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
  if (!body?.children) return null;
  for (const candidate of Array.from(body.children)) {
    const groups = Array.from(candidate?.children || []);
    const inputGroup = groups.find((group) => directSlotElements(group, "input").length > 0) || null;
    const outputGroup = groups.find((group) => directSlotElements(group, "output").length > 0) || null;
    if (!inputGroup && !outputGroup) continue;
    return { root: candidate, inputGroup, outputGroup, inputElements: directSlotElements(inputGroup, "input"), outputElements: directSlotElements(outputGroup, "output") };
  }
  return null;
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
  if (label) { element.title = label; element.setAttribute("aria-label", label); }
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
      const inputSlots = Array.from(this.node?.inputs || []);
      const outputSlots = Array.from(this.node?.outputs || []);
      const inputGroups = managedSocketGroups(inputSlots, this.inputDefs, "input");
      const outputGroups = managedSocketGroups(outputSlots, this.outputDefs, "output");
      const showLabels = !!this.labelsShown();
      const signature = JSON.stringify([
        showLabels,
        inputSlots.map((slot, index) => [index, slot?.name || "", inputGroups.visibleSet.has(slot), slot?.link ?? null]),
        outputSlots.map((slot, index) => [index, slot?.name || "", outputGroups.visibleSet.has(slot), Array.isArray(slot?.links) ? slot.links.length : 0]),
        rail.inputElements.length, rail.outputElements.length,
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
