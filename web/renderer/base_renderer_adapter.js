export const IO_SLOT_HEIGHT = 20;
export const IO_RAIL_GAP = 6;
export const HIDDEN_SOCKET_LABEL = "\u200B";

// Native classic output targets span 40px. Keep those targets independent even
// with every port enabled: wrap dense rails instead of squeezing dots together.
export function compactSocketLayout(width, inputCount, outputCount, rowHeight = IO_SLOT_HEIGHT) {
  const inset = 12, step = 40;
  const columns = Math.max(2, Math.floor((width - inset * 2) / step) + 1);
  const total = inputCount + outputCount;
  const inputColumns = !inputCount ? 0 : !outputCount ? columns
    : Math.max(1, Math.min(columns - 1, Math.round(columns * inputCount / total)));
  const outputColumns = outputCount ? columns - inputColumns : 0;
  const place = (count, countPerRow, output) => Array.from({ length: count }, (_, index) => [
    output ? width - inset - index % countPerRow * step : inset + index % countPerRow * step,
    Math.floor(index / countPerRow) * Math.max(20, rowHeight),
  ]);
  const inputs = place(inputCount, inputColumns, false);
  const outputs = place(outputCount, outputColumns, true);
  const rows = Math.max(inputCount ? Math.ceil(inputCount / inputColumns) : 0,
    outputCount ? Math.ceil(outputCount / outputColumns) : 0);
  return { inputs, outputs, height: rows ? 12 + (rows - 1) * Math.max(20, rowHeight) : 0 };
}

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

export function socketConnected(kind, slot, node = null) {
  const index = (kind === "input" ? node?.inputs : node?.outputs)?.indexOf(slot) ?? -1;
  const check = kind === "input" ? node?.isInputConnected : node?.isOutputConnected;
  if (index >= 0 && typeof check === "function") return !!check.call(node, index);
  return kind === "input" ? slot?.link != null : Number(slot?.links?.length) > 0;
}

export function socketVisible(kind, slot, node = null) {
  return !!slot && (!slot.ppHidden || socketConnected(kind, slot, node));
}

export function ioSocketIndex(list, name) {
  return (list || []).findIndex((slot) => slot?.name === name);
}

export function ensureSchemaSocket(node, kind, def) {
  const list = kind === "input" ? node?.inputs : node?.outputs;
  if (!Array.isArray(list)) return null;

  // V3 schemas own socket creation and ordering. Never append sockets from the
  // renderer: doing so can create a live frontend slot whose serialized index
  // is not present in the backend schema/RETURN_TYPES tuple.
  if (kind === "output" && Number.isInteger(def?.slotIndex)) {
    const indexed = list[def.slotIndex];
    // V3 output identity is positional for graph links. The frontend may expose
    // a display/localized name that differs from the schema key, so never reject
    // the authoritative slot index just because its current name differs.
    if (indexed) return indexed;
  }

  const matches = list.filter((slot) => slot?.name === def.key);
  return matches.find((slot) => socketConnected(kind, slot)) || matches[0] || null;
}

const presentationFields = ["label", "localized_name", "pos", "color_on", "color_off"];
const copy = value => Array.isArray(value) ? [...value] : value;
const equal = (a, b) => Array.isArray(a) && Array.isArray(b)
  ? a.length === b.length && a.every((value, index) => value === b[index]) : a === b;

export function rememberSocketState(slot) {
  if (!slot) return;
  let state = slot.__ppSocketRailState;
  if (!state) {
    state = { applied: {}, own: {} };
    Object.defineProperty(slot, "__ppSocketRailState", { value: state, configurable: true });
  }
  for (const key of presentationFields) {
    // Accept external renames/slot updates, but never recapture our own hidden label.
    if (!(key in state.applied) || !equal(slot[key], state.applied[key])) {
      state[key] = slot[key] === HIDDEN_SOCKET_LABEL ? undefined : copy(slot[key]);
      state.own[key] = Object.hasOwn(slot, key) && slot[key] !== HIDDEN_SOCKET_LABEL;
    }
  }
  return state;
}

