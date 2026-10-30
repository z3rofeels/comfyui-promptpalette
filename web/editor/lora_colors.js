import { sanitizeHexColor, nudgeHexForContrast, currentUiSurface } from "./text_utils.js";

export function loraIdentity(name) {
  return String(name || "").replace(/\\/g, "/");
}
export function colorForLora(name, theme = {}) {
  const colors = theme.loraColors || {}; let key = loraIdentity(name);
  if (!Object.hasOwn(colors, key)) { try { key = decodeURIComponent(key); } catch { /* Literal name. */ } }
  let color = Object.hasOwn(colors, key) ? colors[key] : "";
  if (!color) {
    const matches = Object.keys(colors).filter(value => value.replace(/\.[^./]+$/, "") === key);
    if (matches.length === 1) color = colors[matches[0]];
  }
  return sanitizeHexColor(color || theme.loraColor, "") || "var(--wg-accent)";
}

export function textColorForLora(name, theme = {}) {
  const color = colorForLora(name, theme);
  return color.startsWith("#") ? nudgeHexForContrast(color, currentUiSurface()) : color;
}
