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
from .clip_tokenizer import clip_counting_applies, count_clip_tokens
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


class PromptPaletteV3Node(io.ComfyNode):
    """Base for Prompt Palette V3 nodes with isolated ComfyUI schema caches.

    ComfyUI currently stores V3 compatibility metadata as plain class attributes
    and guards schema population with ``is None``. A subclass can therefore
    inherit a parent's already-populated cache. Give every concrete Prompt
    Palette node its own fresh cache sentinels at class creation time.
    """

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
                # ComfyUI (>= 0.37) re-creates node classes through a
                # metaclass whose __setattr__ is locked (e.g. the
                # "...Clone" class it builds at execution time). Those
                # classes already carry the cache values copied from the
                # unlocked clone, so there is nothing left to reset.
                return

class PromptPaletteEditor(PromptPaletteV3Node):

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
                    tooltip="CLIP-L token count for the final prompt, or -1 when unavailable or when the connected text encoder is not CLIP-based.",
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

    _LORA_CACHE_LIMIT = 4

    @staticmethod
    def _apply_loras(model, clip, loras, cache=None):
        # ``cache`` maps resolved LoRA path -> loaded state dict. Callers that apply
        # LoRAs repeatedly in one run (Combinatorial) pass one dict so the same file
        # is read from disk once. It is bounded to keep memory predictable.
        if cache is None:
            cache = {}
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
            lora_sd = cache.get(lora_path)
            if lora_sd is None:
                lora_sd = comfy.utils.load_torch_file(lora_path, safe_load=True)
                while len(cache) >= PromptPaletteEditor._LORA_CACHE_LIMIT:
                    cache.pop(next(iter(cache)))
                cache[lora_path] = lora_sd
            model, clip = comfy.sd.load_lora_for_models(model, clip, lora_sd, weight, weight)
        return model, clip

    @classmethod
    def _strip_lora_tags(cls, text):
        """Remove <lora:...> tags only when present, leaving other text untouched."""
        if not text or not cls._LORA_TAG_RE.search(text):
            return text, []
        return cls._extract_loras(text)

    @staticmethod
    def _encode(clip, text):
        # Mirror the stock CLIP Text Encode node. The scheduled path handles hooks and
        # omits pooled_output for encoders that have none (Qwen/T5/LLM-style).
        tokens = clip.tokenize(text)
        scheduled = getattr(clip, "encode_from_tokens_scheduled", None)
        if callable(scheduled):
            return scheduled(tokens)
        cond, pooled = clip.encode_from_tokens(tokens, return_pooled=True)
        extras = {} if pooled is None else {"pooled_output": pooled}
        return [[cond, extras]]

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

            resolved, ignored_positive = cls._strip_lora_tags(resolved)
            resolved_negative, ignored_negative = cls._strip_lora_tags(resolved_negative)
            if ignored_positive or ignored_negative:
                logger.warning(
                    "LoRA tags were ignored because MODEL is not connected; "
                    "connect both MODEL and CLIP to apply them"
                )
            conditioning = cls._encode(clip, resolved)
            negative_conditioning = cls._encode(clip, resolved_negative)
        elif model is not None:

            logger.warning(
                "A model was connected without CLIP; LoRA loading and conditioning are unavailable"
            )

        token_stats = count_clip_tokens(resolved) if clip_counting_applies(clip) else None
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

