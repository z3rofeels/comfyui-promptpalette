<p align="center">
  <img width="1856" height="576" alt="Prompt Palette banner" src="https://github.com/user-attachments/assets/475b8530-cd4d-4a5b-a517-3c72b54111f7" />
</p>

<p align="center">
  <strong>Your new best friend for prompting in ComfyUI.</strong><br>
  A colorful wildcard editor, batch prompt generator, and backend-aware weight controller—built as one focused suite.
</p>
<p align="center">
  <img alt="GitHub stars" src="https://img.shields.io/github/stars/z3rofeels/comfyui-promptpalette?style=for-the-badge&color=6ee7b7&labelColor=11131a">
  <img alt="Last commit" src="https://img.shields.io/github/last-commit/z3rofeels/comfyui-promptpalette?style=for-the-badge&color=60a5fa&labelColor=11131a">
  <img alt="ComfyUI Nodes 1 and 2" src="https://img.shields.io/badge/ComfyUI-Nodes%201.x%20%2B%202.x-a78bfa?style=for-the-badge&labelColor=11131a">
 








</p>

> [!TIP]
> **Start with Prompt Palette.** The Combinatorial and Weight Controller nodes are specialized companions—not requirements. Add them only when your workflow needs batch expansion or dedicated prompt-weight routing.

<p align="center">
  <a href="#installation">Installation</a> ·
  <a href="#choose-your-node">Choose a node</a> ·
  <a href="#prompt-palette">Prompt Palette</a> ·
  <a href="#combinatorial">Combinatorial</a> ·
  <a href="#weight-controller">Weight Controller</a> ·
  <a href="#wildcard-syntax">Syntax</a> ·
  <a href="#troubleshooting">Troubleshooting</a>
</p>

---

<a id="whats-new-in-200"></a>
## What's new in Prompt Palette 2.0.0

Prompt Palette 2.0.0 is a major interface and workflow update, but the core idea is unchanged: write normal prompt text, keep wildcard syntax visible, and turn on only the extra tools your workflow needs.

### The main v2 changes

- **Rebuilt settings panel** — Prompt Palette now uses a full-height settings workspace instead of packing every option into the node itself.
- **72 built-in palettes across 12 collections** — Soda Shop, Planetarium, Ocean, Garden, Sweet Shop, Pixel Arcade, Trailhead, Night, Daylight, Creative, Professional, and Materials.
- **Theme Studio** — larger previews, collection browsing, editable custom themes, typography, wildcard-category colors, day/night pairing, corner controls, and theme import/export. Appearance is shared across Prompt Palette, Combinatorial, and Weight Controller while staying scoped to Prompt Palette-owned UI.
- **Workspace presets** — Core, Creator, and Power User presets let you choose how much of the interface is visible without changing the prompt workflow underneath.
- **Resolved Preview modes** — Manual, After pause, or Live. Your editable source stays intact while the preview shows the text Prompt Palette will actually return.
- **Expanded Prompt Library** — My Library supports search, folders, thumbnails, favorites, Recent items, RECIPES, and list/grid views while continuing to use normal local files.
- **Optional Starter Packs** — built-in syntax and model-oriented examples live separately from My Library and can be turned off at any time.
- **Optional Power Tools** — Prompt Doctor, Variation Lab, Resolved Diff, Library Manager, and Recipe Builder 2 can each be enabled independently.
- **Cleaner workflow I/O** — socket visibility and socket-label visibility are controlled separately so the node can stay as compact or as connected as you want.
- **Nine included basic workflows** — KREA 2 Turbo, MiniMax H3, Qwen Image, Z-Image Turbo, LTX-2.3, Anima, Illustrious XL, Pony Diffusion V6 XL, and SDXL.
- **Nodes 1.x and 2.x support** remains part of the same extension.

> [!NOTE]
> Starter Packs and Power Tools are optional. Prompt Palette still works as a straightforward local wildcard-aware prompt node with the extra UI and sockets hidden.

