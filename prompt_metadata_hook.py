"""Queue-time metadata restoration for cached Prompt Palette executions."""

from __future__ import annotations

import logging
from typing import Any

from .prompt_metadata import merge_prompt_metadata, prompt_reference_scores

logger = logging.getLogger(__name__)
_NODE_TYPES = {"PromptPaletteEditor", "PromptPaletteCombinatorial"}
_REGISTER_MARKER = "_prompt_palette_metadata_hook_registered"


def _is_link(value: Any) -> bool:
    return (
        isinstance(value, (list, tuple))
        and len(value) == 2
        and isinstance(value[0], (str, int))
        and isinstance(value[1], int)
    )


def _literal(inputs: dict[str, Any], name: str, default: Any = "") -> tuple[bool, Any]:
    value = inputs.get(name, default)
    if _is_link(value):
        return False, None
    return True, value


def _same_text(inputs: dict[str, Any], name: str, expected: Any, default: str = "") -> bool:
    literal, value = _literal(inputs, name, default)
    return literal and str(value if value is not None else "") == str(expected or "")


def _same_int(inputs: dict[str, Any], name: str, expected: Any, default: int = 0) -> bool:
    literal, value = _literal(inputs, name, default)
    if not literal:
        return False
    try:
        return int(value) == int(expected)
    except (TypeError, ValueError, OverflowError):
        return False


def _loras_match_connection_state(metadata: dict[str, Any], inputs: dict[str, Any]) -> bool:
    loras = metadata.get("loras")
    if not loras and metadata.get("batch"):
        prompts = metadata.get("prompts")
        if isinstance(prompts, list):
            loras = [
                lora
                for item in prompts
                if isinstance(item, dict)
                for lora in (item.get("loras") or [])
            ]
    if not loras:
        return True
    expected_applied = _is_link(inputs.get("model")) and _is_link(inputs.get("clip"))
    if metadata.get("batch"):
        prompts = metadata.get("prompts") if isinstance(metadata.get("prompts"), list) else []
        applied_values = {
            bool(item.get("loras_applied")) for item in prompts if isinstance(item, dict)
        }
        return not applied_values or applied_values == {expected_applied}
    return bool(metadata.get("loras_applied")) == expected_applied


def _editor_metadata_is_fresh(metadata: dict[str, Any], inputs: dict[str, Any]) -> bool:
    if not _same_text(inputs, "text", metadata.get("source_text", "")):
        return False
    if not _same_text(
        inputs, "processing_mode", metadata.get("processing_mode", "entire text as one"),
        "entire text as one",
    ):
        return False
    for input_name, metadata_name in (
        ("prompt_prefix", "prompt_prefix"),
        ("prompt_suffix", "prompt_suffix"),
        ("enhancer_override", "enhancer_override"),
        ("negative_text", "source_negative_text"),
        ("negative_prefix", "negative_prefix"),
        ("negative_suffix", "negative_suffix"),
    ):
        if not _same_text(inputs, input_name, metadata.get(metadata_name, "")):
            return False

    external_literal, external_seed = _literal(inputs, "external_seed", None)
    if not external_literal:
        return False
    effective_seed = external_seed if external_seed is not None else inputs.get("seed", 0)
    try:
        if int(effective_seed) != int(metadata.get("seed", 0)):
            return False
    except (TypeError, ValueError, OverflowError):
        return False
    return _loras_match_connection_state(metadata, inputs)


def _combinatorial_metadata_is_fresh(metadata: dict[str, Any], inputs: dict[str, Any]) -> bool:
    if not _same_text(inputs, "text", metadata.get("source_text", metadata.get("source_prompt", ""))):
        return False
    checks = (
        ("mode", metadata.get("mode", "random"), "random"),
        ("seed_mode", metadata.get("seed_mode", "sequential"), "sequential"),
    )
    for name, expected, default in checks:
        if not _same_text(inputs, name, expected, default):
            return False
    for name, expected, default in (
        ("seed", metadata.get("seed", 0), 0),
        ("count", metadata.get("requested_count", 10), 10),
        ("max_prompts", metadata.get("max_prompts", 0), 0),
    ):
        if not _same_int(inputs, name, expected, default):
            return False
    return _loras_match_connection_state(metadata, inputs)


def _metadata_is_fresh(metadata: dict[str, Any], api_node: dict[str, Any]) -> bool:
    if not isinstance(metadata, dict) or metadata.get("schema") != "prompt-palette.prompt-metadata.v1":
        return False
    inputs = api_node.get("inputs")
    if not isinstance(inputs, dict):
        return False
    node_type = str(api_node.get("class_type", metadata.get("node_type", "")))
    if node_type == "PromptPaletteEditor":
        return _editor_metadata_is_fresh(metadata, inputs)
    if node_type == "PromptPaletteCombinatorial":
        return _combinatorial_metadata_is_fresh(metadata, inputs)
    return False


def _restore_cached_metadata(json_data: dict[str, Any]) -> dict[str, Any]:
    """Republish saved results when core caching skips the Prompt Palette node."""
    try:
        prompt = json_data.get("prompt")
        extra_data = json_data.get("extra_data")
        if not isinstance(prompt, dict) or not isinstance(extra_data, dict):
            return json_data
        extra_pnginfo = extra_data.get("extra_pnginfo")
        if not isinstance(extra_pnginfo, dict):
            return json_data
        workflow = extra_pnginfo.get("workflow")
        workflow_nodes = workflow.get("nodes") if isinstance(workflow, dict) else None
        if not isinstance(workflow_nodes, list):
            return json_data

        scores = prompt_reference_scores(prompt)
        candidates: list[tuple[int, int, str, dict[str, Any]]] = []
        for order, workflow_node in enumerate(workflow_nodes):
            if not isinstance(workflow_node, dict):
                continue
            node_id = str(workflow_node.get("id", ""))
            api_node = prompt.get(node_id)
            if not isinstance(api_node, dict) or api_node.get("class_type") not in _NODE_TYPES:
                continue
            properties = workflow_node.get("properties")
            metadata = (
                properties.get("prompt_palette_last_result")
                if isinstance(properties, dict)
                else None
            )
            if not isinstance(metadata, dict) or not _metadata_is_fresh(metadata, api_node):
                continue
            candidates.append((scores.get(node_id, 0), order, node_id, metadata))

        if not candidates:
            return json_data
        for _score, _order, node_id, metadata in candidates:
            merge_prompt_metadata(
                extra_pnginfo,
                metadata,
                node_id=node_id,
                update_workflow=False,
                set_primary=False,
            )
        _score, _order, node_id, metadata = max(candidates, key=lambda item: (item[0], item[1]))
        merge_prompt_metadata(
            extra_pnginfo,
            metadata,
            node_id=node_id,
            update_workflow=False,
            set_primary=True,
        )
    except Exception:
        logger.exception("Prompt Palette could not restore cached prompt metadata")
    return json_data


def register_prompt_metadata_hook() -> bool:
    try:
        from server import PromptServer

        server = PromptServer.instance
        add_handler = getattr(server, "add_on_prompt_handler", None)
        if not callable(add_handler):
            logger.info("Prompt Palette cached-metadata hook is unavailable in this ComfyUI build")
            return False
        if getattr(server, _REGISTER_MARKER, False):
            return True
        add_handler(_restore_cached_metadata)
        setattr(server, _REGISTER_MARKER, True)
        return True
    except Exception:
        logger.exception("Prompt Palette could not register its cached-metadata hook")
        return False
