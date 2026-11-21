import { textColorForLora } from "./lora_colors.js";
import { loraAt, buildLoraExpression } from "../engine/lora_tags.js";
import { getSharedWildcardEngine } from "../engine/wildcard_engine.js";
import { isComfyQueueShortcut } from "../editor_shortcuts.js";
import { hydrateAcThumbnails } from "./autocomplete_previews.js";
import { libraryThumbnailActions } from "./thumbnails.js";
import { copyPromptPaletteThemeScope, onPromptPaletteAppearanceChanged } from "../prompt_palette_shared.js";
import { sanitizeHexColor, nudgeHexForContrast, currentUiSurface, categoryOf, hashStr, categoryColorFromHue } from "./text_utils.js";
import { createDomRangeForOffsets } from "./editor_surface.js";
import { API } from "../prompt_palette_api.js";
import { loadCustomWords, filterCustomWords, resetCustomWords } from "./custom_words.js";
import { recordInsertedTags, scanTagPieces } from "./booru_tag_colors.js";
import { notify } from "./notifications.js";
import { panelToneFor } from "./panel_tone.js";
import { tagSearch, formatArtistInsertion } from "./tag_search.js";
import { openCustomWordsManager } from "./custom_words_manager.js";
import { syntaxSnippetRows } from "./injector.js";
import { syntaxCodeHtml, syntaxTone } from "./syntax_presentation.js";
import { createPromptUsageStore } from "../prompt_quickness.js";
import { readEditorPreference, writeEditorPreference, getPromptPaletteSectionSnapshot } from "../prompt_palette_state.js";
import {
  loadTheme, saveTheme, DEFAULT_BOORU_COLORS_DARK, DEFAULT_BOORU_COLORS_LIGHT,
} from "./preferences.js";
import {
  styleAutocompleteSettings, shouldOpenStyleAutocomplete, preloadStyleAutocompleteCatalog,
  getStyleAutocompleteMatches, parseStyleAutocompleteQuery,
} from "./style_autocomplete.js";

