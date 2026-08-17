# Changelog

## 2.0.0 — Prompt Palette 2

A major visual and workflow update while keeping the core Prompt Palette workflow familiar.

### Highlights

- New full-height Prompt Palette settings panel.
- One suite-wide appearance system for Prompt Palette, Combinatorial, and Weight Controller.
- Rebuilt the 72-palette library for much stronger visual variety across light, dark, warm, cool, retro, natural, playful, professional, and high-contrast styles. The twelve packs now include **Soda Shop, Planetarium, Ocean, Garden, Sweet Shop, Pixel Arcade, Trailhead, Night, Daylight, Creative, Professional,** and **Materials**.
- Theme Studio now uses larger per-theme previews, full-width collection browsing, custom themes, typography, category colors, day/night pairing, and theme import/export.
- Combinatorial and Weight Controller settings now contain only controls relevant to those nodes.
- Core, Creator, and Power User workspace presets.
- Optional Starter Packs and Power Tools remain individually configurable.
- Separate socket visibility and socket-label controls.
- Nodes 1 and Nodes 2 support.

### Editor and library

- Improved wildcard highlighting, autocomplete, Quick Insert, and Syntax Injector.
- Resolved Preview with Manual, After Pause, and Live modes.
- Prompt Library search, folders, thumbnails, favorites, Recent, RECIPES, and list/grid views.
- Starter Packs remain separate from My Library and can be disabled.

### Companion nodes

- **Prompt Palette (Combinatorial)** — wildcard-aware random batches and Cartesian combinations.
- **Prompt Palette (Weight Controller)** — explicit `(phrase:weight)` handling for supported text encoders.

### Included workflows

Basic Prompt Palette examples are included for:

- KREA 2 Turbo
- MiniMax H3
- Qwen Image
- Z-Image Turbo
- LTX-2.3
- Anima
- Illustrious XL
- Pony Diffusion V6 XL
- SDXL

### Updating from v1

1. Close ComfyUI.
2. Replace the old `comfyui-promptpalette` folder with the v2 folder.
3. Restart ComfyUI.
4. Hard-refresh once if the old interface is still cached.
