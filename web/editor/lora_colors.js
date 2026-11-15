import { sanitizeHexColor, nudgeHexForContrast, currentUiSurface } from "./text_utils.js";

export function loraIdentity(name) {
  let s = String(name || "").trim().replace(/\\/g, "/");
  const match = s.match(/^<lora:([^:<>\r\n]+)/i);
  if (match) s = match[1].trim();
  s = s.replace(/>$/, "").split(":")[0].trim();
  return s;
}

// Scanning every saved color for every card made opening a large catalog cost
// (cards x saved colors) regex runs. Index each color object once on its first fuzzy lookup.
// The first entry in insertion order wins, exactly as the scans did. Saved color objects are
// replaced, never edited in place, so caching by object identity cannot go stale.
const fuzzyColorIndexes = new WeakMap();
function fuzzyColorIndex(colors) {
  let index = fuzzyColorIndexes.get(colors);
  if (index) return index;
  index = { byClean: new Map(), byBase: new Map() };
  for (const [key, value] of Object.entries(colors)) {
    const clean = loraIdentity(key).replace(/\.[^./]+$/, "").toLowerCase();
    if (!index.byClean.has(clean)) index.byClean.set(clean, value);
    const base = clean.split("/").pop();
    if (!index.byBase.has(base)) index.byBase.set(base, value);
  }
  fuzzyColorIndexes.set(colors, index);
  return index;
}

export function customColorForLora(name, theme = {}) {
  const colors = theme?.loraColors || {};
  let key = loraIdentity(name);
  if (!key) return "";
  let decKey = key;
  try { decKey = decodeURIComponent(key); } catch { /* Literal name. */ }

  if (Object.hasOwn(colors, key)) return sanitizeHexColor(colors[key], "");
  if (Object.hasOwn(colors, decKey)) return sanitizeHexColor(colors[decKey], "");

  const cleanKey = decKey.replace(/\.[^./]+$/, "").toLowerCase();
  const baseKey = cleanKey.split("/").pop();

  // Names without an exact entry fall back to extension-less, then file-name-only matches.
  const index = fuzzyColorIndex(colors);
  if (index.byClean.has(cleanKey)) return sanitizeHexColor(index.byClean.get(cleanKey), "");
  if (index.byBase.has(baseKey)) return sanitizeHexColor(index.byBase.get(baseKey), "");

  if (theme?.loraColor) return sanitizeHexColor(theme.loraColor, "");
  return "";
}

export function colorForLora(name, theme = {}) {
  const custom = customColorForLora(name, theme);
  if (custom) return custom;
  return "var(--wg-accent)";
}

export function textColorForLora(name, theme = {}) {
  const color = colorForLora(name, theme);
  return color.startsWith("#") ? nudgeHexForContrast(color, currentUiSurface()) : color;
}