function findWildcardFragment(text, caret) {
  const theme = loadTheme();
  const booruMinChars = Math.max(1, Math.min(12, Math.round(Number(theme.booruAutocompleteMinChars) || 2)));
  const effectiveMinChars = theme.styleAutocompleteEnabled === true && theme.styleAutocompleteMode !== "off"
    ? Math.min(booruMinChars, 2)
    : booruMinChars;
  return getSharedWildcardEngine().autocompleteContext(text, caret, { booruMinChars: effectiveMinChars, loraAutocomplete: theme.loraAutocomplete === true });
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
  for (const p of AC_MIRROR_PROPS) {
    const val = computed[p];
    if (acMirrorDiv.style[p] !== val) acMirrorDiv.style[p] = val;
  }
  if (acMirrorDiv.style.width !== computed.width) acMirrorDiv.style.width = computed.width;

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
// Editor that currently owns the shared menu, including while its first async
// match request is still in flight (acState is not set until results arrive).
let acOwner = null;
let acRequestVersion = 0;
let acInFlightRequests = 0;
let acThemeScopeCopied = null;
let acAppearanceEpoch = 0;
let acThemeScopeEpoch = -1;
let acMenuColorCache = null;
let unsubscribeAcAppearance = null;
// Draft of the inline "save custom word" form; lives only while the menu is open.
let acAddDraft = null;
let cleanupAcPreviews = () => {};
let unsubscribeAcLibrary = null, acContextVersion = 0;
const savedInsertOptions = readEditorPreference("booruInsertOptions", null);
let booruInsertOptions = { spaces: savedInsertOptions?.spaces === true, appendComma: savedInsertOptions?.appendComma === true };
let suppressAutocompleteInputFor = null;
function handleAcDocumentMouseDown(event) {
  const owner = acState?.textarea || acOwner;
  if (owner && !acMenu?.contains(event.target) && event.target !== owner && !owner.contains?.(event.target)) closeAcMenu();
}
function handleAcViewportChange(event) {
  cleanupAcPreviews.dismiss?.();
  if (event.target instanceof Node && acMenu?.contains(event.target)) return;
  if (event.type === "resize") { if (acState || acOwner) closeAcMenu(); }
  else if (acState && acMenu) positionAcMenu(acMenu);
}

function ensureAcMenu() {
  if (acMenu) return acMenu;
  acMenu = document.createElement("div");
  acMenu.className = "wg-ac-menu wg-root";
  acMenu.dataset.promptPaletteGlobal = "true";
  document.body.appendChild(acMenu);

  acMenu.addEventListener("mousedown", (e) => {
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;
    if (e.button !== 0) {
      if (e.button === 2 && target.closest("[data-ac-library]")) { e.preventDefault(); e.stopPropagation(); }
      return;
    }
    // Controls inside the menu act on mousedown (like the rows) and never steal focus from the editor.
    if (target.closest("[data-ac-clear-recents]")) {
      e.preventDefault();
      e.stopPropagation();
      clearAcRecents();
      return;
    }
    const rowIndex = () => Number(target.closest("[data-ac-index]")?.dataset.acIndex);
    if (target.closest("[data-ac-star]")) {
      e.preventDefault();
      e.stopPropagation();
      toggleAcFavorite(rowIndex());
      return;
    }
    if (target.closest("[data-ac-remove]")) {
      e.preventDefault();
      e.stopPropagation();
      removeAcRecent(rowIndex());
      return;
    }
    const insertOption = target.closest("[data-ac-insert-option]");
    if (insertOption) {
      e.preventDefault();
      e.stopPropagation();
      const mode = insertOption.dataset.acInsertOption;
      if (mode === "spaces") booruInsertOptions.spaces = !booruInsertOptions.spaces;
      if (mode === "comma") booruInsertOptions.appendComma = !booruInsertOptions.appendComma;
      writeEditorPreference("booruInsertOptions", booruInsertOptions);
      renderAcMenu();
      return;
    }
    const head = target.closest("[data-ac-toggle]");
    if (head) {
      e.preventDefault();
      toggleAcSection(head.dataset.acToggle);
      return;
    }
    const row = target.closest("[data-ac-index]");
    if (!row) return;
    e.preventDefault();
    commitAcSelection(Number(row.dataset.acIndex));
  });
  acMenu.addEventListener("contextmenu", async event => {
    const row = event.target.closest?.("[data-ac-index]");
    const state = acState, raw = row && state?.items[Number(row.dataset.acIndex)];
    if (!raw) return;
    const item = normalizeAcItem(raw);
    event.preventDefault(); event.stopPropagation();
    cleanupAcPreviews.dismiss?.();
    const request = ++acContextVersion, owner = state.textarea, source = owner.value;
    try {
      const { openCtxMenu } = await import("./context_menu.js");
      if (acState !== state || request !== acContextVersion || !row.isConnected || !owner.isConnected) return;
      const actions = [
        { label: "Insert suggestion", icon: "plus", group: "insert", onSelect: () => {
          if (!owner.isConnected || owner.value !== source) { notify("info", "Prompt changed", "Open suggestions again to insert this item."); return; }
          commitAcSelection(Number(row.dataset.acIndex), state);
        } },
        { label: "Copy " + (item.insertMode === "library" ? "wildcard reference" : "suggestion text"), icon: "copy", group: "clipboard", onSelect: () => navigator.clipboard.writeText(item.insertText ?? (item.insertMode === "library" ? `__${item.value}__` : item.value)) },
      ];
      if (item.insertMode === "library" && !["booru", "custom", "syntax", "lora"].includes(item.kind)) {
        const thumbnails = await API.categories().catch(() => null);
        if (thumbnails) actions.push(...libraryThumbnailActions(item.value, { hasThumbnail: !!thumbnails[item.value], editable: Object.hasOwn(thumbnails, item.value), isActive: () => owner.isConnected }));
      }
      if (acState !== state || request !== acContextVersion || !owner.isConnected) return;
      const scope = owner.closest(".wg-root, .wg-node, .pp-node, .ppwc-surface");
      closeAcMenu();
      openCtxMenu(event.clientX, event.clientY, actions, { scope });
    } catch (error) {
      if (owner.isConnected) notify("error", "Suggestion actions unavailable", error?.message || String(error));
    }
  });
  acMenu.addEventListener("wheel", event => {
    event.stopPropagation();
  }, { passive: true });
  // Providers refresh their own library snapshots asynchronously. Invalidate the
  // lookup too, so a deleted/renamed suggestion cannot commit during that refresh.
  unsubscribeAcLibrary = API.onLibraryChanged(closeAcMenu);
  unsubscribeAcAppearance = onPromptPaletteAppearanceChanged(() => { acAppearanceEpoch += 1; });
  document.addEventListener("mousedown", handleAcDocumentMouseDown);
  document.addEventListener("contextmenu", handleAcDocumentMouseDown);
  document.addEventListener("scroll", handleAcViewportChange, true);
  window.addEventListener("resize", handleAcViewportChange);
  return acMenu;
}

function closeAcMenu() {
  acContextVersion++;
  cleanupAcPreviews(); cleanupAcPreviews = () => {};
  acRequestVersion += 1;
  acAddDraft = null;
  acOwner = null;
  if (!acMenu) { acState = null; return; }
  acMenu.style.display = "none";
  acState = null;
}

// Tallest the menu will grow (it is further limited to the space beside the caret).
const AC_MAX_HEIGHT = 640;

const BOORU_CATEGORY_TITLES = {
  general: "General",
  character: "Character",
  copyright: "Copyright / series",
  artist: "Artist",
  meta: "Meta",
  custom: "Custom words",
};

function booruSettings() {
  const theme = loadTheme();
  // Booru/custom-word autocomplete is opt-in: it stays off until the user enables it in Options.
  let enabled = theme.booruAutocompleteEnabled === true;
  let mode = ["auto", "onDemand", "off"].includes(theme.booruAutocompleteMode) ? theme.booruAutocompleteMode : (enabled ? "auto" : "off");
  if (!enabled) mode = "off";
  if (mode === "off") enabled = false;
  return {
    enabled,
    mode,
    minChars: Math.max(1, Math.min(12, Number(theme.booruAutocompleteMinChars) || 2)),
    database: theme.booruSourceDatabase !== false,
    customWords: theme.booruSourceCustomWords !== false,
  };
}

async function getBooruAutocompleteMatches(query) {
  const search = tagSearch(query);
  const q = search.query.toLowerCase();
  if (search.anima) {
    try { return await API.animaArtists(q); } catch { return []; }
  }
  const settings = booruSettings();
  if (!q || q.length < settings.minChars || (!settings.database && !settings.customWords)) return [];

  const rows = [];
  const seen = new Set();
  const add = (item) => {
    if (!item?.value) return;
    const label = String(item.label ?? item.value);
    const key = `${label.toLowerCase()}\u0000${String(item.value)}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push(item);
  };

  try {
    const databasePromise = settings.database ? API.booruTags(q, search.category) : Promise.resolve([]);
    const customPromise = settings.customWords
      ? loadCustomWords().then((words) => filterCustomWords(words, q, 24, { category: search.category }))
      : Promise.resolve([]);
    const [databaseResult, customResult] = await Promise.allSettled([databasePromise, customPromise]);
    const database = databaseResult.status === "fulfilled" && Array.isArray(databaseResult.value)
      ? databaseResult.value : [];
    const custom = customResult.status === "fulfilled" && Array.isArray(customResult.value)
      ? customResult.value : [];

    // Each source is independent: a broken/oversized custom-word source must not hide
    // otherwise healthy database results, and vice versa. Exact custom matches still win.
    const exactCustom = custom.filter((item) => item?.exactCustomMatch === true || String(item?.label || "").trim().toLowerCase() === q);
    const otherCustom = custom.filter((item) => !(item?.exactCustomMatch === true || String(item?.label || "").trim().toLowerCase() === q));
    exactCustom.forEach(add);
    database.forEach(add);
    otherCustom.forEach(add);
  } catch {
    // Booru autocomplete is optional; preserve whichever local source can still answer.
    if (settings.customWords) {
      try {
        (await loadCustomWords().then((words) => filterCustomWords(words, q, 24, { category: search.category })))
          .forEach(add);
      } catch { /* optional source */ }
    }
  }

  return rows.slice(0, 84);
}

function shouldOpenBooruAutocomplete(fragment, { onDemand = false } = {}) {
  if (!fragment || fragment.kind !== "booru") return true;
  if (tagSearch(fragment.query).anima) return true;
  const settings = booruSettings();
  if (!settings.enabled || settings.mode === "off") return false;
  if (settings.mode === "onDemand" && !onDemand) return false;
  if (!settings.database && !settings.customWords) return false;
  return tagSearch(fragment.query).query.length >= settings.minChars;
}

function shouldOpenTextAutocomplete(fragment, { onDemand = false } = {}) {
  return shouldOpenBooruAutocomplete(fragment, { onDemand }) || shouldOpenStyleAutocomplete(fragment, { onDemand });
}

function expandAutocompleteReplacementRange(text, fragment, caret) {
  if (!fragment) return fragment;
  const source = String(text || "");
  let end = Math.max(fragment.end ?? caret, caret);
  const isBooruChar = (char) => /[A-Za-z0-9_+():'\/\\\-]/.test(char || "");
  const isWildcardNameChar = (char) => /[A-Za-z0-9_\-/]/.test(char || "");

  if (fragment.kind === "lora") {
    const existing = loraAt(source, fragment.start);
    return existing ? { ...fragment, end: existing.end } : fragment;
  }
  if (fragment.kind === "booru") {
    let depth = 0;
    for (let i = fragment.start; i < end; i++) {
      if (source[i] === "\\") { i++; continue; }
      if (source[i] === "(") depth++;
      else if (source[i] === ")") depth--;
    }
    while (end < source.length && isBooruChar(source[end])) {
      // Keep surrounding weight syntax outside the tag replacement.
      if (source[end] === ":" && /^:\s*[+-]?(?:\d|\.\d)/.test(source.slice(end))) break;
      if (source[end] === ")" && depth <= 0) break;
      if (source[end] === "\\" && /[()]/.test(source[end + 1] || "")) { end += 2; continue; }
      if (source[end] === "(") depth++;
      else if (source[end] === ")") depth--;
      end++;
    }
    return { ...fragment, end };
  }

  if (fragment.kind === "wildcard") {
    // Only consume a closer belonging to this name, never one beyond whitespace
    // or punctuation (which may open an entirely different wildcard).
    while (end < source.length && isWildcardNameChar(source[end])) {
      if (source.startsWith("__", end)) return { ...fragment, end: end + 2 };
      end += 1;
    }
    return { ...fragment, end };
  }
  return fragment;
}

function compactCount(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return "";
  const abs = Math.abs(number);
  if (abs < 1000) return number.toLocaleString();
  const units = [[1e9, "B"], [1e6, "M"], [1e3, "K"]];
  for (const [threshold, suffix] of units) {
    if (abs >= threshold) {
      const scaled = number / threshold;
      const digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 1;
      return `${scaled.toFixed(digits).replace(/\.0$/, "")}${suffix}`;
    }
  }
  return number.toLocaleString();
}

function normalizePromptTag(value) {
  return String(value || "")
    .trim()
    .replace(/\\([()])/g, "$1")
    .replace(/\s+/g, "_")
    .toLocaleLowerCase();
}

// Menu rows ask "is this already in the prompt?" once per row. Scan the prompt once per render
// and answer every row from that index; the old per-row rescans made the menu cost
// (rows x prompt length) on every keystroke.
function createPromptPresence(text) {
  const source = String(text || "");
  let tagKeys = null;
  let lower = null;
  return {
    // Same tag boundaries as prompt coloring. Splitting at spaces loses multiword tags
    // inserted with "spaces" enabled, and weight wrappers hide tags.
    hasTag(candidate) {
      const wanted = normalizePromptTag(candidate);
      if (!wanted) return false;
      if (!tagKeys) tagKeys = new Set(scanTagPieces(source).map(piece => piece.key));
      return tagKeys.has(wanted);
    },
    // __name__ with an optional modifier prefix, case-insensitive (same rule as before).
    hasLibraryEntry(path) {
      const name = String(path || "").trim().toLowerCase();
      if (!name) return false;
      if (lower === null) lower = source.toLowerCase();
      if (!lower.includes("__")) return false;
      for (const prefix of LIBRARY_TOKEN_PREFIXES) if (lower.includes("__" + prefix + name + "__")) return true;
      return false;
    },
  };
}
const LIBRARY_TOKEN_PREFIXES = ["", "+", "-", "*", "%", "~", "@"];

function cssColorToHex(value, fallback) {
  const raw = String(value || "").trim();
  const hex = raw.match(/^#([0-9a-f]{6})$/i);
  if (hex) return `#${hex[1]}`;
  const rgb = raw.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (rgb) return `#${[rgb[1], rgb[2], rgb[3]].map(channel => Number(channel).toString(16).padStart(2, "0")).join("")}`;
  // color-mix() backgrounds serialize as color(srgb ...) in modern browsers.
  // Read that resolved surface instead of contrasting against a theme fallback.
  const srgb = raw.match(/^color\(srgb\s+([+-]?[\d.]+)\s+([+-]?[\d.]+)\s+([+-]?[\d.]+)(?:\s*\/\s*[\d.]+)?\s*\)$/i);
  if (srgb) return `#${srgb.slice(1, 4).map(channel => Math.max(0, Math.min(255, Math.round(Number(channel) * 255))).toString(16).padStart(2, "0")).join("")}`;
  return fallback;
}

function resolvedBooruMenuColors(menu, theme = loadTheme(), panelHex = null) {
  const tone = menu.dataset.acTone === "light" ? "light" : "dark";
  const defaults = tone === "light" ? DEFAULT_BOORU_COLORS_LIGHT : DEFAULT_BOORU_COLORS_DARK;
  const saved = theme.booruColors && typeof theme.booruColors === "object" ? theme.booruColors : {};
  const base = theme.booruColorsCustomized ? { ...defaults, ...saved } : { ...defaults };
  const panel = panelHex || cssColorToHex(getComputedStyle(menu).backgroundColor, currentUiSurface());
  return Object.fromEntries(Object.keys(defaults).map((key) => [
    key, nudgeHexForContrast(sanitizeHexColor(base[key], defaults[key]), panel),
  ]));
}

function applyBooruMenuColors(menu, theme = loadTheme(), panelHex = null) {
  if (!menu) return;
  const colors = resolvedBooruMenuColors(menu, theme, panelHex);
  Object.entries(colors).forEach(([key, value]) => menu.style.setProperty(`--pp-booru-${key}`, value));
}

// ---- Recents, favorites and collapsible sections --------------------------------------------
let acStoreInstance = null;
function acStore() {
  if (!acStoreInstance) acStoreInstance = createPromptUsageStore();
  return acStoreInstance;
}

// Recents stay short so the menu never turns into a history list (5-10, default 5).
function acRecentLimit() {
  const value = Math.round(Number(loadTheme().autocompleteRecentLimit));
  return Number.isFinite(value) ? Math.max(5, Math.min(10, value)) : 5;
}

let acCollapsed = null;
function collapsedSections() {
  if (!acCollapsed) {
    let saved = null;
    try { saved = readEditorPreference("acCollapsed", {}); } catch { /* collapse state is a convenience */ }
    acCollapsed = saved && typeof saved === "object" && !Array.isArray(saved) ? { ...saved } : {};
  }
  return acCollapsed;
}
function toggleAcSection(section) {
  if (!section || acState?.kind === "syntax") return;
  const collapsed = collapsedSections();
  if (collapsed[section]) delete collapsed[section]; else collapsed[section] = true;
  try { writeEditorPreference("acCollapsed", { ...collapsed }); } catch { /* collapse state is a convenience */ }
  if (acState) renderAcMenu();
}

let acFavorites = new Map();
let acFavoritesSnapshotRef;
function tagFavoriteKey(kind, value) {
  return `${kind === "custom" ? "custom" : "booru"}\u0000${String(value || "").trim().toLowerCase()}`;
}
function loadAcFavorites() {
  const snapshot = getPromptPaletteSectionSnapshot("quickness");
  if (snapshot === acFavoritesSnapshotRef) return;
  acFavoritesSnapshotRef = snapshot;
  try {
    acFavorites = new Map(acStore().tagFavorites().map((entry) => [tagFavoriteKey(entry.kind, entry.value), entry]));
  } catch { acFavorites = new Map(); }
}
function rawTagKind(item) {
  if (!item || typeof item !== "object") return "";
  if (item.group === "Booru Tags" || item.kind === "booru") return "booru";
  if (item.group === "Custom Words" || item.kind === "custom") return "custom";
  return "";
}
function acItemKey(item) {
  return `${item?.kind || ""}\u0000${String(item?.value ?? item?.label ?? "")}`;
}

// Runs a source lookup, then applies the shared menu rules every editor relies on:
//  - after "__": library/wildcard rows stay first and matching tags follow;
//  - starred tags/custom words are flagged (and surfaced even when the lookup missed them);
//  - Recents are capped.
let loraCatalogCache = null, loraCatalogAt = 0;
async function loraMatches(query) {
  if (!loraCatalogCache || Date.now() - loraCatalogAt > 15000) {
    loraCatalogAt = Date.now();
    loraCatalogCache = API.loras().then(result => result.names || []).catch(error => { loraCatalogCache = null; throw error; });
  }
  const names = await loraCatalogCache;
  return names.filter(name => name.toLocaleLowerCase().includes(query.toLocaleLowerCase())).slice(0, 80).flatMap(name => {
    try { return [{ kind: "lora", group: "Local LoRAs", value: name, label: name, insertMode: "plain", insertText: buildLoraExpression({ names: [name] }) }]; }
    catch { return []; }
  });
}
async function resolveAcItems(getMatches, query, kind, { textarea = null, onDemand = false } = {}) {
  if (kind === "lora") return withLookupTimeout(loraMatches(query));
  const booruSearch = kind === "booru" ? tagSearch(query) : { category: "", anima: false };
  const scoped = kind === "booru" && booruSearch.anima;
  const styleActive = kind === "booru" && !scoped && shouldOpenStyleAutocomplete({ kind, query }, { onDemand });
  const parsedStyle = styleActive ? parseStyleAutocompleteQuery(query) : null;
  if (parsedStyle?.explicit && !booruSearch.category) {
    const activeNode = textarea?.__ppNode || null;
    const styleItems = await withLookupTimeout(getStyleAutocompleteMatches(query, { textarea, activeNode }));
    return decorateAcItems(Array.isArray(styleItems) ? styleItems : [], query, kind);
  }
  const booruActive = kind !== "booru" || scoped || shouldOpenBooruAutocomplete({ kind, query }, { onDemand });
  const basePromise = scoped
    ? getBooruAutocompleteMatches(query)
    : booruActive
      ? Promise.resolve(getMatches(query, kind))
      : Promise.resolve([]);
  const stylePromise = parsedStyle && !booruSearch.category
    ? getStyleAutocompleteMatches(query, { textarea, activeNode: textarea?.__ppNode || null }).catch(() => [])
    : Promise.resolve([]);
  const [rawItems, styleItems] = await withLookupTimeout(Promise.all([basePromise, stylePromise]));
  const combined = Array.isArray(styleItems) && styleItems.length
    ? [...styleItems, ...(Array.isArray(rawItems) ? rawItems : [])]
    : (Array.isArray(rawItems) ? rawItems : []);
  return decorateAcItems(combined, query, kind);
}

async function decorateAcItems(items, query, kind) {
  if (kind !== "booru" && kind !== "wildcard") return items;
  const search = kind === "booru" ? tagSearch(query) : { query, category: "" };
  if (search.anima) {
    loadAcFavorites();
    return items.filter(item => item.source === "anima" && item.category === "artist")
      .map(item => ({ ...item, favorite: acFavorites.has(tagFavoriteKey("booru", item.value)) }));
  }
  const q = String(search.query || "").trim().toLowerCase();
  const settings = booruSettings();
  const tagsEnabled = settings.enabled && (settings.database || settings.customWords);
  let rows = search.category ? items.filter(item => rawTagKind(item) && item.category === search.category) : items.slice();

  if (kind === "wildcard" && tagsEnabled) {
    try {
      const tags = await withLookupTimeout(getBooruAutocompleteMatches(q));
      rows = rows.concat(tags.slice(0, 16));
    } catch { /* tags are optional; the library rows stand on their own */ }
  }

  if (tagsEnabled) {
    loadAcFavorites();
    if (acFavorites.size) {
      const present = new Set();
      rows = rows.map((item) => {
        const tagKind = rawTagKind(item);
        if (!tagKind) return item;
        const key = tagFavoriteKey(tagKind, item.value);
        if (!acFavorites.has(key)) return item;
        present.add(key);
        return { ...item, favorite: true };
      });
      const extra = [];
      for (const [key, entry] of acFavorites) {
        if (search.category && entry.category !== search.category) continue;
        if (present.has(key)) continue;
        if (q && !entry.value.toLowerCase().includes(q)) continue;
        const hasCategory = !(entry.kind === "custom" && entry.category === "custom");
        extra.push({
          value: entry.value, label: entry.value, kind: entry.kind, group: entry.kind === "custom" ? "Custom Words" : "Booru Tags",
          category: entry.category, hasCategory, favorite: true, insertMode: "plain", priority: 2,
        });
        if (extra.length >= 12) break;
      }
      rows = extra.concat(rows);
    }
  }

  const limit = acRecentLimit();
  let recents = 0;
  return rows.filter((item) => {
    if (!item || typeof item !== "object" || !item.recent || item.kind === "style") return true;
    if (item.favorite && rawTagKind(item)) return true; // shown under Favorite Tags, not Recents
    recents += 1;
    return recents <= limit;
  });
}

async function refreshAcItems(keepKey = null) {
  const state = acState;
  if (!state?.getMatches) return;
  const version = ++acRequestVersion;
  try {
    const items = await resolveAcItems(state.getMatches, state.query, state.kind, { textarea: state.textarea, onDemand: true });
    if (version !== acRequestVersion || acState !== state) return;
    state.items = items;
    state.keepActiveKey = keepKey;
  } catch { /* keep the list that is already showing */ }
  if (acState === state) renderAcMenu();
}

function activeKeyExcept(raw) {
  const active = acState?.items?.[acState.activeIndex];
  return active && active !== raw ? acItemKey(normalizeAcItem(active)) : null;
}

function toggleAcFavorite(index) {
  const raw = acState?.items?.[index];
  if (raw == null) return;
  const item = normalizeAcItem(raw);
  if (item.kind === "style") {
    try {
      acStore().toggleStyleFavorite?.(item.styleId || item.value);
    } catch { return; }
    refreshAcItems(acItemKey(item));
    return;
  }
  if (item.kind !== "booru" && item.kind !== "custom") return;
  try {
    acStore().toggleTagFavorite(item.kind, item.value, item.hasCategory ? item.category : "");
  } catch { return; }
  refreshAcItems(acItemKey(item));
}

function removeAcRecent(index) {
  const raw = acState?.items?.[index];
  if (raw == null) return;
  const item = normalizeAcItem(raw);
  if (!item.recent) return;
  const keep = activeKeyExcept(raw);
  const textarea = acState.textarea;
  try {
    acStore().removeRecent(item.kind === "booru" || item.kind === "custom" ? item.kind : "library", item.value);
    textarea?.__ppAcRecentsChanged?.();
  } catch { return; }
  refreshAcItems(keep);
}

function clearAcRecents() {
  if (!acState) return;
  const textarea = acState.textarea;
  try {
    acStore().clearAutocompleteRecent();
    textarea?.__ppAcRecentsChanged?.();
  } catch { return; }
  refreshAcItems(null);
}

function insertBooruValue(value, item) {
  let text = formatArtistInsertion(item, String(value || "").trim(), loadTheme().animaArtistFormatting === true || (acState?.kind === "booru" && tagSearch(acState.query).anima === true));
  // Tag parentheses are literal text, not CLIP weight delimiters. Preserve
  // already escaped parentheses; an even backslash run still needs an escape.
  text = text.replace(/(\\*)[()]/g, (match, slashes) => slashes.length % 2 ? match : "\\" + match);
  if (booruInsertOptions.spaces) text = text.replace(/_/g, " ");
  if (booruInsertOptions.appendComma) text += ", ";
  return text;
}

function sectionForItem(item) {
  if (item?.source === "anima") return "Anima Artists";
  if (item.kind === "style") return item.favorite ? "Favorite Styles" : "Krea 2 & MOSS Styles";
  if (item.favorite && (item.kind === "booru" || item.kind === "custom" || item.group === "Booru Tags" || item.group === "Custom Words")) return "Favorite Tags";
  if (item.recent) return "Recents";
  if (item.kind === "booru") return "Booru Tags";
  if (item.kind === "custom") return "Custom Words";
  if (item.kind === "syntax") return "Syntax";
  if (item.kind === "recipe") return "Recipes";
  if (item.kind === "recent" || item.group === "Recent" || item.group === "Recents") return "Recents";
  if (item.kind === "favorite" || item.group === "Favorites") return "Favorites";
  if (item.group === "My Library") return "Library Prompts";
  if (item.kind === "starter" || item.group === "Starter Packs") return "Library Prompts";
  return item.group || "Library Prompts";
}

function normalizeAcItem(item) {
  if (typeof item === "string") return {
    value: item, label: item, group: "My Library", kind: "library", section: "Library Prompts",
    category: "general", hasCategory: false, count: 0, alias: "", priority: 0, insertText: null, insertMode: "library", selectInserted: false, favorite: false,
  };
  const count = Number(item?.count);
  const priority = Number(item?.priority);
  const group = String(item?.group || "My Library");
  // Keep the source boundary explicit: booru/custom rows are plain prompt tags, while
  // library/favorite/recent rows are the only rows allowed to become __library__ tokens.
  let kind = String(item?.kind || "library");
  if (group === "Booru Tags") kind = "booru";
  else if (group === "Custom Words") kind = "custom";
  return {
    value: String(item?.value ?? item?.label ?? ""),
    source: String(item?.source || ""),
    label: String(item?.label ?? item?.value ?? ""),
    group,
    meta: String(item?.meta || ""),
    kind,
    category: String(item?.category || "general").toLowerCase(),
    hasCategory: !!item?.category,
    facet: String(item?.facet || ""),
    facetLabel: String(item?.facetLabel || ""),
    modelBadge: String(item?.modelBadge || ""),
    conflict: !!item?.conflict,
    conflictReason: String(item?.conflictReason || ""),
    styleId: String(item?.styleId || ""),
    negativeHint: String(item?.negativeHint || ""),
    count: Number.isFinite(count) && count > 0 ? count : 0,
    alias: String(item?.alias || ""),
    priority: Number.isFinite(priority) ? priority : 0,
    insertText: item?.insertText == null ? null : String(item.insertText),
    selectInserted: !!item?.selectInserted,
    selectRange: Array.isArray(item?.selectRange) && item.selectRange.length === 2 ? item.selectRange.map(Number) : null,
    exactCustomMatch: item?.exactCustomMatch === true,
    matchedAlias: String(item?.matchedAlias || ""),
    insertMode: item?.insertMode === "plain" ? "plain" : item?.insertMode === "library" ? "library" : ((kind === "booru" || kind === "custom") ? "plain" : "library"),
    favorite: !!item?.favorite,
    recent: !!item?.recent,
    recipe: !!item?.recipe,
    swatch: typeof item?.swatch === "string" ? item.swatch : "",
    code: String(item?.code || ""),
    syntaxTone: String(item?.syntaxTone || syntaxTone(String(item?.code || ""))),
    section: sectionForItem(item),
  };
}

function appendHighlightedText(parent, value, query) {
  const text = String(value || "");
  const q = String(query || "").trim();
  if (!q) {
    parent.textContent = text;
    return;
  }
  const lower = text.toLocaleLowerCase();
  const lowerQ = q.toLocaleLowerCase();
  const index = lower.indexOf(lowerQ);
  if (index < 0) {
    parent.textContent = text;
    return;
  }
  parent.append(document.createTextNode(text.slice(0, index)));
  const match = document.createElement("span");
  match.className = "wg-ac-match";
  match.textContent = text.slice(index, index + q.length);
  parent.append(match, document.createTextNode(text.slice(index + q.length)));
}

function appendPill(parent, value, modifier = "") {
  const text = String(value || "").trim();
  if (!text) return;
  const pill = document.createElement("span");
  pill.className = `wg-ac-pill${modifier ? ` ${modifier}` : ""}`;
  pill.textContent = text;
  pill.title = text;
  parent.appendChild(pill);
  return pill;
}

function focusAcField(field) {
  if (!acMenu) return;
  const input = acMenu.querySelector(`[data-ac-field="${field}"]`);
  if (!input) return;
  input.focus({ preventScroll: true });
  input.select?.();
}

function cancelAcAdd() {
  const textarea = acState?.textarea;
  acAddDraft = null;
  if (acState) renderAcMenu();
  textarea?.focus();
}

async function saveAcCustomWord() {
  const draft = acAddDraft;
  if (!draft || draft.busy) return;
  const word = draft.word.trim();
  if (!word) {
    draft.error = "Enter the word or phrase to insert.";
    draft.focus = "word";
    renderAcMenu();
    return;
  }
  draft.busy = true;
  draft.error = "";
  renderAcMenu();
  const result = await API.addCustomWord(word, draft.trigger.trim(), draft.category);
  resetCustomWords();
  if (acAddDraft !== draft) return; // menu was closed while saving
  draft.busy = false;
  if (result?.ok !== true) {
    draft.error = result?.error || "Couldn't save the custom word.";
    draft.focus = "word";
    renderAcMenu();
    return;
  }
  notify("success", result.created === false ? "Already saved" : "Custom word saved", word);
  const state = acState;
  acAddDraft = null;
  if (!state) return;
  // Re-run the current lookup so the new word appears in the list right away.
  const version = ++acRequestVersion;
  try {
    const items = state.getMatches ? await resolveAcItems(state.getMatches, state.query, state.kind, { textarea: state.textarea, onDemand: true }) : null;
    if (Array.isArray(items) && version === acRequestVersion && acState === state) state.items = items;
  } catch { /* the saved word will show on the next keystroke */ }
  if (acState === state) renderAcMenu();
  state.textarea?.focus();
}

function createAcImagesToggle(theme = loadTheme()) {
  const imagesToggle = document.createElement("button");
  const active = theme.autocompletePreviews !== false;
  imagesToggle.type = "button";
  imagesToggle.className = "wg-ac-images wg-ac-option" + (active ? " active" : "");
  imagesToggle.textContent = "Images";
  imagesToggle.setAttribute("aria-pressed", String(active));
  imagesToggle.title = "Show attached thumbnails and a hover preview; entries without images stay as text.";
  imagesToggle.addEventListener("mousedown", event => { event.preventDefault(); event.stopPropagation(); });
  imagesToggle.addEventListener("click", () => {
    const latest = loadTheme();
    latest.autocompletePreviews = latest.autocompletePreviews === false;
    saveTheme(latest);
    renderAcMenu();
  });
  return imagesToggle;
}

function buildAcFooter(theme = loadTheme()) {
  const footer = document.createElement("div");
  footer.className = "wg-ac-footer";
  if (acState?.kind !== "booru") {
    footer.classList.add("wg-ac-footer-compact");
    const hint = document.createElement("span");
    hint.className = "wg-ac-footer-hint";
    hint.textContent = acState?.kind === "syntax" ? "Tab/Enter to insert" : "Tab/Enter to insert · Right-click for actions";
    const options = document.createElement("span");
    options.className = "wg-ac-insert-options";
    options.appendChild(createAcImagesToggle(theme));
    footer.append(hint, options);
    return footer;
  }
  if (tagSearch(acState.query).anima) {
    const hint = document.createElement("span"); hint.className = "wg-ac-footer-hint";
    hint.textContent = "Local Anima snapshot · checkpoint support unverified";
    const options = document.createElement("span");
    options.className = "wg-ac-insert-options";
    const comma = document.createElement("button"); comma.type = "button";
    comma.className = "wg-ac-option" + (booruInsertOptions.appendComma ? " active" : "");
    comma.dataset.acInsertOption = "comma"; comma.textContent = ", "; comma.title = "Append a comma and space after the artist";
    options.append(createAcImagesToggle(theme), comma);
    footer.append(hint, options); return footer;
  }

  const stylePrefix = styleAutocompleteSettings().enabled && parseStyleAutocompleteQuery(acState.query).explicit;
  const booruActive = shouldOpenBooruAutocomplete({ kind: "booru", query: acState.query }, { onDemand: true });
  if (stylePrefix || (!booruActive && styleAutocompleteSettings().enabled)) {
    footer.classList.add("wg-ac-footer-compact");
    const hint = document.createElement("span");
    hint.className = "wg-ac-footer-hint";
    hint.textContent = "Styles: cam: lens: angle: framing: pose: light: atmo: style: krea: moss:";
    const options = document.createElement("span");
    options.className = "wg-ac-insert-options";
    options.appendChild(createAcImagesToggle(theme));
    footer.append(hint, options);
    return footer;
  }
  if (!acAddDraft) {
    const hint = document.createElement("span");
    hint.className = "wg-ac-footer-hint";
    hint.textContent = "Not finding it?";

    const options = document.createElement("span");
    options.className = "wg-ac-insert-options";
    const spacesToggle = document.createElement("button");
    spacesToggle.type = "button";
    spacesToggle.className = "wg-ac-option" + (booruInsertOptions.spaces ? " active" : "");
    spacesToggle.dataset.acInsertOption = "spaces";
    spacesToggle.title = "Replace tag underscores with spaces when inserting";
    spacesToggle.textContent = "spaces";
    const commaToggle = document.createElement("button");
    commaToggle.type = "button";
    commaToggle.className = "wg-ac-option" + (booruInsertOptions.appendComma ? " active" : "");
    commaToggle.dataset.acInsertOption = "comma";
    commaToggle.title = "Append a comma and space after the inserted tag";
    commaToggle.textContent = ", ";
    options.append(createAcImagesToggle(theme), spacesToggle, commaToggle);

    const add = document.createElement("button");
    add.type = "button";
    add.className = "wg-ac-add";
    add.title = "Save your own word or phrase to the local custom words list";
    add.textContent = "+ Custom word";
    add.addEventListener("mousedown", (e) => e.preventDefault());
    add.addEventListener("click", () => {
      acAddDraft = { word: String(acState?.query || ""), trigger: "", category: "", busy: false, error: "", focus: "word" };
      renderAcMenu();
    });
    const manage = document.createElement("button");
    manage.type = "button";
    manage.className = "wg-ac-add wg-ac-manage";
    manage.title = "Remove, import or export your custom words";
    manage.textContent = "Manage";
    manage.addEventListener("mousedown", (e) => e.preventDefault());
    manage.addEventListener("click", () => {
      const source = acState?.textarea || null;
      closeAcMenu();
      openCustomWordsManager({ themeSource: source });
    });
    const selectionStart = acState?.textarea?.selectionStart ?? 0;
    const selectionEnd = acState?.textarea?.selectionEnd ?? selectionStart;
    const saveList = acState?.textarea?.__ppSaveSelectionAsList;
    const actions = document.createElement("span");
    actions.className = "wg-ac-footer-actions";
    if (typeof saveList === "function" && selectionEnd > selectionStart) {
      const build = document.createElement("button");
      build.type = "button";
      build.className = "wg-ac-add wg-ac-build";
      build.title = "Turn the selected comma/newline-separated tags into a local wildcard list";
      build.textContent = "Save as list";
      build.addEventListener("mousedown", e => e.preventDefault());
      build.addEventListener("click", async () => {
        const source = acState?.textarea;
        const start = source?.selectionStart ?? selectionStart;
        const end = source?.selectionEnd ?? selectionEnd;
        closeAcMenu();
        await saveList(start, end);
      });
      actions.append(build);
    }
    actions.append(add, manage);
    footer.append(hint, options, actions);
    return footer;
  }

  footer.classList.add("adding");
  const form = document.createElement("div");
  form.className = "wg-ac-add-form";
  const makeInput = (field, placeholder, label) => {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "wg-ac-add-input";
    input.dataset.acField = field;
    input.placeholder = placeholder;
    input.setAttribute("aria-label", label);
    input.maxLength = 500;
    input.spellcheck = false;
    input.autocomplete = "off";
    input.value = acAddDraft[field];
    input.disabled = acAddDraft.busy;
    input.addEventListener("input", () => { acAddDraft[field] = input.value; });
    input.addEventListener("keydown", (e) => {
      if (isComfyQueueShortcut(e)) { closeAcMenu(); return; }
      e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); saveAcCustomWord(); }
      else if (e.key === "Escape") { e.preventDefault(); cancelAcAdd(); }
    });
    return input;
  };
  const wordInput = makeInput("word", "Word or phrase to insert", "Word or phrase to insert");
  const triggerInput = makeInput("trigger", "Shortcuts, comma-separated (optional)", "Shortcuts to type, comma-separated, optional");
  const categorySelect = document.createElement("select");
  categorySelect.className = "wg-ac-add-category";
  categorySelect.dataset.acField = "category";
  categorySelect.title = "Tag type: colors the word like a booru tag of that category";
  categorySelect.setAttribute("aria-label", "Tag type");
  for (const [value, label] of [["", "No type"], ["general", "General"], ["character", "Character"], ["copyright", "Series"], ["artist", "Artist"], ["meta", "Meta"]]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    categorySelect.appendChild(option);
  }
  categorySelect.value = acAddDraft.category;
  categorySelect.disabled = acAddDraft.busy;
  categorySelect.addEventListener("change", () => { acAddDraft.category = categorySelect.value; });
  categorySelect.addEventListener("keydown", (e) => {
    if (isComfyQueueShortcut(e)) { closeAcMenu(); return; }
    e.stopPropagation();
    if (e.key === "Escape") { e.preventDefault(); cancelAcAdd(); }
  });
  const save = document.createElement("button");
  save.type = "button";
  save.className = "wg-ac-add-save";
  save.textContent = acAddDraft.busy ? "Saving…" : "Save";
  save.disabled = acAddDraft.busy;
  save.addEventListener("click", saveAcCustomWord);
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "wg-ac-add-cancel";
  cancel.title = "Cancel";
  cancel.setAttribute("aria-label", "Cancel");
  cancel.textContent = "\u00d7";
  cancel.addEventListener("click", cancelAcAdd);
  form.append(wordInput, triggerInput, categorySelect, save, cancel);
  footer.appendChild(form);

  const note = document.createElement("div");
  note.className = "wg-ac-add-note" + (acAddDraft.error ? " error" : "");
  note.textContent = acAddDraft.error || "Saved to your local custom words. Type a shortcut (or the word) to recall it. A type colors it like a booru tag.";
  footer.appendChild(note);
  return footer;
}

