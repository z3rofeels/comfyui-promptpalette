import json
import math
import re
import random

import comfy.sd
import comfy.utils
import folder_paths
from comfy_api.latest import io

from .wildcard_index import get_index
from .wildcard_resolver import WildcardResolver
from .clip_tokenizer import count_clip_tokens


class PromptPaletteEditor(io.ComfyNode):
    """
    A wildcard-aware prompt text box that doubles as an active CLIP encoder.
    The visible editor (color-coded syntax highlighting, folder picker, hover
    previews, resolved-preview) lives entirely in the frontend DOM widget;
    this node just receives the final plain text in the hidden STRING widget
    the frontend keeps in sync, resolves it, and — depending on which of the
    optional CLIP / MODEL sockets are wired in — either hands back plain
    resolved text or fully encodes it into CONDITIONING.

    CLIP and MODEL are both optional, so this node degrades gracefully
    through three tiers instead of throwing when a socket is empty:

      1. text only              -> wildcards resolved, text outputs filled,
                                    model/clip/conditioning outputs are None.
      2. text + clip             -> text resolved and encoded into standard
                                    ComfyUI CONDITIONING via the given CLIP.
                                    Any <lora:...> tags are left as literal
                                    text (there's no MODEL to patch).
      3. text + clip + model     -> same as above, but the resolved text is
                                    first scanned for <lora:filename:weight>
                                    tags. Any found are loaded and applied to
                                    MODEL/CLIP via comfy.sd.load_lora_for_models,
                                    stripped out of the text, and the *patched*
                                    clip is what actually encodes the prompt.
                                    Tags can come from directly-typed text or
                                    from a wildcard file's entry, since the
                                    scan runs after wildcard resolution.

    The other optional inputs (prefix/suffix/enhancer/external_seed/negative
    variants) exist purely for wiring flexibility, same as before — none of
    them are required either.

    clip_token_count reports how many real CLIP-L tokens the final `prompt`
    output actually costs (start/end/pad tokens not counted), using the same
    tokenizer ComfyUI's own CLIP-L text encoder uses — so wildcard-driven
    length swings (a `__style__` pick can be one token or twenty) are visible
    as a number instead of only discoverable after a truncated-looking
    render. -1 means the tokenizer couldn't be built in this environment
    (see clip_tokenizer.py) rather than a false "0 tokens". Wire it into a
    comparison/switch node to gate on prompts that run past CLIP-L's
    75-tokens-per-chunk window, or just watch it while iterating on a
    wildcard-heavy prompt.
    """

    # <lora:some_name:0.8> -- filename may contain most characters except
    # ':' and '>'; weight is a plain float applied to both model & clip.
    _LORA_TAG_RE = re.compile(r"<lora:([^:>]+):([\d.]+)>")

    @classmethod
    def define_schema(cls):
        return io.Schema(
            # node_id is what gets saved into every workflow JSON. Renaming it
            # (this class used to be registered as WildcardGalleryEditor under
            # the V1 API) means workflows saved under the old name won't
            # auto-resolve to this class anymore -- kept unchanged here since
            # it was already migrated to this id before the V3 conversion.
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
                io.String.Input("text", multiline=True, default="", dynamic_prompts=False),
                io.Int.Input("seed", default=0, min=0, max=0xFFFFFFFFFFFFFFFF),
                io.Combo.Input("processing_mode", options=["entire text as one", "line by line"]),
                # Both socket-only (no widget), so leaving them unconnected
                # simply omits them from the call - execute() defaults both
                # to None and branches on that rather than requiring either.
                io.Clip.Input("clip", optional=True),
                io.Model.Input("model", optional=True),
                io.String.Input("prompt_prefix", optional=True, force_input=True, default=""),
                io.String.Input("prompt_suffix", optional=True, force_input=True, default=""),
                io.String.Input("enhancer_override", optional=True, force_input=True, default=""),
                io.Int.Input("external_seed", optional=True, force_input=True, default=0),
                io.String.Input("negative_text", optional=True, force_input=True, multiline=True, default=""),
                # Mirror the positive side's prefix/suffix wiring for the negative
                # prompt, so users get the same "pipe in a shared style-preset
                # node" freedom on both sides instead of just the positive one.
                io.String.Input("negative_prefix", optional=True, force_input=True, default=""),
                io.String.Input("negative_suffix", optional=True, force_input=True, default=""),
            ],
            # clip_token_count is appended at the end rather than inserted among
            # the existing outputs, so every already-saved workflow's existing
            # links (which reference these by slot index) keep pointing at
            # exactly what they always did.
            outputs=[
                io.Model.Output("model"),
                io.Clip.Output("clip"),
                io.Conditioning.Output("conditioning"),
                io.Conditioning.Output("negative_conditioning"),
                io.String.Output("prompt"),
                io.String.Output("negative_prompt"),
                io.Int.Output("seed_out"),
                io.String.Output("wildcards_used"),
                io.String.Output("raw_text"),
                io.Int.Output("wildcards_used_count"),
                io.Boolean.Output("used_enhancer"),
                io.Int.Output("clip_token_count"),
            ],
        )

    @classmethod
    def _extract_loras(cls, text):
        """Strip <lora:name:weight> tags out of text, returning (clean_text, [(name, weight), ...])."""
        loras = []

        def _capture(m):
            name = m.group(1).strip()
            try:
                weight = float(m.group(2))
            except ValueError:
                weight = 1.0
            loras.append((name, weight))
            return ""

        clean = cls._LORA_TAG_RE.sub(_capture, text)
        # Collapse whatever whitespace the removed tags leave behind.
        clean = re.sub(r"[ \t]+", " ", clean)
        clean = "\n".join(line.strip() for line in clean.splitlines())
        clean = re.sub(r"\n{2,}", "\n", clean).strip()
        return clean, loras

    @staticmethod
    def _apply_loras(model, clip, loras):
        """Sequentially load and apply each (name, weight) LoRA to model/clip."""
        for name, weight in loras:
            lora_path = folder_paths.get_full_path("loras", name)
            if lora_path is None:
                # Tag may have been written without an extension - try the
                # common ones before giving up on it.
                for ext in (".safetensors", ".pt", ".ckpt"):
                    candidate = folder_paths.get_full_path("loras", name + ext)
                    if candidate is not None:
                        lora_path = candidate
                        break
            if lora_path is None:
                print(f"[PromptPalette] warning: LoRA '{name}' not found in loras folder, skipping")
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
        resolver = WildcardResolver(get_index())
        effective_seed = external_seed if external_seed is not None else seed

        def resolve_block(t, seed_offset=0):
            if not t:
                return ""
            if processing_mode == "line by line":
                return "\n".join(resolver.resolve_lines(t, seed=effective_seed + seed_offset))
            return resolver.resolve(t, seed=effective_seed + seed_offset)

        body = resolve_block(text)
        parts = [p for p in (resolve_block(prompt_prefix, -1), body, resolve_block(prompt_suffix, 1)) if p]
        resolved = "\n".join(parts) if processing_mode == "line by line" else " ".join(parts)

        # If an LLM/enhancer node is wired into enhancer_override and produced
        # something, it fully replaces the wildcard-resolved text rather than
        # being merged with it — the enhancer is assumed to already have taken
        # the resolved prompt as its own input upstream. Captured as its own
        # flag (used_enhancer) before overwriting `resolved`, so a downstream
        # node can branch on whether the override actually kicked in this run.
        used_enhancer = bool(enhancer_override and enhancer_override.strip())
        if used_enhancer:
            resolved = enhancer_override

        # Negative prompt gets the same prefix/body/suffix wrapping as the
        # positive prompt, just in its own seed offsets (1000/1001/1002) so a
        # shared prefix/suffix wildcard never draws the same random pick as
        # the positive side's prefix/suffix.
        neg_parts = [p for p in (
            resolve_block(negative_prefix, 1001),
            resolve_block(negative_text, 1000),
            resolve_block(negative_suffix, 1002),
        ) if p]
        resolved_negative = "\n".join(neg_parts) if processing_mode == "line by line" else " ".join(neg_parts)

        used_names = sorted(set(resolver.used_names))
        wildcards_used = json.dumps(used_names)

        # --- Active-encoder tiers. All additive on top of the plain text/
        # wildcard behavior above, gated entirely on which optional sockets
        # are actually connected. ---
        out_model, out_clip = model, clip
        conditioning, negative_conditioning = None, None

        if model is not None and clip is not None:
            # Tier 3: scan runs on the *resolved* text, after wildcard
            # substitution, so a <lora:...> tag can live directly in the
            # prompt or be smuggled in via a wildcard file's entry either way.
            resolved, positive_loras = cls._extract_loras(resolved)
            resolved_negative, negative_loras = cls._extract_loras(resolved_negative)
            loras = positive_loras + negative_loras
            if loras:
                out_model, out_clip = cls._apply_loras(model, clip, loras)
            conditioning = cls._encode(out_clip, resolved)
            negative_conditioning = cls._encode(out_clip, resolved_negative)
        elif clip is not None:
            # Tier 2: no MODEL to patch, so LoRA tags (if any) are left as
            # literal text rather than silently dropped or half-applied.
            conditioning = cls._encode(clip, resolved)
            negative_conditioning = cls._encode(clip, resolved_negative)
        elif model is not None:
            # MODEL wired in without CLIP: can't encode, can't load LoRAs
            # (that call needs both). Pass the model through untouched.
            print("[PromptPalette] warning: model connected without clip - "
                  "no LoRA loading or encoding possible this run")

        # Tokenized last, from whatever `resolved` ended up being after the
        # tier-3 LoRA-tag stripping above (or untouched in tiers 1/2) — so
        # this always matches exactly what the `prompt` output actually
        # contains, not an earlier draft of it.
        token_stats = count_clip_tokens(resolved)
        clip_token_count = token_stats["tokens"] if token_stats is not None else -1

        return io.NodeOutput(out_model, out_clip, conditioning, negative_conditioning,
                              resolved, resolved_negative, effective_seed, wildcards_used,
                              text, len(used_names), used_enhancer, clip_token_count)


