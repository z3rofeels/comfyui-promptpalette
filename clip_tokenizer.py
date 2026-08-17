import logging

logger = logging.getLogger(__name__)

_tokenizer = None
_tokenizer_unavailable = False

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


def count_clip_tokens(text):
    tok = _get_clip_l_tokenizer()
    if tok is None:
        return None

    try:
        tokenized = tok.tokenize_with_weights(text or "", return_word_ids=True)
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

    return {
        "tokens": sum(per_chunk),
        "chunks": len(per_chunk),
        "per_chunk": per_chunk,
        "limit_per_chunk": TOKENS_PER_CHUNK,
    }
