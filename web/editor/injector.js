import { escapeHtml } from "./text_utils.js";
import { copyPromptPaletteThemeScope } from "../prompt_palette_shared.js";

const INJECT_MODIFIERS = [
  { label: "Random", desc: "Seeded \u2014 one pick per resolve, stable for a given seed.", build: cat => `__${cat}__` },
  { label: "Random \u2014 unseeded", desc: "Ignores the seed \u2014 varies on every single run.", build: cat => `__*${cat}__` },
  { label: "Sequential \u2014 next", desc: "Walks forward one line each time this is called.", build: cat => `__+${cat}__` },
  { label: "Sequential \u2014 previous", desc: "Walks backward one line each time this is called.", build: cat => `__-${cat}__` },
  { label: "Cartesian cycle", desc: "Cycles this wildcard with other % groups across editor resolves.", build: cat => `__%${cat}__` },
];
const INJECT_TEMPLATES = [
  { label: "Random choice", desc: "Seeded random pick from an inline list.", build: () => ({ prefix: "{", editable: "a|b|c", suffix: "}" }) },
  { label: "Random choice \u2014 unseeded", desc: "Inline pick that varies every run.", build: () => ({ prefix: "{*", editable: "a|b|c", suffix: "}" }) },
  { label: "Sequential choice \u2014 next", desc: "Inline list, walks forward each call.", build: () => ({ prefix: "{+", editable: "a|b|c", suffix: "}" }) },
  { label: "Sequential choice \u2014 previous", desc: "Inline list, walks backward each call.", build: () => ({ prefix: "{-", editable: "a|b|c", suffix: "}" }) },
  { label: "Cartesian choice cycle", desc: "Cycles with other % groups across editor resolves.", build: () => ({ prefix: "{%", editable: "a|b|c", suffix: "}" }) },
  { label: "Weighted choice", desc: "Higher numbers are picked more often.", build: () => ({ prefix: "{", editable: "1::a|1::b|c", suffix: "}" }) },
  { label: "Joined selection", desc: "Pick an exact number of options, joined by a separator.", build: () => ({ prefix: "{", editable: "2$$, $$a|b|c", suffix: "}" }) },
  { label: "Joined selection \u2014 range", desc: "Pick between N and M options, joined by a separator.", build: () => ({ prefix: "{", editable: "1-2$$, $$a|b|c", suffix: "}" }) },
  { label: "Wildcard multi-pick slots", desc: "Duplicate this wildcard into option slots before a joined selection.", build: cat => ({ prefix: "{2$$, $$", editable: "4", suffix: `#__${cat}__}` }) },
  { label: "Variable assignment", desc: "Store reusable prompt text. The assignment itself is removed from output.", build: () => ({ prefix: "${", editable: "name=value", suffix: "}" }) },
  { label: "Variable \u2014 resolve once", desc: "Resolve an expression when assigned, then reuse that exact result.", build: () => ({ prefix: "${", editable: "name=!{a|b|c}", suffix: "}" }) },
  { label: "Variable with default", desc: "Use a fallback when a variable has not been assigned.", build: () => ({ prefix: "${", editable: "name:fallback", suffix: "}" }) },
  { label: "Comment line", desc: "A line beginning with # is removed before resolution.", build: () => ({ prefix: "# ", editable: "note", suffix: "" }) },
];

const INJECT_EDIT_ACTIONS = [
  { label: "Cut", desc: "Cut the current selection.", cmd: "cut" },
  { label: "Copy", desc: "Copy the current selection.", cmd: "copy" },
  { label: "Paste", desc: "Paste from the clipboard, replacing any selection.", cmd: "paste" },
  { label: "Select All", desc: "Select the entire prompt text.", cmd: "selectAll" },
];

