"""Small compatibility boundary for ComfyUI's versioned V3 API."""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

try:
    # Use ComfyUI’s documented numbered V3 namespace. Current core re-exports
    # its io implementation from latest; this does not pin the engine internals.
    from comfy_api.v0_0_2 import ComfyExtension, io

    COMFY_API_NAMESPACE = "v0_0_2"
except ImportError:  # Older/nightly builds may expose only the moving alias.
    from comfy_api.latest import ComfyExtension, io

    COMFY_API_NAMESPACE = "latest"
    logger.warning(
        "Prompt Palette could not import comfy_api.v0_0_2; using comfy_api.latest. "
        "Update ComfyUI to a current release that exposes the numbered V3 API."
    )

__all__ = ["COMFY_API_NAMESPACE", "ComfyExtension", "io"]
