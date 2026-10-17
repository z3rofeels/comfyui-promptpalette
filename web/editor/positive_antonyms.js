import { API } from "../prompt_palette_api.js";
import { loadTheme, saveTheme } from "./preferences.js";
import { onPromptPaletteAppearanceChanged } from "../prompt_palette_shared.js";
import { hideNativeWidget, installPositiveAntonymsState } from "../prompt_palette_compat.js";

export function positiveAntonymsEnabled(node) {
  if (node._ppPositiveAntonymsState) return node._ppPositiveAntonymsState.current();
  const value = node.widgets?.find(widget => widget.name === "positive_antonyms")?.value;
  return value === true;
}

// Already resolved/compiled material goes to the same backend projection as
// execution. Never resolve it a second time or feed the result into authored fields.
export async function projectPositiveOutput(text, enabled, { signal } = {}) {
  if (!enabled) return { resolved: text, tokenStats: null };
  return API.resolve(text, 0, "entire text as one", { signal, resolve: false, positiveAntonyms: true });
}

export function installPositiveAntonymsControl({ node, root, settingsRoot = root, onChange }) {
  const widget = node.widgets?.find(candidate => candidate.name === "positive_antonyms");
  const state = installPositiveAntonymsState(node);
  const button = root.querySelector('[data-el="btnPositiveAntonyms"]');
  const enabled = settingsRoot.querySelector('[data-el="positiveAntonymsEnabled"]');
  const shortcut = settingsRoot.querySelector('[data-el="togglePositiveAntonymsBtn"]');
  function sync() {
    if (widget) {
      widget.__ppOwnerNode = node; hideNativeWidget(widget);
    }
    const active = positiveAntonymsEnabled(node);
    if (enabled) { enabled.checked = active; enabled.disabled = !widget; }
    if (button) {
      button.hidden = loadTheme().showPositiveAntonymsBtn !== true;
      button.style.display = button.hidden ? "none" : "";
      button.disabled = !widget;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
      button.title = `Positive Antonyms: ${active ? "on" : "off"} · supported positive descriptors only; source and negatives are kept`;
    }
    if (shortcut) shortcut.checked = loadTheme().showPositiveAntonymsBtn === true;
  }
  function commit(value) {
    if (!widget) return;
    state.commit(value);
    widget.callback?.(value, node.graph?.canvas, node);
    node.graph?.setDirtyCanvas?.(true, true);
    sync();
    root.dispatchEvent(new Event("pp-output-transform-changed"));
    onChange?.();
  }
  const toggle = () => commit(!positiveAntonymsEnabled(node));
  const change = () => commit(enabled.checked);
  const visibility = () => saveTheme({ ...loadTheme(), showPositiveAntonymsBtn: shortcut.checked });
  button?.addEventListener("click", toggle);
  enabled?.addEventListener("change", change);
  shortcut?.addEventListener("change", visibility);
  const unsubscribe = onPromptPaletteAppearanceChanged(sync);
  node._ppSyncPositiveAntonyms = sync;
  sync();
  return { sync, cleanup() {
    unsubscribe();
    button?.removeEventListener("click", toggle); enabled?.removeEventListener("change", change); shortcut?.removeEventListener("change", visibility);
    if (node._ppSyncPositiveAntonyms === sync) delete node._ppSyncPositiveAntonyms;
  } };
}
