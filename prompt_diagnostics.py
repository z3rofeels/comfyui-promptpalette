"""Read-only prompt diagnostics. No model loading or attention prediction."""
from __future__ import annotations

import re
from .json_literals import JsonLiterals

EMBEDDING_RE = re.compile(r"\bembedding:([^\s,()<>]+)")
EMBEDDING_EXTENSIONS = (".safetensors", ".pt", ".bin", ".ckpt")
LORA_SPAN_RE = re.compile(r"<lora:[^<>\r\n]+>", re.I)
WILDCARD_SPAN_RE = re.compile(r"__[+\-*%~@]?[A-Za-z0-9_\-/*]+(?:\([^()]*\))?__")
VARIABLE_SPAN_RE = re.compile(r"\$\{[^{}]*\}")
CONDITIONAL_SPAN_RE = re.compile(r"\[(?:if|elif|else|/if|switch|case|default|/switch)(?:\s+[^\]]+)?\]", re.I)
WEIGHT_GROUP_RE = re.compile(r"^\(([\s\S]+):([+-]?(?:\d+(?:\.\d*)?|\.\d+))\)$")
INLINE_WEIGHT_RE = re.compile(r"(?<!\\)\(([^():\r\n]+):([+-]?(?:\d+(?:\.\d*)?|\.\d+))(?<!\\)\)")
PROSE_BUZZWORD_RE = re.compile(
    r"\b(?:score_\d+(?:_up|_down)?|masterpiece|best[ _]quality|absurdres|highres|8k[ _]uhd|4k[ _]uhd)\b",
    re.I,
)
BREAK_TOKEN_RE = re.compile(r"\bBREAK\b")
BOORU_UNDERSCORE_RE = re.compile(r"(?<![A-Za-z0-9_])([A-Za-z0-9]+(?:_[A-Za-z0-9]+)+)(?![A-Za-z0-9_])")
ANIMA_ARTIST_PREFIX_RE = re.compile(r"(?:^|(?<=[\s,]))artist:([A-Za-z0-9_\-]+)", re.I)

PROSE_PROFILES = frozenset({"flux", "krea2", "krea-2", "qwen", "wan", "zimage", "z-image", "moss-caption", "prose"})
TAG_PROFILES = frozenset({"booru", "sdxl", "illustrious", "pony", "anima", "moss-tags", "tags"})


def _mask_non_prompt_regions(text: str, *, mask_syntax: bool = False) -> str:
    """Replace JSON literals, # comment lines, and <lora:...> tags with equal-length spaces."""
    source = str(text or "")
    if not source:
        return ""
    chars = list(source)
    literals = JsonLiterals()
    literals.protect(source)
    from .json_literals import json_object_spans
    for start, end in json_object_spans(source):
        for idx in range(start, end):
            if chars[idx] != "\n":
                chars[idx] = " "

    line_start = 0
    for idx, ch in enumerate(source + "\n"):
        if ch == "\n":
            line = source[line_start:idx]
            if line.lstrip().startswith("#"):
                for j in range(line_start, idx):
                    chars[j] = " "
            line_start = idx + 1

    masked = "".join(chars)
    patterns = [LORA_SPAN_RE]
    if mask_syntax:
        patterns.extend((EMBEDDING_RE, WILDCARD_SPAN_RE, VARIABLE_SPAN_RE, CONDITIONAL_SPAN_RE))
    for pattern in patterns:
        for match in pattern.finditer(masked):
            s, e = match.span()
            for j in range(s, e):
                if chars[j] != "\n":
                    chars[j] = " "
        masked = "".join(chars)
    return masked


def _has_dynamic_syntax(clause: str) -> bool:
    return bool(
        WILDCARD_SPAN_RE.search(clause)
        or VARIABLE_SPAN_RE.search(clause)
        or CONDITIONAL_SPAN_RE.search(clause)
        or ("{" in clause and "}" in clause)
    )


def _unwrap_weight(clause: str) -> str:
    trimmed = clause.strip()
    match = WEIGHT_GROUP_RE.match(trimmed)
    if match:
        # Ensure balanced outer parens before unwrapping
        depth = 0
        balanced = True
        for i, ch in enumerate(trimmed):
            if ch == "(":
                depth += 1
            elif ch == ")":
                depth -= 1
                if depth == 0 and i < len(trimmed) - 1:
                    balanced = False
                    break
        if balanced:
            return match.group(1).strip()
    return trimmed


def _normalize_clause_key(clause: str) -> str:
    inner = _unwrap_weight(clause)
    inner = inner.replace("\\(", "(").replace("\\)", ")")
    norm = re.sub(r"[\s_]+", " ", inner).strip(" \t\r\n.;:").casefold()
    return norm


def iter_top_level_clauses(text: str):
    """Yield (start, end, raw_slice) for comma/newline-separated clauses outside (), {}, []."""
    source = str(text or "")
    masked = _mask_non_prompt_regions(source)
    depth = 0
    seg_start = 0
    n = len(masked)
    i = 0
    while i <= n:
        ch = masked[i] if i < n else ","
        if i < n and ch == "\\":
            i += 2
            continue
        if i < n and ch in "({[":
            depth += 1
        elif i < n and ch in ")}]" and depth > 0:
            depth -= 1
        elif i == n or (depth == 0 and ch in ",\n"):
            s, e = seg_start, i
            while s < e and masked[s].isspace():
                s += 1
            while e > s and masked[e - 1].isspace():
                e -= 1
            if e > s:
                yield s, e, source[s:e]
            seg_start = i + 1
        i += 1


