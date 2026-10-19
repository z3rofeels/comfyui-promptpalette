"""Read-only selection capture and exact prepared batches for Prompt Palette."""
from __future__ import annotations
import json
import re
import uuid
from typing import Any
from .wildcard_resolver import WildcardResolver, WILDCARD_RE, PARAM_WILDCARD_RE, CONDITIONAL_TAG_RE
from .json_literals import JsonLiterals, json_object_spans

MAX_PREPARED_PROMPTS = 256
MAX_PREPARED_CHARS = 4_000_000


def utf16_offset(text: str, offset: int) -> int:
    """Browser selection offsets count UTF-16 units; Python indexes code points."""
    units = 0
    for index, char in enumerate(text):
        if units == offset:
            return index
        units += 2 if ord(char) > 0xFFFF else 1
        if units > offset:
            raise ValueError("selection splits a Unicode character")
    if units == offset:
        return len(text)
    raise ValueError("selection is outside the prompt")


def validate_selection(text: str, start: int, end: int, resolver: WildcardResolver) -> None:
    if start >= end:
        raise ValueError("Select a phrase or a complete wildcard first.")
    if any(start < right and end > left for left, right in json_object_spans(text)):
        raise ValueError("JSON prompts are literal. Edit their captions or text directly; use ordinary caption fields for wildcard variations.")
    spans = [(m.start(), m.end()) for pattern in (WILDCARD_RE, PARAM_WILDCARD_RE)
             for m in pattern.finditer(text)]
    variable_spans = resolver._find_dollar_spans(text)
    spans.extend((a, b) for a, b, _ in variable_spans)
    for left, right, inner in variable_spans:
        if start == left and end == right and re.match(r"^[A-Za-z_][A-Za-z0-9_]*\s*=", inner):
            raise ValueError("Variable assignments do not produce prompt text. Select a variable reference or a visible phrase instead.")
    # Brace groups must remain intact, including nested groups.
    stack: list[int] = []
    for index, char in enumerate(text):
        if char == "{" and (index == 0 or text[index - 1] != "\\"):
            stack.append(index)
        elif char == "}" and stack and (index == 0 or text[index - 1] != "\\"):
            spans.append((stack.pop(), index + 1))
    for left, right in spans:
        if left < start < right or left < end < right:
            raise ValueError("Select the complete wildcard, variable or choice group, rather than part of its syntax.")
    for match in CONDITIONAL_TAG_RE.finditer(text):
        if (match.start() < start < match.end() or match.start() < end < match.end()
                or (start == match.start() and end == match.end())):
            raise ValueError("Select the conditional's prompt content, rather than its control tag.")
    for match in re.finditer(r"(?m)^\s*#[^\n]*", text):
        if start < match.end() and end > match.start():
            raise ValueError("Comment lines are not part of the resolved prompt.")


def capture_selection(index: Any, text: str, start: int, end: int, seed: int, mode: str) -> dict[str, Any]:
    start, end = utf16_offset(text, start), utf16_offset(text, end)
    preview = index.preview_view()
    resolver = WildcardResolver(preview)
    validate_selection(text, start, end, resolver)
    nonce = uuid.uuid4().hex
    left, right = f"PPSELECTION{nonce}BEGIN", f"PPSELECTION{nonce}END"
    marked = text[:start] + left + text[start:end] + right + text[end:]
    resolved = ("\n".join(resolver.resolve_lines(marked, seed=seed))
                if mode == "line by line" else resolver.resolve(marked, seed=seed))
    if resolved.count(left) != 1 or resolved.count(right) != 1:
        raise ValueError("This selection did not survive resolution. Select an active phrase outside variable assignments or inactive conditional branches.")
    before, tail = resolved.split(left)
    selected, after = tail.split(right)
    visible = JsonLiterals().protect(resolved)
    if WILDCARD_RE.search(visible) or PARAM_WILDCARD_RE.search(visible):
        raise ValueError("Resolve missing wildcard lists before capturing this prompt.")
    # The markers can shield boundary whitespace from the resolver's strip().
    frozen = before + selected + after
    trim_left = len(frozen) - len(frozen.lstrip())
    trim_right = len(frozen.rstrip())
    selection_left, selection_right = len(before), len(before) + len(selected)
    if trim_left > selection_left or trim_right < selection_right:
        raise ValueError("Select the phrase without leading or trailing prompt whitespace.")
    before = before[trim_left:]
    after = after[:max(0, trim_right - selection_right)]
    return {"source": text, "prefix": before, "selected": selected, "suffix": after,
            "resolved": before + selected + after, "resolution_seed": seed,
            "processing_mode": mode, "wildcards": sorted(set(resolver.used_names))}


def read_prepared_batch(raw: str, source: str, negative_source: str = "") -> dict[str, Any] | None:
    if not raw.strip():
        return None
    if len(raw) > MAX_PREPARED_CHARS * 2:
        raise ValueError("Prepared variation batch is too large.")
    try:
        value = json.loads(raw)
    except (TypeError, json.JSONDecodeError) as exc:
        raise ValueError("Prepared variations are invalid; clear the prepared batch and try again.") from exc
    if not isinstance(value, dict) or value.get("schema") != "prompt-palette.prepared-batch.v1":
        raise ValueError("Unsupported prepared variation batch.")
    if value.get("source") != source:
        raise ValueError("Prepared variations are out of date. Clear the batch or restore its source prompt.")
    prompts = value.get("prompts")
    if not isinstance(prompts, list) or not 1 <= len(prompts) <= MAX_PREPARED_PROMPTS:
        raise ValueError(f"Prepared variations need 1–{MAX_PREPARED_PROMPTS} prompts.")
    if any(not isinstance(item, str) or len(item) > 1_000_000 for item in prompts):
        raise ValueError("Invalid prepared prompt text.")
    if sum(map(len, prompts)) > MAX_PREPARED_CHARS:
        raise ValueError("Prepared variation batch is too large.")
    negatives = value.get("negative_prompts")
    if "negative_prompts" in value:
        if (not isinstance(negatives, list) or len(negatives) != len(prompts)
                or any(not isinstance(item, str) or len(item) > 1_000_000 for item in negatives)):
            raise ValueError("Each prepared prompt needs its matching negative prompt.")
        if sum(map(len, prompts)) + sum(map(len, negatives)) > MAX_PREPARED_CHARS:
            raise ValueError("Prepared variation batch is too large.")
        if not isinstance(value.get("negative_source"), str) or value["negative_source"] != negative_source:
            raise ValueError("The prepared negative prompts are out of date. Clear the batch or restore its negative prompt.")
    if "comparison" in value:
        labels = value.get("labels")
        if (value["comparison"] != "one-field" or not isinstance(labels, list) or len(labels) != len(prompts)
                or any(not isinstance(label, str) or len(label) > 200 for label in labels)):
            raise ValueError("Invalid prepared comparison labels.")
    wildcards = value.get("wildcards", [])
    if not isinstance(wildcards, list) or len(wildcards) > 5000 or any(not isinstance(name, str) or len(name) > 4096 for name in wildcards):
        raise ValueError("Invalid prepared wildcard metadata.")
    return value