---

<a id="choose-your-node"></a>
<img width="1600" height="190" alt="section-suite" src="https://github.com/user-attachments/assets/756f4704-0e4f-408d-8ba8-5d5031c1195e" />

<img width="1600" height="520" alt="suite-overview" src="https://github.com/user-attachments/assets/1e4e7296-e74a-461d-b7b8-7166fa4aa442" />

| Node | Best for | What it returns |
|---|---|---|
| **Prompt Palette** | Everyday prompt writing, wildcard browsing, editing, organization, previewing, and optional encoding | Resolved prompt text, optional positive/negative conditioning, model/CLIP passthrough, seed and wildcard metadata |
| **Prompt Palette (Combinatorial)** | Producing many deliberate prompt variations from one template | Lists of prompts, seeds, wildcard metadata, and optional per-prompt conditioning/model/CLIP outputs |
| **Prompt Palette (Weight Controller)** | Applying and translating explicit `(phrase:weight)` instructions for different text backends | Backend-ready text, raw weight dictionary, compatibility text, optional conditioning, model/CLIP passthrough |

All three nodes appear under the **PromptPalette** category.

---

<a id="installation"></a>
<img width="1600" height="190" alt="section-install" src="https://github.com/user-attachments/assets/4798f3bf-783e-4c67-87e9-baed7085f5ee" />

