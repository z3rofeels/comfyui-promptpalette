import { copyPromptPaletteThemeScope, installPromptPaletteKeyboardBoundary, svgIcon } from "../prompt_palette_shared.js";
import { readEditorPreference, writeEditorPreference } from "../prompt_palette_state.js";
import { observePanelAnchor } from "./performance_runtime.js";

const LIBRARY_VIEWS = { list: "List", grid: "Gallery", tiles: "Tiles", contact: "Contact sheet", masonry: "Masonry", filmstrip: "Filmstrip / detail" };

export function bindLibraryViewControls(drawer, { getView, setView }) {
  const button = drawer.querySelector('[data-el="pickerViewToggle"]');
  const select = drawer.querySelector('[data-library-view]');
  const modes = Object.keys(LIBRARY_VIEWS);
  const sync = (mode) => {
    drawer.dataset.libraryView = mode;
    if (select) select.value = mode;
    if (button) {
      const next = modes[(modes.indexOf(mode) + 1) % modes.length];
      button.innerHTML = svgIcon(mode === "list" || mode === "tiles" ? "list" : "grid");
      button.title = `${LIBRARY_VIEWS[mode]} view · Next: ${LIBRARY_VIEWS[next]} · Choose any view in Library settings`;
      button.setAttribute("aria-label", button.title);
      button.classList.toggle("active", mode !== "list");
    }
  };
  const choose = (mode) => {
    if (!LIBRARY_VIEWS[mode]) return;
    sync(mode);
    setView(mode);
  };
  const cycle = () => choose(modes[(modes.indexOf(getView()) + 1) % modes.length]);
  const change = () => choose(select.value);
  button?.addEventListener("click", cycle);
  select?.addEventListener("change", change);
  sync(LIBRARY_VIEWS[getView()] ? getView() : "list");
  return () => { button?.removeEventListener("click", cycle); select?.removeEventListener("change", change); };
}

export const RATIOS = {
  square: ["1:1", 1],
  portrait: ["3:4", 3 / 4],
  tall: ["2:3", 2 / 3],
  landscape: ["4:3", 4 / 3],
  wide: ["16:9", 16 / 9],
};

const LIBRARY_TOOLBAR_OPTIONS = { pinned: "Pinned filter", thumbs: "Thumbnails filter", recipes: "Recipes filter", folders: "Folder buttons", view: "Grid/list button", selection: "Recipe selection button", aspect: "Visual aspect buttons" };
const DEFAULT_TOOLBAR = Object.fromEntries(Object.keys(LIBRARY_TOOLBAR_OPTIONS).map(key => [key, true]));

const DEFAULT_SECTION_ORDER = ["pinned", "recent", "categories"];
const VALID_SECTIONS = new Set(DEFAULT_SECTION_ORDER);
const VALID_CAT_SORTS = new Set(["custom", "az", "za", "count", "recipes"]);
const VALID_ITEM_SORTS = new Set(["default", "az", "za", "pinned", "thumbs"]);
const VALID_CAPTION_MODES = new Set(["below", "compact", "overlay"]);

const SECTION_LABELS = {
  pinned: "★ Pinned",
  recent: "↺ Recent",
  categories: "📁 Categories",
};

function escHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function normalizeSectionOrder(order) {
  const result = [];
  if (Array.isArray(order)) {
    for (const id of order) {
      const key = String(id || "").toLowerCase();
      if (VALID_SECTIONS.has(key) && !result.includes(key)) result.push(key);
    }
  }
  for (const id of DEFAULT_SECTION_ORDER) {
    if (!result.includes(id)) result.push(id);
  }
  return result;
}

function normalizeStringList(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    const val = String(item || "").trim();
    if (val && !out.includes(val)) out.push(val);
  }
  return out;
}

export function readLibraryDisplayState() {
  const legacy = readEditorPreference("libraryDensity", "medium");
  const stored = readEditorPreference("libraryDisplayV1", null);
  const initialSize = Number(stored?.size);
  return {
    size: Number.isFinite(initialSize) && initialSize >= 64
      ? Math.min(320, Math.round(initialSize))
      : ({ small: 74, medium: 92, large: 120 }[legacy] || 92),
    aspect: RATIOS[stored?.aspect] ? stored.aspect : "square",
    fit: stored?.fit === "cover" ? "cover" : "contain",
    spacing: ["auto", "tight", "normal", "airy"].includes(stored?.spacing) ? stored.spacing : "auto",
    imagePosition: ["center", "top", "bottom"].includes(stored?.imagePosition) ? stored.imagePosition : "center",
    captionMode: VALID_CAPTION_MODES.has(stored?.captionMode) ? stored.captionMode : "below",
    cardStretch: Boolean(stored?.cardStretch),
    listThumbs: stored?.listThumbs !== false,
    showCounts: stored?.showCounts !== false,
    sectionOrder: normalizeSectionOrder(stored?.sectionOrder),
    hiddenSections: normalizeStringList(stored?.hiddenSections).filter((s) => VALID_SECTIONS.has(s)),
    collapsedSections: normalizeStringList(stored?.collapsedSections).filter((s) => VALID_SECTIONS.has(s)),
    catSort: VALID_CAT_SORTS.has(stored?.catSort) ? stored.catSort : "custom",
    itemSort: VALID_ITEM_SORTS.has(stored?.itemSort) ? stored.itemSort : "default",
    hiddenCats: normalizeStringList(stored?.hiddenCats),
    toolbar: Object.fromEntries(Object.keys(DEFAULT_TOOLBAR).map(key => [key, stored?.toolbar?.[key] !== false])),
  };
}

export function getLibraryOrganization(drawer) {
  const cached = drawer?.__ppLibraryDisplayState;
  return cached ? { ...cached } : readLibraryDisplayState();
}

export function sortLibraryCategories(categories = [], grouped = new Map(), org = {}, customOrder = []) {
  const list = Array.isArray(categories) ? [...categories] : [];
  const hiddenSet = new Set(Array.isArray(org?.hiddenCats) ? org.hiddenCats : []);
  const visible = org?.includeHidden ? list : list.filter((cat) => !hiddenSet.has(cat));
  const mode = org?.catSort || "custom";
  const orderIndex = new Map();
  if (Array.isArray(customOrder)) {
    customOrder.forEach((cat, idx) => orderIndex.set(String(cat), idx));
  }
  const getCount = (cat) => {
    if (grouped instanceof Map) return (grouped.get(cat) || []).length;
    if (grouped && typeof grouped === "object") return (grouped[cat] || []).length;
    return 0;
  };
  const isRecipeCat = (cat) => {
    const low = String(cat || "").toLowerCase();
    return low === "recipes" || low.startsWith("recipes/");
  };

  visible.sort((a, b) => {
    if (mode === "az") return String(a).localeCompare(String(b), undefined, { sensitivity: "base" });
    if (mode === "za") return String(b).localeCompare(String(a), undefined, { sensitivity: "base" });
    if (mode === "count") {
      const diff = getCount(b) - getCount(a);
      if (diff !== 0) return diff;
      return String(a).localeCompare(String(b), undefined, { sensitivity: "base" });
    }
    if (mode === "recipes") {
      const ra = isRecipeCat(a) ? 0 : 1;
      const rb = isRecipeCat(b) ? 0 : 1;
      if (ra !== rb) return ra - rb;
      return String(a).localeCompare(String(b), undefined, { sensitivity: "base" });
    }
    const ia = orderIndex.has(a) ? orderIndex.get(a) : Number.MAX_SAFE_INTEGER;
    const ib = orderIndex.has(b) ? orderIndex.get(b) : Number.MAX_SAFE_INTEGER;
    if (ia !== ib) return ia - ib;
    return String(a).localeCompare(String(b), undefined, { sensitivity: "base" });
  });
  return visible;
}

export function sortLibraryItems(items = [], org = {}, pinnedSet = new Set(), thumbMap = {}) {
  const list = Array.isArray(items) ? [...items] : [];
  const mode = org?.itemSort || "default";
  if (mode === "default" && !org?.quickFilter) return list;

  const filtered = org?.quickFilter
    ? list.filter((item) => {
        const p = item?.path || "";
        if (org.quickFilter === "pinned") return pinnedSet instanceof Set ? pinnedSet.has(p) : false;
        if (org.quickFilter === "thumbs") return Boolean(thumbMap && thumbMap[p]);
        if (org.quickFilter === "recipes") {
          const low = p.toLowerCase();
          return low.startsWith("recipes/") || String(item?.category || "").toLowerCase().startsWith("recipes");
        }
        return true;
      })
    : list;

  if (mode === "default") return filtered;

  const isPinned = (item) => (pinnedSet instanceof Set ? pinnedSet.has(item?.path) : false);
  const hasThumb = (item) => Boolean(thumbMap && thumbMap[item?.path]);
  const getLabel = (item) => String(item?.name || item?.path || "");

  filtered.sort((a, b) => {
    if (mode === "az") return getLabel(a).localeCompare(getLabel(b), undefined, { sensitivity: "base" });
    if (mode === "za") return getLabel(b).localeCompare(getLabel(a), undefined, { sensitivity: "base" });
    if (mode === "pinned") {
      const pa = isPinned(a) ? 0 : 1;
      const pb = isPinned(b) ? 0 : 1;
      if (pa !== pb) return pa - pb;
      return getLabel(a).localeCompare(getLabel(b), undefined, { sensitivity: "base" });
    }
    if (mode === "thumbs") {
      const ta = hasThumb(a) ? 0 : 1;
      const tb = hasThumb(b) ? 0 : 1;
      if (ta !== tb) return ta - tb;
      return getLabel(a).localeCompare(getLabel(b), undefined, { sensitivity: "base" });
    }
    return 0;
  });
  return filtered;
}

