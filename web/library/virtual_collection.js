import { renderVisualCollection, resetVisualCollection } from "./visual_collection.js";

function frame(callback) {
  const raf = globalThis.requestAnimationFrame;
  return typeof raf === "function" ? raf(callback) : setTimeout(callback, 0);
}
function cancelFrame(handle) {
  if (!handle) return;
  if (typeof globalThis.cancelAnimationFrame === "function") globalThis.cancelAnimationFrame(handle); else clearTimeout(handle);
}

export class VirtualCollection {
  constructor({ scrollRoot, items = [], renderItem, renderThumbnail = null, mode = "list", estimateRowHeight = 32, estimateCardHeight = 132, minCardWidth = 88, imageAspectRatio = 1, fixedCardWidth = false, columnCount = null, inlinePadding = null, cardHeightForWidth = null, overscan = 2, onVisibleCount = null, requestRender = null, captureFocus = null, restoreFocus = null, styleDeclaration = null, releaseStyle = null, gap = 6, strideGrid = 1, preserveViewport = false } = {}) {
    this.scrollRoot = scrollRoot;
    this.items = Array.isArray(items) ? items : [];
    this.renderItem = renderItem;
    this.renderThumbnail = renderThumbnail;
    this.mode = mode;
    this.estimateRowHeight = estimateRowHeight;
    this.estimateCardHeight = estimateCardHeight;
    this.minCardWidth = minCardWidth;
    this.fixedCardWidth = fixedCardWidth;
    this.columnCount = columnCount;
    this.inlinePadding = inlinePadding;
    this.cardHeightForWidth = cardHeightForWidth;
    this.imageAspectRatio = Number.isFinite(imageAspectRatio) && imageAspectRatio > 0 ? imageAspectRatio : 1;
    this.overscan = overscan;
    this.onVisibleCount = onVisibleCount;
    this.requestRender = requestRender;
    this.captureFocus = captureFocus;
    this.restoreFocus = restoreFocus;
    // Sidebar-only opt-ins. Node drawers retain their existing six-pixel layout
    // and declaration target; no canvas/widget integration changes here.
    this.styleDeclaration = styleDeclaration;
    this.releaseStyle = releaseStyle;
    this.gap = gap;
    this.strideGrid = strideGrid;
    this.preserveViewport = preserveViewport;
    this.layoutWidth = 0;
    this.layoutColumns = 1;
    this.layoutStride = estimateRowHeight;
    this.renderErrors = new Set();
    this.mountedItems = new Map();
    this.host = document.createElement("div");
    this.host.className = `wg-virtual-collection ${mode === "grid" ? "wg-virtual-grid" : "wg-virtual-list"}`;
    this.window = document.createElement("div");
    this.window.className = mode === "grid" ? "wg-thumb-grid wg-virtual-window" : "wg-virtual-window";
    this.host.appendChild(this.window);
    this.lastStart = -1;
    this.lastEnd = -1;
    this.lastColumns = -1;
    this.updateGeometry();
  }
  hostWidth() {
    // CSS widths retain fractional pixels and are independent of canvas zoom.
    // Existing callers keep their original integer geometry unless opting in.
    const exact = this.cardHeightForWidth && typeof getComputedStyle === "function" ? parseFloat(getComputedStyle(this.host).width) : 0;
    return Math.max(1, exact || this.host.clientWidth || this.scrollRoot?.clientWidth || 300);
  }
  viewportScale(rect = this.scrollRoot?.getBoundingClientRect?.()) {
    // Canvas nodes can be transformed by zoom. Scroll offsets and row strides
    // use local CSS pixels; viewport rectangles must be converted before mixing.
    const height = this.scrollRoot?.offsetHeight;
    return height > 0 && rect?.height > 0 ? rect.height / height : 1;
  }
  columns() {
    if (this.mode !== "grid") return 1;
    if (Number.isInteger(this.columnCount) && this.columnCount > 0) return this.columnCount;
    const width = this.hostWidth();
    const available = Math.max(1, width - (this.inlinePadding ?? (this.fixedCardWidth ? 2 : 0)));
    return Math.max(1, Math.floor((available + this.gap) / (this.minCardWidth + this.gap)));
  }
  effectiveCardHeight(columns = this.columns()) {
    if (this.mode !== "grid") return this.estimateCardHeight;
    const width = this.hostWidth();
    const gap = this.gap;
    const cardWidth = this.fixedCardWidth
      ? (this.columnCount ? this.minCardWidth : Math.min(this.minCardWidth, Math.max(1, width - (this.inlinePadding ?? 2))))
      : Math.max(1, (width - Math.max(0, columns - 1) * gap) / Math.max(1, columns));
    if (this.cardHeightForWidth) return this.cardHeightForWidth(cardWidth);
    // Preserve the caller’s label/border/gap allowance while deriving the image
    // height from its frame ratio. Existing callers retain square geometry.
    const labelAllowance = Math.max(this.styleDeclaration ? 0 : 24, this.estimateCardHeight - this.minCardWidth / this.imageAspectRatio);
    const stride = cardWidth / this.imageAspectRatio + labelAllowance;
    return this.fixedCardWidth ? stride : Math.ceil(stride / this.strideGrid) * this.strideGrid;
  }
  totalHeight(columns = this.columns()) {
    return this.mode === "grid"
      ? Math.ceil(this.items.length / columns) * this.effectiveCardHeight(columns)
      : this.items.length * this.estimateRowHeight;
  }
  updateGeometry() {
    if (["masonry", "filmstrip"].includes(this.mode)) return;
    const columns = this.columns();
    const windowStyle = this.styleDeclaration?.(this.window) || this.window.style;
    const hostStyle = this.styleDeclaration?.(this.host) || this.host.style;
    windowStyle.setProperty("--pp-virtual-columns", columns);
    windowStyle.setProperty("--pp-virtual-card-height", `${this.effectiveCardHeight(columns)}px`);
    hostStyle.setProperty("height", `${Math.max(0, this.totalHeight(columns))}px`);
    hostStyle.setProperty("position", "relative");
    for (const [key, value] of Object.entries({ position: "absolute", left: "0", right: "0", top: "0" })) windowStyle.setProperty(key, value);
  }
  visibleRange() {
    const rootRect = this.scrollRoot?.getBoundingClientRect?.();
    const hostRect = this.host.getBoundingClientRect?.();
    const columns = this.columns();
    if (!rootRect || !hostRect) return [0, Math.min(this.items.length, 40), columns];
    if (hostRect.bottom < rootRect.top || hostRect.top > rootRect.bottom) return [0, 0, columns];
    const scale = this.viewportScale(rootRect);
    const top = Math.max(0, (rootRect.top - hostRect.top) / scale);
    const bottom = Math.min(hostRect.height / scale || this.totalHeight(columns), Math.max(top, (rootRect.bottom - hostRect.top) / scale));
    if (this.mode === "grid") {
      const cardHeight = this.effectiveCardHeight(columns);
      const startRow = Math.max(0, Math.floor(top / cardHeight) - this.overscan);
      const endRow = Math.min(Math.ceil(this.items.length / columns), Math.ceil(bottom / cardHeight) + this.overscan);
      return [startRow * columns, Math.min(this.items.length, endRow * columns), columns];
    }
    const start = Math.max(0, Math.floor(top / this.estimateRowHeight) - this.overscan * 2);
    const end = Math.min(this.items.length, Math.ceil(bottom / this.estimateRowHeight) + this.overscan * 2);
    return [start, end, columns];
  }
  fallbackItem(item, index, error) {
    const row = document.createElement("div");
    row.className = "wg-item wg-virtual-fallback";
    const path = String(item?.path || item?.name || `item-${index}`);
    if (item?.path) row.dataset.path = item.path;
    row.textContent = path.split("/").pop() || path;
    row.title = path;
    const signature = `${error?.name || "Error"}:${error?.message || String(error)}`;
    if (!this.renderErrors.has(signature)) {
      this.renderErrors.add(signature);
      console.error("Prompt Palette: library item render failed; using safe fallback", error);
    }
    return row;
  }
  render() {
    if (!this.host.isConnected) return 0;
    if (["masonry", "filmstrip"].includes(this.mode)) return renderVisualCollection(this);
    const width = this.cardHeightForWidth ? this.hostWidth() : this.host.clientWidth;
    let anchor = null;
    if (this.preserveViewport && this.layoutWidth && width !== this.layoutWidth) {
      const top = (this.scrollRoot.getBoundingClientRect().top - this.host.getBoundingClientRect().top) / this.viewportScale();
      if (top >= 0) anchor = { index: Math.floor(top / this.layoutStride) * this.layoutColumns, fraction: (top % this.layoutStride) / this.layoutStride };
    }
    this.updateGeometry();
    this.layoutWidth = width;
    this.layoutColumns = this.columns();
    this.layoutStride = this.mode === "grid" ? this.effectiveCardHeight(this.layoutColumns) : this.estimateRowHeight;
    if (anchor) {
      const top = (this.host.getBoundingClientRect().top - this.scrollRoot.getBoundingClientRect().top) / this.viewportScale();
      this.scrollRoot.scrollTop += top + (Math.floor(anchor.index / this.layoutColumns) + anchor.fraction) * this.layoutStride;
    }
    const [start, end, columns] = this.visibleRange();
    const offset = this.mode === "grid" ? Math.floor(start / columns) * this.effectiveCardHeight(columns) : start * this.estimateRowHeight;
    const windowStyle = this.styleDeclaration?.(this.window) || this.window.style;
    windowStyle.setProperty("transform", this.styleDeclaration ? `translate3d(0, ${offset}px, 0)` : `translateY(${offset}px)`);
    if (start === this.lastStart && end === this.lastEnd && columns === this.lastColumns) return Math.max(0, end - start);
    this.lastStart = start;
    this.lastEnd = end;
    this.lastColumns = columns;
    const focus = this.captureFocus?.();
    // Retain overlapping rows in place: scrolling should not reload thumbnails
    // or detach the focused button. Cache only the current virtual window.
    for (const [index, element] of this.mountedItems) {
      if (index < start || index >= end) { element.remove(); this.mountedItems.delete(index); }
    }
    const retained = new Set(this.mountedItems.values());
    for (const element of [...this.window.children]) {
      if (!retained.has(element)) element.remove();
    }
    let cursor = this.window.firstChild;
    for (let index = start; index < end; index++) {
      const item = this.items[index];
      let element = this.mountedItems.get(index);
      if (!element) {
        try {
          element = this.renderItem(item, index);
          if (!element || typeof element.nodeType !== "number") throw new TypeError("library renderer did not return a DOM node");
        } catch (error) {
          element = this.fallbackItem(item, index, error);
        }
      }
      this.mountedItems.set(index, element);
      if (element !== cursor) this.window.insertBefore(element, cursor);
      cursor = element.nextSibling;
    }

    this.restoreFocus?.(focus);
    this.onVisibleCount?.(end - start);
    return Math.max(0, end - start);
  }
  schedule() { this.requestRender?.(); }
  updateLayout(options = {}) {
    const modeChanged = options.mode != null && options.mode !== this.mode;
    for (const key of ["mode", "estimateRowHeight", "estimateCardHeight", "minCardWidth", "imageAspectRatio", "fixedCardWidth", "columnCount", "inlinePadding", "cardHeightForWidth", "gap", "strideGrid"]) {
      if (options[key] != null) this[key] = options[key];
    }
    if (modeChanged) {
      resetVisualCollection(this);
      // Sidebars store geometry in CSSOM rules, while node drawers use inline
      // declarations. Clear the actual owner before returning from a visual
      // mode, or its display:block overrides the gallery's grid tracks.
      (this.styleDeclaration?.(this.host) || this.host.style).cssText = "";
      (this.styleDeclaration?.(this.window) || this.window.style).cssText = "";
      this.host.className = `wg-virtual-collection ${this.mode === "grid" ? "wg-virtual-grid" : "wg-virtual-list"}`;
      this.window.className = this.mode === "grid" ? "wg-thumb-grid wg-virtual-window" : "wg-virtual-window";
      this.invalidateItems();
    }
    this.updateGeometry();
    this.schedule();
  }
  invalidateItems() {
    resetVisualCollection(this);
    this.mountedItems.clear();
    this.lastStart = this.lastEnd = this.lastColumns = -1;
  }
  setItems(items) {
    this.items = Array.isArray(items) ? items : [];
    this.invalidateItems();
    this.updateGeometry();
    this.schedule();
  }
  cleanup() {
    resetVisualCollection(this);
    this.mountedItems.clear();
    this.onVisibleCount?.(0);
    this.releaseStyle?.(this.window);
    this.releaseStyle?.(this.host);
    this.host.remove();
  }
}

