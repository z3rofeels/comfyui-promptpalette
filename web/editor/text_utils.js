import { escapeHtml } from "../prompt_palette_shared.js";
import { getPromptPaletteSectionSnapshot } from "../prompt_palette_state.js";
import { BUILTIN_UI_THEMES, loadUiThemes, loadActiveUiThemeName } from "./preferences.js";

// Keep invalid intermediate typing out of the serialized seed and resolver.
// Number-based ComfyUI widgets cannot represent uint64's upper endpoint exactly.
export function bindPromptSeedInput(input, widget, commit) {
  if (!input || !widget) return () => {};
  function edit() {
    if (input.value === "") { input.removeAttribute("aria-invalid"); return; }
    const value = Number(input.value);
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0 || value >= 2 ** 64) {
      input.setAttribute("aria-invalid", "true");
      return;
    }
    input.removeAttribute("aria-invalid");
    commit(value);
  }
  function finish() {
    if (input.value === "" || input.getAttribute("aria-invalid") === "true") {
      input.value = widget.value;
      input.removeAttribute("aria-invalid");
    }
  }
  input.addEventListener("input", edit);
  input.addEventListener("blur", finish);
  return () => { input.removeEventListener("input", edit); input.removeEventListener("blur", finish); };
}

function hashStr(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h;
}
function canonicalRecipeCategory(cat) {
  const raw = String(cat || "");
  const parts = raw.split("/");
  const first = (parts[0] || "").toLowerCase();
  if (first !== "recipe" && first !== "recipes") return raw;
  return ["RECIPES", ...parts.slice(1)].join("/");
}

function categoryOf(p) {
  const parts = String(p || "").split("/");
  const category = parts.length > 1 ? parts.slice(0, -1).join("/") : "misc";
  return canonicalRecipeCategory(category);
}

function slugifyRecipeName(raw) {
  return (raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}
function normalizeLibraryEntryPath(raw, { preserveName = false } = {}) {
  // Disk entry identities are case-sensitive and may contain spaces or Unicode.
  // Slug generation remains the default for suggestions and selection exports.
  if (preserveName) return String(raw || "").trim().replace(/\\/g, "/").split("/").map(part => part.trim()).join("/");
  return String(raw || "")
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => segment
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, ""))
    .filter(Boolean)
    .join("/");
}

function isRecipeCategory(cat) {
  return canonicalRecipeCategory(cat).split("/")[0] === "RECIPES";
}