export function positionLibraryHoverTip(hoverTip, clientX, clientY) {
  if (!hoverTip || typeof window === "undefined") return;
  const pad = 12;
  const vw = window.innerWidth || 1280;
  const vh = window.innerHeight || 800;
  const rect = hoverTip.getBoundingClientRect?.() || { width: 260, height: 180 };
  const w = rect.width || 260;
  const h = rect.height || 180;
  let left = clientX + 16;
  let top = clientY + 14;
  if (left + w + pad > vw) left = clientX - w - 14;
  if (top + h + pad > vh) top = vh - h - pad;
  // Clamp both edges so wide tips in narrow windows never clip off-screen.
  left = Math.max(pad, Math.min(left, vw - w - pad));
  top = Math.max(pad, Math.min(top, vh - h - pad));
  hoverTip.style.left = `${Math.round(left)}px`;
  hoverTip.style.top = `${Math.round(top)}px`;
}

export function renderLibraryHoverTip(hoverTip, {
  name = "",
  lines = [],
  totalLines = null,
  thumbUrl = "",
  category = "",
  accent = "",
  isPinned = false,
  isRecipe = false,
  error = false,
  clientX = null,
  clientY = null,
} = {}) {
  if (!hoverTip) return;
  const rawName = String(name || "");
  const parts = rawName.split("/").filter(Boolean);
  const shortTitle = parts[parts.length - 1] || rawName;
  const catName = category || (parts.length > 1 ? parts.slice(0, -1).join("/") : "general");
  const recipeFlag = isRecipe || rawName.toLowerCase().startsWith("recipes/");

  const cleanLines = (Array.isArray(lines) ? lines : [])
    .map((line) => String(line || "").trim())
    .filter((line) => line && !line.startsWith("# PP_RECIPE_V1"));

  const shownLines = cleanLines.slice(0, 6);
  const total = Number.isFinite(totalLines) && totalLines > 0 ? totalLines : cleanLines.length;
  const remaining = Math.max(0, total - shownLines.length);

  const mediaHtml = thumbUrl
    ? `<div class="wg-tip-media">
        <img class="wg-tip-thumb" src="${escHtml(thumbUrl)}" alt="${escHtml(shortTitle)}" loading="eager" />
      </div>`
    : "";

  const badgesHtml = [
    isPinned ? `<span class="wg-tip-badge wg-tip-badge--pin">★ Pinned</span>` : "",
    recipeFlag ? `<span class="wg-tip-badge wg-tip-badge--recipe">📖 Recipe</span>` : "",
    total > 0 ? `<span class="wg-tip-badge">${total} ${total === 1 ? "line" : "lines"}</span>` : "",
  ].filter(Boolean).join("");

  let bodyHtml = "";
  if (error) {
    bodyHtml = `<div class="wg-tip-line muted">Preview unavailable</div>`;
  } else if (!shownLines.length) {
    bodyHtml = `<div class="wg-tip-line muted">Empty wildcard file</div>`;
  } else {
    bodyHtml = `<div class="wg-tip-lines">${shownLines
      .map((line) => `<div class="wg-tip-line">${escHtml(line.slice(0, 110))}</div>`)
      .join("")}${remaining > 0 ? `<div class="wg-tip-more">+${remaining} more ${remaining === 1 ? "entry" : "entries"}…</div>` : ""}</div>`;
  }

  hoverTip.innerHTML = `<div class="wg-tip-rich${thumbUrl ? " has-thumb" : ""}" style="${accent ? `--wg-tip-accent:${escHtml(accent)};` : ""}">
    ${mediaHtml}
    <div class="wg-tip-content">
      <div class="wg-tip-head">
        <div class="wg-tip-title-row">
          <span class="wg-tip-cat-dot" aria-hidden="true"></span>
          <span class="wg-tip-title">${escHtml(shortTitle)}</span>
        </div>
        <div class="wg-tip-meta-row">
          <code class="wg-tip-token">__${escHtml(rawName)}__</code>
          <div class="wg-tip-badges">${badgesHtml}</div>
        </div>
        <div class="wg-tip-cat-path">${escHtml(catName)}</div>
      </div>
      ${bodyHtml}
    </div>
  </div>`;

  if (clientX !== null && clientY !== null) {
    hoverTip.__lastClientX = clientX;
    hoverTip.__lastClientY = clientY;
    positionLibraryHoverTip(hoverTip, clientX, clientY);
  }
  const img = hoverTip.querySelector(".wg-tip-thumb");
  if (img) {
    img.addEventListener("load", () => {
      if (!hoverTip.classList.contains("hidden") && Number.isFinite(hoverTip.__lastClientX)) {
        positionLibraryHoverTip(hoverTip, hoverTip.__lastClientX, hoverTip.__lastClientY);
      }
    }, { once: true });
    img.addEventListener("error", () => {
      img.closest(".wg-tip-media")?.remove();
    }, { once: true });
  }
}

export function libraryScrollbarMarkup(id = "personal") {
  return `<div class="wg-lib-scrollbar" data-lib-scrollbar="${escHtml(id)}" role="presentation" aria-hidden="true">
    <button type="button" class="wg-lib-scroll-step" data-lib-scroll-step="-1" tabindex="-1" title="Scroll up" aria-label="Scroll library up">▴</button>
    <div class="wg-lib-scroll-track" data-lib-scroll-track title="Click or drag to scroll library">
      <div class="wg-lib-scroll-thumb" data-lib-scroll-thumb></div>
    </div>
    <button type="button" class="wg-lib-scroll-step" data-lib-scroll-step="1" tabindex="-1" title="Scroll down" aria-label="Scroll library down">▾</button>
  </div>`;
}