export function presentSocket(slot, values) {
  const state = rememberSocketState(slot);
  for (const [key, value] of Object.entries(values)) {
    if (!equal(slot[key], value)) slot[key] = copy(value);
    state.applied[key] = copy(value);
  }
}

export function presentationApplied(slot) {
  const state = slot?.__ppSocketRailState;
  return !!state && presentationFields.every((key) => key in state.applied && equal(slot[key], state.applied[key]));
}

export function setSocketLabel(slot, label) {
  if (!slot) return;
  if (!slot.__ppSocketRailState) {
    slot.label = label;
    return;
  }
  const state = rememberSocketState(slot);
  state.label = label === HIDDEN_SOCKET_LABEL ? undefined : copy(label);
  state.own.label = label !== undefined && label !== HIDDEN_SOCKET_LABEL;
  const shouldHide = state.applied.label === HIDDEN_SOCKET_LABEL || slot.label === HIDDEN_SOCKET_LABEL;
  const next = shouldHide ? HIDDEN_SOCKET_LABEL : copy(label);
  slot.label = next;
  state.applied.label = next;
}

export function serializeSocketRail(node, data) {
  for (const kind of ["inputs", "outputs"]) {
    if (!Array.isArray(data?.[kind])) continue;
    // Some hosts serialize slots by reference. Never clean a live slot in place.
    data[kind] = data[kind].map((serialized, index) => {
      if (!serialized) return serialized;
      const result = { ...serialized };
      const original = node[kind]?.[index]?.__ppSocketRailState
        ? rememberSocketState(node[kind][index]) : null;
      for (const key of ["ppHidden", "__ppSocketRailTitle", "__ppSocketRailState"]) delete result[key];
      for (const key of presentationFields) {
        if (original) {
          if (original.own[key]) result[key] = copy(original[key]);
          else delete result[key];
        } else if (result[key] === HIDDEN_SOCKET_LABEL) delete result[key];
      }
      return result;
    });
  }
}

export function restoreSocketState(slot) {
  const original = slot?.__ppSocketRailState;
  if (!slot || !original) return;
  rememberSocketState(slot);
  for (const key of presentationFields) {
    if (original.own[key]) slot[key] = copy(original[key]);
    else delete slot[key];
  }
  delete slot.ppHidden;
  delete slot.__ppSocketRailState;
  delete slot.__ppSocketRailTitle;
}

export function socketDisplayLabel(slot, defs) {
  const def = (defs || []).find((candidate) => candidate.key === slot?.name);
  return [slot?.__ppSocketRailState?.label, slot?.label, slot?.__ppSocketRailState?.localized_name, slot?.localized_name, def?.label, slot?.name].find(value =>
    typeof value === "string" && value.replace(/\u200b/g, "").trim()) || "Socket";
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
    let slot = null;
    // Output links are indexed by their schema position. A legacy/localized name
    // must never make us select a different output slot just because it happens to
    // share the same visible name. Inputs remain name-based because their widget
    // identities are not positional in the same way.
    if (kind === "output" && Number.isInteger(def?.slotIndex)) {
      const indexed = list?.[def.slotIndex];
      if (indexed && !used.has(indexed)) slot = indexed;
    }
    if (!slot) {
      const matches = (list || []).filter((candidate) => candidate?.name === def.key && !used.has(candidate));
      slot = matches.find((candidate) => socketConnected(kind, candidate)) || matches[0] || null;
    }
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
export function managedSocketGroups(list, defs, kind, node = null) {
  const all = Array.from(list || []);
  const canonical = canonicalSchemaSockets(all, defs, kind);
  const canonicalSet = new Set(canonical);
  const extras = all.filter((slot) => !canonicalSet.has(slot));
  const connectedExtras = extras.filter((slot) => socketConnected(kind, slot, node));
  const staleExtras = extras.filter((slot) => !socketConnected(kind, slot, node));
  const visibleCanonical = canonical.filter((slot) => socketVisible(kind, slot, node));
  const hiddenCanonical = canonical.filter((slot) => !socketVisible(kind, slot, node));
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
