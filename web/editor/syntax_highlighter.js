import { createDomRangeForOffsets } from "./editor_surface.js";

function supportsNativeHighlights(editor) {
  return !!(editor?.dataset?.ppEditorSurface === "single" && globalThis.CSS?.highlights && globalThis.Highlight);
}

const BRANCH_PALETTE_COLORS = [
  "var(--wg-branch-c0, var(--wg-success, #5ec992))",
  "var(--wg-branch-c1, #5cb8f6)",
  "var(--wg-branch-c2, var(--wg-accent, #e5a653))",
  "var(--wg-branch-c3, #c389f5)",
];

function styleForDecoration(decoration) {
  if (decoration.kind === "branch-selected") {
    const color = BRANCH_PALETTE_COLORS[Math.abs(Number(decoration.branchPalette) || 0) % BRANCH_PALETTE_COLORS.length];
    return `color:color-mix(in srgb,${color} 90%,var(--wg-prompt-text,#f1eee8));background-color:color-mix(in srgb,${color} 22%,transparent);text-decoration-line:underline;text-decoration-color:${color};text-decoration-thickness:1.5px;text-shadow:0 0 0.45px currentColor;`;
  }
  if (decoration.kind === "branch-unselected") {
    return "color:color-mix(in srgb,var(--wg-prompt-text,#f1eee8) 40%,transparent);";
  }
  if (decoration.kind === "find-current") {
    return "background-color:color-mix(in srgb,var(--wg-accent,#d49a52) 56%,transparent);color:var(--wg-prompt-text,#f1eee8);text-decoration-line:underline;text-decoration-color:var(--wg-accent,#d49a52);";
  }
  if (decoration.kind === "find-match") {
    return "background-color:color-mix(in srgb,var(--wg-accent,#d49a52) 28%,transparent);color:var(--wg-prompt-text,#f1eee8);";
  }
  if (decoration.kind === "find-scope") {
    return "background-color:color-mix(in srgb,var(--wg-accent,#d49a52) 10%,transparent);";
  }
  if (decoration.kind === "wildcard" || decoration.kind === "booru") return `color:${decoration.color};text-shadow:0 0 0.35px currentColor;`;
  if (decoration.kind === "error") return "color:var(--wg-danger,#d86f70);text-decoration-line:underline;text-decoration-style:dashed;text-decoration-color:var(--wg-danger,#d86f70);";
  if (decoration.kind === "lora") return `color:${decoration.color || "var(--wg-accent)"};text-decoration-line:underline;text-decoration-style:dotted;`;
  if (decoration.kind === "conditional") return "color:var(--wg-accent,#d49a52);font-weight:600;";
  if (decoration.kind === "weight") return "color:color-mix(in srgb,var(--wg-accent,#d49a52) 82%,var(--wg-prompt-text,#f1eee8));text-shadow:0 0 0.35px currentColor;";
  if (decoration.kind === "modifier") return "color:var(--wg-success,#78b58b);text-shadow:0 0 0.35px currentColor;";
  if (decoration.kind === "bracket") return "color:var(--wg-accent,#d49a52);text-shadow:0 0 0.35px currentColor;";
  if (decoration.kind === "pipe") return "color:color-mix(in srgb,var(--wg-prompt-text,#f1eee8) 50%,transparent);";
  if (decoration.kind === "comment") return "color:var(--wg-text-faint,#8f887e);";
  return "";
}

function priorityForDecoration(decoration) {
  if (decoration.kind === "find-current") return 4;
  if (decoration.kind === "find-match") return 3;
  if (decoration.kind === "branch-selected") return 2;
  if (decoration.kind === "branch-unselected") return 1;
  if (decoration.kind === "find-scope") return 0;
  return Number.isFinite(decoration.priority) ? decoration.priority : -1;
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
        const priority = priorityForDecoration(decoration);
        const groupKey = `${priority}|${style}`;
        if (!groups.has(groupKey)) groups.set(groupKey, { style, priority, ranges: [] });
        groups.get(groupKey).ranges.push({ start, end });
      }
      const rules = [];
      let order = 0;
      for (const [, { style, priority, ranges }] of groups) {
        const name = `${prefix}-${hashStyle(style)}-${order++}`;
        const domRanges = [];
        for (const item of ranges) {
          try { domRanges.push(createDomRangeForOffsets(editor, item.start, item.end)); } catch { /* one bad range must not drop the editor */ }
        }
        if (!domRanges.length) continue;
        const highlight = new Highlight(...domRanges);
        if ("priority" in highlight) highlight.priority = priority;
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
