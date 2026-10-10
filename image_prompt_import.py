"""Read prompt metadata without decoding pixels, loading a model or saving uploads."""

from __future__ import annotations

import io
import json
import re
from typing import Any

from .prompt_metadata import PROMPT_METADATA_SCHEMA, compose_source_prompt

MAX_IMPORT_BYTES = 32 * 1024 * 1024
MAX_PROMPT_CHARS = 1_000_000


def _decode(value: Any) -> Any:
    if isinstance(value, str):
        try:
            decoded = json.loads(value)
            # Plain-text metadata may itself be a valid JSON number/boolean.
            return decoded if isinstance(decoded, (str, dict, list)) else value
        except (ValueError, TypeError):
            return value
    return value


def _string(record: dict, keys: tuple[str, ...]) -> str | None:
    for key in keys:
        value = record.get(key)
        if isinstance(value, str):
            if len(value) > MAX_PROMPT_CHARS:
                raise ValueError("An embedded prompt exceeds the 1M character limit.")
            return value
    return None


def _pair(record: dict, authored: bool = False) -> dict | None:
    positive = _string(record, ("source_prompt", "source_text", "raw_prompt", "wildcard_prompt") if authored
                       else ("resolved_prompt", "positive_prompt", "prompt"))
    if positive is None:
        return None
    negative = _string(record, ("source_negative_prompt", "source_negative_text") if authored
                       else ("resolved_negative_prompt", "negative_prompt"))
    return {"positive": positive, "negative": negative, "has_negative": negative is not None}


def _palette_record(record: dict, label: str) -> dict | None:
    if record.get("schema") != PROMPT_METADATA_SCHEMA:
        return None
    authored = _pair(record, True)
    items = record.get("prompts") if record.get("batch") else [record]
    results = []
    if isinstance(items, list):
        if len(items) > 5000:
            raise ValueError("Too many embedded batch records.")
        for index, item in enumerate(items):
            if not isinstance(item, dict):
                continue
            pair = _pair(item)
            if pair is None:
                continue
            # Batch children can omit the shared negative, including its source.
            if not pair["has_negative"]:
                shared = _pair(record)
                negative = shared["negative"] if shared else _string(record, ("negative_prompt",))
                if negative is not None:
                    pair.update(negative=negative, has_negative=True)
            local_author = _pair(item, True)
            if local_author and authored and record.get("batch"):
                # Palette batches have one shared authored negative. Older
                # workflow summaries omit it; child default "" is not evidence
                # of an intentionally empty source in that case.
                local_author.update(negative=authored["negative"], has_negative=authored["has_negative"])
            elif local_author and authored and authored["has_negative"] and not local_author["has_negative"]:
                local_author.update(negative=authored["negative"], has_negative=True)
            results.append({**pair, "label": f"Result {index + 1}", "authored": local_author if local_author != authored else None})
    if authored is None and not results:
        return None
    return {"label": label, "source": "Prompt Palette", "authored": authored, "results": results,
            "truncated": bool(record.get("embedded_prompts_truncated") or record.get("truncated"))}


def _link(value: Any) -> bool:
    return isinstance(value, list) and len(value) == 2 and isinstance(value[0], (str, int)) and isinstance(value[1], int)


def _graph_text(graph: dict, ref: Any, channel: str) -> str | None:
    visited = set()
    stack = [ref]
    while stack and len(visited) < 512:
        value = stack.pop()
        if isinstance(value, str):
            return value
        if not _link(value):
            continue
        key = str(value[0])
        if key in visited:
            continue
        visited.add(key)
        node = graph.get(key)
        if not isinstance(node, dict) or not isinstance(node.get("inputs"), dict):
            continue
        inputs = node["inputs"]
        if node.get("class_type") in ("PromptPaletteEditor", "PromptPaletteCombinatorial"):
            name = "negative_text" if channel == "negative" else "text"
            text = inputs.get(name)
            if isinstance(text, str):
                prefix = inputs.get("negative_prefix" if channel == "negative" else "prompt_prefix", "")
                suffix = inputs.get("negative_suffix" if channel == "negative" else "prompt_suffix", "")
                return compose_source_prompt([x for x in (prefix, text, suffix) if isinstance(x, str)], inputs.get("processing_mode", ""))
            stack.append(text)
            continue
        texts = [inputs[k] for k in ("text_g", "text_l") if isinstance(inputs.get(k), str)]
        if texts:
            return "\n".join(dict.fromkeys(texts))
        for name in ("text", "string", "populated_text", "value"):
            if isinstance(inputs.get(name), str):
                return inputs[name]
        stack.extend(inputs.get(k) for k in reversed(("text", "string", "prompt", "conditioning", "conditioning_1", "positive")) if _link(inputs.get(k)))
    return None


def _a1111(text: str) -> dict | None:
    if not text.strip():
        return None
    # Settings start on their own line, not wherever a prompt mentions "Seed:".
    settings = re.search(r"(?m)^Steps:\s*\d+\s*,", text)
    if settings:
        text = text[:settings.start()].rstrip("\r\n")
    negative = re.search(r"(?m)^Negative prompt:[ \t]?", text)
    positive = text[:negative.start()].rstrip("\r\n") if negative else text
    pair = {"positive": positive, "negative": text[negative.end():] if negative else None, "has_negative": bool(negative)}
    return {"label": "Generation parameters", "source": "A1111 / EXIF", "authored": None,
            "results": [{**pair, "label": "Prompt", "authored": None}], "truncated": False}


