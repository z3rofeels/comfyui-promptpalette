<img width="1856" height="576" alt="palbanner" src="https://github.com/user-attachments/assets/475b8530-cd4d-4a5b-a517-3c72b54111f7" />

<p align="center">
  <b>Your</b> <span style="color: #28a745;">new best friend</span> for prompting in <b>ComfyUI</b>.
</p>

<p align="center">
A category-colored, wildcard-aware text encoder node for ComfyUI. 
     Prompt Palette turns the plain prompt textbox into a real editor: your wildcards are colored by folder, resolvable at a glance, browsable from a side drawer, editable without leaving the node, and, if you want, wired straight into CLIP/MODEL for a live encoder with automatic LoRA loading.

This node is a drop-in text encoder. Nothing is required to turn on — every advanced feature below (LoRA loading, negative prompt, seed passthrough, live CONDITIONING output, etc.) is opt-in via the **Inputs & outputs** section of Settings. Left completely alone, it behaves like a normal wildcard-resolving prompt box.


# Table of contents

- [Installation](#installation)
- [Quick tour](#quick-tour)
- [Core features](#core-features)
  - [Color-coded, folder-aware wildcards](#color-coded-folder-aware-wildcards)
  - [Browsing & inserting wildcards](#browsing--inserting-wildcards)
  - [The Syntax Injector](#the-syntax-injector)
  - [Editing wildcards inline](#editing-wildcards-inline)
  - [Seed & resolution controls](#seed--resolution-controls)
  - [Optional inputs & outputs](#optional-inputs--outputs)
  - [Theming & accessibility](#theming--accessibility)
- [✨ Recently added](#-recently-added)
- [Wildcard syntax cheat sheet](#wildcard-syntax-cheat-sheet)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Credits](#credits)

## Quick tour

- Type a prompt as normal. Anything wrapped in double underscores, like `__style/cinematic__`, is treated as a wildcard and colored by its folder.
- Click the 📁 **Browse wildcards** icon to open the picker and click any entry to insert it — it's added with a trailing `, ` automatically so you can keep clicking to chain wildcards together.
- Click the ✏️ **Edit** icon to create or edit a wildcard file without leaving the node.
- Click the ⚙️ **Settings** icon for themes, fonts, accessibility, and the optional input/output sockets.

<img width="1583" height="1017" alt="showresolved" src="https://github.com/user-attachments/assets/e7d0cd39-de4c-4fe0-8c20-bcf02837b8d7" />

## Core features

### Color-coded, folder-aware wildcards

Every `__wildcard__` in your prompt is colored by the category (folder) it lives in, so you can tell at a glance what's a style pick, a character pick, a lighting pick, etc. A legend beneath the prompt lists every category currently in use with its color swatch.

Wildcards that don't resolve to anything in your library (typo'd, renamed, or moved) are styled distinctly (red, dashed underline) instead of colored, and the footer keeps a running `N resolved-ready · N missing` count.

### Browsing & inserting wildcards

- **Picker drawer** (📁) — a searchable, folder-grouped list of every wildcard your backend has scanned. Click a row to insert it into the prompt at the cursor.
- **Pin (⭐)** any wildcard to keep it at the top of the list regardless of search/scroll.
- **Recent** — the last few wildcards you've used surface automatically above the folder list.
- **Copy** — copy a wildcard's `__path__` to your clipboard straight from its row, without inserting it.
- **Hover preview** — hover any row (or any wildcard token already in your prompt) to see a quick preview of that file's contents, or a "file missing" notice if it can't be found.
- **`__` autocomplete** — start typing `__` directly in the prompt and a filtered dropdown of matching wildcards appears; arrow keys + Enter/Tab to commit, Escape to dismiss.
- **Double-click** any wildcard token already in the prompt to jump straight into the Edit drawer for that file.

### The Syntax Injector

Every wildcard has an advanced-syntax flyout (hover the ⚡ icon on its picker row) so you never have to memorize the underlying syntax:

| Modifier | What it does |
|---|---|
| Random | Plain `__name__` — a normal seeded random pick |
| Random — unseeded | `__*name__` — re-rolls every run regardless of seed |
| Sequential — next | `__+name__` — walks forward through the file's options each call |
| Sequential — previous | `__-name__` — walks backward through the file's options each call |

Plus structural templates for inline option lists: random/unseeded/sequential choice, weighted choice, joined selection (exact count or a range), and "repeat this wildcard ×N."

### Editing wildcards inline

The ✏️ **Edit** drawer lets you create a new wildcard file or edit an existing one — one option per line — without leaving ComfyUI or touching the filesystem directly. Save with the button or **Ctrl/Cmd+S**; delete when you no longer need a file.

<img width="1535" height="1037" alt="ppalv2" src="https://github.com/user-attachments/assets/8e3f589c-cbf1-4ef7-a20a-c893ceb68b92" />



<img width="1671" height="941" alt="chrome_19rgnGkG2t" src="https://github.com/user-attachments/assets/ee5c6753-5415-4271-a7dc-efc419cfcdf1" />

### Seed & resolution controls

Turn on **Show seed & line-by-line controls** in Settings to get a compact toolbar strip with:

- A seed field and a 🎲 randomize-now button
- Seed mode: **Fixed**, **Increment (+1/run)**, **Decrement (−1/run)**, or **Randomize (new seed every run)**
- Entire-text-as-one vs. line-by-line resolution mode

Click **Show resolved** any time to preview exactly what your wildcards currently resolve to, without queuing a run.

### Optional inputs & outputs

Nothing here is required — the node works identically with every socket off. Turn on only what you need, per-node, from Settings:

**Inputs:** CLIP (turns this into a live encoder), Model (enables `<lora:name:weight>` tags — typed directly or hidden inside a wildcard file, loaded/applied/stripped automatically), Prompt prefix/suffix, LLM/enhancer override (replaces the resolved prompt entirely when connected), External seed, Negative prompt text + its own prefix/suffix.

**Outputs:** Model & CLIP passthrough (patched with any LoRAs applied this run), Conditioning & Negative conditioning (only present if CLIP is connected), Negative prompt, Seed used, Wildcards used (as JSON, and as a count), Raw unresolved text, and whether the enhancer override was used.

### Theming & accessibility

- Independent **day** and **night** UI themes with one-click toggle, or build/import/export your own via a JSON theme editor
- Per-category color pins, plus global hue rotation and color intensity sliders for everything else
- Custom fonts!
- independent prompt-text and sidebar-text size sliders
- a dedicated prompt text color (choose your own or go default)
  

  
<img width="1810" height="975" alt="optionaldaynight" src="https://github.com/user-attachments/assets/2e88cf49-00bc-4a48-a8e5-bd0953ddd999" />
<img width="1273" height="835" alt="ppalv2b" src="https://github.com/user-attachments/assets/230339a0-30f1-4f38-ab6f-545914f0c4f2" />


<img width="1208" height="763" alt="hue shiftv1" src="https://github.com/user-attachments/assets/a0a696a1-fbfc-450b-bbf2-74394294c1fb" />


</p><img width="1379" height="928" alt="Screenshot 2026-07-10 191042" src="https://github.com/user-attachments/assets/8f89847b-281f-40b4-8a7f-5511a20ae250" />

## ✨ Recently added

A few quality-of-life features on top of everything above:

- **Auto-separator on insert** — inserting a wildcard from the picker now automatically appends `, ` after it, so you can click your way through a whole prompt without ever reaching for the comma key. Skipped automatically if you're inserting right before punctuation that's already there.
- **Right-click a wildcard in the prompt** — right-clicking any wildcard already typed into your prompt opens the same Syntax Injector menu the picker's ⚡ icon offers, so you can add `+`/`-`/random/template syntax *after the fact* without needing to have remembered to click it before inserting. Choosing an option rewrites that exact occurrence in place instead of inserting a duplicate.
- **Undo / Redo** — dedicated ↩/↪ toolbar buttons plus **Ctrl+Z** / **Ctrl+Shift+Z** (or **Ctrl+Y**) now properly undo *everything* in this editor — typing, picker inserts, Syntax Injector commits, autocomplete, and Clear — not just plain keystrokes.
- **Jump to next missing wildcard** — the "`N missing`" counter in the footer is now clickable whenever it's non-zero. Click it to select the next unresolved wildcard token after your cursor (wrapping around), so fixing a typo'd or moved wildcard in a long prompt doesn't mean hunting for red text by eye.


---

## Wildcard syntax cheat sheet

You'll never need to type most of this by hand — the Syntax Injector (⚡, or right-click a token in the prompt) inserts it for you, but here's what it all means:

| Syntax | Meaning |
|---|---|
| `__name__` | Seeded random pick from `name`'s file |
| `__*name__` | Unseeded random pick — re-rolls every run |
| `__+name__` | Sequential — walks forward through the options each call |
| `__-name__` | Sequential — walks backward through the options each call |
| `{a\|b\|c}` | Random inline choice |
| `{*a\|b\|c}` | Unseeded random inline choice |
| `{+a\|b\|c}` / `{-a\|b\|c}` | Sequential forward / backward inline choice |
| `{1::a\|1::b\|c}` | Weighted choice — higher numbers picked more often |
| `{2$$, $$a\|b\|c}` | Pick exactly 2, joined by `, ` |
| `{1-2$$, $$a\|b\|c}` | Pick between 1 and 2, joined by `, ` |
| `{3#__name__}` | Expand `__name__` 3 times before any multi-select |
| `<lora:name:weight>` | Loads a LoRA (only when a Model input is connected) |

---

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Z` | Undo |
| `Ctrl+Shift+Z` / `Ctrl+Y` | Redo |
| `Ctrl/Cmd+S` (in the Edit drawer) | Save the wildcard file being edited |
| `Esc` | Close whichever menu/drawer/popup is currently open |
| Right-click a wildcard token | Open the Syntax Injector for that token |
| Double-click a wildcard token | Open it in the Edit drawer |


**Clear button if things gets cluttered**


<img width="402" height="443" alt="Screenshot 2026-07-10 191457" src="https://github.com/user-attachments/assets/fc94067e-d869-4fa6-8c2e-c87d9ab7e342" />



































***UPDATING SECTION WITH MORE DEMOS SOON***




## Installation

1. Clone or copy this repository into your `ComfyUI/custom_nodes/` folder.
2. Restart ComfyUI.
3. Add the **Prompt Palette** node from the node menu (or search for it) like any other node.





## Credits

Made by **z3rofeels** — [github.com/z3rofeels/comfyui-promptpalette](https://github.com/z3rofeels/)















