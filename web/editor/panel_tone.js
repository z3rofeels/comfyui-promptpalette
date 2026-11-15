// Light/dark tone of a Prompt Palette panel, so booru category colors can switch to a deeper
// set on pale themes. Resolved through a 1px canvas so any CSS color syntax (including
// color-mix results) is handled; falls back to "dark".
const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const toneCache = new Map();
let toneContext = null;

function luminanceFromRgb(r, g, b) {
  const lin = (v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function panelToneFor(element, background = null) {
  try {
    const bg = (background || getComputedStyle(element).backgroundColor || "").trim();
    if (!bg) return "dark";
    if (toneCache.has(bg)) return toneCache.get(bg);
    let tone;
    if (HEX_COLOR.test(bg)) {
      let h = bg.slice(1);
      if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
      const r = parseInt(h.slice(0, 2), 16);
      const g = parseInt(h.slice(2, 4), 16);
      const b = parseInt(h.slice(4, 6), 16);
      tone = luminanceFromRgb(r, g, b) > 0.42 ? "light" : "dark";
    } else {
      if (!toneContext) {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        toneContext = canvas.getContext("2d", { willReadFrequently: true });
      }
      toneContext.clearRect(0, 0, 1, 1);
      toneContext.fillStyle = "#000";
      toneContext.fillStyle = bg;
      toneContext.fillRect(0, 0, 1, 1);
      const [r, g, b] = toneContext.getImageData(0, 0, 1, 1).data;
      tone = luminanceFromRgb(r, g, b) > 0.42 ? "light" : "dark";
    }
    if (toneCache.size > 64) toneCache.clear();
    toneCache.set(bg, tone);
    return tone;
  } catch {
    return "dark";
  }
}
