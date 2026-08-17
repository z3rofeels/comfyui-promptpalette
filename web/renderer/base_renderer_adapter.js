export const IO_SLOT_HEIGHT = 20;
export const IO_RAIL_GAP = 6;
export const HIDDEN_SOCKET_LABEL = "\u200B";

export function frame(callback) {
  const raf = globalThis.requestAnimationFrame;
  return typeof raf === "function" ? raf(callback) : setTimeout(callback, 0);
}

export function cancelFrame(handle) {
  if (!handle) return;
  if (typeof globalThis.cancelAnimationFrame === "function") globalThis.cancelAnimationFrame(handle);
  else clearTimeout(handle);
}

export function nodeActive(node) {
  return !!node && !node?._ppLifecycle?.signal?.aborted;
}

export function socketConnected(kind, slot) {
  return kind === "input" ? slot?.link != null : Number(slot?.links?.length) > 0;
}

export function socketVisible(kind, slot) {
  return !!slot && (!slot.ppHidden || socketConnected(kind, slot));
}

export function ioSocketIndex(list, name) {
  return (list || []).findIndex((slot) => slot?.name === name);
}

export function ensureSchemaSocket(node, kind, def) {
  const list = kind === "input" ? node?.inputs : node?.outputs;
  const matches = (list || []).filter((slot) => slot?.name === def.key);
  const existing = matches.find((slot) => socketConnected(kind, slot)) || matches[0] || null;
  if (existing) return existing;
  let index = -1;
  if (kind === "input" && typeof node?.addInput === "function") node.addInput(def.key, def.type);
  else if (kind === "output" && typeof node?.addOutput === "function") node.addOutput(def.key, def.type);
  const updated = kind === "input" ? node?.inputs : node?.outputs;
  index = ioSocketIndex(updated, def.key);
  return index === -1 ? null : updated[index];
}

export function rememberSocketState(slot) {
  if (!slot || slot.__ppSocketRailState) return;
  slot.__ppSocketRailState = {
    label: slot.label,
    localized_name: slot.localized_name,
    pos: Array.isArray(slot.pos) ? [...slot.pos] : slot.pos,
    color_on: slot.color_on,
    color_off: slot.color_off,
  };
}

export function restoreSocketState(slot) {
  const original = slot?.__ppSocketRailState;
  if (!slot || !original) return;
  slot.label = original.label;
  slot.localized_name = original.localized_name;
  slot.pos = Array.isArray(original.pos) ? [...original.pos] : original.pos;
  slot.color_on = original.color_on;
  slot.color_off = original.color_off;
  delete slot.ppHidden;
  delete slot.__ppSocketRailState;
  delete slot.__ppSocketRailTitle;
}

export function socketDisplayLabel(slot, defs) {
  const def = (defs || []).find((candidate) => candidate.key === slot?.name);
  return def?.label || slot?.__ppSocketRailState?.label || slot?.label || slot?.name || "Socket";
}

export function orderedSockets(list, defs, predicate = () => true) {
  const result = [];
  const seen = new Set();
  for (const def of defs || []) {
    const slot = (list || []).find((candidate) => candidate?.name === def.key);
    if (slot && predicate(slot)) { result.push(slot); seen.add(slot); }
  }
  for (const slot of list || []) if (!seen.has(slot) && predicate(slot)) result.push(slot);
  return result;
}

export function canonicalSchemaSockets(list, defs, kind) {
  const sockets = [];
  const used = new Set();
  for (const def of defs || []) {
    const matches = (list || []).filter((slot) => slot?.name === def.key && !used.has(slot));
    const slot = matches.find((candidate) => socketConnected(kind, candidate)) || matches[0] || null;
    if (!slot) continue;
    used.add(slot);
    sockets.push(slot);
  }
  return sockets;
}

/**
 * Split real LiteGraph slots into the canonical Prompt Palette schema and legacy extras.
 * Unconnected duplicate/stale/blank extras are never rendered. Connected legacy extras are
 * preserved so an old workflow cannot lose an existing link just because the schema evolved.
 */
export function managedSocketGroups(list, defs, kind) {
  const all = Array.from(list || []);
  const canonical = canonicalSchemaSockets(all, defs, kind);
  const canonicalSet = new Set(canonical);
  const extras = all.filter((slot) => !canonicalSet.has(slot));
  const connectedExtras = extras.filter((slot) => socketConnected(kind, slot));
  const staleExtras = extras.filter((slot) => !socketConnected(kind, slot));
  const visibleCanonical = canonical.filter((slot) => socketVisible(kind, slot));
  const hiddenCanonical = canonical.filter((slot) => !socketVisible(kind, slot));
  const visible = [...visibleCanonical, ...connectedExtras];
  const hidden = [...hiddenCanonical, ...staleExtras];
  return {
    canonical, visibleCanonical, hiddenCanonical, connectedExtras, staleExtras, visible, hidden,
    visibleSet: new Set(visible), hiddenSet: new Set(hidden),
  };
}


export class RendererAdapter {
  constructor(node) { this.node = node; }
  install() {}
  cleanup() {}
  hideSocket() {}
  requestLayout() {}
  sync() {}
  isVisible() { return nodeActive(this.node); }
  getViewportScale() {
    const scale = Number(this.node?.graph?.canvas?.ds?.scale);
    return Number.isFinite(scale) && scale > 0 ? scale : 1;
  }
}
