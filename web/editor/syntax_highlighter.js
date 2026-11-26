import { createDomRangeResolver } from "./editor_surface.js";

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
  if (decoration.kind === "chunk-boundary") {
    return "background-color:color-mix(in srgb,var(--wg-warning,var(--wg-accent,#e5a653)) 24%,transparent);text-decoration-line:underline overline;text-decoration-style:dotted;text-decoration-color:var(--wg-warning,var(--wg-accent,#e5a653));text-decoration-thickness:1.5px;";
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
  if (decoration.kind === "chunk-boundary") return 3;
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
  let lastTextNode = editor.firstChild || null;
  let lastSource = "";
  let lastDecorations = null;
  let pendingFrame = 0;
  let needsFrameRepaint = false;
  if (fallbackLayer) fallbackLayer.style.display = "none";

  function cancelPendingFrame() {
    if (pendingFrame && typeof globalThis.cancelAnimationFrame === "function") {
      globalThis.cancelAnimationFrame(pendingFrame);
    }
    pendingFrame = 0;
  }

  function clearRegistry() {
    for (const name of registered) CSS.highlights.delete(name);
    registered.clear();
    if (styleElement.textContent) styleElement.textContent = "";
  }

  function resetState() {
    cancelPendingFrame();
    clearRegistry();
    lastTextNode = null;
    lastSource = "";
    lastDecorations = null;
    needsFrameRepaint = false;
  }

  function applyHighlights(decorations, sourceText) {
    const rangeForOffsets = createDomRangeResolver(editor);
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
    const pending = [];
    const nextRegistered = new Set();
    let order = 0;
    for (const [, { style, priority, ranges }] of groups) {
      const name = `${prefix}-${hashStyle(style)}-${order++}`;
      const domRanges = [];
      for (const item of ranges) {
        try { domRanges.push(rangeForOffsets(item.start, item.end)); } catch { /* one bad range must not drop the editor */ }
      }
      if (!domRanges.length) continue;
      const highlight = new Highlight(...domRanges);
      if ("priority" in highlight) highlight.priority = priority;
      pending.push({ name, highlight });
      nextRegistered.add(name);
      rules.push(`[data-pp-editor-id="${prefix}"]::highlight(${name}){${style}}`);
    }
    for (const name of registered) {
      if (!nextRegistered.has(name)) { CSS.highlights.delete(name); registered.delete(name); }
    }
    const css = rules.join("\n");
    // Ensure ::highlight() CSS rules exist before registering Highlight instances.
    if (styleElement.textContent !== css) styleElement.textContent = css;
    for (const { name, highlight } of pending) {
      if (registered.has(name) || CSS.highlights.has?.(name)) CSS.highlights.delete(name);
      CSS.highlights.set(name, highlight);
      registered.add(name);
    }
    return pending.length > 0;
  }

  function render(decorations = [], sourceText = editor.value, options = {}) {
    cancelPendingFrame();
    let mergedDecorations = decorations;
    const rawOffsets = Array.isArray(options?.chunkBoundaryOffsets)
      ? options.chunkBoundaryOffsets
      : Number.isFinite(options?.chunkBoundaryOffset) && options.chunkBoundaryOffset > 0
      ? [options.chunkBoundaryOffset]
      : [];
    if (rawOffsets.length && sourceText) {
      const extra = [];
      for (const item of rawOffsets) {
        if (item && typeof item === "object" && Number.isFinite(item.start) && Number.isFinite(item.end)) {
          extra.push({ start: item.start, end: item.end, kind: "chunk-boundary" });
        } else if (Number.isFinite(item)) {
          const pos = Math.max(0, Math.min(sourceText.length - 1, Math.trunc(item)));
          if (sourceText.length > 0) extra.push({ start: pos, end: Math.min(sourceText.length, pos + 1), kind: "chunk-boundary" });
        }
      }
      if (extra.length) mergedDecorations = [...decorations, ...extra];
    }
    try {
      if (!sourceText || !mergedDecorations.length) {
        clearRegistry();
        lastTextNode = editor.firstChild || null;
        lastSource = String(sourceText || "");
        lastDecorations = null;
        needsFrameRepaint = false;
        return true;
      }
      if (editor.firstChild !== lastTextNode) needsFrameRepaint = true;
      const applied = applyHighlights(mergedDecorations, sourceText);
      lastTextNode = editor.firstChild || null;
      lastSource = sourceText;
      lastDecorations = mergedDecorations;
      if (needsFrameRepaint && applied && typeof globalThis.requestAnimationFrame === "function") {
        // Re-register fresh DOM ranges on the next frame after programmatic text-node
        // replacement so Chromium/Electron invalidates ::highlight() without waiting for blur.
        pendingFrame = globalThis.requestAnimationFrame(() => {
          pendingFrame = 0;
          needsFrameRepaint = false;
          if (!editor.isConnected || editor.value !== sourceText || lastDecorations !== mergedDecorations) return;
          try {
            applyHighlights(mergedDecorations, sourceText);
            lastTextNode = editor.firstChild || null;
          } catch { /* ignore stale frame if editor mutated concurrently */ }
        });
      } else {
        needsFrameRepaint = false;
      }
      if (fallbackLayer) fallbackLayer.style.display = "none";
      return true;
    } catch (error) {
      console.warn("Prompt Palette: native syntax highlighting fell back to the compatibility overlay", error);
      resetState();
      if (fallbackLayer) fallbackLayer.style.display = "";
      return false;
    }
  }

  return {
    native: true,
    render,
    reset() { resetState(); },
    clear() {
      resetState();
      styleElement.remove();
      if (fallbackLayer) fallbackLayer.style.display = "";
    },
  };
}