export function bindLibraryScrollbar(scrollEl, barEl) {
  if (!scrollEl || !barEl) return { refresh() {}, cleanup() {} };
  scrollEl.classList.add("has-custom-scrollbar");
  const findInBar = (sel) => barEl.querySelector?.(sel) || barEl.parentElement?.querySelector?.(sel);
  const upBtn = findInBar('[data-lib-scroll-step="-1"]');
  const downBtn = findInBar('[data-lib-scroll-step="1"]');
  const track = findInBar("[data-lib-scroll-track]");
  const thumb = findInBar("[data-lib-scroll-thumb]");
  const cleanups = [];
  const on = (el, evt, fn, opts) => {
    if (!el?.addEventListener) return;
    el.addEventListener(evt, fn, opts);
    cleanups.push(() => el.removeEventListener?.(evt, fn, opts));
  };

  function refresh() {
    if (!scrollEl || !barEl) return;
    if (scrollEl.offsetHeight > 0) {
      barEl.style.top = `${scrollEl.offsetTop}px`;
      barEl.style.height = `${scrollEl.offsetHeight}px`;
      barEl.style.bottom = "auto";
    }
    const scrollHeight = Math.max(0, Number(scrollEl.scrollHeight) || 0);
    const clientHeight = Math.max(0, Number(scrollEl.clientHeight) || 0);
    const maxScroll = Math.max(0, scrollHeight - clientHeight);
    const canScroll = maxScroll > 1;
    barEl.classList.toggle("is-scrollable", canScroll);
    barEl.dataset.scrollable = String(canScroll);
    const curScroll = Math.max(0, Math.min(maxScroll, Number(scrollEl.scrollTop) || 0));
    if (upBtn) upBtn.disabled = !canScroll || curScroll <= 0;
    if (downBtn) downBtn.disabled = !canScroll || curScroll >= maxScroll - 1;
    if (!thumb) return;
    if (!canScroll) {
      thumb.style.height = "100%";
      thumb.style.transform = "translateY(0px)";
      thumb.dataset.progress = "0";
      return;
    }
    const trackHeight = Math.max(36, Number(track?.clientHeight) || Math.max(40, clientHeight - 32));
    const ratio = clientHeight / Math.max(1, scrollHeight);
    const thumbHeight = Math.max(24, Math.min(trackHeight, Math.round(trackHeight * ratio)));
    const maxThumbTop = Math.max(0, trackHeight - thumbHeight);
    const progress = maxScroll > 0 ? curScroll / maxScroll : 0;
    const thumbTop = Math.round(progress * maxThumbTop);
    thumb.style.height = `${thumbHeight}px`;
    thumb.style.transform = `translateY(${thumbTop}px)`;
    thumb.dataset.progress = String(Math.round(progress * 100));
  }

  for (const evt of ["pointerdown", "mousedown", "click", "dblclick", "dragstart", "contextmenu"]) {
    on(barEl, evt, (e) => e.stopPropagation());
  }

  on(scrollEl, "wheel", (e) => {
    if (e.ctrlKey || e.metaKey) return;
    e.stopPropagation();
  }, { passive: true });

  on(scrollEl, "scroll", refresh, { passive: true });

  let dragSession = null;
  function stopDrag() {
    if (!dragSession) return;
    const { pointerId, move, up } = dragSession;
    dragSession = null;
    barEl.classList.remove("dragging");
    if (typeof window !== "undefined") {
      window.removeEventListener?.("pointermove", move, true);
      window.removeEventListener?.("pointerup", up, true);
      window.removeEventListener?.("pointercancel", up, true);
    }
    try { thumb?.releasePointerCapture?.(pointerId); } catch {}
  }

  on(thumb, "pointerdown", (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation?.();
    stopDrag();
    const startY = Number(e.clientY) || 0;
    const startScroll = Number(scrollEl.scrollTop) || 0;
    const pointerId = e.pointerId;
    barEl.classList.add("dragging");
    try { thumb.setPointerCapture?.(pointerId); } catch {}

    const move = (ev) => {
      ev.preventDefault?.();
      ev.stopPropagation?.();
      const maxScroll = Math.max(0, (Number(scrollEl.scrollHeight) || 0) - (Number(scrollEl.clientHeight) || 0));
      if (maxScroll <= 0) return;
      const trackRect = track?.getBoundingClientRect?.();
      const thumbRect = thumb?.getBoundingClientRect?.();
      const trackPx = (trackRect?.height || Number(track?.clientHeight) || 120);
      const thumbPx = (thumbRect?.height || Number(thumb?.clientHeight) || 28);
      const travel = Math.max(1, trackPx - thumbPx);
      const deltaY = (Number(ev.clientY) || 0) - startY;
      scrollEl.scrollTop = Math.max(0, Math.min(maxScroll, Math.round(startScroll + (deltaY / travel) * maxScroll)));
      if (typeof Event === "function") {
        try { scrollEl.dispatchEvent(new Event("scroll")); } catch {}
      }
      refresh();
    };
    const up = (ev) => {
      ev?.stopPropagation?.();
      stopDrag();
    };
    dragSession = { pointerId, move, up };
    if (typeof window !== "undefined") {
      window.addEventListener?.("pointermove", move, true);
      window.addEventListener?.("pointerup", up, true);
      window.addEventListener?.("pointercancel", up, true);
    }
  });
  on(thumb, "lostpointercapture", stopDrag);

  on(track, "pointerdown", (e) => {
    if (e.target === thumb || thumb?.contains?.(e.target)) return;
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const maxScroll = Math.max(0, (Number(scrollEl.scrollHeight) || 0) - (Number(scrollEl.clientHeight) || 0));
    if (maxScroll <= 0) return;
    const rect = track?.getBoundingClientRect?.();
    const thumbRect = thumb?.getBoundingClientRect?.();
    const trackTop = rect?.top || 0;
    const trackPx = rect?.height || Number(track?.clientHeight) || 120;
    const thumbPx = thumbRect?.height || Number(thumb?.clientHeight) || 28;
    const travel = Math.max(1, trackPx - thumbPx);
    const clickOffset = (Number(e.clientY) || 0) - trackTop - thumbPx / 2;
    const ratio = Math.max(0, Math.min(1, clickOffset / travel));
    scrollEl.scrollTop = Math.round(ratio * maxScroll);
    if (typeof Event === "function") {
      try { scrollEl.dispatchEvent(new Event("scroll")); } catch {}
    }
    refresh();
  });

  let holdTimer = null;
  const clearHold = () => {
    if (holdTimer !== null) {
      if (typeof clearInterval === "function") clearInterval(holdTimer);
      holdTimer = null;
    }
  };
  const stepBy = (dir) => {
    const maxScroll = Math.max(0, (Number(scrollEl.scrollHeight) || 0) - (Number(scrollEl.clientHeight) || 0));
    if (maxScroll <= 0) return;
    const step = Math.max(56, Math.round(((Number(scrollEl.clientHeight) || 240) * 0.32)));
    scrollEl.scrollTop = Math.max(0, Math.min(maxScroll, (Number(scrollEl.scrollTop) || 0) + dir * step));
    if (typeof Event === "function") {
      try { scrollEl.dispatchEvent(new Event("scroll")); } catch {}
    }
    refresh();
  };
  for (const [btn, dir] of [[upBtn, -1], [downBtn, 1]]) {
    let pointerHandled = false;
    on(btn, "pointerdown", (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      pointerHandled = true;
      clearHold();
      stepBy(dir);
      if (typeof setInterval === "function") holdTimer = setInterval(() => stepBy(dir), 95);
    });
    on(btn, "pointerup", clearHold);
    on(btn, "pointerleave", clearHold);
    on(btn, "pointercancel", clearHold);
    on(btn, "click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!pointerHandled) stepBy(dir);
      pointerHandled = false;
    });
  }

  const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(refresh) : null;
  ro?.observe(scrollEl);
  const mo = typeof MutationObserver !== "undefined" ? new MutationObserver(refresh) : null;
  try { mo?.observe(scrollEl, { childList: true, subtree: false }); } catch {}

  refresh();
  return {
    refresh,
    cleanup() {
      stopDrag();
      clearHold();
      ro?.disconnect();
      mo?.disconnect();
      cleanups.forEach((fn) => fn());
    },
  };
}

export function libraryFilterBarMarkup() {
  return `<div class="wg-library-filter-bar" role="toolbar" aria-label="My Library quick filters and folder tools">
    <div class="wg-lib-quick-filters" role="group" aria-label="Filter entries">
      ${[["all", "All", "", "Show all entries"], ["pinned", "Pinned", "pin", "Show pinned entries only"], ["thumbs", "Thumbs", "image", "Show entries with user thumbnails"], ["recipes", "Recipes", "recipe", "Show Palette Recipes only"]].map(([key, label, icon, title]) => `<button type="button" class="wg-lib-qf${key === "all" ? " active" : ""}" data-lib-quick-filter="${key}" aria-pressed="${key === "all"}" title="${title}">${icon ? svgIcon(icon, 12) : ""}<span>${label}</span></button>`).join("")}
    </div>
    <div class="wg-lib-folder-tools" role="group" aria-label="Folder actions">
      <button type="button" class="wg-lib-folder-btn" data-act="libExpandAll" title="Expand all folders" aria-label="Expand all folders">⊞</button>
      <button type="button" class="wg-lib-folder-btn" data-act="libCollapseAll" title="Collapse all folders" aria-label="Collapse all folders">⊟</button>
    </div>
  </div>`;
}

export function libraryDisplayMarkup() {
  return `<div class="wg-library-display" role="group" aria-label="Library display">
    <div class="wg-library-customize-panel hidden" data-library-customize-panel role="region" aria-label="Library organization and view settings">
      <div class="wg-lib-cust-section">
        <label class="wg-lib-cust-field"><span>View</span><select data-library-view aria-label="Library view"><option value="list">List</option><option value="grid">Gallery</option><option value="tiles">Tiles — names &amp; folders</option><option value="contact">Contact sheet — image first</option><option value="masonry">Masonry — natural image ratios</option><option value="filmstrip">Filmstrip — detail &amp; neighbors</option></select></label>
        <div class="wg-lib-cust-head">
          <span class="wg-lib-cust-title">Thumbnail Size &amp; Ratio</span>
          <button type="button" class="wg-lib-cust-reset" data-lib-org-reset title="Reset library display and organization settings to defaults">Reset</button>
        </div>
        <div class="wg-lib-size-row">
          <label class="wg-library-size"><span>Size</span><input type="range" min="64" max="320" step="1" data-library-size aria-label="Library thumbnail size" title="Drag to resize cards · Double-click to reset"><output data-library-size-value></output></label>
          <button type="button" class="wg-library-fit" data-library-fit aria-pressed="false" title="Fit shows the whole image; Fill crops to the frame">Fit</button>
          <select data-library-aspect aria-label="Thumbnail aspect ratio" hidden tabindex="-1"><option value="square">1:1</option><option value="portrait">3:4</option><option value="tall">2:3</option><option value="landscape">4:3</option><option value="wide">16:9</option></select>
        </div>
        <div class="wg-lib-aspect-pills" role="group" aria-label="Visual aspect ratio presets">
          <button type="button" class="wg-lib-aspect-pill" data-library-aspect-pill="square" title="Square (1:1)"><i class="wg-ratio-box wg-ratio-box--square"></i><span>1:1</span></button>
          <button type="button" class="wg-lib-aspect-pill" data-library-aspect-pill="portrait" title="Portrait (3:4)"><i class="wg-ratio-box wg-ratio-box--portrait"></i><span>3:4</span></button>
          <button type="button" class="wg-lib-aspect-pill" data-library-aspect-pill="tall" title="Tall Portrait (2:3)"><i class="wg-ratio-box wg-ratio-box--tall"></i><span>2:3</span></button>
          <button type="button" class="wg-lib-aspect-pill" data-library-aspect-pill="landscape" title="Landscape (4:3)"><i class="wg-ratio-box wg-ratio-box--landscape"></i><span>4:3</span></button>
          <button type="button" class="wg-lib-aspect-pill" data-library-aspect-pill="wide" title="Widescreen (16:9)"><i class="wg-ratio-box wg-ratio-box--wide"></i><span>16:9</span></button>
        </div>
        <div class="wg-lib-cust-row">
          <label class="wg-lib-cust-field">
            <span>Captions</span>
            <select data-lib-caption-mode aria-label="Card caption style">
              <option value="below">Standard</option>
              <option value="compact">Compact</option>
              <option value="overlay">Overlay</option>
            </select>
          </label>
          <div class="wg-lib-cust-toggles">
            <button type="button" class="wg-lib-toggle-chip" data-lib-card-stretch aria-pressed="false" title="Stretch cards to fill the full row width">Fill Row</button>
            <button type="button" class="wg-lib-toggle-chip" data-lib-list-thumbs aria-pressed="true" title="Show mini user thumbnails inside List view rows">List Thumbs</button>
            <button type="button" class="wg-lib-toggle-chip" data-lib-show-counts aria-pressed="true" title="Show folder and filter counts">Counts</button>
          </div>
        </div>
      </div>
      <details class="wg-lib-cust-advanced" data-lib-image-settings>
        <summary class="wg-lib-cust-summary"><span class="wg-lib-cust-title">Image &amp; spacing</span></summary>
        <div class="wg-lib-cust-advanced-body">
          <label class="wg-lib-cust-field"><span>Spacing</span><select data-lib-spacing aria-label="Card spacing"><option value="auto">Match view</option><option value="tight">Tight</option><option value="normal">Comfortable</option><option value="airy">Airy</option></select></label>
          <label class="wg-lib-cust-field"><span>Image anchor</span><select data-lib-image-position aria-label="Thumbnail image anchor"><option value="center">Center</option><option value="top">Top — portraits</option><option value="bottom">Bottom</option></select></label>
          <p class="wg-lib-settings-hint">Fill crops to the frame. Fit keeps the whole image. Images are never stretched.</p>
        </div>
      </details>
      <details class="wg-lib-cust-advanced" data-lib-toolbar-settings>
        <summary class="wg-lib-cust-summary"><span class="wg-lib-cust-title">Toolbar shortcuts</span></summary>
        <div class="wg-lib-toolbar-options">${Object.entries(LIBRARY_TOOLBAR_OPTIONS).map(([key, label]) => `<label><input type="checkbox" data-lib-toolbar-option="${key}"><span>${label}</span></label>`).join("")}</div>
        <div class="wg-lib-more-controls" data-lib-more-controls hidden><span>More controls</span><div data-lib-shortcut-shelf></div></div>
      </details>
      <details class="wg-lib-cust-advanced" data-lib-cust-advanced>
      <summary class="wg-lib-cust-summary" title="Show, hide, reorder and sort library sections and folders">
        <span class="wg-lib-cust-summary-caret" aria-hidden="true">▸</span>
        <span class="wg-lib-cust-title">Organization</span>
        <span class="wg-lib-cust-badge" data-lib-org-badge hidden></span>
      </summary>
      <div class="wg-lib-cust-advanced-body">
      <div class="wg-lib-cust-section">
        <div class="wg-lib-cust-head">
          <span class="wg-lib-cust-title">Sections (Show / Reorder)</span>
        </div>
        <div class="wg-lib-sec-list" data-lib-sec-list></div>
      </div>
      <div class="wg-lib-cust-section">
        <div class="wg-lib-cust-row">
          <label class="wg-lib-cust-field">
            <span>Sort Folders</span>
            <select data-lib-cat-sort aria-label="Sort categories">
              <option value="custom">Custom Order</option>
              <option value="az">Name A → Z</option>
              <option value="za">Name Z → A</option>
              <option value="count">Most Entries</option>
              <option value="recipes">Recipes First</option>
            </select>
          </label>
          <label class="wg-lib-cust-field">
            <span>Sort Entries</span>
            <select data-lib-item-sort aria-label="Sort entries within categories">
              <option value="default">Default</option>
              <option value="az">Name A → Z</option>
              <option value="za">Name Z → A</option>
              <option value="pinned">★ Pinned First</option>
              <option value="thumbs">🖼 Thumbs First</option>
            </select>
          </label>
        </div>
      </div>
      <div class="wg-lib-cust-section" data-lib-cat-manager-section>
        <div class="wg-lib-cust-head">
          <span class="wg-lib-cust-title">Visible Folders</span>
          <button type="button" class="wg-lib-cust-link hidden" data-lib-show-all-cats>Show All</button>
        </div>
        <div class="wg-lib-cat-chips" data-lib-cat-chips>
          <span class="wg-lib-cust-empty">Folders appear once loaded</span>
        </div>
      </div>
      </div>
      </details>
    </div>
  </div>`;
}

