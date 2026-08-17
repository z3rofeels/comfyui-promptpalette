import json
import math
import re
import random
import logging

import comfy.sd
import comfy.utils
import folder_paths
from .comfy_compat import io

from .wildcard_index import get_index
from .wildcard_resolver import WildcardResolver
from .clip_tokenizer import count_clip_tokens
from .prompt_metadata import (
    build_prompt_metadata, compact_json, compose_source_prompt, publish_prompt_metadata,
)

logger = logging.getLogger(__name__)

UINT64_MAX = 0xFFFFFFFFFFFFFFFF


def _coerce_int(value, default=0):
    if isinstance(value, bool):
        return default
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value) if math.isfinite(value) and value.is_integer() else default
    if isinstance(value, str) and re.fullmatch(r"[+-]?\d+", value.strip()):
        try:
            return int(value.strip())
        except (ValueError, OverflowError):
            return default
    return default


def _coerce_uint64(value, default=0):
    parsed = _coerce_int(value, default)
    return max(0, min(parsed, UINT64_MAX))


def _coerce_text(value):
    return value if isinstance(value, str) else "" if value is None else str(value)


def _coerce_choice(value, choices, default):
    return value if isinstance(value, str) and value in choices else default

_DYNAMIC_PROMPT_RE = re.compile(
    r"__(?:[+\-*%~@][A-Za-z0-9_\-/*]+|[A-Za-z0-9_\-/]+\([^()]*\))__"
    r"|\{[+\-*%~@][^{}]*\}"
)


def _prompt_uses_runtime_sequence(*values):
    return any(_DYNAMIC_PROMPT_RE.search(_coerce_text(value)) for value in values)