function appendAcFooter(menu, theme = loadTheme()) {
  const footer = buildAcFooter(theme);
  menu.appendChild(footer);
  return footer;
}

// Items grouped into the sections the menu draws, in display order. Each entry keeps its
// index into acState.items so keyboard order and rows stay in sync.
function buildAcGroups(search) {
  // Section order follows what was typed: "__" lists the library/wildcards first and tags after;
  // an ordinary word lists tags/custom words first and the relevant library entries after.
  const groupOrder = acState.kind === "wildcard"
    ? ["Favorites", "Recents", "Recipes", "Library Prompts", "Favorite Tags", "Exact Custom", "Booru Tags", "Custom Words", "Syntax"]
    : ["Anima Artists", "Favorite Styles", "Krea 2 & MOSS Styles", "Favorite Tags", "Exact Custom", "Booru Tags", "Custom Words", "Recents", "Favorites", "Recipes", "Library Prompts", "Syntax"];
  const grouped = new Map();
  acState.items.forEach((rawItem, index) => {
    const item = normalizeAcItem(rawItem);
    const isExactCustom = item.kind === "custom" && (item.exactCustomMatch === true || String(item.label || "").trim().toLocaleLowerCase() === String(search?.query ?? acState.query ?? "").trim().toLocaleLowerCase());
    if (isExactCustom) item.exactCustom = true;
    const section = item.section === "Favorite Tags" ? "Favorite Tags" : isExactCustom ? "Exact Custom" : (item.section || sectionForItem(item));
    if (!grouped.has(section)) grouped.set(section, []);
    grouped.get(section).push({ item, index });
  });
  const rank = (section) => {
    const base = groupOrder.indexOf(section);
    return base === -1 ? 100 : base;
  };
  return Array.from(grouped.entries()).sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b));
}