### Standard ComfyUI

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/z3rofeels/comfyui-promptpalette.git
```

Restart ComfyUI, then search the node menu for **Prompt Palette**.

<details>
<summary><strong>Windows portable command</strong></summary>

Run this from your `ComfyUI_windows_portable` folder:

```bat
cd ComfyUI\custom_nodes
git clone https://github.com/z3rofeels/comfyui-promptpalette.git
..\..\python_embeded\python.exe -m pip install -r comfyui-promptpalette\requirements.txt
```

Restart the portable launcher after installation.
</details>

<details>
<summary><strong>Updating</strong></summary>

```bash
cd ComfyUI/custom_nodes/comfyui-promptpalette
git pull
python -m pip install -r requirements.txt
```

Restart ComfyUI and hard-refresh the browser after frontend updates.

> [!IMPORTANT]
> For a **manual v1 → v2 update**, replace the old `comfyui-promptpalette` folder cleanly instead of copying the v2 files over the existing folder. This prevents retired frontend files from an older install from being left behind.
</details>

### Included example workflows

The `workflows/` folder in Prompt Palette 2.0.0 includes deliberately basic examples built around ComfyUI's normal model-specific conditioning paths. They are starting points, not showcase workflows.

| Workflow | Prompt Palette placement |
|---|---|
| **KREA 2 Turbo — Basic** | Uses the native KREA 2 text encoder with Prompt Palette conditioning. |
| **MiniMax H3 — Basic T2V** | Sends Prompt Palette's resolved prompt into the native MiniMax H3 conditioning path. |
| **Qwen Image — Basic** | Uses the native Qwen Image text encoder with Prompt Palette for positive and negative conditioning. |
| **Z-Image Turbo — Basic** | Uses the native Z-Image text encoder with Prompt Palette conditioning. |
| **LTX-2.3 — Basic T2V** | Keeps LTX-2.3's native audio/video conditioning chain and uses Prompt Palette in place of the prompt-entry step. |
| **Anima — Basic** | Uses Anima's native Qwen text encoder with Prompt Palette for positive and negative conditioning. |
| **Illustrious XL — Basic** | Standard SDXL-family graph with Prompt Palette replacing the positive and negative text encoders. |
| **Pony Diffusion V6 XL — Basic** | Standard SDXL-family graph with Prompt Palette replacing the positive and negative text encoders. |
| **SDXL — Basic** | Standard SDXL graph with Prompt Palette replacing the positive and negative text encoders. |

### Wildcard library location

By default, Prompt Palette creates and scans:

```text
ComfyUI/wildcards/
```

It supports nested `.txt` files and nested `.yaml` / `.yml` libraries. You can also point it to another folder through Prompt Palette's settings, `wildcards_config.json`, or ComfyUI's `extra_model_paths.yaml` using a `wildcards:` entry.

Example:

```text
ComfyUI/wildcards/
├── characters/
│   └── monsters.txt        → __characters/monsters__
├── lighting/
│   └── cinematic.txt    → __lighting/cinematic__
└── styles.yaml          → nested YAML keys become slash paths
```

---

<a id="prompt-palette"></a>
<img width="1600" height="190" alt="section-prompt-palette" src="https://github.com/user-attachments/assets/f59d6a9b-4a55-4e3c-a6b9-e7ac682e11de" />

Prompt Palette replaces the plain prompt box with a full wildcard-aware editor while remaining useful as a simple text node. Leave every optional socket disabled and it behaves like a normal resolving prompt box; connect CLIP and MODEL only when you want live encoding and LoRA handling.

<p align="center">
<img width="1689" height="972" alt="Screenshot 2026-08-16 160803" src="https://github.com/user-attachments/assets/2d3499f9-9a5a-4ba6-a250-822b94eb1d28" />

</p>

### The 30-second tour

1. Type normally. `__wildcards__` are color-coded by their folder.
2. Open the **Prompt Library** to search My Library or the optional Starter Packs, preview entries, and insert what you need.
3. Open **Edit** to create or change `.txt` wildcards without leaving ComfyUI.
4. Use **Resolved Preview** to inspect the actual returned prompt; choose Manual, After pause, or Live updates in Settings.
5. Open **Settings** for Theme Studio, workspace controls, text sizing, wildcard paths, optional tools, and socket visibility.

### Wildcard-first editing

- **Folder colors and legend** make long prompts readable at a glance.
- **Missing wildcard detection** marks broken references and lets you jump to the next one.
- **Autocomplete** opens when you type `__`.
- **Hover preview** shows a wildcard file's contents without inserting it.
- **Double-click a token** to open that wildcard directly in the editor.
- **Right-click a token** to open the Syntax Injector and rewrite that exact occurrence.
- **Undo and redo** cover typing, inserts, autocomplete, syntax changes, and clearing.

### Prompt Library, recipes, and stash

<table>
<tr>
<td width="33%" valign="top"><strong>Prompt Library</strong><br>Search My Library, browse folders, switch between list/grid views, use thumbnails, favorites and Recent, and keep RECIPES alongside normal local entries.</td>
<td width="33%" valign="top"><strong>Palette Recipes</strong><br>Save reusable prompt building blocks so a familiar combination is never more than a click away.</td>
<td width="33%" valign="top"><strong>Prompt Stash</strong><br>Temporarily park prompts inside the node instead of opening extra text nodes or external notes.</td>
</tr>
</table>

<table>
<tr>
<td align="center"><img width="430" alt="Wildcard gallery mode" src="https://github.com/user-attachments/assets/c71b9c45-c315-47d2-973f-d91176d94459"></td>
<td align="center"><img width="500" alt="Palette Recipes" src="https://github.com/user-attachments/assets/f6792bd7-b9d2-4e9a-b2ab-01e15f31a0a5"></td>
<td align="center"><img width="500" alt="Prompt Stash" src="https://github.com/user-attachments/assets/42de2118-e9a9-40c1-8eae-b965d679398c"></td>
</tr>
</table>

### Starter Packs

Starter Packs are optional built-in examples kept separate from **My Library**. They are there to show useful syntax and model-oriented prompt structures without mixing bundled content into your own wildcard folders.

Included packs cover **Prompt Palette Syntax, Universal, KREA 2, MiniMax H3, Qwen Image, Z-Image Turbo, LTX-2.3, Anima, Illustrious, Pony, and SDXL**. Disable Starter Packs in Settings if you only want your own library.

<img width="726" height="1155" alt="Screenshot 2026-08-16 114459" src="https://github.com/user-attachments/assets/fb80837d-07d4-4db3-93aa-d06967d0f7bf" />


### Optional Power Tools

Each Power Tool is independent and can stay off unless you want it.

- **Prompt Doctor** — local prompt/library syntax checks for missing or empty wildcards, unclosed expressions, undefined variables, malformed parameter calls, duplicate LoRA tags, and similar issues.
<img width="986" height="566" alt="PPalDoc" src="https://github.com/user-attachments/assets/f25b99f0-bd36-4de4-b0ed-ed7b9eccff00" />

- **Variation Lab** — preview multiple deterministic wildcard resolutions before queueing, then copy or reuse a result with its seed.

  <img width="1494" height="989" alt="PPalVari" src="https://github.com/user-attachments/assets/95b67457-45b8-47b3-a300-ee7b60fbde14" />

- **Resolved Diff** — highlights what changed between the editable source and the resolved prompt.
- **Library Manager** — larger-library management and health tools, including multi-select and supported reversible operations.
- **Recipe Builder 2** — richer RECIPES creation with ordering, wildcard mode, separator, prefix, suffix, and source preview.

Prompt Palette can also expose its actions through ComfyUI's command palette when that integration is enabled.

### Optional encoder and workflow sockets

Nothing is required. Enable only the sockets your graph needs.

**Optional inputs**

- `clip` — encodes the resolved positive and negative text.
- `model` — enables `<lora:name:weight>` loading when CLIP is also connected.
- `prompt_prefix` / `prompt_suffix` — add reusable text before or after the main prompt.
- `enhancer_override` — replaces the resolved positive prompt when a connected enhancer returns text.
- `external_seed` — takes seed control from another node.
- `negative_text`, `negative_prefix`, `negative_suffix` — build and resolve the negative side in the same node.

**Optional outputs**

- Patched `model` and `clip`
- Positive and negative `conditioning`
- Resolved positive and negative prompt strings
- Effective seed
- Wildcards used and wildcard count
- Original unresolved text
- Enhancer-used flag
- Real CLIP-L token count
- Prompt Palette metadata JSON

Socket visibility and socket-label visibility are separate controls in v2, so a socket can stay connected while its displayed label is hidden when you want a cleaner graph.

> [!NOTE]
> LoRA tags are applied only when both MODEL and CLIP are connected. Tags are scanned **after** wildcard resolution, so a wildcard entry may contain `<lora:name:weight>`.

### Themes and accessibility

- **72 built-in palettes** across 12 collections: Soda Shop, Planetarium, Ocean, Garden, Sweet Shop, Pixel Arcade, Trailhead, Night, Daylight, Creative, Professional, and Materials
- Full-width **Theme Studio** with larger previews and collection browsing
- Suite-wide saved appearance for Prompt Palette, Combinatorial, and Weight Controller
- Independent day and night theme pairing
- Editable custom themes with import/export
- Per-category wildcard colors
- Hue and saturation controls
- Custom prompt and interface fonts
- Separate prompt/interface text sizes
- Dedicated prompt text color
- Corner-roundness and other presentation controls
- **Core, Creator, and Power User** workspace presets
- Density, toolbar, preview, motion, contrast, and interface-size controls

Prompt Palette themes stay scoped to Prompt Palette-owned UI; they do not recolor the ComfyUI canvas, menus, sidebar, or unrelated nodes.



<p align="center">
<img width="1437" height="1344" alt="Comfy_Desktop_2EoBSqbTuy" src="https://github.com/user-attachments/assets/7980ac12-8236-486a-8566-bc6c022bf9cd" />
</p>

---

<a id="combinatorial"></a>

<img width="1600" height="190" alt="section-combinatorial" src="https://github.com/user-attachments/assets/2ee927c7-1bd1-4874-85d5-de27cd6aa9c0" />

The Combinatorial node turns one wildcard-aware template into a **list of resolved prompts in a single node execution**. It shares Prompt Palette's editor, browser, theming, and syntax tools, but its outputs are intentionally list-based so downstream nodes can fan out over the generated set.

<img width="1600" height="460" alt="diagram-combinatorial" src="https://github.com/user-attachments/assets/e241cac3-911d-4778-9739-118c6a180376" />

### Choose a generation mode

| Mode | What it does | Use it when |
|---|---|---|
| **Random** | Resolves the template `count` times with independently derived seeds. Sampling is with replacement, so repeats are possible. | You want a controlled number of quick variations without expanding the complete space. |
| **Combinatorial** | Expands every **unmarked** wildcard and choice group into the full Cartesian product, stopping at `max_prompts`. | You want every subject × outfit × location pairing, a test matrix, or a complete prompt sweep. |

Example:

```text
a __subject__ wearing __outfit__ in __location__
```

With 3 subjects, 4 outfits, and 5 locations, Combinatorial mode produces `3 × 4 × 5 = 60` prompts.

### Controls

- `count` — number of prompts in Random mode; ignored in Combinatorial mode.
- `seed` — base seed used to make the run reproducible.
- `seed_mode`
  - **Sequential** — `seed`, `seed + 1`, `seed + 2`, …
  - **Fixed** — reuse the same seed for every generated prompt.
  - **Random** — derive a reproducible sequence of random seeds from the base seed.
- `max_prompts` — Combinatorial-only safety cap. `0` uses the built-in limit of **5,000**.
- **Estimated output** — updates before the run and warns when expansion will hit the cap.

### What expands—and what does not

In Combinatorial mode, ordinary unmarked groups expand:

```text
__subject__
{red|blue|green}
```

A group carrying an explicit sampler marker such as `+`, `-`, `*`, `~`, `@`, or `%` opts out of full expansion and makes one pick per generated prompt. This lets one part of a template stay random or sequential while the rest expands exhaustively.

### Outputs and fan-out

The node returns list outputs for `model`, `clip`, `conditioning`, `prompt`, `seed_out`, `wildcards_used`, and `prompt_metadata_json`.

> [!WARNING]
> In ComfyUI, a list output can cause connected downstream nodes to execute once per item. An estimated output of 500 prompts can therefore become 500 sampler runs. Use the live estimate and `max_prompts` deliberately.

When both MODEL and CLIP are connected, each generated prompt can load and apply its own LoRA tags before encoding. That matters when different wildcard combinations select different LoRAs.

---

<a id="weight-controller"></a>
<img width="1600" height="190" alt="section-weight-controller" src="https://github.com/user-attachments/assets/5912fc8b-ef24-4e0f-a164-9d52a259d248" />

The Weight Controller is a standalone text-routing companion. Feed it Prompt Palette's resolved `prompt`, `negative_prompt`, `raw_text`, or any other STRING. It reads explicit `(phrase:weight)` annotations and returns the format expected by the selected backend.

<img width="1600" height="500" alt="diagram-weight-controller" src="https://github.com/user-attachments/assets/66a68575-1d31-4342-9426-673c52b40d54" />


### Input syntax

```text
a portrait of a (red fox:1.35), dusk lighting, (blurry:-0.8)
```

- Weight `1.0` is neutral.
- Values above `1.0` emphasize a phrase.
- Values below `1.0` reduce it.
- Negative values request suppression where the downstream backend supports negative weighting.
- Nested weighted parentheses are not supported; keep each weighted phrase in its own top-level group.
- Bare `(word)` or `[word]` shorthand is not interpreted. Use the explicit `:weight` form.

### Weighting modes

| Mode shown in the node | `text` output | Typical route |
|---|---|---|
| **SDXL / CLIP (Standard)** | Keeps `(phrase:weight)` annotations intact | Standard ComfyUI CLIP tokenization; connect CLIP for direct conditioning |
| **Krea 2 / ZIT (Qwen)** | Returns clean de-bracketed prose | Send clean text to the Qwen-family encoder; use `negpip_compatible` for a downstream attention/negative-weight patcher that parses explicit weights |
| **LTX 2.3 / T5 (LLM)** | Returns clean de-bracketed prose | LLM/T5/Gemma-style text encoders that should receive natural language without literal weight brackets |

### Outputs

- `text` — formatted for the selected weighting mode.
- `weight_dict` — raw `{phrase: weight}` values exactly as authored, excluding neutral `1.0` segments.
- `negpip_compatible` — always emits explicit weighted text for downstream nodes that parse `(phrase:weight)`.
- `conditioning` — populated when CLIP is connected.
- `model` / `clip` — untouched passthrough sockets for cleaner graphs.
- `clip_token_count` — token count for the node's final `text` output.

### Advanced controls

Advanced controls are intentionally off by default.

- **Soft Safety Clamp** compresses extreme weights toward `1.0` while leaving values near neutral mostly unchanged.
- **Zero Inversion Null** affects clean-prose modes only. Because plain prose cannot carry a negative multiplier, negatively weighted phrases are removed instead of silently becoming normal unweighted text.

> [!IMPORTANT]
> `weight_dict` always preserves the raw number you entered. Clamping and negative routing affect generated text/conditioning outputs—not the dictionary.

### Recommended wiring

```text
Prompt Palette: prompt
        │
        ▼
