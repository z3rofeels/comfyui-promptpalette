# Changelog

## 2.1.1 — Prompting Ergonomics, Hygiene & Discoverability

### Prompt Doctor & 1-Click Hygiene

- Detect case- and underscore-normalized duplicate clauses across plain prompts and Fields (`find_duplicate_clauses`, `UnifiedWildcardEngine.validate`) while preserving JSON literals, `#` comments, wildcards, and trailing `# --- LoRAs ---` docks.
- Add pre-flight file availability checks for `embedding:...` and `<lora:...>` references against ComfyUI's `embeddings` and `loras` catalogs (`/prompt_palette/diagnostics`, `/prompt_palette/resolve`, `/prompt_palette/inspect`), surfacing missing assets and duplicate counts in the Status Bar attention badge, Prompt Doctor, and Prompt Inspector before queueing.
- Add diff-previewed **Tidy & Deduplicate** and **Adapt for Model** tools (`FLUX`, `Krea 2`, `Qwen / Wan / Z-Image`, `SDXL / Illustrious / Pony`, `Booru`, and `Anima`) accessible from the editor context menu, Prompt Doctor, Prompt Inspector, and Command Palette, always recording a single reversible Undo step (`Ctrl/Cmd+Z`).

### Smart Paste (Civitai / A1111 Block Splitter)

- Detect pasted multi-line Civitai/A1111 blocks (`Negative prompt:`, `Steps:` / generation parameters, and inline `<lora:name:wt>` tags) without affecting normal typing speed, offering a non-blocking banner with split preview to separate Positive/Negative text, strip metadata parameters, dock LoRAs, optionally apply the parsed seed, or split clauses into Fields.

### Interactive Clause & Token Breakdown

- Add a **Token & Weight Breakdown** section to Prompt Inspector with a color-coded per-Field / per-clause token share bar (`75` CLIP-L tokens per chunk, `LoRAs 0t`) and interactive `−0.05` / `1.00×` / `+0.05` clause weight steppers backed by `weight_edit.js`.
- Add an opt-in **CLIP-L chunk boundary marker** (`chunkBoundaryIndicator`, off by default) rendered via `CSS.highlights` with zero DOM mutation.

### Inline Wildcard & Choice Quick-Swap

- Support `Alt/Option+Click` and right-click **Peek / swap token…** on any `__wildcard__` or `{a|b|c}` choice group to inspect available options and thumbnails, reroll a candidate slot, or pin an option in place via Undo history.

### Command Palette & Empty-State Quick-Start

- Add a scoped **Command Palette (`Ctrl/Cmd+K`)** inside Prompt Palette surfaces to fuzzy-search toolbar actions, hygiene tools, Quick Slots `A–D`, main sidebar tabs, and Starter Packs.
- Show unobtrusive, dismissible **Quick-Start** shortcut pills (`Starter Packs`, `Fields Workspace`, `Browse LoRAs`, `Import Image`, `Ctrl/Cmd+K`) when an empty editor is focused.

### LoraPal, Generation History & Toolbar Controls

- Add **Fave Folders** in **LoraPal** (sidecar and sidebar **LoRAs** tab) with per-folder star toggles, a `★ Fave Folders` dropdown group, and an `All Fave` quick-jump bar synced across panels.
- Add **Newest ↓ / Oldest ↑** sorting and scroll-preserving `Load more` pagination across **Recent Generations** in both the node and sidebar.
- Add individual toolbar visibility toggles for **Refine**, **Inputs / outputs (Ports)**, and **Zen**, a **Manage ports…** shortcut in Settings, and full zero-height empty-track collapse down to the corner **Settings** gear when all toolbar actions are hidden.

## 2.1.0 — Style Studio, Expanded Starter Packs & Visual Polish

### Style Studio & Style Autocomplete (opt-in)