async function runTextareaEditCommand(textarea, render, cmd) {
  textarea.focus();
  if (cmd === "selectAll") {
    textarea.select();
    return;
  }

  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;

  try {
    if (!navigator.clipboard) throw new Error("Clipboard API unavailable");

    if (cmd === "paste") {
      const text = await navigator.clipboard.readText();
      textarea.setRangeText(text, start, end, "end");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }

    const selected = textarea.value.slice(start, end);
    if (!selected) return;
    await navigator.clipboard.writeText(selected);

    if (cmd === "cut") {
      textarea.setRangeText("", start, end, "start");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    }
  } catch {}
}

let injectMenu = null;
let injectState = null;
let injectCloseTimer = null;
function handleInjectDocumentMouseDown(event) {
  if (injectState && !injectMenu?.contains(event.target) && event.target !== injectState.trigger) closeInjectMenu();
}

function ensureInjectMenu() {
  if (injectMenu) return injectMenu;
  injectMenu = document.createElement("div");
  injectMenu.className = "wg-inject-menu wg-root";
  injectMenu.dataset.promptPaletteGlobal = "true";
  document.body.appendChild(injectMenu);

  injectMenu.addEventListener("mousedown", (e) => {
    const row = e.target.closest(".wg-inject-item");
    if (!row || !injectState) return;
    e.preventDefault();
    const idx = Number(row.dataset.index);
    if (row.dataset.kind === "mod") commitInjectModifier(INJECT_MODIFIERS[idx]);
    else if (row.dataset.kind === "tpl") commitInjectTemplate(INJECT_TEMPLATES[idx]);
    else commitInjectEditAction(INJECT_EDIT_ACTIONS[idx]);
  });
  injectMenu.addEventListener("mouseenter", () => clearTimeout(injectCloseTimer));
  injectMenu.addEventListener("mouseleave", scheduleCloseInjectMenu);
  document.addEventListener("mousedown", handleInjectDocumentMouseDown);
  return injectMenu;
}

function insertInjectorText(textarea, renderFn, text, selStart, selEnd, replaceRange) {
  const start = replaceRange ? replaceRange.start : (textarea.selectionStart ?? textarea.value.length);
  const end = replaceRange ? replaceRange.end : start;
  textarea.value = textarea.value.slice(0, start) + text + textarea.value.slice(end);
  if (selStart == null) {
    textarea.selectionStart = textarea.selectionEnd = start + text.length;
  } else {
    textarea.selectionStart = start + selStart;
    textarea.selectionEnd = start + selEnd;
  }
  textarea.focus();
  renderFn();
}

function commitInjectModifier(mod) {
  if (!injectState) return;
  const { textarea, render, cat, replaceRange } = injectState;
  insertInjectorText(textarea, render, mod.build(cat), null, null, replaceRange);
  closeInjectMenu();
}
function commitInjectTemplate(tpl) {
  if (!injectState) return;
  const { textarea, render, cat, replaceRange } = injectState;
  const { prefix, editable, suffix } = tpl.build(cat);
  insertInjectorText(textarea, render, prefix + editable + suffix, prefix.length, prefix.length + editable.length, replaceRange);
  closeInjectMenu();
}
function commitInjectEditAction(action) {
  if (!injectState) return;
  const { textarea, render } = injectState;
  closeInjectMenu();
  runTextareaEditCommand(textarea, render, action.cmd);
}