function renderAcMenu() {
  if (!acState) return;
  cleanupAcPreviews(); cleanupAcPreviews = () => {};
  const search = acState.kind === "booru" ? tagSearch(acState.query) : null;
  let groups = buildAcGroups(search);

  // Keyboard order must match what is drawn, so put the items in display order first. Doing this
  // before the menu is touched means it is built once, with focus and selection still intact.
  const displayOrder = groups.flatMap(([, entries]) => entries.map(({ index }) => index));
  if (displayOrder.some((value, position) => value !== position)) {
    const keepKey = acState.keepActiveKey;
    acState.items = displayOrder.map((index) => acState.items[index]);
    acState.activeIndex = 0; // a fresh list starts on its first visible row...
    if (keepKey) { // ...unless the caller (star/remove/clear) wants the same row kept active
      const kept = acState.items.findIndex((raw) => acItemKey(normalizeAcItem(raw)) === keepKey);
      if (kept >= 0) acState.activeIndex = kept;
    }
    acState.keepActiveKey = null;
    groups = buildAcGroups(search);
  }
  if (acState.keepActiveKey) {
    const kept = acState.items.findIndex((raw) => acItemKey(normalizeAcItem(raw)) === acState.keepActiveKey);
    if (kept >= 0) acState.activeIndex = kept;
    acState.keepActiveKey = null;
  }

  const previewRows = [];
  const caretCoords = getCaretCoords(acState.textarea, acState.anchor ?? acState.end);
  const menu = ensureAcMenu();
  const theme = loadTheme();
  const scope = acState?.textarea?.closest?.(".wg-root, .wg-node, .pp-node, .ppwc-surface");
  if (scope && (acThemeScopeCopied !== scope || acThemeScopeEpoch !== acAppearanceEpoch)) {
    copyPromptPaletteThemeScope(scope, menu);
    acThemeScopeCopied = scope;
    acThemeScopeEpoch = acAppearanceEpoch;
  } else if (!scope) {
    acThemeScopeCopied = null;
  }
  const highContrast = !!scope?.classList?.contains("wg-high-contrast");
  if (menu.classList.contains("wg-high-contrast") !== highContrast) menu.classList.toggle("wg-high-contrast", highContrast);
  const surface = currentUiSurface();
  const colorsChanged = !acMenuColorCache
    || acMenuColorCache.menu !== menu
    || acMenuColorCache.scope !== (scope || null)
    || acMenuColorCache.epoch !== acAppearanceEpoch
    || acMenuColorCache.highContrast !== highContrast
    || acMenuColorCache.booruColorsCustomized !== !!theme.booruColorsCustomized
    || acMenuColorCache.booruColorsRef !== theme.booruColors
    || acMenuColorCache.surface !== surface;
  if (colorsChanged) {
    const panelBg = typeof getComputedStyle === "function" ? (getComputedStyle(menu).backgroundColor || "") : "";
    const tone = panelToneFor(menu, panelBg);
    menu.dataset.acTone = tone;
    const panelHex = cssColorToHex(panelBg, surface);
    applyBooruMenuColors(menu, theme, panelHex);
    acMenuColorCache = {
      menu,
      scope: scope || null,
      epoch: acAppearanceEpoch,
      highContrast,
      booruColorsCustomized: !!theme.booruColorsCustomized,
      booruColorsRef: theme.booruColors,
      surface,
      panelHex,
    };
  }
  const panelHex = acMenuColorCache.panelHex;
  menu.dataset.acPromptHasSelection = String((acState?.textarea?.selectionEnd ?? 0) > (acState?.textarea?.selectionStart ?? 0));
  const activeField = document.activeElement instanceof HTMLElement && menu.contains(document.activeElement)
    ? document.activeElement.dataset?.acField : "";
  const fieldSelection = activeField
    ? { start: document.activeElement.selectionStart, end: document.activeElement.selectionEnd } : null;
  const list = document.createElement("div");
  list.className = "wg-ac-list";
  if (search?.category) {
    const heading = document.createElement("div"); heading.className = "wg-ac-head";
    heading.textContent = search.anima ? `Anima artists · ${search.query || "local snapshot"}` : `${BOORU_CATEGORY_TITLES[search.category]} tags · ${search.query}`;
    list.appendChild(heading);
  }
  const promptText = acState?.textarea?.value || "";
  const promptLower = promptText.toLowerCase();
  const promptPresence = createPromptPresence(promptText);
  const animaArtistFormatting = theme.animaArtistFormatting === true;

  // Collapsed sections hide their rows, so the keyboard only walks the rows that are showing.
  const canCollapse = acState.kind !== "syntax";
  const collapsedMap = collapsedSections();
  const isCollapsed = (section) => canCollapse && !!collapsedMap[section];
  const visible = [];
  for (const [section, entries] of groups) {
    if (!isCollapsed(section)) entries.forEach(({ index }) => visible.push(index));
  }
  acState.visible = visible;
  if (!visible.includes(acState.activeIndex)) acState.activeIndex = visible.length ? visible[0] : -1;

  if (!acState.items.length) {
    const empty = document.createElement("div");
    empty.className = "wg-ac-empty";
    empty.textContent = acState.kind === "syntax" ? "No syntax matches" : "No matches — keep typing or open Library";
    list.appendChild(empty);
  } else {
    // Every source gets an explicit section label, even when it is the only source.
    // This keeps Tags / Recent / Library / Syntax visually distinct instead of making
    // the menu's meaning depend on what happened to match the current query.
    const sectionLabels = {
      "Favorite Styles": "Favorite styles",
      "Krea 2 & MOSS Styles": "Styles · Krea 2 & MOSS",
      "Exact Custom": "Exact",
      "Favorite Tags": "Favorite tags",
      "Booru Tags": "Tags",
      "Custom Words": "Custom",
      "Favorites": "Favorites",
      "Recents": "Recent",
      "Recipes": "Recipes",
      "Library Prompts": "Library",
      "Syntax": "Syntax",
    };
    for (const [section, entries] of groups) {
      const collapsed = isCollapsed(section);
      const heading = document.createElement("div");
      heading.className = "wg-ac-group" + (canCollapse ? " collapsible" : "") + (collapsed ? " collapsed" : "");
      heading.dataset.acSection = section.toLowerCase().replace(/\s+/g, "-");
      const title = document.createElement("span");
      title.className = "wg-ac-group-title";
      if (canCollapse) {
        heading.dataset.acToggle = section;
        heading.setAttribute("role", "button");
        heading.setAttribute("aria-expanded", String(!collapsed));
        heading.title = collapsed ? "Expand section" : "Collapse section";
        const caret = document.createElement("span");
        caret.className = "wg-ac-caret";
        caret.setAttribute("aria-hidden", "true");
        caret.textContent = collapsed ? "\u25b8" : "\u25be";
        title.appendChild(caret);
      }
      const label = document.createElement("span");
      label.textContent = sectionLabels[section] || section;
      title.appendChild(label);
      // A collapsed section shows how much it is hiding; an open one stays free of counts.
      if (collapsed) {
        const hidden = document.createElement("span");
        hidden.className = "wg-ac-group-count";
        hidden.textContent = String(entries.length);
        title.appendChild(hidden);
      }
      heading.appendChild(title);
      if (section === "Recents") {
        const clear = document.createElement("button");
        clear.type = "button";
        clear.className = "wg-ac-clear";
        clear.dataset.acClearRecents = "true";
        clear.title = "Clear all recents (use \u00d7 on a row to remove just that one)";
        clear.textContent = "Clear";
        heading.appendChild(clear);
      }
      list.appendChild(heading);
      if (collapsed) continue;

      for (const { item, index } of entries) {
        const row = document.createElement("div");
        const styleSnippetLower = item.kind === "style" && item.insertText
          ? item.insertText.toLowerCase().slice(0, Math.min(48, item.insertText.length)).trim()
          : "";
        const inPrompt = item.kind === "syntax" || item.kind === "lora" ? false
          : item.kind === "style"
            ? (styleSnippetLower ? promptLower.includes(styleSnippetLower) : false)
            : (item.kind === "booru" || item.kind === "custom")
              ? (promptPresence.hasTag(item.insertText == null ? item.value : item.insertText)
                || promptPresence.hasTag(formatArtistInsertion(item, item.insertText == null ? item.value : item.insertText, animaArtistFormatting)))
              : promptPresence.hasLibraryEntry(item.value);
        row.className = "wg-ac-item" + (index === acState.activeIndex ? " active" : "") + (inPrompt ? " in-prompt" : "");
        row.dataset.acIndex = String(index);
        row.dataset.acKind = item.kind;
        row.dataset.acSection = section.toLowerCase().replace(/\s+/g, "-");
        if (inPrompt) row.dataset.acInPrompt = "true";
        if (item.exactCustom) row.dataset.acExactCustom = "true";

        if (item.kind === "booru") {
          const category = Object.hasOwn(BOORU_CATEGORY_TITLES, item.category) ? item.category : "general";
          row.dataset.acBooru = category;
          row.title = BOORU_CATEGORY_TITLES[category];
        } else if (item.kind === "custom") {
          if (item.hasCategory && Object.hasOwn(BOORU_CATEGORY_TITLES, item.category)) {
            row.dataset.acBooru = item.category;
            row.dataset.acCustom = "true";
            row.title = `${BOORU_CATEGORY_TITLES[item.category]} (custom word)`;
          } else {
            row.dataset.acBooru = "custom";
            row.title = "Custom word";
          }
        } else if (item.kind === "style") {
          const rawColor = sanitizeHexColor(item.swatch, "#d49a52");
          const styleColor = nudgeHexForContrast(rawColor, panelHex);
          row.style.setProperty("--pp-ac-bar", styleColor);
          row.style.setProperty("--pp-ac-tint", styleColor);
          row.style.color = styleColor;
          if (item.facet) row.dataset.acFacet = item.facet;
          if (item.conflict) row.dataset.acConflict = "true";
          row.title = item.conflict
            ? `${item.conflictReason || "Conflicting style attribute already in prompt"} · ${item.label}`
            : `${item.label} (${item.facetLabel || "Style"} · ${item.modelBadge || "KREA2/MOSS"})`;
        } else if (item.kind === "lora") {
          row.title = `${item.value} · local LoRA`;
          const color = textColorForLora(item.value, theme);
          row.style.setProperty("--pp-ac-bar", color);
          row.style.color = color;
        } else if (item.kind === "syntax") {
          row.title = item.meta || "Inline syntax";
          row.dataset.syntaxTone = item.syntaxTone || "choice";
        } else {
          // Library card: prompt, wildcard list, recipe, favorite or recent. These are all
          // library-backed rows, so their source color must remain attached to the item even
          // when it is surfaced through Recents or Favorites.
          if (item.favorite) row.dataset.acFavorite = "true";
          if (item.recent) row.dataset.acRecent = "true";
          if (item.recipe) row.dataset.acRecipe = "true";
          row.dataset.acLibrary = "true";
          const libraryCategory = categoryOf(item.value);
          const automaticLibraryColor = theme?.categoryPins?.[libraryCategory]
            || categoryColorFromHue(((hashStr(libraryCategory) % 360) + (Number(theme?.hueRotate) || 0)) % 360, Number(theme?.saturation) || 58, currentUiSurface());
          const sourceColor = sanitizeHexColor(item.swatch, automaticLibraryColor);
          const libraryColor = nudgeHexForContrast(sourceColor, panelHex);
          row.style.setProperty("--pp-ac-lib", libraryColor);
          row.style.setProperty("--pp-ac-source", sourceColor);
          row.style.setProperty("--pp-ac-bar", libraryColor);
          // Explicit color binding prevents a theme accent or section-specific rule from
          // turning a Recent row into a generic red item. The prompt itself keeps sourceColor.
          row.style.color = libraryColor;
          row.title = (item.recipe ? "Palette Recipe" : item.favorite ? "Favorite" : item.recent ? "Recently used" : "Library") + " · Right-click for thumbnail actions";
        }

        const textWrap = document.createElement("span");
        textWrap.className = "wg-ac-copy";
        const strong = document.createElement("strong");
        const styleHighlightQuery = item.kind === "style"
          ? parseStyleAutocompleteQuery(search?.query ?? acState.query ?? "").query
          : (search?.query ?? acState.query ?? "");
        appendHighlightedText(strong, item.label, styleHighlightQuery);
        textWrap.appendChild(strong);
        if (item.meta) {
          const small = document.createElement("small");
          small.textContent = item.meta;
          textWrap.appendChild(small);
        }

        const metrics = document.createElement("span");
        metrics.className = "wg-ac-metrics";
        if (item.kind === "syntax" && item.code) appendPill(metrics, item.code, "wg-ac-code").innerHTML = syntaxCodeHtml(item.code);
        if (item.kind === "style") {
          if (item.facetLabel) appendPill(metrics, item.facetLabel, "wg-ac-source");
          if (item.modelBadge) appendPill(metrics, item.modelBadge, "wg-ac-alias");
          if (item.conflict) appendPill(metrics, "\u26a0 Conflict", "wg-ac-conflict");
        }
        if (item.recipe) appendPill(metrics, "recipe", "wg-ac-source wg-ac-recipe");
        else if (item.favorite && item.kind !== "booru" && item.kind !== "custom" && item.kind !== "style") appendPill(metrics, "\u2605", "wg-ac-source wg-ac-fav");
        else if (item.recent) appendPill(metrics, "recent", "wg-ac-source");
        if (item.count) appendPill(metrics, compactCount(item.count), "wg-ac-count");
        if (item.alias && item.alias !== item.label && item.kind !== "style") appendPill(metrics, item.alias, "wg-ac-alias");
        if (item.exactCustom) appendPill(metrics, "exact", "wg-ac-source");
        else if (inPrompt) appendPill(metrics, "✓", "wg-ac-present");
        if (!item.count && !item.alias && item.kind === "custom" && !item.exactCustom) appendPill(metrics, "custom", "wg-ac-source");

        if (item.kind === "booru" || item.kind === "custom" || item.kind === "style") {
          const star = document.createElement("button");
          star.type = "button";
          star.className = "wg-ac-star" + (item.favorite ? " on" : "");
          star.dataset.acStar = "true";
          star.setAttribute("aria-pressed", String(!!item.favorite));
          star.title = item.favorite ? "Remove from favorites" : "Add to favorites";
          star.textContent = item.favorite ? "\u2605" : "\u2606";
          metrics.appendChild(star);
        }
        if (item.recent && item.kind !== "style") {
          const remove = document.createElement("button");
          remove.type = "button";
          remove.className = "wg-ac-remove";
          remove.dataset.acRemove = "true";
          remove.title = "Remove from recents";
          remove.setAttribute("aria-label", "Remove from recents");
          remove.textContent = "\u00d7";
          metrics.appendChild(remove);
        }

        row.append(textWrap, metrics);
        previewRows.push({ row, item, index });
        list.appendChild(row);
        if (index === acState.activeIndex && index > 0) {
          requestAnimationFrame(() => row.scrollIntoView({ block: "nearest" }));
        }
      }
    }
  }

  const footer = buildAcFooter(theme);
  if (typeof menu.replaceChildren === "function") {
    menu.replaceChildren(list, footer);
  } else {
    menu.innerHTML = "";
    menu.append(list, footer);
  }
  if (acAddDraft) menu.dataset.acAdding = "true"; else delete menu.dataset.acAdding;

  positionAcMenu(menu, caretCoords);
  if (theme.autocompletePreviews !== false) {
    const state = acState, request = acRequestVersion, revision = API.previewRevision();
    cleanupAcPreviews = hydrateAcThumbnails(menu, previewRows, state.activeIndex,
      () => acState === state && acRequestVersion === request && API.previewRevision() === revision && menu.style.display !== "none" && loadTheme().autocompletePreviews !== false,
      () => positionAcMenu(menu));
  }

  if (acAddDraft?.focus) {
    focusAcField(acAddDraft.focus);
    acAddDraft.focus = "";
  } else if (activeField) {
    const input = menu.querySelector(`[data-ac-field="${activeField}"]`);
    if (input && !input.disabled) {
      input.focus({ preventScroll: true });
      if (fieldSelection) { try { input.setSelectionRange(fieldSelection.start, fieldSelection.end); } catch { /* not selectable */ } }
    }
  }
}

