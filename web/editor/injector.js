import { escapeHtml } from "./text_utils.js";
import { copyPromptPaletteThemeScope } from "../prompt_palette_shared.js";
import { openPromptTools, canBuildPromptRules } from "./prompt_tools_panel.js";
import { syntaxTone, syntaxCodeHtml } from "./syntax_presentation.js";
import { notify } from "./notifications.js";

export const INJECT_MODIFIERS = [
  { label: "Random", desc: "Seeded \u2014 one pick per resolve, stable for a given seed.", build: cat => `__${cat}__` },
  { label: "Random \u2014 unseeded", desc: "Ignores the seed \u2014 varies on every single run. ~ is an alias.", build: cat => `__*${cat}__` },
  { label: "Sequential \u2014 next", desc: "Walks forward one line each time this is called. @ is an alias.", build: cat => `__+${cat}__` },
  { label: "Sequential \u2014 previous", desc: "Walks backward one line each time this is called.", build: cat => `__-${cat}__` },
  { label: "Cartesian cycle", desc: "Cycles this wildcard with other % groups across editor resolves.", build: cat => `__%${cat}__` },
];
export const INJECT_TEMPLATES = [
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
  { label: "If / otherwise", desc: "Use different text depending on an assigned variable.", build: () => ({ prefix: "[if ", editable: 'genre == "cyberpunk"', suffix: "]neon lighting[else]soft lighting[/if]" }) },
  { label: "If / else if / otherwise", desc: "Check branches in order; the first match wins.", build: () => ({ prefix: "[if ", editable: 'genre == "cyberpunk"', suffix: ']neon[elif genre == "fantasy"]pastel[else]neutral[/if]' }) },
  { label: "Boolean AND", desc: "Both comparisons must match. Assign genre and mood with ${name=value} first.", build: () => ({ prefix: "[if ", editable: 'genre == "fantasy" and mood == "calm"', suffix: "]soft light[else]dramatic light[/if]" }) },
  { label: "Boolean OR", desc: "At least one comparison must match.", build: () => ({ prefix: "[if ", editable: 'genre == "fantasy" or genre == "sci-fi"', suffix: "]imaginary world[else]everyday world[/if]" }) },
  { label: "Boolean NOT", desc: "Reverse a condition. Use parentheses to group and/or expressions.", build: () => ({ prefix: "[if ", editable: 'not (genre == "fantasy" or genre == "sci-fi")', suffix: "]everyday world[else]imaginary world[/if]" }) },
  { label: "Switch / case / default", desc: "Compare one value with cases. The first match wins; no fall-through.", build: () => ({ prefix: "[switch ", editable: "genre", suffix: '][case "cyberpunk"]neon lighting[case "fantasy"]soft lighting[default]neutral lighting[/switch]' }) },
  { label: "Membership", desc: "Match any pipe-separated value; quoted strings stay literal.", build: () => ({ prefix: "[if ", editable: 'genre in "fantasy"|"sci-fi"', suffix: "]imaginary world[else]everyday world[/if]" }) },
  { label: "Numeric comparison", desc: "Compare numbers with >, >=, <, <=, == or !=.", build: () => ({ prefix: "[if ", editable: "detail >= 2", suffix: "]intricate[else]simple[/if]" }) },
  { label: "Nested branches", desc: "Nest conditions inside if or switch branches.", build: () => ({ prefix: "[if ", editable: 'genre == "fantasy"', suffix: '][if mood == "calm"]quiet forest[else]stormy forest[/if][else]city[/if]' }) },
  { label: "Reuse a variable", desc: "Insert text from a variable assigned earlier in this resolved block.", build: () => ({ prefix: "${", editable: "name", suffix: "}" }) },
  { label: "Parameterized wildcard", desc: "Pass values into a wildcard entry that uses ${key:fallback} placeholders.", build: () => ({ prefix: "__", editable: "category/name(key=value)", suffix: "__" }) },
  { label: "Phrase weight", desc: "Explicit numeric emphasis for encoders that support CLIP-style weights.", build: () => ({ prefix: "(", editable: "phrase", suffix: ":1.2)" }) },
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
  const source = textarea.value;
  if (cmd === "delete") {
    textarea.setRangeText("", start, end, "start");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    return;
  }

  try {
    if (!navigator.clipboard) throw new Error("Clipboard API unavailable");

    if (cmd === "paste") {
      const text = await navigator.clipboard.readText();
      if (textarea.value !== source) return;
      textarea.setRangeText(text, start, end, "end");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }

    const selected = textarea.value.slice(start, end);
    if (!selected) return;
    await navigator.clipboard.writeText(selected);

    if (cmd === "cut") {
      if (textarea.value !== source) return;
      textarea.setRangeText("", start, end, "start");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    }
  } catch { notify("error", "Clipboard unavailable", "Allow clipboard access or use your keyboard's copy, cut and paste shortcuts."); }
}

