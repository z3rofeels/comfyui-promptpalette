import logging
import threading
from collections import OrderedDict

logger = logging.getLogger(__name__)

_tokenizer = None
_tokenizer_unavailable = False
_token_cache_lock = threading.Lock()
_token_count_cache: OrderedDict[str, dict] = OrderedDict()
_TOKEN_CACHE_LIMIT = 256
_TOKEN_CACHE_MAX_CHARS = 16384

TOKENS_PER_CHUNK = 75


def _get_clip_l_tokenizer():
    global _tokenizer, _tokenizer_unavailable
    if _tokenizer is not None or _tokenizer_unavailable:
        return _tokenizer
    try:
        # ComfyUI has no public standalone token-count service. Keep this internal import
        # isolated and optional so an upstream tokenizer move cannot break node loading.
        from comfy import sd1_clip

        tokenizer_type = getattr(sd1_clip, "SD1Tokenizer", None)
        if tokenizer_type is None:
            raise RuntimeError("SD1Tokenizer is unavailable")
        _tokenizer = tokenizer_type(embedding_directory=None)
    except Exception as exc:
        logger.warning("CLIP-L token counter is unavailable: %s", exc)
        _tokenizer_unavailable = True
        _tokenizer = None
    return _tokenizer


def clip_counting_applies(clip):
    """True when a CLIP-L style token count is meaningful for this text encoder.

    With no CLIP connected there is nothing to contradict the count, so it stays
    available. For a connected CLIP, only tokenizers built on the CLIP BPE vocab
    (SD1/SDXL/SD3/Flux-style) qualify; Qwen/T5/LLM-style encoders do not.
    """
    if clip is None:
        return True
    tokenizer = getattr(clip, "tokenizer", None)
    if tokenizer is None:
        return False
    return any(hasattr(tokenizer, name) for name in ("clip_l", "clip_g", "clip_h"))


def _copy_token_stats(stats):
    return {
        "tokens": stats["tokens"],
        "chunks": stats["chunks"],
        "per_chunk": list(stats["per_chunk"]),
        "limit_per_chunk": stats["limit_per_chunk"],
    }


def count_clip_tokens(text, *, include_layout=False):
    tok = _get_clip_l_tokenizer()
    if tok is None:
        return None

    source_text = text or ""
    can_cache = not include_layout and len(source_text) <= _TOKEN_CACHE_MAX_CHARS
    if can_cache:
        with _token_cache_lock:
            cached = _token_count_cache.get(source_text)
            if cached is not None:
                _token_count_cache.move_to_end(source_text)
                return _copy_token_stats(cached)

    try:
        tokenized = tok.tokenize_with_weights(source_text, return_word_ids=True)
        batches = tokenized.get(getattr(tok, "clip_name", "l"))
        if batches is None:
            batches = next(iter(tokenized.values()))
    except Exception as exc:
        logger.debug("CLIP-L token count failed", exc_info=exc)
        return None

    per_chunk = []
    for batch in batches:
        real = sum(1 for item in batch if len(item) > 2 and item[2] != 0)
        per_chunk.append(real)

    while len(per_chunk) > 1 and per_chunk[-1] == 0:
        per_chunk.pop()
    if not per_chunk or sum(per_chunk) == 0:
        return {"tokens": 0, "chunks": 0, "per_chunk": [], "limit_per_chunk": TOKENS_PER_CHUNK}

    result = {
        "tokens": sum(per_chunk),
        "chunks": len(per_chunk),
        "per_chunk": per_chunk,
        "limit_per_chunk": TOKENS_PER_CHUNK,
    }
    if can_cache:
        with _token_cache_lock:
            _token_count_cache[source_text] = _copy_token_stats(result)
            if len(_token_count_cache) > _TOKEN_CACHE_LIMIT:
                _token_count_cache.popitem(last=False)
    if include_layout:
        layout = []
        decoder = getattr(getattr(tok, "tokenizer", None), "decode", None)
        for chunk, batch in enumerate(batches):
            for item in batch:
                if len(item) < 3 or item[2] == 0:
                    continue
                if len(layout) >= 512:
                    break
                token = item[0]
                try:
                    label = decoder([token]) if decoder and isinstance(token, int) else str(token)
                except Exception:
                    label = str(token)
                layout.append({"text": label[:80], "weight": float(item[1]), "chunk": chunk + 1})
        result["layout"] = layout
        result["layout_omitted"] = max(0, result["tokens"] - len(layout))
    return result
