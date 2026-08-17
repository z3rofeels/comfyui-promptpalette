"""Structured prompt metadata shared by Prompt Palette outputs and saved assets."""

from __future__ import annotations

import copy
import json
from typing import Any

PROMPT_METADATA_SCHEMA = "prompt-palette.prompt-metadata.v1"
EMBEDDED_BATCH_CHAR_LIMIT = 1_000_000


def compact_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def compose_source_prompt(parts: list[str], processing_mode: str) -> str:
    cleaned = [part for part in parts if part]
    return ("\n" if processing_mode == "line by line" else " ").join(cleaned)


def build_prompt_metadata(
    *,
    node_type: str,
    prompt: str,
    negative_prompt: str = "",
    source_prompt: str = "",
    source_negative_prompt: str = "",
    source_text: str = "",
    source_negative_text: str = "",
    seed: int | None = None,
    processing_mode: str = "",
    wildcards_used: list[str] | None = None,
    used_enhancer: bool = False,
    enhancer_override: str = "",
    loras: list[dict[str, Any]] | None = None,
    clip_token_count: int | None = None,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    metadata: dict[str, Any] = {
        "schema": PROMPT_METADATA_SCHEMA,
        "schema_version": 1,
        "generator": "Prompt Palette",
        "node_type": node_type,
        # Common aliases are deliberate: asset browsers vary in which key they inspect.
        "prompt": prompt,
        "positive_prompt": prompt,
        "resolved_prompt": prompt,
        "negative_prompt": negative_prompt,
        "resolved_negative_prompt": negative_prompt,
        "source_prompt": source_prompt,
        "raw_prompt": source_prompt,
        "wildcard_prompt": source_prompt,
        "source_negative_prompt": source_negative_prompt,
        "source_text": source_text,
        "source_negative_text": source_negative_text,
        "wildcards_used": list(wildcards_used or []),
        "wildcards_used_count": len(wildcards_used or []),
        "used_enhancer": bool(used_enhancer),
        "enhancer_override": enhancer_override if used_enhancer else "",
        "loras": list(loras or []),
        "wildcards_resolved": source_prompt != prompt or bool(wildcards_used),
    }
    if seed is not None:
        metadata["seed"] = int(seed)
    if processing_mode:
        metadata["processing_mode"] = processing_mode
    if clip_token_count is not None:
        metadata["clip_token_count"] = int(clip_token_count)
    if extra:
        metadata.update(extra)
    return metadata


def _hidden_value(node_cls: type, name: str, default: Any = None) -> Any:
    hidden = getattr(node_cls, "hidden", None)
    return getattr(hidden, name, default) if hidden is not None else default


def _node_id(node_cls: type) -> str:
    value = _hidden_value(node_cls, "unique_id", "")
    return str(value) if value is not None else ""



def _is_prompt_link(value: Any) -> bool:
    return (
        isinstance(value, (list, tuple))
        and len(value) == 2
        and isinstance(value[0], (str, int))
        and isinstance(value[1], int)
    )


def _iter_prompt_links(value: Any):
    if _is_prompt_link(value):
        yield str(value[0]), int(value[1])
        return
    if isinstance(value, dict):
        for child in value.values():
            yield from _iter_prompt_links(child)
    elif isinstance(value, (list, tuple)):
        for child in value:
            yield from _iter_prompt_links(child)


def prompt_reference_scores(prompt: Any) -> dict[str, int]:
    """Score Prompt Palette nodes by how directly their outputs feed the graph."""
    if not isinstance(prompt, dict):
        return {}
    scores: dict[str, int] = {}
    for node in prompt.values():
        if not isinstance(node, dict):
            continue
        for source_id, output_index in _iter_prompt_links(node.get("inputs", {})):
            source = prompt.get(source_id)
            if not isinstance(source, dict):
                continue
            node_type = source.get("class_type")
            if node_type == "PromptPaletteEditor":
                weight = {4: 8, 2: 6, 3: 6, 12: 2}.get(output_index, 1)
            elif node_type == "PromptPaletteCombinatorial":
                weight = {3: 8, 2: 6, 6: 2}.get(output_index, 1)
            else:
                continue
            scores[source_id] = scores.get(source_id, 0) + weight
    return scores


def _workflow_order(extra_pnginfo: dict[str, Any], node_id: str) -> int:
    workflow = extra_pnginfo.get("workflow")
    nodes = workflow.get("nodes") if isinstance(workflow, dict) else None
    if not isinstance(nodes, list):
        return -1
    for index, node in enumerate(nodes):
        if isinstance(node, dict) and str(node.get("id", "")) == str(node_id):
            return index
    return -1


def _should_set_primary(
    extra_pnginfo: dict[str, Any], prompt: Any, node_id: str
) -> bool:
    if not node_id or not isinstance(prompt, dict):
        return True
    container = extra_pnginfo.get("prompt_palette")
    existing_id = container.get("primary_node_id") if isinstance(container, dict) else None
    if existing_id in (None, "", node_id):
        return True
    scores = prompt_reference_scores(prompt)
    current_rank = (scores.get(str(node_id), 0), _workflow_order(extra_pnginfo, str(node_id)))
    existing_rank = (
        scores.get(str(existing_id), 0),
        _workflow_order(extra_pnginfo, str(existing_id)),
    )
    return current_rank >= existing_rank

def _workflow_node(workflow: Any, node_id: str) -> dict[str, Any] | None:
    if not isinstance(workflow, dict):
        return None
    nodes = workflow.get("nodes")
    if not isinstance(nodes, list):
        return None
    for node in nodes:
        if isinstance(node, dict) and str(node.get("id", "")) == node_id:
            return node
    return None


def _workflow_summary(metadata: dict[str, Any]) -> dict[str, Any]:
    if metadata.get("batch"):
        return {
            "schema": metadata.get("schema"),
            "node_type": metadata.get("node_type"),
            "batch": True,
            "count": metadata.get("count", 0),
            "source_prompt": metadata.get("source_prompt", ""),
            "mode": metadata.get("mode", ""),
            "seed_mode": metadata.get("seed_mode", ""),
            "seed": metadata.get("seed", 0),
            "requested_count": metadata.get("requested_count", metadata.get("count", 0)),
            "max_prompts": metadata.get("max_prompts", 0),
            "wildcards_used": metadata.get("wildcards_used", []),
            "truncated": metadata.get("embedded_prompts_truncated", False),
            "prompts": metadata.get("prompts", []),
        }
    return copy.deepcopy(metadata)


def _bounded_batch_metadata(metadata: dict[str, Any]) -> dict[str, Any]:
    if not metadata.get("batch"):
        return copy.deepcopy(metadata)
    bounded = {key: copy.deepcopy(value) for key, value in metadata.items() if key != "prompts"}
    prompts = metadata.get("prompts") if isinstance(metadata.get("prompts"), list) else []
    kept: list[Any] = []
    for item in prompts:
        candidate = [*kept, item]
        bounded["prompts"] = candidate
        if len(compact_json(bounded)) > EMBEDDED_BATCH_CHAR_LIMIT:
            break
        kept.append(copy.deepcopy(item))
    bounded["prompts"] = kept
    bounded["embedded_prompts_count"] = len(kept)
    bounded["embedded_prompts_truncated"] = len(kept) < len(prompts)
    return bounded


def _parameters_text(metadata: dict[str, Any]) -> str:
    if metadata.get("batch"):
        prompts = metadata.get("prompts") if isinstance(metadata.get("prompts"), list) else []
        first = prompts[0] if prompts and isinstance(prompts[0], dict) else {}
        prompt = str(first.get("positive_prompt", ""))
        negative = str(first.get("negative_prompt", ""))
        seed = first.get("seed")
        suffix = f"Prompt Palette batch: {metadata.get('count', len(prompts))} prompts"
    else:
        prompt = str(metadata.get("positive_prompt", ""))
        negative = str(metadata.get("negative_prompt", ""))
        seed = metadata.get("seed")
        suffix = "Prompt Palette resolved prompt"
    lines = [prompt]
    if negative:
        lines.append(f"Negative prompt: {negative}")
    details = []
    if seed is not None:
        details.append(f"Seed: {seed}")
    details.append(suffix)
    lines.append(", ".join(details))
    return "\n".join(lines)


def merge_prompt_metadata(
    extra_pnginfo: dict[str, Any],
    metadata: dict[str, Any],
    *,
    node_id: str = "",
    update_workflow: bool = True,
    set_primary: bool = True,
) -> dict[str, Any]:
    """Merge one Prompt Palette record into a queue-local EXTRA_PNGINFO mapping."""
    published = copy.deepcopy(metadata)
    if node_id:
        published["node_id"] = str(node_id)

    embedded = _bounded_batch_metadata(published)
    container = extra_pnginfo.get("prompt_palette")
    if not isinstance(container, dict):
        container = {"schema": PROMPT_METADATA_SCHEMA, "nodes": {}}
        extra_pnginfo["prompt_palette"] = container
    container["schema"] = PROMPT_METADATA_SCHEMA
    nodes = container.get("nodes")
    if not isinstance(nodes, dict):
        nodes = {}
        container["nodes"] = nodes
    record_key = str(node_id or published.get("node_type", "PromptPalette"))
    nodes[record_key] = embedded

    if set_primary:
        container["primary_node_id"] = str(node_id)
        container["primary"] = embedded

        # Plain aliases let asset managers show the final prompt without
        # understanding Prompt Palette's wildcard syntax.
        if not published.get("batch"):
            resolved = published.get("positive_prompt", "")
            source = published.get("source_prompt", "")
            extra_pnginfo["positive_prompt"] = resolved
            extra_pnginfo["resolved_prompt"] = resolved
            extra_pnginfo["negative_prompt"] = published.get("negative_prompt", "")
            extra_pnginfo["prompt_source"] = source
            extra_pnginfo["raw_prompt"] = source
            extra_pnginfo["wildcard_prompt"] = source
            extra_pnginfo["negative_prompt_source"] = published.get(
                "source_negative_prompt", ""
            )
        else:
            prompt_items = [
                item for item in embedded.get("prompts", []) if isinstance(item, dict)
            ]
            resolved_prompts = [
                item.get("positive_prompt", "") for item in prompt_items
            ]
            source = published.get("source_prompt", "")
            extra_pnginfo["positive_prompts"] = resolved_prompts
            extra_pnginfo["resolved_prompts"] = resolved_prompts
            extra_pnginfo["positive_prompt"] = resolved_prompts[0] if resolved_prompts else ""
            extra_pnginfo["resolved_prompt"] = resolved_prompts[0] if resolved_prompts else ""
            extra_pnginfo["negative_prompt"] = (
                prompt_items[0].get("negative_prompt", "") if prompt_items else ""
            )
            extra_pnginfo["prompt_source"] = source
            extra_pnginfo["raw_prompt"] = source
            extra_pnginfo["wildcard_prompt"] = source
        extra_pnginfo["parameters"] = _parameters_text(embedded)
        extra_pnginfo["prompt_palette_metadata"] = embedded

    if update_workflow:
        workflow_node = _workflow_node(extra_pnginfo.get("workflow"), str(node_id))
        if workflow_node is not None:
            properties = workflow_node.get("properties")
            if not isinstance(properties, dict):
                properties = {}
                workflow_node["properties"] = properties
            properties["prompt_palette_last_result"] = _workflow_summary(embedded)
            properties["prompt_palette_source_text"] = published.get(
                "source_text", published.get("source_prompt", "")
            )
            if not published.get("batch"):
                properties["prompt_palette_resolved_prompt"] = published.get(
                    "positive_prompt", ""
                )
                properties["prompt_palette_resolved_negative_prompt"] = published.get(
                    "negative_prompt", ""
                )

    return published


def publish_prompt_metadata(node_cls: type, metadata: dict[str, Any]) -> dict[str, Any]:
    """Publish metadata to EXTRA_PNGINFO without modifying executable prompt inputs."""
    node_id = _node_id(node_cls)
    extra_pnginfo = _hidden_value(node_cls, "extra_pnginfo")
    if not isinstance(extra_pnginfo, dict):
        published = copy.deepcopy(metadata)
        if node_id:
            published["node_id"] = node_id
        return published
    prompt = _hidden_value(node_cls, "prompt")
    return merge_prompt_metadata(
        extra_pnginfo,
        metadata,
        node_id=node_id,
        update_workflow=True,
        set_primary=_should_set_primary(extra_pnginfo, prompt, node_id),
    )