def _user_comment(value: Any) -> str:
    if isinstance(value, str):
        return value
    if not isinstance(value, bytes):
        return ""
    if value.startswith(b"UNICODE\0"):
        raw = value[8:]
        if raw.startswith((b"\xff\xfe", b"\xfe\xff")):
            return raw.decode("utf-16", errors="replace").rstrip("\0")
        order = "utf-16-be" if raw[0::2].count(0) > raw[1::2].count(0) else "utf-16-le"
        return raw.decode(order, errors="replace").rstrip("\0")
    if value.startswith(b"ASCII\0\0\0"):
        value = value[8:]
    return value.decode("utf-8", errors="replace").rstrip("\0")


def recover_prompt_metadata(info: dict, exif_comment: str = "") -> list[dict]:
    decoded = {key: _decode(value) for key, value in info.items()}
    records, seen = [], set()
    def add(record, label):
        if not isinstance(record, dict):
            return
        fingerprint = json.dumps(record, sort_keys=True, ensure_ascii=False)
        if fingerprint in seen:
            return
        recovered = _palette_record(record, label)
        if recovered:
            seen.add(fingerprint)
            records.append(recovered)
    container = decoded.get("prompt_palette")
    if isinstance(container, dict):
        add(container.get("primary"), "Primary Palette prompt")
        nodes = container.get("nodes")
        if isinstance(nodes, dict):
            for key, record in nodes.items():
                add(record, f"Palette node {key}")
    add(decoded.get("prompt_palette_metadata"), "Palette prompt")
    workflow = decoded.get("workflow")
    if not records and isinstance(workflow, dict) and isinstance(workflow.get("nodes"), list):
        for node in workflow["nodes"]:
            if isinstance(node, dict) and isinstance(node.get("properties"), dict):
                add(node["properties"].get("prompt_palette_last_result"), f"Palette node {node.get('id', '')}")
    if records:
        return records
    # Older assets may have the exported aliases without the structured record.
    aliases = {"source_prompt": decoded.get("prompt_source", decoded.get("raw_prompt")),
               "source_negative_prompt": decoded.get("negative_prompt_source"),
               "positive_prompt": decoded.get("positive_prompt", decoded.get("resolved_prompt")),
               "negative_prompt": decoded.get("negative_prompt")}
    if _pair(aliases) or _pair(aliases, True):
        results = [_pair(aliases)] if _pair(aliases) else []
        return [{"label": "Embedded prompt", "source": "Prompt metadata", "authored": _pair(aliases, True),
                 "results": [{**pair, "label": "Prompt", "authored": None} for pair in results], "truncated": False}]
    graph = decoded.get("prompt")
    if isinstance(graph, dict):
        for key, node in graph.items():
            if not isinstance(node, dict) or not isinstance(node.get("inputs"), dict):
                continue
            inputs = node["inputs"]
            if "positive" not in inputs:
                continue
            positive = _graph_text(graph, inputs["positive"], "positive")
            if positive is None:
                continue
            negative = _graph_text(graph, inputs.get("negative"), "negative")
            pair = {"positive": positive, "negative": negative, "has_negative": negative is not None}
            records.append({"label": f"{node.get('class_type', 'Sampler')} {key}", "source": "ComfyUI graph (authored)",
                            "authored": pair, "results": [], "truncated": False})
        if records:
            return records
    parameters = decoded.get("parameters")
    fallback = _a1111(parameters) if isinstance(parameters, str) else None
    fallback = fallback or (_a1111(exif_comment) if exif_comment else None)
    return [fallback] if fallback else []


def import_image_prompts(data: bytes) -> dict:
    if len(data) > MAX_IMPORT_BYTES:
        raise ValueError("Image exceeds the 32MB import limit.")
    from PIL import Image, UnidentifiedImageError
    try:
        with Image.open(io.BytesIO(data), formats=("PNG", "JPEG", "WEBP")) as image:
            if image.format not in ("PNG", "JPEG", "WEBP"):
                raise ValueError("Choose a PNG, JPEG or WebP image.")
            info = dict(image.info)
            # PNG getexif() otherwise loads the pixels to look for a late eXIf chunk.
            exif = image.getexif() if image.format != "PNG" or "exif" in info else None
            comment = _user_comment(exif.get_ifd(34665).get(37510, exif.get(37510))) if exif else ""
            records = recover_prompt_metadata(info, comment)
    except (UnidentifiedImageError, OSError, SyntaxError) as error:
        raise ValueError("The file is not a readable PNG, JPEG or WebP image.") from error
    if not records:
        raise ValueError("No prompt metadata found. This image may have been saved with metadata disabled or removed.")
    for record in records:
        pairs = [record.get("authored"), *record["results"], *(item.get("authored") for item in record["results"])]
        for pair in pairs:
            if pair and any(isinstance(pair.get(key), str) and len(pair[key]) > MAX_PROMPT_CHARS for key in ("positive", "negative")):
                raise ValueError("An embedded prompt exceeds the 1M character limit.")
    payload = {"ok": True, "records": records}
    if len(json.dumps(payload, ensure_ascii=False)) > 8 * MAX_PROMPT_CHARS:
        raise ValueError("Embedded prompt metadata is too large to preview.")
    return payload
