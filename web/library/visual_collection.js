// Optional presentations for the existing collection manager. Item renderers
// retain ownership of insert/edit/pin/context actions; navigation never inserts.
const states = new WeakMap();
const label = item => String(item?.name || item?.path || item?.tag || "Entry");

export function clampAspectRatio(width, height, min = 0.35, max = 2.8) {
  const w = Number(width), h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  const raw = w / h;
  if (!Number.isFinite(raw) || raw <= 0) return null;
  return Math.max(min, Math.min(max, raw));
}

function itemKeyFor(c, item, index) {
  if (typeof c.itemKey === "function") {
    const key = c.itemKey(item, index);
    if (key != null && key !== "") return key;
  }
  return item?.path || (item?.id != null && item.id !== "" ? item.id : "") || item?.tag || item?.name || index;
}

function initialItemRatio(c, item) {
  if (typeof c.getItemRatio === "function") {
    const raw = c.getItemRatio(item);
    if (raw && typeof raw === "object") return clampAspectRatio(raw.width, raw.height);
    return clampAspectRatio(raw, 1);
  }
  return clampAspectRatio(item?.preview_width ?? item?.width, item?.preview_height ?? item?.height);
}

function style(c, element, values) {
  const declaration = c.styleDeclaration?.(element) || element.style;
  for (const [key, value] of Object.entries(values)) declaration.setProperty(key, String(value));
}

function disposeNode(c, s, node) {
  if (!node) return;
  s.activeNodes.delete(node);
  s.nodeKeys.delete(node);
  c.releaseStyle?.(node);
  node.remove();
}

function dispose(c, s, index) {
  const node = s.nodes.get(index);
  if (!node) return;
  s.nodes.delete(index);
  disposeNode(c, s, node);
}

export function resetVisualCollection(c) {
  const s = states.get(c);
  if (!s) return;
  s.disposed = true;
  for (const node of s.nodes.values()) disposeNode(c, s, node);
  s.nodes.clear();
  c.window.replaceChildren();
  c.host.classList.remove("pp-visual-collection", "pp-view-masonry", "pp-view-filmstrip");
  states.delete(c);
  c.onVisibleCount?.(0);
}

function state(c) {
  let s = states.get(c);
  if (s) return s;
  c.window.replaceChildren(); c.mountedItems.clear();
  s = {
    nodes: new Map(),
    activeNodes: new WeakSet(),
    nodeKeys: new WeakMap(),
    heights: new Map(),
    ratios: new Map(),
    width: 0,
    dirty: true,
    packed: null,
    selected: 0,
    disposed: false,
  };
  const remembered = c.visualSelectionKey != null
    ? c.items.findIndex((item, i) => itemKeyFor(c, item, i) === c.visualSelectionKey)
    : -1;
  if (remembered >= 0) s.selected = remembered;
  states.set(c, s);
  c.host.classList.add("pp-visual-collection", `pp-view-${c.mode}`);
  style(c, c.host, { position: "relative", height: "auto", "min-width": "0" });
  style(c, c.window, { position: "relative", transform: "none", display: "block", width: "100%", height: "auto" });
  return s;
}

function resolveCardNode(s, node) {
  if (!node) return null;
  if (s.nodeKeys.has(node)) return node;
  return node.closest?.(".pp-visual-card") || null;
}

export function reportVisualMediaDimensions(c, node, width, height) {
  const s = states.get(c);
  if (!s || s.disposed) return null;
  const card = resolveCardNode(s, node);
  if (!card || !s.activeNodes.has(card)) return null;
  const ratio = clampAspectRatio(width, height);
  if (ratio == null) return null;
  const key = s.nodeKeys.get(card);
  const prev = key !== undefined ? s.ratios.get(key) : undefined;
  if (key !== undefined) s.ratios.set(key, ratio);
  style(c, card, { "--pp-natural-ratio": ratio });
  card.classList.add("pp-media-loaded");
  card.classList.remove("pp-media-broken");
  if (c.mode === "masonry" && (prev == null || Math.abs(prev - ratio) > 0.005)) {
    if (key !== undefined) s.heights.delete(key);
    s.dirty = true;
    c.schedule?.();
  }
  return ratio;
}