let injectMenu = null;
let injectState = null;
let injectCloseTimer = null;
function handleInjectDocumentMouseDown(event) {
  if (injectState && !injectMenu?.contains(event.target) && event.target !== injectState.trigger) closeInjectMenu();
}
function handleInjectViewportChange(event) {
  if (injectState && !(event.target instanceof Node && injectMenu?.contains(event.target))) closeInjectMenu();
}

function ensureInjectMenu() {
  if (injectMenu) return injectMenu;
  injectMenu = document.createElement("div");
  // Use the same visual primitives as the shared autocomplete popup so wildcard
  // injection, syntax suggestions, and booru/tag autocomplete feel like one system.
  injectMenu.className = "wg-inject-menu wg-ac-menu wg-root";
  injectMenu.dataset.promptPaletteGlobal = "true";
  document.body.appendChild(injectMenu);

  injectMenu.addEventListener("mousedown", (e) => {
    const row = e.target.closest(".wg-inject-item");
    if (!row || !injectState) return;
    e.preventDefault();
    const idx = Number(row.dataset.index);
    if (row.dataset.kind === "tool") {
      const { textarea, replaceRange } = injectState;
      const tab = row.dataset.tool;
      closeInjectMenu(); openPromptTools(textarea, { tab, range: tab === "rules" ? replaceRange : null });
    }
    else if (row.dataset.kind === "mod") commitInjectModifier(INJECT_MODIFIERS[idx]);
    else if (row.dataset.kind === "tpl") commitInjectTemplate(INJECT_TEMPLATES[idx]);
    else commitInjectEditAction(INJECT_EDIT_ACTIONS[idx]);
  });
  injectMenu.addEventListener("mouseenter", () => clearTimeout(injectCloseTimer));
  injectMenu.addEventListener("mouseleave", scheduleCloseInjectMenu);
  document.addEventListener("mousedown", handleInjectDocumentMouseDown);
  document.addEventListener("contextmenu", handleInjectDocumentMouseDown);
  document.addEventListener("scroll", handleInjectViewportChange, true);
  window.addEventListener("resize", handleInjectViewportChange);
  document.addEventListener("keydown", handleInjectKeydown, true);
  return injectMenu;
}

