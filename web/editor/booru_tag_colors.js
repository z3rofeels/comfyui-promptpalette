import { API } from "../prompt_palette_api.js";
import { loadCustomWords, getCustomWordsGeneration } from "./custom_words.js";
import { DEFAULT_BOORU_COLORS_DARK, DEFAULT_BOORU_COLORS_LIGHT } from "./preferences.js";
import { sanitizeHexColor, nudgeHexForContrast, relativeLuminance, currentUiSurface } from "./text_utils.js";

/**
 * Keeps booru / custom-word tags colored after they are inserted into the prompt, the same way
 * wildcards and library recipes keep their colors, so a whole prompt can be read at a glance.
 *
 * Where a tag's category comes from, in priority order:
 *   1. The user's own custom words (their category, or "custom" when they have none).
 *   2. Tags inserted from the autocomplete menu in this browser (instant, no round trip).
 *   3. The bundled offline database, looked up in small batches through the local server.
 * Nothing here ever leaves the machine.
 */

export const TAG_CATEGORY_KEYS = ["general", "artist", "copyright", "character", "meta", "custom"];
export const TAG_CATEGORY_LABELS = {
  general: "General tag", artist: "Artist tag", copyright: "Copyright / series tag",
  character: "Character tag", meta: "Meta tag", custom: "Custom word",
};

const CACHE_LIMIT = 8000;
const BATCH_LIMIT = 200;
const FLUSH_DELAY_MS = 180;
const RETRY_AFTER_MS = 20_000;
const MAX_KEY_CHARS = 100;
const MAX_KEY_WORDS = 9;

// key -> category name, or "" when the database is known not to contain the tag.
const cache = new Map();
const pending = new Set();
const inflight = new Set();
const failedAt = new Map();
const listeners = new Set();
let flushTimer = null;

// Custom words: key -> category ("custom" when the row has none).
let customIndex = new Map();
let customGenerationSeen = -1;
let customRefreshVersion = 0;

export function normalizeTagKey(text) {
  return String(text ?? "")
    .trim()
    .replace(/\\([()])/g, "$1")
    .replace(/\s+/g, "_")
    .toLowerCase();
}

function lookupable(key) {
  if (!key || key.length > MAX_KEY_CHARS) return false;
  if (/[<>{}|$]/.test(key)) return false;
  if (/^[\d._+-]+$/.test(key)) return false;
  return key.split("_").length <= MAX_KEY_WORDS;
}

function remember(key, category) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, category);
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
}

function notify() {
  for (const listener of Array.from(listeners)) {
    try { listener(); } catch (error) { console.warn("Prompt Palette: tag color listener failed", error); }
  }
}