export function libraryDisplayGeometry(drawer) {
  const size = Number(drawer?.dataset.cardSize) || 92;
  const ratio = RATIOS[drawer?.dataset.cardAspect]?.[1] || 1;
  const fontScale = drawer && typeof getComputedStyle === "function"
    ? Number.parseFloat(getComputedStyle(drawer).getPropertyValue("--wg-ui-font-scale")) || 1
    : 1;
  const captionMode = drawer?.dataset.captionMode || "below";
  const baseCaption = captionMode === "overlay" ? 0 : captionMode === "compact" ? 24 : 36;
  return { size, ratio, captionHeight: baseCaption * fontScale };
}

// Tiles keep their established 64–120px band for normal sizes, then continue to
// grow gently so the full slider travel stays live instead of hitting a clamp.
export function libraryTileHeight(size, scale = 1) {
  const s = Number(size) || 92, cap = 120 * scale;
  return Math.max(64 * scale, s <= cap ? s : cap + (s - cap) * 0.3);
}

// Shared by the Editor's virtual search and both nodes' actual card markup.
export function libraryVirtualLayout(drawer) {
  const { size, ratio, captionHeight } = libraryDisplayGeometry(drawer);
  const view = drawer.dataset.libraryView || "grid";
  const scale = parseFloat(getComputedStyle(drawer).getPropertyValue("--wg-ui-font-scale")) || 1;
  const gap = ({ tight: 2, normal: 8, airy: 12 })[drawer.dataset.librarySpacing] ?? (view === "contact" ? 2 : view === "tiles" ? 6 : 8);
  const tileHeight = libraryTileHeight(size, scale);
  const cardHeightForWidth = view === "tiles"
    ? () => tileHeight + 2 + gap
    : width => (width - 2) / ratio + (view === "contact" ? 0 : captionHeight) + 2 + gap;
  return { minCardWidth: size, imageAspectRatio: ratio,
    fixedCardWidth: view === "tiles" || view === "contact" ? false : drawer.dataset.cardStretch !== "true",
    columnCount: view === "tiles" ? 1 : null,
    estimateCardHeight: cardHeightForWidth(size), cardHeightForWidth, inlinePadding: 0, gap };
}

export function libraryThumbnailMarkup(url, isRecipe = false) {
  const fallback = `<div class="wg-thumb-fallback" aria-hidden="true" ${url ? "hidden" : ""}><span class="wg-thumb-fallback-glyph">${svgIcon(isRecipe ? "recipe" : "folder", 24)}</span></div>`;
  return `<div class="wg-thumb-media">${fallback}${url ? `<img class="wg-thumb-img" src="${escHtml(url)}" alt="" loading="lazy" decoding="async" fetchpriority="low">` : ""}</div>`;
}