export function reportVisualMediaError(c, node) {
  const s = states.get(c);
  if (!s || s.disposed) return;
  const card = resolveCardNode(s, node);
  if (!card || !s.activeNodes.has(card)) return;
  const key = s.nodeKeys.get(card);
  card.classList.add("pp-media-broken");
  card.classList.remove("pp-media-loaded");
  if (key !== undefined && !s.ratios.has(key)) {
    s.ratios.set(key, 1);
    style(c, card, { "--pp-natural-ratio": 1 });
  }
  if (c.mode === "masonry") {
    if (key !== undefined) s.heights.delete(key);
    s.dirty = true;
    c.schedule?.();
  }
}

function syncReadyMedia(c, s, node) {
  if (!node || s.disposed || !s.activeNodes.has(node)) return;
  for (const img of node.querySelectorAll("img")) {
    if (img.complete && img.naturalWidth && img.naturalHeight) {
      reportVisualMediaDimensions(c, node, img.naturalWidth, img.naturalHeight);
      return;
    }
  }
  for (const video of node.querySelectorAll("video")) {
    if (video.readyState >= 1 && video.videoWidth && video.videoHeight) {
      reportVisualMediaDimensions(c, node, video.videoWidth, video.videoHeight);
      return;
    }
  }
}

function itemNode(c, s, index) {
  let node = s.nodes.get(index);
  if (node) return node;
  const item = c.items[index];
  const key = itemKeyFor(c, item, index);
  try { node = c.renderItem(item, index); }
  catch (error) { node = c.fallbackItem(item, index, error); }
  node.classList.add("pp-visual-card");
  s.nodes.set(index, node);
  s.activeNodes.add(node);
  s.nodeKeys.set(node, key);
  const initialRatio = s.ratios.get(key) ?? initialItemRatio(c, item);
  if (initialRatio != null && !s.ratios.has(key)) s.ratios.set(key, initialRatio);

  for (const img of node.querySelectorAll("img")) {
    const loaded = () => {
      if (s.disposed || !s.activeNodes.has(node)) return;
      if (img.naturalWidth && img.naturalHeight) {
        reportVisualMediaDimensions(c, node, img.naturalWidth, img.naturalHeight);
      } else {
        s.dirty = true; c.schedule?.();
      }
    };
    img.addEventListener("load", loaded, { once: true });
    img.addEventListener("error", () => {
      if (s.disposed || !s.activeNodes.has(node)) return;
      img.hidden = true;
      const fallback = node.querySelector(".wg-thumb-fallback");
      if (fallback) { fallback.hidden = false; fallback.title = "Preview unavailable — change thumbnail from the context menu"; }
      reportVisualMediaError(c, node);
    }, { once: true });
  }

  for (const video of node.querySelectorAll("video")) {
    const loaded = () => {
      if (s.disposed || !s.activeNodes.has(node)) return;
      if (video.videoWidth && video.videoHeight) {
        reportVisualMediaDimensions(c, node, video.videoWidth, video.videoHeight);
      }
    };
    video.addEventListener("loadedmetadata", loaded, { once: true });
    video.addEventListener("error", () => {
      if (s.disposed || !s.activeNodes.has(node)) return;
      reportVisualMediaError(c, node);
    }, { once: true });
  }

  return node;
}

// Positions are rebuilt only on resize or changed image dimensions, never on
// every scroll. Per-column binary search bounds the mounted viewport.
export function packMasonry(count, columns, width, gap, heights, estimate) {
  const bottoms = Array(columns).fill(0), lanes = Array.from({ length: columns }, () => []), positions = [];
  const readHeight = typeof heights === "function" ? heights : index => heights?.get?.(index);
  const readEstimate = typeof estimate === "function" ? estimate : () => estimate;
  for (let index = 0; index < count; index++) {
    let column = 0;
    for (let k = 1; k < columns; k++) if (bottoms[k] < bottoms[column]) column = k;
    const height = readHeight(index) || readEstimate(index);
    const position = { index, x: column * (width + gap), y: bottoms[column], height };
    positions.push(position); lanes[column].push(position); bottoms[column] += height + gap;
  }
  return { positions, lanes, height: Math.max(0, ...bottoms) };
}

