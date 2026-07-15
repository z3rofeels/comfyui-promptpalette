import { app } from "/scripts/app.js";

const CSS_HREF = "extensions/comfyui-promptpalette/css/wildcard_editor.css";
if (!document.querySelector(`link[href="${CSS_HREF}"]`)) {
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = CSS_HREF;
  document.head.appendChild(link);
}

const API = {
  async list() {
    const r = await fetch("/prompt_palette/list");
    return (await r.json()).items || [];
  },
  async search(q) {
    const r = await fetch(`/prompt_palette/search?q=${encodeURIComponent(q)}`);
    return (await r.json()).items || [];
  },
  async preview(name) {
    const r = await fetch(`/prompt_palette/preview?name=${encodeURIComponent(name)}`);
    return await r.json();
  },
  async content(name) {
    const r = await fetch(`/prompt_palette/content?name=${encodeURIComponent(name)}`);
    if (!r.ok) return null;
    return await r.json();
  },
  async save(name, content) {
    const r = await fetch("/prompt_palette/save", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, content }),
    });
    return await r.json();
  },
  async del(name) {
    const r = await fetch("/prompt_palette/delete", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    return await r.json();
  },
  async resolve(text, seed, mode) {
    const r = await fetch("/prompt_palette/resolve", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, seed, mode }),
    });
    return (await r.json()).resolved || "";
  },
  async refreshWildcards() {
    const r = await fetch("/prompt_palette/refresh", { method: "POST" });
    if (!r.ok) throw new Error(`refresh failed: ${r.status}`);
    return await r.json();
  },
};

function loadTheme() {
  try {
    const raw = localStorage.getItem("pp_theme");
    if (raw) return { ...defaultTheme(), ...JSON.parse(raw) };
  } catch (e) {}
  return defaultTheme();
}
function defaultTheme() {
  return {
    hueRotate: 0, saturation: 65, categoryPins: {},
    // Accessibility: kept separate from the interface (light/dark) theme
    // above and the wildcard-token hue/saturation system, since these three
    // control genuinely different things (chrome color vs. token color vs.
    // legibility) and users with vision needs often want to tune only one.
    fontFamily: "",              // "" = use built-in default stack for each area
    editorFontSize: 12.5,        // px, main prompt textarea + resolved-preview
    uiFontScale: 1,              // multiplier, sidebar/folder/legend text
    promptTextColor: "#e8e2d4",  // plain (non-token) prompt text + caret
    // Toolbar declutter: the seed/increment/line-by-line/randomize cluster and
    // the day/night quick-toggle button are both optional, off/on by these
    // defaults, and switchable from Settings without digging through menus.
    showSeedControls: false,
    showDayNightBtn: true,
    dayTheme: "Daylight",
    nightTheme: "Amber",
    // "Zen" toggle: the per-item Syntax Injector flyout (hover ⚡ icon in the
    // picker drawer, next to each wildcard row). On by default; minimalist
    // users can switch it off in Settings for a fully click-only browsing
    // experience.
    syntaxInjectorEnabled: true,
  };
}
function saveTheme(theme) {
  try { localStorage.setItem("pp_theme", JSON.stringify(theme)); } catch (e) {}
}
function loadPinned() {
  try { return new Set(JSON.parse(localStorage.getItem("pp_pinned") || "[]")); } catch (e) { return new Set(); }
}
function savePinned(set) {
  try { localStorage.setItem("pp_pinned", JSON.stringify(Array.from(set))); } catch (e) {}
}
// Categories default to COLLAPSED (i.e. absent from this set) so the list
// doesn't flood the drawer the moment a bunch of wildcards are added.
function loadExpandedCats() {
  try { return new Set(JSON.parse(localStorage.getItem("pp_expanded_cats") || "[]")); } catch (e) { return new Set(); }
}
function saveExpandedCats(set) {
  try { localStorage.setItem("pp_expanded_cats", JSON.stringify(Array.from(set))); } catch (e) {}
}
// User-defined ordering for sidebar category folders (drag-to-reorder).
// Stores just the ordered list of category names seen so far; any category
// not yet in this list (new wildcard folder) is appended alphabetically at
// render time and the list is persisted so its position "sticks" from then on.
function loadCatOrder() {
  try { return JSON.parse(localStorage.getItem("pp_cat_order") || "[]"); } catch (e) { return []; }
}
function saveCatOrder(arr) {
  try { localStorage.setItem("pp_cat_order", JSON.stringify(arr)); } catch (e) {}
}

// --- Interface theme system -------------------------------------------
// This themes the UI chrome (backgrounds, panels, buttons, borders, labels)
// via CSS custom properties. It is intentionally separate from the
// hue/saturation/category-pin system above, which colors the wildcard
// tokens inside the prompt text and is left untouched. 
const UI_THEME_KEYS = [
  ["bg", "Background"],
  ["panel-bg", "Panels / drawers"],
  ["surface", "Inputs & editor"],
  ["border", "Border"],
  ["border-strong", "Border (strong)"],
  ["text", "Text"],
  ["text-dim", "Text (dim)"],
  ["text-faint", "Text (faint)"],
  ["accent", "Accent"],
  ["accent-text", "Accent text"],
  ["success", "Success"],
  ["danger", "Danger"],
];
const BUILTIN_UI_THEMES = {
  "Amber": {
    "bg": "#1d1c1a", "panel-bg": "#171511", "surface": "#131211",
    "border": "#2c2820", "border-strong": "#38352f",
    "text": "#e8e2d4", "text-dim": "#b3ab99", "text-faint": "#6f6a5c",
    "accent": "#d9a441", "accent-text": "#1d1c1a",
    "success": "#7fae7a", "danger": "#e0605f",
  },
  "Slate": {
    "bg": "#191c20", "panel-bg": "#14171a", "surface": "#101215",
    "border": "#252a30", "border-strong": "#333a42",
    "text": "#e1e7ec", "text-dim": "#96a3ad", "text-faint": "#5c6770",
    "accent": "#5aa9e6", "accent-text": "#0d1216",
    "success": "#6fbf8b", "danger": "#e0605f",
  },
  "Forest": {
    "bg": "#161d17", "panel-bg": "#121712", "surface": "#0f130f",
    "border": "#243024", "border-strong": "#33452f",
    "text": "#e2ecdf", "text-dim": "#9db497", "text-faint": "#5c6c58",
    "accent": "#7fae7a", "accent-text": "#0f1a10",
    "success": "#8fca8a", "danger": "#e0605f",
  },
  "Mono": {
    "bg": "#1a1a1a", "panel-bg": "#151515", "surface": "#101010",
    "border": "#2a2a2a", "border-strong": "#3a3a3a",
    "text": "#e8e8e8", "text-dim": "#a8a8a8", "text-faint": "#707070",
    "accent": "#d0d0d0", "accent-text": "#141414",
    "success": "#8ec98e", "danger": "#e0605f",
  },
  "Daylight": {
    "bg": "#f6f4ef", "panel-bg": "#ffffff", "surface": "#ffffff",
    "border": "#d9d4c8", "border-strong": "#b9b2a0",
    "text": "#1f1d18", "text-dim": "#4c473c", "text-faint": "#79725f",
    "accent": "#a9660a", "accent-text": "#ffffff",
    "success": "#2e7d32", "danger": "#c62828",
  },
  "High Contrast": {
    "bg": "#000000", "panel-bg": "#000000", "surface": "#0a0a0a",
    "border": "#ffffff", "border-strong": "#ffffff",
    "text": "#ffffff", "text-dim": "#f2f2f2", "text-faint": "#d0d0d0",
    "accent": "#ffd400", "accent-text": "#000000",
    "success": "#5cff5c", "danger": "#ff5c5c",
  },
};
function loadUiThemes() {
  try {
    const raw = localStorage.getItem("pp_ui_themes");
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return {};
}
function saveUiThemes(themes) {
  try { localStorage.setItem("pp_ui_themes", JSON.stringify(themes)); } catch (e) {}
}
function loadActiveUiThemeName() {
  try { return localStorage.getItem("pp_ui_active_theme") || "Amber"; } catch (e) { return "Amber"; }
}
function saveActiveUiThemeName(name) {
  try { localStorage.setItem("pp_ui_active_theme", name); } catch (e) {}
}

function hashStr(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h;
}
function categoryOf(p) {
  const parts = p.split("/");
  return parts.length > 1 ? parts.slice(0, -1).join("/") : "misc";
}
function escapeHtml(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
// Wraps the first case-insensitive occurrence of `filter` inside `text` in a
// <mark class="wg-match"> span, for highlighting picker search matches (see
// pickerRow). Falls back to plain escaped text when there's no filter or no
// match in this particular string (e.g. the match was in a parent folder
// segment rather than the leaf name shown on the row).
function highlightMatch(text, filter) {
  if (!filter) return escapeHtml(text);
  const idx = text.toLowerCase().indexOf(filter.toLowerCase());
  if (idx === -1) return escapeHtml(text);
  return escapeHtml(text.slice(0, idx)) +
    `<mark class="wg-match">${escapeHtml(text.slice(idx, idx + filter.length))}</mark>` +
    escapeHtml(text.slice(idx + filter.length));
}
// Used for any color value that might originate from imported/pasted theme
// JSON rather than a native <input type="color"> (which the browser already
// guarantees is a clean hex string). Anything that isn't a real #rrggbb
// falls back to a safe default instead of being trusted as-is.
function sanitizeHexColor(v, fallback = "#000000") {
  return (typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v)) ? v : fallback;
}
function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = n => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const toHex = x => Math.round(255 * x).toString(16).padStart(2, "0");
  return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
}

// ---------------------------------------------------------------------
// "__" wildcard autocomplete
// ---------------------------------------------------------------------
// The actual match lookup (getAcMatches) is defined per node instance,
// down in buildWildcardWidget, because it reads that node's own `knownSet` —
// the live wildcard list already maintained elsewhere in this file (hydrated
// on load by refreshLibrary(), and re-hydrated whenever the user hits the
// refresh button, via node.updateWildcardSidePanels). Keeping the lookup
// per-instance (rather than one shared/global list) is what makes this
// correct if more than one of these nodes is ever on the same canvas.

// Finds an in-progress, unclosed "__query" fragment ending exactly at
// `caret`, or returns null if the caret isn't inside one. A "__" only
// counts as an *opener* if an even number of "__" pairs precede it —
// that's what stops this from re-triggering on the closing "__" of a
// token the user already finished typing (e.g. right after "__style__"
// with no separator yet before the next word).
function findWildcardFragment(text, caret) {
  const before = text.slice(0, caret);
  const m = before.match(/__([A-Za-z0-9_\-\/]*)$/);
  if (!m) return null;
  const start = m.index;
  const priorPairs = (before.slice(0, start).match(/__/g) || []).length;
  if (priorPairs % 2 !== 0) return null;
  return { query: m[1], start, end: caret };
}