function renderInjectMenu(cat) {
  const menu = ensureInjectMenu();
  const scope = injectState?.textarea?.closest?.(".wg-root, .wg-node, .pp-node, .ppwc-surface");
  if (scope) copyPromptPaletteThemeScope(scope, menu);
  const modRows = INJECT_MODIFIERS.map((m, i) => `
      <div class="wg-inject-item" data-kind="mod" data-index="${i}" title="${escapeHtml(m.desc)}">
        <span class="wg-inject-item-label">${escapeHtml(m.label)}</span>
        <span class="wg-inject-item-code">${escapeHtml(m.build(cat))}</span>
      </div>`).join("");
  const tplRows = INJECT_TEMPLATES.map((t, i) => {
    const { prefix, editable, suffix } = t.build(cat);
    return `
      <div class="wg-inject-item" data-kind="tpl" data-index="${i}" title="${escapeHtml(t.desc)}">
        <span class="wg-inject-item-label">${escapeHtml(t.label)}</span>
        <span class="wg-inject-item-code">${escapeHtml(prefix + editable + suffix)}</span>
      </div>`;
  }).join("");
  const editRows = INJECT_EDIT_ACTIONS.map((a, i) => `
      <div class="wg-inject-item" data-kind="edit" data-index="${i}" title="${escapeHtml(a.desc)}">
        <span class="wg-inject-item-label">${escapeHtml(a.label)}</span>
      </div>`).join("");
  menu.innerHTML =
    `<div class="wg-inject-head">${escapeHtml(cat)}</div>` +
    `<div class="wg-inject-section-label">Wildcard</div>` + modRows +
    `<div class="wg-inject-section-label">Template</div>` + tplRows +
    `<div class="wg-inject-section-label">Edit</div>` + editRows;
}

function positionInjectMenu(trigger) {
  const menu = ensureInjectMenu();
  const rect = trigger.getBoundingClientRect();
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  const vw = window.innerWidth, vh = window.innerHeight;
  let left = Math.max(8, Math.min(rect.left, vw - mw - 8));
  let top = rect.bottom + 4;
  if (top + mh > vh - 8) top = Math.max(8, rect.top - mh - 4);
  menu.style.left = left + "px";
  menu.style.top = top + "px";
}

function positionInjectMenuAt(x, y) {
  const menu = ensureInjectMenu();
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  const vw = window.innerWidth, vh = window.innerHeight;
  menu.style.left = Math.max(8, Math.min(x, vw - mw - 8)) + "px";
  menu.style.top = Math.max(8, Math.min(y, vh - mh - 8)) + "px";
}

function openInjectMenu(trigger, cat, textarea, render, replaceRange = null) {
  clearTimeout(injectCloseTimer);
  const menu = ensureInjectMenu();
  if (injectState && injectState.trigger && injectState.trigger !== trigger) injectState.trigger.classList.remove("open");
  injectState = { trigger, cat, textarea, render, replaceRange };
  renderInjectMenu(cat);
  menu.style.display = "block";
  positionInjectMenu(trigger);
  trigger.classList.add("open");
}

function openInjectMenuAtPoint(x, y, cat, textarea, render, replaceRange) {
  clearTimeout(injectCloseTimer);
  const menu = ensureInjectMenu();
  if (injectState && injectState.trigger) injectState.trigger.classList.remove("open");
  injectState = { trigger: null, cat, textarea, render, replaceRange };
  renderInjectMenu(cat);
  menu.style.display = "block";
  positionInjectMenuAt(x, y);
}

function closeInjectMenu() {
  clearTimeout(injectCloseTimer);
  injectCloseTimer = null;
  if (!injectMenu) return;
  injectMenu.style.display = "none";
  if (injectState && injectState.trigger) injectState.trigger.classList.remove("open");
  injectState = null;
}

function scheduleCloseInjectMenu() {
  clearTimeout(injectCloseTimer);
  injectCloseTimer = setTimeout(closeInjectMenu, 220);
}

function cancelScheduledCloseInjectMenu() {
  clearTimeout(injectCloseTimer);
  injectCloseTimer = null;
}



export function cleanupInjector() {
  closeInjectMenu();
  document.removeEventListener("mousedown", handleInjectDocumentMouseDown);
  injectMenu?.remove();
  injectMenu = null;
}

export { runTextareaEditCommand, insertInjectorText, openInjectMenu, openInjectMenuAtPoint, closeInjectMenu, scheduleCloseInjectMenu, cancelScheduledCloseInjectMenu, injectState };
