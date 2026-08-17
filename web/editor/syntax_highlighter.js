import { createDomRangeForOffsets } from "./editor_surface.js";

function supportsNativeHighlights(editor) {
  return !!(editor?.dataset?.ppEditorSurface === "single" && globalThis.CSS?.highlights && globalThis.Highlight);
}

function styleForDecoration(decoration) {
  if (decoration.kind === "wildcard") return `color:${decoration.color};text-shadow:0 0 0.35px currentColor;`;
  if (decoration.kind === "error") return "color:var(--wg-danger,#d86f70);text-decoration-line:underline;text-decoration-style:dashed;text-decoration-color:var(--wg-danger,#d86f70);";
  if (decoration.kind === "weight") return "color:color-mix(in srgb,var(--wg-accent,#d49a52) 82%,var(--wg-prompt-text,#f1eee8));text-shadow:0 0 0.35px currentColor;";
  if (decoration.kind === "modifier") return "color:var(--wg-success,#78b58b);text-shadow:0 0 0.35px currentColor;";
  if (decoration.kind === "bracket") return "color:var(--wg-accent,#d49a52);text-shadow:0 0 0.35px currentColor;";
  if (decoration.kind === "pipe") return "color:color-mix(in srgb,var(--wg-prompt-text,#f1eee8) 50%,transparent);";
  if (decoration.kind === "comment") return "color:var(--wg-text-faint,#8f887e);";
  return "";
}

function hashStyle(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function createSyntaxHighlighter(editor, fallbackLayer) {
  const native = supportsNativeHighlights(editor);
  if (!native) return { native: false, render() { return false; }, reset() {}, clear() {} };

  const prefix = String(editor.dataset.ppEditorId || "pp-editor").replace(/[^a-zA-Z0-9_-]/g, "-");
  const styleElement = document.createElement("style");
  styleElement.dataset.promptPaletteEditorHighlights = prefix;
  document.head.appendChild(styleElement);
  const registered = new Set();
  if (fallbackLayer) fallbackLayer.style.display = "none";

  function clearRegistry() {
    for (const name of registered) CSS.highlights.delete(name);
    registered.clear();
    styleElement.textContent = "";
  }

  function render(decorations = [], sourceText = editor.value) {
    try {
      clearRegistry();
      if (!sourceText || !decorations.length) return true;
      const groups = new Map();
      for (const decoration of decorations) {
        const start = Number(decoration.start);
        const end = Number(decoration.end);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || start < 0 || end > sourceText.length) continue;
        const style = styleForDecoration(decoration);
        if (!style) continue;
        if (!groups.has(style)) groups.set(style, []);
        groups.get(style).push({ start, end });
      }
      const rules = [];
      let order = 0;
      for (const [style, ranges] of groups) {
        const name = `${prefix}-${hashStyle(style)}-${order++}`;
        const domRanges = [];
        for (const item of ranges) {
          try { domRanges.push(createDomRangeForOffsets(editor, item.start, item.end)); } catch { /* one bad range must not drop the editor */ }
        }
        if (!domRanges.length) continue;
        const highlight = new Highlight(...domRanges);
        if ("priority" in highlight) highlight.priority = -1;
        CSS.highlights.set(name, highlight);
        registered.add(name);
        rules.push(`[data-pp-editor-id="${prefix}"]::highlight(${name}){${style}}`);
      }
      styleElement.textContent = rules.join("\n");
      return true;
    } catch (error) {
      console.warn("Prompt Palette: native syntax highlighting fell back to the compatibility overlay", error);
      clearRegistry();
      if (fallbackLayer) fallbackLayer.style.display = "";
      return false;
    }
  }

  return {
    native: true,
    render,
    reset() { clearRegistry(); },
    clear() {
      clearRegistry();
      styleElement.remove();
      if (fallbackLayer) fallbackLayer.style.display = "";
    },
  };
}