- Add the opt-in **Style Studio** sidecar for **Krea 2** and **MOSS-Image** (`94` curated entries across `12` facets and `8` curated mixes), with Subject-First and Scene-First word-budget ordering, `{%a|b}` Mix Composer, MOSS Caption / Ordered Tags / Spatial JSON dialects, quoted typography helper, and conflict/buzzword lint.
- Add opt-in **Style autocomplete** in the prompt editor with facet badges (`LENS`, `CAMERA`, `MEDIUM`, `ATMO`, `EXPR`, `LIGHT`, `STYLE`, `FRAMING`, and more) and prefix filters (`style:`, `cam:`, `lens:`, `light:`, `atmo:`, `krea2:`, `moss:`, etc.), inserting phrases verbatim without Booru underscore/parenthesis transforms.
- Expand **Starter Packs (`v2.2.0`)** across `12` packs (`Prompt Palette Syntax`, `Universal` 54, `KREA 2` 50, `MOSS-Image` 30, `MiniMax H3`, `Qwen Image`, `Z-Image Turbo`, `LTX-2.3`, `Anima`, `Illustrious`, `Pony`, and `SDXL`) with tag/facet search and an optional **Style Studio ↗** bridge when Style Studio is enabled.

### Sidebar, LoRAs & Generation History

- Polish **Generation Inspector** into a Civitai-style right-hand flyout alongside the sidebar (`Raw Input Prompt` vs `Final Resolved Prompt`, wildcard/choice selection ledger, color-matched LoRA cards with async base-model and trigger enrichment, generation parameter tiles, and collapsible `Workflow & Nodes`), keeping the gallery unobstructed.
- Unify **Recent Generations**, **LoraPal** (both sidebar **LoRAs** tab and floating sidecar), and **Explore** on virtualized **Gallery**, **Masonry**, **Filmstrip / detail**, and **List** views with `Natural` and preset aspect ratios, smooth scrolling, and responsive narrow-width layouts.
- Preserve **Model Info** flyout theme/color syncing, multi-preview image/video stepping, `1.0` base-strength initialization, trailing `# --- LoRAs ---` prompt docking, and **Saved LoRA sets**.

### Release & Documentation

- Bump package, extension, and Registry metadata to **2.1.0**.
- Refresh the GitHub `README.md` with updated 2.1.0 feature coverage, cleaner navigation, and visual showcases for Autocomplete, LoraPal Model Info, Generation Inspector, Fields, Seed Lab, and Saved Port Layouts.

## 2.0.9 — Keep & Evolve

### Refine and compare

- Pin a generation as a node's Keeper, compare new candidates against it, and keep a better candidate as the next reference.
- Refine an active Palette or Combinatorial draft with Commit / Cancel, using the existing prompt, Fields, Variation Lab, and LoRA tools. Other A–D drafts stay saved.
- Review recorded prompt channels or authored Fields before recovering a generation. Promote selected data into the editor or an A–D draft, with replacement review for saved work.
- Compare up to four saved generations in Recent Generations with Gallery or an A/B image wipe, highlighted prompt differences, run details, and comparison JSON export.
- Keep verified Palette output distinct from authored or resolved node context. History recording and storage of authored text and Fields remain opt-in and local.
- Inspect any Recent Generation in a Civitai-style info panel: large artwork with identity pills, color-coded LoRA rows, prompt cards with a Resolved / Authored switch, parameter tiles and a category-toned node list. Every copy and reuse action is unchanged.
- Recent Generations: press Esc to close the inspector (focus returns to the card you opened), and use the arrow keys, Home and End to move between cards.
- Recent Generations: Gallery cards no longer collapse into thin strips in the Generations tab when the list is long, and the list scrolls normally. Filmstrip fits the Library-tab section, and the Generations tab no longer overlaps the LoRAs tab at narrow widths. Layout is chosen in one place, the sidebar toolbar; the duplicate selector inside Recent Generations is gone.

### Editing and workspace