class PromptPaletteEditor(io.ComfyNode):

    _LORA_TAG_RE = re.compile(
        r"<lora:([^:>]+):([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)>"
    )

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(

            node_id="PromptPaletteEditor",
            display_name="Prompt Palette",
            category="PromptPalette",
            description=(
                "Prompt Palette (by z3rofeels): a wildcard-aware prompt box that "
                "doubles as an active CLIP encoder. Resolves __wildcard__ syntax "
                "plus optional prefix/suffix/negative text, then - depending on "
                "which of the optional CLIP/MODEL sockets are connected - either "
                "outputs plain resolved text or fully encodes it into "
                "CONDITIONING, loading any <lora:name:weight> tags along the "
                "way if MODEL is also wired in. Also reports the resolved "
                "prompt's real CLIP-L token count."
            ),
            inputs=[
                io.String.Input(
                    "text",
                    display_name="Prompt",
                    tooltip="Wildcard-aware source prompt edited in Prompt Palette.",
                    multiline=True,
                    default="",
                    dynamic_prompts=False,
                ),
                io.Int.Input(
                    "seed",
                    display_name="Seed",
                    tooltip="Seed used for deterministic wildcard resolution.",
                    default=0,
                    min=0,
                    max=0xFFFFFFFFFFFFFFFF,
                ),
                io.Combo.Input(
                    "processing_mode",
                    display_name="Processing mode",
                    tooltip="Resolve the prompt as one block or resolve each line independently.",
                    options=["entire text as one", "line by line"],
                    default="entire text as one",
                ),

                io.Clip.Input(
                    "clip",
                    display_name="CLIP",
                    tooltip="Optional CLIP input used to encode the resolved positive and negative prompts.",
                    optional=True,
                ),
                io.Model.Input(
                    "model",
                    display_name="Model",
                    tooltip="Optional model input; connect with CLIP to apply LoRA tags found in the prompt.",
                    optional=True,
                ),
                io.String.Input(
                    "prompt_prefix",
                    display_name="Prompt prefix",
                    tooltip="External wildcard-aware text prepended to the prompt.",
                    optional=True,
                    force_input=True,
                    default="",
                ),
                io.String.Input(
                    "prompt_suffix",
                    display_name="Prompt suffix",
                    tooltip="External wildcard-aware text appended to the prompt.",
                    optional=True,
                    force_input=True,
                    default="",
                ),
                io.String.Input(
                    "enhancer_override",
                    display_name="LLM / enhancer override",
                    tooltip="A non-empty value replaces the resolved positive prompt.",
                    optional=True,
                    force_input=True,
                    default="",
                ),
                io.Int.Input(
                    "external_seed",
                    display_name="External seed",
                    tooltip="Optional external seed that takes precedence over the node's Seed control.",
                    optional=True,
                    force_input=True,
                ),
                io.String.Input(
                    "negative_text",
                    display_name="Negative prompt (text)",
                    tooltip="Optional wildcard-aware negative prompt text.",
                    optional=True,
                    force_input=True,
                    multiline=True,
                    default="",
                ),

                io.String.Input(
                    "negative_prefix",
                    display_name="Negative prefix",
                    tooltip="External wildcard-aware text prepended to the negative prompt.",
                    optional=True,
                    force_input=True,
                    default="",
                ),
                io.String.Input(
                    "negative_suffix",
                    display_name="Negative suffix",
                    tooltip="External wildcard-aware text appended to the negative prompt.",
                    optional=True,
                    force_input=True,
                    default="",
                ),
            ],

            hidden=[io.Hidden.unique_id, io.Hidden.prompt, io.Hidden.extra_pnginfo],
            outputs=[
                io.Model.Output(
                    "model",
                    display_name="Model (passthrough)",
                    tooltip="Connected model, patched with prompt LoRAs when CLIP is also connected.",
                ),
                io.Clip.Output(
                    "clip",
                    display_name="CLIP (passthrough)",
                    tooltip="Connected CLIP, patched alongside the model when prompt LoRAs are applied.",
                ),
                io.Conditioning.Output(
                    "conditioning",
                    display_name="Conditioning",
                    tooltip="Resolved positive prompt encoded with the connected CLIP.",
                ),
                io.Conditioning.Output(
                    "negative_conditioning",
                    display_name="Negative conditioning",
                    tooltip="Resolved negative prompt encoded with the connected CLIP.",
                ),
                io.String.Output(
                    "prompt",
                    display_name="Prompt",
                    tooltip="Final resolved prompt text, or the enhancer override when used.",
                ),
                io.String.Output(
                    "negative_prompt",
                    display_name="Negative prompt",
                    tooltip="Final resolved negative prompt text.",
                ),
                io.Int.Output(
                    "seed_out",
                    display_name="Seed used",
                    tooltip="Seed actually used for this resolution.",
                ),
                io.String.Output(
                    "wildcards_used",
                    display_name="Wildcards used (JSON)",
                    tooltip="JSON list of wildcard files used during this resolution.",
                ),
                io.String.Output(
                    "raw_text",
                    display_name="Raw text (unresolved)",
                    tooltip="Source prompt before wildcard resolution.",
                ),
                io.Int.Output(
                    "wildcards_used_count",
                    display_name="Wildcards used (count)",
                    tooltip="Number of distinct wildcard files used during this resolution.",
                ),
                io.Boolean.Output(
                    "used_enhancer",
                    display_name="Used enhancer override",
                    tooltip="True when the enhancer override replaced the resolved prompt.",
                ),
                io.Int.Output(
                    "clip_token_count",
                    display_name="CLIP token count",
                    tooltip="CLIP-L token count for the final prompt, or -1 when unavailable.",
                ),
                io.String.Output(
                    "prompt_metadata_json",
                    display_name="Prompt metadata (JSON)",
                    tooltip="Final and source prompts plus seed, wildcard, LoRA, and execution metadata.",
                ),
            ],
        )

    @classmethod
    def fingerprint_inputs(
        cls, text="", prompt_prefix="", prompt_suffix="", enhancer_override="",
        negative_text="", negative_prefix="", negative_suffix="", **_kwargs,
    ):
        if _prompt_uses_runtime_sequence(
            text, prompt_prefix, prompt_suffix, enhancer_override,
            negative_text, negative_prefix, negative_suffix,
        ):
            return float("nan")
        return get_index().fingerprint()

    @classmethod
    def _extract_loras(cls, text):

        loras = []

        def _capture(m):
            name = m.group(1).strip()
            try:
                weight = float(m.group(2))
            except (ValueError, OverflowError):
                weight = 1.0
            if not math.isfinite(weight):
                weight = 1.0
            loras.append((name, weight))
            return ""

        clean = cls._LORA_TAG_RE.sub(_capture, text)

        clean = re.sub(r"[ \t]+", " ", clean)
        clean = "\n".join(line.strip() for line in clean.splitlines())
        clean = re.sub(r"\n{2,}", "\n", clean).strip()
        return clean, loras

    @classmethod
    def _lora_records(cls, text, source):
        records = []
        for match in cls._LORA_TAG_RE.finditer(text or ""):
            try:
                weight = float(match.group(2))
            except (ValueError, OverflowError):
                weight = 1.0
            if not math.isfinite(weight):
                weight = 1.0
            records.append({
                "name": match.group(1).strip(),
                "weight": weight,
                "model_strength": weight,
                "clip_strength": weight,
                "source": source,
            })
        return records

    @staticmethod
    def _apply_loras(model, clip, loras):

        for name, weight in loras:
            lora_path = folder_paths.get_full_path("loras", name)
            if lora_path is None:

                for ext in (".safetensors", ".pt", ".ckpt"):
                    candidate = folder_paths.get_full_path("loras", name + ext)
                    if candidate is not None:
                        lora_path = candidate
                        break
            if lora_path is None:
                logger.warning("LoRA %r was not found in the loras folder; skipping it", name)
                continue
            lora_sd = comfy.utils.load_torch_file(lora_path, safe_load=True)
            model, clip = comfy.sd.load_lora_for_models(model, clip, lora_sd, weight, weight)
        return model, clip

    @staticmethod
    def _encode(clip, text):
        tokens = clip.tokenize(text)
        cond, pooled = clip.encode_from_tokens(tokens, return_pooled=True)
        return [[cond, {"pooled_output": pooled}]]

    @classmethod
    def execute(cls, text, seed, processing_mode,
                clip=None, model=None,
                prompt_prefix="", prompt_suffix="", enhancer_override="",
                external_seed=None, negative_text="",
                negative_prefix="", negative_suffix=""):
        processing_mode = _coerce_choice(
            processing_mode, {"entire text as one", "line by line"}, "entire text as one"
        )
        text = _coerce_text(text)
        prompt_prefix = _coerce_text(prompt_prefix)
        prompt_suffix = _coerce_text(prompt_suffix)
        enhancer_override = _coerce_text(enhancer_override)
        negative_text = _coerce_text(negative_text)
        negative_prefix = _coerce_text(negative_prefix)
        negative_suffix = _coerce_text(negative_suffix)
        resolver = WildcardResolver(get_index())
        seed = _coerce_uint64(seed)
        effective_seed = seed if external_seed is None else _coerce_uint64(external_seed, seed)
        source_prompt = compose_source_prompt([prompt_prefix, text, prompt_suffix], processing_mode)
        source_negative_prompt = compose_source_prompt(
            [negative_prefix, negative_text, negative_suffix], processing_mode
        )

        def resolve_block(t, seed_offset=0):
            if not t:
                return ""
            if processing_mode == "line by line":
                return "\n".join(resolver.resolve_lines(t, seed=effective_seed + seed_offset))
            return resolver.resolve(t, seed=effective_seed + seed_offset)

        body = resolve_block(text)
        parts = [p for p in (resolve_block(prompt_prefix, -1), body, resolve_block(prompt_suffix, 1)) if p]
        resolved = "\n".join(parts) if processing_mode == "line by line" else " ".join(parts)

        used_enhancer = bool(enhancer_override and enhancer_override.strip())
        if used_enhancer:
            resolved = enhancer_override

        neg_parts = [p for p in (
            resolve_block(negative_prefix, 1001),
            resolve_block(negative_text, 1000),
            resolve_block(negative_suffix, 1002),
        ) if p]
        resolved_negative = "\n".join(neg_parts) if processing_mode == "line by line" else " ".join(neg_parts)

        used_names = sorted(set(resolver.used_names))
        wildcards_used = json.dumps(used_names)

        out_model, out_clip = model, clip
        conditioning, negative_conditioning = None, None
        lora_records = cls._lora_records(resolved, "positive") + cls._lora_records(
            resolved_negative, "negative"
        )
        loras_applied = False

        if model is not None and clip is not None:

            resolved, positive_loras = cls._extract_loras(resolved)
            resolved_negative, negative_loras = cls._extract_loras(resolved_negative)
            loras = positive_loras + negative_loras
            if loras:
                out_model, out_clip = cls._apply_loras(model, clip, loras)
                loras_applied = True
            conditioning = cls._encode(out_clip, resolved)
            negative_conditioning = cls._encode(out_clip, resolved_negative)
        elif clip is not None:

            conditioning = cls._encode(clip, resolved)
            negative_conditioning = cls._encode(clip, resolved_negative)
        elif model is not None:

            logger.warning(
                "A model was connected without CLIP; LoRA loading and conditioning are unavailable"
            )

        token_stats = count_clip_tokens(resolved)
        clip_token_count = token_stats["tokens"] if token_stats is not None else -1

        metadata = build_prompt_metadata(
            node_type="PromptPaletteEditor",
            prompt=resolved,
            negative_prompt=resolved_negative,
            source_prompt=source_prompt,
            source_negative_prompt=source_negative_prompt,
            source_text=text,
            source_negative_text=negative_text,
            seed=effective_seed,
            processing_mode=processing_mode,
            wildcards_used=used_names,
            used_enhancer=used_enhancer,
            enhancer_override=enhancer_override,
            loras=lora_records,
            clip_token_count=clip_token_count,
            extra={
                "loras_applied": loras_applied,
                "prompt_prefix": prompt_prefix,
                "prompt_suffix": prompt_suffix,
                "negative_prefix": negative_prefix,
                "negative_suffix": negative_suffix,
            },
        )
        published = publish_prompt_metadata(cls, metadata)
        return io.NodeOutput(
            out_model, out_clip, conditioning, negative_conditioning,
            resolved, resolved_negative, effective_seed, wildcards_used,
            text, len(used_names), used_enhancer, clip_token_count, compact_json(published),
            ui={"prompt_palette": published},
        )