function positionAcMenu(menu, precomputedCoords = null) {
  if (!acState) return;
  // Size and place the menu: as wide as its longest row (CSS max-width applies) and as
  // tall as the results need, using whichever side of the caret has more room.
  const coords = precomputedCoords || getCaretCoords(acState.textarea, acState.anchor ?? acState.end);
  const margin = 8;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const belowTop = coords.top + coords.lineHeight + 4;
  const roomBelow = vh - belowTop - margin;
  const roomAbove = coords.top - 4 - margin;
  if (menu.style.display !== "flex") menu.style.display = "flex";
  const listEl = menu.querySelector(".wg-ac-list");
  const footEl = menu.querySelector(".wg-ac-footer");
  if (!listEl && menu.style.maxHeight) menu.style.maxHeight = "";
  const naturalHeight = listEl
    ? listEl.scrollHeight + (footEl ? footEl.offsetHeight : 0) + 4
    : menu.scrollHeight;
  const wanted = Math.min(naturalHeight, AC_MAX_HEIGHT);
  const placeBelow = roomBelow >= Math.min(wanted, 280) || roomBelow >= roomAbove;
  const room = Math.max(48, placeBelow ? roomBelow : roomAbove);
  const maxAllowedHeight = Math.max(1, Math.min(AC_MAX_HEIGHT, room, vh - 2 * margin));
  const maxHeightPx = maxAllowedHeight + "px";
  if (menu.style.maxHeight !== maxHeightPx) menu.style.maxHeight = maxHeightPx;
  const height = menu.offsetHeight;
  const width = menu.offsetWidth;
  menu.style.left = Math.max(margin, Math.min(coords.left, vw - width - margin)) + "px";
  menu.style.top = Math.max(margin, Math.min(placeBelow ? belowTop : coords.top - 4 - height, vh - height - margin)) + "px";
}