- Route individual Fields through optional text inputs and outputs, combine incoming text before or after authored text, and retain field order. Empty fields accept external text; isolated positive/negative outputs and exact Combinatorial rows retain their own text. Field settings explains separators, preview limits, and regional encoder routing.
- Name A–D quick drafts, inspect their positive/negative text, and review saved drafts before copying over them. Each draft retains its own plain prompt or Fields workspace.
- Keep typing smooth with autocomplete open on long prompts, and reduce per-keystroke cost in large Fields workspaces.
- Keep the Settings gear steady when the Auto hide toolbar reveals or retracts.
- Open LoraPal on large collections without a stall: faster local preview/sidecar discovery in big folders and lighter card rendering with many saved LoRA colours.
- Improve Find & Replace with compact options, replacement previews, and safer selection tracking. Ctrl/Cmd+Enter retains ComfyUI's queue shortcut.
- Restore compact top-edge Ports with native link handling and more editor space. Search ports and save up to 16 named port layouts per workflow node while preserving connected ports and custom labels.
- Reclaim footer space with an auto-hiding status bar; warnings stay visible. Always visible and Warnings only modes remain available.
- Color Field titles with their accent. Choose Field only, Title only or Field and title for the workspace (Fields editor settings) or per field (Field settings → Color on). Titles and carets adapt to light and dark themes; editor syntax colors are never changed.
- Improve Fields grid sizing, resizing at canvas zoom, cancellation, and active-field visibility. Jump to field retains selections and text scroll positions; settings adapt to compact and wide nodes.
- Restore Combinatorial startup with the shared Fields settings, populate seed-behavior choices, and keep externally connected controls authoritative.
- Improve editing responsiveness, panel following, undo/redo, and cleanup when editors close or nodes are removed.
- Keep the Fields workspace settings (and the field list beside them) exactly where they are scrolled when you change a color, title, type, or any other field option.
- Keep Field names when a workflow reloads: a saved workspace is no longer discarded because its optional checkpoint history is invalid, and Field titles never fall back to internal ids (they use the saved name, the socket name, or `Field N`).

### LoRAs and library

- Open a Civitai-style model info flyout from any LoRA card (card click or the ⓘ button) with artwork, base model and version, file size, description, tags, trigger words, color, suggested strength and Add to prompt. LoraPal alignment, disclosure headers and swatch colors were polished to match the theme accent.
- Add a LoRAs sidebar tab using the shared local LoraPal catalog, favorites, colors, previews, active-stack controls, and strength trials.
- Browse the sidebar LoRA collection in Gallery, List, Masonry, or Filmstrip / detail, with responsive controls and the full matching catalog available.
- Preserve preview thumbnails during panel resizing and show the existing fallback when an image cannot load.

## 2.0.8 — LoraPal and flexible workspaces

- Browse local LoRAs, inspect metadata and image/video previews, edit separate Model/CLIP strengths, and prepare strength trials with LoraPal and LoRA Audition Lab.
- Add adjustable Fields columns, heights, and presentation controls, alongside named snapshots, variants, and field presets.
- Add Tiles and Contact sheet library views, card/framing controls, and a movable, resizable Library settings window.
- Switch between A–D prompt drafts, use Find & Replace, and browse Seed Lab's recent seeds, favorites, presets, and optional fortunes.
- Add Anima 1.0 weighting, settings search, independent menu sizing, optional library collections and relationships, and local generation history.

## 2.0.7 — Visual browsing and focused comparisons

- Share local wildcard thumbnails across the Library, main sidebar, autocomplete, and hover previews.
- Improve sidebar artist/tag browsing, editable prompting-language starters, settings, and narrow layouts.
- Add MOSS caption, ordered-tag, and layout starters with local workflow examples. Complete valid JSON stays literal through prompt resolution and batches.
- Compare one Fields change at a time against a fixed resolved baseline; send matching positive/negative trials to Combinatorial.
- Expand bundled reference artwork with Anima previews and Booru concept references, with source and rights information retained.
- Preserve ComfyUI queue shortcuts while editing and provide access to native spelling suggestions.

## 2.0.6 — Sidebar and field variation

- Browse Library, styles, Syntax, and Tools beside the canvas and insert into a selected prompt target.
- Add offline style browsing, Anima artist search, personal previews, and favorites.
- Use Vary, Lock, and Follow during generation, with layouts, snapshots, variants, and field comparisons.
- Improve library editing with retained drafts, autocomplete, cleanup tools, and safer Save copy behavior.
- Add toolbar arrangement, visual syntax guidance, switch/case conditions, and optional Positive Antonyms.

## 2.0.5 — Selective prompt variation

- Add offline Booru autocomplete, category filtering, custom words, and import/export.
- Build prompts from structured recipe fields and selectively Lock, Vary, or Follow their choices. Keep useful Variation Lab previews for reuse or batch generation.
- Customize toolbar size, order, and visibility, and import reviewed prompt text from images with embedded metadata.
- Add Choices & rules, a prompt inspector, and improvements to selection, undo, library refresh, and saved workspace restoration.

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
