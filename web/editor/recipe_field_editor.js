// Attach existing Prompt Palette tools; no field-specific autocomplete or parser.
import { upgradeEditorSurface } from "./editor_surface.js";
import { createSyntaxHighlighter } from "./syntax_highlighter.js";
import { attachAutocomplete, closeAcMenu } from "./autocomplete.js";
import { openInjectMenuAtPoint, closeInjectMenu, injectState } from "./injector.js";
import { onTagColorsChanged } from "./booru_tag_colors.js";
import { createRefinementController } from "./refinement_controller.js";
import { attachEditorContextMenu } from "./context_menu.js";
import { saveEditorSelection } from "./selection_library.js";
import { loadTheme } from "./preferences.js";

export function attachRecipeFieldEditor({ node, root, input, overlay, paintSyntax, getMatches, onCommit,
  onChange, atomicEdit, getSeed, getMode, getLibrary, mapBatchPrompt, getBatchSource, onFocus, onUndo, onRedo, host, openHost, bindHover, onLibrarySaved, moveFocus, allowBatch = true,
  variationGuard, prepareBatchPrompts, projectPrompt }) {
  const surface = upgradeEditorSurface(input), editor = surface.element;
  const highlighter = createSyntaxHighlighter(editor, overlay);
  let disposed = false;
  function paint() {
    if (disposed) return;
    const result = paintSyntax(editor.value);
    if (!highlighter.render(result.decorations, editor.value)) overlay.innerHTML = result.html + "\n";
  }
  const change = () => { onChange(editor.value); paint(); };
  const acCleanup = attachAutocomplete(editor, { getMatches, onCommit, syntax: true });
  const focus = () => { if (injectState?.textarea !== editor) closeInjectMenu(); onFocus?.(editor); paint(); };
  const scroll = () => { overlay.scrollTop = editor.scrollTop; overlay.scrollLeft = editor.scrollLeft; };
  const blur = () => { if (injectState?.textarea === editor) closeInjectMenu(); };
  editor.addEventListener("input", change);
  editor.addEventListener("focus", focus);
  editor.addEventListener("blur", blur);
  editor.addEventListener("scroll", scroll);
  editor.__ppExtractSelectionToWildcard = (start, end) => saveEditorSelection(editor, start, end, { onSaved: onLibrarySaved });
  editor.__ppSaveSelectionAsList = (start, end) => saveEditorSelection(editor, start, end, { list: true, onSaved: onLibrarySaved });
  const cleanupContext = attachEditorContextMenu(editor, {
    render: change, beforeOpen: closeInjectMenu,
    promptTools: { node, getSeed, getMode, project: projectPrompt, apply: (text, start, end) => { atomicEdit(text); editor.value = text; editor.setSelectionRange(start, end); paint(); } },
    syntaxEnabled: () => loadTheme().syntaxInjectorEnabled !== false,
    tokenContext: (event, selection, handle) => {
      if (loadTheme().syntaxInjectorEnabled === false) return false;
      const hit = paintSyntax(editor.value).ranges.find(r => r.start <= selection.start && selection.start < r.end);
      if (!hit) return false;
      handle(); editor.setSelectionRange(hit.start, hit.end);
      openInjectMenuAtPoint(event.clientX, event.clientY, hit.name, editor, change, hit);
      return true;
    },
    syntaxAction: (event, selection) => openInjectMenuAtPoint(event.clientX, event.clientY, "", editor, change, selection.start === selection.end ? null : selection),
  });
  // The explicit field action opens the same existing syntax menu.
  const syntax = event => {
    closeAcMenu(); editor.focus();
    const caret = editor.selectionStart;
    const hit = paintSyntax(editor.value).ranges.find(r => r.start <= caret && r.end >= caret);
    const rect = event.currentTarget.getBoundingClientRect();
    openInjectMenuAtPoint(rect.left, rect.bottom, hit?.name || "", editor, change, hit || null);
  };
  const refinement = createRefinementController({ node, root, textarea: editor, render: change,
    atomicEdit: (text, start, end) => { atomicEdit(text); editor.value = text; editor.setSelectionRange(start, end); paint(); },
    getSeed, getMode, getLibrary, host, openHost, allowBatch, fieldOnly: true, mapBatchPrompt, getBatchSource, variationGuard, prepareBatchPrompts });
  const historyKey = event => {
    if (event.isComposing || event.keyCode === 229) return;
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === "z" || key === "y") { event.preventDefault(); event.stopPropagation(); closeAcMenu(); if (key === "y" || event.shiftKey) onRedo?.(); else onUndo?.(); }
  };
  editor.addEventListener("keydown", historyKey, true);
  const tabKey = event => {
    if (event.key === "Tab" && !event.defaultPrevented && !event.ctrlKey && !event.metaKey && moveFocus?.(event.shiftKey ? -1 : 1)) { event.preventDefault(); event.stopPropagation(); }
  };
  editor.addEventListener("keydown", tabKey);
  const hoverCleanup = bindHover?.(editor, () => paintSyntax(editor.value).ranges, true);
  const tagCleanup = onTagColorsChanged(paint);
  paint();
  return { editor, syntax, vary: () => refinement.varyAll(), varySelection: () => refinement.varySelection(), repaint: paint, cleanup() {
    disposed = true; refinement.cleanup(); acCleanup(); cleanupContext(); tagCleanup(); highlighter.clear(); surface.cleanup();
    delete editor.__ppExtractSelectionToWildcard; delete editor.__ppSaveSelectionAsList;
    if (injectState?.textarea === editor) closeInjectMenu();
    hoverCleanup?.(); editor.removeEventListener("keydown", tabKey);
    editor.removeEventListener("keydown", historyKey, true);
    editor.removeEventListener("input", change); editor.removeEventListener("focus", focus);
    editor.removeEventListener("blur", blur); editor.removeEventListener("scroll", scroll);
  } };
}