// Mirror-div technique: clones the textarea's text-affecting computed
// styles onto an offscreen div, fills it with the text up to `index`, and
// reads back the position of a marker span. This tracks the real caret
// pixel-for-pixel even when the user changes font family/size in the
// editor's own Settings panel, unlike a fixed monospace char-width guess.
const AC_MIRROR_PROPS = [
  "boxSizing", "width", "fontFamily", "fontSize", "fontWeight", "fontStyle",
  "letterSpacing", "lineHeight", "paddingTop", "paddingRight", "paddingBottom",
  "paddingLeft", "borderTopWidth", "borderRightWidth", "borderBottomWidth",
  "borderLeftWidth", "textIndent", "textTransform",
];
let acMirrorDiv = null;
function getCaretCoords(textarea, index) {
  if (!acMirrorDiv) {
    acMirrorDiv = document.createElement("div");
    acMirrorDiv.style.position = "absolute";
    acMirrorDiv.style.visibility = "hidden";
    acMirrorDiv.style.whiteSpace = "pre-wrap";
    acMirrorDiv.style.wordWrap = "break-word";
    acMirrorDiv.style.top = "0px";
    acMirrorDiv.style.left = "-9999px";
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

// One shared floating menu, reused across every node instance — only one
// textarea can be focused and typing at a time, so there's no need for a
// separate DOM element (or a separate outside-click listener) per node.
let acMenu = null;
let acState = null; // { textarea, items, activeIndex, start, end, onCommit }

function ensureAcMenu() {
  if (acMenu) return acMenu;
  acMenu = document.createElement("div");
  acMenu.className = "wg-ac-menu";
  document.body.appendChild(acMenu);
  // mousedown (not click) so this fires before the textarea blurs.
  acMenu.addEventListener("mousedown", (e) => {
    const row = e.target.closest("[data-ac-index]");
    if (!row) return;
    e.preventDefault();
    commitAcSelection(Number(row.dataset.acIndex));
  });
  document.addEventListener("mousedown", (e) => {
    if (acState && !acMenu.contains(e.target) && e.target !== acState.textarea) closeAcMenu();
  });
  return acMenu;
}

function closeAcMenu() {
  if (!acMenu) return;
  acMenu.style.display = "none";
  acState = null;
}

function renderAcMenu() {
  if (!acState) return;
  const menu = ensureAcMenu();
  menu.innerHTML = "";
  if (!acState.items.length) {
    const empty = document.createElement("div");
    empty.className = "wg-ac-empty";
    empty.textContent = "no matching wildcards";
    menu.appendChild(empty);
  } else {
    acState.items.forEach((item, i) => {
      const row = document.createElement("div");
      row.className = "wg-ac-item" + (i === acState.activeIndex ? " active" : "");
      row.dataset.acIndex = String(i);
      row.textContent = item;
      menu.appendChild(row);
    });
  }
  const coords = getCaretCoords(acState.textarea, acState.end);
  menu.style.left = coords.left + "px";
  menu.style.top = (coords.top + coords.lineHeight + 4) + "px";
  menu.style.display = "block";
}

async function openOrUpdateAcMenu(textarea, fragment, getMatches, onCommit) {
  const items = await getMatches(fragment.query);
  // The user may have kept typing (or the fragment may have closed/moved)
  // while this lookup was in flight — recheck before showing stale results.
  const stillValid = findWildcardFragment(textarea.value, textarea.selectionStart);
  if (!stillValid || stillValid.start !== fragment.start) return;
  acState = { textarea, items, activeIndex: 0, start: fragment.start, end: fragment.end, onCommit };
  renderAcMenu();
}

function commitAcSelection(index) {
  if (!acState) return;
  const { textarea, start, end, items, onCommit } = acState;
  const item = items[index];
  if (item == null) return closeAcMenu();
  const tag = `__${item}__`;
  textarea.value = textarea.value.slice(0, start) + tag + textarea.value.slice(end);
  const caret = start + tag.length;
  textarea.selectionStart = textarea.selectionEnd = caret;
  closeAcMenu();
  textarea.focus();
  if (onCommit) onCommit(item);
}

// ---------------------------------------------------------------------
// "Syntax Injector" hover/click flyout on picker item rows
// ---------------------------------------------------------------------
// Lets a user insert advanced wildcard syntax for a specific item without
// memorizing it, straight from the picker drawer's row. Split into two
// kinds, per the backend engine's own split between "a name that resolves
// on its own" and "a structural template you fill in":
//
//  - Modifiers: single-click, fully-formed inserts bound to the hovered
//    item's full path (__path__, __*path__, __+path__, __-path__). Nothing
//    left to fill in, so the caret just lands after the tag, same as
//    clicking a picker row.
//  - Templates: structural {…} snippets. These aren't "about" the hovered
//    item (a|b|c are placeholder options, not real wildcard names) EXCEPT
//    for "repeat this wildcard", which is inherently path-bound since
//    it wraps __path__ directly. Each template is inserted as
//    prefix+editable+suffix, and only the `editable` span is selected
//    afterward — this keeps syntax-critical characters (the leading *find/+/-
//    modifier, the closing __path__}) out of the selection so a careless
//    retype can't clobber them, while still landing the user's cursor right
//    on the part they actually need to customize.
const INJECT_MODIFIERS = [
  { label: "Random", desc: "Seeded \u2014 one pick per resolve, stable for a given seed.", build: cat => `__${cat}__` },
  { label: "Random \u2014 unseeded", desc: "Ignores the seed \u2014 varies on every single run.", build: cat => `__*${cat}__` },
  { label: "Sequential \u2014 next", desc: "Walks forward one line each time this is called.", build: cat => `__+${cat}__` },
  { label: "Sequential \u2014 previous", desc: "Walks backward one line each time this is called.", build: cat => `__-${cat}__` },
];
const INJECT_TEMPLATES = [
  { label: "Random choice", desc: "Seeded random pick from an inline list.", build: () => ({ prefix: "{", editable: "a|b|c", suffix: "}" }) },
  { label: "Random choice \u2014 unseeded", desc: "Inline pick that varies every run.", build: () => ({ prefix: "{*", editable: "a|b|c", suffix: "}" }) },
  { label: "Sequential choice \u2014 next", desc: "Inline list, walks forward each call.", build: () => ({ prefix: "{+", editable: "a|b|c", suffix: "}" }) },
  { label: "Sequential choice \u2014 previous", desc: "Inline list, walks backward each call.", build: () => ({ prefix: "{-", editable: "a|b|c", suffix: "}" }) },
  { label: "Weighted choice", desc: "Higher numbers are picked more often.", build: () => ({ prefix: "{", editable: "1::a|1::b|c", suffix: "}" }) },
  { label: "Joined selection", desc: "Pick an exact number of options, joined by a separator.", build: () => ({ prefix: "{", editable: "2$$, $$a|b|c", suffix: "}" }) },
  { label: "Joined selection \u2014 range", desc: "Pick between N and M options, joined by a separator.", build: () => ({ prefix: "{", editable: "1-2$$, $$a|b|c", suffix: "}" }) },
  { label: "Repeat this wildcard \u00d7N", desc: "Expands the wildcard N times before any multi-select.", build: cat => ({ prefix: "{", editable: "3", suffix: `#__${cat}__}` }) },
];

// One shared floating menu, reused across every node instance on the canvas
// (same reasoning as the "__" autocomplete menu above: only one row can be
// hovered/focused at a time, so a single DOM element is all this ever needs).
let injectMenu = null;
let injectState = null; // { trigger, cat, textarea, render, replaceRange }
let injectCloseTimer = null;

function ensureInjectMenu() {
  if (injectMenu) return injectMenu;
  injectMenu = document.createElement("div");
  injectMenu.className = "wg-inject-menu";
  document.body.appendChild(injectMenu);
  // mousedown (not click) so this fires before the picker row/textarea blurs.
  injectMenu.addEventListener("mousedown", (e) => {
    const row = e.target.closest(".wg-inject-item");
    if (!row || !injectState) return;
    e.preventDefault();
    const idx = Number(row.dataset.index);
    if (row.dataset.kind === "mod") commitInjectModifier(INJECT_MODIFIERS[idx]);
    else commitInjectTemplate(INJECT_TEMPLATES[idx]);
  });
  injectMenu.addEventListener("mouseenter", () => clearTimeout(injectCloseTimer));
  injectMenu.addEventListener("mouseleave", scheduleCloseInjectMenu);
  document.addEventListener("mousedown", (e) => {
    if (injectState && !injectMenu.contains(e.target) && e.target !== injectState.trigger) closeInjectMenu();
  });
  return injectMenu;
}

// replaceRange (optional) — { start, end } into textarea.value. When given,
// the commit overwrites that exact slice instead of inserting at whatever
// the caret currently happens to be at. Used by the right-click-on-a-token
// path below, so choosing e.g. "Sequential — next" on an already-inserted
// __name__ rewrites that same occurrence into __+name__ in place rather
// than dropping a second copy in wherever the caret last was.
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

function renderInjectMenu(cat) {
  const menu = ensureInjectMenu();
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
  menu.innerHTML =
    `<div class="wg-inject-head">${escapeHtml(cat)}</div>` +
    `<div class="wg-inject-section-label">Wildcard</div>` + modRows +
    `<div class="wg-inject-section-label">Template</div>` + tplRows;
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

// Same clamped-to-viewport placement as positionInjectMenu above, just
// anchored to a raw screen point (the right-click position) instead of a
// hover-able DOM element's bounding box — mirrors how openCtxMenu positions
// the row right-click menu elsewhere in this file.
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

// Right-click-on-a-token entry point (see the textarea "contextmenu"
// listener below). Reuses every bit of the menu/state/commit plumbing above
// — there's just no persistent trigger element to anchor to or to
// highlight with the "open" class, since the click can land on any of
// possibly many token occurrences in the prompt text rather than a fixed
// picker row.
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
  if (!injectMenu) return;
  injectMenu.style.display = "none";
  if (injectState && injectState.trigger) injectState.trigger.classList.remove("open");
  injectState = null;
}

function scheduleCloseInjectMenu() {
  clearTimeout(injectCloseTimer);
  injectCloseTimer = setTimeout(closeInjectMenu, 220);
}

// ---------------------------------------------------------------------
// Row right-click context menu (copy path / pin / jump to category)
// ---------------------------------------------------------------------
// Same one-shared-floating-element reasoning as the inject menu above: only
// one row can be right-clicked at a time across every node on the canvas.
// Deliberately generic — it just renders whatever { label, onSelect } list
// it's given, so pickerRow (which knows about pinning/copying/categories)
// builds the action list rather than this module needing to know about any
// of that itself.
let ctxMenu = null;
let ctxMenuOpen = false;

function ensureCtxMenu() {
  if (ctxMenu) return ctxMenu;
  ctxMenu = document.createElement("div");
  ctxMenu.className = "wg-ctx-menu";
  document.body.appendChild(ctxMenu);
  // mousedown-outside closes it, same pattern as the inject menu — but a
  // mousedown *inside* is left alone so the item's own click handler (added
  // fresh per openCtxMenu call) gets a chance to run first.
  document.addEventListener("mousedown", (e) => {
    if (ctxMenuOpen && !ctxMenu.contains(e.target)) closeCtxMenu();
  });
  return ctxMenu;
}

function openCtxMenu(x, y, actions) {
  const menu = ensureCtxMenu();
  menu.innerHTML = actions.map((a, i) =>
    `<div class="wg-ctx-item" data-index="${i}">${escapeHtml(a.label)}</div>`).join("");
  Array.from(menu.children).forEach((row, i) => {
    row.addEventListener("click", () => {
      closeCtxMenu();
      actions[i].onSelect();
    });
  });
  menu.style.display = "block";
  ctxMenuOpen = true;
  // Clamp to viewport, same corner-flip approach as positionInjectMenu.
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  const vw = window.innerWidth, vh = window.innerHeight;
  menu.style.left = Math.max(8, Math.min(x, vw - mw - 8)) + "px";
  menu.style.top = Math.max(8, Math.min(y, vh - mh - 8)) + "px";
}

function closeCtxMenu() {
  if (!ctxMenu) return;
  ctxMenu.style.display = "none";
  ctxMenuOpen = false;
}

function buildWildcardWidget(node, hiddenWidget) {
  const theme = loadTheme();
  const pinned = loadPinned();
  const expandedCats = loadExpandedCats();
  let catOrder = loadCatOrder(); // ordered category names; reassigned as new folders are seen/reordered
  let recentList = [];
  let knownSet = new Set();       // full paths known to backend, refreshed periodically
  let libraryCache = [];          // last fetched flat list
  let tokenRanges = [];
  const previewCache = new Map(); // name -> {found, lines}

  const root = document.createElement("div");
  root.className = "wg-node";
  root.innerHTML = `
    <div class="wg-toolbar" data-el="toolbar">
      <div class="wg-toolbar-group left">
        <button class="wg-icon-btn" data-act="picker" title="Browse wildcards">&#128193;</button>
        <button class="wg-icon-btn" data-act="edit" title="Edit / create wildcard">&#9998;</button>
        <button class="wg-icon-btn" data-act="refresh" title="Re-scan wildcards directory">&#8635;</button>
        <button class="wg-icon-btn" data-act="undo" title="Undo (Ctrl+Z)">&#8617;</button>
        <button class="wg-icon-btn" data-act="redo" title="Redo (Ctrl+Shift+Z)">&#8618;</button>
      </div>
      <button class="wg-pill wg-pill-resolve" data-act="resolve">Show resolved</button>
      <div class="wg-toolbar-group right">
        <button class="wg-icon-btn" data-act="copy" title="Copy prompt to clipboard">&#128203;</button>
        <button class="wg-icon-btn" data-act="clear" title="Clear prompt">&#128465;</button>
        <button class="wg-icon-btn" data-el="dayNightBtn" data-act="dayNightToggle" title="Toggle day/night theme">&#127769;</button>
        <button class="wg-icon-btn" data-act="settings" title="Settings">&#9881;</button>
      </div>
      <!-- Seed / increment / line-by-line / randomize cluster. Hidden by
           default (see theme.showSeedControls) to keep the toolbar compact;
           when switched on in Settings it lives right here in the same
           toolbar as Show resolved / refresh rather than as a separate
           always-on strip. -->
      <div class="wg-toolbar-extra" data-el="seedbar">
        <span class="wg-seed-label">Seed</span>
        <input type="number" class="wg-seed-input" data-el="seedInput" min="0" step="1" title="Prompt seed">
        <button class="wg-icon-btn" data-act="seedRandomizeNow" title="Roll a new random seed now">&#127922;</button>
        <select class="wg-seed-mode" data-el="seedModeSelect" title="What happens to the seed after each run"></select>
        <select class="wg-seed-mode" data-el="processingModeSelect" title="How multi-line prompts are resolved" style="flex: 0 0 148px;">
          <option value="entire text as one">Entire text as one</option>
          <option value="line by line">Line by line</option>
        </select>
      </div>
    </div>
    <div class="wg-main">
      <div class="wg-drawer left" data-drawer="picker">
        <div class="wg-drawer-inner">
          <h4>Browse wildcards</h4>
          <div class="wg-search"><input type="text" placeholder="Search wildcards..." data-el="search"></div>
          <div class="wg-list" data-el="pickerList"></div>
        </div>
      </div>
      <div class="wg-body">
        <div class="wg-editor-wrap">
          <div class="wg-editor-real" data-el="editorReal">
            <div class="wg-editor-layer wg-highlight" data-el="highlight"></div>
            <textarea class="wg-editor-layer wg-textarea" data-el="textarea" spellcheck="true"></textarea>
          </div>
          <div class="wg-resolved" data-el="resolvedView"></div>
        </div>
        <div class="wg-legend" data-el="legend"></div>
        <div class="wg-footer">
          <span class="wg-hint" data-el="hintLeft">colored by folder</span>
          <span class="wg-hint" data-el="charCount"></span>
          <span class="wg-hint" data-el="hintRight"></span>
        </div>
      </div>
      <div class="wg-drawer right" data-drawer="edit">
        <div class="wg-drawer-inner">
          <div class="wg-drawer-head">
            <h4>Edit wildcard</h4>
            <button class="wg-close-btn" data-act="closeEditDrawer" title="Close">&#10005;</button>
          </div>
          <label>File (txt only, path/name)</label>
          <input type="text" data-el="editName" placeholder="folder/subfolder/name">
          <label>Content (one line per option)</label>
          <textarea data-el="editContent"></textarea>
          <div class="wg-status" data-el="editStatus"></div>
          <div class="wg-drawer-btns">
            <button data-act="delete">Delete</button>
            <button class="primary" data-act="save">Save</button>
          </div>
        </div>
      </div>
    </div>
    <div class="wg-settings-popup" data-el="settingsPopup">
      <div class="wg-settings-head">
        <span>Editor settings</span>
        <button class="wg-close-btn" data-act="closeSettings">&#10005;</button>
      </div>
      <div class="wg-settings-body">
        <details class="wg-settings-section" open>
          <summary>Toolbar</summary>
          <div class="wg-settings-section-body">
            <div class="wg-toggle-row" title="Seed value, seed mode (fixed/increment/decrement/randomize), the randomize-now dice button, and the entire-text/line-by-line select \u2014 shown together in the main toolbar when on.">
              <label style="margin:0;">Show seed &amp; line-by-line controls</label>
              <input type="checkbox" data-el="toggleSeedControls">
            </div>
            <div class="wg-toggle-row" title="A quick toolbar button that flips between your chosen day and night interface themes.">
              <label style="margin:0;">Show day/night toggle button</label>
              <input type="checkbox" data-el="toggleDayNightBtn">
            </div>
            <div class="wg-toggle-row" title="The small ⚡ flyout that appears when hovering a category in the wildcard browser (and when right-clicking a wildcard already in the prompt), for quick-inserting __+/__*/{...} syntax without memorizing it. Turn off for a fully minimal, click-only browsing experience.">
              <label style="margin:0;">Show syntax injector on hover</label>
              <input type="checkbox" data-el="toggleSyntaxInjector">
            </div>
            <div class="wg-srow" style="margin-top:8px;">
              <label>Day theme</label>
              <select class="wg-theme-select" data-el="dayThemeSelect"></select>
            </div>
            <div class="wg-srow">
              <label>Night theme</label>
              <select class="wg-theme-select" data-el="nightThemeSelect"></select>
            </div>
          </div>
        </details>

        <details class="wg-settings-section" open>
          <summary>Accessibility</summary>
          <div class="wg-settings-section-body">
            <div class="wg-srow">
              <label>Font family</label>
              <input type="text" class="wg-theme-select" data-el="fontFamilyInput" list="wg-font-suggestions"
                     placeholder="Leave blank for default (monospace editor / system UI font)">
              <datalist id="wg-font-suggestions">
                <option value="Atkinson Hyperlegible">
                <option value="OpenDyslexic">
                <option value="Arial">
                <option value="Verdana">
                <option value="Tahoma">
                <option value="Segoe UI">
                <option value="Georgia">
                <option value="Consolas">
                <option value="Cascadia Code">
                <option value="Courier New">
              </datalist>
              <div class="wg-drawer-btns" style="margin-top:6px;">
                <button data-act="fontBrowseLocal" title="Pick from fonts actually installed on your system (Chrome/Edge only)">Browse installed fonts&#8230;</button>
                <button data-act="fontClear" title="Clear override, use built-in default fonts">Use default</button>
              </div>
              <div class="wg-status" data-el="fontStatus"></div>
            </div>
            <div class="wg-srow">
              <div class="wg-rowline"><label style="margin:0;">Prompt text size</label><span data-el="editorFontOut">12.5px</span></div>
              <input type="range" class="wg-range" data-el="editorFontRange" min="10" max="28" step="0.5" value="12.5">
            </div>
            <div class="wg-srow">
              <div class="wg-rowline"><label style="margin:0;">Folder / sidebar text size</label><span data-el="uiFontOut">100%</span></div>
              <input type="range" class="wg-range" data-el="uiFontRange" min="80" max="200" step="5" value="100">
            </div>
            <div class="wg-srow">
              <label>Prompt text color <span style="opacity:.6;">(plain text, not wildcard tokens)</span></label>
              <input type="color" data-el="promptTextColor" value="#e8e2d4">
            </div>
          </div>
        </details>

        <details class="wg-settings-section" open>
          <summary>Interface theme</summary>
          <div class="wg-settings-section-body">
            <div class="wg-srow">
              <select class="wg-theme-select" data-el="uiThemeSelect"></select>
            </div>
            <div class="wg-swatch-grid" data-el="uiThemeSwatches"></div>
            <div class="wg-drawer-btns" style="margin-top:6px;">
              <button data-act="uiThemeNew" title="Duplicate the current theme as an editable copy">New</button>
              <button data-act="uiThemeRename" title="Rename the current custom theme">Rename</button>
              <button data-act="uiThemeDelete" title="Delete the current custom theme">Delete</button>
            </div>
            <div class="wg-drawer-btns" style="margin-top:4px;">
              <button data-act="uiThemeImport">Import JSON</button>
              <button data-act="uiThemeExport">Export JSON</button>
            </div>
            <div class="wg-status" data-el="uiThemeStatus"></div>
          </div>
        </details>

        <details class="wg-settings-section">
          <summary>Wildcard token colors</summary>
          <div class="wg-settings-section-body">
            <div class="wg-srow">
              <div class="wg-rowline"><label style="margin:0;">Hue rotation</label><span data-el="hueOut">0°</span></div>
              <input type="range" class="wg-range" data-el="hueRange" min="0" max="359" value="0">
            </div>
            <div class="wg-srow">
              <div class="wg-rowline"><label style="margin:0;">Color intensity</label><span data-el="satOut">65%</span></div>
              <input type="range" class="wg-range" data-el="satRange" min="30" max="90" step="5" value="65">
            </div>
          </div>
        </details>

        <details class="wg-settings-section">
          <summary>Category colors</summary>
          <div class="wg-settings-section-body">
            <div data-el="catPins"></div>
          </div>
        </details>

        <details class="wg-settings-section">
          <summary>Import / export token theme</summary>
          <div class="wg-settings-section-body">
            <div class="wg-theme-export"><textarea data-el="themeJson" readonly></textarea></div>
            <button class="wg-pill" data-act="copyTheme">Copy JSON</button>
            <button class="wg-pill" data-act="pasteTheme">Paste + apply</button>
            <button class="wg-pill" data-act="resetTheme">Reset</button>
          </div>
        </details>

        <details class="wg-settings-section">
          <summary>Inputs &amp; outputs</summary>
          <div class="wg-settings-section-body">
            <div style="font-size:9px; color:var(--wg-text-faint,#8a836f); line-height:1.5; margin-bottom:6px;">Turn on any socket you want to wire up. Connect CLIP to turn this into a live encoder that outputs CONDITIONING directly instead of just text; add MODEL alongside it and any &lt;lora:name:weight&gt; tags in the prompt (typed directly or hidden in a wildcard file) get loaded, applied, and stripped out automatically. Everything else here \u2014 prefixes, negative prompt, enhancer override, etc. \u2014 is just extra wiring flexibility. Nothing is required; the node works the same with everything off.</div>
            <div class="wg-rowline" style="margin:2px 0 4px;"><label style="margin:0; color:var(--wg-text-dim,#c9c2b1); font-size:9px; text-transform:uppercase; letter-spacing:.05em;">Optional inputs</label></div>
            <div data-el="ioInputToggles"></div>
            <div class="wg-rowline" style="margin:10px 0 4px;"><label style="margin:0; color:var(--wg-text-dim,#c9c2b1); font-size:9px; text-transform:uppercase; letter-spacing:.05em;">Optional outputs</label></div>
            <div data-el="ioOutputToggles"></div>
          </div>
        </details>
      </div>
      <div class="wg-settings-footer">
        <a class="wg-credit-link" href="https://github.com/z3rofeels/comfyui-promptpalette" target="_blank" rel="noopener noreferrer" title="comfyui-promptpalette on GitHub">
          <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>
          <span>Made by <strong>z3rofeels</strong></span>
        </a>
      </div>
    </div>
  `;

  const el = sel => root.querySelector(`[data-el="${sel}"]`);
  const textarea = el("textarea");
  const highlight = el("highlight");
  const legend = el("legend");
  const pickerDrawer = root.querySelector('[data-drawer="picker"]');
  const editDrawer = root.querySelector('[data-drawer="edit"]');
  const settingsPopup = el("settingsPopup");
  const editorReal = el("editorReal");
  const resolvedView = el("resolvedView");
  const hintRight = el("hintRight");
  const seedInput = el("seedInput");
  const seedModeSelect = el("seedModeSelect");
  const processingModeSelect = el("processingModeSelect");

  // ---- pull seed / control-after-generate / processing_mode off the node body into this UI ----
  // All three are still real LiteGraph widgets underneath (so queueing/serialization
  // work exactly as before) — we just hide their canvas-drawn rows and mirror
  // their values into these DOM controls instead.
  const seedWidget = node.widgets.find(w => w.name === "seed");
  const controlWidget =
    (seedWidget && seedWidget.linkedWidgets && seedWidget.linkedWidgets[0]) ||
    node.widgets.find(w => w !== seedWidget && /control.*generate/i.test(w.name || ""));
  const modeWidget = node.widgets.find(w => w.name === "processing_mode");
  [seedWidget, controlWidget, modeWidget].forEach(w => {
    if (!w) return;
    w.type = "hidden";
    w.computeSize = () => [0, -4];
    // Belt-and-suspenders: on some LiteGraph/ComfyUI frontend builds, type
    // "hidden" isn't a recognized skip-case for canvas-drawn (non-DOM)
    // widgets like these — it just falls through to default rendering,
    // which is what caused the leftover "processing_mode" row bleeding
    // through behind the DOM UI. A no-op draw() is honored ahead of any
    // type switch in every LiteGraph version, so this guarantees nothing
    // paints for these three regardless of frontend version.
    w.draw = () => {};
    if (w.inputEl) w.inputEl.style.display = "none";
  });
  if (modeWidget) {
    processingModeSelect.addEventListener("change", () => {
      modeWidget.value = processingModeSelect.value;
      if (typeof modeWidget.callback === "function") modeWidget.callback(modeWidget.value, node.graph?.canvas, node);
      node.graph?.setDirtyCanvas(true, true);
      if (resolvedView.classList.contains("on")) refreshResolvedView();
    });
  } else {
    processingModeSelect.disabled = true;
  }

  const SEED_MODE_LABELS = {
    fixed: "Fixed \u2014 lock this prompt's seed",
    increment: "Increment \u2014 +1 each run",
    decrement: "Decrement \u2014 \u22121 each run",
    randomize: "Randomize \u2014 new seed each run",
  };
  function syncSeedControlsFromWidgets() {
    if (seedWidget) seedInput.value = seedWidget.value;
    if (controlWidget) {
      const values = (controlWidget.options && controlWidget.options.values) || ["fixed", "increment", "decrement", "randomize"];
      if (seedModeSelect.dataset.built !== "1") {
        seedModeSelect.innerHTML = values.map(v => `<option value="${escapeHtml(v)}">${escapeHtml(SEED_MODE_LABELS[v] || v)}</option>`).join("");
        seedModeSelect.dataset.built = "1";
      }
      seedModeSelect.value = controlWidget.value;
    } else {
      seedModeSelect.style.display = "none"; // no control widget found on this node/ComfyUI version — degrade gracefully
    }
    if (modeWidget) processingModeSelect.value = modeWidget.value;
  }
  if (seedWidget) {
    seedInput.addEventListener("input", () => {
      if (seedInput.value === "") return;
      seedWidget.value = Number(seedInput.value);
      if (typeof seedWidget.callback === "function") seedWidget.callback(seedWidget.value, node.graph?.canvas, node);
      node.graph?.setDirtyCanvas(true, true);
    });
  } else {
    el("seedbar").querySelectorAll("input,button,select").forEach(x => x.disabled = true);
  }
  if (controlWidget) {
    seedModeSelect.addEventListener("change", () => {
      controlWidget.value = seedModeSelect.value;
      if (typeof controlWidget.callback === "function") controlWidget.callback(controlWidget.value, node.graph?.canvas, node);
      node.graph?.setDirtyCanvas(true, true);
    });
  }
  root.querySelector('[data-act="seedRandomizeNow"]').addEventListener("click", () => {
    if (!seedWidget) return;
    const maxSeed = Number.MAX_SAFE_INTEGER; // native widget's real ceiling is 2^64-1, but JS numbers only carry 2^53-1 safely
    const randomSeed = Math.floor(Math.random() * maxSeed);
    seedWidget.value = randomSeed;
    seedInput.value = randomSeed;
    if (typeof seedWidget.callback === "function") seedWidget.callback(randomSeed, node.graph?.canvas, node);
    node.graph?.setDirtyCanvas(true, true);
  });
  syncSeedControlsFromWidgets();

  // ---- optional inputs/outputs: toggleable sockets for piping in other nodes ----
  // Every socket here is already declared (as optional) in the Python node's
  // INPUT_TYPES/RETURN_TYPES, so the backend always accepts them — what these
  // toggles control is purely whether the socket is *visible* on this node
  // instance, via LiteGraph's own addInput/removeInput/addOutput/removeOutput.
  // State is per-node (node.properties), not a global editor preference like
  // the theme/font settings, since which sockets you want wired up is a
  // per-node-instance choice.
  const IO_INPUT_DEFS = [
    { key: "clip", type: "CLIP", label: "CLIP", desc: "Connect to turn this node into a live encoder \u2014 the resolved prompt and negative prompt get encoded into CONDITIONING via this CLIP instead of only being returned as text." },
    { key: "model", type: "MODEL", label: "Model", desc: "Connect alongside CLIP to enable <lora:name:weight> tags, typed directly or hidden inside a wildcard file's entry. Any found are loaded, applied to the model/clip, and stripped out of the text before it's encoded. Without a MODEL connected, LoRA tags are left as literal text." },
    { key: "prompt_prefix", type: "STRING", label: "Prompt prefix", desc: "Prepend externally-supplied text (resolved for wildcards too) before this node's own prompt \u2014 e.g. a shared style-preset text node." },
    { key: "prompt_suffix", type: "STRING", label: "Prompt suffix", desc: "Append externally-supplied text (resolved for wildcards too) after this node's own prompt." },
    { key: "enhancer_override", type: "STRING", label: "LLM / enhancer override", desc: "If connected and non-empty, this completely replaces the resolved prompt output \u2014 wire in an LLM prompt-enhancer node here." },
    { key: "external_seed", type: "INT", label: "External seed", desc: "Drive wildcard resolution from another node's seed instead of this node's own Seed control above." },
    { key: "negative_text", type: "STRING", label: "Negative prompt (text)", desc: "A second wildcard-aware text block, resolved independently and returned as its own negative_prompt output." },
    { key: "negative_prefix", type: "STRING", label: "Negative prefix", desc: "Prepend externally-supplied text (resolved for wildcards too) before the negative prompt \u2014 mirrors Prompt prefix but for the negative side." },
    { key: "negative_suffix", type: "STRING", label: "Negative suffix", desc: "Append externally-supplied text (resolved for wildcards too) after the negative prompt \u2014 mirrors Prompt suffix but for the negative side." },
  ];
  const IO_OUTPUT_DEFS = [
    { key: "model", type: "MODEL", label: "Model (passthrough)", desc: "The connected Model, passed through \u2014 patched with any LoRAs pulled from <lora:...> tags this run if CLIP was also connected, otherwise unchanged. None if no Model is connected." },
    { key: "clip", type: "CLIP", label: "CLIP (passthrough)", desc: "The connected CLIP, passed through \u2014 patched alongside Model above if LoRAs were applied, otherwise unchanged. None if no CLIP is connected." },
    { key: "conditioning", type: "CONDITIONING", label: "Conditioning", desc: "The resolved prompt encoded via the connected CLIP. None unless a CLIP input is connected." },
    { key: "negative_conditioning", type: "CONDITIONING", label: "Negative conditioning", desc: "The resolved negative prompt encoded via the connected CLIP. None unless a CLIP input is connected." },
    { key: "negative_prompt", type: "STRING", label: "Negative prompt", desc: "Resolved text from the Negative prompt input above." },
    { key: "seed_out", type: "INT", label: "Seed used", desc: "The seed actually used to resolve this run \u2014 feed straight into a sampler's seed input." },
    { key: "wildcards_used", type: "STRING", label: "Wildcards used (JSON)", desc: "A JSON list of every wildcard file name that got picked this run, for logging/debugging." },
    { key: "raw_text", type: "STRING", label: "Raw text (unresolved)", desc: "Passthrough of exactly what's typed into this node, before any wildcard resolution \u2014 handy for logging or diffing against the resolved prompt." },
    { key: "wildcards_used_count", type: "INT", label: "Wildcards used (count)", desc: "How many distinct wildcard files were picked this run \u2014 wire straight into a counter/logic node instead of parsing the JSON list." },
    { key: "used_enhancer", type: "BOOLEAN", label: "Used enhancer override", desc: "True if the LLM / enhancer override input was connected and non-empty this run, so it replaced the wildcard-resolved prompt." },
  ];

  node.properties = node.properties || {};
  node.properties.wg_io = node.properties.wg_io || { inputs: {}, outputs: {} };
  // Read via a live getter rather than caching the object: ComfyUI's node.configure()
  // (fired when a saved workflow loads) replaces node.properties wholesale *after*
  // onNodeCreated has already built this UI, so a cached reference would silently
  // go stale on reload. Always going through node.properties.wg_io picks up
  // whatever object is current, and self-heals if configure() ever hands back
  // something missing the inputs/outputs sub-keys.
  function ioState() {
    const s = node.properties.wg_io || (node.properties.wg_io = { inputs: {}, outputs: {} });
    s.inputs = s.inputs || {};
    s.outputs = s.outputs || {};
    return s;
  }

  function socketIndex(list, name) {
    return (list || []).findIndex(s => s.name === name);
  }
  function syncIoSocket(kind, def, enabled) {
    const list = kind === "input" ? node.inputs : node.outputs;
    const idx = socketIndex(list, def.key);
    if (enabled && idx === -1) {
      if (kind === "input") node.addInput(def.key, def.type);
      else node.addOutput(def.key, def.type);
    } else if (!enabled && idx !== -1) {
      if (kind === "input") node.removeInput(idx);
      else node.removeOutput(idx);
    }
    node.graph?.setDirtyCanvas(true, true);
  }
  function renderIoToggles() {
    const inWrap = el("ioInputToggles");
    const outWrap = el("ioOutputToggles");
    inWrap.innerHTML = "";
    IO_INPUT_DEFS.forEach(def => {
      const row = document.createElement("div");
      row.className = "wg-toggle-row";
      row.title = def.desc;
      row.innerHTML = `<label style="margin:0;">${escapeHtml(def.label)}</label><input type="checkbox" data-io-in="${def.key}">`;
      const cb = row.querySelector("input");
      cb.checked = !!ioState().inputs[def.key];
      cb.addEventListener("change", () => {
        ioState().inputs[def.key] = cb.checked;
        syncIoSocket("input", def, cb.checked);
      });
      inWrap.appendChild(row);
    });
    outWrap.innerHTML = "";
    IO_OUTPUT_DEFS.forEach(def => {
      const row = document.createElement("div");
      row.className = "wg-toggle-row";
      row.title = def.desc;
      row.innerHTML = `<label style="margin:0;">${escapeHtml(def.label)}</label><input type="checkbox" data-io-out="${def.key}">`;
      const cb = row.querySelector("input");
      cb.checked = !!ioState().outputs[def.key];
      cb.addEventListener("change", () => {
        ioState().outputs[def.key] = cb.checked;
        syncIoSocket("output", def, cb.checked);
      });
      outWrap.appendChild(row);
    });
  }
  renderIoToggles();
  // Backend declares all optional sockets, so LiteGraph auto-creates slots for
  // every one of them the moment the node is built. Strip anything the saved
  // toggle state says should be off (all of them, on a brand-new node) so the
  // node starts clean with just the always-on "prompt" output.
  IO_INPUT_DEFS.forEach(def => syncIoSocket("input", def, !!ioState().inputs[def.key]));
  IO_OUTPUT_DEFS.forEach(def => syncIoSocket("output", def, !!ioState().outputs[def.key]));

  // Re-render the toggle checkboxes and re-sync sockets against whatever
  // node.properties.wg_io turns out to be after ComfyUI restores a saved
  // workflow (see the ioState() comment above) — otherwise the checkboxes
  // would show everything unchecked even though the sockets themselves
  // (serialized separately as node.inputs/outputs) came back correctly.
  node._wgRefreshIoToggles = function () {
    renderIoToggles();
    IO_INPUT_DEFS.forEach(def => syncIoSocket("input", def, !!ioState().inputs[def.key]));
    IO_OUTPUT_DEFS.forEach(def => syncIoSocket("output", def, !!ioState().outputs[def.key]));
  };

  let hoverTip = document.querySelector(".wg-tip");
  if (!hoverTip) {
    hoverTip = document.createElement("div");
    hoverTip.className = "wg-tip";
    document.body.appendChild(hoverTip);
  }

  function buildCategoryColorMap(categoriesInUse) {
    const hues = {};
    categoriesInUse.forEach(cat => { hues[cat] = theme.categoryPins[cat] ? null : (hashStr(cat) % 360 + theme.hueRotate) % 360; });
    const entries = Object.entries(hues).filter(([, v]) => v !== null);
    entries.sort((a, b) => a[1] - b[1]);
    for (let i = 1; i < entries.length; i++) {
      if (entries[i][1] - entries[i - 1][1] < 20) entries[i][1] = entries[i - 1][1] + 20;
    }
    entries.forEach(([cat, hue]) => { hues[cat] = hue % 360; });
    return hues;
  }
  function colorForToken(name, categoryHueMap) {
    const cat = categoryOf(name);
    if (theme.categoryPins[cat]) return theme.categoryPins[cat];
    const hue = categoryHueMap[cat] !== undefined ? categoryHueMap[cat] : (hashStr(cat) % 360 + theme.hueRotate) % 360;
    const leaf = name.split("/").pop();
    const shadeShift = (hashStr(leaf) % 20) - 10;
    return `hsl(${hue}, ${theme.saturation}%, ${Math.min(78, Math.max(52, 66 + shadeShift))}%)`;
  }
  function isKnown(name) {
    return knownSet.has(name) || Array.from(knownSet).some(n => n.split("/").pop() === name.split("/").pop());
  }
  function extractWildcardNames(text) {
    const names = new Set(); const re = /__[+*]?([A-Za-z0-9_\-\/]+)__/g; let m;
    while ((m = re.exec(text))) names.add(m[1]);
    return Array.from(names);
  }
  function highlightText(text) {
    const names = extractWildcardNames(text);
    const categoriesInUse = Array.from(new Set(names.map(categoryOf)));
    const categoryHueMap = buildCategoryColorMap(categoriesInUse);
    let out = ""; let i = 0; const ranges = [];
    while (i < text.length) {
      const rest = text.slice(i);
      const wildcardMatch = rest.match(/^__[+*]?[A-Za-z0-9_\-\/]+__/);
      if (wildcardMatch) {
        const token = wildcardMatch[0];
        const innerName = token.replace(/^__[+*]?/, "").replace(/__$/, "");
        const start = i, end = i + token.length;
        if (isKnown(innerName)) {
          const color = colorForToken(innerName, categoryHueMap);
          out += `<span class="wg-token" style="color:${color}; font-weight:600;">${escapeHtml(token)}</span>`;
          ranges.push({ start, end, name: innerName, known: true });
        } else {
          out += `<span class="wg-tok-error">${escapeHtml(token)}</span>`;
          ranges.push({ start, end, name: innerName, known: false });
        }
        i = end; continue;
      }
      const weightMatch = rest.match(/^\d+::/);
      if (weightMatch) { out += `<span class="wg-tok-weight">${escapeHtml(weightMatch[0])}</span>`; i += weightMatch[0].length; continue; }
      const quantMatch = rest.match(/^(\d+(-\d+)?\$\$[^$]*\$\$|\d+#)/);
      if (quantMatch) { out += `<span class="wg-tok-mod">${escapeHtml(quantMatch[0])}</span>`; i += quantMatch[0].length; continue; }
      const ch = text[i];
      if (ch === "{" || ch === "}") { out += `<span class="wg-tok-bracket">${ch}</span>`; i++; continue; }
      if (ch === "|") { out += `<span class="wg-tok-pipe">|</span>`; i++; continue; }
      if (ch === "#" && (i === 0 || text[i - 1] === "\n")) {
        const lineEnd = text.indexOf("\n", i);
        const line = lineEnd === -1 ? text.slice(i) : text.slice(i, lineEnd);
        out += `<span class="wg-tok-comment">${escapeHtml(line)}</span>`; i += line.length; continue;
      }
      out += escapeHtml(ch); i++;
    }
    tokenRanges = ranges;
    return { html: out, names, categoriesInUse, categoryHueMap };
  }

  function syncHiddenWidget() {
    hiddenWidget.value = textarea.value;
    if (typeof hiddenWidget.callback === "function") hiddenWidget.callback(hiddenWidget.value);
    // Belt-and-suspenders: some ComfyUI frontend versions mis-align widgets_values
    // (a positional array) when a DOM widget sits alongside a hidden text widget,
    // which silently wipes hiddenWidget.value on tab switch / workflow reload.
    // node.properties is serialized as a plain keyed object and isn't subject to
    // that indexing issue, so mirror the text there as a reliable fallback.
    node.properties = node.properties || {};
    node.properties.wg_text = textarea.value;
    node.graph?.setDirtyCanvas(true, true);
  }

  function refreshFromHidden() {
    // Re-hydrate the visible textarea after ComfyUI reconfigures this node
    // (workflow tab switch, undo/redo, page reload). Prefer node.properties
    // since it's the more reliable store; fall back to the widget value.
    const restored =
      (node.properties && typeof node.properties.wg_text === "string" && node.properties.wg_text) ||
      hiddenWidget.value ||
      "";
    if (restored !== textarea.value) {
      textarea.value = restored;
      // Bypass the generic change-tracking below for this one — it's a
      // workflow-level restore, not an edit the user made in this session,
      // so it shouldn't itself become an undo step, and any undo/redo
      // history from before the restore no longer applies to what's here.
      lastKnownValue = restored;
      undoStack = [];
      redoStack = [];
      burstStartValue = null;
      clearTimeout(burstTimer);
      render();
    }
    syncSeedControlsFromWidgets();
  }

  // ---- lightweight undo/redo ---------------------------------------------
  // Every programmatic edit in this file (wildcard insert, Syntax Injector
  // commit, "__" autocomplete commit, Ctrl+1/2/3 wrap, Clear) sets
  // textarea.value directly — which, unlike typing, pasting, or
  // document.execCommand, does NOT feed the browser's native undo stack.
  // That silently breaks Ctrl+Z the moment any of those run, which given how
  // central "click to insert" is here would otherwise make undo useless
  // almost immediately. Rather than hunt down and touch every call site that
  // mutates textarea.value, this hooks the one chokepoint they already all
  // funnel through — render() — and diffs against the last known value
  // there, so it catches typed edits and programmatic ones alike with no
  // per-call-site plumbing. Scoped locally (not module-level like the
  // shared inject/ctx menus above) since each node's prompt needs its own
  // independent history.
  let undoStack = [];
  let redoStack = [];
  let lastKnownValue = textarea.value;
  let burstStartValue = null;   // pre-edit value for the in-progress coalesced typing burst, if any
  let burstTimer = null;
  const UNDO_COALESCE_MS = 600; // pause length that ends a "burst" of rapid typing as one undo step
  const UNDO_LIMIT = 100;       // cap so a long editing session can't grow this unbounded

  function flushUndoBurst() {
    clearTimeout(burstTimer);
    if (burstStartValue === null) return;
    undoStack.push(burstStartValue);
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    burstStartValue = null;
  }

  function noteValueChange() {
    const current = textarea.value;
    if (current === lastKnownValue) return;
    if (burstStartValue === null) burstStartValue = lastKnownValue;
    redoStack = []; // any new edit invalidates whatever was available to redo
    lastKnownValue = current;
    clearTimeout(burstTimer);
    burstTimer = setTimeout(flushUndoBurst, UNDO_COALESCE_MS);
  }

  function updateUndoRedoButtons() {
    if (undoBtn) undoBtn.disabled = !(undoStack.length || burstStartValue !== null);
    if (redoBtn) redoBtn.disabled = !redoStack.length;
  }

  function performUndo() {
    flushUndoBurst();
    if (!undoStack.length) return;
    redoStack.push(textarea.value);
    const prev = undoStack.pop();
    textarea.value = prev;
    lastKnownValue = prev;
    textarea.selectionStart = textarea.selectionEnd = prev.length;
    textarea.focus();
    render();
  }

  function performRedo() {
    flushUndoBurst(); // a stray pending burst can't be redone over — discard it
    if (!redoStack.length) return;
    undoStack.push(textarea.value);
    const next = redoStack.pop();
    textarea.value = next;
    lastKnownValue = next;
    textarea.selectionStart = textarea.selectionEnd = next.length;
    textarea.focus();
    render();
  }

  function render() {
    noteValueChange();
    const { html, names, categoriesInUse, categoryHueMap } = highlightText(textarea.value);
    highlight.innerHTML = html + "\n";
    legend.innerHTML = "";
    categoriesInUse.forEach(cat => {
      const color = theme.categoryPins[cat] || `hsl(${categoryHueMap[cat]}, ${theme.saturation}%, 66%)`;
      const shape = "border-radius:50%;";
      const chip = document.createElement("div");
      chip.className = "wg-chip";
      chip.innerHTML = `<span class="wg-sw" style="background:${color}; ${shape}"></span>${escapeHtml(cat)}`;
      legend.appendChild(chip);
    });
    const knownCount = names.filter(isKnown).length;
    const missingCount = names.length - knownCount;
    hintRight.textContent = `${knownCount} resolved-ready \u00b7 ${missingCount} missing`;
    hintRight.classList.toggle("wg-hint-clickable", missingCount > 0);
    hintRight.title = missingCount > 0 ? "Click to jump to the next missing wildcard" : "";
    const len = textarea.value.length;
    el("charCount").textContent = `${len.toLocaleString()} char${len === 1 ? "" : "s"}`;
    syncHiddenWidget();
    if (resolvedView.classList.contains("on")) refreshResolvedView();
    updateThemeJson();
    updateUndoRedoButtons();
  }

  async function refreshResolvedView() {
    const seed = seedWidget ? seedWidget.value : 0;
    const mode = modeWidget ? modeWidget.value : "entire text as one";
    resolvedView.textContent = "resolving...";
    try {
      const resolved = await API.resolve(textarea.value, seed, mode);
      resolvedView.textContent = resolved;
    } catch (e) {
      resolvedView.textContent = "(failed to resolve — is ComfyUI running with this node's server routes loaded?)";
    }
  }

  textarea.addEventListener("input", render);
  textarea.addEventListener("scroll", () => { highlight.scrollTop = textarea.scrollTop; highlight.scrollLeft = textarea.scrollLeft; });

  // Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y — custom undo/redo (see block above
  // render()). preventDefault() so this fully replaces the browser's native
  // textarea undo rather than racing it; native undo can't see the
  // programmatic edits anyway; this one covers those and typing alike.
  textarea.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const key = e.key.toLowerCase();
    if (key === "z" && e.shiftKey) { e.preventDefault(); performRedo(); }
    else if (key === "z") { e.preventDefault(); performUndo(); }
    else if (key === "y") { e.preventDefault(); performRedo(); }
  });

  // ---- hover preview (approximate monospace hit-test) ----
  function charIndexFromEvent(e) {
    const cs = getComputedStyle(textarea);
    const lineH = parseFloat(cs.lineHeight) || 20;
    const padT = parseFloat(cs.paddingTop) || 8;
    const padL = parseFloat(cs.paddingLeft) || 10;
    const charW = 7.4;
    const rect = textarea.getBoundingClientRect();
    const x = e.clientX - rect.left + textarea.scrollLeft - padL;
    const y = e.clientY - rect.top + textarea.scrollTop - padT;
    const row = Math.max(0, Math.floor(y / lineH));
    const col = Math.max(0, Math.round(x / charW));
    const lines = textarea.value.split("\n");
    if (row >= lines.length) return -1;
    let idx = 0;
    for (let i = 0; i < row; i++) idx += lines[i].length + 1;
    return idx + Math.min(col, lines[row].length);
  }
  async function showTipForName(x, y, name, known) {
    let entry = previewCache.get(name);
    if (!entry) {
      entry = await API.preview(name);
      previewCache.set(name, entry);
    }
    const lines = (entry.lines || []).slice(0, 4);
    hoverTip.innerHTML = `<div class="wg-tip-title">${escapeHtml(known ? name : name + " (not found)")}</div>` +
      (lines.length ? lines.map(l => `<div class="wg-tip-line">${escapeHtml(l)}</div>`).join("") :
        `<div class="wg-tip-line">${known ? "no preview available" : "file missing"}</div>`);
    hoverTip.style.left = (x + 14) + "px";
    hoverTip.style.top = (y + 14) + "px";
    hoverTip.style.display = "block";
  }
  function hideTip() { hoverTip.style.display = "none"; }
  let hoverDebounce = null;
  textarea.addEventListener("mousemove", (e) => {
    const idx = charIndexFromEvent(e);
    const tok = tokenRanges.find(t => idx >= t.start && idx < t.end);
    clearTimeout(hoverDebounce);
    if (tok) {
      hoverDebounce = setTimeout(() => showTipForName(e.clientX, e.clientY, tok.name, tok.known), 120);
    } else hideTip();
  });
  textarea.addEventListener("mouseleave", hideTip);

  // ---- picker drawer ----
  const searchInput = el("search");
  const pickerList = el("pickerList");
  // Keyboard nav through the currently-rendered picker rows (Up/Down/Enter
  // from the search box — see the searchInput keydown listener below).
  // -1 means "nothing highlighted yet". Reset to -1 on every re-render since
  // the row that used to be at a given index may no longer be the same item.
  let pickerKbIndex = -1;
  function pickerRows() { return Array.from(pickerList.querySelectorAll(".wg-item")); }
  function movePickerKbIndex(delta) {
    const rows = pickerRows();
    rows.forEach(r => r.classList.remove("wg-kb-active"));
    if (!rows.length) { pickerKbIndex = -1; return; }
    pickerKbIndex = pickerKbIndex === -1
      ? (delta > 0 ? 0 : rows.length - 1)
      : (pickerKbIndex + delta + rows.length) % rows.length;
    const row = rows[pickerKbIndex];
    row.classList.add("wg-kb-active");
    row.scrollIntoView({ block: "nearest" });
  }

  function insertWildcard(path) {
    const tag = `__${path}__`;
    const pos = textarea.selectionStart ?? textarea.value.length;
    const before = textarea.value.slice(0, pos);
    const after = textarea.value.slice(pos);
    // Auto-append a ", " separator right after the inserted tag so wildcards
    // can be clicked in one after another without the user manually typing a
    // separator in between each time. Skipped when a comma already follows
    // (optionally after some whitespace) — e.g. inserting mid-prompt, just
    // before existing punctuation — so this never produces a doubled ",," or
    // stacks a second separator next to one that's already there.
    const alreadySeparated = /^\s*,/.test(after);
    const insertText = alreadySeparated ? tag : tag + ", ";
    textarea.value = before + insertText + after;
    textarea.focus();
    textarea.selectionStart = textarea.selectionEnd = pos + insertText.length;
    recentList = [path, ...recentList.filter(p => p !== path)].slice(0, 8);
    render();
    renderPickerList(searchInput.value);
  }

  // ---- "__" wildcard autocomplete ----
  // Reads this node's own live `knownSet` — the same set hydrated by
  // refreshLibrary() on load and re-hydrated whenever the user hits the
  // refresh button (via node.updateWildcardSidePanels below). There's no
  // separate list to keep in sync: whatever the picker drawer/legend
  // already know about is exactly what this dropdown offers.
  function getAcMatches(query) {
    const q = query.toLowerCase();
    const matches = Array.from(knownSet).filter(p => p.toLowerCase().includes(q));
    // Prefer paths where the query matches at a path/leaf boundary (e.g. "sty"
    // matching "style/cyberpunk" beats it matching mid-word), then alphabetical.
    const rank = p => {
      const leaf = p.split("/").pop().toLowerCase();
      if (leaf.startsWith(q)) return 0;
      if (p.toLowerCase().startsWith(q)) return 1;
      return 2;
    };
    matches.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    return matches.slice(0, 20); // cap so the dropdown can't grow into a full-list scroll
  }

  function commitAcItem(path) {
    recentList = [path, ...recentList.filter(p => p !== path)].slice(0, 8);
    render();
    renderPickerList(searchInput.value);
  }

  textarea.addEventListener("input", () => {
    const fragment = findWildcardFragment(textarea.value, textarea.selectionStart);
    if (!fragment) return closeAcMenu();
    openOrUpdateAcMenu(textarea, fragment, getAcMatches, commitAcItem);
  });

  textarea.addEventListener("keydown", (e) => {
    if (!acState || acState.textarea !== textarea) return;
    const count = acState.items.length;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      acState.activeIndex = count ? (acState.activeIndex + 1) % count : 0;
      renderAcMenu();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      acState.activeIndex = count ? (acState.activeIndex - 1 + count) % count : 0;
      renderAcMenu();
    } else if (e.key === "Enter" || e.key === "Tab") {
      if (!count) return; // nothing to complete — let the key behave normally
      e.preventDefault();
      e.stopPropagation();
      commitAcSelection(acState.activeIndex);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeAcMenu();
    }
  });

  // Arrow/click can move the caret out of the fragment being completed
  // without firing "input" — recheck and close the menu when that happens.
  function recheckAcOnCaretMove() {
    if (!acState || acState.textarea !== textarea) return;
    const fragment = findWildcardFragment(textarea.value, textarea.selectionStart);
    if (!fragment || fragment.start !== acState.start) closeAcMenu();
  }
  textarea.addEventListener("keyup", (e) => {
    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) recheckAcOnCaretMove();
  });
  textarea.addEventListener("click", recheckAcOnCaretMove);

  // ---- Ctrl+1/2/3 formatting shortcuts ----
  // Placeholder wrap syntax — swap the open/close strings for whatever your
  // UI actually uses (e.g. weight/emphasis tags, [color1][/color1]-style
  // spans, etc). e.code (not e.key) is used so this keys off physical
  // "1"/"2"/"3" regardless of keyboard layout (AZERTY, etc).
  const WRAP_SYNTAX = {
    Digit1: { open: "[color1]", close: "[/color1]" }, // Syntax A
    Digit2: { open: "[color2]", close: "[/color2]" }, // Syntax B
    Digit3: { open: "[color3]", close: "[/color3]" }, // Syntax C
  };
  // Listening on `textarea` itself (rather than document/window) is what
  // scopes this to just this node's widget — the handler physically can't
  // fire unless this textarea has focus, so it never competes with other
  // nodes' widgets or with LiteGraph's own canvas-level shortcuts. The
  // stopPropagation() below is just belt-and-suspenders on top of that.
  textarea.addEventListener("keydown", (e) => {
    if (!e.ctrlKey || e.altKey) return; // Ctrl-only, as specified — extend to e.metaKey too if you want it to also work as Cmd+1/2/3 on macOS
    const pair = WRAP_SYNTAX[e.code];
    if (!pair) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    if (start === end) return; // nothing selected — let the key fall through untouched
    e.preventDefault();
    e.stopPropagation();
    const selected = textarea.value.slice(start, end);
    textarea.value = textarea.value.slice(0, start) + pair.open + selected + pair.close + textarea.value.slice(end);
    // Re-select just the original text (not the new tags), matching the
    // usual "wrap selection" UX so another shortcut can be stacked right away.
    textarea.selectionStart = start + pair.open.length;
    textarea.selectionEnd = start + pair.open.length + selected.length;
    textarea.focus();
    render(); // keep highlight/hidden-widget/legend in sync, same as any other programmatic edit in this file
  });

  function pickerRow(item, filter = "") {
    const cat = categoryOf(item.path);
    const color = theme.categoryPins[cat] || `hsl(${(hashStr(cat) % 360 + theme.hueRotate) % 360}, ${theme.saturation}%, 66%)`;
    const shape = "border-radius:50%;";
    const isPinned = pinned.has(item.path);
    const row = document.createElement("div");
    row.className = "wg-item";
    // Type badge removed here — the Syntax Injector trigger now lives in its
    // place (see below), keyed off the item's full path rather than its
    // category. Wrapping for long names is handled by .wg-item .wg-name in
    // wildcard_editor.css. The displayed name (last path segment) gets its
    // matched substring highlighted when a search filter is active.
    row.innerHTML = `<span class="wg-sw" style="background:${color}; ${shape}"></span><span class="wg-name">${highlightMatch(item.path.split("/").pop(), filter)}</span><span class="wg-pin ${isPinned ? "pinned" : ""}">${isPinned ? "\u2605" : "\u2606"}</span>`;
    row.querySelector(".wg-name").addEventListener("click", () => insertWildcard(item.path));
    row.querySelector(".wg-sw").addEventListener("click", () => insertWildcard(item.path));
    row.querySelector(".wg-pin").addEventListener("click", (e) => {
      e.stopPropagation();
      if (pinned.has(item.path)) pinned.delete(item.path); else pinned.add(item.path);
      savePinned(pinned);
      renderPickerList(searchInput.value);
    });

    // ---- Right-click context menu: copy path / pin / jump to category ----
    // Gives the same three actions the row's icons already offer, without
    // needing to land a click on a specific tiny icon — handy on a narrow
    // sidebar or when several rows are visually packed close together.
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      closeInjectMenu();
      const nowPinned = pinned.has(item.path);
      openCtxMenu(e.clientX, e.clientY, [
        { label: "Copy path", onSelect: () => copyBtn.click() },
        {
          label: nowPinned ? "Unpin" : "Pin",
          onSelect: () => {
            if (pinned.has(item.path)) pinned.delete(item.path); else pinned.add(item.path);
            savePinned(pinned);
            renderPickerList(searchInput.value);
          },
        },
        { label: `Jump to "${cat}"`, onSelect: () => jumpToCategory(cat) },
      ]);
    });

    // ---- Copy-path trigger (hover 📋) ----
    // Copies "__path__" to the clipboard without inserting it into this
    // textarea — for grabbing a wildcard to paste into a saved snippet,
    // another node, or anywhere else. Always available regardless of the
    // Zen toggle, since it's an independent feature from the injector.
    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "wg-copy-trigger";
    copyBtn.title = `Copy "__${item.path}__" to clipboard`;
    copyBtn.innerHTML = "&#128203;"; // 📋
    copyBtn.setAttribute("draggable", "false");
    copyBtn.addEventListener("mousedown", (e) => e.stopPropagation());
    copyBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(`__${item.path}__`);
        const prevHtml = copyBtn.innerHTML;
        const prevTitle = copyBtn.title;
        copyBtn.innerHTML = "&#10003;"; // checkmark
        copyBtn.classList.add("copied");
        setTimeout(() => {
          copyBtn.innerHTML = prevHtml;
          copyBtn.title = prevTitle;
          copyBtn.classList.remove("copied");
        }, 1100);
      } catch (err) {
        copyBtn.title = "Copy failed \u2014 clipboard permission denied";
      }
    });
    row.insertBefore(copyBtn, row.querySelector(".wg-pin"));

    // ---- Syntax Injector trigger (hover ⚡, see openInjectMenu et al. above) ----
    // Moved down from the folder header to each item row, replacing the old
    // type badge. Uses item.path (the full path) instead of the category
    // name, so __path__ syntax it inserts is scoped to this exact wildcard
    // rather than the whole folder. Gated on the Zen toggle at creation time
    // (not just hidden via CSS) so switching it off keeps the DOM lighter,
    // not just visually empty — see toggleSyntaxInjectorCb's change handler,
    // which re-renders this list immediately so the icons appear/disappear
    // without delay.
    if (theme.syntaxInjectorEnabled !== false) {
      const trigger = document.createElement("button");
      trigger.type = "button";
      trigger.className = "wg-inject-trigger";
      trigger.title = `Insert wildcard syntax for "${item.path}"`;
      trigger.innerHTML = "&#9889;"; // ⚡
      // Explicitly opt this control out of HTML5 drag — rows aren't
      // draggable today, but this matches the header trigger's belt-and-
      // suspenders opt-out in case row dragging is ever added.
      trigger.setAttribute("draggable", "false");
      // Stops the document-level "click outside closes the menu" listener
      // in ensureInjectMenu() from ever seeing this mousedown, so it can't
      // race the click handler below.
      trigger.addEventListener("mousedown", (e) => e.stopPropagation());
      let openDelay = null;
      trigger.addEventListener("click", (e) => {
        e.stopPropagation();
        clearTimeout(openDelay);
        if (injectState && injectState.trigger === trigger) closeInjectMenu();
        else openInjectMenu(trigger, item.path, textarea, render);
      });
      trigger.addEventListener("mouseenter", () => {
        clearTimeout(injectCloseTimer);
        clearTimeout(openDelay);
        // Small hover delay so sweeping the cursor down the list on the way
        // somewhere else doesn't flash a flyout per row.
        openDelay = setTimeout(() => openInjectMenu(trigger, item.path, textarea, render), 90);
      });
      trigger.addEventListener("mouseleave", () => {
        clearTimeout(openDelay);
        scheduleCloseInjectMenu();
      });
      row.insertBefore(trigger, row.querySelector(".wg-pin"));
    }

    row.addEventListener("mouseenter", (e) => showTipForName(e.clientX, e.clientY, item.path, true));
    row.addEventListener("mousemove", (e) => { hoverTip.style.left = (e.clientX + 14) + "px"; hoverTip.style.top = (e.clientY + 14) + "px"; });
    row.addEventListener("mouseleave", hideTip);
    return row;
  }

  async function renderPickerList(filter = "") {
    // The picker rows (and any injector trigger button/context menu they
    // hold) are about to be torn down and rebuilt below — close both flyouts
    // first rather than leaving them anchored to a DOM node that's about to
    // be discarded.
    if (injectState && injectState.textarea === textarea) closeInjectMenu();
    if (ctxMenuOpen) closeCtxMenu();
    pickerKbIndex = -1;
    // Preserve scroll position across re-renders: toggling a folder open/
    // closed or typing in the search box rebuilds this list's innerHTML from
    // scratch, which would otherwise always snap the scroll back to the top.
    const prevScrollTop = pickerList.scrollTop;
    pickerList.innerHTML = `<div class="wg-hint" style="padding:6px;">loading...</div>`;
    const items = filter ? await API.search(filter) : libraryCache;
    pickerList.innerHTML = "";
    if (!filter) {
      const pinnedItems = libraryCache.filter(l => pinned.has(l.path));
      if (pinnedItems.length) {
        const lbl = document.createElement("div"); lbl.className = "wg-section-label"; lbl.textContent = "Pinned";
        pickerList.appendChild(lbl);
        pinnedItems.forEach(item => pickerList.appendChild(pickerRow(item)));
      }
      const recentItems = recentList.filter(p => !pinned.has(p)).map(p => libraryCache.find(l => l.path === p)).filter(Boolean);
      if (recentItems.length) {
        const lbl = document.createElement("div");
        lbl.className = "wg-section-label wg-section-label-row";
        lbl.innerHTML = `<span>Recent</span><button type="button" class="wg-clear-recent" data-act="clearRecent" title="Clear recent list">Clear</button>`;
        lbl.querySelector('[data-act="clearRecent"]').addEventListener("click", (e) => {
          e.stopPropagation();
          recentList = [];
          renderPickerList(searchInput.value);
        });
        pickerList.appendChild(lbl);
        recentItems.forEach(item => pickerList.appendChild(pickerRow(item)));
      }
    }
    const grouped = {};
    items.forEach(l => { const cat = categoryOf(l.path); (grouped[cat] = grouped[cat] || []).push(l); });

    // Reordering is only meaningful in the idle browse view — while filtering,
    // categories come and go with the search term, so we just sort matches
    // alphabetically and leave the persisted order untouched.
    const canReorder = !filter;
    let catNames;
    if (canReorder) {
      const present = Object.keys(grouped);
      const known = catOrder.filter(c => present.includes(c));
      const unseen = present.filter(c => !catOrder.includes(c)).sort();
      catNames = [...known, ...unseen];
      if (unseen.length) {
        catOrder = catNames.slice();
        saveCatOrder(catOrder);
      }
    } else {
      catNames = Object.keys(grouped).sort();
    }

    let dragCat = null;
    catNames.forEach(cat => {
      // While actively filtering/searching, always show matches regardless
      // of collapsed state — collapsing only applies to the idle browse view.
      const isExpanded = !!filter || expandedCats.has(cat);
      const header = document.createElement("div");
      header.className = "wg-folder" + (isExpanded ? " expanded" : "");
      header.dataset.cat = cat;
      header.innerHTML = `<span class="wg-folder-caret">${isExpanded ? "\u25BE" : "\u25B8"}</span><span class="wg-folder-name">${escapeHtml(cat)}</span><span class="wg-folder-count">${grouped[cat].length}</span>`;
      header.title = isExpanded ? "Click to collapse" : "Click to expand";
      header.addEventListener("click", () => {
        if (expandedCats.has(cat)) expandedCats.delete(cat); else expandedCats.add(cat);
        saveExpandedCats(expandedCats);
        renderPickerList(searchInput.value);
      });

      // Syntax Injector trigger used to live here on the folder header — it
      // now lives on each item row instead (see pickerRow above), keyed off
      // the item's full path rather than the category name.

      // ---- drag-to-reorder (idle browse view only) ----
      if (canReorder) {
        header.classList.add("wg-draggable");
        header.draggable = true;
        header.addEventListener("dragstart", (e) => {
          dragCat = cat;
          header.classList.add("dragging");
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", cat);
        });
        header.addEventListener("dragend", () => {
          dragCat = null;
          header.classList.remove("dragging");
        });
        header.addEventListener("dragover", (e) => {
          if (!dragCat || dragCat === cat) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          header.classList.add("drag-over");
        });
        header.addEventListener("dragleave", () => header.classList.remove("drag-over"));
        header.addEventListener("drop", (e) => {
          e.preventDefault();
          header.classList.remove("drag-over");
          const dragged = dragCat || e.dataTransfer.getData("text/plain");
          if (!dragged || dragged === cat) return;
          const from = catOrder.indexOf(dragged);
          const to = catOrder.indexOf(cat);
          if (from === -1 || to === -1) return;
          catOrder.splice(from, 1);
          catOrder.splice(to, 0, dragged);
          saveCatOrder(catOrder);
          renderPickerList(searchInput.value);
        });
      }

      pickerList.appendChild(header);
      if (isExpanded) grouped[cat].forEach(item => pickerList.appendChild(pickerRow(item, filter)));
    });
    if (!items.length) pickerList.innerHTML = `<div class="wg-hint" style="padding:6px;">no matches</div>`;
    // Restore the scroll position captured before the rebuild. If the new
    // content is shorter (e.g. a folder was just collapsed), the browser
    // clamps this to the new max scrollTop on its own.
    pickerList.scrollTop = prevScrollTop;
  }

  // Used by each row's right-click context menu ("Jump to category" — see
  // pickerRow). Category folders only exist in the idle browse view, so an
  // active search filter is cleared first to bring the folder list back.
  function jumpToCategory(cat) {
    searchInput.value = "";
    if (!expandedCats.has(cat)) {
      expandedCats.add(cat);
      saveExpandedCats(expandedCats);
    }
    renderPickerList("");
    requestAnimationFrame(() => {
      const header = pickerList.querySelector(`.wg-folder[data-cat="${CSS.escape(cat)}"]`);
      if (!header) return;
      header.scrollIntoView({ block: "center" });
      header.classList.add("wg-jump-flash");
      setTimeout(() => header.classList.remove("wg-jump-flash"), 900);
    });
  }

  let searchDebounce = null;
  searchInput.addEventListener("input", () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => renderPickerList(searchInput.value), 150);
  });
  // Arrow/Enter navigation through whatever's currently visible in the
  // picker (pinned/recent/category rows, or search matches), so a wildcard
  // can be inserted without ever reaching for the mouse. Mirrors the "__"
  // autocomplete's own keydown handling above for a consistent feel.
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      if (!pickerRows().length) return;
      e.preventDefault();
      movePickerKbIndex(1);
    } else if (e.key === "ArrowUp") {
      if (!pickerRows().length) return;
      e.preventDefault();
      movePickerKbIndex(-1);
    } else if (e.key === "Enter") {
      const rows = pickerRows();
      if (pickerKbIndex < 0 || !rows[pickerKbIndex]) return;
      e.preventDefault();
      rows[pickerKbIndex].querySelector(".wg-name").click();
    } else if (e.key === "Escape" && searchInput.value) {
      // Local-first, same philosophy as handleEscapeKey below: clearing an
      // active filter is more immediate than whatever a second Escape would
      // close, so it takes priority and doesn't propagate to that cascade.
      e.preventDefault();
      e.stopPropagation();
      searchInput.value = "";
      renderPickerList("");
    }
  });

  async function refreshLibrary() {
    libraryCache = await API.list();
    knownSet = new Set(libraryCache.map(l => l.path));
    render();
  }

  // ---- edit drawer ----
  const editName = el("editName");
  const editContent = el("editContent");
  const editStatus = el("editStatus");

  async function loadIntoEditDrawer(name) {
    editName.value = name;
    const data = await API.content(name);
    if (data && data.found) {
      editContent.value = data.content;
      editContent.disabled = !data.editable;
      editStatus.textContent = data.editable ? "" : "yaml-backed wildcards are edited in their source file.";
      editStatus.className = "wg-status";
    } else {
      editContent.value = "";
      editContent.disabled = false;
      editStatus.textContent = "new wildcard \u2014 write one option per line, then save.";
      editStatus.className = "wg-status";
    }
  }

  // Named (not just an inline click handler) so the Ctrl/Cmd+S keyboard
  // shortcut below can trigger the exact same save path as clicking the
  // button.
  async function saveEditDrawer() {
    const name = editName.value.trim();
    if (!name) { editStatus.textContent = "enter a name/path first"; editStatus.className = "wg-status err"; return; }
    const res = await API.save(name, editContent.value);
    if (res.ok) {
      editStatus.textContent = "saved.";
      editStatus.className = "wg-status";
      previewCache.delete(name);
      await refreshLibrary();
      renderPickerList(searchInput.value);
    } else {
      editStatus.textContent = res.error || "save failed";
      editStatus.className = "wg-status err";
    }
  }
  root.querySelector('[data-act="save"]').addEventListener("click", saveEditDrawer);
  // Enter in the filename field "confirms" whatever path was typed: load its
  // existing content into the editor if the wildcard already exists (same
  // outcome as double-clicking that token), or reset to the blank "new
  // wildcard" state if it doesn't. Scoped to this one input (rather than the
  // whole drawer) so Enter still behaves normally — inserting nothing, since
  // it's a single-line input — and doesn't clash with newlines in the
  // multi-line content textarea below it.
  editName.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const name = editName.value.trim();
    if (name) loadIntoEditDrawer(name);
  });
  root.querySelector('[data-act="delete"]').addEventListener("click", async () => {
    const name = editName.value.trim();
    if (!name) return;
    const res = await API.del(name);
    if (res.ok) {
      editStatus.textContent = "deleted.";
      editStatus.className = "wg-status";
      previewCache.delete(name);
      editContent.value = "";
      await refreshLibrary();
      renderPickerList(searchInput.value);
    } else {
      editStatus.textContent = res.error || "delete failed";
      editStatus.className = "wg-status err";
    }
  });

  // ---- resizable picker sidebar (drag right edge, 220–640px) ----
  const PICKER_MIN_WIDTH = 220;
  const PICKER_MAX_WIDTH = 640;
  function loadPickerWidth() {
    try {
      const w = parseInt(localStorage.getItem("pp_picker_width"), 10);
      if (Number.isFinite(w)) return Math.min(PICKER_MAX_WIDTH, Math.max(PICKER_MIN_WIDTH, w));
    } catch (e) {}
    return PICKER_MIN_WIDTH;
  }
  function savePickerWidth(w) {
    try { localStorage.setItem("pp_picker_width", String(w)); } catch (e) {}
  }
  let pickerWidth = loadPickerWidth();

  // The drawer's default/closed width (0, or a fixed 220px while open) lives
  // in the stylesheet; a resized width is applied as an inline style, which
  // wins over those rules automatically without needing !important. It's set
  // only while the drawer is open (see openPickerDrawer/closePickerDrawer
  // below) — leaving it set while closed would also override the "closed"
  // width:0 rule and break the collapse animation.
  const pickerResizeHandle = document.createElement("div");
  pickerResizeHandle.className = "wg-drawer-resize-handle";
  pickerResizeHandle.title = "Drag to resize";
  pickerDrawer.appendChild(pickerResizeHandle);

  let resizingPicker = false;
  let resizeStartX = 0;
  let resizeStartWidth = 0;
  pickerResizeHandle.addEventListener("mousedown", (e) => {
    if (!pickerDrawer.classList.contains("open")) return;
    resizingPicker = true;
    resizeStartX = e.clientX;
    resizeStartWidth = pickerDrawer.getBoundingClientRect().width;
    pickerDrawer.classList.add("resizing");
    document.body.style.userSelect = "none";
    e.preventDefault();
  });
  const handlePickerResizeMove = (e) => {
    if (!resizingPicker) return;
    pickerWidth = Math.min(PICKER_MAX_WIDTH, Math.max(PICKER_MIN_WIDTH, resizeStartWidth + (e.clientX - resizeStartX)));
    pickerDrawer.style.width = pickerWidth + "px";
  };
  const handlePickerResizeUp = () => {
    if (!resizingPicker) return;
    resizingPicker = false;
    pickerDrawer.classList.remove("resizing");
    document.body.style.userSelect = "";
    savePickerWidth(pickerWidth);
  };
  document.addEventListener("mousemove", handlePickerResizeMove);
  document.addEventListener("mouseup", handlePickerResizeUp);

  // ---- toolbar actions ----
  function openPickerDrawer() {
    pickerDrawer.classList.add("open");
    root.querySelector('[data-act="picker"]').classList.add("active");
    pickerDrawer.style.width = pickerWidth + "px";
    renderPickerList(searchInput.value);
  }
  function closePickerDrawer() {
    pickerDrawer.classList.remove("open");
    root.querySelector('[data-act="picker"]').classList.remove("active");
    pickerDrawer.style.width = "";
  }
  root.querySelector('[data-act="picker"]').addEventListener("click", () => {
    if (pickerDrawer.classList.contains("open")) closePickerDrawer(); else openPickerDrawer();
  });
  function closeEditDrawer() {
    editDrawer.classList.remove("open");
    root.querySelector('[data-act="edit"]').classList.remove("active");
  }
  root.querySelector('[data-act="edit"]').addEventListener("click", (e) => {
    editDrawer.classList.toggle("open");
    e.currentTarget.classList.toggle("active");
  });
  // Explicit close button inside the edit drawer itself — same effect as
  // clicking the pencil icon in the toolbar, just discoverable from inside
  // the panel so users aren't left hunting for how to dismiss it.
  root.querySelector('[data-act="closeEditDrawer"]').addEventListener("click", closeEditDrawer);
  // Ctrl/Cmd+S anywhere inside the edit drawer (filename field or content
  // textarea) saves, instead of triggering the browser's "save page" dialog.
  editDrawer.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      saveEditDrawer();
    }
  });
  root.querySelector('[data-act="resolve"]').addEventListener("click", async (e) => {
    const on = resolvedView.classList.toggle("on");
    editorReal.classList.toggle("hidden", on);
    e.currentTarget.classList.toggle("on", on);
    e.currentTarget.textContent = on ? "Back to editing" : "Show resolved";
    if (on) await refreshResolvedView();
  });

  // ---- copy / clear / hot-refresh ----
  const copyBtn = root.querySelector('[data-act="copy"]');
  copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(textarea.value);
      const prevHtml = copyBtn.innerHTML;
      copyBtn.innerHTML = "&#10003;"; // checkmark
      copyBtn.classList.add("active");
      setTimeout(() => { copyBtn.innerHTML = prevHtml; copyBtn.classList.remove("active"); }, 1100);
    } catch (e) {
      copyBtn.title = "Copy failed \u2014 clipboard permission denied";
    }
  });

  root.querySelector('[data-act="clear"]').addEventListener("click", () => {
    if (!textarea.value) return;
    if (!confirm("Clear the entire prompt? (You can Ctrl+Z to undo this.)")) return;
    textarea.value = "";
    // Manually dispatch 'input' so the existing textarea listener (which drives
    // render()/syncHiddenWidget()) fires and the canvas serialization loop
    // picks up the change, exactly as if the user had deleted the text by hand.
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.focus();
  });

  const refreshBtn = root.querySelector('[data-act="refresh"]');
  refreshBtn.addEventListener("click", async () => {
    refreshBtn.classList.add("active");
    refreshBtn.disabled = true;
    try {
      const data = await API.refreshWildcards();
      node.updateWildcardSidePanels(data);
    } catch (e) {
      console.error("[prompt-palette] wildcard refresh failed:", e);
      refreshBtn.title = "Refresh failed \u2014 see console";
    } finally {
      refreshBtn.classList.remove("active");
      refreshBtn.disabled = false;
    }
  });

  const undoBtn = root.querySelector('[data-act="undo"]');
  const redoBtn = root.querySelector('[data-act="redo"]');
  undoBtn.addEventListener("click", performUndo);
  redoBtn.addEventListener("click", performRedo);

  // Hot-reloads the picker drawer / legend / known-wildcard set from a fresh
  // backend directory scan without requiring a full browser refresh. Exposed
  // on the node instance (not just closed over here) so other call sites —
  // e.g. a future "watch filesystem" feature — can trigger the same repaint.
  node.updateWildcardSidePanels = function (data) {
    const items = (data && data.items) || [];
    libraryCache = items;
    knownSet = new Set(items.map(i => i.path));
    renderPickerList(searchInput.value);
    renderCatPins();
    render(); // re-highlight the editor text against the refreshed known-wildcard set
  };

  // double-click a token in the editor to jump straight to editing it.
  // charIndexFromEvent() above is an approximate monospace hit-test, kept
  // ONLY for the hover tooltip (which can tolerate being a little off). It
  // falls apart on variable-width fonts, so it isn't precise enough to
  // decide what gets opened for editing here. Instead, read the browser's
  // own native double-click word selection directly off the textarea and
  // resolve THAT to the enclosing __folder/name__ token range. Browsers
  // disagree on whether "_" and "/" count as word-boundary characters, so
  // the native selection might only grab "folder" or "name__" or similar —
  // any overlap between it and a known token range is enough to resolve to
  // the FULL token, regardless of which slice the browser actually selected.
  textarea.addEventListener("dblclick", (e) => {
    const nativeStart = textarea.selectionStart;
    const nativeEnd = textarea.selectionEnd;
    const tok = tokenRanges.find(t => t.start <= nativeEnd && t.end >= nativeStart);
    if (tok) {
      // Widen the (possibly partial) native selection to the full token so
      // what's visibly highlighted matches what's being opened for editing.
      textarea.selectionStart = tok.start;
      textarea.selectionEnd = tok.end;
      editDrawer.classList.add("open");
      root.querySelector('[data-act="edit"]').classList.add("active");
      loadIntoEditDrawer(tok.name);
    }
  });

  // Right-click a wildcard token to reach the same Syntax Injector menu the
  // picker row's hover ⚡ trigger offers (Random / Random — unseeded /
  // Sequential — next "+" / Sequential — previous "-" / templates — see
  // INJECT_MODIFIERS / INJECT_TEMPLATES and openInjectMenu* above) without
  // having to remember to reach for that icon before the wildcard was
  // inserted in the first place. Committing an item here overwrites this
  // exact token occurrence in place (via replaceRange) instead of inserting
  // a second copy wherever the caret last was — so picking e.g.
  // "Sequential — next" on a plain __name__ rewrites it to __+name__ right
  // where it sits, rather than duplicating it.
  textarea.addEventListener("contextmenu", (e) => {
    if (theme.syntaxInjectorEnabled === false) return; // Zen mode — Syntax Injector fully off, same as the picker's ⚡ trigger
    // The right-button mousedown that precedes "contextmenu" has already
    // moved the caret to the click point (same native-caret reasoning the
    // dblclick handler above relies on) — more robust than the approximate
    // monospace charIndexFromEvent() hit-test used for the hover tooltip,
    // especially once a custom (non-monospace) --wg-font-family is in play.
    const idx = textarea.selectionStart;
    const tok = tokenRanges.find(t => t.start <= idx && t.end >= idx);
    if (!tok) return; // not on a wildcard token — leave the browser's native menu alone
    e.preventDefault();
    hideTip();
    closeCtxMenu();
    textarea.selectionStart = tok.start;
    textarea.selectionEnd = tok.end;
    openInjectMenuAtPoint(e.clientX, e.clientY, tok.name, textarea, render, { start: tok.start, end: tok.end });
  });

  // Jump-to-next-missing-wildcard — clicking the "N missing" hint in the
  // footer (see render() above, which toggles .wg-hint-clickable on it)
  // selects the next unresolved __name__ token after the caret, wrapping
  // around to the first one past the end. Missing wildcards (path doesn't
  // match anything the backend scanned) are easy to miss just by eye in a
  // long prompt — this is a quick way to actually find and fix them instead
  // of hunting through the text for the red-styled tokens one by one.
  function jumpToNextMissing() {
    const missing = tokenRanges.filter(t => !t.known);
    if (!missing.length) return;
    const caret = textarea.selectionEnd;
    const target = missing.find(t => t.start > caret) || missing[0];
    textarea.focus();
    textarea.selectionStart = target.start;
    textarea.selectionEnd = target.end;
    // Setting selection while focused already scrolls most browsers to
    // reveal the caret; nudge the highlight overlay to match in case that
    // happens without a native "scroll" event firing on the textarea.
    highlight.scrollTop = textarea.scrollTop;
    highlight.scrollLeft = textarea.scrollLeft;
  }
  hintRight.addEventListener("click", jumpToNextMissing);

  // ---- settings popup (with a real close button + outside click + escape) ----
  const settingsBtn = root.querySelector('[data-act="settings"]');
  function openSettings() { settingsPopup.classList.add("open"); }
  function closeSettings() { settingsPopup.classList.remove("open"); }
  settingsBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    settingsPopup.classList.toggle("open");
  });
  root.querySelector('[data-act="closeSettings"]').addEventListener("click", closeSettings);
  
  // Named functions for memory cleanup
  const handleOutsideClick = (e) => {
    if (settingsPopup.classList.contains("open") && !settingsPopup.contains(e.target) && e.target !== settingsBtn) {
      closeSettings();
    }
  };
  const handleEscapeKey = (e) => {
    if (e.key !== "Escape") return;
    // Closest-opened-thing-first: the row context menu and injector flyout
    // are the most ephemeral (click/hover-driven) floating elements, so they
    // close before anything else; then the settings popup, which floats
    // above the drawers; then whichever side drawer is open.
    if (ctxMenuOpen) closeCtxMenu();
    else if (injectState && injectState.textarea === textarea) closeInjectMenu();
    else if (settingsPopup.classList.contains("open")) closeSettings();
    else if (editDrawer.classList.contains("open")) closeEditDrawer();
    else if (pickerDrawer.classList.contains("open")) closePickerDrawer();
  };
  
  document.addEventListener("click", handleOutsideClick);
  document.addEventListener("keydown", handleEscapeKey);
  settingsPopup.addEventListener("click", (e) => e.stopPropagation());

  // ---- accessibility: font family / sizes / prompt text color ----
  // Applied to document.documentElement (same pattern as the interface theme
  // below) so it's a single global legibility preference shared by every
  // Prompt Palette node on the canvas, rather than something you'd have to
  // re-tune per node.
  const fontFamilyInput = el("fontFamilyInput");
  const fontStatus = el("fontStatus");
  const editorFontRange = el("editorFontRange"), editorFontOut = el("editorFontOut");
  const uiFontRange = el("uiFontRange"), uiFontOut = el("uiFontOut");
  const promptTextColorInput = el("promptTextColor");

  function setFontStatus(msg, isErr) {
    fontStatus.textContent = msg || "";
    fontStatus.className = "wg-status" + (isErr ? " err" : "");
  }

  function applyFontSettings() {
    const r = document.documentElement.style;
    if (theme.fontFamily && theme.fontFamily.trim()) {
      r.setProperty("--wg-font-family", `"${theme.fontFamily.trim()}"`);
    } else {
      r.removeProperty("--wg-font-family");
    }
    r.setProperty("--wg-editor-font-size", `${theme.editorFontSize}px`);
    r.setProperty("--wg-ui-font-scale", theme.uiFontScale);
    r.setProperty("--wg-prompt-text", theme.promptTextColor);
  }

  function refreshFontControlsUI() {
    fontFamilyInput.value = theme.fontFamily || "";
    editorFontRange.value = theme.editorFontSize;
    editorFontOut.textContent = `${theme.editorFontSize}px`;
    uiFontRange.value = Math.round(theme.uiFontScale * 100);
    uiFontOut.textContent = `${Math.round(theme.uiFontScale * 100)}%`;
    promptTextColorInput.value = theme.promptTextColor;
  }
  refreshFontControlsUI();

  fontFamilyInput.addEventListener("input", () => {
    theme.fontFamily = fontFamilyInput.value;
    saveTheme(theme); applyFontSettings(); updateThemeJson();
  });
  editorFontRange.addEventListener("input", () => {
    theme.editorFontSize = parseFloat(editorFontRange.value);
    editorFontOut.textContent = `${theme.editorFontSize}px`;
    saveTheme(theme); applyFontSettings(); updateThemeJson();
  });
  uiFontRange.addEventListener("input", () => {
    theme.uiFontScale = parseInt(uiFontRange.value, 10) / 100;
    uiFontOut.textContent = `${uiFontRange.value}%`;
    saveTheme(theme); applyFontSettings(); updateThemeJson();
  });
  promptTextColorInput.addEventListener("input", () => {
    theme.promptTextColor = promptTextColorInput.value;
    saveTheme(theme); applyFontSettings(); updateThemeJson();
  });
  root.querySelector('[data-act="fontClear"]').addEventListener("click", () => {
    theme.fontFamily = "";
    fontFamilyInput.value = "";
    saveTheme(theme); applyFontSettings(); updateThemeJson();
    setFontStatus("using default fonts");
  });
  root.querySelector('[data-act="fontBrowseLocal"]').addEventListener("click", async () => {
    // Local Font Access API: Chrome/Edge 103+ only, requires a user gesture and a
    // one-time permission grant. Lets the page read the *names* of fonts actually
    // installed on the user's system (not the font files) so the family typed
    // into the input above is guaranteed to exist, instead of guessing.
    if (typeof window.queryLocalFonts !== "function") {
      setFontStatus("Your browser doesn't support browsing installed fonts (Chrome/Edge only). Type a font name manually \u2014 it must already be installed on your system for the browser to render it.", true);
      return;
    }
    try {
      const fonts = await window.queryLocalFonts();
      const families = Array.from(new Set(fonts.map(f => f.family))).sort();
      if (!families.length) { setFontStatus("no local fonts found", true); return; }
      fontStatus.innerHTML = "";
      fontStatus.className = "wg-status";
      const sel = document.createElement("select");
      sel.className = "wg-theme-select";
      sel.style.marginTop = "4px";
      sel.innerHTML = `<option value="">${families.length} installed fonts found \u2014 pick one\u2026</option>` +
        families.map(f => `<option value="${escapeHtml(f)}">${escapeHtml(f)}</option>`).join("");
      sel.addEventListener("change", () => {
        if (!sel.value) return;
        theme.fontFamily = sel.value;
        fontFamilyInput.value = sel.value;
        saveTheme(theme); applyFontSettings(); updateThemeJson();
        setFontStatus(`using "${sel.value}"`);
      });
      fontStatus.appendChild(sel);
    } catch (e) {
      setFontStatus("font permission denied or unavailable", true);
    }
  });

  const hueRange = el("hueRange"), hueOut = el("hueOut");
  const satRange = el("satRange"), satOut = el("satOut");
  hueRange.value = theme.hueRotate; hueOut.textContent = theme.hueRotate + "\u00b0";
  satRange.value = theme.saturation; satOut.textContent = theme.saturation + "%";

  hueRange.addEventListener("input", () => { theme.hueRotate = parseInt(hueRange.value, 10); hueOut.textContent = theme.hueRotate + "\u00b0"; saveTheme(theme); render(); });
  satRange.addEventListener("input", () => { theme.saturation = parseInt(satRange.value, 10); satOut.textContent = theme.saturation + "%"; saveTheme(theme); render(); });

  function renderCatPins() {
    const wrap = el("catPins");
    const categories = Array.from(new Set(libraryCache.map(l => categoryOf(l.path)))).sort();
    wrap.innerHTML = "";
    categories.forEach(cat => {
      const row = document.createElement("div"); row.className = "wg-catpin-row";
      const current = theme.categoryPins[cat] || hslToHex((hashStr(cat) % 360 + theme.hueRotate) % 360, theme.saturation, 66);
      row.innerHTML = `<span>${escapeHtml(cat)}</span><input type="color" value="${current}">`;
      row.querySelector("input").addEventListener("input", (e) => { theme.categoryPins[cat] = e.target.value; saveTheme(theme); render(); });
      wrap.appendChild(row);
    });
  }
  function updateThemeJson() {
    el("themeJson").value = JSON.stringify(theme, null, 2);
  }
  root.querySelector('[data-act="copyTheme"]').addEventListener("click", async (e) => {
    await navigator.clipboard.writeText(el("themeJson").value).catch(() => {});
    e.target.textContent = "Copied"; setTimeout(() => e.target.textContent = "Copy JSON", 1200);
  });
  root.querySelector('[data-act="pasteTheme"]').addEventListener("click", async () => {
    try {
      const text = await navigator.clipboard.readText();
      const parsed = JSON.parse(text);
      Object.assign(theme, { ...defaultTheme(), ...parsed });
      hueRange.value = theme.hueRotate || 0; hueOut.textContent = (theme.hueRotate || 0) + "\u00b0";
      satRange.value = theme.saturation || 65; satOut.textContent = (theme.saturation || 65) + "%";
      refreshFontControlsUI();
      saveTheme(theme); applyFontSettings(); render();
    } catch (e) { alert("clipboard doesn't contain valid theme JSON"); }
  });
  root.querySelector('[data-act="resetTheme"]').addEventListener("click", () => {
    Object.assign(theme, defaultTheme());
    hueRange.value = 0; hueOut.textContent = "0\u00b0";
    satRange.value = 65; satOut.textContent = "65%";
    refreshFontControlsUI();
    saveTheme(theme); applyFontSettings(); render();
  });

  // ---- interface theme (UI chrome, not the token/text colors above) ----
  const uiThemeSelect = el("uiThemeSelect");
  const uiThemeSwatches = el("uiThemeSwatches");
  const uiThemeStatus = el("uiThemeStatus");

  let customUiThemes = loadUiThemes();
  let activeUiThemeName = loadActiveUiThemeName();

  function allUiThemes() { return { ...BUILTIN_UI_THEMES, ...customUiThemes }; }
  function isBuiltinUiTheme(name) { return !!BUILTIN_UI_THEMES[name] && !customUiThemes[name]; }
  if (!allUiThemes()[activeUiThemeName]) activeUiThemeName = "Amber";

  // Themes apply as CSS custom properties on the document root (not just
  // this node) so the shared hover-tip element — which lives outside
  // .wg-node in the DOM — picks them up too, and so every wildcard editor
  // node on the canvas stays in sync, matching how the token theme already
  // behaves as a single global setting.
  function applyUiTheme() {
    const t = allUiThemes()[activeUiThemeName] || BUILTIN_UI_THEMES.Amber;
    UI_THEME_KEYS.forEach(([key]) => {
      document.documentElement.style.setProperty(`--wg-${key}`, t[key]);
    });
    // Also recolor the underlying LiteGraph node itself (title bar + body),
    // not just the DOM widget's own CSS — otherwise a strip of the default
    // grey node canvas shows around/behind the UI, especially on light
    // themes like Daylight/High Contrast. Every node instance re-applies
    // this on its own theme-change listener, so all of them stay in sync
    // with the single shared theme, same as everything else here.
    node.bgcolor = t.bg;
    node.color = t.accent;
    node.graph?.setDirtyCanvas(true, true);
    if (typeof updateDayNightIcon === "function") updateDayNightIcon();
  }
  function setUiThemeStatus(msg, isErr) {
    uiThemeStatus.textContent = msg || "";
    uiThemeStatus.className = "wg-status" + (isErr ? " err" : "");
  }
  function renderUiThemeSelect() {
    const themes = allUiThemes();
    uiThemeSelect.innerHTML = Object.keys(themes).sort().map(name =>
      `<option value="${escapeHtml(name)}" ${name === activeUiThemeName ? "selected" : ""}>${escapeHtml(name)}${isBuiltinUiTheme(name) ? "" : " (custom)"}</option>`
    ).join("");
  }
  function renderUiThemeSwatches() {
    const t = allUiThemes()[activeUiThemeName] || BUILTIN_UI_THEMES.Amber;
    const locked = isBuiltinUiTheme(activeUiThemeName);
    uiThemeSwatches.innerHTML = "";
    UI_THEME_KEYS.forEach(([key, label]) => {
      const item = document.createElement("div");
      item.className = "wg-swatch-item";
      // Built via DOM APIs rather than innerHTML string interpolation, since
      // t[key] can originate from an imported theme JSON (clipboard-pasted,
      // untrusted). Assigning .value as a property (not concatenating into
      // an HTML attribute string) means it's always treated as plain text,
      // never parsed as markup, no matter what it contains.
      const swatchLabel = document.createElement("span");
      swatchLabel.textContent = label;
      const input = document.createElement("input");
      input.type = "color";
      input.value = sanitizeHexColor(t[key]);
      input.disabled = locked;
      item.appendChild(swatchLabel);
      item.appendChild(input);
      input.addEventListener("input", (e) => {
        if (locked) return;
        customUiThemes[activeUiThemeName][key] = e.target.value;
        saveUiThemes(customUiThemes);
        applyUiTheme();
      });
      uiThemeSwatches.appendChild(item);
    });
    setUiThemeStatus(locked ? "built-in theme \u2014 hit \u201cNew\u201d to make an editable copy" : "");
  }
  function refreshUiThemeUI() { renderUiThemeSelect(); renderUiThemeSwatches(); refreshDayNightSelects(); }

  // ---- Toolbar declutter: optional seed/mode cluster + day/night toggle ----
  // Both live in theme (global, shared across every Prompt Palette node),
  // same storage pattern as font/interface-theme prefs above. The seed/mode
  // cluster itself (.wg-toolbar-extra) is the same markup that used to be
  // an always-visible bar; it's now nested inside .wg-toolbar and simply
  // shown/hidden with a class, so switching it on adds it to the same bar
  // as Show resolved / refresh instead of a separate strip.
  const toolbarSeedExtra = el("seedbar");
  const dayNightBtn = el("dayNightBtn");
  const toggleSeedControlsCb = el("toggleSeedControls");
  const toggleDayNightBtnCb = el("toggleDayNightBtn");
  const toggleSyntaxInjectorCb = el("toggleSyntaxInjector");
  const dayThemeSelect = el("dayThemeSelect");
  const nightThemeSelect = el("nightThemeSelect");

  function applyToolbarSettings() {
    toolbarSeedExtra.classList.toggle("on", !!theme.showSeedControls);
    dayNightBtn.style.display = theme.showDayNightBtn ? "" : "none";
  }
  function refreshToolbarSettingsUI() {
    toggleSeedControlsCb.checked = !!theme.showSeedControls;
    toggleDayNightBtnCb.checked = !!theme.showDayNightBtn;
    toggleSyntaxInjectorCb.checked = theme.syntaxInjectorEnabled !== false;
  }
  function refreshDayNightSelects() {
    const themes = allUiThemes();
    const names = Object.keys(themes).sort();
    // Self-heal if the theme a user picked for day/night got renamed or
    // deleted since (same fallback pattern as activeUiThemeName above).
    if (!themes[theme.dayTheme]) theme.dayTheme = names.includes("Daylight") ? "Daylight" : names[0];
    if (!themes[theme.nightTheme]) theme.nightTheme = names.includes("Amber") ? "Amber" : names[0];
    saveTheme(theme);
    [[dayThemeSelect, "dayTheme"], [nightThemeSelect, "nightTheme"]].forEach(([sel, key]) => {
      sel.innerHTML = names.map(n =>
        `<option value="${escapeHtml(n)}" ${n === theme[key] ? "selected" : ""}>${escapeHtml(n)}</option>`
      ).join("");
    });
  }
  // Icon reflects the ACTION (what clicking will do), matching the common
  // sun/moon toggle convention: show the moon while in the day theme (click
  // to go dark), show the sun once night theme is active (click for day).
  function updateDayNightIcon() {
    const inNight = theme.nightTheme && activeUiThemeName === theme.nightTheme;
    dayNightBtn.innerHTML = inNight ? "&#9728;" : "&#127769;";
    dayNightBtn.title = inNight ? "Switch to day theme" : "Switch to night theme";
  }

  toggleSeedControlsCb.addEventListener("change", () => {
    theme.showSeedControls = toggleSeedControlsCb.checked;
    saveTheme(theme);
    applyToolbarSettings();
  });
  toggleDayNightBtnCb.addEventListener("change", () => {
    theme.showDayNightBtn = toggleDayNightBtnCb.checked;
    saveTheme(theme);
    applyToolbarSettings();
  });
  toggleSyntaxInjectorCb.addEventListener("change", () => {
    theme.syntaxInjectorEnabled = toggleSyntaxInjectorCb.checked;
    saveTheme(theme);
    if (!theme.syntaxInjectorEnabled && injectState && injectState.textarea === textarea) closeInjectMenu();
    // Rebuild so the picker rows immediately gain/lose their ⚡ triggers
    // instead of waiting for the next unrelated re-render.
    renderPickerList(searchInput.value);
  });
  dayThemeSelect.addEventListener("change", () => {
    theme.dayTheme = dayThemeSelect.value;
    saveTheme(theme);
    updateDayNightIcon();
  });
  nightThemeSelect.addEventListener("change", () => {
    theme.nightTheme = nightThemeSelect.value;
    saveTheme(theme);
    updateDayNightIcon();
  });
  dayNightBtn.addEventListener("click", () => {
    const target = activeUiThemeName === theme.nightTheme ? theme.dayTheme : theme.nightTheme;
    if (!target || !allUiThemes()[target]) return; // configured theme got renamed/deleted — nothing to switch to
    activeUiThemeName = target;
    saveActiveUiThemeName(activeUiThemeName);
    applyUiTheme();
    refreshUiThemeUI();
  });

  uiThemeSelect.addEventListener("change", () => {
    activeUiThemeName = uiThemeSelect.value;
    saveActiveUiThemeName(activeUiThemeName);
    applyUiTheme();
    renderUiThemeSwatches();
  });

  root.querySelector('[data-act="uiThemeNew"]').addEventListener("click", () => {
    const base = allUiThemes()[activeUiThemeName] || BUILTIN_UI_THEMES.Amber;
    let name = prompt("Name for the new theme:", `${activeUiThemeName} copy`);
    if (!name) return;
    name = name.trim();
    if (!name) return;
    customUiThemes[name] = { ...base };
    saveUiThemes(customUiThemes);
    activeUiThemeName = name;
    saveActiveUiThemeName(name);
    applyUiTheme();
    refreshUiThemeUI();
  });
  root.querySelector('[data-act="uiThemeRename"]').addEventListener("click", () => {
    if (isBuiltinUiTheme(activeUiThemeName)) return setUiThemeStatus("built-in themes can't be renamed", true);
    let name = prompt("Rename theme:", activeUiThemeName);
    if (!name) return;
    name = name.trim();
    if (!name || name === activeUiThemeName) return;
    if (allUiThemes()[name]) return setUiThemeStatus("a theme with that name already exists", true);
    customUiThemes[name] = customUiThemes[activeUiThemeName];
    delete customUiThemes[activeUiThemeName];
    saveUiThemes(customUiThemes);
    activeUiThemeName = name;
    saveActiveUiThemeName(name);
    refreshUiThemeUI();
  });
  root.querySelector('[data-act="uiThemeDelete"]').addEventListener("click", () => {
    if (isBuiltinUiTheme(activeUiThemeName)) return setUiThemeStatus("built-in themes can't be deleted", true);
    delete customUiThemes[activeUiThemeName];
    saveUiThemes(customUiThemes);
    activeUiThemeName = "Amber";
    saveActiveUiThemeName(activeUiThemeName);
    applyUiTheme();
    refreshUiThemeUI();
  });
  root.querySelector('[data-act="uiThemeImport"]').addEventListener("click", async () => {
    try {
      const text = await navigator.clipboard.readText();
      const parsed = JSON.parse(text);
      const source = parsed.colors || parsed;
      const name = (parsed.name && String(parsed.name).trim()) || `Imported ${Object.keys(customUiThemes).length + 1}`;
      const colors = {};
      UI_THEME_KEYS.forEach(([key]) => {
        colors[key] = sanitizeHexColor(source[key], BUILTIN_UI_THEMES.Amber[key]);
      });
      customUiThemes[name] = colors;
      saveUiThemes(customUiThemes);
      activeUiThemeName = name;
      saveActiveUiThemeName(name);
      applyUiTheme();
      refreshUiThemeUI();
      setUiThemeStatus(`imported "${name}"`);
    } catch (e) {
      setUiThemeStatus("clipboard doesn't contain a valid theme JSON", true);
    }
  });
  root.querySelector('[data-act="uiThemeExport"]').addEventListener("click", async () => {
    const t = allUiThemes()[activeUiThemeName] || BUILTIN_UI_THEMES.Amber;
    const payload = { name: activeUiThemeName, ...t };
    await navigator.clipboard.writeText(JSON.stringify(payload, null, 2)).catch(() => {});
    setUiThemeStatus("copied theme JSON to clipboard \u2014 share the file to let others import it");
  });

  applyUiTheme();
  refreshUiThemeUI();
  applyFontSettings();
  applyToolbarSettings();
  refreshToolbarSettingsUI();

  // initial load
  textarea.value = (node.properties && node.properties.wg_text) || hiddenWidget.value || "";
  refreshLibrary().then(() => renderCatPins());
  render();

  // Wrap the actual UI in a padded, click-through frame before handing it to
  // addDOMWidget. The frame (not `root`) is what gets sized to the node, so
  // its padding ring is genuine gap around the whole widget — not covered
  // by any element — leaving the node's resize corner and ComfyUI's own
  // right-click context menu reachable at the edges instead of getting
  // swallowed by this DOM widget.
  const frame = document.createElement("div");
  frame.className = "wg-node-frame";
  frame.appendChild(root);

  return { 
    root: frame, 
    refreshFromHidden,
    cleanup: () => {
      document.removeEventListener("mousemove", handlePickerResizeMove);
      document.removeEventListener("mouseup", handlePickerResizeUp);
      document.removeEventListener("click", handleOutsideClick);
      document.removeEventListener("keydown", handleEscapeKey);
      if (acState && acState.textarea === textarea) closeAcMenu();
      if (injectState && injectState.textarea === textarea) closeInjectMenu();
      if (ctxMenuOpen) closeCtxMenu();
    }
  };
}