class PromptPaletteCombinatorial(io.ComfyNode):

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="PromptPaletteCombinatorial",
            display_name="Prompt Palette (Combinatorial)",
            category="PromptPalette",
            description=(
                "Prompt Palette (by z3rofeels) - Combinatorial: batch-generates "
                "many prompts from one wildcard-aware text block in a single "
                "run, either by rolling `count` independently-seeded random "
                "resolutions or by expanding every combination of unmarked "
                "wildcard groups (combinatorial mode, capped by max_prompts). "
                "Optional CLIP/MODEL sockets encode each generated prompt to "
                "CONDITIONING and apply any per-prompt <lora:name:weight> tags, "
                "same as the base Prompt Palette node."
            ),
            inputs=[
                io.String.Input(
                    "text",
                    display_name="Prompt",
                    tooltip="Wildcard-aware source prompt expanded by this batch node.",
                    multiline=True,
                    default="",
                    dynamic_prompts=False,
                ),
                io.Combo.Input(
                    "mode",
                    display_name="Mode",
                    tooltip="Generate independent random prompts or expand every combination.",
                    options=["random", "combinatorial"],
                    default="random",
                ),
                io.Int.Input(
                    "count",
                    display_name="Count",
                    tooltip="Random mode only; number of prompts to generate.",
                    default=10,
                    min=1,
                    max=WildcardResolver.MAX_COMBINATORIAL_PROMPTS,
                ),
                io.Int.Input(
                    "seed",
                    display_name="Seed",
                    tooltip="Base seed for deterministic wildcard resolution.",
                    default=0,
                    min=0,
                    max=0xFFFFFFFFFFFFFFFF,
                ),
                io.Combo.Input(
                    "seed_mode",
                    display_name="Seed mode",
                    tooltip="Choose sequential, fixed, or deterministically randomized per-prompt seeds.",
                    options=["sequential", "fixed", "random"],
                    default="sequential",
                ),
                io.Int.Input(
                    "max_prompts",
                    display_name="Max prompts",
                    tooltip="Combinatorial mode safety cap; 0 uses the resolver default "
                            f"({WildcardResolver.MAX_COMBINATORIAL_PROMPTS}).",
                    default=0,
                    min=0,
                    max=WildcardResolver.MAX_COMBINATORIAL_PROMPTS,
                ),
                io.Clip.Input(
                    "clip",
                    display_name="CLIP",
                    tooltip="Optional CLIP input used to encode every generated prompt.",
                    optional=True,
                ),
                io.Model.Input(
                    "model",
                    display_name="Model",
                    tooltip="Optional model input used when applying per-prompt LoRA tags.",
                    optional=True,
                ),
            ],
            hidden=[io.Hidden.unique_id, io.Hidden.prompt, io.Hidden.extra_pnginfo],
            outputs=[
                io.Model.Output(
                    "model",
                    display_name="Model list",
                    tooltip="One model per prompt, individually patched when LoRA tags are applied.",
                    is_output_list=True,
                ),
                io.Clip.Output(
                    "clip",
                    display_name="CLIP list",
                    tooltip="One CLIP value per prompt, patched alongside the model when needed.",
                    is_output_list=True,
                ),
                io.Conditioning.Output(
                    "conditioning",
                    display_name="Conditioning list",
                    tooltip="One encoded conditioning value per prompt when CLIP is connected.",
                    is_output_list=True,
                ),
                io.String.Output(
                    "prompt",
                    display_name="Prompt list",
                    tooltip="Resolved prompt texts, one per generated item.",
                    is_output_list=True,
                ),
                io.Int.Output(
                    "seed_out",
                    display_name="Seed list",
                    tooltip="Resolution seed used for each generated prompt.",
                    is_output_list=True,
                ),
                io.String.Output(
                    "wildcards_used",
                    display_name="Wildcards used",
                    tooltip="Wildcard files used during this batch, repeated for list-compatible fan-out.",
                    is_output_list=True,
                ),
                io.String.Output(
                    "prompt_metadata_json",
                    display_name="Prompt metadata (JSON) list",
                    tooltip="One resolved/source metadata record per generated prompt.",
                    is_output_list=True,
                ),
            ],
        )

    @classmethod
    def fingerprint_inputs(cls, text="", **_kwargs):
        if _prompt_uses_runtime_sequence(text):
            return float("nan")
        return get_index().fingerprint()

    @staticmethod
    def _derive_seeds(seed, seed_mode, n):
        n = max(1, n)
        if seed_mode == "fixed":
            return [seed] * n
        if seed_mode == "sequential":
            return [(seed + i) & 0xFFFFFFFFFFFFFFFF for i in range(n)]
        rng = random.Random(seed)
        return [rng.randint(0, 0xFFFFFFFFFFFFFFFF) for _ in range(n)]

    @classmethod
    def execute(cls, text, mode, count, seed, seed_mode, max_prompts, clip=None, model=None):
        mode = _coerce_choice(mode, {"random", "combinatorial"}, "random")
        seed_mode = _coerce_choice(seed_mode, {"sequential", "fixed", "random"}, "sequential")
        text = _coerce_text(text)
        count = _coerce_int(count, 10)
        max_prompts = _coerce_int(max_prompts, 0)
        seed = _coerce_uint64(seed)
        count = max(1, min(count, WildcardResolver.MAX_COMBINATORIAL_PROMPTS))
        max_prompts = max(0, min(max_prompts, WildcardResolver.MAX_COMBINATORIAL_PROMPTS))
        resolver = WildcardResolver(get_index())

        if mode == "combinatorial":
            prompts = resolver.generate_combinatorial(text, seed=seed, max_prompts=max_prompts or None)
            if resolver.last_generation_truncated:
                cap = max_prompts or resolver.MAX_COMBINATORIAL_PROMPTS
                logger.warning(
                    "Combinatorial generation reached the %s-prompt safety cap; output is truncated",
                    cap,
                )
            if not prompts:
                prompts = [""]
            seeds_out = cls._derive_seeds(seed, seed_mode, len(prompts))
        else:
            seeds_out = cls._derive_seeds(seed, seed_mode, count)
            prompts = [resolver.resolve(text, seed=s) for s in seeds_out]

        used_names = sorted(set(resolver.used_names))
        wildcards_used = json.dumps(used_names)

        out_models, out_clips, conditioning, out_prompts = [], [], [], []
        prompt_metadata = []
        for index, p in enumerate(prompts):
            lora_records = PromptPaletteEditor._lora_records(p, "positive")
            loras_applied = False
            if model is not None and clip is not None:
                clean, loras = PromptPaletteEditor._extract_loras(p)
                m, c = PromptPaletteEditor._apply_loras(model, clip, loras) if loras else (model, clip)
                loras_applied = bool(loras)
                out_models.append(m)
                out_clips.append(c)
                conditioning.append(PromptPaletteEditor._encode(c, clean))
                out_prompts.append(clean)
            elif clip is not None:
                out_models.append(model)
                out_clips.append(clip)
                conditioning.append(PromptPaletteEditor._encode(clip, p))
                out_prompts.append(p)
            else:
                out_models.append(model)
                out_clips.append(clip)
                conditioning.append(None)
                out_prompts.append(p)
            prompt_metadata.append(build_prompt_metadata(
                node_type="PromptPaletteCombinatorial",
                prompt=out_prompts[-1],
                source_prompt=text,
                source_text=text,
                seed=seeds_out[index],
                processing_mode=mode,
                wildcards_used=used_names,
                loras=lora_records,
                extra={
                    "batch_index": index,
                    "batch_count": len(prompts),
                    "generation_mode": mode,
                    "seed_mode": seed_mode,
                    "loras_applied": loras_applied,
                },
            ))

        n = len(out_prompts)
        batch_metadata = {
            "schema": "prompt-palette.prompt-metadata.v1",
            "schema_version": 1,
            "generator": "Prompt Palette",
            "node_type": "PromptPaletteCombinatorial",
            "batch": True,
            "count": n,
            "source_prompt": text,
            "source_text": text,
            "mode": mode,
            "seed_mode": seed_mode,
            "seed": seed,
            "requested_count": count,
            "max_prompts": max_prompts,
            "wildcards_used": used_names,
            "truncated": bool(resolver.last_generation_truncated),
            "prompts": prompt_metadata,
        }
        published_batch = publish_prompt_metadata(cls, batch_metadata)
        ui_limit = 20
        ui_metadata = {key: value for key, value in published_batch.items() if key != "prompts"}
        ui_metadata["prompts"] = prompt_metadata[:ui_limit]
        ui_metadata["ui_prompts_count"] = len(ui_metadata["prompts"])
        ui_metadata["ui_prompts_truncated"] = n > ui_limit
        return io.NodeOutput(
            out_models, out_clips, conditioning, out_prompts, seeds_out, [wildcards_used] * n,
            [compact_json(item) for item in prompt_metadata],
            ui={"prompt_palette": ui_metadata},
        )

