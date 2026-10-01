import { loadExtensionStylesheet } from "../prompt_palette_shared.js";

// These used to be pulled in through @import inside css/wildcard_editor.css. An
// @import target can't be version-stamped from its parent <link>, so browsers and
// ComfyUI Desktop's Electron cache could keep serving an old partial (for example
// an old 50-autocomplete.css) next to a fresh one. Each partial is now loaded
// directly, with the server's build id in its URL. ORDER MATTERS: later files
// override earlier ones, exactly as the old @import order did.
const EDITOR_PARTIALS = [
  "00-base", "10-polish", "20-nodes2-io", "30-workspace", "40-horizontal-layout",
  "50-autocomplete", "60-library", "70-performance", "80-v4",
];

const editorPartialLoads = EDITOR_PARTIALS.map((name) =>
  loadExtensionStylesheet(new URL(`../css/editor/${name}.css`, import.meta.url).href, `prompt-palette-editor:${name}`),
);

const POWER_TOOLS_CSS_HREF = new URL("../css/prompt_palette_power_tools.css", import.meta.url).href;
const EFFECTS_CSS_HREF = new URL("../css/prompt_palette_effects.css", import.meta.url).href;

export const editorStylesReady = Promise.all([
  ...editorPartialLoads,
  loadExtensionStylesheet(POWER_TOOLS_CSS_HREF, "prompt-palette-power-tools"),
  loadExtensionStylesheet(EFFECTS_CSS_HREF, "prompt-palette-effects"),
]).catch((error) => {
  console.error("Prompt Palette: failed to load editor stylesheets", error);
  throw error;
});