// --- Output-slot remap for PromptPaletteEditor's toggleable sockets -------
// IO_OUTPUT_DEFS (above, inside buildWildcardWidget) lets the user flip
// optional outputs on/off per node instance. Turning one on calls
// node.addOutput(), which LiteGraph always appends to the END of the live
// node.outputs array — so the *visible* socket order ends up being "whatever
// order the user happened to click the checkboxes in," not the Python node's
// fixed RETURN_TYPES/RETURN_NAMES tuple order.
//
// app.graphToPrompt() serializes a downstream link as [node_id, slot_index],
// where slot_index is the source socket's position in that live (visible)
// node.outputs array. The backend executor has no concept of "visible order"
// though — it only ever reads a node's Nth returned value, N = position in
// RETURN_NAMES. So the moment visible order and RETURN_NAMES order diverge,
// a link recorded with the visible index silently pulls whatever value
// happens to sit at that position in the backend tuple instead of the one
// the user actually wired up.
//
// Fix: after the frontend serializes the prompt, walk every link that
// originates from a PromptPaletteEditor node and rewrite its slot index from
// "position in the live node.outputs array" to "position in RETURN_NAMES."
// This only has to touch links; widget values serialize fine as-is.

// MUST exactly match the PromptPaletteEditor Python node's RETURN_NAMES
// tuple, in order — index here = the backend's real, fixed output position.
// If RETURN_NAMES on the Python side ever changes, update this to match.
const OUTPUT_SLOT_ORDER = [
  "model", "clip", "conditioning", "negative_conditioning", "prompt",
  "negative_prompt", "seed_out", "wildcards_used", "raw_text",
  "wildcards_used_count", "used_enhancer",
];