class PromptPaletteWeightController(io.ComfyNode):

    _WEIGHT_RE = re.compile(
        r"\(([^()]+):([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\)"
    )

    _SOFT_CLAMP_STEEPNESS = 8.0

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="PromptPaletteWeightController",
            display_name="Prompt Palette (Weight Controller)",
            category="PromptPalette",
            description=(
                "Prompt Palette (by z3rofeels) - Weight Controller: a universal "
                "per-phrase weighting front-end for `(phrase:weight)` syntax. "
                "Parses weighted segments out of any input text and re-emits "
                "them in the format your backend actually wants - bracketed "
                "SDXL/CLIP syntax, Krea 2/ZIT/Qwen-style, or plain de-bracketed "
                "text for LLM/T5 encoders - with optional soft clamping and "
                "negative-weight routing. Can also encode straight to "
                "CONDITIONING if CLIP is connected."
            ),
            inputs=[
                io.String.Input(
                    "text",
                    display_name="Text",
                    tooltip="Text containing optional (phrase:weight) segments.",
                    multiline=True,
                    default="",
                    dynamic_prompts=False,
                ),
                io.Combo.Input(
                    "weighting_mode",
                    display_name="Weighting mode",
                    tooltip="Choose the output syntax expected by the target text encoder.",
                    options=[
                        "SDXL / CLIP (Standard)",
                        "Krea 2 / ZIT (Qwen)",
                        "LTX 2.3 / T5 (LLM)",
                    ],
                    default="SDXL / CLIP (Standard)",
                ),
                io.Boolean.Input(
                    "advanced_controls",
                    display_name="Advanced controls",
                    tooltip="Show or hide the optional clamping and negative-routing controls.",
                    default=False,
                ),
                io.Combo.Input(
                    "weight_clamping",
                    display_name="Weight clamping",
                    tooltip="Optionally compress extreme weights with a soft safety clamp.",
                    options=["None", "Soft Safety Clamp"],
                    default="None",
                ),
                io.Combo.Input(
                    "negative_routing",
                    display_name="Negative routing",
                    tooltip="Choose how negative weights are represented in clean-text modes.",
                    options=["Direct", "Zero Inversion Null"],
                    default="Direct",
                ),
                io.Clip.Input(
                    "clip",
                    display_name="CLIP",
                    tooltip="Optional CLIP input for direct conditioning output.",
                    optional=True,
                ),
                io.Model.Input(
                    "model",
                    display_name="Model",
                    tooltip="Optional model passthrough for compact workflow wiring.",
                    optional=True,
                ),
            ],
            outputs=[
                io.String.Output(
                    "text",
                    display_name="Weighted text",
                    tooltip="Text formatted for the selected weighting mode.",
                ),
                io.Custom("DICT").Output(
                    "weight_dict",
                    display_name="Weight dictionary",
                    tooltip="Parsed phrase-to-weight values.",
                ),
                io.String.Output(
                    "negpip_compatible",
                    display_name="NegPip text",
                    tooltip="Bracketed text compatible with negative-weight pipelines.",
                ),
                io.Conditioning.Output(
                    "conditioning",
                    display_name="Conditioning",
                    tooltip="Encoded conditioning when CLIP is connected.",
                ),
                io.Model.Output(
                    "model",
                    display_name="Model",
                    tooltip="Model passthrough.",
                ),
                io.Clip.Output(
                    "clip",
                    display_name="CLIP",
                    tooltip="CLIP passthrough.",
                ),
                io.Int.Output(
                    "clip_token_count",
                    display_name="CLIP tokens",
                    tooltip="CLIP-L token count for the weighted text, or -1 when unavailable.",
                ),
            ],
        )

    @classmethod
    def _parse_weighted_segments(cls, text):

        segments = []
        pos = 0
        for m in cls._WEIGHT_RE.finditer(text):
            if m.start() > pos:
                leading = text[pos:m.start()]
                if leading:
                    segments.append((leading, 1.0))
            phrase = m.group(1).strip()
            try:
                weight = float(m.group(2))
            except (ValueError, OverflowError):
                weight = 1.0
            if not math.isfinite(weight):
                weight = 1.0
            if phrase:
                segments.append((phrase, weight))
            pos = m.end()
        if pos < len(text):
            trailing = text[pos:]
            if trailing:
                segments.append((trailing, 1.0))
        return segments

    @classmethod
    def _soft_clamp(cls, weight):

        delta = weight - 1.0
        if delta == 0.0:
            return 1.0
        compressed = math.tanh(delta * cls._SOFT_CLAMP_STEEPNESS) / cls._SOFT_CLAMP_STEEPNESS
        return 1.0 + compressed

    @classmethod
    def _apply_clamp(cls, weight, weight_clamping):
        if weight_clamping == "Soft Safety Clamp":
            return cls._soft_clamp(weight)
        return weight

    @staticmethod
    def _fmt_weight(w):

        s = f"{w:.4f}".rstrip("0").rstrip(".")
        return s if s not in ("", "-") else "0"

    @classmethod
    def _format_bracket_text(cls, segments, weight_clamping):

        parts = []
        for phrase, weight in segments:
            w = cls._apply_clamp(weight, weight_clamping)
            if w == 1.0:
                parts.append(phrase)
            else:
                parts.append(f"({phrase}:{cls._fmt_weight(w)})")
        return "".join(parts)

    @classmethod
    def _format_clean_text(cls, segments, weight_clamping, negative_routing):

        parts = []
        for phrase, weight in segments:
            w = cls._apply_clamp(weight, weight_clamping)
            if w < 0.0 and negative_routing == "Zero Inversion Null":
                continue
            parts.append(phrase)
        return "".join(parts)

    @classmethod
    def execute(cls, text, weighting_mode, advanced_controls=False,
                weight_clamping="None", negative_routing="Direct",
                clip=None, model=None):

        weighting_mode = _coerce_choice(
            weighting_mode,
            {"SDXL / CLIP (Standard)", "Krea 2 / ZIT (Qwen)", "LTX 2.3 / T5 (LLM)"},
            "SDXL / CLIP (Standard)",
        )
        weight_clamping = _coerce_choice(
            weight_clamping, {"None", "Soft Safety Clamp"}, "None"
        )
        negative_routing = _coerce_choice(
            negative_routing, {"Direct", "Zero Inversion Null"}, "Direct"
        )
        if isinstance(advanced_controls, str):
            advanced_controls = advanced_controls.strip().lower() in {"1", "true", "yes", "on"}
        else:
            advanced_controls = bool(advanced_controls)
        effective_clamping = weight_clamping if advanced_controls else "None"
        effective_routing = negative_routing if advanced_controls else "Direct"

        text = _coerce_text(text)
        segments = cls._parse_weighted_segments(text)

        weight_dict = {}
        for phrase, weight in segments:
            if weight != 1.0:
                weight_dict[phrase] = weight

        if weighting_mode == "SDXL / CLIP (Standard)":
            text_out = cls._format_bracket_text(segments, effective_clamping)
        else:
            text_out = cls._format_clean_text(segments, effective_clamping, effective_routing)

        negpip_text = cls._format_bracket_text(segments, effective_clamping)

        conditioning = None
        if clip is not None:

            conditioning = PromptPaletteEditor._encode(clip, text_out)

        token_stats = count_clip_tokens(text_out)
        clip_token_count = token_stats["tokens"] if token_stats is not None else -1

        return io.NodeOutput(text_out, weight_dict, negpip_text, conditioning,
                              model, clip, clip_token_count)
