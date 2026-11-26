import { parsePrompt } from "../engine/wildcard_engine.js";
import { loraAt, loraChoiceAt, loraModeExpression, formatLoraTag } from "../engine/lora_tags.js";
import { escapeHtml } from "./text_utils.js";
import { isComfyQueueShortcut } from "../editor_shortcuts.js";
import { copyPromptPaletteThemeScope, svgIcon } from "../prompt_palette_shared.js";
import { runTextareaEditCommand, openInjectMenuAtPoint, closeInjectMenu, injectState } from "./injector.js";
import { closeAcMenu } from "./autocomplete.js";
import { editorOffsetAtPoint } from "./editor_hover.js";
import { notify } from "./notifications.js";
import { openPromptTools, closePromptToolsFor, canBuildPromptRules } from "./prompt_tools_panel.js";
import { loadTheme } from "./preferences.js";
import { findQuickSwapTokenAt, openTokenQuickSwap, closeTokenQuickSwap, attachTokenQuickSwap } from "./token_quick_swap.js";
import { openPromptHygieneModal, closePromptHygieneModal } from "./prompt_hygiene.js";

let ctxMenu = null;
let ctxMenuOpen = false;
let ctxMenuEditor = null;
let ctxMenuFocus = null;
let ctxMenuIndex = -1;
function handleContextDocumentMouseDown(event) {
  if (ctxMenuOpen && !ctxMenu?.contains(event.target)) closeCtxMenu();
}
function handleContextViewportChange(event) {
  if (ctxMenuOpen && !(event.target instanceof Node && ctxMenu?.contains(event.target))) closeCtxMenu();
}

const MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || "");
export const shortcutHint = (keys) => MAC ? keys.replace(/Ctrl\+/g, "\u2318").replace(/Shift\+/g, "\u21e7") : keys;
let typeahead = "", typeaheadTimer = null;
const menuItems = () => ctxMenu ? [...ctxMenu.querySelectorAll(":scope > .wg-ctx-item")] : [];
function activateRow(index, { focus = true } = {}) {
  const rows = menuItems();
  ctxMenuIndex = index;
  rows.forEach((row, i) => { row.tabIndex = i === index ? 0 : -1; row.classList.toggle("active", i === index); });
  if (focus && rows[index]) { rows[index].focus({ preventScroll: true }); rows[index].scrollIntoView({ block: "nearest" }); }
}
function stepRow(from, delta) {
  const rows = menuItems(); if (!rows.length) return -1;
  let index = from;
  for (let n = 0; n < rows.length; n++) {
    index = index < 0 ? (delta > 0 ? 0 : rows.length - 1) : (index + delta + rows.length) % rows.length;
    if (rows[index].getAttribute("aria-disabled") !== "true") return index;
  }
  return -1;
}
function handleContextKeyDown(event) {
  if (!ctxMenuOpen) return;
  if (event.isComposing || event.keyCode === 229) return;
  if (isComfyQueueShortcut(event)) { closeCtxMenu(); return; }
  const printable = event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && event.key !== " ";
  if (!printable && !["ArrowDown", "ArrowUp", "Home", "End", "Enter", " ", "Escape", "Tab"].includes(event.key)) return;
  if (event.key === "Tab") { closeCtxMenu(); return; }
  event.preventDefault(); event.stopImmediatePropagation();
  if (event.key === "Escape") { closeCtxMenu(); return; }
  const rows = menuItems();
  if (event.key === "Enter" || event.key === " ") { rows[ctxMenuIndex]?.click(); return; }
  if (printable) {
    // Type-ahead: jump to the next enabled action whose label starts with the typed text.
    typeahead += event.key.toLowerCase(); clearTimeout(typeaheadTimer); typeaheadTimer = setTimeout(() => { typeahead = ""; }, 700);
    const ordered = [...rows.keys()].map(i => (Math.max(ctxMenuIndex, -1) + 1 + i) % rows.length);
    const hit = ordered.find(i => rows[i].getAttribute("aria-disabled") !== "true" && rows[i].textContent.trim().toLowerCase().startsWith(typeahead));
    if (hit !== undefined) activateRow(hit);
    return;
  }
  if (event.key === "Home") activateRow(stepRow(rows.length - 1, 1));
  else if (event.key === "End") activateRow(stepRow(0, -1));
  else activateRow(stepRow(ctxMenuIndex, event.key === "ArrowDown" ? 1 : -1));
}

