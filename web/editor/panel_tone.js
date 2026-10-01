// Light/dark tone of a Prompt Palette panel, so booru category colors can switch to a deeper
// set on pale themes. Resolved through a 1px canvas so any CSS color syntax (including
// color-mix results) is handled; falls back to "dark".
const toneCache = new Map();
let toneContext = null;

export function panelToneFor(element) {
  try {
    const bg = getComputedStyle(element).backgroundColor || "";
    if (toneCache.has(bg)) return toneCache.get(bg);
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
    const lin = (v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    const tone = (0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)) > 0.42 ? "light" : "dark";
    if (toneCache.size > 64) toneCache.clear();
    toneCache.set(bg, tone);
    return tone;
  } catch {
    return "dark";
  }
}
