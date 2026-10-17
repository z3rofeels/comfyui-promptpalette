import { getSharedWildcardEngine } from "../engine/wildcard_engine.js";
// One editing boundary for Palette editors and native ComfyUI text widgets.
import { listPromptPaletteCommandTargets } from "../prompt_palette_command_bus.js";

export function sidebarEditingHandlers({ getEditor, useLibraryEntry, openLibraryItem }) {
  return {
    sidebarEditor: getEditor,
    sidebarUseLibraryEntry: useLibraryEntry,
    sidebarOpenLibraryItem: openLibraryItem,
    sidebarInsert(selection, text, editRange) {
      const editor = getEditor();
      if (editor !== selection.editor || editor.value !== selection.source || !editor.isConnected) throw new Error("The target prompt changed. Capture the selection again before inserting.");
      if (editor.readOnly || editor.disabled || editor.getAttribute("aria-readonly") === "true" || editor.contentEditable === "false") throw new Error("Choose an editable prompt field.");
      const next = selection.source.slice(0, selection.start) + text + selection.source.slice(selection.end);
      const start = selection.start + (editRange?.[0] ?? text.length), end = selection.start + (editRange?.[1] ?? text.length);
      editor.focus({ preventScroll: true });
      editor.__ppPromptTools.apply(next, start, end);
      editor.focus({ preventScroll: true }); editor.setSelectionRange(start, end);
      return true;
    },
  };
}

const nativeTargets = new WeakMap();
function liveTextElement(widget) {
  const editor = widget.inputEl;
  return editor?.isConnected && editor.tagName === "TEXTAREA" ? editor : null;
}
function writable(node, widget) {
  return typeof widget.value === "string" && !widget.disabled && !widget.readOnly && !widget.options?.readonly && !widget.options?.readOnly
    && !node.inputs?.some(input => input.name === widget.name && input.link != null)
    && !widget.inputEl?.readOnly && !widget.inputEl?.disabled;
}
function nativeTarget(node, widget) {
  let byWidget = nativeTargets.get(node);
  if (!byWidget) { byWidget = new WeakMap(); nativeTargets.set(node, byWidget); }
  if (byWidget.has(widget)) return byWidget.get(widget);
  function read() {
    if (!node.graph?._nodes?.includes(node) || !node.widgets?.includes(widget) || !writable(node, widget)) throw new Error("This text field was removed, connected, or made read-only. Choose another target.");
    const editor = liveTextElement(widget), source = editor ? editor.value : String(widget.value);
    return { editor, widget, source, start: editor?.selectionStart ?? source.length, end: editor?.selectionEnd ?? source.length };
  }
  const target = { node, widget, label: () => `${node.title || node.type || node.comfyClass} · #${node.id} → ${widget.name || "text"}`, handlers: {
    sidebarRequiresResolvedText: true,
    sidebarEditor: () => liveTextElement(widget),
    sidebarSelection: read,
    sidebarInsert(selection, text, editRange) {
      const now = read();
      if (selection.widget !== widget || now.source !== selection.source) throw new Error("The target text changed. Capture the selection again before inserting.");
      const next = now.source.slice(0, selection.start) + text + now.source.slice(selection.end);
      const start = selection.start + (editRange?.[0] ?? text.length), end = selection.start + (editRange?.[1] ?? text.length);
      if (now.editor) {
        const editor = now.editor;
        editor.focus({ preventScroll: true }); editor.setSelectionRange(selection.start, selection.end);
        // Native insertion preserves the browser's text undo when available.
        if (!document.execCommand?.("insertText", false, text)) {
          editor.setRangeText(text, selection.start, selection.end, "end");
          editor.dispatchEvent(new Event("input", { bubbles: true }));
        }
        editor.setSelectionRange(start, end);
      }
      // Some renderers expose only the widget. Update that same backing value and
      // callback; never manufacture a second editor or change unrelated widgets.
      if (widget.value !== next) { widget.value = next; widget.callback?.(next, node.graph?.canvas, node); }
      node.graph?.setDirtyCanvas?.(true, true);
      return true;
    },
    focusEditor: () => { const editor = liveTextElement(widget); if (!editor) throw new Error("Open this node’s text editor on the canvas first."); editor.focus({ preventScroll: true }); },
  } };
  byWidget.set(widget, target); return target;
}

export function sidebarTargets(graph) {
  const managed = listPromptPaletteCommandTargets(graph).filter(t => t.handlers.sidebarEditor);
  const managedNodes = new Set(managed.map(t => t.node));
  const others = [];
  for (const node of graph?._nodes || []) {
    // Palette custom surfaces register their authoritative editor themselves.
    if (managedNodes.has(node) || /^PromptPalette/.test(node.comfyClass || node.type || "")) continue;
    for (const widget of node.widgets || []) {
      const textWidget = widget.inputEl?.tagName === "TEXTAREA" || widget.options?.multiline === true
        || ["customtext", "text", "string"].includes(String(widget.type).toLowerCase());
      if (textWidget && writable(node, widget)) others.push(nativeTarget(node, widget));
    }
  }
  return [...managed, ...others];
}

export function sidebarTextNeedsResolution(text) {
  return getSharedWildcardEngine().parse(text).lines.some(line => line.parsed.segments.some(segment => ["wildcard", "variable", "conditional", "bracket", "comment"].includes(segment.type)));
}
