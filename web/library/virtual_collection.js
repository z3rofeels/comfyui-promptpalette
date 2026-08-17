function frame(callback) {
  const raf = globalThis.requestAnimationFrame;
  return typeof raf === "function" ? raf(callback) : setTimeout(callback, 0);
}
function cancelFrame(handle) {
  if (!handle) return;
  if (typeof globalThis.cancelAnimationFrame === "function") globalThis.cancelAnimationFrame(handle); else clearTimeout(handle);
}

export class VirtualCollection {
  constructor({ scrollRoot, items = [], renderItem, mode = "list", estimateRowHeight = 32, estimateCardHeight = 132, minCardWidth = 88, overscan = 2, onVisibleCount = null, requestRender = null } = {}) {
    this.scrollRoot = scrollRoot;
    this.items = Array.isArray(items) ? items : [];
    this.renderItem = renderItem;
    this.mode = mode;
    this.estimateRowHeight = estimateRowHeight;
    this.estimateCardHeight = estimateCardHeight;
    this.minCardWidth = minCardWidth;
    this.overscan = overscan;
    this.onVisibleCount = onVisibleCount;
    this.requestRender = requestRender;
    this.renderErrors = new Set();
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
  columns() {
    if (this.mode !== "grid") return 1;
    const width = Math.max(1, this.host.clientWidth || this.scrollRoot?.clientWidth || 300);
    return Math.max(1, Math.floor((width + 6) / (this.minCardWidth + 6)));
  }
  effectiveCardHeight(columns = this.columns()) {
    if (this.mode !== "grid") return this.estimateCardHeight;
    const width = Math.max(1, this.host.clientWidth || this.scrollRoot?.clientWidth || 300);
    const gap = 6;
    const cardWidth = Math.max(1, (width - Math.max(0, columns - 1) * gap) / Math.max(1, columns));
    // The image is square. Preserve the density-specific label allowance that
    // estimateCardHeight carried, but derive the image portion from the actual
    // current grid width so resizing cannot leave a stale spacer height.
    const labelAllowance = Math.max(24, this.estimateCardHeight - this.minCardWidth);
    return Math.ceil(cardWidth + labelAllowance);
  }
  totalHeight(columns = this.columns()) {
    return this.mode === "grid"
      ? Math.ceil(this.items.length / columns) * this.effectiveCardHeight(columns)
      : this.items.length * this.estimateRowHeight;
  }
  updateGeometry() {
    const columns = this.columns();
    this.host.style.height = `${Math.max(0, this.totalHeight(columns))}px`;
    this.host.style.position = "relative";
    this.window.style.position = "absolute";
    this.window.style.left = "0";
    this.window.style.right = "0";
    this.window.style.top = "0";
  }
  visibleRange() {
    const rootRect = this.scrollRoot?.getBoundingClientRect?.();
    const hostRect = this.host.getBoundingClientRect?.();
    const columns = this.columns();
    if (!rootRect || !hostRect) return [0, Math.min(this.items.length, 40), columns];
    if (hostRect.bottom < rootRect.top || hostRect.top > rootRect.bottom) return [0, 0, columns];
    const top = Math.max(0, rootRect.top - hostRect.top);
    const bottom = Math.min(hostRect.height || this.totalHeight(columns), Math.max(top, rootRect.bottom - hostRect.top));
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
    this.updateGeometry();
    const [start, end, columns] = this.visibleRange();
    if (start === this.lastStart && end === this.lastEnd && columns === this.lastColumns) return Math.max(0, end - start);
    this.lastStart = start;
    this.lastEnd = end;
    this.lastColumns = columns;
    const fragment = document.createDocumentFragment();
    for (let index = start; index < end; index++) {
      const item = this.items[index];
      let element;
      try {
        element = this.renderItem(item, index);
        if (!element || typeof element.nodeType !== "number") throw new TypeError("library renderer did not return a DOM node");
      } catch (error) {
        element = this.fallbackItem(item, index, error);
      }
      fragment.appendChild(element);
    }
    this.window.replaceChildren(fragment);
    if (this.mode === "grid") {
      const row = Math.floor(start / columns);
      this.window.style.transform = `translateY(${row * this.effectiveCardHeight(columns)}px)`;
    } else this.window.style.transform = `translateY(${start * this.estimateRowHeight}px)`;
    this.onVisibleCount?.(end - start);
    return Math.max(0, end - start);
  }
  schedule() { this.requestRender?.(); }
  setItems(items) {
    this.items = Array.isArray(items) ? items : [];
    this.lastStart = this.lastEnd = this.lastColumns = -1;
    this.updateGeometry();
    this.schedule();
  }
  cleanup() {
    this.onVisibleCount?.(0);
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
