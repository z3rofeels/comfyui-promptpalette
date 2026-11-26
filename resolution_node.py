"""Standalone ComfyUI Resolution Selector & Latent Generator node.

Provides model-aware aspect-ratio presets, orientation swap, predictable
dimension snapping, and native LATENT generation for SDXL, SD 1.5,
Flux.1/SD3/Z-Image/Anima/Krea 2, Qwen-Image, and MOSS-Image/Flux.2.
"""

from __future__ import annotations

import inspect
import math
from dataclasses import dataclass

from .comfy_compat import io

try:
    import torch
except ImportError:  # pragma: no cover - outside ComfyUI runtime
    torch = None

try:
    import comfy.model_management as model_management
except ImportError:  # pragma: no cover - outside ComfyUI runtime
    model_management = None

_SCHEMA_SUPPORTS_SEARCH_ALIASES = "search_aliases" in inspect.signature(io.Schema).parameters


@dataclass(frozen=True)
class ResolutionProfile:
    name: str
    channels: int
    downscale: int
    step: int
    min_dim: int
    max_dim: int
    default_width: int
    default_height: int


PROFILES: tuple[ResolutionProfile, ...] = (
    ResolutionProfile(
        name="SDXL / Pony / Illustrious",
        channels=4,
        downscale=8,
        step=64,
        min_dim=512,
        max_dim=4096,
        default_width=1024,
        default_height=1024,
    ),
    ResolutionProfile(
        name="Flux.1 / SD3 / Z-Image / Anima / Krea 2",
        channels=16,
        downscale=8,
        step=16,
        min_dim=256,
        max_dim=4096,
        default_width=1024,
        default_height=1024,
    ),
    ResolutionProfile(
        name="Qwen-Image",
        channels=16,
        downscale=8,
        step=16,
        min_dim=256,
        max_dim=4096,
        default_width=1328,
        default_height=1328,
    ),
    ResolutionProfile(
        name="MOSS-Image / Flux.2",
        channels=128,
        downscale=16,
        step=16,
        min_dim=256,
        max_dim=4096,
        default_width=1024,
        default_height=1024,
    ),
    ResolutionProfile(
        name="SD 1.5",
        channels=4,
        downscale=8,
        step=64,
        min_dim=256,
        max_dim=2048,
        default_width=512,
        default_height=512,
    ),
)

PROFILE_NAMES: list[str] = [p.name for p in PROFILES]
PROFILE_MAP: dict[str, ResolutionProfile] = {p.name: p for p in PROFILES}
DEFAULT_PROFILE: str = PROFILES[0].name


def get_profile(model_profile: str | None) -> ResolutionProfile:
    if isinstance(model_profile, str) and model_profile in PROFILE_MAP:
        return PROFILE_MAP[model_profile]
    return PROFILE_MAP[DEFAULT_PROFILE]


