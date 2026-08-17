# Prompt Palette 2.0

**A local-first prompt workspace for ComfyUI, made by z3rofeels.**

Prompt Palette is a small suite of ComfyUI nodes for writing, organizing, previewing, combining, and weighting prompts without moving the work out of ComfyUI. Your prompt library stays local, wildcard syntax stays visible, and the extra tools are optional.

## Contents

- [Features](#features)
- [Installation](#installation)
- [Included workflows](#included-workflows)
- [The three nodes](#the-three-nodes)
- [Prompt Palette](#prompt-palette)
  - [Editor and preview](#editor-and-preview)
  - [Prompt Library](#prompt-library)
  - [Starter Packs](#starter-packs)
  - [Wildcard syntax](#wildcard-syntax)
- [Optional Power Tools](#optional-power-tools)
- [Appearance and workspace](#appearance-and-workspace)
- [Inputs and outputs](#inputs-and-outputs)
- [Combinatorial](#combinatorial)
- [Weight Controller](#weight-controller)
- [Wildcard library location](#wildcard-library-location)
- [Updating](#updating)
- [Troubleshooting](#troubleshooting)
- [Design philosophy](#design-philosophy)
- [License](#license)

## Features

- **Local-first prompt editing** with visible wildcard syntax and no required account or cloud prompt service.
- **Prompt Library** with nested local files and folders, search, thumbnails, favorites, Recent items, and RECIPES.
- **Optional Starter Packs** with Prompt Palette syntax examples and model-oriented prompt ideas.
- **Resolved Preview** so you can inspect the final prompt text while keeping the editable source intact.
- **Wildcard and choice syntax** including seeded, unseeded, sequential, combinatorial, weighted-choice, variable, and parameter forms.
- **Optional CLIP and MODEL integration** for direct conditioning, passthrough, LoRA tags, token counts, and workflow metadata.
- **Negative prompt support** alongside the main prompt workflow.
- **Prompt Stash and history tools** for keeping useful prompt states close at hand.
- **Combinatorial generation** for random batches or full Cartesian prompt expansion.
- **Weight Controller** for translating `(phrase:weight)` syntax for different text-encoder workflows.
- **72 built-in palettes** organized into twelve easy-to-browse collections, with deliberately different light, dark, warm, cool, playful, neutral, retro, natural, and high-contrast looks. Custom theme copies, typography controls, wildcard-category colors, day/night pairing, and corner-roundness control are included too.
- **Workspace controls** for density, toolbar visibility, preview behavior, motion, contrast, and interface text size.
- **Nodes 1 and Nodes 2 support** from the same extension.
- **Example workflows** for popular image and video models using ComfyUI core nodes plus Prompt Palette only.

## Installation

### Git

From `ComfyUI/custom_nodes`:

```bash
git clone https://github.com/z3rofeels/comfyui-promptpalette.git
pip install -r comfyui-promptpalette/requirements.txt
```

Restart ComfyUI, then search for **Prompt Palette**.

### Manual ZIP install

1. Download the release ZIP.
2. Extract the `comfyui-promptpalette` folder into `ComfyUI/custom_nodes`.
3. Install `requirements.txt` with the Python environment used by ComfyUI if needed.
4. Restart ComfyUI.

When updating from an older release, replace the old `comfyui-promptpalette` folder instead of copying new files over it.

### Windows portable

From the `ComfyUI_windows_portable` folder:

```bat
cd ComfyUI\custom_nodes
git clone https://github.com/z3rofeels/comfyui-promptpalette.git
..\..\python_embeded\python.exe -m pip install -r comfyui-promptpalette\requirements.txt
```

Restart ComfyUI afterward.

## Included workflows

The `workflows/` folder contains deliberately basic examples for the model families represented in the built-in Starter Packs.

They use **ComfyUI core nodes plus Prompt Palette only**. Optional prompt enhancers, helper packs, ControlNet stacks, upscalers, and unrelated extras are left out. When a model has a native conditioning path, that path is kept intact and Prompt Palette replaces the normal prompt entry/encoding point.

| Workflow | Prompt Palette placement |
|---|---|
| **KREA 2 Turbo — Basic** | Uses the native KREA 2 text encoder and Prompt Palette conditioning. |
| **MiniMax H3 — Basic T2V** | Sends Prompt Palette's resolved prompt into the native MiniMax H3 conditioning node. |
| **Qwen Image — Basic** | Uses the native Qwen Image text encoder with Prompt Palette for positive and negative conditioning. |
| **Z-Image Turbo — Basic** | Uses the native Z-Image text encoder and Prompt Palette conditioning. |
| **LTX-2.3 — Basic T2V** | Uses LTX-2.3's native audio/video conditioning chain with Prompt Palette in place of the text encode nodes. |
| **Anima — Basic** | Uses Anima's native Qwen text encoder with Prompt Palette for positive and negative conditioning. |
| **Illustrious XL — Basic** | Standard SDXL-family checkpoint graph with Prompt Palette replacing the positive and negative text encoders. |
| **Pony Diffusion V6 XL — Basic** | Standard SDXL-family checkpoint graph with Prompt Palette replacing the positive and negative text encoders. |
| **SDXL — Basic** | Standard SDXL graph with Prompt Palette replacing the positive and negative text encoders. |

The prompts in these examples come from the matching Prompt Palette Starter Packs. They are clean starting points, not showcase workflows.

## The three nodes

All three nodes appear in the **PromptPalette** category.

| Node | Use it for |
|---|---|
| **Prompt Palette** | Everyday prompt writing, wildcard browsing, reusable local prompt pieces, previewing, RECIPES, metadata, and optional CLIP/MODEL wiring. |
| **Prompt Palette (Combinatorial)** | Producing controlled batches or Cartesian combinations from wildcard-aware prompt templates. |
| **Prompt Palette (Weight Controller)** | Translating explicit `(phrase:weight)` syntax for different text-encoder workflows, with optional conditioning output. |

You do not need the companion nodes to use Prompt Palette.

## Prompt Palette

Prompt Palette can be used as a simple resolved-text node or as a larger prompt workspace. Show only the tools and sockets you actually use.

### Editor and preview

The main editor keeps your original source prompt visible, including wildcard syntax, inline choices, variables, and parameter calls.

**Resolved Preview** shows the prompt text Prompt Palette will return without replacing the editable source. Preview behavior can be set to **Manual**, **After pause**, or **Live**.

Wildcard categories can be color-coded to make large prompts easier to scan, and autocomplete / Quick Insert can help locate local library entries while typing.

### Prompt Library

**My Library** uses ordinary local files and folders. It supports:

- nested `.txt` files;
- nested `.yaml` / `.yml` libraries;
- search;
- folders;
- thumbnails;
- favorites;
- Recent items;
- RECIPES;
- list and grid presentation.

Your library is not converted into a proprietary database. The files remain yours to edit, copy, back up, or use elsewhere.

### Starter Packs

Starter Packs are optional built-in examples kept separate from My Library.

The included collections cover:

- Prompt Palette Syntax
- Universal
- KREA 2
- MiniMax H3
- Qwen Image
- Z-Image Turbo
- LTX-2.3
- Anima
- Illustrious
- Pony
- SDXL

They are starting points, not required templates, and can be disabled.

### Wildcard syntax

A compact reference:

```text
__Locations/Location__                  seeded wildcard
__*Locations/Location__                 unseeded wildcard
__+Locations/Location__                 sequential forward
__-Locations/Location__                 sequential backward
__%Locations/Location__                 Cartesian cycle

{cinematic|documentary|editorial}       seeded choice
{*warm|cool|neutral}                    unseeded choice
{5::cinematic|1::documentary}           weighted choice
{2$$, $$red|green|blue}                 choose two and join with ", "
{1-3$$ + $$red|green|blue}              choose a range and join with " + "

${subject=runner}                        assign a variable
${light=!{warm|cool}}                    assign and resolve immediately
${wardrobe:casual jacket}                variable with fallback

__Templates/Portrait(subject=runner,light=golden hour)__
                                         parameter wildcard

# this whole line is ignored             comment
```

Type `__` and part of a wildcard path to use Quick Insert. The Syntax Injector can also help insert common wildcard forms.

## Optional Power Tools

Power Tools are independent and can be enabled only when wanted.

### Prompt Doctor

Checks prompt and library syntax locally for issues such as missing or empty wildcards, unclosed expressions, undefined variables, malformed parameter calls, duplicate LoRA tags, and similar prompt-health problems.

### Variation Lab

Preview several deterministic prompt variations before queueing generation. Results can be inspected, copied, or reused with their seed.

### Resolved Diff

Shows what changed between the editable source and the resolved prompt.

### Library Manager

Adds larger-library search and management tools, multi-select, supported bulk file operations, and in-session undo for reversible library changes.

### Recipe Builder 2

A structured RECIPES builder with ordering, wildcard mode, separator, prefix, suffix, and source preview. The original quick Recipe save path remains available when Recipe Builder 2 is disabled.

### ComfyUI command palette

Optional Prompt Palette actions can be registered with ComfyUI's command palette.

## Appearance and workspace

The main **Prompt Palette** settings panel owns appearance for the whole three-node suite. Change a palette, font, category color, corner shape, or day/night pair there and Prompt Palette, Combinatorial, and Weight Controller use the same saved appearance. Combinatorial and Weight Controller keep their own settings focused on their node-specific controls. The saved suite theme still applies when a workflow contains only one of the companion nodes.

The theme studio includes **72 built-in palettes** grouped into twelve collections:

- **Soda Shop** — six unmistakably different fountain-counter flavors, from Cream Soda to Grape Pop and Root Beer;
- **Planetarium** — icy Europa, dusty Mars, pale Saturn, electric Neptune, Solar Flare, Deep Space, and other space-inspired looks;
- **Ocean** — sea glass, tropical reef, storm coast, lagoon, abyss, and bioluminescent water;
- **Garden** — meadow, hydrangea, sunflower, terracotta, greenhouse, and bluebell;
- **Sweet Shop** — strawberry cream, lemon, blue raspberry, cotton candy, mint chip, and chocolate;
- **Pixel Arcade** — bold blue, cherry, coin-gold, cyan, green-screen, and CRT-inspired palettes;
- **Trailhead** — pine, canyon clay, lake cabin, desert sage, campfire, and alpine sky;
- **Night** — charcoal, plum, navy, terminal green, rosewood, and noir-gold dark themes;
- **Daylight** — cool porcelain, warm newsprint, ivory, peach, lavender, and mint light themes;
- **Creative** — Bauhaus, Art Deco, Memphis, ink wash, ceramic, and paper-cut inspired palettes;
- **Professional** — slate, graphite, Oxford, sand, blueprint, and high-contrast choices;
- **Materials** — copper, frosted glass, and walnut/brass inspired palettes.

Theme Studio uses the whole panel width: choose a collection, then pick from larger per-theme previews that show the actual panel, surface, border, text, and accent relationship. Built-in palettes can be duplicated into editable custom themes.

Appearance controls also include day/night pairing, prompt and interface typography, corner roundness, wildcard-category colors, and theme import/export.

Prompt Palette themes are scoped to Prompt Palette-owned UI. They do not recolor the ComfyUI canvas, menus, sidebar, or unrelated nodes.

Workspace controls let you tune density, toolbar visibility, preview behavior, motion, contrast, interface text size, and other presentation choices without changing your prompt content.

## Inputs and outputs

Prompt Palette can stay compact. Unused sockets can be hidden, while socket-label visibility is controlled separately.

Optional inputs include:

- CLIP;
- MODEL;
- prompt prefix and suffix;
- negative prompt text, prefix, and suffix;
- external seed;
- enhancer override.

Available outputs include:

- resolved prompt text;
- resolved negative prompt text;
- raw unresolved source text;
- effective seed;
- wildcard information;
- optional MODEL / CLIP passthrough;
- optional positive / negative conditioning;
- CLIP token count;
- Prompt Palette metadata JSON.

When MODEL and CLIP are connected, Prompt Palette can also apply supported `<lora:name:weight>` tags found in prompt text.

## Combinatorial

**Prompt Palette (Combinatorial)** expands one wildcard-aware prompt template into multiple outputs.

It supports:

- random batches;
- full Cartesian expansion;
- sequential, fixed, or deterministic randomized seed handling;
- a configurable output safety cap;
- prompt, seed, and metadata lists;
- optional MODEL / CLIP / conditioning list outputs when connected.

## Weight Controller

**Prompt Palette (Weight Controller)** parses explicit `(phrase:weight)` syntax and translates it for different text-encoder workflows.

Available modes include:

- **SDXL / CLIP (Standard)**;
- **Krea 2 / ZIT (Qwen)**;
- **LTX 2.3 / T5 (LLM)**.

It can return formatted weighted text, a parsed weight dictionary, NegPip-compatible text, optional conditioning, and MODEL / CLIP passthrough.

## Wildcard library location

By default, Prompt Palette works with the configured ComfyUI wildcard location. A different wildcard folder can be selected in Prompt Palette settings.

Prompt Palette also supports compatible wildcard paths provided through its config and `extra_model_paths.yaml`.

## Updating

For a major Prompt Palette update:

1. Close ComfyUI.
2. Replace the existing `comfyui-promptpalette` folder with the new release, or use `git pull` if installed with Git.
3. Re-run `pip install -r requirements.txt` if dependencies changed.
4. Restart ComfyUI.
5. Hard-refresh the frontend once if an old cached interface is still displayed.

## Troubleshooting

### A wildcard is marked missing

Confirm the file exists beneath the active wildcard library and that the prompt path matches the nested folder/file name.

### The UI still looks like an older version after updating

Make sure the previous Prompt Palette folder was replaced cleanly, restart ComfyUI, then hard-refresh the frontend once.

### I only want a simple prompt node

Hide unused sockets, disable Starter Packs, leave Power Tools off, and use Prompt Palette as a straightforward resolved-text node.

### Reporting an issue

Please include your ComfyUI version, frontend version if known, Nodes 1 / Nodes 2 mode, and a screenshot or minimal workflow when possible:

`https://github.com/z3rofeels/comfyui-promptpalette/issues`

## Design philosophy

Prompt Palette is meant to make deliberate prompt work easier without taking control away from the person using it.

That means:

- local-first where practical;
- visible, understandable prompt syntax;
- no account requirement;
- no mandatory cloud prompt library;
- optional advanced tools rather than mandatory complexity;
- customization stays inside Prompt Palette;
- normal ComfyUI workflows remain normal ComfyUI workflows.

## License

See [LICENSE](LICENSE).

**Prompt Palette by z3rofeels.**