function remapPromptPaletteOutputs(promptResult) {
  const output = promptResult && promptResult.output;
  if (!output) return;

  for (const nodeId in output) {
    const inputs = output[nodeId] && output[nodeId].inputs;
    if (!inputs) continue;

    for (const inputName in inputs) {
      const val = inputs[inputName];
      // Links are always exactly [upstream_node_id, upstream_slot_index];
      // anything else (string/number/bool/array-shaped widget value) is a
      // literal, so the typeof check on val[1] is what tells them apart.
      if (!Array.isArray(val) || val.length !== 2 || typeof val[1] !== "number") continue;

      const [sourceId, visibleSlot] = val;
      const sourceNode = output[sourceId];
      if (!sourceNode || sourceNode.class_type !== "PromptPaletteEditor") continue;

      // prompt.output carries no frontend socket metadata, so cross-reference
      // the live graph node to find which output NAME actually sits at the
      // visible slot index the frontend recorded for this link.
      const liveNode = app.graph.getNodeById(sourceId) || app.graph.getNodeById(Number(sourceId));
      const liveOutputs = liveNode && liveNode.outputs;
      if (!liveOutputs || !liveOutputs[visibleSlot]) continue;

      const fixedSlot = OUTPUT_SLOT_ORDER.indexOf(liveOutputs[visibleSlot].name);
      if (fixedSlot === -1 || fixedSlot === visibleSlot) continue;

      inputs[inputName] = [sourceId, fixedSlot];
    }
  }
}

