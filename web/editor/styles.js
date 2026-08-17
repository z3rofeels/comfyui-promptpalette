import { loadExtensionStylesheet } from "../prompt_palette_shared.js";

const CSS_HREF = new URL("../css/wildcard_editor.css", import.meta.url).href;
const POWER_TOOLS_CSS_HREF = new URL("../css/prompt_palette_power_tools.css", import.meta.url).href;
const EFFECTS_CSS_HREF = new URL("../css/prompt_palette_effects.css", import.meta.url).href;

export const editorStylesReady = Promise.all([
  loadExtensionStylesheet(CSS_HREF, "prompt-palette-editor"),
  loadExtensionStylesheet(POWER_TOOLS_CSS_HREF, "prompt-palette-power-tools"),
  loadExtensionStylesheet(EFFECTS_CSS_HREF, "prompt-palette-effects"),
]).catch((error) => {
  console.error("Prompt Palette: failed to load editor stylesheets", error);
  throw error;
});
