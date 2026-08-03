from typing_extensions import override
from comfy_api.latest import ComfyExtension, io

from .nodes import PromptPaletteEditor, PromptPaletteCombinatorial, PromptPaletteWeightController

try:
    from . import server_routes  # noqa: F401  registers aiohttp routes on import
except Exception as e:
    print(f"[prompt-palette] warning: could not register server routes: {e}")

WEB_DIRECTORY = "web"


class PromptPaletteExtension(ComfyExtension):
    @override
    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return [PromptPaletteEditor, PromptPaletteCombinatorial, PromptPaletteWeightController]


async def comfy_entrypoint() -> PromptPaletteExtension:
    return PromptPaletteExtension()


__all__ = ["comfy_entrypoint", "WEB_DIRECTORY"]
