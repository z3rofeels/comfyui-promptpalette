import json

from .wildcard_index import get_index
from .wildcard_resolver import WildcardResolver


class PromptPaletteEditor:
    """
    A wildcard-aware prompt text box. The visible editor (color-coded syntax
    highlighting, folder picker, hover previews, resolved-preview) lives entirely
    in the frontend DOM widget; this node just receives the final plain text
    in the hidden STRING widget the frontend keeps in sync, and resolves it.

    Beyond the always-on "prompt" output, this node declares a handful of
    optional inputs/outputs purely for wiring flexibility (e.g. piping in an
    LLM prompt-enhancer node, or feeding the resolved seed into a sampler).
    None of them are required — the node behaves exactly as a plain wildcard
    text box if left unconnected. Whether their sockets are actually shown
    on a given node instance is controlled by that node's Settings > Inputs
    & Outputs panel in the frontend, not by anything here.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": ("STRING", {"multiline": True, "default": "", "dynamicPrompts": False}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xFFFFFFFFFFFFFFFF}),
                "processing_mode": (["entire text as one", "line by line"],),
            },
            "optional": {
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

    RETURN_TYPES = ("STRING", "STRING", "INT", "STRING", "STRING", "INT", "BOOLEAN")
    RETURN_NAMES = ("prompt", "negative_prompt", "seed_out", "wildcards_used",
                     "raw_text", "wildcards_used_count", "used_enhancer")
    FUNCTION = "process"
    CATEGORY = "PromptPalette"
    OUTPUT_NODE = False

    def process(self, text, seed, processing_mode,
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

        return (resolved, resolved_negative, effective_seed, wildcards_used,
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
