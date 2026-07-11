import json
import re

import comfy.sd
import comfy.utils
import folder_paths

from .wildcard_index import get_index
from .wildcard_resolver import WildcardResolver


class PromptPaletteEditor:
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
    """

    # <lora:some_name:0.8> -- filename may contain most characters except
    # ':' and '>'; weight is a plain float applied to both model & clip.
    _LORA_TAG_RE = re.compile(r"<lora:([^:>]+):([\d.]+)>")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": ("STRING", {"multiline": True, "default": "", "dynamicPrompts": False}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xFFFFFFFFFFFFFFFF}),
                "processing_mode": (["entire text as one", "line by line"],),
            },
            "optional": {
                # Both socket-only (no widget), so leaving them unconnected
                # simply omits them from the call - process() defaults both
                # to None and branches on that rather than requiring either.
                "clip": ("CLIP",),
                "model": ("MODEL",),
                "prompt_prefix": ("STRING", {"forceInput": True, "default": ""}),
                "prompt_suffix": ("STRING", {"forceInput": True, "default": ""}),
                "enhancer_override": ("STRING", {"forceInput": True, "default": ""}),
                "external_seed": ("INT", {"forceInput": True}),
                "negative_text": ("STRING", {"multiline": True, "forceInput": True, "default": ""}),
                # Mirror the positive side's prefix/suffix wiring for the negative
                # prompt, so users get the same "pipe in a shared style-preset
                # node" freedom on both sides instead of just the positive one.
                "negative_prefix": ("STRING", {"forceInput": True, "default": ""}),
                "negative_suffix": ("STRING", {"forceInput": True, "default": ""}),
            },
        }

    RETURN_TYPES = ("MODEL", "CLIP", "CONDITIONING", "CONDITIONING", "STRING", "STRING",
                     "INT", "STRING", "STRING", "INT", "BOOLEAN")
    RETURN_NAMES = ("model", "clip", "conditioning", "negative_conditioning", "prompt", "negative_prompt",
                     "seed_out", "wildcards_used", "raw_text", "wildcards_used_count", "used_enhancer")
    FUNCTION = "process"
    CATEGORY = "PromptPalette"
    OUTPUT_NODE = False

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

    def process(self, text, seed, processing_mode,
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
            resolved, positive_loras = self._extract_loras(resolved)
            resolved_negative, negative_loras = self._extract_loras(resolved_negative)
            loras = positive_loras + negative_loras
            if loras:
                out_model, out_clip = self._apply_loras(model, clip, loras)
            conditioning = self._encode(out_clip, resolved)
            negative_conditioning = self._encode(out_clip, resolved_negative)
        elif clip is not None:
            # Tier 2: no MODEL to patch, so LoRA tags (if any) are left as
            # literal text rather than silently dropped or half-applied.
            conditioning = self._encode(clip, resolved)
            negative_conditioning = self._encode(clip, resolved_negative)
        elif model is not None:
            # MODEL wired in without CLIP: can't encode, can't load LoRAs
            # (that call needs both). Pass the model through untouched.
            print("[PromptPalette] warning: model connected without clip - "
                  "no LoRA loading or encoding possible this run")

        return (out_model, out_clip, conditioning, negative_conditioning,
                resolved, resolved_negative, effective_seed, wildcards_used,
                text, len(used_names), used_enhancer)


# NOTE: this mapping key is the node's permanent type id — it's what gets saved
# into every workflow JSON. Renaming it (as done here, from WildcardGalleryEditor)
# means workflows saved under the old name won't auto-resolve to this class
# anymore. If you have existing workflows/users you care about, keep the old key
# as a second alias pointing at the same class instead of removing it, e.g.:
#   NODE_CLASS_MAPPINGS = {"PromptPaletteEditor": PromptPaletteEditor, "WildcardGalleryEditor": PromptPaletteEditor}
NODE_CLASS_MAPPINGS = {
    "PromptPaletteEditor": PromptPaletteEditor,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "PromptPaletteEditor": "Prompt Palette",
}