def find_duplicate_clauses(text: str) -> list[dict]:
    """Detect case/underscore-normalized duplicate clauses while preserving exact source spans."""
    seen: dict[str, tuple[int, int, str]] = {}
    duplicates: list[dict] = []
    for start, end, raw in iter_top_level_clauses(text):
        if _has_dynamic_syntax(raw):
            continue
        norm = _normalize_clause_key(raw)
        if len(norm) < 2 or norm in {"break", "and", "the", "a", "an"}:
            continue
        prev = seen.get(norm)
        if prev is not None:
            if len(duplicates) < 64:
                duplicates.append({
                    "clause": raw,
                    "normalized": norm,
                    "span": [start, end],
                    "first_span": [prev[0], prev[1]],
                    "reason": f"Duplicate of “{prev[2]}” earlier in prompt.",
                    "suggested_replacement": "",
                })
        else:
            seen[norm] = (start, end, raw)
    return duplicates


def detect_model_syntax_mismatches(text: str, target_profile: str) -> list[dict]:
    """Return non-destructive diagnostic spans where syntax conflicts with target_profile."""
    profile = str(target_profile or "").strip().lower()
    if not profile:
        return []
    source = str(text or "")
    if not source.strip():
        return []
    masked = _mask_non_prompt_regions(source, mask_syntax=True)
    mismatches: list[dict] = []

    def push(start: int, end: int, kind: str, reason: str, replacement: str):
        if len(mismatches) < 64:
            mismatches.append({
                "span": [start, end],
                "kind": kind,
                "matched": source[start:end],
                "reason": reason,
                "suggested_replacement": replacement,
            })

    if profile in PROSE_PROFILES:
        for m in INLINE_WEIGHT_RE.finditer(masked):
            s, e = m.span()
            inner = source[m.start(1):m.end(1)].strip()
            push(s, e, "numeric-weight", "Prose encoders read (phrase:weight) brackets literally instead of scaling emphasis.", inner)
        for m in BREAK_TOKEN_RE.finditer(masked):
            push(m.start(), m.end(), "break-token", "BREAK chunk delimiters are specific to CLIP tag chunking.", "")
        for m in PROSE_BUZZWORD_RE.finditer(masked):
            push(m.start(), m.end(), "legacy-buzzword", "Score/quality tags add token noise in natural-language encoders.", "")
        for m in BOORU_UNDERSCORE_RE.finditer(masked):
            s, e = m.span(1)
            raw_word = source[s:e]
            if raw_word.lower().startswith("score_"):
                continue
            push(s, e, "booru-underscore", "Natural-language encoders tokenize spaces more cleanly than Booru underscores.", raw_word.replace("_", " "))
    elif profile in TAG_PROFILES:
        if profile == "anima":
            for m in ANIMA_ARTIST_PREFIX_RE.finditer(masked):
                s, e = m.span()
                artist_name = source[m.start(1):m.end(1)].replace("_", " ").strip()
                push(s, e, "anima-artist", "Anima expects @Artist Name with spaces instead of artist:name.", f"@{artist_name}")
        for m in re.finditer(r"[ \t]+,", masked):
            push(m.start(), m.end(), "comma-spacing", "Extra whitespace before comma in tag list.", ",")
        for m in re.finditer(r",\s*,+", masked):
            push(m.start(), m.end(), "double-comma", "Redundant empty comma separator.", ",")

    mismatches.sort(key=lambda item: item["span"][0])
    return mismatches


def inspect_embeddings(text, available=None):
    masked = _mask_non_prompt_regions(text or "")
    names = list(dict.fromkeys(EMBEDDING_RE.findall(masked)))
    known = set(available or [])
    known_lower = {item.lower(): item for item in known}
    result = []
    for name in names[:64]:
        clean = name.strip()
        low = clean.lower()
        filename = (
            known_lower.get(low)
            or next((known_lower[low + ext] for ext in EMBEDDING_EXTENSIONS if (low + ext) in known_lower), None)
            or next((item for item in known if item.replace("\\", "/").split("/")[-1].lower() in {low, *(low + ext for ext in EMBEDDING_EXTENSIONS)}), None)
        )
        result.append({
            "name": clean,
            "filename": filename,
            "status": "unknown" if available is None else "found" if filename else "missing",
        })
    return result


def inspect_resolved_prompt(resolved, segments, available=None, target_profile: str = ""):
    weighted = [{"text": phrase, "weight": weight} for phrase, weight in segments if weight != 1.0][:64]
    payload = {
        "weights": weighted,
        "embeddings": inspect_embeddings(resolved, available),
        "duplicates": find_duplicate_clauses(resolved),
        "weight_note": "Explicit numeric source weights, including multiplied nested weights. Encoder support and output formatting determine their effect.",
        "token_note": "CLIP-L reference tokenizer; not a measurement of the connected encoder. Embedding names are counted as text, without loading their vectors.",
    }
    if target_profile:
        payload["mismatches"] = detect_model_syntax_mismatches(resolved, target_profile)
    return payload