function highlightMatch(text, filter) {
  if (!filter) return escapeHtml(text);
  const idx = text.toLowerCase().indexOf(filter.toLowerCase());
  if (idx === -1) return escapeHtml(text);
  return escapeHtml(text.slice(0, idx)) +
    `<mark class="wg-match">${escapeHtml(text.slice(idx, idx + filter.length))}</mark>` +
    escapeHtml(text.slice(idx + filter.length));
}

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
// Pure color math is memoized: the autocomplete menu and prompt painter ask about the same
// handful of colors on every keystroke. Bounded so odd custom palettes cannot grow it forever.
const PURE_COLOR_CACHE_LIMIT = 2048;
const luminanceCache = new Map();
const contrastNudgeCache = new Map();
function relativeLuminance(hex) {
  const value = sanitizeHexColor(hex, "#121417").slice(1);
  const cached = luminanceCache.get(value);
  if (cached !== undefined) return cached;
  const channels = [0, 2, 4].map(index => parseInt(value.slice(index, index + 2), 16) / 255)
    .map(channel => channel <= .04045 ? channel / 12.92 : Math.pow((channel + .055) / 1.055, 2.4));
  const result = channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
  if (luminanceCache.size >= PURE_COLOR_CACHE_LIMIT) luminanceCache.clear();
  luminanceCache.set(value, result);
  return result;
}
function contrastRatio(a, b) {
  const first = relativeLuminance(a), second = relativeLuminance(b);
  return (Math.max(first, second) + .05) / (Math.min(first, second) + .05);
}
function hexToRgb(hex) {
  const value = sanitizeHexColor(hex, "#000000").slice(1);
  return [0, 2, 4].map(index => parseInt(value.slice(index, index + 2), 16));
}
function rgbToHex(rgb) {
  return `#${rgb.map((channel) => {
    const safe = Math.max(0, Math.min(255, Math.round(channel)));
    return safe.toString(16).padStart(2, "0");
  }).join("")}`;
}
function nudgeHexForContrast(value, background, minimum = 4.5) {
  const original = sanitizeHexColor(value);
  const bg = sanitizeHexColor(background, "#121417");
  const cacheKey = `${original}|${bg}|${minimum}`;
  const cached = contrastNudgeCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const result = computeNudgedHex(original, bg, minimum);
  if (contrastNudgeCache.size >= PURE_COLOR_CACHE_LIMIT) contrastNudgeCache.clear();
  contrastNudgeCache.set(cacheKey, result);
  return result;
}
function computeNudgedHex(original, bg, minimum) {
  if (contrastRatio(original, bg) >= minimum) return original;
  const base = hexToRgb(original);
  const candidates = [];
  for (const target of [[0, 0, 0], [255, 255, 255]]) {
    for (let step = 1; step <= 40; step += 1) {
      const amount = step / 40;
      const color = rgbToHex(base.map((channel, index) => channel + (target[index] - channel) * amount));
      const ratio = contrastRatio(color, bg);
      candidates.push({ color, ratio, amount });
      if (ratio >= minimum) return color;
    }
  }
  candidates.sort((a, b) => b.ratio - a.ratio || a.amount - b.amount);
  return candidates[0]?.color || original;
}
const categoryColorCache = new Map();
const UI_SURFACE_UNSET = Symbol("unset");
let cachedUiSurfaceEditorRef = UI_SURFACE_UNSET;
let cachedUiSurfaceHex = "";
function currentUiSurface() {
  const editorSnapshot = getPromptPaletteSectionSnapshot("editor");
  if (editorSnapshot === cachedUiSurfaceEditorRef) {
    return cachedUiSurfaceHex;
  }
  const name = loadActiveUiThemeName();
  const colors = loadUiThemes()[name] || BUILTIN_UI_THEMES[name] || BUILTIN_UI_THEMES.Cinder;
  const resolved = sanitizeHexColor(colors?.surface, BUILTIN_UI_THEMES.Cinder.surface);
  cachedUiSurfaceEditorRef = editorSnapshot;
  cachedUiSurfaceHex = resolved;
  return resolved;
}
function categoryColorFromHue(hue, saturation, surface = currentUiSurface(), shadeShift = 0) {
  const background = sanitizeHexColor(surface, BUILTIN_UI_THEMES.Cinder.surface);
  const normHue = ((Number(hue) % 360) + 360) % 360;
  const normSat = Math.max(30, Math.min(90, Number(saturation) || 58));
  const shift = Number(shadeShift) || 0;
  const cacheKey = `${normHue}|${normSat}|${background}|${shift}`;
  const cached = categoryColorCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const preferred = relativeLuminance(background) > .45 ? 36 + shift : 68 + shift;
  let best = null;
  for (let lightness = 15; lightness <= 85; lightness++) {
    const color = hslToHex(normHue, normSat, lightness);
    const ratio = contrastRatio(color, background);
    const candidate = { color, ratio, distance: Math.abs(lightness - preferred) };
    if (ratio >= 4.5 && (!best || best.ratio < 4.5 || candidate.distance < best.distance || (candidate.distance === best.distance && ratio > best.ratio))) best = candidate;
    else if ((!best || best.ratio < 4.5) && (!best || ratio > best.ratio)) best = candidate;
  }
  const result = best?.color || hslToHex(normHue, normSat, preferred);
  if (categoryColorCache.size >= PURE_COLOR_CACHE_LIMIT) categoryColorCache.clear();
  categoryColorCache.set(cacheKey, result);
  return result;
}


export {
  hashStr, canonicalRecipeCategory, categoryOf, slugifyRecipeName, normalizeLibraryEntryPath, isRecipeCategory,
  escapeHtml, highlightMatch, sanitizeHexColor, hslToHex, relativeLuminance, contrastRatio, nudgeHexForContrast, currentUiSurface, categoryColorFromHue,
};

// Shared library insertion separator rule for node and sidebar entry actions.
export function wildcardInsertionText(path, after = "") {
  return `__${path}__` + (/^\s*,/.test(after) ? "" : ", ");
}
