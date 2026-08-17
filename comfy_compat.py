"""Small compatibility boundary for ComfyUI's versioned V3 API."""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

try:
    # Use the numbered V3 namespace so this release does not silently follow `latest`.
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