class PromptPaletteCombinatorial(io.ComfyNode):
    """
    Batch-generates multiple prompts from one wildcard-aware text block in a
    single node execution -- a separate node from PromptPaletteEditor rather
    than a mode bolted onto it, so existing single-prompt workflows built
    against that node are completely unaffected. Converting its outputs to
    lists in place would silently change downstream execution behavior (a
    ComfyUI list output re-runs anything wired to it once per item) for
    every saved workflow that already uses it.

    Two generation modes, matching upstream dynamicprompts / comfyui-et_dynamicprompts:
      random        -> `count` independently-seeded resolve() calls. Picking one
                        random value per group each call already uniformly samples
                        the full combination space (with replacement), so this is
                        just WildcardResolver.resolve() in a loop -- no separate
                        combinatorial code path needed for it. `count` is ignored
                        in combinatorial mode.
      combinatorial -> every combination, via WildcardResolver.generate_combinatorial()
                        (the joint Cartesian product of every unmarked group).
                        Capped by max_prompts (0 = fall back to WildcardResolver.
                        MAX_COMBINATORIAL_PROMPTS).

    seed_mode controls how each individual prompt's own resolve seed is derived
    from the `seed` widget:
      fixed      -> every prompt uses the same seed (mainly useful in
                    combinatorial mode, where the combination itself -- not
                    the seed -- is what varies prompt to prompt)
      sequential -> seed, seed+1, seed+2, ... -- deterministic, reproducible
      random     -> seed seeds a Random() that in turn picks each prompt's
                    actual resolve seed (reproducible from `seed`, but not a
                    simple increment)

    Both +/-/@ (sequential/cyclical) and % (joint combinatorial) markers still
    work as normal inside `random` mode too, since their counters live on the
    shared WildcardIndex singleton, not on any one resolve() call -- so e.g. a
    __%name__ group will still sweep through its combinations once per prompt
    in the batch, same as it would across `count` separately-queued runs of
    the plain PromptPaletteEditor node.

    clip/model are optional and gated exactly like PromptPaletteEditor's tiers,
    reusing its _extract_loras/_apply_loras/_encode helpers directly rather
    than duplicating them: no clip -> prompt/seed lists only; clip only ->
    encoded per-prompt CONDITIONING, <lora:...> tags left as text; clip+model
    -> each prompt's own <lora:...> tags are loaded and applied to that
    prompt's own copy of model/clip before encoding, since two different
    combinations can legitimately call for two different LoRAs.
    """

    @classmethod
    def define_schema(cls):
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
                io.String.Input("text", multiline=True, default="", dynamic_prompts=False),
                io.Combo.Input("mode", options=["random", "combinatorial"]),
                io.Int.Input("count", default=10, min=1, max=WildcardResolver.MAX_COMBINATORIAL_PROMPTS,
                             tooltip="random mode only; ignored in combinatorial mode"),
                io.Int.Input("seed", default=0, min=0, max=0xFFFFFFFFFFFFFFFF),
                io.Combo.Input("seed_mode", options=["sequential", "fixed", "random"]),
                io.Int.Input("max_prompts", default=0, min=0, max=WildcardResolver.MAX_COMBINATORIAL_PROMPTS,
                             tooltip="combinatorial mode only; 0 = use the resolver's default cap "
                                     f"({WildcardResolver.MAX_COMBINATORIAL_PROMPTS})"),
                io.Clip.Input("clip", optional=True),
                io.Model.Input("model", optional=True),
            ],
            outputs=[
                io.Model.Output("model", is_output_list=True),
                io.Clip.Output("clip", is_output_list=True),
                io.Conditioning.Output("conditioning", is_output_list=True),
                io.String.Output("prompt", is_output_list=True),
                io.Int.Output("seed_out", is_output_list=True),
                io.String.Output("wildcards_used", is_output_list=True),
            ],
        )

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
        resolver = WildcardResolver(get_index())

        if mode == "combinatorial":
            prompts = resolver.generate_combinatorial(text, seed=seed, max_prompts=max_prompts or None)
            if resolver.last_generation_truncated:
                cap = max_prompts or resolver.MAX_COMBINATORIAL_PROMPTS
                print(f"[PromptPalette] combinatorial generation hit the {cap}-prompt safety cap; output is truncated")
            if not prompts:
                prompts = [""]
            seeds_out = cls._derive_seeds(seed, seed_mode, len(prompts))
        else:
            seeds_out = cls._derive_seeds(seed, seed_mode, count)
            prompts = [resolver.resolve(text, seed=s) for s in seeds_out]

        used_names = sorted(set(resolver.used_names))
        wildcards_used = json.dumps(used_names)

        out_models, out_clips, conditioning, out_prompts = [], [], [], []
        for p in prompts:
            if model is not None and clip is not None:
                # Each combination's own <lora:...> tags get their own
                # model/clip patch -- two different prompts in the same batch
                # can legitimately call for two different LoRAs.
                clean, loras = PromptPaletteEditor._extract_loras(p)
                m, c = PromptPaletteEditor._apply_loras(model, clip, loras) if loras else (model, clip)
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

        n = len(out_prompts)
        return io.NodeOutput(out_models, out_clips, conditioning, out_prompts, seeds_out, [wildcards_used] * n)


