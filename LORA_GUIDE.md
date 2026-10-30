# LoraPal — LoRAs in Prompt Palette

## Quick start

1. Open **LoraPal** from the modular toolbar. Its visibility toggle remains in the existing toolbar settings.
2. Click **+ Add** on a card or list row. Each addition keeps the LoRAs already in your prompt. Clicking a card selects it for strength/variation setup and shows its local information.
3. In **Active in Prompt**, edit Model and CLIP separately, use **Mute** for a zero-strength comparison, or **×** to remove a standalone LoRA. Unmute restores the two previous strengths during the same editor session, including closing/reopening the sidecar; that memory resets when the editor or workflow is recreated.
4. To replace one LoRA, click its **Swap** button, choose the replacement card, then click **Replace LoRA**. Other entries stay in place. The sidecar also supports explicit prompt selections via **Use cursor**.
5. Select a catalog entry or use **Info** to see local metadata. Click trigger chips to stage words, then use **Insert / Replace** to commit. Trigger words are optional and never silently inserted by Add or Swap.

### Local artwork and metadata

Use **Set image / Change image** in the info area or right-click a catalog entry. PNG, JPEG and WebP are accepted up to 8 MB and 40 megapixels. Custom images are saved per ComfyUI user, outside the model folder; the original artwork and model are preserved. **Use folder preview** removes only LoraPal’s custom image. In **LoRA settings**, choose **Fill thumbnail** or **Show whole image**.

Without a custom image, LoraPal displays local PNG, JPEG, WebP, GIF, AVIF and BMP images, or MP4, WebM and M4V video previews beside the LoRA. Examples: `example.preview.mp4`, `example.safetensors.preview.jpg`, `example.png`, `example.thumb.webp`, `example.preview.1.mp4` and `example_1.jpg`. Filename matching ignores letter case. Matching metadata sidecars may also point to a differently named local media file in the same folder; online URLs are never fetched. Existing folder previews have no 8 MB upload limit.

Videos show a still frame and play silently on hover or keyboard focus. Only visible videos load; leaving a preview pauses it, and closing the panel releases it. The **Previews** switch sits directly beside **Grid / List** and **Size**, above the collection. Previews start enabled. Use this switch to turn them on or off. The switch and thumbnail framing apply to both gallery and list views. Custom uploaded images take priority; **Use folder preview** restores the original image or video. Unavailable artwork uses a placeholder. Refresh after adding previews; restart ComfyUI and reload the browser after installing this update.

Available information is merged from matching `.civitai.info`, `.json`, `.metadata.json`, `.info.json`, `.user.info`, `.info`, `.rgthree-info.json` and short `.txt` sidecars, plus embedded safetensors metadata. This includes nested `civitai` data from LoRA Manager and supported explicit rgthree trained-word records. The panel shows recorded trigger words, base model, title/version, author, description, tags and suggested strengths when present. Empty or malformed sidecars do not hide useful metadata in another matching file. Training tag frequencies are not treated as trigger words.

A folder containing exactly one LoRA can also use **`metadata.json`**, **`preview.jpeg`**, **`preview.mp4`**, or another local image/video filename. In shared folders, use model-named sidecars and previews (for example `example.metadata.json` and `example.jpeg`) so artwork is not assigned to the wrong model. The selected LoRA shows which metadata and preview files were found.

The size slider adjusts preview height continuously from **80–240px** and reflows gallery columns to fill the available width. List thumbnails scale too. Double-click the slider to restore 125px. The slider uses LoraPal’s own styles and saves its setting.

Custom thumbnails are fetched with the active ComfyUI user identity. Folder media streams directly. Preview loading can continue even if metadata lookup fails; failures are shown instead of silently leaving empty cards. If a video codec is unsupported by the browser, LoraPal tries a still-frame fallback using an already installed FFmpeg or imageio-ffmpeg binary. It never downloads a decoder. Without a compatible decoder, add a JPEG preview or custom image.

The **Refresh** button rescans local files and clears discovery caches. Search can read remaining local metadata in small batches to find trigger words beyond the visible cards. No online metadata lookup, image download or model-weight loading is performed by the browser. Metadata held in a different manager’s centralized folder is not scanned automatically.

LoRAs inside choices and conditional rules can have their weights edited, but removal of those alternatives stays in the prompt editor to preserve the surrounding syntax.



Use the tools you want: ordinary prompting, separate ComfyUI LoRA nodes, typed tags, wildcards, Fields, or the local picker. No downloads or new dependencies are needed.

## Pick, insert, swap, and audition

Open the **LoraPal** toolbar button, **Insert syntax → Browse LoRAs**, or the prompt’s right-click menu. LoRAs now open in a **true moveable, resizable popout sidecar window** that floats over the workspace, leaving your prompt editor fully visible and uncompressed:

- **Moveable & Resizable**: Drag the title bar to move the window within the ComfyUI browser window. Drag the bottom-right corner (`◢`) to resize width and height freely. Arrow keys provide fine adjustments.
- **Follow Node vs Free Floating**: In Follow Node mode (default), the window automatically docks beside your active editor node and tracks canvas panning/zooming in real time. Dragging the window or clicking **Follow node** switches to Free Floating mode so you can position it wherever you want. Double-clicking the header or clicking **Reset** restores default geometry and docks beside the node.
- **Dedicated Active LoRA Deck**: A dedicated section displays all LoRAs currently active in your prompt. Adjust Model and CLIP strengths with number fields, mute LoRAs (weight 0) without deleting them, or click **Dock at end of prompt** to format all tags into a tidy block at the very end of your prompt (`# --- LoRAs ---`), moving standalone tags while preserving choices, variables, conditional rules, and the spacing inside your prompt.
- **Folder & Favorites Navigation**: Browse your local LoRA library by folder hierarchy or filter by `★ Favorites` or `⚡ Active`. A folder dropdown provides item counts for every directory.
- **Gallery (Grid) & List Views + Size Slider**: Switch between visual Grid cards and dense List rows. A dedicated card size slider (matching the Prompt Palette sidebar) lets you scale cards from compact 80px thumbnails to detailed 240px cards with double-click reset to 125px.
- **Civitai & LoRA Manager Metadata**: Automatically extracts trained trigger words, base model badges (SDXL, FLUX, Pony, SD1.5, Illustrious), descriptions, and thumbnails from sidecar files (`.civitai.info`, `.json`, `.txt`) and embedded safetensors headers. Click trigger chips to stage text for insertion; right-click a catalog entry to copy its trigger words.
- **LoRA Audition Lab ("Audition & Trials")**: Dedicated interactive strength testing. Use 1-click audition presets (**Subtle 0.35**, **Balanced 0.70**, **Full 1.00**, **Punchy 1.25**, **A/B Trial 0 / 0.8**, **3-Step 0.4/0.7/1**, **5-Step Sweep**) or test variation modes (Cycle `+`, Seeded trial, Combinatorial batch, Random `*`, Cartesian `%`).

Selecting several files builds a stack or alternatives. Apply inserts at the saved cursor or replaces the selected tag/text. After inserting, the target collapses to the end of the insertion so the next insertion is additive. To replace an existing tag explicitly, use its **Swap** button or choose a tag with **Use cursor**; your current LoRA choices and strengths are retained. In the **Active in Prompt** deck, choose any tag to inspect or edit it explicitly.

Right-click a prompt tag to adjust MODEL or CLIP by 0.05, switch an existing LoRA choice between seeded/next/previous/random modes, or prepare a strength sweep for Combinatorial. A single tag’s quick sweep uses 0.4 / 0.7 / 1, preserving its separate CLIP strength; existing pure-LoRA alternatives retain their authored choices. Mixed prompt rules are never replaced wholesale. Right-click a collection card to insert/swap, cycle/randomize/test strengths, or choose/reset its color.

Both strength fields are always editable. **Link strengths** makes Model changes follow through to CLIP; typing into CLIP automatically unlinks it. Check Link strengths to reconnect them.

Use the native color swatch on any LoRA card or list row, or choose a default under **Browser options**. Per-file colors follow that LoRA in the collection, autocomplete and optional prompt highlighting; displayed text is adjusted for contrast while your chosen color is retained. **Reset LoRA color** in the catalog context menu removes a per-file override. These appearance choices are browser-local and do not change prompt text or execution.

The star saves a browser-local favorite. **Local previews**, **Complete <lora: while typing**, and **Highlight LoRA tags** are optional. Local previews start enabled; completion and highlighting start disabled. With completion enabled, type `<lora:` and part of a filename, then use the existing autocomplete keyboard controls. Replacing a complete tag through autocomplete preserves its separate strengths. Ctrl+Enter remains ComfyUI’s queue shortcut.

Local preview naming, custom image controls and metadata sources are described above. The picker only reads local metadata; it never fetches provider URLs or treats training-tag frequencies as required triggers.

## Execution and wiring

The picker’s **This node’s LoRA execution** setting is saved with the workflow. Old workflows default to Auto. Library entry editing can insert syntax; choose execution on the Palette node that resolves it.

| Mode | Text outputs | Loading and encoding |
| --- | --- | --- |
| Auto | Tags removed when MODEL and/or CLIP is connected; preserved when neither is connected | Patch connected inputs and encode clean text with the resulting CLIP |
| External | Keep resolved tags for another text-based loader | Do not load LoRAs here; Palette’s own encoding excludes recognized tags |
| Strip | Remove recognized tags | Do not load LoRAs; encode remaining text if CLIP is connected |
| Native bypass | Remove recognized tags | Use ComfyUI’s native bypass LoRA loader; error if that API is unavailable when an active LoRA is requested |