export function bindLibraryDisplay(drawer, onChange = () => {}, options = {}) {
  const state = readLibraryDisplayState();
  drawer.__ppLibraryDisplayState = state;
  const onOrganizeChange = typeof options?.onOrganizeChange === "function" ? options.onOrganizeChange : null;

  const size = drawer.querySelector("[data-library-size]");
  const output = drawer.querySelector("[data-library-size-value]");
  const aspect = drawer.querySelector("[data-library-aspect]");
  const fit = drawer.querySelector("[data-library-fit]");
  const customizeBtns = Array.from(drawer.querySelectorAll("[data-library-customize-toggle]"));
  const customizeBtn = customizeBtns[0] || null;
  const customizePanel = drawer.querySelector("[data-library-customize-panel]");
  const aspectPills = Array.from(drawer.querySelectorAll("[data-library-aspect-pill]"));
  const spacingSelect = drawer.querySelector('[data-lib-spacing]');
  const imagePositionSelect = drawer.querySelector('[data-lib-image-position]');
  const captionSelect = drawer.querySelector("[data-lib-caption-mode]");
  const cardStretchBtn = drawer.querySelector("[data-lib-card-stretch]");
  const listThumbsBtn = drawer.querySelector("[data-lib-list-thumbs]");
  const showCountsBtn = drawer.querySelector("[data-lib-show-counts]");
  const secListEl = drawer.querySelector("[data-lib-sec-list]");
  const catSortSelect = drawer.querySelector("[data-lib-cat-sort]");
  const itemSortSelect = drawer.querySelector("[data-lib-item-sort]");
  const catChipsEl = drawer.querySelector("[data-lib-cat-chips]");
  const showAllCatsBtn = drawer.querySelector("[data-lib-show-all-cats]");
  const resetBtn = drawer.querySelector("[data-lib-org-reset]");
  const advancedEl = drawer.querySelector("[data-lib-cust-advanced]");
  const orgBadge = drawer.querySelector("[data-lib-org-badge]");
  const listEl = drawer.querySelector('[data-el="pickerList"]');
  const searchEl = drawer.querySelector('[data-el="search"]');
  const DEFAULT_SIZE = 92;
  let resetFlashTimer = null;
  let pendingReveal = null;
  let pendingFocus = null;

  const scrollbarBindings = [];
  for (const [scrollSel, barId] of [
    ['[data-el="pickerList"]', "personal"],
    ['[data-el="starterTree"]', "starter"],
  ]) {
    const scrollEl = drawer.querySelector(scrollSel);
    const barEl = drawer.querySelector(`[data-lib-scrollbar="${barId}"]`);
    if (scrollEl && barEl) {
      scrollbarBindings.push(bindLibraryScrollbar(scrollEl, barEl));
    }
  }
  const refreshScrollbars = () => {
    scrollbarBindings.forEach((sb) => sb.refresh());
  };

  let knownCategories = [];
  let categoryColorFn = options?.getCategoryColor || null;

  const computeAvailableMax = (explicitWidth = 0) => {
    const w = Number(explicitWidth) || drawer.clientWidth || Number(drawer.dataset.width) || 0;
    const style = listEl?.clientWidth ? getComputedStyle(listEl) : null;
    const contentWidth = style ? listEl.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) : w - 24;
    return w > 0 ? Math.max(64, Math.min(320, Math.floor(contentWidth))) : 320;
  };

  // Keep the slider's entire travel useful in compact drawers. A saved larger
  // preference comes back when the panel widens; it is not overwritten by fit.
  let availableMax = computeAvailableMax();

  let sectionsMarkup = null, categoriesMarkup = null;
  function renderSectionsList() {
    if (!secListEl) return;
    const order = normalizeSectionOrder(state.sectionOrder);
    const hidden = new Set(state.hiddenSections || []);
    const markup = order.map((secId, idx) => {
      const isVisible = !hidden.has(secId);
      return `<div class="wg-lib-sec-row${isVisible ? "" : " is-hidden"}" data-sec-id="${escHtml(secId)}">
        <button type="button" class="wg-lib-sec-toggle${isVisible ? " active" : ""}" data-lib-sec-toggle="${escHtml(secId)}" aria-pressed="${String(isVisible)}" title="${isVisible ? "Hide section" : "Show section"}">
          <span class="wg-lib-sec-check">${isVisible ? "✓" : ""}</span>
          <span class="wg-lib-sec-name">${escHtml(SECTION_LABELS[secId] || secId)}</span>
        </button>
        <div class="wg-lib-sec-order-btns">
          <button type="button" class="wg-lib-sec-move" data-lib-sec-move="up" data-sec-id="${escHtml(secId)}" ${idx === 0 ? "disabled" : ""} title="Move section up" aria-label="Move ${escHtml(secId)} up">↑</button>
          <button type="button" class="wg-lib-sec-move" data-lib-sec-move="down" data-sec-id="${escHtml(secId)}" ${idx === order.length - 1 ? "disabled" : ""} title="Move section down" aria-label="Move ${escHtml(secId)} down">↓</button>
        </div>
      </div>`;
    }).join("");
    if (markup !== sectionsMarkup) { secListEl.innerHTML = markup; sectionsMarkup = markup; }
  }

  function renderCategoryChips() {
    if (!catChipsEl) return;
    const hiddenSet = new Set(state.hiddenCats || []);
    if (showAllCatsBtn) {
      showAllCatsBtn.classList.toggle("hidden", hiddenSet.size === 0);
      showAllCatsBtn.textContent = `Show All (${hiddenSet.size} hidden)`;
    }
    if (!knownCategories.length) {
      if (categoriesMarkup !== "") catChipsEl.innerHTML = `<span class="wg-lib-cust-empty">No folders loaded</span>`;
      categoriesMarkup = "";
      return;
    }
    const markup = knownCategories.map((cat) => {
      const isHidden = hiddenSet.has(cat);
      const color = typeof categoryColorFn === "function" ? categoryColorFn(cat) : "";
      return `<button type="button" class="wg-lib-cat-chip${isHidden ? " is-hidden" : " active"}" data-lib-cat-toggle="${escHtml(cat)}" aria-pressed="${String(!isHidden)}" title="${isHidden ? `Show "${cat}" folder` : `Hide "${cat}" folder`}" style="${color ? `--cat-chip-color:${escHtml(color)};` : ""}">
        <span class="wg-lib-cat-chip-dot" aria-hidden="true"></span>
        <span class="wg-lib-cat-chip-label">${escHtml(cat)}</span>
      </button>`;
    }).join("");
    if (markup !== categoriesMarkup) { catChipsEl.innerHTML = markup; categoriesMarkup = markup; }
  }

  function notifyOrganizeChange() {
    drawer.__ppLibraryDisplayState = state;
    if (typeof CustomEvent === "function") {
      try {
        drawer.dispatchEvent(new CustomEvent("pp-library-organize-change", { detail: { state: { ...state } } }));
      } catch {}
    }
    onOrganizeChange?.({ ...state });
  }

  function apply(persist = false, organization = true) {
    const effectiveSize = Math.min(state.size, availableMax);
    const ratioNum = RATIOS[state.aspect]?.[1] || 1;
    const imageHeight = Math.max(36, Math.round(effectiveSize / ratioNum));
    drawer.__ppLibraryDisplayState = state;
    drawer.classList.add("wg-library-display-scope");
    drawer.dataset.librarySpacing = state.spacing;
    drawer.style.setProperty("--wg-library-image-position", state.imagePosition);
    drawer.style.setProperty("--wg-library-gap", state.spacing === "auto" ? "var(--wg-library-view-gap, 8px)" : `${({ tight: 2, normal: 8, airy: 12 })[state.spacing]}px`);
    // CSS twin of libraryTileHeight(); stays live when --wg-ui-font-scale changes.
    drawer.style.setProperty("--wg-tile-height", `max(calc(64px * var(--wg-ui-font-scale, 1)), calc(min(${effectiveSize}px, 120px * var(--wg-ui-font-scale, 1)) + max(0px, ${effectiveSize}px - 120px * var(--wg-ui-font-scale, 1)) * 0.3))`);
    drawer.dataset.cardSize = String(effectiveSize);
    drawer.dataset.cardAspect = state.aspect;
    drawer.dataset.cardFit = state.fit;
    drawer.dataset.captionMode = state.captionMode || "below";
    drawer.dataset.cardStretch = String(Boolean(state.cardStretch));
    drawer.dataset.listThumbs = String(state.listThumbs !== false);
    drawer.dataset.showCounts = String(state.showCounts !== false);
    drawer.style.setProperty("--wg-personal-thumb-min", `${effectiveSize}px`);
    drawer.style.setProperty("--wg-library-image-ratio", String(ratioNum));
    drawer.style.setProperty("--wg-library-image-height", `${imageHeight}px`);
    drawer.style.setProperty("--wg-library-image-fit", state.fit);
    drawer.style.setProperty("--wg-starter-thumb", `${Math.round(effectiveSize * 0.56)}px`);
    drawer.style.setProperty("--wg-starter-card-height", `${Math.round(effectiveSize * 0.56)}px`);
    drawer.style.setProperty("--wg-starter-card-min", `${Math.max(138, effectiveSize + 56)}px`);
    if (size) {
      size.max = String(availableMax);
      size.value = effectiveSize;
      // A zero-width range is a dead control; show it as such until the drawer widens.
      size.disabled = availableMax <= 64;
      size.setAttribute("aria-valuetext", `${effectiveSize} pixels card width`);
    }
    if (output) output.textContent = `${effectiveSize}px`;
    if (aspect) aspect.value = state.aspect;
    if (fit) {
      fit.textContent = state.fit === "contain" ? "Fit" : "Fill";
      fit.setAttribute("aria-pressed", String(state.fit === "cover"));
    }
    for (const pill of aspectPills) {
      const active = pill.dataset.libraryAspectPill === state.aspect;
      pill.classList.toggle("active", active);
      pill.setAttribute("aria-pressed", String(active));
    }
    if (spacingSelect) spacingSelect.value = state.spacing;
    if (imagePositionSelect) imagePositionSelect.value = state.imagePosition;
    if (captionSelect) captionSelect.value = state.captionMode || "below";
    if (cardStretchBtn) {
      cardStretchBtn.classList.toggle("active", Boolean(state.cardStretch));
      cardStretchBtn.setAttribute("aria-pressed", String(Boolean(state.cardStretch)));
    }
    if (listThumbsBtn) {
      const on = state.listThumbs !== false;
      listThumbsBtn.classList.toggle("active", on);
      listThumbsBtn.setAttribute("aria-pressed", String(on));
    }
    if (showCountsBtn) {
      const on = state.showCounts !== false;
      showCountsBtn.classList.toggle("active", on);
      showCountsBtn.setAttribute("aria-pressed", String(on));
    }
    if (catSortSelect) catSortSelect.value = state.catSort || "custom";
    if (itemSortSelect) itemSortSelect.value = state.itemSort || "default";
    if (orgBadge) {
      const changes = (state.hiddenSections?.length || 0) + (state.hiddenCats?.length || 0)
        + ((state.catSort || "custom") !== "custom" ? 1 : 0)
        + ((state.itemSort || "default") !== "default" ? 1 : 0);
      orgBadge.hidden = changes === 0;
      orgBadge.textContent = changes ? `${changes} custom` : "";
    }
    syncToolbar();
    if (organization) { renderSectionsList(); renderCategoryChips(); }
    if (persist) writeEditorPreference("libraryDisplayV1", { ...state });
  }

  let pendingRender = null;
  const scheduleRender = () => {
    if (pendingRender !== null) return;
    if (typeof requestAnimationFrame === "function") {
      pendingRender = requestAnimationFrame(() => {
        pendingRender = null;
        onChange();
      });
    } else {
      onChange();
    }
  };

  const listeners = [];
  function listen(el, name, handler, opts) {
    if (!el) return;
    el.addEventListener(name, handler, opts);
    listeners.push(() => el.removeEventListener(name, handler, opts));
  }

  for (const control of [
    size,
    aspect,
    fit,
    ...customizeBtns,
    customizePanel,
    captionSelect,
    cardStretchBtn,
    listThumbsBtn,
    showCountsBtn,
    catSortSelect,
    itemSortSelect,
    showAllCatsBtn,
    resetBtn,
  ]) {
    listen(control, "pointerdown", (e) => e.stopPropagation());
    listen(control, "click", (e) => e.stopPropagation());
    listen(control, "keydown", (e) => {
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", " "].includes(e.key)) {
        e.stopPropagation();
      }
    });
  }

  const toolbarOptions = Array.from(drawer.querySelectorAll("[data-lib-toolbar-option]"));
  const shortcutShelf = drawer.querySelector("[data-lib-shortcut-shelf]");
  const moreControls = drawer.querySelector("[data-lib-more-controls]");
  const shortcuts = new Map();
  for (const [key, selector] of Object.entries({ pinned: '[data-lib-quick-filter="pinned"]', thumbs: '[data-lib-quick-filter="thumbs"]', recipes: '[data-lib-quick-filter="recipes"]', folders: '.wg-lib-folder-tools', view: '[data-el="pickerViewToggle"]', selection: '[data-el="recipeSelectToggle"]' })) {
    const element = drawer.querySelector(selector);
    if (!element) continue;
    const marker = document.createComment(`Library ${key} shortcut`); element.before(marker);
    shortcuts.set(key, { element, marker });
    if (!element.getAttribute("aria-label") && element.title) element.setAttribute("aria-label", element.title);
  }
  function syncHeader(tab = drawer.dataset.libraryTab || "personal") {
    drawer.dataset.libraryTab = tab;
    for (const element of drawer.querySelectorAll('[data-library-personal]')) element.hidden = tab !== "personal";
    syncToolbar();
  }
  function syncToolbar() {
    const fontScale = parseFloat(getComputedStyle(drawer).getPropertyValue("--wg-ui-font-scale")) || 1;
    const compact = drawer.clientWidth < 240 * fontScale;
    for (const control of toolbarOptions) {
      const key = control.dataset.libToolbarOption;
      control.checked = state.toolbar[key] !== false;
      control.closest("label").hidden = key !== "aspect" && !shortcuts.has(key);
    }
    for (const [key, { element, marker }] of shortcuts) {
      const inToolbar = state.toolbar[key] !== false && !(compact && ["view", "selection"].includes(key));
      const target = inToolbar ? marker.parentNode : shortcutShelf;
      if (target && element.parentNode !== target) {
        if (target === marker.parentNode) marker.after(element); else target.append(element);
      }
    }
    if (moreControls) moreControls.hidden = drawer.dataset.libraryTab === "starter" || !shortcutShelf?.children.length;
    const all = drawer.querySelector('[data-lib-quick-filter="all"]');
    const active = drawer.querySelector('[data-lib-quick-filter].active')?.dataset.libQuickFilter || "all";
    if (all) (all.querySelector("span") || all).textContent = active !== "all" && state.toolbar[active] === false ? `Clear ${active}` : "All";
    for (const group of drawer.querySelectorAll('.wg-lib-quick-filters')) group.hidden = group.children.length === 1 && active === "all";
    const bar = drawer.querySelector('.wg-library-filter-bar');
    if (bar) bar.hidden = !Array.from(bar.children).some(element => !element.hidden && element.children.length);
    for (const pill of aspectPills) pill.parentElement.hidden = state.toolbar.aspect === false;
    if (aspect) { aspect.hidden = state.toolbar.aspect !== false; aspect.tabIndex = state.toolbar.aspect === false ? 0 : -1; }
  }
  for (const control of toolbarOptions) listen(control, "change", () => {
    state.toolbar[control.dataset.libToolbarOption] = control.checked; apply(true); refreshScrollbars();
  });
  listen(drawer, "error", event => {
    const image = event.target;
    if (!image.matches?.('.wg-thumb-media > .wg-thumb-img')) return;
    image.closest(".wg-thumb-item")?.classList.remove("has-thumb");
    image.hidden = true; const fallback = image.parentElement.querySelector('.wg-thumb-fallback');
    if (fallback) fallback.hidden = false;
  }, true);

  listen(size, "input", () => {
    state.size = Math.max(64, Math.min(availableMax, Number(size.value) || 92));
    apply(false, false);
    scheduleRender();
    refreshScrollbars();
  });
  listen(size, "change", () => apply(true));
  listen(size, "dblclick", (e) => {
    e.preventDefault();
    e.stopPropagation();
    state.size = DEFAULT_SIZE;
    apply(true);
    scheduleRender();
    refreshScrollbars();
  });
  listen(aspect, "change", () => {
    state.aspect = RATIOS[aspect.value] ? aspect.value : "square";
    apply(true);
    scheduleRender();
    refreshScrollbars();
  });
  listen(fit, "click", (e) => {
    e.preventDefault();
    state.fit = state.fit === "contain" ? "cover" : "contain";
    apply(true);
  });

  for (const pill of aspectPills) {
    listen(pill, "click", (e) => {
      e.preventDefault();
      const next = pill.dataset.libraryAspectPill;
      if (!RATIOS[next]) return;
      state.aspect = next;
      apply(true);
      scheduleRender();
      refreshScrollbars();
    });
  }

  const isCustomizeOpen = () => Boolean(customizePanel && !customizePanel.classList.contains("hidden"));

  // Move the existing controls into a scoped portal; no canvas/prototype hooks.
  const SIDECAR_GAP = 8;
  const SIDECAR_MARGIN = 8;
  const panelHome = customizePanel ? document.createComment("Library settings home") : null;
  if (customizePanel) customizePanel.before(panelHome);
  let sidecar = null;
  let stopPlacement = null;
  let sidecarPlacement = "";
  let floatingPosition = null;
  let gesture = null;
  let themeObserver = null;
  const savedSize = readEditorPreference("librarySettingsSizeV1", null);
  let fitSettingsHeight = !Number.isFinite(savedSize?.height);
  const panelSize = {
    width: Number.isFinite(savedSize?.width) ? Math.max(260, Math.min(800, savedSize.width)) : 340,
    height: Number.isFinite(savedSize?.height) ? Math.max(220, Math.min(1000, savedSize.height)) : 560,
  };
  const persistSize = () => writeEditorPreference("librarySettingsSizeV1", { ...panelSize });

  function syncSidecarTheme() {
    if (!sidecar) return;
    const scope = drawer.closest?.(".wg-node, .pp-node, .ppwc-surface") || drawer;
    copyPromptPaletteThemeScope(scope, sidecar);
    for (const cls of ["wg-high-contrast", "wg-reduce-motion", "wg-no-animations", "wg-disable-animations", "wg-large-text"]) {
      sidecar.classList.toggle(cls, scope.classList?.contains(cls) === true);
    }
  }

  function finishGesture() {
    if (!gesture) return;
    const { target, id, resizing } = gesture;
    gesture = null;
    if (target.hasPointerCapture?.(id)) target.releasePointerCapture(id);
    sidecar?.classList.remove("is-manipulating");
    if (resizing) persistSize();
  }

  function ensureSidecar() {
    if (sidecar) return sidecar;
    sidecar = document.createElement("div");
    sidecar.className = "wg-root wg-library-sidecar";
    sidecar.hidden = true;
    sidecar.setAttribute("role", "dialog");
    sidecar.setAttribute("aria-label", "Library settings");
    sidecar.setAttribute("aria-modal", "false");
    sidecar.innerHTML = `<div class="wg-library-sidecar-head">
      <button type="button" class="wg-library-sidecar-drag" data-lib-sidecar-drag aria-label="Move library settings; use arrow keys" title="Drag to move · Arrow keys move · Double-click to follow library">${svgIcon("settings", 14)}<span>Library settings</span></button>
      <button type="button" class="wg-close-btn" data-lib-sidecar-close aria-label="Close library settings" title="Close">×</button>
      </div><div class="wg-library-sidecar-body wg-library-display" data-lib-sidecar-body></div>
      <div class="wg-library-sidecar-foot"><button type="button" data-lib-sidecar-follow aria-pressed="true" title="Keep settings beside the library as the canvas moves">Follow library</button><button type="button" data-lib-sidecar-reset title="Restore settings window size and position">Reset window</button><button type="button" data-lib-sidecar-resize aria-label="Resize library settings; use arrow keys" title="Drag to resize · Arrow keys resize">◢</button></div>`;
    listen(sidecar, "pointerdown", (e) => e.stopPropagation());
    listen(sidecar, "click", (e) => e.stopPropagation());
    listen(sidecar, "wheel", (e) => e.stopPropagation(), { passive: true });
    listen(sidecar, "keydown", (e) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      e.stopPropagation();
      setCustomizeOpen(false);
      customizeBtns.find((b) => !b.hidden)?.focus?.({ preventScroll: true });
    });
    listen(sidecar.querySelector("[data-lib-sidecar-close]"), "click", () => {
      setCustomizeOpen(false);
      customizeBtns.find((b) => !b.hidden)?.focus?.({ preventScroll: true });
    });
    const follow = () => { finishGesture(); floatingPosition = null; sidecarPlacement = ""; placeSidecar(); };
    listen(sidecar.querySelector("[data-lib-sidecar-follow]"), "click", () => {
      if (floatingPosition) follow();
      else { const r = sidecar.getBoundingClientRect(); floatingPosition = { left: r.left, top: r.top }; sidecarPlacement = ""; placeSidecar(); }
    });
    listen(sidecar.querySelector("[data-lib-sidecar-reset]"), "click", () => {
      panelSize.width = 340; panelSize.height = 560; fitSettingsHeight = true;
      writeEditorPreference("librarySettingsSizeV1", null); follow();
    });
    const drag = sidecar.querySelector("[data-lib-sidecar-drag]");
    listen(drag, "dblclick", follow);
    for (const [target, resizing] of [[drag, false], [sidecar.querySelector("[data-lib-sidecar-resize]"), true]]) {
      listen(target, "pointerdown", (e) => {
        if (e.button !== 0 || gesture) return;
        e.preventDefault(); target.focus({ preventScroll: true });
        const rect = sidecar.getBoundingClientRect();
        floatingPosition = { left: rect.left, top: rect.top };
        gesture = { target, resizing, id: e.pointerId, x: e.clientX, y: e.clientY, rect };
        target.setPointerCapture(e.pointerId);
        sidecar.classList.add("is-manipulating");
      });
      listen(target, "pointermove", (e) => {
        if (!gesture || e.pointerId !== gesture.id) return;
        const { rect, x, y } = gesture;
        if (resizing) {
          fitSettingsHeight = false;
          panelSize.width = Math.max(260, Math.min(800, innerWidth - rect.left - SIDECAR_MARGIN, rect.width + e.clientX - x));
          panelSize.height = Math.max(220, Math.min(1000, innerHeight - rect.top - SIDECAR_MARGIN, rect.height + e.clientY - y));
        } else floatingPosition = { left: rect.left + e.clientX - x, top: rect.top + e.clientY - y };
        sidecarPlacement = ""; placeSidecar();
      });
      for (const event of ["pointerup", "pointercancel", "lostpointercapture"]) listen(target, event, finishGesture);
      listen(target, "keydown", (e) => {
        if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key) || e.ctrlKey || e.metaKey || e.altKey) return;
        e.preventDefault();
        const step = e.shiftKey ? 40 : 10;
        const dx = e.key === "ArrowRight" ? step : e.key === "ArrowLeft" ? -step : 0;
        const dy = e.key === "ArrowDown" ? step : e.key === "ArrowUp" ? -step : 0;
        const rect = sidecar.getBoundingClientRect();
        floatingPosition = { left: rect.left + (resizing ? 0 : dx), top: rect.top + (resizing ? 0 : dy) };
        if (resizing) {
          fitSettingsHeight = false;
          panelSize.width = Math.max(260, Math.min(800, innerWidth - rect.left - SIDECAR_MARGIN, rect.width + dx));
          panelSize.height = Math.max(220, Math.min(1000, innerHeight - rect.top - SIDECAR_MARGIN, rect.height + dy));
          persistSize();
        }
        sidecarPlacement = ""; placeSidecar();
      });
    }
    listeners.push(installPromptPaletteKeyboardBoundary(sidecar));
    return sidecar;
  }

  function placeSidecar() {
    if (!sidecar || sidecar.hidden) return;
    const rect = drawer.getBoundingClientRect();
    const usable = drawer.isConnected && drawer.classList.contains("open")
      && !customizeBtn?.closest?.("[hidden]") && rect.width >= 40 && rect.height >= 40;
    if (!usable) { setCustomizeOpen(false); return; }
    const vw = globalThis.innerWidth || document.documentElement.clientWidth;
    const vh = globalThis.innerHeight || document.documentElement.clientHeight;
    const width = Math.min(panelSize.width, Math.max(1, vw - SIDECAR_MARGIN * 2));
    if (sidecar.style.width !== `${width}px`) sidecar.style.width = `${width}px`;
    const contentHeight = fitSettingsHeight
      ? Math.max(220, customizePanel.scrollHeight + sidecar.querySelector(".wg-library-sidecar-head").offsetHeight + sidecar.querySelector(".wg-library-sidecar-foot").offsetHeight + 2)
      : panelSize.height;
    const height = Math.min(contentHeight, panelSize.height, Math.max(1, vh - SIDECAR_MARGIN * 2));
    const key = [rect.left, rect.top, rect.width, rect.height, vw, vh, width, height, floatingPosition?.left, floatingPosition?.top].join();
    if (key === sidecarPlacement) return;
    sidecarPlacement = key;
    sidecar.style.visibility = floatingPosition || (rect.right > 0 && rect.left < vw && rect.bottom > 0 && rect.top < vh) ? "" : "hidden";
    let left = rect.left - SIDECAR_GAP - width;
    if (left < SIDECAR_MARGIN) left = rect.right + SIDECAR_GAP + width <= vw - SIDECAR_MARGIN ? rect.right + SIDECAR_GAP : rect.left + SIDECAR_GAP;
    left = Math.max(SIDECAR_MARGIN, Math.min(floatingPosition?.left ?? left, vw - width - SIDECAR_MARGIN));
    const top = Math.max(SIDECAR_MARGIN, Math.min(floatingPosition?.top ?? rect.top, vh - height - SIDECAR_MARGIN));
    if (floatingPosition) floatingPosition = { left, top };
    Object.assign(sidecar.style, { left: `${Math.round(left)}px`, top: `${Math.round(top)}px`, width: `${width}px`, height: `${height}px` });
    sidecar.querySelector("[data-lib-sidecar-follow]").setAttribute("aria-pressed", String(!floatingPosition));
  }

  function showSidecar() {
    const host = ensureSidecar();
    syncSidecarTheme();
    themeObserver?.disconnect();
    themeObserver = new MutationObserver(syncSidecarTheme);
    // Observe only the owning ancestry, never the portal or document subtree.
    for (let el = drawer; el; el = el.parentElement) {
      themeObserver.observe(el, { attributes: true, attributeFilter: ["style", "class", "data-wg-tone", "data-wg-finish"] });
    }
    host.querySelector("[data-lib-sidecar-body]").append(customizePanel);
    customizePanel.classList.remove("hidden");
    if (!host.isConnected) document.body.append(host);
    host.hidden = false;
    sidecarPlacement = "";
    placeSidecar();
    host.querySelector("[data-lib-sidecar-drag]").focus({ preventScroll: true });
    stopPlacement?.();
    stopPlacement = observePanelAnchor(drawer, placeSidecar, { content: customizePanel });
  }

  function hideSidecar() {
    finishGesture();
    themeObserver?.disconnect();
    themeObserver = null;
    customizePanel.classList.add("hidden");
    if (panelHome?.parentNode && customizePanel.parentNode !== panelHome.parentNode) panelHome.after(customizePanel);
    if (sidecar) sidecar.hidden = true;
    stopPlacement?.(); stopPlacement = null;
  }

  function setCustomizeOpen(nextOpen) {
    if (!customizePanel) return;
    if (nextOpen) showSidecar(); else hideSidecar();
    for (const candidate of customizeBtns) {
      candidate.classList.toggle("active", nextOpen);
      candidate.setAttribute("aria-expanded", String(nextOpen));
    }
    refreshScrollbars();
  }

  for (const btn of customizeBtns) {
    listen(btn, "click", (e) => {
      e.preventDefault();
      setCustomizeOpen(!isCustomizeOpen());
    });
  }

  if (advancedEl) {
    if (readEditorPreference("libraryOrganizeOpen", false) === true) advancedEl.open = true;
    listen(advancedEl, "toggle", () => {
      writeEditorPreference("libraryOrganizeOpen", Boolean(advancedEl.open));
      refreshScrollbars();
    });
  }

  const isTypingTarget = (el) => {
    const tag = String(el?.tagName || "").toLowerCase();
    return tag === "input" || tag === "textarea" || tag === "select" || Boolean(el?.isContentEditable);
  };

  listen(drawer, "keydown", (e) => {
    if (e.defaultPrevented) return;
    if (e.key === "Escape" && isCustomizeOpen()) {
      e.preventDefault();
      e.stopPropagation();
      const returnFocus = customizePanel.contains?.(e.target) || customizeBtns.includes(e.target);
      setCustomizeOpen(false);
      if (returnFocus) customizeBtns.find((b) => !b.hidden)?.focus?.({ preventScroll: true });
      return;
    }
    const wantsSearch = (e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey && !isTypingTarget(e.target))
      || ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && String(e.key).toLowerCase() === "f");
    if (wantsSearch && searchEl && !searchEl.closest?.("[hidden]")) {
      e.preventDefault();
      e.stopPropagation();
      searchEl.focus?.({ preventScroll: true });
      searchEl.select?.();
    }
  });

  const headerSelector = ".wg-folder[data-cat]";
  const sectionSelector = "[data-sec-collapse]";
  const headerKey = (el) => {
    if (!el?.dataset) return null;
    if (el.dataset.secCollapse) return { kind: "sec", key: el.dataset.secCollapse };
    if (el.dataset.cat && el.classList?.contains("wg-folder")) return { kind: "cat", key: el.dataset.cat };
    return null;
  };
  const findHeader = (ref) => {
    if (!ref || !listEl) return null;
    if (ref.kind === "sec") return Array.from(listEl.querySelectorAll(sectionSelector)).find((h) => h.dataset.secCollapse === ref.key) || null;
    return Array.from(listEl.querySelectorAll(headerSelector)).find((h) => h.dataset.cat === ref.key) || null;
  };
  const headerFromEvent = (target) => {
    const header = target?.closest?.(sectionSelector) || target?.closest?.(headerSelector);
    if (!header) return null;
    if (target?.closest?.("button") && target.closest("button") !== header) return null;
    return header;
  };

  listen(listEl, "click", (e) => {
    const header = headerFromEvent(e.target);
    pendingReveal = header ? headerKey(header) : null;
  }, true);

  listen(listEl, "keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const header = e.target;
    if (!header?.matches?.(headerSelector) && !header?.matches?.(sectionSelector)) return;
    e.preventDefault();
    e.stopPropagation();
    pendingFocus = headerKey(header);
    header.click?.();
  });

  function revealToggledContent() {
    const ref = pendingReveal;
    pendingReveal = null;
    const header = findHeader(ref);
    if (!header) return;
    const expanded = ref.kind === "sec" ? !header.classList.contains("is-collapsed") : header.classList.contains("expanded");
    if (!expanded) return;
    let sibling = header.nextElementSibling;
    for (let i = 0; sibling && i < 80; i += 1, sibling = sibling.nextElementSibling) {
      if (sibling.matches?.(".wg-folder, .wg-section-label, .wg-hidden-cats-bar, .wg-lib-empty-state")) break;
      sibling.classList?.add("wg-lib-reveal");
    }
  }

  function decorateHeaders() {
    if (!listEl) return;
    for (const header of listEl.querySelectorAll(headerSelector)) {
      header.tabIndex = 0;
      header.setAttribute("role", "button");
      header.setAttribute("aria-expanded", String(header.classList.contains("expanded")));
    }
    for (const header of listEl.querySelectorAll(sectionSelector)) {
      header.tabIndex = 0;
      header.setAttribute("role", "button");
      header.setAttribute("aria-expanded", String(!header.classList.contains("is-collapsed")));
    }
  }

  function syncQuickFilterCounts(counts) {
    if (!counts || typeof counts !== "object") return;
    for (const btn of drawer.querySelectorAll("[data-lib-quick-filter]")) {
      const n = Number(counts[btn.dataset.libQuickFilter]);
      if (!Number.isFinite(n)) continue;
      btn.dataset.count = n > 999 ? "999+" : String(n);
      btn.toggleAttribute("data-empty", n === 0 && btn.dataset.libQuickFilter !== "all");
    }
  }

  listen(spacingSelect, "change", () => {
    state.spacing = ["auto", "tight", "normal", "airy"].includes(spacingSelect.value) ? spacingSelect.value : "auto";
    apply(true); scheduleRender(); notifyOrganizeChange();
  });
  listen(imagePositionSelect, "change", () => {
    state.imagePosition = ["center", "top", "bottom"].includes(imagePositionSelect.value) ? imagePositionSelect.value : "center";
    apply(true);
  });
  listen(captionSelect, "change", () => {
    state.captionMode = VALID_CAPTION_MODES.has(captionSelect.value) ? captionSelect.value : "below";
    apply(true);
    scheduleRender();
    refreshScrollbars();
  });

  listen(cardStretchBtn, "click", (e) => {
    e.preventDefault();
    state.cardStretch = !state.cardStretch;
    apply(true);
    scheduleRender();
    refreshScrollbars();
  });

  listen(listThumbsBtn, "click", (e) => {
    e.preventDefault();
    state.listThumbs = state.listThumbs === false;
    apply(true);
    notifyOrganizeChange();
    refreshScrollbars();
  });

  listen(showCountsBtn, "click", (e) => {
    e.preventDefault();
    state.showCounts = state.showCounts === false;
    apply(true);
  });

  listen(catSortSelect, "change", () => {
    state.catSort = VALID_CAT_SORTS.has(catSortSelect.value) ? catSortSelect.value : "custom";
    apply(true);
    notifyOrganizeChange();
    refreshScrollbars();
  });

  listen(itemSortSelect, "change", () => {
    state.itemSort = VALID_ITEM_SORTS.has(itemSortSelect.value) ? itemSortSelect.value : "default";
    apply(true);
    notifyOrganizeChange();
    refreshScrollbars();
  });

  listen(secListEl, "click", (e) => {
    const toggleBtn = e.target?.closest?.("[data-lib-sec-toggle]");
    if (toggleBtn) {
      e.preventDefault();
      const secId = toggleBtn.dataset.libSecToggle;
      if (!VALID_SECTIONS.has(secId)) return;
      const hidden = new Set(state.hiddenSections || []);
      if (hidden.has(secId)) hidden.delete(secId);
      else hidden.add(secId);
      state.hiddenSections = Array.from(hidden);
      apply(true);
      notifyOrganizeChange();
      refreshScrollbars();
      return;
    }
    const moveBtn = e.target?.closest?.("[data-lib-sec-move]");
    if (moveBtn) {
      e.preventDefault();
      const secId = moveBtn.dataset.secId;
      const dir = moveBtn.dataset.libSecMove;
      const order = normalizeSectionOrder(state.sectionOrder);
      const idx = order.indexOf(secId);
      if (idx === -1) return;
      const targetIdx = dir === "up" ? idx - 1 : idx + 1;
      if (targetIdx < 0 || targetIdx >= order.length) return;
      const [item] = order.splice(idx, 1);
      order.splice(targetIdx, 0, item);
      state.sectionOrder = order;
      apply(true);
      notifyOrganizeChange();
      refreshScrollbars();
    }
  });

  listen(catChipsEl, "click", (e) => {
    const chip = e.target?.closest?.("[data-lib-cat-toggle]");
    if (!chip) return;
    e.preventDefault();
    const cat = chip.dataset.libCatToggle;
    if (!cat) return;
    const hidden = new Set(state.hiddenCats || []);
    if (hidden.has(cat)) hidden.delete(cat);
    else hidden.add(cat);
    state.hiddenCats = Array.from(hidden);
    apply(true);
    notifyOrganizeChange();
    refreshScrollbars();
  });

  listen(showAllCatsBtn, "click", (e) => {
    e.preventDefault();
    if (!state.hiddenCats?.length) return;
    state.hiddenCats = [];
    apply(true);
    notifyOrganizeChange();
    refreshScrollbars();
  });

  listen(resetBtn, "click", (e) => {
    e.preventDefault();
    state.size = 92;
    state.spacing = "auto";
    state.imagePosition = "center";
    state.toolbar = { ...DEFAULT_TOOLBAR };
    state.aspect = "square";
    state.fit = "contain";
    state.captionMode = "below";
    state.cardStretch = false;
    state.listThumbs = true;
    state.showCounts = true;
    state.sectionOrder = [...DEFAULT_SECTION_ORDER];
    state.hiddenSections = [];
    state.collapsedSections = [];
    state.catSort = "custom";
    state.itemSort = "default";
    state.hiddenCats = [];
    apply(true);
    scheduleRender();
    notifyOrganizeChange();
    refreshScrollbars();
    if (resetFlashTimer !== null && typeof clearTimeout === "function") clearTimeout(resetFlashTimer);
    resetBtn.classList.add("is-done");
    resetBtn.textContent = "✓ Reset";
    if (typeof setTimeout === "function") {
      resetFlashTimer = setTimeout(() => {
        resetFlashTimer = null;
        resetBtn.classList.remove("is-done");
        resetBtn.textContent = "Reset";
      }, 1100);
    }
  });

  const handleResizeSync = (event) => {
    const next = computeAvailableMax(event?.detail?.width);
    refreshScrollbars();
    syncToolbar();
    if (next === availableMax) return;
    const previousSize = Math.min(state.size, availableMax);
    availableMax = next;
    apply(false, false);
    // A wider slider range alone does not change any card. Retain decoded
    // thumbnails and virtual anchors until the effective card size changes.
    if (Math.min(state.size, availableMax) !== previousSize) scheduleRender();
  };

  listen(drawer, "pp-library-resized", handleResizeSync);
  const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(handleResizeSync) : null;
  observer?.observe(drawer);
  syncHeader(drawer.querySelector('[data-library-tab].active')?.dataset.libraryTab || "personal");
  apply();
  refreshScrollbars();

  const api = {
    cleanup() {
      observer?.disconnect();
      scrollbarBindings.forEach((sb) => sb.cleanup());
      if (pendingRender !== null && typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(pendingRender);
      }
      if (resetFlashTimer !== null && typeof clearTimeout === "function") clearTimeout(resetFlashTimer);
      if (customizePanel) hideSidecar();
      listeners.forEach((remove) => remove());
      sidecar?.remove();
      sidecar = null;
      panelHome?.remove();
      for (const { element, marker } of shortcuts.values()) { marker.after(element); marker.remove(); }
      if (drawer.__ppLibraryDisplayBinding === api) delete drawer.__ppLibraryDisplayBinding;
    },
    refreshScrollbars,
    syncHeader,
    afterListRender({ counts = null } = {}) {
      decorateHeaders();
      revealToggledContent();
      if (pendingFocus) {
        const target = findHeader(pendingFocus);
        pendingFocus = null;
        target?.focus?.({ preventScroll: true });
      }
      syncQuickFilterCounts(counts);
      syncToolbar();
      refreshScrollbars();
    },
    closeCustomize() {
      setCustomizeOpen(false);
    },
    syncCategories(categories = [], getColor = null) {
      if (typeof getColor === "function") categoryColorFn = getColor;
      const next = Array.isArray(categories) ? categories.map((c) => String(c || "").trim()).filter(Boolean) : [];
      knownCategories = next;
      renderCategoryChips();
      refreshScrollbars();
    },
    getState() {
      return { ...state };
    },
    setState(patch = {}, { persist = true, notify = true } = {}) {
      if (!patch || typeof patch !== "object") return;
      if (Array.isArray(patch.hiddenCats)) state.hiddenCats = normalizeStringList(patch.hiddenCats);
      if (Array.isArray(patch.hiddenSections)) state.hiddenSections = normalizeStringList(patch.hiddenSections).filter((s) => VALID_SECTIONS.has(s));
      if (Array.isArray(patch.collapsedSections)) state.collapsedSections = normalizeStringList(patch.collapsedSections).filter((s) => VALID_SECTIONS.has(s));
      if (Array.isArray(patch.sectionOrder)) state.sectionOrder = normalizeSectionOrder(patch.sectionOrder);
      if (VALID_CAT_SORTS.has(patch.catSort)) state.catSort = patch.catSort;
      if (VALID_ITEM_SORTS.has(patch.itemSort)) state.itemSort = patch.itemSort;
      apply(persist);
      if (notify) notifyOrganizeChange();
      refreshScrollbars();
    },
  };
  drawer.__ppLibraryDisplayBinding = api;
  return api;
}