function moveAcSelection(nextIndex) {
  if (!acState || !acMenu || nextIndex < 0) return false;
  const prevIndex = acState.activeIndex;
  acState.activeIndex = nextIndex;
  if (prevIndex === nextIndex) return true;
  const nextRow = acMenu.querySelector(`.wg-ac-item[data-ac-index="${nextIndex}"]`);
  if (!nextRow) return false;
  const prevRow = acMenu.querySelector(`.wg-ac-item[data-ac-index="${prevIndex}"]`);
  if (prevRow && prevRow !== nextRow) prevRow.classList.remove("active");
  nextRow.classList.add("active");
  nextRow.scrollIntoView?.({ block: "nearest" });
  return true;
}

const AC_LOOKUP_TIMEOUT_MS = 4000;
function withLookupTimeout(promise) {
  let timer = 0;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("autocomplete lookup timed out")), AC_LOOKUP_TIMEOUT_MS); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function syntaxMenuEnabled() {
  return loadTheme().syntaxInjectorEnabled !== false;
}

async function openOrUpdateAcMenu(textarea, fragment, getMatches, onCommit, { force = false, onDemand = false } = {}) {
  const requestVersion = ++acRequestVersion;
  acOwner = textarea;
  const query = fragment.query;
  let items;
  acInFlightRequests += 1;
  try {
    items = await resolveAcItems(getMatches, query, fragment.kind, { textarea, onDemand: onDemand || force });
  } catch (error) {
    console.warn("Prompt Palette: autocomplete lookup failed", error);
    if (requestVersion === acRequestVersion && acOwner === textarea) closeAcMenu();
    return;
  } finally {
    acInFlightRequests = Math.max(0, acInFlightRequests - 1);
  }
  if (requestVersion !== acRequestVersion || acOwner !== textarea || !textarea.isConnected) return;
  // `force` is for menus opened on demand at a bare caret, where no typed fragment exists to re-derive.
  const stillValid = force
    ? (textarea.selectionStart === fragment.end && textarea.selectionEnd === fragment.end ? fragment : null)
    : findWildcardFragment(textarea.value, textarea.selectionStart);
  if (!stillValid || stillValid.start !== fragment.start || stillValid.end !== textarea.selectionStart || stillValid.query !== query) return;
  const replacementFragment = expandAutocompleteReplacementRange(textarea.value, stillValid, textarea.selectionStart);
  acState = {
    textarea, items, activeIndex: 0, start: replacementFragment.start, end: replacementFragment.end, anchor: textarea.selectionStart,
    source: textarea.value,
    kind: stillValid.kind || "wildcard", modifier: stillValid.modifier || "", query, onCommit, getMatches,
  };
  renderAcMenu();
}