export function visibleMasonry(lanes, top, bottom) {
  const indices = [];
  for (const lane of lanes) {
    let lo = 0, hi = lane.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (lane[mid].y + lane[mid].height < top) lo = mid + 1; else hi = mid; }
    for (let i = lo; i < lane.length && lane[i].y <= bottom; i++) indices.push(lane[i].index);
  }
  return indices.sort((a, b) => a - b);
}

function computeMasonryLayout(c, s) {
  const available = c.hostWidth(), gap = c.gap ?? 8;
  const columns = Math.max(1, c.columnCount || Math.floor((available + gap) / (Math.max(32, c.minCardWidth) + gap)));
  const width = (c.fixedCardWidth && !c.columnCount)
    ? Math.max(1, Math.min(c.minCardWidth, available))
    : Math.max(1, (available - (columns - 1) * gap) / columns);
  if (s.width !== width) { s.width = width; s.heights.clear(); s.dirty = true; }
  if (s.columns !== columns || s.gap !== gap) { s.columns = columns; s.gap = gap; s.dirty = true; }
  if (s.dirty) {
    const chromeEstimate = Number.isFinite(Number(c.estimateChromeHeight)) ? Number(c.estimateChromeHeight) : 62;
    s.packed = packMasonry(
      c.items.length,
      columns,
      width,
      gap,
      index => s.heights.get(itemKeyFor(c, c.items[index], index)),
      index => {
        const item = c.items[index];
        const key = itemKeyFor(c, item, index);
        let ratio = s.ratios.get(key);
        if (ratio == null) {
          ratio = initialItemRatio(c, item);
          if (ratio != null) s.ratios.set(key, ratio);
        }
        return width / (ratio || 1) + chromeEstimate;
      }
    );
    s.dirty = false;
    style(c, c.window, { height: `${s.packed.height}px` });
  }
  return { width, columns, gap };
}

function masonry(c, s) {
  if (c.isHidden?.()) return 0;
  const hiddenInBrowser = typeof c.host?.getClientRects === "function"
    && c.host.isConnected
    && c.host.getClientRects().length === 0
    && !c.host.clientWidth
    && !c.scrollRoot?.clientWidth
    && ((c.host.ownerDocument?.documentElement?.clientWidth > 0) || (c.host.ownerDocument?.body?.getClientRects?.().length > 0));
  if (hiddenInBrowser) return 0;
  const { width } = computeMasonryLayout(c, s);
  const root = c.scrollRoot?.getBoundingClientRect?.(), host = c.host?.getBoundingClientRect?.();
  const scale = root ? (c.viewportScale?.(root) || 1) : 1;
  const top = root && host ? (root.top - host.top) / scale : 0;
  const bottom = root && host ? top + root.height / scale : s.packed.height;
  const indices = visibleMasonry(s.packed.lanes, top - 300, bottom + 300);
  const keep = new Set(indices);
  const focus = c.captureFocus?.();
  for (const index of s.nodes.keys()) if (!keep.has(index)) dispose(c, s, index);
  let cursor = c.window.firstChild;
  for (const index of indices) {
    const node = itemNode(c, s, index), pos = s.packed.positions[index];
    if (node !== cursor) c.window.insertBefore(node, cursor);
    cursor = node.nextSibling;
    const key = itemKeyFor(c, c.items[index], index);
    const styles = { position: "absolute", width: `${width}px`, left: `${pos.x}px`, top: `${pos.y}px`, height: "auto" };
    const ratio = s.ratios.get(key) ?? initialItemRatio(c, c.items[index]);
    if (ratio != null) styles["--pp-natural-ratio"] = ratio;
    style(c, node, styles);
    if (!node.classList.contains("pp-media-loaded") && !node.classList.contains("pp-media-broken")) {
      syncReadyMedia(c, s, node);
    }
  }
  // Read after writes. Natural image ratios and real caption/action heights
  // supply geometry, so themes and font scaling don't overlap following cards.
  for (const index of indices) {
    const node = s.nodes.get(index);
    const height = node?.offsetHeight || 0;
    const key = itemKeyFor(c, c.items[index], index);
    if (height > 0) {
      const prevHeight = s.heights.get(key) ?? s.packed?.positions?.[index]?.height;
      s.heights.set(key, height);
      if (prevHeight !== height) s.dirty = true;
    }
  }
  c.restoreFocus?.(focus);
  if (s.dirty) c.schedule();
  c.onVisibleCount?.(indices.length);
  return indices.length;
}