function insertInjectorText(textarea, renderFn, text, selStart, selEnd, replaceRange) {
  const start = replaceRange ? replaceRange.start : (textarea.selectionStart ?? textarea.value.length);
  const end = replaceRange ? replaceRange.end : (textarea.selectionEnd ?? start);
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

  const row = (kind, index, label, code, desc, tool = "") => `
    <div class="wg-ac-item wg-inject-item" role="menuitem" data-kind="${kind}" data-index="${index}" ${tool ? `data-tool="${tool}"` : ""} data-syntax-tone="${tool ? "logic" : kind === "edit" ? "note" : syntaxTone(code)}" title="${escapeHtml(desc)}">
      <span class="wg-ac-copy wg-inject-copy">
        <strong>${escapeHtml(label)}</strong>
        ${desc ? `<small>${escapeHtml(desc)}</small>` : ""}
      </span>
      ${code ? `<span class="wg-ac-metrics"><span class="wg-ac-pill wg-ac-code">${syntaxCodeHtml(code)}</span></span>` : ""}
    </div>`;

  const modRows = cat ? INJECT_MODIFIERS.map((m, i) => row("mod", i, m.label, m.build(cat), m.desc)).join("") : "";
  const groups = [["choice", "Choices"], ["weight", "Selection & weighting"], ["variable", "Reusable values"], ["logic", "Conditions"], ["note", "Notes"]];
  const tplRows = groups.map(([tone, title]) => {
    const rows = INJECT_TEMPLATES.map((t, i) => {
      if (!cat && i === 8) return "";
      const { prefix, editable, suffix } = t.build(cat), code = prefix + editable + suffix;
      return syntaxTone(code) === tone ? row("tpl", i, t.label, code, t.desc) : "";
    }).join("");
    return rows ? `<div class="wg-ac-group pp-syntax-group" data-syntax-tone="${tone}">${title}</div>${rows}` : "";
  }).join("");
  const selected = injectState.textarea.selectionEnd > injectState.textarea.selectionStart;
  const editRows = INJECT_EDIT_ACTIONS.map((a, i) => !selected && ["cut", "copy"].includes(a.cmd) ? "" : row("edit", i, a.label, "", a.desc)).join("");
  const tools = (!canBuildPromptRules(injectState.textarea) ? "" : row("tool", 0, "Build choices & rules", "", "Use a dropdown and matching outputs instead of writing syntax by hand.", "rules"))
    + row("tool", 1, "Inspect prompt", "", "See explicit weights, reference tokens and embedding availability.", "inspect");

  menu.innerHTML =
    `<div class="wg-ac-group wg-inject-head" data-ac-section="context">${escapeHtml(cat || "Insert syntax")}</div>` +
    `<div class="wg-ac-group pp-syntax-group" data-syntax-tone="logic">Prompt tools</div>` + tools +
    (cat ? `<div class="wg-ac-group pp-syntax-group" data-syntax-tone="choice" data-ac-section="wildcard">Wildcard mode</div>` + modRows : "") + tplRows +
    `<div class="wg-ac-group" data-ac-section="edit">Edit</div>` + editRows;
  menu.setAttribute("role", "menu");
}

function handleInjectKeydown(event) {
  if (!injectState || (document.activeElement !== injectState.textarea && !injectMenu?.contains(document.activeElement)) || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
  // Shift navigation belongs to native text selection, never to menu navigation.
  if (event.shiftKey && ["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) { closeInjectMenu(); return; }
  const rows = [...injectMenu.querySelectorAll(".wg-inject-item")], active = rows.findIndex(row => row.classList.contains("active"));
  if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
    event.preventDefault(); event.stopPropagation();
    const next = event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1 : event.key === "ArrowDown" ? (active + 1) % rows.length : (active < 0 ? rows.length - 1 : (active + rows.length - 1) % rows.length);
    rows.forEach((row, index) => row.classList.toggle("active", index === next)); rows[next]?.scrollIntoView({ block: "nearest" });
  } else if (event.key === "Enter" && active >= 0) {
    event.preventDefault(); event.stopPropagation(); rows[active].dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  } else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeInjectMenu(); }
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



// Rows for the typing-triggered syntax menu ("{" opens it). Only templates that stand alone
// (no wildcard name needed) are offered; `typed` is what the user already typed ("{", "{*", "${").
export function syntaxSnippetRows(typed = "") {
  const wanted = String(typed || "");
  const rows = [];
  for (const tpl of INJECT_TEMPLATES) {
    const { prefix, editable, suffix } = tpl.build("name");
    if (!/^\$?\{/.test(prefix) || /__name__/.test(suffix)) continue;
    if (wanted && !prefix.startsWith(wanted)) continue;
    const code = prefix + editable + suffix;
    rows.push({
      value: code, label: tpl.label, meta: tpl.desc, code, kind: "syntax", group: "Syntax",
      insertText: code, selectRange: [prefix.length, prefix.length + editable.length],
      syntaxTone: syntaxTone(code),
    });
  }
  return rows;
}

export function cleanupInjector() {
  closeInjectMenu();
  document.removeEventListener("mousedown", handleInjectDocumentMouseDown);
  document.removeEventListener("contextmenu", handleInjectDocumentMouseDown);
  document.removeEventListener("scroll", handleInjectViewportChange, true);
  window.removeEventListener("resize", handleInjectViewportChange);
  document.removeEventListener("keydown", handleInjectKeydown, true);
  injectMenu?.remove();
  injectMenu = null;
}

export { runTextareaEditCommand, insertInjectorText, openInjectMenu, openInjectMenuAtPoint, closeInjectMenu, scheduleCloseInjectMenu, cancelScheduledCloseInjectMenu, injectState };