function openOrUpdateAcMenuAt(textarea, caret, getMatches, onCommit) {
  return openOrUpdateAcMenu(textarea, { kind: "syntax", query: "", modifier: "", start: caret, end: caret }, getMatches, onCommit, { force: true });
}

function commitAcSelection(index, state = acState) {
  if (!state) return;
  const { textarea, start, end, items, onCommit } = state;
  if (textarea.readOnly || textarea.disabled || textarea.getAttribute("aria-readonly") === "true") {
    closeAcMenu(); return;
  }
  if (state.source != null && (textarea.value !== state.source
      || textarea.selectionStart !== state.anchor || textarea.selectionEnd !== state.anchor)) {
    closeAcMenu(); return;
  }
  const rawItem = items[index];
  if (rawItem == null) return closeAcMenu();
  const item = normalizeAcItem(rawItem);
  // The row's explicit insertion mode is the source of truth. Plain tags/custom words are
  // inserted as literal tags (escaping parentheses and applying existing user toggles);
  // only a verified library row may become __name__. Apply explicitly enabled
  // insertion options to canonical booru/custom values even when a row supplies
  // insertText (aliases do); other plain syntax snippets remain verbatim.
  const isStyleRow = item.kind === "style";
  const isPlainTag = !isStyleRow && (item.insertMode === "plain" || item.kind === "booru" || item.kind === "custom");
  const isTagRow = item.kind === "booru" || item.kind === "custom";
  let replacement = isStyleRow
    ? (item.insertText == null ? item.value : item.insertText)
    : isPlainTag
      ? (isTagRow ? insertBooruValue(item.insertText == null ? item.value : item.insertText, item) : formatArtistInsertion(item, item.insertText == null ? item.value : item.insertText, loadTheme().animaArtistFormatting === true))
      : (item.insertText == null
        ? `__${state.kind === "wildcard" ? (state.modifier || "") : ""}${item.value}__`
        : item.insertText);
  if (item.kind === "lora") {
    const existing = loraAt(textarea.value, start);
    if (existing) replacement = buildLoraExpression({ names: [item.value], model: existing.model, clip: existing.clip, linked: false });
  }
  if (!isPlainTag && item.insertText == null && textarea.__ppRecipeInsert) {
    const source = textarea.value;
    if (textarea.__ppRecipeInsert(item.value, { source, start, end, fallback: replacement, committed: () => onCommit?.(item) })) {
      closeAcMenu(); return;
    }
  }
  textarea.value = textarea.value.slice(0, start) + replacement + textarea.value.slice(end);
  // A picked tag keeps its category color in the prompt. Register it before the input event
  // below triggers the repaint, so it never flashes uncolored while the lookup catches up.
  if (item.kind === "booru") recordInsertedTags(replacement, item.category);
  else if (item.kind === "custom") recordInsertedTags(replacement, item.hasCategory ? item.category : "custom");
  suppressAutocompleteInputFor = textarea;
  if (item.selectRange) {
    const [from, to] = item.selectRange;
    textarea.selectionStart = start + Math.max(0, Math.min(replacement.length, from));
    textarea.selectionEnd = start + Math.max(0, Math.min(replacement.length, to));
  } else if (item.selectInserted) {
    textarea.selectionStart = start;
    textarea.selectionEnd = start + replacement.length;
  } else {
    const caret = start + replacement.length;
    textarea.selectionStart = textarea.selectionEnd = caret;
  }
  closeAcMenu();
  textarea.focus();
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  // The event above is synchronous, so any listener that was going to consume the flag already
  // has. Never leave it armed: a stale flag would swallow the user's next real keystroke.
  suppressAutocompleteInputFor = null;
  if (isStyleRow) {
    try { acStore().recordStyleUsage?.(item.styleId || item.value); } catch { /* usage stats are optional */ }
  }
  if (onCommit) onCommit(item);
}