def snap_dimension(value: int | float, multiple: int, min_dim: int, max_dim: int) -> int:
    """Round value to the nearest valid multiple within [min_dim, max_dim]."""
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        numeric = float(min_dim)
    if numeric != numeric:  # NaN guard
        numeric = float(min_dim)
    step = max(1, int(multiple))
    clamped = max(float(min_dim), min(float(max_dim), numeric))
    snapped = int(round(clamped / step) * step)
    if snapped < min_dim:
        snapped = ((min_dim + step - 1) // step) * step
    if snapped > max_dim:
        snapped = (max_dim // step) * step
    return max(step, snapped)


def snap_dimensions(
    model_profile: str | None,
    width: int | float,
    height: int | float,
    snap_to_multiple: bool = True,
) -> tuple[int, int, ResolutionProfile]:
    """Normalize (width, height) to valid multiples for the given model profile."""
    profile = get_profile(model_profile)
    multiple = profile.step if snap_to_multiple else profile.downscale
    # Always enforce at least the architecture's spatial downscale multiple.
    effective_multiple = max(profile.downscale, multiple)
    w = snap_dimension(width, effective_multiple, profile.min_dim, profile.max_dim)
    h = snap_dimension(height, effective_multiple, profile.min_dim, profile.max_dim)
    return w, h, profile


def dimensions_for_aspect_and_mp(
    model_profile: str | None,
    aspect_w: float,
    aspect_h: float,
    target_mp: float,
    snap_to_multiple: bool = True,
) -> tuple[int, int, ResolutionProfile]:
    """Compute snapped (width, height) matching an aspect ratio and target megapixel budget."""
    profile = get_profile(model_profile)
    safe_aw = max(0.01, float(aspect_w or 1.0))
    safe_ah = max(0.01, float(aspect_h or 1.0))
    safe_mp = max(0.1, float(target_mp or 1.0))
    # Diffusion architectures define 1 MP as 1024x1024 = 1,048,576 px (so 4 MP = 2048x2048).
    target_pixels = safe_mp * 1_048_576.0
    ratio = safe_aw / safe_ah
    raw_w = math.sqrt(target_pixels * ratio)
    raw_h = math.sqrt(target_pixels / ratio)
    return snap_dimensions(profile.name, raw_w, raw_h, snap_to_multiple=snap_to_multiple)


class _StandaloneResolutionV3Node(io.ComfyNode):
    """Isolated V3 schema cache base for standalone utility nodes."""

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
                return


class PromptPaletteResolutionSelector(_StandaloneResolutionV3Node):
    """Standalone model-aware resolution selector and empty LATENT generator."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        schema_kwargs = {
            "node_id": "PromptPaletteResolutionSelector",
            "display_name": "Resolution Selector",
            "category": "PromptPalette",
            "is_output_node": False,
            "description": (
                "Resolution Selector (by z3rofeels): standalone aspect-ratio picker "
                "and model-aware empty LATENT generator for SDXL, Flux.1/SD3/Z-Image/"
                "Anima/Krea 2, Qwen-Image, MOSS-Image/Flux.2, and SD 1.5."
            ),
            "inputs": [
                io.Combo.Input(
                    "model_profile",
                    display_name="Model Profile",
                    tooltip="Selects architecture-verified aspect presets, dimension snapping, and native LATENT channel/downscale format.",
                    options=PROFILE_NAMES,
                    default=DEFAULT_PROFILE,
                ),
                io.Int.Input(
                    "width",
                    display_name="Width",
                    tooltip="Output image width in pixels.",
                    default=1024,
                    min=16,
                    max=4096,
                    step=16,
                ),
                io.Int.Input(
                    "height",
                    display_name="Height",
                    tooltip="Output image height in pixels.",
                    default=1024,
                    min=16,
                    max=4096,
                    step=16,
                ),
                io.Int.Input(
                    "batch_size",
                    display_name="Batch Size",
                    tooltip="Number of empty latent images in the batch.",
                    default=1,
                    min=1,
                    max=4096,
                ),
                io.Boolean.Input(
                    "snap_to_multiple",
                    display_name="Snap to Step",
                    tooltip="Snap dimensions to the model profile's recommended step (e.g. 64 for SDXL, 16 for Flux/MOSS).",
                    default=True,
                    optional=True,
                ),
            ],
            "outputs": [
                io.Latent.Output(
                    "latent",
                    display_name="Latent",
                    tooltip="Empty LATENT batch formatted for the selected model architecture.",
                ),
                io.Int.Output(
                    "width",
                    display_name="Width",
                    tooltip="Snapped output width in pixels.",
                ),
                io.Int.Output(
                    "height",
                    display_name="Height",
                    tooltip="Snapped output height in pixels.",
                ),
            ],
        }
        if _SCHEMA_SUPPORTS_SEARCH_ALIASES:
            schema_kwargs["search_aliases"] = [
                "resolution",
                "aspect ratio",
                "resolution selector",
                "empty latent",
                "latent size",
                "canvas size",
                "flux2 latent",
                "moss latent",
                "sdxl resolution",
            ]
        return io.Schema(**schema_kwargs)

    @classmethod
    def execute(
        cls,
        model_profile: str = DEFAULT_PROFILE,
        width: int = 1024,
        height: int = 1024,
        batch_size: int = 1,
        snap_to_multiple: bool = True,
    ) -> io.NodeOutput:
        if torch is None:
            raise RuntimeError("PyTorch is required to generate LATENT tensors.")

        w, h, profile = snap_dimensions(
            model_profile,
            width,
            height,
            snap_to_multiple=bool(snap_to_multiple),
        )
        batch = max(1, min(4096, int(batch_size or 1)))
        latent_h = max(1, h // profile.downscale)
        latent_w = max(1, w // profile.downscale)

        device = model_management.intermediate_device() if model_management is not None else "cpu"
        dtype = model_management.intermediate_dtype() if model_management is not None else torch.float32

        latent = torch.zeros(
            [batch, profile.channels, latent_h, latent_w],
            device=device,
            dtype=dtype,
        )
        return io.NodeOutput(
            {"samples": latent, "downscale_ratio_spacial": profile.downscale},
            w,
            h,
        )


__all__ = [
    "DEFAULT_PROFILE",
    "PROFILES",
    "PROFILE_MAP",
    "PROFILE_NAMES",
    "PromptPaletteResolutionSelector",
    "ResolutionProfile",
    "dimensions_for_aspect_and_mp",
    "get_profile",
    "snap_dimension",
    "snap_dimensions",
]
