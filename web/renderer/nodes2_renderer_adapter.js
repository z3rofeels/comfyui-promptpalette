import { RendererAdapter, nodeActive, socketDisplayLabel, managedSocketGroups, frame, cancelFrame } from "./base_renderer_adapter.js";

function escapeAttributeValue(value) {
  return String(value ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
function vueNodeIdFromElement(element) {
  const host = element?.matches?.(".lg-node") ? element : element?.closest?.(".lg-node");
  return host?.dataset?.nodeId ?? null;
}
function affectedVueNodeIds(records) {
  const ids = new Set();
  const collect = (element) => {
    if (element?.nodeType !== 1) return;
    const ownId = vueNodeIdFromElement(element);
    if (ownId != null) ids.add(String(ownId));
    for (const host of element.querySelectorAll?.(".lg-node[data-node-id]") || []) if (host.dataset.nodeId != null) ids.add(String(host.dataset.nodeId));
  };
  for (const record of records || []) {
    collect(record.target);
    for (const added of record.addedNodes || []) collect(added);
    for (const removed of record.removedNodes || []) collect(removed);
  }
  return ids;
}
function directSlotElements(group, kind) {
  if (!group?.children) return [];
  const className = kind === "input" ? "lg-slot--input" : "lg-slot--output";
  return Array.from(group.children).filter((element) => element?.classList?.contains(className));
}
function findPrimarySlotRail(nodeElement, node) {
  if (!nodeElement?.querySelector) return null;
  const nodeId = escapeAttributeValue(node?.id);
  const body = nodeElement.querySelector(`[data-testid="node-body-${nodeId}"]`) || nodeElement.querySelector('[data-testid^="node-body-"]');
  if (!body) return null;

  // Current Nodes 2 renders NodeSlots as a wrapper with two child groups:
  //   NodeSlots -> input group -> .lg-slot--input*
  //            -> output group -> .lg-slot--output*
  // Older Nodes 2 builds used a slightly different wrapper shape, so retain a
  // narrow fallback that walks direct children before using the canonical shape.
  const firstInput = body.querySelector('.lg-slot--input');
  const firstOutput = body.querySelector('.lg-slot--output');
  const inputGroup = firstInput?.parentElement || null;
  const outputGroup = firstOutput?.parentElement || null;
  const inputRoot = inputGroup?.parentElement || null;
  const outputRoot = outputGroup?.parentElement || null;
  const root = inputRoot && (!outputRoot || inputRoot === outputRoot)
    ? inputRoot
    : outputRoot && !inputRoot
      ? outputRoot
      : inputRoot?.contains?.(outputGroup)
        ? inputRoot
        : outputRoot?.contains?.(inputGroup)
          ? outputRoot
          : null;

  if (root && (inputGroup || outputGroup)) {
    return {
      root,
      inputGroup,
      outputGroup,
      inputElements: directSlotElements(inputGroup, "input"),
      outputElements: directSlotElements(outputGroup, "output"),
    };
  }

  for (const candidate of Array.from(body.children || [])) {
    const groups = Array.from(candidate?.children || []);
    const legacyInputGroup = groups.find((group) => directSlotElements(group, "input").length > 0) || null;
    const legacyOutputGroup = groups.find((group) => directSlotElements(group, "output").length > 0) || null;
    if (!legacyInputGroup && !legacyOutputGroup) continue;
    return {
      root: candidate,
      inputGroup: legacyInputGroup,
      outputGroup: legacyOutputGroup,
      inputElements: directSlotElements(legacyInputGroup, "input"),
      outputElements: directSlotElements(legacyOutputGroup, "output"),
    };
  }
  return null;
}

function renderedNode2Inputs(list) {
  // The normal NodeSlots component renders non-widget inputs. Widget-backed
  // sockets are rendered by WidgetGrid instead, where the widget row owns the
  // socket. Keep this helper limited to the NodeSlots side of the current
  // Nodes 2 structure.
  return Array.from(list || []).filter((slot) => !slot?.widget);
}

function managedWidgetSocketElements(nodeElement, node, inputDefs) {
  const widgetsRoot = nodeElement?.querySelector?.('[data-testid="node-widgets"]');
  if (!widgetsRoot) return [];

  const defsByName = new Map((inputDefs || []).map((def) => [def.key, def]));
  const managedWidgets = [];
  for (const widget of Array.from(node?.widgets || [])) {
    if (!widget?.name || !defsByName.has(widget.name)) continue;
    if (!widget.__ppSocketOnly && !widget.__ppSocketRailCandidate) continue;
    const inputIndex = (node.inputs || []).findIndex((slot) => slot?.name === widget.name);
    if (inputIndex < 0) continue;
    managedWidgets.push({ widget, inputIndex, def: defsByName.get(widget.name) });
  }

  // WidgetGrid preserves node.widgets order for the rows it renders. Since
  // Prompt Palette marks only its managed backing widgets as socket-only, the
  // row order is enough to map the live InputSlot back to the real input index.
  const rows = Array.from(widgetsRoot.querySelectorAll('[data-testid="node-widget"]'));
  const visible = managedWidgets.filter(({ widget }) => widget.hidden !== true && widget.options?.hidden !== true);
  const elements = [];
  for (let i = 0; i < visible.length; i += 1) {
    const row = rows[i];
    const socket = row?.querySelector?.('.lg-slot--input');
    if (socket) elements.push({ element: socket, row, ...visible[i] });
  }
  return elements;
}

function hideWidgetRowControl(row) {
  if (!row) return;
  for (const child of Array.from(row.children || [])) {
    if (child.querySelector?.('.lg-slot--input')) continue;
    child.hidden = true;
    child.setAttribute('aria-hidden', 'true');
    child.style.display = 'none';
  }
}

function setWidgetSocketLabel(element, label, show) {
  const wrapper = element?.parentElement;
  if (!wrapper) return;
  if (show && label) {
    wrapper.style.position = 'relative';
    wrapper.style.opacity = '1';
    let labelEl = wrapper.querySelector?.('[data-pp-widget-socket-label]');
    if (!labelEl) {
      const doc = element?.ownerDocument || globalThis.document;
      if (!doc?.createElement) return;
      labelEl = doc.createElement('span');
      labelEl.dataset.ppWidgetSocketLabel = 'true';
      wrapper.appendChild(labelEl);
    }
    labelEl.textContent = label;
    labelEl.style.position = 'absolute';
    labelEl.style.left = '11px';
    labelEl.style.top = '50%';
    labelEl.style.transform = 'translateY(-50%)';
    labelEl.style.whiteSpace = 'nowrap';
    labelEl.style.pointerEvents = 'none';
    labelEl.style.fontSize = '9px';
    labelEl.style.lineHeight = '12px';
    labelEl.style.color = 'var(--node-text, var(--fg-color, #c9c9c9))';
  } else {
    const labelEl = wrapper.querySelector?.('[data-pp-widget-socket-label]');
    labelEl?.remove?.();
  }
}

function renderedLabelText(element) {
  return element?.querySelector?.('.text-node-component-slot-text')?.textContent ?? '';
}
function setVueSocketState(element, { hidden = false, showLabels = false, label = "" } = {}) {
  if (!element) return;
  const hiddenText = hidden ? "true" : "false";
  const labelMode = showLabels ? "shown" : "hidden";
  element.dataset.ppSocketRailItem = "true";
  element.dataset.ppSocketHidden = hiddenText;
  element.dataset.ppSocketLabels = labelMode;
  element.hidden = hidden;
  element.setAttribute("aria-hidden", hiddenText);
  if (label) {
    element.title = label;
    element.setAttribute("aria-label", label);
    // V3's Nodes 2 slot labels are Vue-rendered from NodeState. Palette's
    // classic renderer deliberately uses a zero-width compact label, so keep
    // the mounted Vue text authoritative here without changing graph links.
    const text = element.querySelector?.('.text-node-component-slot-text');
    if (text && showLabels && text.textContent !== label) text.textContent = label;
  }
  if (hidden) element.setAttribute("inert", ""); else element.removeAttribute("inert");
}

class Nodes2LifecycleObserver {
  constructor() { this.adapters = new Map(); this.observer = null; this.host = null; }
  register(adapter) {
    const id = adapter.node?.id;
    if (id == null) return;
    this.adapters.set(String(id), adapter);
    this.ensure();
    adapter.node._ppSocketObserverCount = this.observer ? 1 : 0;
  }
  unregister(adapter) {
    const id = adapter.node?.id;
    if (id != null) this.adapters.delete(String(id));
    delete adapter.node?._ppSocketObserverCount;
    if (!this.adapters.size) this.stop();
  }
  ensure() {
    if (this.observer || typeof MutationObserver === "undefined" || typeof document === "undefined") return;
    this.host = document.getElementById?.("graph-canvas-container") || document.querySelector?.(".graph-canvas-container") || document.body || document.documentElement;
    if (!this.host) return;
    this.observer = new MutationObserver((records) => {
      for (const id of affectedVueNodeIds(records)) {
        const adapter = this.adapters.get(String(id));
        if (!adapter) continue;
        if (!nodeActive(adapter.node)) { this.unregister(adapter); continue; }
        adapter.requestSync();
      }
    });
    this.observer.observe(this.host, { childList: true, subtree: true });
    for (const adapter of this.adapters.values()) adapter.node._ppSocketObserverCount = 1;
  }
  stop() {
    this.observer?.disconnect();
    this.observer = null;
    this.host = null;
  }
  count() { return this.observer ? 1 : 0; }
}
const lifecycleObserver = new Nodes2LifecycleObserver();

export class Nodes2RendererAdapter extends RendererAdapter {
  constructor(node, { labelsShown = () => false } = {}) {
    super(node);
    this.labelsShown = labelsShown;
    this.inputDefs = [];
    this.outputDefs = [];
    this.vueNode = null;
    this.syncFrame = 0;
    this.signature = "";
    this.lastSyncedVueNode = null;
    this.inSync = false;
    this.mode = null;
  }
  install(inputDefs = [], outputDefs = []) {
    this.inputDefs = inputDefs;
    this.outputDefs = outputDefs;
    lifecycleObserver.register(this);
    this.requestSync();
  }
  findVueNode() {
    if (this.vueNode?.isConnected && this.vueNode.dataset?.nodeId === String(this.node?.id)) return this.vueNode;
    const nodeId = this.node?.id;
    if (nodeId == null || typeof document === "undefined") return null;
    this.vueNode = document.querySelector?.(`.lg-node[data-node-id="${escapeAttributeValue(nodeId)}"]`) || null;
    return this.vueNode;
  }
  requestSync() {
    if (!nodeActive(this.node) || this.syncFrame) return;
    this.syncFrame = frame(() => { this.syncFrame = 0; if (nodeActive(this.node)) this.sync(); });
  }
  setMode(nextMode) {
    if (this.mode === nextMode) return false;
    this.mode = nextMode;
    // Renderer switches detach/remount DOM widgets without changing their value.
    // Notify only this node so it can re-register visual state after the mount.
    // The existing shared Nodes 2 MutationObserver is the source of the event;
    // no extra observer, polling loop, or geometry mutation is introduced.
    try { this.node?._wgRendererModeChanged?.(nextMode); } catch (error) {
      console.warn("Prompt Palette: renderer-mode refresh failed", error);
    }
    return true;
  }
  sync() {
    if (this.inSync) return false;
    this.inSync = true;
    const profiler = this.node?._ppProfiler;
    const started = profiler?.enabled ? (globalThis.performance?.now?.() ?? Date.now()) : 0;
    profiler?.count("socketSyncs");
    try {
      const nodeElement = this.findVueNode();
      this.setMode(nodeElement ? "nodes2" : "classic");
      if (!nodeElement) return false;
      const rail = findPrimarySlotRail(nodeElement, this.node);
      if (!rail) return false;
      const inputSlots = renderedNode2Inputs(this.node?.inputs || []);
      const widgetSocketEntries = managedWidgetSocketElements(nodeElement, this.node, this.inputDefs);
      const outputSlots = Array.from(this.node?.outputs || []);
      const inputGroups = managedSocketGroups([
        ...inputSlots,
        ...widgetSocketEntries.map((entry) => this.node?.inputs?.[entry.inputIndex]).filter(Boolean),
      ], this.inputDefs, "input");
      const outputGroups = managedSocketGroups(outputSlots, this.outputDefs, "output");
      const showLabels = !!this.labelsShown();
      const signature = JSON.stringify([
        showLabels,
        inputSlots.map((slot, index) => [index, slot?.name || "", inputGroups.visibleSet.has(slot), slot?.link ?? null]),
        outputSlots.map((slot, index) => [index, slot?.name || "", outputGroups.visibleSet.has(slot), Array.isArray(slot?.links) ? slot.links.length : 0]),
        rail.inputElements.length, widgetSocketEntries.length, rail.outputElements.length,
        rail.inputElements.map((element) => renderedLabelText(element)),
        widgetSocketEntries.map((entry) => renderedLabelText(entry.element)),
        rail.outputElements.map((element) => renderedLabelText(element)),
      ]);
      if (this.lastSyncedVueNode === nodeElement && this.signature === signature) return false;
      this.lastSyncedVueNode = nodeElement;
      this.signature = signature;
      let visibleCount = 0;
      rail.inputElements.forEach((element, index) => {
        const slot = inputSlots[index];
        const hidden = !slot || !inputGroups.visibleSet.has(slot);
        if (!hidden) visibleCount += 1;
        setVueSocketState(element, { hidden, showLabels, label: socketDisplayLabel(slot, this.inputDefs) });
      });
      widgetSocketEntries.forEach(({ element, row, widget, inputIndex, def }) => {
        const slot = this.node?.inputs?.[inputIndex];
        const hidden = !slot || !inputGroups.visibleSet.has(slot);
        if (!hidden) visibleCount += 1;
        hideWidgetRowControl(row);
        if (row) {
          row.hidden = hidden;
          row.setAttribute('aria-hidden', hidden ? 'true' : 'false');
        }
        widget.__ppSocketOnly = !hidden;
        const label = def?.label || socketDisplayLabel(slot, this.inputDefs);
        setWidgetSocketLabel(element, label, !hidden && showLabels);
        setVueSocketState(element, { hidden, showLabels: false, label });
      });
      rail.outputElements.forEach((element, index) => {
        const slot = outputSlots[index];
        const hidden = !slot || !outputGroups.visibleSet.has(slot);
        if (!hidden) visibleCount += 1;
        setVueSocketState(element, { hidden, showLabels, label: socketDisplayLabel(slot, this.outputDefs) });
      });
      rail.root.dataset.ppSocketRail = "true";
      rail.root.dataset.ppSocketEmpty = visibleCount === 0 ? "true" : "false";
      rail.root.dataset.ppSocketCompact = showLabels ? "false" : "true";
      if (rail.inputGroup) rail.inputGroup.dataset.ppSocketRailGroup = "input";
      if (rail.outputGroup) rail.outputGroup.dataset.ppSocketRailGroup = "output";
      nodeElement.dataset.ppSocketRailBody = "true";
      return true;
    } finally {
      this.inSync = false;
      if (started) profiler.record("nodes2.sync", (globalThis.performance?.now?.() ?? Date.now()) - started);
    }
  }
  isVisible() {
    const nodeElement = this.findVueNode();
    if (!nodeElement) return false;
    const rect = nodeElement.getBoundingClientRect?.();
    return !rect || (rect.bottom >= 0 && rect.right >= 0 && rect.top <= (globalThis.innerHeight || globalThis.document?.documentElement?.clientHeight || 0) && rect.left <= (globalThis.innerWidth || globalThis.document?.documentElement?.clientWidth || 0));
  }
  cleanup() {
    lifecycleObserver.unregister(this);
    cancelFrame(this.syncFrame);
    this.syncFrame = 0;
    this.signature = "";
    this.lastSyncedVueNode = null;
    this.inSync = false;
    this.mode = null;
    const vueNode = this.vueNode;
    if (vueNode?.querySelectorAll) {
      for (const element of vueNode.querySelectorAll('[data-pp-socket-rail-item="true"]')) {
        delete element.dataset.ppSocketRailItem; delete element.dataset.ppSocketHidden; delete element.dataset.ppSocketLabels;
        element.hidden = false; element.removeAttribute("aria-hidden"); element.removeAttribute("inert");
      }
      for (const element of vueNode.querySelectorAll('[data-pp-socket-rail="true"], [data-pp-socket-rail-group]')) {
        delete element.dataset.ppSocketRail; delete element.dataset.ppSocketEmpty; delete element.dataset.ppSocketCompact; delete element.dataset.ppSocketRailGroup;
      }
      delete vueNode.dataset.ppSocketRailBody;
    }
    this.vueNode = null;
  }
}

export function nodes2ObserverCount() { return lifecycleObserver.count(); }
