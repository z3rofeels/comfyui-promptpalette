# MOSS-Image with Prompt Palette

The bundled examples use ComfyUI's native MOSS nodes. Start with a current ComfyUI build; these workflows require **0.42.1 or newer**. Prompt Palette includes no model weights or automatic model downloads.

| Workflow | Purpose |
|---|---|
| [Turbo AIO](workflows/prompt_palette_moss_turbo_aio.json) | All-in-one checkpoint example |
| [Base INT8](workflows/prompt_palette_moss_base_int8.json) | Separate model, text encoder, and VAE example |
| [SFT caption](workflows/prompt_palette_moss_sft_caption.json) | Regular SFT with a caption prompt |
| [SFT layout](workflows/prompt_palette_moss_sft_layout.json) | Regular SFT with layout guidance |

1. Load the matching workflow in ComfyUI and read its model/setup notes.
2. Select your installed files in each loader. Use the workflow intended for your model variant; the Turbo and regular-SFT examples have different sampling settings.
3. Edit the Prompt Palette text, or enable the Adjustable Recipe Workspace in Power tools and choose a MOSS layout.
4. For structured layout JSON, keep valid JSON objects intact and match the canvas dimensions to the workflow. Choices and wildcards outside a complete JSON object work normally.
5. Keep Prompt Palette's seed output connected to the sampler when using its seed controls.

The workflow files document their individual wiring and settings. Loading the actual models and checking generated output requires a live ComfyUI installation and compatible hardware.
