import { getSharedWildcardEngine } from "../engine/wildcard_engine.js";
import { copyPromptPaletteThemeScope } from "../prompt_palette_shared.js";
import { escapeHtml } from "./text_utils.js";
import { createDomRangeForOffsets } from "./editor_surface.js";

function findWildcardFragment(text, caret) {
  return getSharedWildcardEngine().autocompleteContext(text, caret);
}

const AC_MIRROR_PROPS = [
  "boxSizing", "width", "fontFamily", "fontSize", "fontWeight", "fontStyle",
  "letterSpacing", "lineHeight", "paddingTop", "paddingRight", "paddingBottom",
  "paddingLeft", "borderTopWidth", "borderRightWidth", "borderBottomWidth",
  "borderLeftWidth", "textIndent", "textTransform",
];
let acMirrorDiv = null;
function getCaretCoords(textarea, index) {
  if (textarea?.dataset?.ppEditorSurface === "single") {
    const computed = getComputedStyle(textarea);
    const lineHeight = parseFloat(computed.lineHeight) || 18;
    try {
      const range = createDomRangeForOffsets(textarea, index, index);
      let rect = range.getBoundingClientRect();
      if ((!rect || (!rect.width && !rect.height)) && index > 0) {
        const previous = createDomRangeForOffsets(textarea, index - 1, index);
        const previousRect = previous.getBoundingClientRect();
        rect = { top: previousRect.top, left: previousRect.right, height: previousRect.height, width: 0 };
      }
      if (rect && (rect.height || rect.width)) return { top: rect.top, left: rect.left, lineHeight: rect.height || lineHeight };
    } catch { /* fall through to the compatibility mirror */ }
  }
  if (!acMirrorDiv) {
    acMirrorDiv = document.createElement("div");
    acMirrorDiv.style.position = "absolute";
    acMirrorDiv.style.visibility = "hidden";
    acMirrorDiv.style.whiteSpace = "pre-wrap";
    acMirrorDiv.style.wordWrap = "break-word";
    acMirrorDiv.style.top = "0px";
    acMirrorDiv.style.left = "-9999px";
    acMirrorDiv.dataset.promptPaletteGlobal = "true";
    document.body.appendChild(acMirrorDiv);
  }
  const computed = getComputedStyle(textarea);
  AC_MIRROR_PROPS.forEach(p => { acMirrorDiv.style[p] = computed[p]; });
  acMirrorDiv.style.width = computed.width;

  acMirrorDiv.textContent = textarea.value.slice(0, index);
  const marker = document.createElement("span");
  marker.textContent = textarea.value.slice(index) || ".";
  acMirrorDiv.appendChild(marker);

  const rect = textarea.getBoundingClientRect();
  const top = rect.top + marker.offsetTop + parseFloat(computed.borderTopWidth || "0") - textarea.scrollTop;
  const left = rect.left + marker.offsetLeft + parseFloat(computed.borderLeftWidth || "0") - textarea.scrollLeft;
  const lineHeight = parseFloat(computed.lineHeight) || 18;

  acMirrorDiv.removeChild(marker);
  acMirrorDiv.textContent = "";

  return { top, left, lineHeight };
}

let acMenu = null;
let acState = null;
let acRequestVersion = 0;
function handleAcDocumentMouseDown(event) {
  if (acState && !acMenu?.contains(event.target) && event.target !== acState.textarea) closeAcMenu();
}

function ensureAcMenu() {
  if (acMenu) return acMenu;
  acMenu = document.createElement("div");
  acMenu.className = "wg-ac-menu wg-root";
  acMenu.dataset.promptPaletteGlobal = "true";
  document.body.appendChild(acMenu);

  acMenu.addEventListener("mousedown", (e) => {
    const row = e.target.closest("[data-ac-index]");
    if (!row) return;
    e.preventDefault();
    commitAcSelection(Number(row.dataset.acIndex));
  });
  document.addEventListener("mousedown", handleAcDocumentMouseDown);
  return acMenu;
}

function closeAcMenu() {
  acRequestVersion += 1;
  if (!acMenu) { acState = null; return; }
  acMenu.style.display = "none";
  acState = null;
}