/** Subscribe to "a lookup finished, repaint" events. Returns the unsubscribe function. */
export function onTagColorsChanged(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Text that was just inserted from the menu: its category is already known, so color it right away. */
export function recordInsertedTags(text, category) {
  const name = TAG_CATEGORY_KEYS.includes(category) ? category : "general";
  for (const part of String(text ?? "").split(/[,\n]/)) {
    const key = normalizeTagKey(part);
    if (lookupable(key)) remember(key, name);
  }
}

function rebuildCustomIndex(words) {
  const next = new Map();
  for (const word of Array.isArray(words) ? words : []) {
    const category = TAG_CATEGORY_KEYS.includes(word?.category) && word.category !== "custom" ? word.category : "custom";
    // A row inserts its value (never the shortcut it was found by). Values can be whole
    // "masterpiece, best quality" phrases, so index each comma-separated part too.
    for (const part of [String(word?.value ?? ""), ...String(word?.value ?? "").split(",")]) {
      const key = normalizeTagKey(part);
      if (key && !next.has(key)) next.set(key, category);
    }
  }
  customIndex = next;
}

function syncCustomIndex() {
  const generation = getCustomWordsGeneration();
  if (generation === customGenerationSeen) return;
  customGenerationSeen = generation;
  const version = ++customRefreshVersion;
  loadCustomWords().then((words) => {
    if (version !== customRefreshVersion) return;
    rebuildCustomIndex(words);
    notify();
  }).catch(() => { /* custom words are optional */ });
}

async function flush() {
  flushTimer = null;
  if (!pending.size) return;
  const batch = Array.from(pending).slice(0, BATCH_LIMIT);
  batch.forEach((key) => { pending.delete(key); inflight.add(key); });
  try {
    const categories = await API.booruLookup(batch);
    for (const key of batch) {
      const category = categories?.[key];
      remember(key, TAG_CATEGORY_KEYS.includes(category) ? category : "");
    }
    notify();
  } catch {
    // Server unavailable or busy: leave the words uncolored and try again later.
    const now = Date.now();
    batch.forEach((key) => failedAt.set(key, now));
  } finally {
    batch.forEach((key) => inflight.delete(key));
    if (pending.size) schedule();
  }
}

function schedule() {
  if (flushTimer != null) return;
  flushTimer = setTimeout(flush, FLUSH_DELAY_MS);
}

function queue(key) {
  if (pending.has(key) || inflight.has(key)) return;
  const failed = failedAt.get(key);
  if (failed && Date.now() - failed < RETRY_AFTER_MS) return;
  if (failed) failedAt.delete(key);
  pending.add(key);
  schedule();
}

/** Category for one normalized tag key, or "" when it is not (yet) a known tag. */
export function categoryForTagKey(key) {
  const custom = customIndex.get(key);
  if (custom) return custom;
  if (!lookupable(key)) return "";
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  queue(key);
  return "";
}

const isEscaped = (text, index) => index > 0 && text[index - 1] === "\\";

function unescapedCount(text, start, end, char) {
  let count = 0;
  for (let i = start; i < end; i++) if (text[i] === char && !isEscaped(text, i)) count++;
  return count;
}

/**
 * Comma-separated pieces of a plain-text run, with prompt-weight decoration peeled off:
 * "(blue hair:1.2)" -> "blue hair", while "kaga_\(kancolle\)" and "kaga_(kancolle)" stay whole.
 * Returns [{ start, end, key }] with offsets relative to `text`.
 */
export function scanTagPieces(text) {
  const source = String(text ?? "");
  const pieces = [];
  let from = 0;
  while (from <= source.length) {
    let stop = from;
    while (stop < source.length && source[stop] !== "," && source[stop] !== "\n") stop++;
    let start = from;
    let end = stop;
    while (start < end && /\s/.test(source[start])) start++;
    while (end > start && /\s/.test(source[end - 1])) end--;
    let opened = 0;
    while (start < end && (source[start] === "(" || source[start] === "[")) { start++; opened++; }
    for (let guard = 0; guard < 8 && end > start; guard++) {
      const last = source[end - 1];
      if ((last === ")" && !isEscaped(source, end - 1) && unescapedCount(source, start, end, ")") > unescapedCount(source, start, end, "("))
        || (last === "]" && !isEscaped(source, end - 1) && unescapedCount(source, start, end, "]") > unescapedCount(source, start, end, "["))) {
        end--;
        continue;
      }
      if (opened) {
        const weight = source.slice(start, end).match(/:\s*[+-]?(?:\d+\.?\d*|\.\d+)\s*$/);
        if (weight) { end -= weight[0].length; opened = 0; continue; }
      }
      break;
    }
    while (end > start && /\s/.test(source[end - 1])) end--;
    if (end > start) {
      const key = normalizeTagKey(source.slice(start, end));
      if (key) pieces.push({ start, end, key });
    }
    if (stop >= source.length) break;
    from = stop + 1;
  }
  return pieces;
}

let paletteSignature = "";
let paletteValue = null;

/** Booru colors as they appear in the menu: theme overrides, nudged to stay readable on the editor. */
export function resolveTagPalette(theme) {
  const surface = currentUiSurface();
  const light = relativeLuminance(surface) > 0.45;
  const defaults = light ? DEFAULT_BOORU_COLORS_LIGHT : DEFAULT_BOORU_COLORS_DARK;
  const saved = theme?.booruColors && typeof theme.booruColors === "object" ? theme.booruColors : {};
  const customized = !!theme?.booruColorsCustomized;
  const signature = `${surface}|${light}|${customized}|${customized ? JSON.stringify(saved) : ""}`;
  if (signature === paletteSignature && paletteValue) return paletteValue;
  const base = customized ? { ...defaults, ...saved } : { ...defaults };
  paletteValue = Object.fromEntries(TAG_CATEGORY_KEYS.map((key) => [
    key, nudgeHexForContrast(sanitizeHexColor(base[key], defaults[key]), surface),
  ]));
  paletteSignature = signature;
  return paletteValue;
}

/**
 * A painter for one render pass, or null when the user turned tag coloring off.
 * paint(text, offset) returns the colored ranges of a plain-text run: [{ start, end, category, color }],
 * with `offset` added so the ranges are absolute positions in the prompt.
 */
export function createTagPainter(theme) {
  if (theme?.booruPromptColors === false) return null;
  syncCustomIndex();
  const palette = resolveTagPalette(theme);
  const used = new Set();
  return {
    palette,
    used,
    paint(text, offset = 0) {
      const ranges = [];
      if (!text || !/[A-Za-z0-9\u0080-\uffff]/.test(text)) return ranges;
      for (const piece of scanTagPieces(text)) {
        const category = categoryForTagKey(piece.key);
        if (!category) continue;
        used.add(category);
        ranges.push({ start: offset + piece.start, end: offset + piece.end, category, color: palette[category] });
      }
      return ranges;
    },
  };
}
