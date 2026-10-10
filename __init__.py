from typing_extensions import override
import importlib
import logging

from .comfy_compat import ComfyExtension, io

from .nodes import PromptPaletteEditor, PromptPaletteCombinatorial, PromptPaletteWeightController

try:
    # Imported for its side effect: registering the HTTP routes (including /prompt_palette/build_id).
    importlib.import_module(".server_routes", __package__)
except Exception:
    logging.getLogger(__name__).exception("Prompt Palette could not register server routes")

try:
    from .prompt_metadata_hook import register_prompt_metadata_hook
    register_prompt_metadata_hook()
except Exception:
    logging.getLogger(__name__).exception("Prompt Palette could not register metadata restoration")

WEB_DIRECTORY = "web"
__version__ = "2.0.5"

class PromptPaletteExtension(ComfyExtension):
    @override
    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return [PromptPaletteEditor, PromptPaletteCombinatorial, PromptPaletteWeightController]

async def comfy_entrypoint() -> PromptPaletteExtension:
    return PromptPaletteExtension()

__all__ = ["comfy_entrypoint", "WEB_DIRECTORY", "__version__"]