function filmstrip(c, s) {
  if (!c.items.length) {
    c.window.replaceChildren();
    s.detail = null;
    s.paint = -1;
    c.onVisibleCount?.(0);
    return 0;
  }
  if (!s.detail) {
    s.toolbar = document.createElement("div"); s.toolbar.className = "pp-film-toolbar";
    s.status = document.createElement("span"); s.status.setAttribute("aria-live", "polite");
    const previous = document.createElement("button"), next = document.createElement("button");
    previous.type = next.type = "button"; previous.textContent = "‹"; next.textContent = "›";
    previous.setAttribute("aria-label", "Previous preview"); next.setAttribute("aria-label", "Next preview");
    s.previous = previous; s.next = next;
    const select = index => {
      s.selected = Math.max(0, Math.min(c.items.length - 1, index));
      const item = c.items[s.selected];
      c.visualSelectionKey = itemKeyFor(c, item, s.selected);
      s.paint = -1;
      filmstrip(c, s);
    };
    previous.addEventListener("click", e => { e.stopPropagation(); select(s.selected - 1); });
    next.addEventListener("click", e => { e.stopPropagation(); select(s.selected + 1); });
    s.toolbar.append(previous, s.status, next);
    s.detail = document.createElement("div"); s.detail.className = "pp-film-detail"; s.detail.title = "Use the card’s usual insert, edit and context actions. Browse previews with the strip below.";
    s.strip = document.createElement("div"); s.strip.className = "pp-film-strip";
    s.strip.tabIndex = 0; s.strip.setAttribute("role", "group"); s.strip.setAttribute("aria-label", "Preview selection. Left and right arrows to browse; Home and End to jump.");
    s.strip.addEventListener("keydown", e => {
      if (e.ctrlKey || e.metaKey || e.altKey || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
      e.preventDefault(); e.stopPropagation();
      select(e.key === "Home" ? 0 : e.key === "End" ? c.items.length - 1 : s.selected + (e.key === "ArrowRight" ? 1 : -1));
      s.strip.focus({ preventScroll: true });
    });
    s.select = select;
    c.window.append(s.toolbar, s.detail, s.strip);
  }
  s.selected = Math.max(0, Math.min(c.items.length - 1, s.selected));
  if (s.paint === s.selected) return s.nodes.size;
  const selected = s.selected;
  for (const index of s.nodes.keys()) if (index !== selected) dispose(c, s, index);
  const detailNode = itemNode(c, s, selected);
  s.detail.replaceChildren(detailNode);
  const selectedKey = itemKeyFor(c, c.items[selected], selected);
  const selectedRatio = s.ratios.get(selectedKey) ?? initialItemRatio(c, c.items[selected]) ?? 1;
  style(c, detailNode, { "--pp-natural-ratio": selectedRatio });
  if (!detailNode.classList.contains("pp-media-loaded") && !detailNode.classList.contains("pp-media-broken")) {
    syncReadyMedia(c, s, detailNode);
  }
  s.status.textContent = `${selected + 1} / ${c.items.length} · ${label(c.items[selected])}`;
  s.status.title = label(c.items[selected]);
  s.previous.disabled = selected === 0; s.next.disabled = selected === c.items.length - 1;
  s.strip.replaceChildren();
  // A sliding strip of nine neighbors bounds DOM and image work even at 50k.
  const start = Math.max(0, Math.min(selected - 4, c.items.length - 9));
  for (let index = start; index < Math.min(c.items.length, start + 9); index++) {
    const button = document.createElement("button"); button.type = "button";
    button.className = "pp-film-neighbor"; button.title = label(c.items[index]);
    button.setAttribute("aria-label", `Preview ${label(c.items[index])}`);
    button.setAttribute("aria-pressed", String(index === selected));
    // Lazy media providers can mount a bounded thumbnail directly into the strip.
    if (c.renderThumbnail) {
      c.renderThumbnail(c.items[index], button, index);
    } else if (typeof c.thumbnailUrl === "function") {
      const url = c.thumbnailUrl(c.items[index], index);
      if (url) {
        const img = document.createElement("img");
        img.src = url;
        img.alt = "";
        img.loading = "lazy";
        img.decoding = "async";
        img.addEventListener("error", () => img.remove(), { once: true });
        button.append(img);
      }
    } else {
      const hadNode = s.nodes.has(index);
      const sample = hadNode ? s.nodes.get(index) : itemNode(c, s, index);
      const source = sample.querySelector("img");
      if (source) {
        const img = source.cloneNode(false);
        img.removeAttribute("id");
        img.alt = "";
        img.loading = "lazy";
        img.addEventListener("error", () => img.remove(), { once: true });
        button.append(img);
      }
      if (!hadNode && index !== selected) dispose(c, s, index);
    }
    const caption = document.createElement("span"); caption.textContent = label(c.items[index]); button.append(caption);
    button.addEventListener("click", e => { e.stopPropagation(); s.select(index); s.strip.focus({ preventScroll: true }); });
    s.strip.append(button);
  }
  const activeNeighbor = s.strip.querySelector('.pp-film-neighbor[aria-pressed="true"]');
  if (activeNeighbor && s.strip.scrollWidth > s.strip.clientWidth) {
    activeNeighbor.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }
  s.paint = selected;
  c.onVisibleCount?.(1);
  return 1;
}

export function updateVisualItems(c, items, { patchNode = null } = {}) {
  const nextItems = Array.isArray(items) ? items : [];
  const s = states.get(c);
  if (!s) {
    c.items = nextItems;
    c.schedule?.();
    return;
  }
  const oldItems = c.items;
  const byKey = new Map();
  for (const [oldIndex, node] of s.nodes) {
    const key = itemKeyFor(c, oldItems[oldIndex], oldIndex);
    if (!byKey.has(key)) byKey.set(key, node);
    else disposeNode(c, s, node);
  }
  s.nodes.clear();
  c.items = nextItems;
  if (byKey.size > 0) {
    for (let i = 0; i < nextItems.length; i++) {
      const item = nextItems[i];
      const key = itemKeyFor(c, item, i);
      const node = byKey.get(key);
      if (!node) continue;
      byKey.delete(key);
      s.nodes.set(i, node);
      s.nodeKeys.set(node, key);
      if (typeof patchNode === "function") patchNode(node, item, i);
      if (byKey.size === 0) break;
    }
    for (const orphan of byKey.values()) disposeNode(c, s, orphan);
  }
  if (c.mode === "filmstrip") {
    if (c.visualSelectionKey != null) {
      const found = nextItems.findIndex((item, i) => itemKeyFor(c, item, i) === c.visualSelectionKey);
      s.selected = found >= 0 ? found : Math.max(0, Math.min(nextItems.length - 1, s.selected));
    } else {
      s.selected = Math.max(0, Math.min(nextItems.length - 1, s.selected));
    }
    s.paint = -1;
  }
  s.dirty = true;
  c.schedule?.();
}

export function captureVisualAnchor(c) {
  const s = states.get(c);
  if (!c || c.mode !== "masonry" || !s?.packed?.positions?.length || !c.scrollRoot || !c.host) return null;
  const root = c.scrollRoot.getBoundingClientRect(), host = c.host.getBoundingClientRect();
  const scale = c.viewportScale?.(root) || 1;
  const top = (root.top - host.top) / scale;
  if (top < 0) return null;
  const visible = visibleMasonry(s.packed.lanes, top, top + 1);
  const firstIndex = visible.length ? visible[0] : s.packed.positions.findIndex(p => p.y + p.height >= top);
  if (firstIndex < 0 || firstIndex >= c.items.length) return null;
  const pos = s.packed.positions[firstIndex];
  return {
    type: "visual",
    key: itemKeyFor(c, c.items[firstIndex], firstIndex),
    index: firstIndex,
    offset: Math.max(0, top - pos.y),
    fraction: pos.height > 0 ? Math.max(0, (top - pos.y) / pos.height) : 0,
  };
}

export function restoreVisualAnchor(c, anchor) {
  if (!c || !anchor || c.mode !== "masonry" || !c.scrollRoot || !c.host) return;
  const s = states.get(c);
  if (!s) return;
  computeMasonryLayout(c, s);
  if (!s.packed?.positions?.length) return;
  let targetIndex = -1;
  if (anchor.key != null) {
    targetIndex = c.items.findIndex((item, i) => itemKeyFor(c, item, i) === anchor.key);
  }
  if (targetIndex < 0 && Number.isInteger(anchor.index)) {
    targetIndex = Math.max(0, Math.min(c.items.length - 1, anchor.index));
  }
  if (targetIndex < 0 || targetIndex >= s.packed.positions.length) return;
  const pos = s.packed.positions[targetIndex];
  const root = c.scrollRoot.getBoundingClientRect(), host = c.host.getBoundingClientRect();
  const scale = c.viewportScale?.(root) || 1;
  const targetTop = pos.y + (anchor.offset ?? 0);
  c.scrollRoot.scrollTop += (host.top - root.top) / scale + targetTop;
}

export function selectVisualIndex(c, index) {
  if (!c || c.mode !== "filmstrip" || !c.items?.length) return -1;
  const s = state(c);
  if (!s.select) filmstrip(c, s);
  s.select?.(index);
  return s.selected;
}

export function visualItemRect(c, index) {
  if (!c || c.mode !== "masonry" || index < 0 || index >= (c.items?.length || 0)) return null;
  const s = state(c);
  if (s.dirty || !s.packed) computeMasonryLayout(c, s);
  return s.packed?.positions?.[index] || null;
}

export function visualNeighborIndex(c, index, direction) {
  if (!c || !c.items?.length) return -1;
  const total = c.items.length;
  const cur = Math.max(0, Math.min(total - 1, index));
  if (c.mode !== "masonry") {
    return (direction === "up" || direction === "left") ? Math.max(0, cur - 1) : Math.min(total - 1, cur + 1);
  }
  const s = state(c);
  if (s.dirty || !s.packed) computeMasonryLayout(c, s);
  const pos = s.packed?.positions?.[cur];
  const lanes = s.packed?.lanes || [];
  if (!pos || !lanes.length) {
    return (direction === "up" || direction === "left") ? Math.max(0, cur - 1) : Math.min(total - 1, cur + 1);
  }
  let laneIndex = -1, slotIndex = -1;
  for (let li = 0; li < lanes.length; li++) {
    const si = lanes[li].findIndex(entry => entry.index === cur);
    if (si >= 0) { laneIndex = li; slotIndex = si; break; }
  }
  if (laneIndex < 0) {
    return (direction === "up" || direction === "left") ? Math.max(0, cur - 1) : Math.min(total - 1, cur + 1);
  }
  if (direction === "up") return slotIndex > 0 ? lanes[laneIndex][slotIndex - 1].index : cur;
  if (direction === "down") return slotIndex + 1 < lanes[laneIndex].length ? lanes[laneIndex][slotIndex + 1].index : cur;
  const targetLaneIndex = direction === "left" ? laneIndex - 1 : laneIndex + 1;
  if (targetLaneIndex >= 0 && targetLaneIndex < lanes.length && lanes[targetLaneIndex].length) {
    const curCenter = pos.y + pos.height / 2;
    let best = lanes[targetLaneIndex][0];
    let bestDist = Infinity;
    for (const candidate of lanes[targetLaneIndex]) {
      const overlap = Math.min(pos.y + pos.height, candidate.y + candidate.height) - Math.max(pos.y, candidate.y);
      const centerDist = Math.abs((candidate.y + candidate.height / 2) - curCenter);
      const dist = overlap > 0 ? centerDist * 0.1 : centerDist;
      if (dist < bestDist) {
        bestDist = dist;
        best = candidate;
      }
    }
    return best.index;
  }
  return direction === "left" ? Math.max(0, cur - 1) : Math.min(total - 1, cur + 1);
}

export function renderVisualCollection(c) {
  const s = state(c);
  return c.mode === "masonry" ? masonry(c, s) : filmstrip(c, s);
}
