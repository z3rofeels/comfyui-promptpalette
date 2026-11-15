// Optional presentations for the existing collection manager. Item renderers
// retain ownership of insert/edit/pin/context actions; navigation never inserts.
const states = new WeakMap();
const label = item => String(item?.name || item?.path || item?.tag || "Entry");
function style(c, element, values) {
  const declaration = c.styleDeclaration?.(element) || element.style;
  for (const [key, value] of Object.entries(values)) declaration.setProperty(key, String(value));
}
function dispose(c, s, index) {
  const node = s.nodes.get(index);
  if (node) { c.releaseStyle?.(node); node.remove(); s.nodes.delete(index); }
}
export function resetVisualCollection(c) {
  const s = states.get(c);
  if (!s) return;
  s.disposed = true;
  for (const index of s.nodes.keys()) dispose(c, s, index);
  c.window.replaceChildren();
  c.host.classList.remove("pp-visual-collection", "pp-view-masonry", "pp-view-filmstrip");
  states.delete(c);
}
function state(c) {
  let s = states.get(c);
  if (s) return s;
  c.window.replaceChildren(); c.mountedItems.clear();
  s = { nodes: new Map(), heights: new Map(), width: 0, dirty: true, positions: [], selected: 0, disposed: false };
  const remembered = c.items.findIndex(item => (item?.path || item?.tag || item?.name) === c.visualSelectionKey);
  if (remembered >= 0) s.selected = remembered;
  states.set(c, s);
  c.host.classList.add("pp-visual-collection", `pp-view-${c.mode}`);
  style(c, c.host, { position: "relative", height: "auto", "min-width": "0" });
  style(c, c.window, { position: "relative", transform: "none", display: "block", width: "100%", height: "auto" });
  return s;
}
function itemNode(c, s, index) {
  let node = s.nodes.get(index);
  if (node) return node;
  try { node = c.renderItem(c.items[index], index); }
  catch (error) { node = c.fallbackItem(c.items[index], index, error); }
  node.classList.add("pp-visual-card");
  s.nodes.set(index, node);
  for (const img of node.querySelectorAll("img")) {
    const loaded = () => {
      if (s.disposed || s.nodes.get(index) !== node) return;
      if (img.naturalWidth && img.naturalHeight) {
        style(c, node, { "--pp-natural-ratio": img.naturalWidth / img.naturalHeight });
        node.classList.add("pp-media-loaded");
      }
      s.dirty = true; c.schedule();
    };
    img.addEventListener("load", loaded, { once: true });
    img.addEventListener("error", () => {
      if (s.disposed || s.nodes.get(index) !== node) return;
      node.classList.add("pp-media-broken");
      img.hidden = true;
      const fallback = node.querySelector(".wg-thumb-fallback");
      if (fallback) { fallback.hidden = false; fallback.title = "Preview unavailable — change thumbnail from the context menu"; }
      s.dirty = true; c.schedule();
    }, { once: true });
    if (img.complete && img.naturalWidth) loaded();
  }
  return node;
}
// Positions are rebuilt only on resize or changed image dimensions, never on
// every scroll. Per-column binary search bounds the mounted viewport.
export function packMasonry(count, columns, width, gap, heights, estimate) {
  const bottoms = Array(columns).fill(0), lanes = Array.from({ length: columns }, () => []), positions = [];
  for (let index = 0; index < count; index++) {
    let column = 0;
    for (let k = 1; k < columns; k++) if (bottoms[k] < bottoms[column]) column = k;
    const height = heights.get(index) || estimate;
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
function masonry(c, s) {
  const available = c.hostWidth(), gap = c.gap || 8;
  const columns = Math.max(1, Math.min(c.items.length || 1, c.columnCount || Math.floor((available + gap) / (Math.max(32, c.minCardWidth) + gap))));
  const width = Math.max(1, (available - (columns - 1) * gap) / columns);
  if (s.width !== width) { s.width = width; s.heights.clear(); s.dirty = true; }
  if (s.columns !== columns || s.gap !== gap) { s.columns = columns; s.gap = gap; s.dirty = true; }
  if (s.dirty) {
    s.packed = packMasonry(c.items.length, columns, width, gap, s.heights, width + 62);
    s.dirty = false;
    style(c, c.window, { height: `${s.packed.height}px` });
  }
  const root = c.scrollRoot.getBoundingClientRect(), host = c.host.getBoundingClientRect();
  const scale = c.viewportScale(root);
  const top = (root.top - host.top) / scale, bottom = top + root.height / scale;
  const indices = visibleMasonry(s.packed.lanes, top - 300, bottom + 300);
  const keep = new Set(indices);
  for (const index of s.nodes.keys()) if (!keep.has(index)) dispose(c, s, index);
  const focus = c.captureFocus?.();
  let cursor = c.window.firstChild;
  for (const index of indices) {
    const node = itemNode(c, s, index), pos = s.packed.positions[index];
    style(c, node, { position: "absolute", width: `${width}px`, left: `${pos.x}px`, top: `${pos.y}px`, height: "auto" });
    if (node !== cursor) c.window.insertBefore(node, cursor);
    cursor = node.nextSibling;
  }
  // Read after writes. Natural image ratios and real caption/action heights
  // supply geometry, so themes and font scaling don't overlap following cards.
  for (const index of indices) {
    const height = s.nodes.get(index).offsetHeight;
    if (height > 0 && s.heights.get(index) !== height) { s.heights.set(index, height); s.dirty = true; }
  }
  c.restoreFocus?.(focus);
  if (s.dirty) c.schedule();
  c.onVisibleCount?.(indices.length);
  return indices.length;
}
function filmstrip(c, s) {
  if (!c.items.length) { c.window.replaceChildren(); return 0; }
  if (!s.detail) {
    s.toolbar = document.createElement("div"); s.toolbar.className = "pp-film-toolbar";
    s.status = document.createElement("span"); s.status.setAttribute("aria-live", "polite");
    const previous = document.createElement("button"), next = document.createElement("button");
    previous.type = next.type = "button"; previous.textContent = "‹"; next.textContent = "›";
    previous.setAttribute("aria-label", "Previous preview"); next.setAttribute("aria-label", "Next preview");
    s.previous = previous; s.next = next;
    const select = index => { s.selected = Math.max(0, Math.min(c.items.length - 1, index)); const item = c.items[s.selected]; c.visualSelectionKey = item?.path || item?.tag || item?.name; s.paint = -1; filmstrip(c, s); };
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
  if (s.paint === s.selected) return s.nodes.size;
  const selected = s.selected;
  for (const index of s.nodes.keys()) if (index !== selected) dispose(c, s, index);
  s.detail.replaceChildren(itemNode(c, s, selected));
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
    if (c.renderThumbnail) c.renderThumbnail(c.items[index], button);
    else {
      const sample = index === selected ? s.nodes.get(index) : itemNode(c, s, index);
      const source = sample.querySelector("img");
      if (source) { const img = source.cloneNode(false); img.removeAttribute("id"); img.alt = ""; img.loading = "lazy"; img.addEventListener("error", () => img.remove(), { once: true }); button.append(img); }
    }
    const caption = document.createElement("span"); caption.textContent = label(c.items[index]); button.append(caption);
    button.addEventListener("click", e => { e.stopPropagation(); s.select(index); s.strip.focus({ preventScroll: true }); });
    s.strip.append(button);
    if (index !== selected) dispose(c, s, index);
  }
  s.paint = selected;
  c.onVisibleCount?.(1);
  return 1;
}
export function renderVisualCollection(c) {
  const s = state(c);
  return c.mode === "masonry" ? masonry(c, s) : filmstrip(c, s);
}