const LORA_SKIP_RE = /<lora:[^:<>\r\n]+>/gi;
const WEIGHT_SUFFIX_SKIP_RE = /:[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?=\))/g;

export function estimateChunkBoundaryOffsets(sourceText, { tokensPerChunk = 75, exactTotalTokens = null } = {}) {
  const text = String(sourceText || "");
  if (!text.trim() || tokensPerChunk <= 0) return [];
  // Mask comments, LoRAs, and numeric weight suffixes so chunk markers track prompt content
  const masked = text
    .split("\n")
    .map((ln) => (/^\s*#/.test(ln) ? " ".repeat(ln.length) : ln))
    .join("\n")
    .replace(LORA_SKIP_RE, (m) => " ".repeat(m.length))
    .replace(WEIGHT_SUFFIX_SKIP_RE, (m) => " ".repeat(m.length));

  const units = [];
  const tokenPattern = /[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;
  for (const m of masked.matchAll(tokenPattern)) {
    const raw = m[0];
    if (raw === "(" || raw === ")") continue;
    const isWord = /[\p{L}\p{N}_]/u.test(raw);
    const weight = isWord ? Math.max(1, Math.ceil(raw.length / 6)) * 1.08 : 0.85;
    units.push({ start: m.index ?? 0, end: (m.index ?? 0) + raw.length, cost: weight });
  }
  if (!units.length) return [];

  const rawTotal = units.reduce((sum, u) => sum + u.cost, 0);
  const scale = Number.isFinite(exactTotalTokens) && exactTotalTokens > 0 && rawTotal > 0
    ? exactTotalTokens / rawTotal
    : 1;
  const effectiveTotal = rawTotal * scale;
  if (effectiveTotal <= tokensPerChunk) return [];

  const boundaries = [];
  let nextThreshold = tokensPerChunk;
  let cumulative = 0;
  let chunkIndex = 1;
  for (const u of units) {
    cumulative += u.cost * scale;
    if (cumulative >= nextThreshold && boundaries.length < 16) {
      boundaries.push({
        start: u.start,
        end: u.end,
        chunkIndex,
        kind: "chunk-boundary",
      });
      chunkIndex += 1;
      nextThreshold = chunkIndex * tokensPerChunk;
    }
  }
  return boundaries;
}
