"""Standalone ComfyUI visual label and workflow-organization node (LabelPal).

This module is intentionally independent of Prompt Palette's prompt resolution,
wildcard library, and LoRA subsystems so it works as a general-purpose ComfyUI
canvas utility in any workflow.
"""

from __future__ import annotations

import inspect

from .comfy_compat import io

_SCHEMA_SUPPORTS_SEARCH_ALIASES = "search_aliases" in inspect.signature(io.Schema).parameters


class _StandaloneV3Node(io.ComfyNode):
    """Isolated V3 schema cache base for standalone utility nodes."""

    _SCHEMA_CACHE_FIELDS = (
        "_DESCRIPTION",
        "_CATEGORY",
        "_EXPERIMENTAL",
        "_DEPRECATED",
        "_DEV_ONLY",
        "_API_NODE",
        "_OUTPUT_NODE",
        "_HAS_INTERMEDIATE_OUTPUT",
        "_INPUT_IS_LIST",
        "_OUTPUT_IS_LIST",
        "_RETURN_TYPES",
        "_RETURN_NAMES",
        "_OUTPUT_TOOLTIPS",
        "_NOT_IDEMPOTENT",
        "_ACCEPT_ALL_INPUTS",
    )

    def __init_subclass__(cls, **kwargs):
        super().__init_subclass__(**kwargs)
        for field in cls._SCHEMA_CACHE_FIELDS:
            try:
                setattr(cls, field, None)
            except AttributeError:
                return


class LabelPal(_StandaloneV3Node):
    """Zero-cost visual section header, banner, and sticky-note node for ComfyUI."""

    COLOR_PRESETS = (
        "amber",
        "cherry",
        "tangerine",
        "lime",
        "cyan",
        "plum",
        "cream",
        "slate",
    )
    STYLE_VARIANTS = ("card", "banner", "sticky", "minimal", "text")
    TEXT_SIZES = ("sm", "md", "lg", "xl")

    @classmethod
    def define_schema(cls) -> io.Schema:
        schema_kwargs = {
            "node_id": "LabelPal",
            "display_name": "LabelPal",
            "category": "PromptPalette",
            "is_output_node": False,
            "description": (
                "LabelPal (by z3rofeels): standalone visual section label, stage "
                "banner, and sticky-note card for organizing any ComfyUI workflow. "
                "Purely visual with zero backend execution cost."
            ),
            "inputs": [
                io.String.Input(
                    "title",
                    display_name="Title",
                    tooltip="Main heading text. Use 'TAG · Heading' to show an eyebrow badge above the title.",
                    multiline=False,
                    default="Section Label",
                    dynamic_prompts=False,
                ),
                io.String.Input(
                    "note",
                    display_name="Note",
                    tooltip="Optional supporting instructions. Supports '- ' bullets, '1. ' steps, **bold**, and `code` chips.",
                    multiline=True,
                    default="",
                    optional=True,
                    dynamic_prompts=False,
                ),
                io.Combo.Input(
                    "color_preset",
                    display_name="Color",
                    tooltip="Coordinated color preset used to categorize workflow sections.",
                    options=list(cls.COLOR_PRESETS),
                    default="amber",
                    optional=True,
                ),
                io.Combo.Input(
                    "style_variant",
                    display_name="Style",
                    tooltip="Card (structured note), Banner (stage header), Sticky (warm note), Minimal (quiet card), or Text (no node box, floating text only).",
                    options=list(cls.STYLE_VARIANTS),
                    default="card",
                    optional=True,
                ),
                io.Combo.Input(
                    "text_size",
                    display_name="Size",
                    tooltip="Typography scale for the heading and supporting text (S, M, L, XL).",
                    options=list(cls.TEXT_SIZES),
                    default="md",
                    optional=True,
                ),
            ],
            "outputs": [],
        }
        if _SCHEMA_SUPPORTS_SEARCH_ALIASES:
            schema_kwargs["search_aliases"] = [
                "label",
                "note",
                "sticky note",
                "section header",
                "banner",
                "callout",
                "workflow guide",
            ]
        return io.Schema(**schema_kwargs)

    @classmethod
    def execute(cls, **_kwargs) -> io.NodeOutput:
        return io.NodeOutput()


__all__ = ["LabelPal"]