class PromptPaletteWeightController(io.ComfyNode):
    """
    A universal per-phrase weighting front-end that sits between a text
    source (PromptPaletteEditor's `prompt`/`negative_prompt`/`raw_text`
    output, or any other STRING) and whichever text-conditioning backend
    the rest of the workflow actually targets.

    This is new functionality, not a refactor of anything that existed in
    this suite before -- PromptPaletteEditor and PromptPaletteCombinatorial
    have never done per-word weight parsing; they resolve wildcards and
    (optionally) encode the result as-is. Rather than bolting weight
    authoring onto PromptPaletteEditor directly, it's its own node, for the
    same reason PromptPaletteCombinatorial is its own node instead of a
    mode on PromptPaletteEditor (see that class's docstring): folding a
    large, unrelated feature into an existing node changes what every
    already-saved workflow using it does the moment this file is updated,
    where a new node only affects graphs that actually add it. Because it
    takes plain text in and plain text/CONDITIONING out, it composes with
    the rest of the suite for free -- wire it after PromptPaletteEditor's
    `prompt` output for the positive side, and again after
    `negative_prompt` for the negative side, if you want both weighted.

    ------------------------------------------------------------------
    INPUT SYNTAX
    ------------------------------------------------------------------
    `text` is scanned for `(phrase:weight)` annotations -- one level of
    parentheses, an explicit signed/unsigned float after a colon, e.g.
    `a photo of a (red sports car:1.6), (blurry:-1.2), dusk lighting`.
    This is the same explicit syntax ComfyUI's own CLIP tokenizer uses,
    and the same convention community Krea 2/Qwen attention-patching
    nodes generally expect as input. Nested parentheses inside one
    annotation are not supported
    (`(a (b:1.2) c:1.4)` will not parse the way you'd hope) -- write each
    weighted phrase as its own top-level `(...:weight)` group. Bare
    `(word)` / `[word]` shorthand (A1111-style implicit +/-10%) is
    deliberately NOT interpreted: none of this node's real downstream
    targets documents that convention, only the explicit `:weight` form,
    so guessing at an implicit-weight behavior none of them promise would
    be inventing behavior rather than matching it.

    Absolute Control philosophy: `weight_dict` always reports the raw
    number exactly as written -- 2.5 stays 2.5, 3.0 stays 3.0, no hidden
    renormalization, ever. `weight_clamping`/`negative_routing` are
    opt-in transforms that only ever affect the generated text/
    conditioning outputs below -- never `weight_dict`.

    ------------------------------------------------------------------
    weighting_mode
    ------------------------------------------------------------------
    "SDXL / CLIP (Standard)"
        `text` keeps the `(phrase:weight)` syntax intact -- exactly what
        ComfyUI's built-in CLIP tokenizer parses (the same
        tokenize_with_weights() mechanism clip_tokenizer.py in this suite
        already relies on for its token-count feature). If `clip` is
        wired in, `conditioning` is built from this same weighted string
        via clip.tokenize()/encode_from_tokens() -- the traditional
        pooled-embedding math.

    "Krea 2 / ZIT (Qwen)"
        Krea 2's text encoder is a real Qwen3-VL language model (loaded
        via CLIPLoader with type "krea2"). ComfyUI's normal (word:weight)
        syntax does nothing there, because the Qwen3-VL encoder just
        reads the parentheses as literal text. So `text` here is fully
        de-bracketed prose -- safe to feed straight into a Krea2/Qwen3-VL
        (or Z-Image/"ZIT") text encoder without stray "(word:1.4)"
        characters confusing the language model. Real per-token
        attention-level weighting for this model family does not happen
        inside this node -- it happens in whichever attention-patching
        node your workflow uses downstream (typically one that patches
        MODEL/CLIP given clip+model+text+strength, and/or handles
        negative weights specifically via its own MODEL+CLIP patch).
        Those nodes generally parse the exact `(phrase:weight)` string
        `negpip_compatible` produces below -- wire `negpip_compatible`
        into that node's `text` input, not `weight_dict`, since none of
        them take a raw dict; they parse annotated text the same way
        this node does.

    "LTX 2.3 / T5 (LLM)"
        Same treatment as Krea2/Qwen: bracket syntax gets stripped for
        `text`. One correction worth flagging on the model naming, in
        case the rest of your pipeline is built around it: LTX 2.3 itself
        shipped with a Gemma 3 12B text encoder -- T5-XXL was the encoder
        for earlier LTX Video releases (2.0/2.1/2.2), and LTX's own docs
        warn that old T5 weights aren't compatible with 2.3 workflows.
        This mode is kept generic ("any LLM/DiT-backbone text encoder
        where bracket syntax isn't natively meaningful") rather than
        hard-coded to T5 specifically, so it covers either encoder
        correctly. There's no single community-standard
        "LTXPromptWeight"-equivalent patch node the way Krea 2 has two --
        so `weight_dict` is genuinely the main way to carry real per-word
        weights further here, by piping it into whatever custom attention
        patcher your LTX pipeline actually uses.

    ------------------------------------------------------------------
    advanced_controls / weight_clamping / negative_routing
    ------------------------------------------------------------------
    advanced_controls (default False) gates weight_clamping and
    negative_routing at the *value* level: execute() substitutes
    "None"/"Direct" for them whenever advanced_controls is False,
    regardless of what they're actually set to -- so a leftover widget
    value from an earlier session can't silently clamp a beginner's
    result. That's a runtime guarantee, not a UI one: V3's Python schema
    has no built-in "hide this widget unless that checkbox is on"
    declaration, so both widgets stay visible on the node body either way
    as far as nodes.py is concerned. To actually make them disappear when
    advanced_controls is off (the "keep the default UI perfectly clean"
    half of the brief), see web/weight_controller_ui.js, added alongside
    this node -- a small nodeCreated hook, the same extension mechanism
    this suite's existing web/ scripts already use.

    weight_clamping:
      "None"              -> absolute raw weight, unmodified.
      "Soft Safety Clamp" -> a tanh soft-knee centered on 1.0 (neutral):
                              values near 1.0 pass through almost
                              unchanged; values far from 1.0 compress
                              toward it instead of growing linearly. This
                              is a heuristic curve tuned by feel (see
                              _SOFT_CLAMP_STEEPNESS), not a published
                              formula for any specific text encoder -- it
                              happens to map a UI 1.5 to ~1.125, close to
                              the "~1.12" example in the brief, but treat
                              the steepness constant as a dial to retune,
                              not a derived constant with special meaning.

    negative_routing (only changes anything for weight < 0):
      "Direct"               -> raw negative value passed through as-is.
                                 Correct for negpip_compatible (both real
                                 downstream consumers parse negative
                                 weights natively) and for SDXL-mode
                                 `text` (ComfyUI's own tokenizer also
                                 applies a negative multiplier natively).
      "Zero Inversion Null"  -> only changes the plain-prose `text`
                                 output in Krea2/LTX mode. Plain prose has
                                 no way to carry a negative multiplier at
                                 all, so the honest way to respect a
                                 suppression request there is to drop the
                                 phrase from the sentence entirely, rather
                                 than let it silently render at full,
                                 unweighted inclusion. "Direct" in that
                                 same clean-text path just means "don't
                                 intervene" -- there's no negative-safe
                                 raw value to pass through unmodified in
                                 plain prose.

    ------------------------------------------------------------------
    OUTPUTS
    ------------------------------------------------------------------
    text                    STRING - formatted per weighting_mode, above.
    weight_dict               DICT - {phrase: raw_weight} for every phrase
                                      whose weight != 1.0, exactly as
                                      typed. Custom-typed ("DICT") rather
                                      than a JSON STRING so it can be
                                      wired directly into another custom
                                      node's own raw-dict input -- that
                                      node needs to declare a matching
                                      "DICT" (or "*"/any) input type to
                                      actually connect to it.
    negpip_compatible        STRING - `(phrase:weight)` annotated text,
                                      always produced regardless of
                                      weighting_mode, formatted fixed-
                                      point (no scientific notation, sign
                                      preserved) to match the explicit
                                      `(phrase:weight)` syntax that
                                      Krea 2/Qwen attention-patching
                                      nodes typically parse as their
                                      `text` input.
    conditioning         CONDITIONING - only populated if `clip` is wired
                                      in. SDXL mode: real per-token
                                      weighted embeddings via
                                      clip.tokenize()/encode_from_tokens()
                                      on the bracketed text. Krea2/LTX
                                      modes: encoded from the clean
                                      de-bracketed text -- no token-level
                                      weighting is applied to this
                                      CONDITIONING object for those
                                      backbones, since that math lives in
                                      a downstream MODEL-level attention
                                      patcher, not in a CLIP conditioning
                                      object. Route negpip_compatible/
                                      weight_dict into that kind of node
                                      for real per-word control on
                                      Krea 2/LTX.
    model, clip                     - untouched pass-through of the
                                      optional `model`/`clip` inputs, so
                                      this node can sit inline in a chain
                                      without a separate reroute for
                                      whichever of the two it didn't need
                                      for encoding.
    clip_token_count            INT - the same real-tokenizer count
                                      PromptPaletteEditor already reports,
                                      run over this node's own `text`
                                      output (-1 if the tokenizer isn't
                                      available in this environment; see
                                      clip_tokenizer.py).
    """

    # Single level of parens, explicit signed/unsigned float weight after
    # a colon -- e.g. "(red sports car:1.6)" or "(blurry:-1.2)". Phrase
    # itself may contain anything except '(' ')' so annotations can't
    # nest; see class docstring for why that's intentional.
    _WEIGHT_RE = re.compile(r"\(([^()]+):(-?\d+(?:\.\d+)?)\)")

    # Dial for the "Soft Safety Clamp" tanh curve -- see class docstring.
    _SOFT_CLAMP_STEEPNESS = 8.0

    @classmethod
    def define_schema(cls):
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
                io.String.Input("text", multiline=True, default="", dynamic_prompts=False),
                io.Combo.Input("weighting_mode", options=[
                    "SDXL / CLIP (Standard)",
                    "Krea 2 / ZIT (Qwen)",
                    "LTX 2.3 / T5 (LLM)",
                ]),
                io.Boolean.Input("advanced_controls", default=False),
                io.Combo.Input("weight_clamping", options=["None", "Soft Safety Clamp"]),
                io.Combo.Input("negative_routing", options=["Direct", "Zero Inversion Null"]),
                io.Clip.Input("clip", optional=True),
                io.Model.Input("model", optional=True),
            ],
            outputs=[
                io.String.Output("text"),
                io.Custom("DICT").Output("weight_dict"),
                io.String.Output("negpip_compatible"),
                io.Conditioning.Output("conditioning"),
                io.Model.Output("model"),
                io.Clip.Output("clip"),
                io.Int.Output("clip_token_count"),
            ],
        )

    @classmethod
    def _parse_weighted_segments(cls, text):
        """
        Splits `text` into an ordered list of (segment_text, weight)
        tuples by scanning for `(phrase:weight)` annotations. Everything
        outside an annotation comes back as its own weight=1.0 segment, so
        "".join(seg for seg, _ in segments) always reconstructs the
        original text exactly (minus the parens/colon/number of any
        annotations themselves). A malformed weight number falls back to
        1.0 rather than raising, matching how PromptPaletteEditor's own
        <lora:...:weight> tag parsing already degrades on a bad float.
        """
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
            except ValueError:
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
        """tanh soft-knee compressor centered on 1.0 -- see class docstring."""
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
        """Fixed-point, trimmed of trailing zeros -- '1.5000' -> '1.5', '-1.2000' -> '-1.2'."""
        s = f"{w:.4f}".rstrip("0").rstrip(".")
        return s if s not in ("", "-") else "0"

    @classmethod
    def _format_bracket_text(cls, segments, weight_clamping):
        """
        `(phrase:weight)` syntax for every altered phrase; unweighted
        segments pass through verbatim. Used for both the SDXL-mode
        `text` output and the always-produced `negpip_compatible` output.
        negative_routing is deliberately not applied here: both real
        consumers of this format (ComfyUI's own tokenizer, and
        downstream attention-patching nodes) parse negative weights
        natively, so there is nothing to reroute.
        """
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
        """
        Plain de-bracketed prose for LLM/DiT-backbone text encoders. See
        negative_routing in the class docstring for why a negative weight
        can drop its phrase entirely here rather than just lose its sign.
        """
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
        # advanced_controls gates these at the value level regardless of
        # what the widgets are actually set to -- see class docstring.
        effective_clamping = weight_clamping if advanced_controls else "None"
        effective_routing = negative_routing if advanced_controls else "Direct"

        segments = cls._parse_weighted_segments(text or "")

        # Raw, absolute, untouched by clamping/routing -- Absolute
        # Control philosophy. Only phrases that were actually annotated
        # make it in; a repeated phrase keeps its last-seen weight, since
        # a dict can only hold one entry per key.
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
            # Reuses PromptPaletteEditor's own tokenize/encode_from_tokens
            # helper rather than duplicating it -- same pattern
            # PromptPaletteCombinatorial already follows.
            conditioning = PromptPaletteEditor._encode(clip, text_out)

        token_stats = count_clip_tokens(text_out)
        clip_token_count = token_stats["tokens"] if token_stats is not None else -1

        return io.NodeOutput(text_out, weight_dict, negpip_text, conditioning,
                              model, clip, clip_token_count)