function normalizeAcItem(item) {
  if (typeof item === "string") return { value: item, label: item, group: "My Library", kind: "library" };
  return {
    value: String(item?.value ?? item?.label ?? ""),
    label: String(item?.label ?? item?.value ?? ""),
    group: String(item?.group || "My Library"),
    meta: String(item?.meta || ""),
    kind: String(item?.kind || "library"),
    insertText: item?.insertText == null ? null : String(item.insertText),
    selectInserted: !!item?.selectInserted,
    favorite: !!item?.favorite,
  };
}

function renderAcMenu() {
  if (!acState) return;
  const menu = ensureAcMenu();
  const scope = acState?.textarea?.closest?.(".wg-root, .wg-node, .pp-node, .ppwc-surface");
  if (scope) copyPromptPaletteThemeScope(scope, menu);
  menu.innerHTML = "";
  if (!acState.items.length) {
    const empty = document.createElement("div");
    empty.className = "wg-ac-empty";
    empty.textContent = "No matches — keep typing or open Library";
    menu.appendChild(empty);
  } else {
    let lastGroup = "";
    acState.items.forEach((rawItem, i) => {
      const item = normalizeAcItem(rawItem);
      if (item.group !== lastGroup) {
        const heading = document.createElement("div");
        heading.className = "wg-ac-group";
        heading.textContent = item.group;
        menu.appendChild(heading);
        lastGroup = item.group;
      }
      const row = document.createElement("div");
      row.className = "wg-ac-item" + (i === acState.activeIndex ? " active" : "");
      row.dataset.acIndex = String(i);
      const icon = item.kind === "starter" ? "✦" : item.favorite ? "★" : item.kind === "recent" ? "↺" : "__";
      row.innerHTML = `<span class="wg-ac-kind">${escapeHtml(icon)}</span><span class="wg-ac-copy"><strong>${escapeHtml(item.label)}</strong>${item.meta ? `<small>${escapeHtml(item.meta)}</small>` : ""}</span>`;
      menu.appendChild(row);
    });
  }
  const coords = getCaretCoords(acState.textarea, acState.end);
  const maxLeft = Math.max(8, window.innerWidth - Math.min(420, menu.offsetWidth || 360) - 8);
  menu.style.left = Math.max(8, Math.min(coords.left, maxLeft)) + "px";
  menu.style.top = Math.max(8, Math.min(coords.top + coords.lineHeight + 4, window.innerHeight - 250)) + "px";
  menu.style.display = "block";
}

async function openOrUpdateAcMenu(textarea, fragment, getMatches, onCommit) {
  const requestVersion = ++acRequestVersion;
  const query = fragment.query;
  const items = await getMatches(query);
  if (requestVersion !== acRequestVersion) return;
  const stillValid = findWildcardFragment(textarea.value, textarea.selectionStart);
  if (!stillValid || stillValid.start !== fragment.start || stillValid.end !== textarea.selectionStart || stillValid.query !== query) return;
  acState = { textarea, items, activeIndex: 0, start: stillValid.start, end: stillValid.end, modifier: stillValid.modifier || "", onCommit };
  renderAcMenu();
}

function commitAcSelection(index) {
  if (!acState) return;
  const { textarea, start, end, items, onCommit } = acState;
  const rawItem = items[index];
  if (rawItem == null) return closeAcMenu();
  const item = normalizeAcItem(rawItem);
  const replacement = item.insertText == null ? `__${acState.modifier || ""}${item.value}__` : item.insertText;
  textarea.value = textarea.value.slice(0, start) + replacement + textarea.value.slice(end);
  if (item.selectInserted) {
    textarea.selectionStart = start;
    textarea.selectionEnd = start + replacement.length;
  } else {
    const caret = start + replacement.length;
    textarea.selectionStart = textarea.selectionEnd = caret;
  }
  closeAcMenu();
  textarea.focus();
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  if (onCommit) onCommit(item);
}



export function cleanupAutocomplete() {
  closeAcMenu();
  document.removeEventListener("mousedown", handleAcDocumentMouseDown);
  acMenu?.remove();
  acMenu = null;
  acMirrorDiv?.remove();
  acMirrorDiv = null;
}

export { findWildcardFragment, getCaretCoords, openOrUpdateAcMenu, closeAcMenu, renderAcMenu, commitAcSelection, acState };