For ordinary integrated loading:

1. Connect the checkpoint/diffusion MODEL and text encoder CLIP to Palette’s corresponding optional inputs.
2. Connect Palette’s **Model** output to the sampler MODEL input. If you use external text encoders, supply Palette’s patched **CLIP** output to them.
3. Use Palette’s positive and negative **Conditioning** outputs, or encode its clean text using that patched CLIP. Connecting the original checkpoint MODEL directly to the sampler bypasses Palette’s model patches.

MODEL-only input works for diffusion-only loading; CLIP-only input applies the CLIP strength and encodes text. Neither can affect an unconnected side. A file found on disk does not prove that it matches your architecture, checkpoint, or text encoder. ComfyUI’s native loader determines supported keys and logs unmatched patches. LoRA and LyCORIS variants work only to the extent supported by the installed native loader.

For **Combinatorial**, connect **Model list**, **CLIP list** when needed, positive **Conditioning list**, and **Negative conditioning list** consistently. Every row starts from the original connected inputs, applies its own stack, and uses the same resulting CLIP for its positive and negative encoding. The separate **Model (passthrough)** and **CLIP (passthrough)** outputs remain the original inputs. ComfyUI may execute downstream nodes once per list item; use Max prompts deliberately.

A LoRA tag in negative text is part of the same model/CLIP stack, not a negative-only LoRA. Repeating a tag stacks it again; duplicates are not silently deduplicated. Use a negative strength explicitly when that is your intent. Zero on both connected sides skips disk loading. Missing, invalid or ambiguous names are skipped with a warning and a recorded status; a corrupt file or native loader error stops execution instead of claiming success.

## Syntax and variation

Names are relative to a ComfyUI-registered LoRA folder, including subfolders and extra model paths. Full filenames are most precise. Extensionless names work when exactly one file matches, across all extensions registered with ComfyUI. Folder separators work on Windows and Unix. No basename guessing across folders or silent first-match selection is performed.

| Goal | Example |
| --- | --- |
| Linked strengths | `<lora:styles/paint.safetensors:0.8>` |
| Separate strengths | `<lora:styles/paint.safetensors:0.8:0.2>` |
| Model only | `<lora:styles/paint.safetensors:0.8:0>` |
| CLIP only | `<lora:styles/paint.safetensors:0:0.6>` |
| Off | `<lora:styles/paint.safetensors:0>` |
| Stack | `<lora:paint:0.6> <lora:detail:0.3>` |
| Seeded alternative | `{<lora:paint:0.6>|<lora:ink:0.8>}` |
| Next each resolve | `{+<lora:paint:0.4>|<lora:paint:0.7>|<lora:paint:1>}` |
| Fresh random | `{*<lora:paint:0.4>|<lora:paint:0.8>}` |
| Keep CLIP fixed during a sweep | `{<lora:paint:0.4:0.2>|<lora:paint:0.8:0.2>}` |

Unmarked alternatives enumerate in Combinatorial, and make one seeded choice in regular Palette. Explicit `+`, `-`, `*` and other existing modifiers retain their usual resolver behavior. Sequential advancement happens per resolution, not necessarily once for the entire graph. Keep the downstream sampler noise seed fixed when comparing strengths; Palette’s seed controls text selection independently.

You can save complete tags plus their trigger words on separate lines of a wildcard TXT, use them in variables/conditions, insert them through Fields, or include them in prefix/suffix inputs. The existing resolver finishes first; only the selected, resolved tags load. An enhancer override replaces the positive text before tag extraction. Valid JSON objects remain literal, including tag-like strings inside captions.

The picker percent-encodes syntax delimiters in filenames such as double underscores and braces, preventing them from becoming wildcard or choice syntax. Exact registered filenames take priority over decoded aliases. External loaders may not decode these protected names; use simple filenames or the external loader’s own file selector for those cases.

## Other ComfyUI workflows

Keep using stock LoRA loaders upstream if you prefer: feed their patched outputs into Palette and type no additional tags. Use **External** if a specialized loader consumes resolved tag text. Custom LoRA stack socket formats, per-block weights, schedules/hooks, model-specific loaders and unsupported extra-network tag dialects belong to their owning nodes. Palette does not reinterpret or impersonate those formats. Select Strip only when you explicitly want recognized tags removed.

The existing Prompt Inspector reports resolved tag strengths and file availability without loading weights. Execution metadata records requested/effective strengths, source channel, execution mode and statuses such as loaded, disabled, missing, ambiguous, external, stripped or text_only. `loaded` / `loras_applied` means the native loader returned successfully, not a measured visual effect or confirmation that every key matched. `encoded_prompt` and `encoded_negative_prompt` distinguish the clean encoder text from external-loader tag text.
