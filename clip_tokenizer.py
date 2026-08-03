"""
Real CLIP-L token counting for resolved prompts.

Wildcards make final prompt length unpredictable at edit time -- a short
`__style__` reference can expand into a 40-token line, and stacking a few
of those across a prompt can quietly blow past CLIP's 77-token-per-chunk
window without any visual cue in the raw (unresolved) text. This module
answers "how many tokens will this resolved prompt actually cost" using
the *real* tokenizer ComfyUI itself uses for SD1.5/SDXL's CLIP-L text
encoder, not a word-count approximation.

It reuses ComfyUI's own bundled tokenizer (comfy.sd1_clip.SD1Tokenizer,
which loads vocab.json/merges.txt shipped inside comfy/sd1_tokenizer/ --
no model weights, no GPU, no network access, nothing this node needs to
download). Building it once is cheap; tokenizing a single prompt string
is cheap enough to happen on every keystroke while the resolved preview
is open, same cost class as the wildcard resolution that already runs on
every one of those keystrokes.

Known limitation: this counts CLIP-L (SD1.x / SDXL's first text encoder)
tokens specifically. Architectures that don't use a CLIP-L component at
all (T5-only encoders, etc.) won't hit a 77-token/75-per-chunk wall the
same way, so this number won't mean the same thing for them -- but CLIP-L
is still the encoder the large majority of installs are built on, and
"how many CLIP tokens is this" is the same question people already ask
about SD1.5/SDXL prompts today.
"""

_tokenizer = None
_tokenizer_unavailable = False

# SD1.5/SDXL's CLIP-L wraps prompt content into fixed-size chunks: each
# chunk gets its own start/end token, leaving 77 - 2 = 75 slots for actual
# prompt content per chunk (see comfy.sd1_clip.SDTokenizer.max_length).
TOKENS_PER_CHUNK = 75


def _get_clip_l_tokenizer():
    """Lazily builds and caches a standalone CLIP-L tokenizer. Returns None
    (once, then remembers not to retry) if it can't be built -- e.g. this
    module is being imported outside a real ComfyUI process -- so callers
    can just omit the stat instead of showing a wrong one."""
    global _tokenizer, _tokenizer_unavailable
    if _tokenizer is not None or _tokenizer_unavailable:
        return _tokenizer
    try:
        import comfy.sd1_clip as sd1_clip
        _tokenizer = sd1_clip.SD1Tokenizer(embedding_directory=None)
    except Exception as e:
        print(f"[prompt-palette] token counter unavailable - couldn't build CLIP-L tokenizer ({e})")
        _tokenizer_unavailable = True
        _tokenizer = None
    return _tokenizer


def count_clip_tokens(text):
    """Tokenizes `text` exactly the way ComfyUI's CLIP Text Encode would
    for a CLIP-L encoder, and returns real (non start/end/pad) token
    stats:
      tokens          - total content-token count across the whole prompt
      chunks          - how many 75-token CLIP windows that spreads across
      per_chunk       - content-token count for each individual chunk, so
                        a lopsided split (e.g. [75, 3]) is visible rather
                        than just a combined total
      limit_per_chunk - TOKENS_PER_CHUNK, included so callers don't need
                        to import this module just for the constant

    Returns None if the tokenizer isn't available in this environment
    (e.g. running outside ComfyUI, or a ComfyUI version whose internal
    tokenizer API has changed shape) so callers can skip the stat
    entirely rather than surface a wrong number.
    """
    tok = _get_clip_l_tokenizer()
    if tok is None:
        return None

    text = text or ""
    try:
        tokenized = tok.tokenize_with_weights(text, return_word_ids=True)
        batches = tokenized.get(getattr(tok, "clip_name", "l"))
        if batches is None:
            # Defensive fallback for a differently-named single-encoder key
            # on some ComfyUI versions -- there's only ever one entry here
            # since SD1Tokenizer wraps exactly one clip.
            batches = next(iter(tokenized.values()))
    except Exception as e:
        print(f"[prompt-palette] token count failed: {e}")
        return None

    per_chunk = []
    for batch in batches:
        # word id 0 is reserved for non-content tokens (start/end/pad);
        # anything else is a real piece of the prompt.
        real = sum(1 for item in batch if len(item) > 2 and item[2] != 0)
        per_chunk.append(real)

    # Trailing fully-empty chunks can appear with some padding configs --
    # trim them so e.g. a short prompt doesn't get reported as "2 chunks".
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
