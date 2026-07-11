from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

try:
    from . import server_routes  # noqa: F401  registers aiohttp routes on import
except Exception as e:
    print(f"[prompt-palette] warning: could not register server routes: {e}")

WEB_DIRECTORY = "web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
