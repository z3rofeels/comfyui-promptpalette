// Attach the existing prompt menus to native library textareas. Keep native
// selection and undo, and never resolve or rewrite the saved option lines.
import { attachAutocomplete, getBooruAutocompleteMatches, getCaretCoords, closeAcMenu, acState, findWildcardFragment, shouldOpenBooruAutocomplete } from "./autocomplete.js";
import { libraryAcRows, recentAcRows, mergeUnifiedRows, rankLibraryPaths } from "./autocomplete_sources.js";
import { createPromptUsageStore } from "../prompt_quickness.js";
import { loadTheme, loadPinned } from "./preferences.js";
import { tagSearch } from "./tag_search.js";
import { openInjectMenuAtPoint, closeInjectMenu, injectState } from "./injector.js";
import { attachEditorContextMenu, shortcutHint } from "./context_menu.js";
import { closePromptToolsFor } from "./prompt_tools_panel.js";

export function attachLibraryEditPromptTools({ drawer, el, getLibrary, getMatches, onCommit, applyText }) {
  const content = el("editContent"), findBar = el("editFindBar"), find = el("editFind");
  const suggest = el("editSuggest"), syntax = el("editSyntaxTool"), expand = el("editExpand"), findToggle = el("editFindToggle");
  const usage = createPromptUsageStore(), listeners = [];
  const on = (target, type, fn) => { target.addEventListener(type, fn); listeners.push(() => target.removeEventListener(type, fn)); };
  let library = null, paths = new Set(), matches = [], match = -1;
  const editable = () => !content.disabled && !content.readOnly;
  const change = () => content.dispatchEvent(new Event("input", { bubbles: true }));
  const commit = onCommit || (item => {
    if (item?.kind === "booru" || item?.kind === "custom") usage.recordTag(item.value, item.kind, item.category);
    else if (item?.value && item.kind !== "syntax") usage.recordLibrary(item.value);
  });
  async function lookup(query, kind = "wildcard") {
    const items = getLibrary() || [];
    if (items !== library) { library = items; paths = new Set(items.map(item => item.path)); }
    const theme = loadTheme(), pinned = loadPinned();
    const q = String(kind === "booru" ? tagSearch(query).query : query || "").trim().toLowerCase();
    const entries = usage.recentEntries(16);
    const recent = recentAcRows(q, { entries: kind === "booru" ? entries : entries.filter(item => item.kind === "library"), pinned, theme, contextKind: kind, isLibraryPath: path => paths.has(path) });
    const rows = libraryAcRows(q, { rankedPaths: rankLibraryPaths(items, q), pinned, theme,
      excludePaths: new Set(recent.filter(item => item.insertMode === "library").map(item => item.value)) });
    return kind === "booru" ? mergeUnifiedRows(await getBooruAutocompleteMatches(query), [...recent, ...rows]) : [...recent, ...rows];
  }
  const autocompleteCleanup = attachAutocomplete(content, { getMatches: getMatches || lookup, onCommit: commit, syntax: true });
  function openSyntax(event) {
    if (!editable() || loadTheme().syntaxInjectorEnabled === false) return;
    closeAcMenu();
    const rect = event.currentTarget.getBoundingClientRect();
    content.focus({ preventScroll: true });
    openInjectMenuAtPoint(rect.left, rect.bottom, "", content, change,
      content.selectionEnd > content.selectionStart ? { start: content.selectionStart, end: content.selectionEnd } : null);
  }
  const contextCleanup = attachEditorContextMenu(content, {
    render: change, beforeOpen: closeInjectMenu,
    syntaxEnabled: () => editable() && loadTheme().syntaxInjectorEnabled !== false,
    syntaxAction: (event, selection) => {
      if (editable()) openInjectMenuAtPoint(event.clientX, event.clientY, "", content, change, selection.start === selection.end ? null : selection);
    },
    promptTools: { apply: (text, start, end) => { if (editable()) applyText(text, start, end); } },
  });
  function refreshCaret() {
    const start = content.selectionStart, end = content.selectionEnd;
    const before = content.value.slice(0, start), line = before.split("\n").length;
    el("editCaret").textContent = `Line ${line.toLocaleString()} · Col ${(start - before.lastIndexOf("\n")).toLocaleString()}${end > start ? ` · ${(end - start).toLocaleString()} selected` : ""}`;
  }
  function scan() {
    matches = []; match = -1;
    const query = find.value;
    if (query) {
      const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
      for (const hit of content.value.matchAll(pattern)) matches.push({ start: hit.index, end: hit.index + hit[0].length });
    }
    el("editFindCount").textContent = query ? `${matches.length.toLocaleString()} matches` : "";
    el("editFindPrev").disabled = el("editFindNext").disabled = !matches.length;
  }
  function go(direction) {
    if (!matches.length) return;
    if (match < 0) {
      match = direction > 0 ? matches.findIndex(hit => hit.start >= content.selectionEnd) : matches.findLastIndex(hit => hit.start < content.selectionStart);
      if (match < 0) match = direction > 0 ? 0 : matches.length - 1;
    } else match = (match + direction + matches.length) % matches.length;
    content.focus({ preventScroll: true });
    content.setSelectionRange(matches[match].start, matches[match].end);
    const caret = getCaretCoords(content, matches[match].start), rect = content.getBoundingClientRect();
    content.scrollTop += caret.top - rect.top - rect.height / 2;
    el("editFindCount").textContent = `${(match + 1).toLocaleString()} / ${matches.length.toLocaleString()}`;
    refreshCaret();
  }
  function toggleFind(open) {
    findBar.hidden = !open; findToggle.setAttribute("aria-expanded", String(open));
    if (open) {
      const selected = content.value.slice(content.selectionStart, content.selectionEnd);
      if (selected && !selected.includes("\n")) find.value = selected;
      scan(); find.focus(); find.select();
    } else content.focus({ preventScroll: true });
  }
  on(suggest, "click", () => {
    if (!editable()) return;
    content.focus({ preventScroll: true });
    const fragment = findWildcardFragment(content.value, content.selectionStart);
    if (content.selectionEnd > content.selectionStart || (fragment?.kind === "booru" && !shouldOpenBooruAutocomplete(fragment, { onDemand: true }))) {
      el("editStatus").textContent = content.selectionEnd > content.selectionStart
        ? "Place the cursor where you want suggestions, or choose Syntax to wrap your selection."
        : "Tag suggestions are off. Enable Booru / custom word autocomplete in Prompt Palette settings.";
      return;
    }
    content.dispatchEvent(new KeyboardEvent("keydown", { key: " ", code: "Space", ctrlKey: true, bubbles: true, cancelable: true }));
  });
  on(syntax, "click", openSyntax);
  on(findToggle, "click", () => toggleFind(findBar.hidden));
  on(el("editFindClose"), "click", () => toggleFind(false));
  on(find, "input", scan);
  on(el("editFindPrev"), "click", () => go(-1));
  on(el("editFindNext"), "click", () => go(1));
  on(find, "keydown", event => {
    if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); go(event.shiftKey ? -1 : 1); }
  });
  on(drawer, "keydown", event => {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "f") {
      event.preventDefault(); event.stopPropagation(); toggleFind(true);
    } else if (event.key === "Escape" && !findBar.hidden) {
      event.preventDefault(); event.stopPropagation(); toggleFind(false);
    }
  });
  on(expand, "click", () => {
    const expanded = drawer.classList.toggle("pp-ledit-expanded");
    expand.setAttribute("aria-pressed", String(expanded)); expand.textContent = expanded ? "Restore" : "Expand";
    content.focus({ preventScroll: true });
  });
  for (const type of ["click", "keyup", "select", "focus"]) on(content, type, refreshCaret);
  on(content, "input", () => { refreshCaret(); if (!findBar.hidden) scan(); });
  for (const element of drawer.querySelectorAll("[title]")) element.title = shortcutHint(element.title);
  const suspend = () => {
    closePromptToolsFor(content);
    if (acState?.textarea === content) closeAcMenu();
    if (injectState?.textarea === content) closeInjectMenu();
    if (document.activeElement === content) content.blur();
  };
  return {
    suspend,
    refresh() {
      suggest.disabled = !editable(); syntax.disabled = !editable() || loadTheme().syntaxInjectorEnabled === false;
      refreshCaret(); if (!findBar.hidden) scan();
    },
    cleanup() { suspend(); autocompleteCleanup(); contextCleanup(); listeners.forEach(fn => fn()); },
  };
}
