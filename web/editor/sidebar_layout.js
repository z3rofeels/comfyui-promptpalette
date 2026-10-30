import { loadSidebarDisplay } from "./preferences.js";

export const snapSidebarSize = value => Math.ceil(value / 4) * 4;

// One width/column calculation for both CSS tracks and virtual row estimates.
// Packed rows choose the nearest whole column count, then share every pixel.
export function resolveSidebarGrid(width, requestedWidth, fillRows = true, gap = 8) {
  const available = Math.max(1, Number(width) || 320);
  const requested = Math.min(available, Math.max(1, requestedWidth));
  if (!fillRows) return {
    columns: Math.max(1, Math.floor((Math.max(1, available - 2) + gap) / (requested + gap))),
    cardWidth: requested,
  };
  const maxColumns = Math.max(1, Math.floor((available + gap) / (32 + gap)));
  const columns = Math.max(1, Math.min(maxColumns, Math.round((available + gap) / (requested + gap))));
  return { columns, cardWidth: (available - (columns - 1) * gap) / columns };
}

export function sidebarLayoutMetrics(key, themeScale = 1, availableWidth = 320) {
  const state = loadSidebarDisplay(), scale = state.scale;
  const ui = Math.max(.75, Math.min(2, Number(themeScale) || 1));
  const progress = (scale - .1) / 1.9;
  const requested = 32 + (Math.max(32, availableWidth - 2) - 32) * progress;
  const grid = resolveSidebarGrid(availableWidth, requested, state.chrome.fillRows);
  const cardWidth = state.layouts[key] === "list" ? requested : grid.cardWidth;
  const ratio = { square: 1, portrait: 3 / 4, tall: 2 / 3, landscape: 4 / 3, wide: 16 / 9 }[state.aspect];
  return { ...grid, mode: state.layouts[key] || "gallery", scale, font: 1, ratio, cardWidth,
    density: cardWidth < 96 ? "tiny" : cardWidth < 160 ? "micro" : "normal",
    rowHeight: (32 + 64 * progress) * ui };
}