class PromptPaletteCombinatorial(PromptPaletteV3Node):

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
                # Prompt Palette's remaining optional sockets. They are appended after the
                # original inputs and are link-only (force_input), so they add no widgets and
                # saved workflows keep their widget values in the same order.
                io.String.Input(
                    "prompt_prefix",
                    display_name="Prompt prefix",
                    tooltip="External wildcard-aware text prepended to every generated prompt (resolved per prompt).",
                    optional=True,
                    force_input=True,
                    default="",
                ),
                io.String.Input(
                    "prompt_suffix",
                    display_name="Prompt suffix",
                    tooltip="External wildcard-aware text appended to every generated prompt (resolved per prompt).",
                    optional=True,
                    force_input=True,
                    default="",
                ),
                io.String.Input(
                    "enhancer_override",
                    display_name="LLM / enhancer override",
                    tooltip="A non-empty value replaces every generated prompt (the batch keeps its length and seeds).",
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
                    tooltip="Optional wildcard-aware negative prompt, resolved once for the whole batch.",
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
                # ---- Single-value outputs (not lists: wiring these runs downstream once). ----
                # Appended after the seven list outputs so existing links keep their slot index.
                io.Model.Output(
                    "model_passthrough",
                    display_name="Model (passthrough)",
                    tooltip="The connected Model, unchanged (per-prompt LoRA patched models are on Model list).",
                ),
                io.Clip.Output(
                    "clip_passthrough",
                    display_name="CLIP (passthrough)",
                    tooltip="The connected CLIP, unchanged (per-prompt LoRA patched CLIPs are on CLIP list).",
                ),
                io.Conditioning.Output(
                    "first_conditioning",
                    display_name="Conditioning (first)",
                    tooltip="Conditioning for the first generated prompt. Needs CLIP connected. Use Conditioning list for every prompt.",
                ),
                io.Conditioning.Output(
                    "negative_conditioning",
                    display_name="Negative conditioning",
                    tooltip="The resolved negative prompt encoded once with the connected CLIP (unpatched). Needs CLIP connected.",
                ),
                io.String.Output(
                    "first_prompt",
                    display_name="Prompt (first)",
                    tooltip="The first generated prompt. Use Prompt list for every prompt.",
                ),
                io.String.Output(
                    "negative_prompt",
                    display_name="Negative prompt",
                    tooltip="Resolved negative prompt text, resolved once for the whole batch.",
                ),
                io.Int.Output(
                    "first_seed",
                    display_name="Seed used (first)",
                    tooltip="Seed used for the first generated prompt. Use Seed list for every prompt.",
                ),
                io.String.Output(
                    "wildcards_used_json",
                    display_name="Wildcards used (JSON)",
                    tooltip="JSON list of wildcard files used during this batch, as one value.",
                ),
                io.String.Output(
                    "raw_text",
                    display_name="Raw text (unresolved)",
                    tooltip="Source prompt before wildcard resolution.",
                ),
                io.Int.Output(
                    "wildcards_used_count",
                    display_name="Wildcards used (count)",
                    tooltip="Number of distinct wildcard files used during this batch.",
                ),
                io.Boolean.Output(
                    "used_enhancer",
                    display_name="Used enhancer override",
                    tooltip="True when the enhancer override replaced the generated prompts.",
                ),
                io.Int.Output(
                    "clip_token_count",
                    display_name="CLIP token count (max)",
                    tooltip="Highest CLIP-L token count across the batch, or -1 when unavailable or the connected text encoder is not CLIP-based.",
                ),
                io.String.Output(
                    "batch_metadata_json",
                    display_name="Batch metadata (JSON)",
                    tooltip="One JSON record for the whole batch, including every generated prompt's metadata.",
                ),
                io.Int.Output(
                    "prompt_count",
                    display_name="Prompt count",
                    tooltip="How many prompts this batch generated.",
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
    def execute(cls, text, mode, count, seed, seed_mode, max_prompts, clip=None, model=None,
                prompt_prefix="", prompt_suffix="", enhancer_override="",
                external_seed=None, negative_text="",
                negative_prefix="", negative_suffix=""):
        mode = _coerce_choice(mode, {"random", "combinatorial"}, "random")
        seed_mode = _coerce_choice(seed_mode, {"sequential", "fixed", "random"}, "sequential")
        text = _coerce_text(text)
        count = _coerce_int(count, 10)
        max_prompts = _coerce_int(max_prompts, 0)
        prompt_prefix = _coerce_text(prompt_prefix)
        prompt_suffix = _coerce_text(prompt_suffix)
        enhancer_override = _coerce_text(enhancer_override)
        negative_text = _coerce_text(negative_text)
        negative_prefix = _coerce_text(negative_prefix)
        negative_suffix = _coerce_text(negative_suffix)
        seed = _coerce_uint64(seed)
        # An external seed wins over the Seed control, exactly like the base Prompt Palette node.
        effective_seed = seed if external_seed is None else _coerce_uint64(external_seed, seed)
        count = max(1, min(count, WildcardResolver.MAX_COMBINATORIAL_PROMPTS))
        max_prompts = max(0, min(max_prompts, WildcardResolver.MAX_COMBINATORIAL_PROMPTS))
        resolver = WildcardResolver(get_index())

        if mode == "combinatorial":
            prompts = resolver.generate_combinatorial(text, seed=effective_seed, max_prompts=max_prompts or None)
            if resolver.last_generation_truncated:
                cap = max_prompts or resolver.MAX_COMBINATORIAL_PROMPTS
                logger.warning(
                    "Combinatorial generation reached the %s-prompt safety cap; output is truncated",
                    cap,
                )
            if not prompts:
                prompts = [""]
            seeds_out = cls._derive_seeds(effective_seed, seed_mode, len(prompts))
        else:
            seeds_out = cls._derive_seeds(effective_seed, seed_mode, count)
            prompts = [resolver.resolve(text, seed=s) for s in seeds_out]

        # Prefix / suffix / enhancer are applied per generated prompt. With none of them
        # connected this block changes nothing, so existing workflows behave as before.
        def resolve_extra(block, prompt_seed, offset):
            if not block:
                return ""
            return resolver.resolve(block, seed=(prompt_seed + offset) & UINT64_MAX)

        used_enhancer = bool(enhancer_override and enhancer_override.strip())
        if used_enhancer:
            prompts = [enhancer_override for _ in prompts]
        elif prompt_prefix or prompt_suffix:
            composed = []
            for prompt_seed, generated in zip(seeds_out, prompts):
                parts = [
                    part for part in (
                        resolve_extra(prompt_prefix, prompt_seed, -1),
                        generated,
                        resolve_extra(prompt_suffix, prompt_seed, 1),
                    ) if part
                ]
                composed.append(" ".join(parts))
            prompts = composed

        # The negative prompt is a single value for the whole batch.
        negative_parts = [part for part in (
            resolve_extra(negative_prefix, effective_seed, 1001),
            resolve_extra(negative_text, effective_seed, 1000),
            resolve_extra(negative_suffix, effective_seed, 1002),
        ) if part]
        resolved_negative = " ".join(negative_parts)

        used_names = sorted(set(resolver.used_names))
        wildcards_used = json.dumps(used_names)

        out_models, out_clips, conditioning, out_prompts = [], [], [], []
        prompt_metadata = []
        lora_cache = {}
        for index, p in enumerate(prompts):
            lora_records = PromptPaletteEditor._lora_records(p, "positive")
            loras_applied = False
            if model is not None and clip is not None:
                clean, loras = PromptPaletteEditor._extract_loras(p)
                m, c = PromptPaletteEditor._apply_loras(model, clip, loras, lora_cache) if loras else (model, clip)
                loras_applied = bool(loras)
                out_models.append(m)
                out_clips.append(c)
                conditioning.append(PromptPaletteEditor._encode(c, clean))
                out_prompts.append(clean)
            elif clip is not None:
                clean, _ignored = PromptPaletteEditor._strip_lora_tags(p)
                out_models.append(model)
                out_clips.append(clip)
                conditioning.append(PromptPaletteEditor._encode(clip, clean))
                out_prompts.append(clean)
            else:
                out_models.append(model)
                out_clips.append(clip)
                conditioning.append(None)
                out_prompts.append(p)
            prompt_metadata.append(build_prompt_metadata(
                node_type="PromptPaletteCombinatorial",
                prompt=out_prompts[-1],
                negative_prompt=resolved_negative,
                source_prompt=text,
                source_text=text,
                seed=seeds_out[index],
                processing_mode=mode,
                wildcards_used=used_names,
                used_enhancer=used_enhancer,
                enhancer_override=enhancer_override,
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

        negative_conditioning = None
        if clip is not None:
            clean_negative, ignored_negative = PromptPaletteEditor._strip_lora_tags(resolved_negative)
            if ignored_negative:
                logger.warning(
                    "LoRA tags in the negative prompt are ignored by the Combinatorial node; "
                    "it encodes one shared negative prompt with the unpatched CLIP"
                )
            resolved_negative = clean_negative
            negative_conditioning = PromptPaletteEditor._encode(clip, clean_negative)

        clip_token_count = -1
        if clip_counting_applies(clip):
            counts = []
            for item in out_prompts:
                stats = count_clip_tokens(item)
                if stats is not None:
                    counts.append(stats["tokens"])
            if counts:
                clip_token_count = max(counts)

        batch_metadata = {
            "schema": "prompt-palette.prompt-metadata.v1",
            "schema_version": 1,
            "generator": "Prompt Palette",
            "node_type": "PromptPaletteCombinatorial",
            "batch": True,
            "count": n,
            "source_prompt": text,
            "source_text": text,
            "negative_prompt": resolved_negative,
            "source_negative_text": negative_text,
            "prompt_prefix": prompt_prefix,
            "prompt_suffix": prompt_suffix,
            "negative_prefix": negative_prefix,
            "negative_suffix": negative_suffix,
            "used_enhancer": used_enhancer,
            "enhancer_override": enhancer_override if used_enhancer else "",
            "mode": mode,
            "seed_mode": seed_mode,
            "seed": effective_seed,
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
            # 0-6: list outputs, unchanged.
            out_models, out_clips, conditioning, out_prompts, seeds_out, [wildcards_used] * n,
            [compact_json(item) for item in prompt_metadata],
            # 7-20: single-value outputs, in the order declared in the schema.
            model, clip, conditioning[0] if conditioning else None, negative_conditioning,
            out_prompts[0] if out_prompts else "", resolved_negative,
            seeds_out[0] if seeds_out else effective_seed,
            wildcards_used, text, len(used_names), used_enhancer, clip_token_count,
            compact_json(published_batch), n,
            ui={"prompt_palette": ui_metadata},
        )

class PromptPaletteWeightController(PromptPaletteV3Node):

    _WEIGHT_SUFFIX_RE = re.compile(
        r"^(.*):([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)$", re.DOTALL
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
                    tooltip="CLIP-L token count for the weighted text, or -1 when unavailable or when the connected text encoder is not CLIP-based.",
                ),
            ],
        )

    @staticmethod
    def _find_group_end(text, start):
        """Index of the ')' matching the '(' at ``start`` (escaped parens ignored), or -1."""
        depth = 0
        i = start
        length = len(text)
        while i < length:
            ch = text[i]
            if ch == "\\":
                i += 2
                continue
            if ch == "(":
                depth += 1
            elif ch == ")":
                depth -= 1
                if depth == 0:
                    return i
            i += 1
        return -1

    @classmethod
    def _collect_segments(cls, text, weight, out):
        pos = 0
        i = 0
        length = len(text)
        while i < length:
            ch = text[i]
            if ch == "\\":
                i += 2
                continue
            if ch == "(":
                end = cls._find_group_end(text, i)
                if end != -1:
                    inner = text[i + 1:end]
                    match = cls._WEIGHT_SUFFIX_RE.match(inner)
                    if match and match.group(1).strip():
                        if i > pos:
                            out.append((text[pos:i], weight))
                        try:
                            own = float(match.group(2))
                        except (ValueError, OverflowError):
                            own = 1.0
                        combined = weight * own if math.isfinite(own) else weight
                        if not math.isfinite(combined):
                            combined = weight
                        cls._collect_segments(match.group(1), combined, out)
                        pos = i = end + 1
                        continue
                    # Unweighted group: keep the parentheses as text, but still
                    # look for weighted groups inside it.
                    out.append((text[pos:i + 1], weight))
                    cls._collect_segments(inner, weight, out)
                    pos = end
                    i = end + 1
                    continue
            i += 1
        if pos < length:
            out.append((text[pos:], weight))

    @classmethod
    def _parse_weighted_segments(cls, text):
        """Split ``text`` into (phrase, weight) pieces.

        Nested weighted groups multiply their weights, escaped parentheses stay
        literal, and whitespace around a weighted phrase is kept outside it.
        """
        raw = []
        cls._collect_segments(text, 1.0, raw)
        segments = []
        for phrase, weight in raw:
            if not phrase:
                continue
            if weight == 1.0:
                segments.append((phrase, 1.0))
                continue
            core = phrase.strip()
            if not core:
                segments.append((phrase, 1.0))
                continue
            lead = phrase[:len(phrase) - len(phrase.lstrip())]
            trail = phrase[len(phrase.rstrip()):]
            if lead:
                segments.append((lead, 1.0))
            segments.append((core, weight))
            if trail:
                segments.append((trail, 1.0))
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
        dropped = False
        for phrase, weight in segments:
            w = cls._apply_clamp(weight, weight_clamping)
            if w < 0.0 and negative_routing == "Zero Inversion Null":
                dropped = True
                continue
            if dropped:
                # Don't leave a doubled space (or a leading space) where a phrase was removed.
                if not parts or (parts[-1][-1:].isspace() and phrase[:1].isspace()):
                    phrase = phrase.lstrip()
                dropped = False
            parts.append(phrase)
        result = "".join(parts)
        return result.rstrip() if dropped else result

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
        seen_pairs = set()
        for phrase, weight in segments:
            if weight == 1.0 or (phrase, weight) in seen_pairs:
                continue
            seen_pairs.add((phrase, weight))
            key, suffix = phrase, 2
            while key in weight_dict:
                # Same phrase, different weight: keep both instead of overwriting.
                key = f"{phrase} #{suffix}"
                suffix += 1
            weight_dict[key] = weight

        if weighting_mode == "SDXL / CLIP (Standard)":
            text_out = cls._format_bracket_text(segments, effective_clamping)
        else:
            text_out = cls._format_clean_text(segments, effective_clamping, effective_routing)

        negpip_text = cls._format_bracket_text(segments, effective_clamping)

        conditioning = None
        if clip is not None:

            conditioning = PromptPaletteEditor._encode(clip, text_out)

        token_stats = count_clip_tokens(text_out) if clip_counting_applies(clip) else None
        clip_token_count = token_stats["tokens"] if token_stats is not None else -1

        return io.NodeOutput(text_out, weight_dict, negpip_text, conditioning,
                              model, clip, clip_token_count)