Weight Controller: text
        ├── text ─────────────► target text encoder
        ├── negpip_compatible ► attention / negative-weight patcher
        └── conditioning ─────► sampler path (when CLIP is connected)
```

Add a second Weight Controller after Prompt Palette's `negative_prompt` output when the positive and negative sides need independent handling.

---

<a id="wildcard-syntax"></a>
<img width="1600" height="190" alt="section-syntax" src="https://github.com/user-attachments/assets/0f2fe042-9ea2-4ec2-8236-1493e3b54fc5" />

The **Syntax Injector** inserts most of this for you from the wildcard browser or a token's right-click menu.

<img width="759" height="576" alt="Screenshot 2026-08-16 114940" src="https://github.com/user-attachments/assets/a0a2c32f-6adb-4e1f-bdb4-ab625b394624" />


### Everyday syntax

| Syntax | Meaning |
|---|---|
| `__name__` | Seeded random line from a wildcard file |
| `__*name__` or `__~name__` | Unseeded random line; may change every run |
| `__+name__` | Sequential forward |
| `__-name__` | Sequential backward |
| `__@name__` | Cyclical/sequential-forward alias used by Dynamic Prompts syntax |
| `__%name__` | Joint combinatorial step across every `%` group in the same normal Prompt Palette resolve call |
| `{a\|b\|c}` | Seeded inline choice |
| `{*a\|b\|c}` or `{~a\|b\|c}` | Unseeded inline choice |
| `{+a\|b\|c}` / `{-a\|b\|c}` | Sequential inline choice |
| `{@a\|b\|c}` | Cyclical inline choice |
| `{%a\|b\|c}` | Joint combinatorial inline step |
| `{2::common\|1::rare}` | Weighted random choice |
| `{2$$, $$a\|b\|c}` | Pick exactly two items and join with `, ` |
| `{1-3$$, $$a\|b\|c}` | Pick between one and three items |
| `<lora:name:0.8>` | Load/apply a LoRA when MODEL and CLIP are connected |

<details>
<summary><strong>Advanced templates, globs, and variables</strong></summary>

| Syntax | Meaning |
|---|---|
| `__colours*__` | Pool entries from wildcard names matching a glob pattern |
| `__artists/**__` | Recursive wildcard glob below a folder |
| `__template(subject=fox)__` | Use a wildcard file as a parameterized multi-line template |
| `${name=value}` | Assign a variable that is re-evaluated when read |
| `${name=!value}` | Assign and resolve a variable once immediately |
| `${name}` | Read a variable |
| `${name:default}` | Read a variable with fallback text |
| `{3#__name__}` | Expand the wildcard token three times before multi-select processing |

Nesting is resolved innermost-first. Lines beginning with `#` are treated as comments and omitted during resolution.
</details>

### `%` inside Prompt Palette vs. the Combinatorial node

- `%` syntax in the regular Prompt Palette node advances **one joint combination per execution**.
- The dedicated Combinatorial node returns the **entire expansion set in one execution** and does not require `%` markers.

---

<img width="1600" height="190" alt="section-reference" src="https://github.com/user-attachments/assets/ec90b3aa-1423-4020-a580-b53502a19a8d" />

### Keyboard and mouse shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl/Cmd + Z` | Undo |
| `Ctrl/Cmd + Shift + Z` or `Ctrl/Cmd + Y` | Redo |
| `Ctrl/Cmd + S` in the Edit drawer | Save the current wildcard file |
| `Esc` | Close the active drawer, menu, or popup |
| Right-click a wildcard token | Open the Syntax Injector for that occurrence |
| Double-click a wildcard token | Open that wildcard in the Edit drawer |

<a id="troubleshooting"></a>
### Troubleshooting

<details>
<summary><strong>The node loads, but its custom UI does not appear</strong></summary>

1. Update ComfyUI and its frontend.
2. Restart ComfyUI completely.
3. Hard-refresh the browser (`Ctrl/Cmd + Shift + R`).
4. Confirm the repository folder is named `comfyui-promptpalette` and contains the `web/` directory.
5. Open the browser console and look for messages beginning with `[PromptPalette]` or `Prompt Palette:`.
6. When reporting the issue, include whether you use Desktop or portable, Nodes 1.x or 2.x, the frontend version, and the first relevant console error.
</details>

<details>
<summary><strong>My wildcard stays unresolved</strong></summary>

- Confirm the file exists below the active wildcard library path.
- Use slash paths without the file extension: `characters/monsters.txt` becomes `__characters/monsters__`.
- Click Refresh in the wildcard browser after external file changes.
- A bare leaf name works only when it is unambiguous across the library.
</details>

<details>
<summary><strong>Combinatorial mode creates too many runs</strong></summary>

Check **Estimated output** before queueing. Reduce the wildcard sizes, mark groups that should make only one pick, or set a lower `max_prompts` value.
</details>

<details>
<summary><strong>Weights appear as literal text</strong></summary>

Confirm the selected mode matches the connected text encoder. Standard ComfyUI CLIP can interpret explicit weighted syntax; Qwen/LLM-style encoders generally need clean prose plus a compatible downstream weighting patcher.
</details>

### Compatibility

- ComfyUI Nodes **1.x and 2.x**
- ComfyUI Desktop and portable installations
- `.txt`, `.yaml`, and `.yml` wildcard libraries
- Large nested wildcard libraries with cached/background scanning

When reporting a bug, include a minimal workflow, exact reproduction steps, console output, ComfyUI/frontend versions, node mode, and Desktop vs. portable.

### License

Prompt Palette 2.0.0 is licensed under **GNU GPL-3.0-only**. The full license text is included in the repository's `LICENSE` file.

### Credits

Prompt Palette builds on work and conventions from:

- **ComfyUI and the ComfyUI community** — the node-based creative platform and ecosystem.
- **Adi Eyal / Dynamic Prompts** — the wildcard and dynamic-prompt conventions that inspired much of the supported syntax.
- **Jtkelm2 and AUTOMATIC1111 contributors** — early text-file prompt replacement workflows and conventions.

Made with care by **z3rofeels**.

<p align="center">
  <a href="https://github.com/z3rofeels/comfyui-promptpalette/issues">Report a bug</a> ·
  <a href="https://github.com/z3rofeels/comfyui-promptpalette/discussions">Start a discussion</a> ·
  <a href="https://github.com/z3rofeels/comfyui-promptpalette">Star Prompt Palette</a>
</p>