function attachAutocomplete(textarea, { getMatches, onCommit, onInput, onRecentsChanged, syntax = false, node = null } = {}) {
  if (!textarea || typeof getMatches !== "function") return () => {};
  const previousCleanup = textarea.__ppAutocompleteCleanup;
  if (typeof previousCleanup === "function") previousCleanup();
  if (node && !textarea.__ppNode) textarea.__ppNode = node;
  preloadStyleAutocompleteCatalog();
  let disposed = false;
  // Lets the menu tell the owning editor that Recents were cleared/removed (its library list may mirror them).
  textarea.__ppAcRecentsChanged = typeof onRecentsChanged === "function" ? onRecentsChanged : null;

  const syntaxMatches = async (query) => syntaxSnippetRows(query);
  // Only editors whose text is resolved as inline syntax opt in (Prompt Palette, Combinatorial).
  const syntaxAllowed = () => syntax && syntaxMenuEnabled();
  let booruInputTimer = 0;
  const cancelBooruInputTimer = () => {
    if (booruInputTimer) { clearTimeout(booruInputTimer); booruInputTimer = 0; }
  };
  const openForCurrentCaret = ({ onDemand = false, typed = false } = {}) => {
    if (disposed) return;
    if (textarea.selectionEnd > textarea.selectionStart) { cancelBooruInputTimer(); closeAcMenu(); return; }
    const fragment = findWildcardFragment(textarea.value, textarea.selectionStart);
    if (!fragment) { cancelBooruInputTimer(); closeAcMenu(); return; }
    if (fragment.kind === "lora") { cancelBooruInputTimer(); openOrUpdateAcMenu(textarea, fragment, loraMatches, onCommit, { onDemand }); return; }
    if (fragment.kind === "syntax") {
      // The syntax menu is opt-in by action: it appears when "{" is typed or on demand (Ctrl+Space),
      // never because the caret merely landed next to an existing brace.
      cancelBooruInputTimer();
      if (!syntaxAllowed() || !(typed || onDemand)) { closeAcMenu(); return; }
      openOrUpdateAcMenu(textarea, fragment, syntaxMatches, onCommit, { onDemand });
      return;
    }
    if (!shouldOpenTextAutocomplete(fragment, { onDemand })) {
      cancelBooruInputTimer();
      if (fragment.kind === "booru") closeAcMenu();
      return;
    }
    if (typed && !onDemand && fragment.kind === "booru" && (acInFlightRequests > 0 || booruInputTimer)) {
      cancelBooruInputTimer();
      booruInputTimer = setTimeout(() => {
        booruInputTimer = 0;
        if (disposed || !textarea.isConnected || document.activeElement !== textarea) return;
        openForCurrentCaret({ onDemand: false, typed: false });
      }, 45);
      return;
    }
    cancelBooruInputTimer();
    openOrUpdateAcMenu(textarea, fragment, getMatches, onCommit, { onDemand });
  };

  const onCompositionStart = () => {
    if (acOwner === textarea || acState?.textarea === textarea) closeAcMenu();
  };
  const onFocus = () => {
    if (acOwner && acOwner !== textarea) closeAcMenu();
    else if (!acOwner && acState && acState.textarea !== textarea) closeAcMenu();
  };
  const handleInput = (event) => {
    if (event?.isComposing) { onCompositionStart(); return; }
    if (suppressAutocompleteInputFor === textarea) {
      suppressAutocompleteInputFor = null;
      closeAcMenu();
      return;
    }
    // Some editor surfaces (notably the single-surface contenteditable used by
    // current ComfyUI frontends) normalize the DOM during the same input event.
    // Let the owning editor sync its state first, then derive the autocomplete
    // fragment from the final value/selection.
    try { onInput?.(); } catch (error) { console.warn("Prompt Palette: autocomplete input sync failed", error); }
    const typed = !event?.inputType || event.inputType === "insertText";
    queueMicrotask(() => {
      if (disposed || !textarea.isConnected || document.activeElement !== textarea) return;
      openForCurrentCaret({ typed });
    });
  };
  const onClick = () => {
    if (textarea.selectionEnd > textarea.selectionStart) return closeAcMenu();
    const fragment = findWildcardFragment(textarea.value, textarea.selectionStart);
    if (!fragment) return closeAcMenu();
    if (fragment.kind === "booru") {
      openForCurrentCaret();
      return;
    }
    openForCurrentCaret();
  };
  const onKeyup = (event) => {
    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) openForCurrentCaret();
  };
  const onKeydown = (event) => {
    if (isComfyQueueShortcut(event)) { closeAcMenu(); return; }
    if (event.isComposing || event.keyCode === 229) return;
    // Selection shortcuts belong to the editor even when an old completion
    // request/menu is still pending. Shift+arrows must extend the native range.
    if (event.shiftKey || textarea.selectionEnd > textarea.selectionStart) closeAcMenu();
    if (event.ctrlKey && !event.altKey && !event.metaKey && event.code === "Space") {
      const fragment = findWildcardFragment(textarea.value, textarea.selectionStart);
      if (fragment?.kind === "wildcard" || fragment?.kind === "lora") {
        event.preventDefault();
        event.stopPropagation();
        openForCurrentCaret({ onDemand: true });
        return;
      }
      if (fragment?.kind === "booru" && shouldOpenTextAutocomplete(fragment, { onDemand: true })) {
        event.preventDefault();
        event.stopPropagation();
        openForCurrentCaret({ onDemand: true });
        return;
      }
      // Nothing to complete at the caret: Ctrl+Space offers the inline syntax instead, so the
      // options are one shortcut away without typing a preset word first.
      if (!fragment && syntaxAllowed() && !(acState && acState.textarea === textarea)) {
        const caret = textarea.selectionStart;
        event.preventDefault();
        event.stopPropagation();
        openOrUpdateAcMenuAt(textarea, caret, syntaxMatches, onCommit);
        return;
      }
      if (fragment?.kind === "syntax" && syntaxAllowed()) {
        event.preventDefault();
        event.stopPropagation();
        openForCurrentCaret({ onDemand: true });
        return;
      }
    }
    if (!acState || acState.textarea !== textarea) return;
    const visibleRows = acState.visible || acState.items.map((_, index) => index);
    const count = visibleRows.length;
    const position = visibleRows.indexOf(acState.activeIndex);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (count) {
        const nextIndex = visibleRows[(position + 1) % count];
        if (!moveAcSelection(nextIndex)) renderAcMenu();
      }
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (count) {
        const nextIndex = visibleRows[position < 0 ? count - 1 : (position - 1 + count) % count];
        if (!moveAcSelection(nextIndex)) renderAcMenu();
      }
    } else if (event.key === "Enter" || event.key === "Tab") {
      if (!count) return;
      event.preventDefault();
      event.stopPropagation();
      commitAcSelection(acState.activeIndex);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeAcMenu();
    }
  };
  const onBlur = (event) => {
    const next = event.relatedTarget;
    if (next && acMenu?.contains(next)) return;
    if ((acOwner === textarea || acState?.textarea === textarea) && !acMenu?.contains(next)) closeAcMenu();
  };

  textarea.addEventListener("compositionstart", onCompositionStart);
  textarea.addEventListener("focus", onFocus);
  textarea.addEventListener("input", handleInput);
  textarea.addEventListener("click", onClick);
  textarea.addEventListener("keyup", onKeyup);
  textarea.addEventListener("keydown", onKeydown);
  textarea.addEventListener("blur", onBlur);

  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    cancelBooruInputTimer();
    textarea.removeEventListener("compositionstart", onCompositionStart);
    textarea.removeEventListener("focus", onFocus);
    textarea.removeEventListener("input", handleInput);
    textarea.removeEventListener("click", onClick);
    textarea.removeEventListener("keyup", onKeyup);
    textarea.removeEventListener("keydown", onKeydown);
    textarea.removeEventListener("blur", onBlur);
    if (acOwner === textarea || acState?.textarea === textarea) closeAcMenu();
    if (textarea.__ppAutocompleteCleanup === cleanup) {
      delete textarea.__ppAutocompleteCleanup;
      textarea.__ppAcRecentsChanged = null;
    }
  };
  Object.defineProperty(textarea, "__ppAutocompleteCleanup", { value: cleanup, configurable: true });
  return cleanup;
}

export function cleanupAutocomplete() {
  suppressAutocompleteInputFor = null;
  closeAcMenu();
  unsubscribeAcLibrary?.(); unsubscribeAcLibrary = null;
  unsubscribeAcAppearance?.(); unsubscribeAcAppearance = null;
  acThemeScopeCopied = null;
  acMenuColorCache = null;
  acFavoritesSnapshotRef = undefined;
  document.removeEventListener("mousedown", handleAcDocumentMouseDown);
  document.removeEventListener("contextmenu", handleAcDocumentMouseDown);
  document.removeEventListener("scroll", handleAcViewportChange, true);
  window.removeEventListener("resize", handleAcViewportChange);
  acMenu?.remove();
  acMenu = null;
  acMirrorDiv?.remove();
  acMirrorDiv = null;
}

export {
  findWildcardFragment, getCaretCoords, openOrUpdateAcMenu, closeAcMenu, renderAcMenu, commitAcSelection, acState,
  shouldOpenBooruAutocomplete, shouldOpenTextAutocomplete, getBooruAutocompleteMatches, attachAutocomplete,
};
