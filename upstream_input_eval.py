"""Evaluate upstream ComfyUI node chains to import text before execution."""

from __future__ import annotations

import asyncio
import inspect
from typing import Any

MAX_UPSTREAM_NODES = 64


def _default_node_mappings() -> dict[str, Any]:
    import nodes

    return getattr(nodes, "NODE_CLASS_MAPPINGS", {})


def _is_link(value: Any) -> bool:
    return (
        isinstance(value, (list, tuple))
        and len(value) == 2
        and isinstance(value[0], (str, int))
        and isinstance(value[1], int)
        and not isinstance(value[1], bool)
    )


def _filter_kwargs(fn: Any, raw_kwargs: dict[str, Any]) -> dict[str, Any]:
    try:
        sig = inspect.signature(fn)
    except (TypeError, ValueError):
        return dict(raw_kwargs)
    if any(p.kind == inspect.Parameter.VAR_KEYWORD for p in sig.parameters.values()):
        return dict(raw_kwargs)
    return {k: v for k, v in raw_kwargs.items() if k in sig.parameters}


def _missing_required_param(fn: Any, required_names: list[str], provided: dict[str, Any]) -> str | None:
    try:
        sig = inspect.signature(fn)
    except (TypeError, ValueError):
        return None
    has_var_kw = any(p.kind == inspect.Parameter.VAR_KEYWORD for p in sig.parameters.values())
    for name in required_names:
        if name in provided:
            continue
        param = sig.parameters.get(name)
        if param is not None and param.default is inspect.Parameter.empty and not has_var_kw:
            return name
    return None


def _unwrap_result(result: Any) -> tuple[Any, ...]:
    if isinstance(result, dict) and "result" in result:
        result = result["result"]
    elif hasattr(result, "result") and not isinstance(result, (str, bytes, tuple, list)):
        result = result.result
    if isinstance(result, tuple):
        return result
    if isinstance(result, list):
        return tuple(result)
    return (result,)


def _coerce_output_text(value: Any, output_index: int) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, (int, float, bool)):
        return str(value)
    if isinstance(value, (list, tuple)):
        parts: list[str] = []
        for item in value:
            if item is None:
                continue
            if isinstance(item, (str, int, float, bool)):
                parts.append(str(item))
            else:
                raise ValueError(
                    f"Upstream output #{output_index} contains non-text item ({type(item).__name__})."
                )
        return "\n".join(parts)
    raise ValueError(f"Upstream output #{output_index} is not text (got {type(value).__name__}).")


async def _invoke_callable(fn: Any, kwargs: dict[str, Any]) -> Any:
    if inspect.iscoroutinefunction(fn):
        return await fn(**kwargs)
    result = await asyncio.to_thread(fn, **kwargs)
    if inspect.isawaitable(result):
        result = await result
    return result


