"""Optional, model-independent projection of resolved positive prompt tags.

Only standalone descriptors are eligible. Dialogue, prose, explicit negations
and structured expressions stay literal when their meaning is uncertain.
This module is authoritative for execution and server-backed previews.
"""

import re

from .wildcard_resolver import CONDITIONAL_TAG_RE, PARAM_WILDCARD_RE, WILDCARD_RE


POSITIVE_ANTONYMS = {
    "censor": "uncensored",
    "censored": "uncensored",
    "bad hands": "well-formed hands",
    "deformed hands": "anatomically correct hands",
    "blurry": "sharp focus",
    "low quality": "masterpiece",
    "low resolution": "high resolution",
    "distorted anatomy": "correct anatomy",
    "bad proportions": "balanced proportions",
    "poorly drawn face": "detailed face",
    "out of focus": "in focus",
}
_CONCEPT_RE = re.compile(
    "(?:" + "|".join(re.escape(key).replace(r"\ ", r"\s+")
                       for key in sorted(POSITIVE_ANTONYMS, key=lambda key: (-len(key), key))) + ")",
    re.IGNORECASE,
)
_SEPARATOR_RE = re.compile(r"[,;\r\n]+[ \t]*")
_COUNTERPART_RE = re.compile(
    r"(?<![\w-])(?:" + "|".join(re.escape(value).replace(r"\ ", r"\s+")
                                 for value in sorted(set(POSITIVE_ANTONYMS.values()), key=lambda value: (-len(value), value))) + r")(?![\w-])",
    re.IGNORECASE,
)


def enabled_flag(value):
    return value.strip().lower() in {"true", "1", "yes", "on"} if isinstance(value, str) else value is True or value == 1


def protected_span_end(text, start, *, require_closed=False):
    """End of a quoted/balanced expression; an unfinished span protects the tail.

    Shared with the Weight Controller's conservative Anima parser. Apostrophes
    within words are ordinary text; callers decide whether a quote starts here.
    """
    opening = text[start]
    if opening in '\"\'`':
        cursor = start + 1
        while cursor < len(text):
            if text[cursor] == "\\":
                cursor += 2
                continue
            if text[cursor] == opening:
                return cursor + 1
            cursor += 1
        return -1 if require_closed else len(text)
    pairs = {"(": ")", "[": "]", "{": "}", "<": ">"}
    stack = [pairs[opening]]
    cursor = start + 1
    while cursor < len(text):
        char = text[cursor]
        if char == "\\":
            cursor += 2
            continue
        if char in '\"\'`' and not (char == "'" and cursor and text[cursor - 1].isalnum()):
            cursor = protected_span_end(text, cursor)
            continue
        if char in pairs:
            stack.append(pairs[char])
        elif char == stack[-1]:
            stack.pop()
            if not stack:
                return cursor + 1
        cursor += 1
    return -1 if require_closed else len(text)


def _descriptor_chunks(text):
    """Split at ordinary tag/field boundaries, never inside protected spans."""
    chunks, cursor, start, protected = [], 0, 0, False
    while cursor < len(text):
        char = text[cursor]
        if char == "\\":
            protected = True
            cursor += 2
            continue
        if char in "([{<" or char in '\"`' or (char == "'" and (cursor == 0 or not text[cursor - 1].isalnum())):
            protected = True
            cursor = protected_span_end(text, cursor)
            continue
        if char in ",;\r\n":
            match = _SEPARATOR_RE.match(text, cursor)
            chunks.append((text[start:cursor], match.group(), protected))
            start = cursor = match.end()
            protected = False
            continue
        cursor += 1
    chunks.append((text[start:], "", protected))
    return chunks


def apply_positive_antonyms(text, enabled=False):
    if not enabled_flag(enabled) or not text:
        return text
    # Unresolved branch directives could govern the apparent plain text. Do not
    # process it until the resolver can safely evaluate the whole structure.
    if CONDITIONAL_TAG_RE.search(text):
        return text
    chunks = _descriptor_chunks(text)
    # A counterpart embedded in prose/dialogue/weighting cannot be moved safely.
    # Leave its undesirable partner alone rather than add a duplicate descriptor.
    blocked = set()
    for source, _separator, protected in chunks:
        normalized = " ".join(source.strip().lower().split())
        if protected or normalized not in POSITIVE_ANTONYMS.values():
            blocked.update(" ".join(match.group().lower().split()) for match in _COUNTERPART_RE.finditer(source))
    counterparts, removed = [], set()
    for index, (source, _separator, protected) in enumerate(chunks):
        if protected or WILDCARD_RE.search(source) or PARAM_WILDCARD_RE.search(source):
            continue
        match = _CONCEPT_RE.fullmatch(source.strip())
        if match:
            concept = " ".join(match.group().lower().split())
            counterpart = POSITIVE_ANTONYMS[concept]
            if counterpart in blocked:
                continue
            if counterpart not in counterparts:
                counterparts.append(counterpart)
            removed.add(index)
    if not removed:
        return text
    # Existing standalone counterparts are moved to the front, rather than
    # duplicated. Never consume occurrences in dialogue or weighted/prose spans.
    for index, (source, _separator, protected) in enumerate(chunks):
        if not protected and " ".join(source.strip().lower().split()) in counterparts:
            removed.add(index)
    kept = [index for index, (source, _, _) in enumerate(chunks) if index not in removed and source.strip()]
    parts = []
    previous = None
    for index in kept:
        if previous is not None:
            boundaries = [chunks[i][1] for i in range(previous, index)]
            if index == previous + 1:
                separator = boundaries[0]
            elif any("\n" in boundary or "\r" in boundary for boundary in boundaries):
                separator = "\n" * max(1, min(2, max(boundary.count("\n") for boundary in boundaries)))
            else:
                separator = "; " if any(";" in boundary for boundary in boundaries) else ", "
            parts.append(separator)
        parts.append(chunks[index][0].strip())
        previous = index
    body = "".join(parts)
    return ", ".join(counterparts) + (", " + body if body else "")