function ensureCtxMenu() {
  if (ctxMenu) return ctxMenu;
  ctxMenu = document.createElement("div");
  ctxMenu.className = "wg-ctx-menu wg-root";
  ctxMenu.dataset.promptPaletteGlobal = "true";
  ctxMenu.setAttribute("role", "menu");
  ctxMenu.setAttribute("aria-label", "Prompt actions");
  document.body.appendChild(ctxMenu);

  document.addEventListener("mousedown", handleContextDocumentMouseDown);
  document.addEventListener("contextmenu", handleContextDocumentMouseDown);
  document.addEventListener("keydown", handleContextKeyDown, true);
  document.addEventListener("scroll", handleContextViewportChange, true);
  window.addEventListener("resize", handleContextViewportChange);
  return ctxMenu;
}

function openCtxMenu(x, y, actions, { scope: ownerScope = null } = {}) {
  x = Number.isFinite(x) ? x : 0;
  y = Number.isFinite(y) ? y : 0;
  // Keep each section contiguous and retain its caller's priority. Repeated
  // labels within one section should never create duplicate actions.
  const groups = new Map(), seen = new Set();
  for (const action of actions) {
    if (!action?.label || typeof action.onSelect !== "function") continue;
    const group = action.group || "";
    const key = `${group}:${action.label.trim().toLocaleLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(action);
  }
  actions = [...groups.values()].flat();
  const sectionLabels = { swap: "Quick swap", insert: "Insert", edit: "Text editing", item: "Library entry", thumb: "Thumbnail", nav: "Navigation", folder: "Folders", order: "Folder order", visibility: "Visibility", selection: "Selection", source: "Import", hygiene: "Prompt hygiene", tools: "Prompt tools", fix: "Repair reference", find: "Find entry", lora: "LoRA", audition: "Audition", appearance: "Appearance", "lora-strength": "LoRA strengths", "lora-vary": "LoRA variations", clipboard: "Clipboard", explore: "Explore", favorite: "Favorites" };
  ctxMenuEditor = null;
  const menu = ensureCtxMenu();
  menu.classList.toggle("pp-lora-context", actions.some(action => action.group === "lora" || action.group === "audition" || action.group?.startsWith("lora-")));
  ctxMenuFocus = document.activeElement;
  ctxMenuIndex = -1; typeahead = "";
  const hit = document.elementFromPoint?.(x, y);
  const scope = ownerScope || hit?.closest?.(".wg-root, .wg-node, .pp-node, .ppwc-surface") || document.activeElement?.closest?.(".wg-root, .wg-node, .pp-node, .ppwc-surface");
  if (scope) copyPromptPaletteThemeScope(scope, menu);
  menu.classList.toggle("wg-high-contrast", !!scope?.classList?.contains("wg-high-contrast"));
  // Actions may add optional presentation fields: group (section break), icon,
  // hint (shortcut), danger and disabled. Callers that pass only label/onSelect
  // keep working and render as a single section.
  let previousGroup = null;
  menu.innerHTML = actions.map((a, i) => {
    const group = a.group || "";
    const sep = i && group !== previousGroup ? '<div class="wg-ctx-sep" role="separator"></div>' : "";
    const heading = group !== previousGroup && groups.size > 1 && sectionLabels[group]
      ? `<div class="wg-ctx-heading" role="presentation">${escapeHtml(sectionLabels[group])}</div>` : "";
    previousGroup = group;
    const hint = a.hint ? shortcutHint(a.hint) : "";
    return `${sep}${heading}<div class="wg-ctx-item${a.danger ? " danger" : ""}" role="menuitem" tabindex="-1" data-index="${i}"` +
      `${a.disabled ? ' aria-disabled="true"' : ""}${hint ? ` data-hint="${escapeHtml(hint)}" aria-keyshortcuts="${escapeHtml(hint)}"` : ""}>` +
      `<span class="wg-ctx-icon" aria-hidden="true">${a.icon ? svgIcon(a.icon, 14) : ""}</span>` +
      `<span class="wg-ctx-label">${escapeHtml(a.label)}</span></div>`;
  }).join("");
  menuItems().forEach((row) => {
    const i = Number(row.dataset.index);
    row.addEventListener("mouseenter", () => { if (row.getAttribute("aria-disabled") !== "true") activateRow(menuItems().indexOf(row), { focus: false }); });
    // A portal must not move focus or replace the editor's live selection before
    // the action runs. This works for native textareas and the shared DOM editor.
    row.addEventListener("mousedown", event => { event.preventDefault(); event.stopPropagation(); });
    row.addEventListener("click", (event) => {
      // The menu lives under document.body rather than inside the node. Keep this
      // click inside Prompt Palette so node-level actions (notably Recipe Builder)
      // are not immediately closed again by the editor's outside-click handler.
      event.preventDefault();
      event.stopPropagation();
      if (row.getAttribute("aria-disabled") === "true") return;
      closeCtxMenu();
      const failed = error => notify("error", "Editor action failed", error?.message || String(error));
      // File dialogs and clipboard APIs must start inside this user gesture.
      try { Promise.resolve(actions[i].onSelect()).catch(failed); }
      catch (error) { failed(error); }
    });
  });
  // Measure at the origin so a previous edge position cannot shrink-wrap the
  // menu narrower, then open toward the side with room instead of covering the
  // pointer (and the text under it).
  menu.style.left = "0px"; menu.style.top = "0px";
  menu.style.display = "block";
  menu.scrollTop = 0;
  ctxMenuOpen = true;

  const pad = 8;
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  const vw = window.innerWidth, vh = window.innerHeight;
  const left = x + mw + pad > vw && x - mw >= pad ? x - mw : x;
  const top = y + mh + pad > vh && y - mh >= pad ? y - mh : y;
  menu.style.left = Math.max(pad, Math.min(left, vw - mw - pad)) + "px";
  menu.style.top = Math.max(pad, Math.min(top, vh - mh - pad)) + "px";
}

function closeCtxMenu() {
  ctxMenuEditor = null;
  if (!ctxMenu) return;
  const focusedInside = ctxMenu.contains(document.activeElement);
  ctxMenu.style.display = "none";
  ctxMenuOpen = false;
  // Arrow navigation focuses the menu without touching the saved editor range.
  if (focusedInside && ctxMenuFocus?.isConnected) ctxMenuFocus.focus?.({ preventScroll: true });
  ctxMenuFocus = null;
  ctxMenuIndex = -1;
}



export function cleanupContextMenu() {
  closeCtxMenu();
  closeTokenQuickSwap({ restoreFocus: false });
  closePromptHygieneModal();
  document.removeEventListener("mousedown", handleContextDocumentMouseDown);
  document.removeEventListener("contextmenu", handleContextDocumentMouseDown);
  document.removeEventListener("keydown", handleContextKeyDown, true);
  document.removeEventListener("scroll", handleContextViewportChange, true);
  window.removeEventListener("resize", handleContextViewportChange);
  ctxMenu?.remove();
  ctxMenu = null;
}

// Keep the secondary-button gesture inside the DOM library in both renderers.
// Capture handles nested image/row controls before a widget swallows the event;
// stopping the down events keeps the classic canvas from starting its own action.
export function attachLibraryContextMenu(target, openMenu, matches = () => true) {
  const stopSecondary = event => { if (event.button === 2 && matches(event)) event.stopPropagation(); };
  const onContextMenu = event => {
    if (!matches(event)) return;
    event.preventDefault(); event.stopPropagation();
    openMenu(event);
  };
  target.addEventListener("pointerdown", stopSecondary, true);
  target.addEventListener("mousedown", stopSecondary, true);
  target.addEventListener("contextmenu", onContextMenu, true);
  return () => {
    target.removeEventListener("pointerdown", stopSecondary, true);
    target.removeEventListener("mousedown", stopSecondary, true);
    target.removeEventListener("contextmenu", onContextMenu, true);
  };
}

export function contextWildcardAtPoint(editor, event, selection, ranges = []) {
  // Parse the current source using the shared engine, not asynchronously painted
  // ranges. This also keeps comments and literal JSON out of syntax actions.
  const tokens = parsePrompt(editor.value).wildcards;
  const rect = editor.getBoundingClientRect();
  const inside = rect.width > 0 && rect.height > 0 && event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
  const offset = inside ? editorOffsetAtPoint(editor, event.clientX, event.clientY) : -1;
  const caret = offset >= 0 ? offset : selection.start;
  // A caret is an insertion boundary: the right half of the closing underscore
  // can resolve to the token's end. Prefer the next token when they are adjacent.
  const token = tokens.find(range => range.start <= caret && caret < range.end)
    || tokens.find(range => range.end === caret);
  if (!token) return null;
  const withinSelection = offset < 0 || (caret >= selection.start && caret <= selection.end);
  if (withinSelection && selection.end > selection.start && (selection.start < token.start || selection.end > token.end)) return null;
  const painted = ranges.find(range => range.name === token.name);
  return { ...token, known: painted?.known };
}

export function attachEditorContextMenu(editor, {
  render = () => {}, beforeOpen = () => {}, tokenContext = null,
  selectionActions = () => [], syntaxAction = null, syntaxEnabled = () => true,
  findAction = null,
  promptTools = {},
} = {}) {
  editor.__ppPromptTools = promptTools;
  const cleanupQuickSwap = attachTokenQuickSwap(editor, { applyEdit: promptTools.apply });
  const originalTitle = editor.getAttribute("title");
  editor.title = [originalTitle, "Right-click: Prompt Palette actions and wildcard modes. Alt/Option + Click: peek or swap wildcard/choice token. Alt/Option + right-click: spelling and browser editing."].filter(Boolean).join("\n");
  const onContextMenu = event => {
    // Browsers expose no portable way to ask whether the clicked word is misspelled.
    // Keep Palette's established gesture; the alternate opens only native tools.
    if (event.altKey) {
      event.stopPropagation();
      closeAcMenu(); closeCtxMenu(); closeInjectMenu(); beforeOpen();
      return;
    }
    const snapshot = { source: editor.value, start: editor.selectionStart, end: editor.selectionEnd, direction: editor.selectionDirection };
    const pointerOffset = event.clientX || event.clientY ? editorOffsetAtPoint(editor, event.clientX, event.clientY) : -1;
    // Retain an intentional selection when clicked inside it. A click elsewhere
    // addresses that location rather than a stale selection in another passage.
    if (pointerOffset >= 0 && (pointerOffset < snapshot.start || pointerOffset > snapshot.end)) {
      snapshot.start = snapshot.end = pointerOffset;
      snapshot.direction = "none";
    }
    const editable = !editor.readOnly && !editor.disabled && editor.getAttribute("contenteditable") !== "false";
    const selected = snapshot.end > snapshot.start;
    const hasText = selected && snapshot.source.slice(snapshot.start, snapshot.end).trim();
    const handle = () => { event.preventDefault(); event.stopPropagation(); closeAcMenu(); closeCtxMenu(); beforeOpen(); };
    const restore = () => {
      if (!editor.isConnected) return false;
      if (editor.value !== snapshot.source) { notify("info", "Prompt changed", "Select the text again to apply this action."); return false; }
      editor.focus({ preventScroll: true });
      editor.setSelectionRange(snapshot.start, snapshot.end, snapshot.direction);
      return true;
    };
    let lora = loraAt(editor.value, pointerOffset >= 0 ? pointerOffset : snapshot.start);
    if (lora && selected && (snapshot.start < lora.start || snapshot.end > lora.end)) lora = null;
    if (tokenContext?.(event, snapshot, handle)) { if (ctxMenuOpen) ctxMenuEditor = editor; return; }
    if (editable && syntaxEnabled()) {
      const wildcard = contextWildcardAtPoint(editor, event, snapshot);
      if (wildcard) {
        handle(); closeInjectMenu();
        editor.setSelectionRange(wildcard.start, wildcard.end);
        openInjectMenuAtPoint(event.clientX, event.clientY, wildcard.name, editor, render, wildcard);
        return;
      }
    }
    handle(); closeInjectMenu(); closeTokenQuickSwap({ restoreFocus: false });
    const action = (label, fn, meta = {}) => ({ ...meta, label, onSelect: () => { if (restore()) return fn(); } });
    const swapTarget = editable ? findQuickSwapTokenAt(editor.value, pointerOffset >= 0 ? pointerOffset : snapshot.start) : null;
    const actions = [
      ...(swapTarget ? [action("Peek / swap token\u2026", () => openTokenQuickSwap(editor, { offset: swapTarget.start, anchorPoint: { x: event.clientX, y: event.clientY }, applyEdit: promptTools.apply }), { icon: "dice", hint: "Alt+Click", group: "swap" })] : []),
      ...(selected ? [action("Cut", () => runTextareaEditCommand(editor, render, "cut"), { disabled: !editable, icon: "cut", hint: "Ctrl+X", group: "edit" }), action("Copy", () => runTextareaEditCommand(editor, render, "copy"), { icon: "copy", hint: "Ctrl+C", group: "edit" })] : []),
      action("Paste", () => runTextareaEditCommand(editor, render, "paste"), { disabled: !editable, icon: "paste", hint: "Ctrl+V", group: "edit" }),
      ...(selected ? [action("Delete", () => runTextareaEditCommand(editor, render, "delete"), { disabled: !editable, icon: "trash", hint: "Del", group: "edit", danger: true })] : []),
      action("Select All", () => runTextareaEditCommand(editor, render, "selectAll"), { icon: "select", hint: "Ctrl+A", group: "edit" }),
      ...(typeof findAction === "function" ? [
        action("Find & replace\u2026", () => findAction({ replace: true, inSelection: selected ? true : null }), { icon: "search", hint: "Ctrl+H", group: "edit" }),
      ] : []),
      ...(promptTools.node?._ppOpenImageImport ? [action("Import prompt from image…", () => promptTools.node._ppOpenImageImport(), { icon: "image", group: "source" })] : []),
    ];
    if (hasText && editable) {
      if (editor.__ppExtractSelectionToWildcard) actions.push(action("Save selection to My Library\u2026", () => editor.__ppExtractSelectionToWildcard(snapshot.start, snapshot.end), { icon: "gallery", group: "selection" }));
      if (editor.__ppSaveSelectionAsList) actions.push(action("Save selection as list\u2026", () => editor.__ppSaveSelectionAsList(snapshot.start, snapshot.end), { icon: "list", group: "selection" }));
      for (const extra of selectionActions(snapshot)) actions.push(action(extra.label, extra.onSelect, { icon: extra.icon || "branch", group: "selection" }));
    }
    if (editable && syntaxAction && syntaxEnabled()) actions.push(action("Insert syntax\u2026", () => syntaxAction(event, snapshot), { icon: "bolt", group: "tools" }));
    if (editable && syntaxEnabled() && canBuildPromptRules(editor)) actions.push(action("Build choices & rules\u2026", () => openPromptTools(editor), { icon: "recipe", group: "tools" }));
    if (editable && syntaxEnabled() && canBuildPromptRules(editor)) actions.push(action(lora ? "Edit / swap LoRA…" : "Browse LoRAs…", () => openPromptTools(editor, { tab: "loras", range: lora || snapshot }), { icon: "gallery", group: lora ? "lora" : "tools" }));
    if (editable && lora && syntaxEnabled() && canBuildPromptRules(editor)) {
      const expression = loraChoiceAt(snapshot.source, lora.start);
      const replace = (range, text) => {
        if (!canBuildPromptRules(editor)) return;
        const next = snapshot.source.slice(0, range.start) + text + snapshot.source.slice(range.end), end = range.start + text.length;
        if (promptTools.apply) promptTools.apply(next, range.start, end);
        else { editor.value = next; editor.setSelectionRange(range.start, end); editor.dispatchEvent(new Event("input", { bubbles: true })); }
      };
      actions.push(action("Local previews & trigger words…", () => openPromptTools(editor, { tab: "loras", range: lora }), { group: "lora", icon: "gallery" }));
      actions.push(action(lora.model === 0 && lora.clip === 0 ? "Enable at strength 1" : "Mute LoRA (both strengths 0)", () => replace(lora, formatLoraTag(lora, lora.model === 0 && lora.clip === 0 ? 1 : 0, lora.model === 0 && lora.clip === 0 ? 1 : 0)), { group: "lora", icon: "bolt" }));
      for (const delta of [-0.05, 0.05]) actions.push(action(`Both strengths ${delta < 0 ? "−" : "+"}0.05`, () => replace(lora, formatLoraTag(lora, lora.model + delta, lora.clip + delta)), { group: "lora-strength", icon: delta < 0 ? "minus" : "plus" }));
      for (const [channel, label] of [["model", "Model"], ["clip", "CLIP"]]) for (const delta of [-0.05, 0.05]) actions.push(action(`${label} strength ${delta < 0 ? "−" : "+"}0.05`, () => replace(lora, formatLoraTag(lora, lora.model + (channel === "model" ? delta : 0), lora.clip + (channel === "clip" ? delta : 0))), { group: "lora-strength", icon: delta < 0 ? "minus" : "plus" }));
      for (const [mode, label] of [["seeded", "Seeded strength choice"], ["cycle", "Cycle strengths · next each run"], ["previous", "Cycle strengths · previous each run"], ["random", "Random strengths each run"], ["batch", "Test all strengths · Combinatorial"]]) actions.push(action(label, () => replace(expression, loraModeExpression(expression, mode)), { group: "lora-vary", icon: "branch" }));
    }
    if (editable) {
      actions.push(action("Fix / Tidy prompt\u2026", () => openPromptHygieneModal(editor, { mode: "tidy", applyEdit: promptTools.apply }), { icon: "sparkles", group: "hygiene" }));
      actions.push(action("Adapt for model\u2026", () => openPromptHygieneModal(editor, { mode: "adapt", applyEdit: promptTools.apply }), { icon: "bolt", group: "hygiene" }));
    }
    actions.push(action("Inspect prompt\u2026", () => openPromptTools(editor, { tab: "inspect" }), { icon: "doctor", group: "tools" }));
    if (loadTheme().styleSelectorEnabled === true) {
      actions.push(action("Open Style Studio\u2026", () => {
        import("./style_selector.js").then(({ openStyleSelector }) => openStyleSelector(editor));
      }, { icon: "palette", group: "tools" }));
    }
    const groupOrder = lora ? ["swap", "lora", "lora-strength", "lora-vary", "edit", "selection", "source", "hygiene", "tools"] : ["swap", "edit", "selection", "source", "hygiene", "tools"];
    actions.sort((a, b) => groupOrder.indexOf(a.group) - groupOrder.indexOf(b.group));
    openCtxMenu(event.clientX, event.clientY, actions);
    ctxMenuEditor = editor;
  };
  const onKeydown = event => {
    if (event.key !== "Escape") return;
    if (ctxMenuEditor === editor) closeCtxMenu();
    else if (injectState?.textarea === editor) closeInjectMenu();
    else return;
    event.preventDefault(); event.stopPropagation();
  };
  editor.addEventListener("contextmenu", onContextMenu);
  editor.addEventListener("keydown", onKeydown);
  return () => {
    cleanupQuickSwap();
    closePromptToolsFor(editor);
    delete editor.__ppPromptTools;
    if (originalTitle === null) editor.removeAttribute("title"); else editor.setAttribute("title", originalTitle);
    if (ctxMenuEditor === editor) closeCtxMenu();
    if (injectState?.textarea === editor) closeInjectMenu();
    editor.removeEventListener("contextmenu", onContextMenu); editor.removeEventListener("keydown", onKeydown);
  };
}

export { openCtxMenu, closeCtxMenu, ctxMenuOpen };