export class VirtualCollectionManager {
  constructor(scrollRoot, { onVisibleCount = null } = {}) {
    this.scrollRoot = scrollRoot;
    this.collections = new Set();
    this.onVisibleCount = onVisibleCount;
    this.visibleByCollection = new Map();
    this.frame = 0;
    this.boundSchedule = () => this.schedule();
    this.scrollRoot?.addEventListener?.("scroll", this.boundSchedule, { passive: true });
    this.resizeObserver = typeof ResizeObserver !== "undefined" ? new ResizeObserver(this.boundSchedule) : null;
  }
  mount(container, options) {
    let collection = null;
    collection = new VirtualCollection({
      ...options,
      scrollRoot: this.scrollRoot,
      requestRender: () => this.schedule(),
      onVisibleCount: (count) => {
        this.visibleByCollection.set(collection, count);
        this.onVisibleCount?.(Array.from(this.visibleByCollection.values()).reduce((a, b) => a + b, 0));
      },
    });
    this.collections.add(collection);
    container.appendChild(collection.host);
    this.resizeObserver?.observe(collection.host);
    // Paint the currently visible window immediately. The scheduled pass still
    // handles geometry changes after the rest of the library tree is mounted.
    try { collection.render(); } catch (error) { console.error("Prompt Palette: virtual library render failed", error); }
    this.schedule();
    return collection;
  }
  schedule() {
    if (this.frame) return;
    this.frame = frame(() => {
      this.frame = 0;
      for (const collection of this.collections) {
        try { collection.render(); } catch (error) { console.error("Prompt Palette: virtual library render failed", error); }
      }
    });
  }
  // Keep the logical item near the top when density/columns change.
  captureViewportAnchor(itemSpan = 1) {
    const collection = this.collections.values().next().value;
    if (!collection || ["masonry", "filmstrip"].includes(collection.mode)) return null;
    const root = this.scrollRoot.getBoundingClientRect(), host = collection.host.getBoundingClientRect();
    const top = (root.top - host.top) / collection.viewportScale(root);
    if (top < 0) return null;
    const columns = collection.preserveViewport && collection.layoutWidth ? collection.layoutColumns : collection.columns();
    const stride = collection.preserveViewport && collection.layoutWidth ? collection.layoutStride : collection.mode === "grid" ? collection.effectiveCardHeight(columns) : collection.estimateRowHeight;
    return { index: Math.floor(top / stride) * columns * itemSpan, fraction: (top % stride) / stride };
  }
  restoreViewportAnchor(anchor, itemSpan = 1) {
    const collection = this.collections.values().next().value;
    if (!anchor || !collection || ["masonry", "filmstrip"].includes(collection.mode)) return;
    const root = this.scrollRoot.getBoundingClientRect(), host = collection.host.getBoundingClientRect();
    const columns = collection.columns(), stride = collection.mode === "grid" ? collection.effectiveCardHeight(columns) : collection.estimateRowHeight;
    const row = Math.floor(anchor.index / itemSpan / columns);
    this.scrollRoot.scrollTop += (host.top - root.top) / collection.viewportScale(root) + (row + anchor.fraction) * stride;
    // The caller has already restored the old logical item into the new layout.
    // Mark that geometry current so render() does not apply a second anchor.
    collection.layoutWidth = collection.cardHeightForWidth ? collection.hostWidth() : collection.host.clientWidth;
    collection.layoutColumns = columns;
    collection.layoutStride = stride;
    this.schedule();
  }
  refresh() { this.schedule(); }
  clear() {
    cancelFrame(this.frame);
    this.frame = 0;
    for (const collection of this.collections) {
      this.resizeObserver?.unobserve?.(collection.host);
      collection.cleanup();
    }
    this.collections.clear();
    this.visibleByCollection.clear();
    this.onVisibleCount?.(0);
  }
  cleanup() {
    this.clear();
    this.scrollRoot?.removeEventListener?.("scroll", this.boundSchedule);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
  }
}