app.registerExtension({
  name: "comfyui.promptpalette.editor",
  // One-time, app-level patch — not tied to any single node's lifecycle, so
  // it belongs in setup() (fired once after ComfyUI's app finishes
  // initializing) rather than beforeRegisterNodeDef (fired per node type).
  // Guarded on `app` itself in case this extension script is ever loaded
  // more than once, so app.graphToPrompt only ever gets wrapped a single time.
  async setup() {
    if (app.__promptPaletteGraphToPromptPatched) return;
    app.__promptPaletteGraphToPromptPatched = true;

    const origGraphToPrompt = app.graphToPrompt.bind(app);
    app.graphToPrompt = async function (...args) {
      const promptResult = await origGraphToPrompt(...args);
      remapPromptPaletteOutputs(promptResult);
      return promptResult;
    };
  },
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "PromptPaletteEditor") return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;

      const hiddenWidget = this.widgets.find(w => w.name === "text");
      if (!hiddenWidget) return r;

      hiddenWidget.type = "hidden";
      hiddenWidget.computeSize = () => [0, -4];
      if (hiddenWidget.inputEl) hiddenWidget.inputEl.style.display = "none";

      const node = this;
      node.resizable = true;

      const MIN_WIDTH = 480;
      const MIN_HEIGHT = 370;

      const { root: container, refreshFromHidden, cleanup } = buildWildcardWidget(node, hiddenWidget);
      const domWidget = node.addDOMWidget("prompt_palette_ui", "div", container, {
        getValue: () => hiddenWidget.value,
        setValue: (v) => {
          hiddenWidget.value = v;
          node.properties = node.properties || {};
          node.properties.wg_text = v;
        },
        // The hidden "text" widget already serializes this value. Keeping this
        // DOM widget out of widgets_values avoids positional index drift between
        // it and the hidden widget across ComfyUI frontend versions/tab switches.
        serialize: false,
        // getMinHeight/getMaxHeight/getHeight are ComfyUI's own dedicated hooks
        // for "how big/where is this specific DOM element drawn" — used for
        // sizing, positioning, and the "Enable DOM element clipping" setting
        // (docs.comfy.org/interface/settings/lite-graph). Crucially, they are
        // NOT the same function LiteGraph's node-level auto-grow pass consults
        // to decide whether the *node* needs to get bigger — that's a
        // completely separate code path keyed off the node's own resize
        // handling, untouched here. So answering these honestly (no ceiling,
        // real current height) fixes the DOM-clipping ghosting bug without
        // reopening the runaway-growth bug: there's no shared function left
        // for the two concerns to fight over, unlike every previous attempt
        // that tried to make widget.computeSize serve both jobs at once.
        getMinHeight: () => MIN_HEIGHT,
        getMaxHeight: () => Infinity,
        getHeight: () => node.size[1],
      });
      node._wgRefreshFromHidden = refreshFromHidden;
      
      node.onRemoved = function () {
        if (cleanup) cleanup();
      };

      // --- Free resize, without the old runaway-growth bug OR the DOM-clip
      // --- ghosting bug --------------------------------------------------
      // Both bugs came from the same mistake: making ONE function (widget
      // computeSize) answer TWO different questions — "how much room does
      // this widget need" (which feeds LiteGraph's node auto-grow) and "how
      // big/where is the DOM element actually drawn" (which feeds ComfyUI's
      // DOM-widget clipping/positioning, see the "Enable DOM element
      // clipping" setting at docs.comfy.org/interface/settings/lite-graph).
      // Lying to it fixed auto-grow but broke clipping (ghosting). Telling
      // it the truth fixed clipping but reopened auto-grow, even after
      // trying to shield that through a node.computeSize override — because
      // node auto-grow isn't actually gated by node.computeSize here, it's
      // driven directly by whatever the DOM widget reports.
      //
      // addDOMWidget has dedicated options for the second question —
      // getMinHeight/getMaxHeight/getHeight, passed above — that are a
      // separate code path from the node's own resize/auto-grow handling.
      // Answering those honestly (no ceiling, real current height) no
      // longer has anything to feed back into node growth, because nothing
      // here reports widget size through node.computeSize (or LiteGraph's
      // own default widget-summing version of it) at all anymore. The node
      // itself only ever changes size from an actual user drag, and its
      // only job left is enforcing a floor on that.
      function clampSize() {
        if (node.size[0] < MIN_WIDTH) node.size[0] = MIN_WIDTH;
        if (node.size[1] < MIN_HEIGHT) node.size[1] = MIN_HEIGHT;
      }

      const onResize = node.onResize;
      node.onResize = function (size) {
        if (onResize) onResize.apply(this, arguments);
        clampSize();
      };

      node.setSize([Math.max(node.size[0], MIN_WIDTH), Math.max(node.size[1], MIN_HEIGHT)]);
      return r;
    };
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const r = onConfigure ? onConfigure.apply(this, arguments) : undefined;
      // Re-sync the visible textarea (and seed/mode/IO-toggle controls) after
      // ComfyUI reconfigures this node, e.g. when switching back to a workflow
      // tab. Deferred a tick so this runs after ComfyUI finishes restoring
      // widgets_values/properties.
      if (this._wgRefreshFromHidden) setTimeout(() => this._wgRefreshFromHidden(), 0);
      if (this._wgRefreshIoToggles) setTimeout(() => this._wgRefreshIoToggles(), 0);
      return r;
    };
  },
});