async def evaluate_upstream_text(
    prompt_graph: dict[str, Any],
    target_node_id: str | int,
    output_index: int = 0,
    node_mappings: dict[str, Any] | None = None,
) -> str:
    """Evaluate only the upstream subgraph required to resolve one text output."""
    if not isinstance(prompt_graph, dict) or not prompt_graph:
        raise ValueError("Upstream prompt graph is empty.")
    if len(prompt_graph) > MAX_UPSTREAM_NODES:
        raise ValueError(f"Upstream chain exceeds {MAX_UPSTREAM_NODES} nodes.")
    if not isinstance(output_index, int) or isinstance(output_index, bool) or output_index < 0:
        raise ValueError("Invalid upstream output slot index.")

    target_id = str(target_node_id)
    if target_id not in prompt_graph:
        raise ValueError(f"Upstream node '{target_id}' is not in the submitted subgraph.")

    mappings = node_mappings if node_mappings is not None else _default_node_mappings()
    cache: dict[str, tuple[Any, ...]] = {}
    visiting: set[str] = set()

    async def eval_node(node_id: str) -> tuple[Any, ...]:
        if node_id in cache:
            return cache[node_id]
        if node_id in visiting:
            raise ValueError("Upstream node connections form a cycle.")
        spec = prompt_graph.get(node_id)
        if not isinstance(spec, dict):
            raise ValueError(f"Upstream node '{node_id}' has an invalid definition.")

        class_type = str(spec.get("class_type") or "")
        raw_inputs = spec.get("inputs") or {}
        if not isinstance(raw_inputs, dict):
            raise ValueError(f"Upstream node '{class_type or node_id}' has invalid inputs.")

        visiting.add(node_id)
        try:
            resolved_inputs: dict[str, Any] = {}
            for key, value in raw_inputs.items():
                if _is_link(value):
                    up_id = str(value[0])
                    up_slot = value[1]
                    up_outputs = await eval_node(up_id)
                    if up_slot < 0 or up_slot >= len(up_outputs):
                        raise ValueError(
                            f"Upstream node '{up_id}' did not produce output slot #{up_slot}."
                        )
                    resolved_inputs[key] = up_outputs[up_slot]
                else:
                    resolved_inputs[key] = value

            if class_type == "Reroute":
                passthrough = next(iter(resolved_inputs.values()), "")
                result_tuple = (passthrough,)
                cache[node_id] = result_tuple
                return result_tuple

            if class_type == "PrimitiveNode":
                primitive_val = next(iter(resolved_inputs.values()), "")
                result_tuple = (primitive_val,)
                cache[node_id] = result_tuple
                return result_tuple

            node_cls = mappings.get(class_type)
            if node_cls is None:
                raise ValueError(f"Node type '{class_type}' is not available on the server.")

            if hasattr(node_cls, "define_schema") and callable(getattr(node_cls, "execute", None)):
                fn = node_cls.execute
                call_kwargs = _filter_kwargs(fn, resolved_inputs)
                raw_result = await _invoke_callable(fn, call_kwargs)
            else:
                fn_name = getattr(node_cls, "FUNCTION", None)
                if not fn_name or not hasattr(node_cls, fn_name):
                    raise ValueError(f"Node type '{class_type}' cannot be evaluated directly.")

                input_types = {}
                if callable(getattr(node_cls, "INPUT_TYPES", None)):
                    try:
                        input_types = node_cls.INPUT_TYPES() or {}
                    except Exception:
                        input_types = {}

                hidden_spec = input_types.get("hidden")
                if isinstance(hidden_spec, dict):
                    for hidden_key, hidden_type in hidden_spec.items():
                        if hidden_key in resolved_inputs:
                            continue
                        if hidden_type == "PROMPT":
                            resolved_inputs[hidden_key] = prompt_graph
                        elif hidden_type == "EXTRA_PNGINFO":
                            resolved_inputs[hidden_key] = {}
                        elif hidden_type == "UNIQUE_ID":
                            resolved_inputs[hidden_key] = node_id

                instance = node_cls()
                fn = getattr(instance, fn_name)
                required_spec = input_types.get("required")
                required_names = list(required_spec.keys()) if isinstance(required_spec, dict) else []
                missing = _missing_required_param(fn, required_names, resolved_inputs)
                if missing:
                    raise ValueError(
                        f"Upstream node '{class_type}' is missing required input '{missing}'."
                    )

                call_kwargs = _filter_kwargs(fn, resolved_inputs)
                raw_result = await _invoke_callable(fn, call_kwargs)

            result_tuple = _unwrap_result(raw_result)
            cache[node_id] = result_tuple
            return result_tuple
        finally:
            visiting.discard(node_id)

    outputs = await eval_node(target_id)
    if output_index >= len(outputs):
        raise ValueError(
            f"Upstream node '{target_id}' produced {len(outputs)} output(s); slot #{output_index} is unavailable."
        )
    return _coerce_output_text(outputs[output_index], output_index)
