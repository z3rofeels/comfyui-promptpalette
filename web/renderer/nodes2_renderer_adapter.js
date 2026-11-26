import { RendererAdapter, nodeActive, socketConnected, socketDisplayLabel, managedSocketGroups, compactSocketLayout, frame, cancelFrame } from "./base_renderer_adapter.js";

function escapeAttributeValue(value) {
  return String(value ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
function vueNodeIdFromElement(element) {
  const host = element?.matches?.(".lg-node") ? element : element?.closest?.(".lg-node");
  return host?.dataset?.nodeId ?? null;
}
const PP_OWNED_DOM_SELECTOR = ".wg-node-frame, .ppwc-surface, .wg-root, .wg-settings-popup, .wg-seed-portal, .wg-ac-menu, .wg-ac-preview, .wg-ctx-menu, .wg-tip, .pp-sidebar-hover-preview, .pp-lora-flyout, .pp-lora-sidecar-window";
function isPromptPaletteOwnedNode(node) {
  return node?.nodeType === 1 && (node.matches?.(PP_OWNED_DOM_SELECTOR) || node.dataset?.promptPaletteGlobal === "true" || !!node.closest?.(PP_OWNED_DOM_SELECTOR));
}
function affectedVueNodeIds(records) {
  const ids = new Set();
  let externalMutation = false;
  const collect = (element) => {
    if (element?.nodeType !== 1 || isPromptPaletteOwnedNode(element)) return;
    externalMutation = true;
    const ownId = vueNodeIdFromElement(element);
    if (ownId != null) ids.add(String(ownId));
    if (element.firstElementChild) {
      for (const host of element.querySelectorAll?.(".lg-node[data-node-id]") || []) {
        if (host.dataset.nodeId != null) ids.add(String(host.dataset.nodeId));
      }
    }
  };
  for (const record of records || []) {
    // Prompt text, status counts, popups and virtual cards are owned by Prompt Palette.
    // They cannot change Vue's native sockets. A widget mount/removal is still
    // detected because its mutation target lies outside this owned subtree.
    if (isPromptPaletteOwnedNode(record.target)) continue;
    const targetId = vueNodeIdFromElement(record.target);
    if (targetId != null) ids.add(String(targetId));
    if (record.addedNodes?.length || record.removedNodes?.length) {
      for (const added of record.addedNodes || []) collect(added);
      for (const removed of record.removedNodes || []) collect(removed);
    }
  }
  return { ids, externalMutation };
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
      body,
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
      body,
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

function slotIndexFromVueSocket(element, nodeId, kind = "input") {
  const keyed = element?.querySelector?.('[data-slot-key]')?.dataset?.slotKey;
  if (!keyed) return -1;
  const parts = String(keyed).split(":");
  if (parts.length < 3 || parts[0] !== String(nodeId) || parts[1] !== kind) return -1;
  const index = Number(parts[2]);
  return Number.isInteger(index) && index >= 0 ? index : -1;
}

function managedWidgetSocketElements(nodeElement, node, inputDefs) {
  const widgetsRoot = nodeElement?.querySelector?.('[data-testid="node-widgets"]');
  if (!widgetsRoot) return [];

  const defsByName = new Map((inputDefs || []).map((def) => [def.key, def]));
  const widgetsByName = new Map(Array.from(node?.widgets || []).filter((widget) => widget?.name).map((widget) => [widget.name, widget]));
  const managedByInputIndex = new Map();
  for (let inputIndex = 0; inputIndex < (node?.inputs || []).length; inputIndex += 1) {
    const slot = node.inputs[inputIndex];
    if (!slot?.name || !defsByName.has(slot.name)) continue;
    // slot.widget is often only a { name } descriptor, not the backing widget.
    const widget = widgetsByName.get(slot.widget?.name || slot.name) || slot.widget;
    if (!widget || (!widget.__ppSocketOnly && !widget.__ppSocketRailCandidate)) continue;
    managedByInputIndex.set(inputIndex, { widget, inputIndex, def: defsByName.get(slot.name) });
  }

  // Current ComfyUI Nodes 2 exposes the real widget-input index on data-slot-key.
  // Use it as the identity instead of assuming the first rendered row is our first
  // managed widget; ordinary widgets, suppressed widgets, and converted widgets can
  // all change the rendered row count/order.
  const socketRoots = Array.from(widgetsRoot.querySelectorAll('.lg-slot--input'));
  const elements = [];
  const consumed = new Set();
  for (const element of socketRoots) {
    const inputIndex = slotIndexFromVueSocket(element, node?.id);
    const entry = managedByInputIndex.get(inputIndex);
    if (!entry || consumed.has(inputIndex)) continue;
    const row = element.closest?.('[data-testid="node-widget"]') || element.parentElement?.parentElement || null;
    elements.push({ element, row, ...entry });
    consumed.add(inputIndex);
  }

  // Older Nodes 2 builds did not expose data-slot-key consistently. Preserve a
  // conservative fallback for those versions, but only among rows whose socket
  // label matches a managed widget name/label.
  if (!elements.length) {
    const rows = Array.from(widgetsRoot.querySelectorAll('[data-testid="node-widget"]'));
    for (const row of rows) {
      const socket = row?.querySelector?.('.lg-slot--input');
      if (!socket) continue;
      const renderedLabel = String(socket.querySelector?.('.text-node-component-slot-text')?.textContent || '').trim();
      const entry = Array.from(managedByInputIndex.values()).find(({ inputIndex, def }) => {
        if (consumed.has(inputIndex)) return false;
        const slot = node?.inputs?.[inputIndex];
        return renderedLabel === String(def?.label || slot?.label || slot?.name || '').trim();
      });
      if (!entry) continue;
      elements.push({ element: socket, row, ...entry });
      consumed.add(entry.inputIndex);
    }
  }
  return elements;
}

function hideWidgetRowControl(row, remember) {
  if (!row) return;
  for (const child of Array.from(row.children || [])) {
    if (child.matches?.('.lg-slot--input') || child.querySelector?.('.lg-slot--input')) continue;
    remember(child);
    child.hidden = true;
    child.setAttribute('aria-hidden', 'true');
    child.style.display = 'none';
  }
}

function exposeWidgetSocket(element, remember) {
  const wrapper = element?.parentElement;
  if (!wrapper) return;
  remember(wrapper);
  // The backing control is hidden, but its native connection target and label
  // remain usable. Do not create another absolutely positioned label system.
  wrapper.style.position = "relative";
  wrapper.style.opacity = "1";
}
function nativeLabelElement(element) {
  return element?.querySelector?.('.text-node-component-slot-text, [data-slot-label], [class*="slot-text"], :scope > [data-testid="slot-connection-dot"] ~ div, :scope > div:has(+ [data-testid="slot-connection-dot"])');
}
function renderedLabelText(element) {
  return nativeLabelElement(element)?.textContent ?? '';
}
function setVueSocketState(element, { hidden = false, showLabels = false, label = "", widget = false } = {}) {
  if (!element) return;
  const hiddenText = hidden ? "true" : "false";
  const labelMode = showLabels ? "shown" : "hidden";
  element.dataset.ppSocketRailItem = "true";
  element.dataset.ppSocketHidden = hiddenText;
  element.dataset.ppSocketLabels = labelMode;
  element.hidden = hidden;
  element.setAttribute("aria-hidden", hiddenText);
  if (label) {
    element.setAttribute("aria-label", label);
    // Leave Vue-owned label text untouched. A blank label can get a separate
    // fallback while the host mounts; remove it as soon as native text exists.
    const text = nativeLabelElement(element);
    const content = text ? text.textContent : [...element.childNodes].filter(child =>
      child.nodeType === 3 || child.nodeType === 1 && !child.matches('[data-pp-socket-fallback-label], .lg-slot__connection-dot, svg')).map(child => child.textContent).join("");
    const present = String(content || "").replace(/\u200b/g, "").trim();
    let fallback = element.querySelector('[data-pp-socket-fallback-label]');
    if (showLabels && (text || widget) && !present && !hidden) {
      if (!fallback) { fallback = document.createElement("span"); fallback.dataset.ppSocketFallbackLabel = "true"; element.append(fallback); }
      if (fallback.textContent !== label) fallback.textContent = label;
    } else fallback?.remove();
  }
  if (hidden) element.setAttribute("inert", ""); else element.removeAttribute("inert");
}

class Nodes2LifecycleObserver {
  constructor() { this.adapters = new Map(); this.observer = null; this.host = null; this.vueDomEpoch = 0; }
  isObservingHost() { return !!this.observer && !!this.host?.isConnected; }
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
    this.vueDomEpoch += 1;
    this.observer = new MutationObserver((records) => {
      const { ids, externalMutation } = affectedVueNodeIds(records);
      if (externalMutation || ids.size) this.vueDomEpoch += 1;
      for (const id of ids) {
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
    this.vueDomEpoch += 1;
  }
  count() { return this.observer ? 1 : 0; }
}
const lifecycleObserver = new Nodes2LifecycleObserver();

export class Nodes2RendererAdapter extends RendererAdapter {
  constructor(node, { labelsShown = () => false, hover = null } = {}) {
    super(node);
    this.labelsShown = labelsShown;
    this.hover = hover;
    this.socketElements = new WeakMap();
    this.hoverHost = null;
    this.hoverMove = event => {
      const element = event.target.closest?.('[data-pp-socket-rail-item]');
      const entry = element && this.socketElements.get(element);
      if (entry) this.hover?.show(event, entry.slot, entry.kind, entry.kind === "input" ? this.inputDefs : this.outputDefs);
      else this.hover?.hide();
    };
    this.hoverLeave = () => this.hover?.hide();
    this.inputDefs = [];
    this.outputDefs = [];
    this.vueNode = null;
    this.lastMissEpoch = -1;
    this.syncFrame = 0;
    this.signature = "";
    this.lastSyncedVueNode = null;
    this.lastSyncedElements = [];
    this.inSync = false;
    this.mode = null;
    this.domState = new Map();
  }
  remember(element) {
    if (!element || this.domState.has(element)) return;
    const attrs = ["hidden", "aria-hidden", "aria-label", "inert", "title", "data-pp-socket-rail-item", "data-pp-socket-hidden", "data-pp-socket-labels", "data-pp-socket-rail", "data-pp-socket-empty", "data-pp-socket-compact", "data-pp-socket-rail-group", "data-pp-socket-rail-body", "data-pp-socket-body", "data-pp-socket-widget-path", "data-pp-socket-native-collapsed"];
    this.domState.set(element, { attrs: attrs.map(key => [key, element.getAttribute(key)]),
      styles: ["display", "position", "opacity", "--pp-socket-x", "--pp-socket-y", "--pp-socket-rail-height"].map(key => [key, element.style.getPropertyValue(key), element.style.getPropertyPriority(key)]) });
  }
  restoreElement(element, state) {
    for (const [key, value] of state.attrs) { if (value === null) element.removeAttribute(key); else element.setAttribute(key, value); }
    for (const [key, value, priority] of state.styles) { if (value) element.style.setProperty(key, value, priority); else element.style.removeProperty(key); }
    for (const label of element.querySelectorAll('[data-pp-widget-socket-label], [data-pp-socket-fallback-label]')) label.remove();
  }
  releaseDom() {
    this.hoverHost?.removeEventListener("pointermove", this.hoverMove);
    this.hoverHost?.removeEventListener("pointerleave", this.hoverLeave);
    this.hoverHost = null;
    this.hover?.hide();
    for (const [element, state] of this.domState) this.restoreElement(element, state);
    this.domState.clear();
  }
  install(inputDefs = [], outputDefs = []) {
    this.inputDefs = inputDefs;
    this.outputDefs = outputDefs;
    lifecycleObserver.register(this);
    this.requestSync();
  }
  findVueNode() {
    if (this.vueNode?.isConnected && this.vueNode.dataset?.nodeId === String(this.node?.id)) return this.vueNode;
    this.vueNode = null;
    if (this.lastMissEpoch === lifecycleObserver.vueDomEpoch && lifecycleObserver.isObservingHost()) return null;
    const nodeId = this.node?.id;
    if (nodeId == null || typeof document === "undefined") return null;
    this.vueNode = document.querySelector?.(`.lg-node[data-node-id="${escapeAttributeValue(nodeId)}"]`) || null;
    if (!this.vueNode && lifecycleObserver.isObservingHost()) {
      this.lastMissEpoch = lifecycleObserver.vueDomEpoch;
    } else if (this.vueNode) {
      this.lastMissEpoch = -1;
    }
    return this.vueNode;
  }
  requestSyncIfActive() {
    if (this.mode === "classic" && !this.findVueNode()) return;
    this.requestSync();
  }
  requestSync() {
    if (!nodeActive(this.node) || this.syncFrame) return;
    this.syncFrame = frame(() => { this.syncFrame = 0; if (nodeActive(this.node)) this.sync(); });
  }
  setMode(nextMode) {
    const prevMode = this.mode;
    if (prevMode === nextMode) return false;
    this.mode = nextMode;
    // Initial classic discovery only confirms the already-mounted legacy node;
    // re-running full theme/visual/geometry teardown+remount here adds a large startup spike.
    if (prevMode !== null || nextMode === "nodes2") {
      this.node._ppRendererAdapter?.classic.requestLayout();
      // Renderer switches detach/remount DOM widgets without changing their value.
      // Notify only this node so it can re-register visual state after the mount.
      // The existing shared Nodes 2 MutationObserver is the source of the event;
      // no extra observer, polling loop, or geometry mutation is introduced.
      try { this.node?._wgRendererModeChanged?.(nextMode); } catch (error) {
        console.warn("Prompt Palette: renderer-mode refresh failed", error);
      }
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
      if (this.lastSyncedVueNode && this.lastSyncedVueNode !== nodeElement) this.releaseDom();
      if (!nodeElement) { this.lastSyncedVueNode = null; this.signature = ""; this.lastSyncedElements = []; return false; }
      for (const [element, state] of this.domState) if (!element.isConnected) { this.restoreElement(element, state); this.domState.delete(element); }
      const rail = findPrimarySlotRail(nodeElement, this.node);
      if (!rail) {
        // Native node collapse replaces the body with ComfyUI's own title slots.
        // Release our body presentation rather than leaving a second compact rail.
        this.releaseDom(); this.signature = ""; this.lastSyncedElements = [];
        this.lastSyncedVueNode = null;
        return false;
      }
      const inputSlots = renderedNode2Inputs(this.node?.inputs || []);
      const widgetSocketEntries = managedWidgetSocketElements(nodeElement, this.node, this.inputDefs);
      const outputSlots = Array.from(this.node?.outputs || []);
      const inputGroups = managedSocketGroups(this.node.inputs, this.inputDefs, "input", this.node);
      const outputGroups = managedSocketGroups(outputSlots, this.outputDefs, "output", this.node);
      const showLabels = this.labelsShown();
      const width = rail.body.clientWidth || Number(this.node.size?.[0]) || 180;
      const compact = compactSocketLayout(width, inputGroups.visible.length, outputGroups.visible.length);
      const positions = new Map([
        ...inputGroups.visible.map((slot, index) => [slot, compact.inputs[index]]),
        ...outputGroups.visible.map((slot, index) => [slot, compact.outputs[index]]),
      ]);
      const allSocketElements = [...nodeElement.querySelectorAll('.lg-slot--input, .lg-slot--output')];
      const slotSignature = (slot, kind, visible) => [slot?.name, slot?.type, socketDisplayLabel(slot, kind === "input" ? this.inputDefs : this.outputDefs), visible, socketConnected(kind, slot, this.node)];
      const signature = JSON.stringify([
        showLabels, width, !!this.node.flags?.collapsed, allSocketElements.length,
        inputSlots.map(slot => slotSignature(slot, "input", inputGroups.visibleSet.has(slot))),
        widgetSocketEntries.map(({ inputIndex }) => {
          const slot = this.node?.inputs?.[inputIndex];
          return [inputIndex, slotSignature(slot, "input", inputGroups.visibleSet.has(slot))];
        }),
        outputSlots.map(slot => slotSignature(slot, "output", outputGroups.visibleSet.has(slot))),
        rail.inputElements.length, widgetSocketEntries.length, rail.outputElements.length,
        rail.inputElements.map((element) => renderedLabelText(element)),
        widgetSocketEntries.map((entry) => renderedLabelText(entry.element)),
        rail.outputElements.map((element) => renderedLabelText(element)),
      ]);
      // Vue can replace slot/widget rows without replacing the outer node, and
      // with exactly the same labels/counts. Those new elements still need our
      // visibility state; a value-only signature cannot identify a remount.
      const elements = [rail.body, rail.root, rail.inputGroup, rail.outputGroup, ...rail.inputElements,
        ...widgetSocketEntries.flatMap(entry => [entry.element, entry.row]), ...rail.outputElements, ...allSocketElements];
      const sameElements = elements.length === this.lastSyncedElements.length
        && elements.every((element, index) => element === this.lastSyncedElements[index]);
      if (this.lastSyncedVueNode === nodeElement && sameElements && this.signature === signature) return false;
      this.lastSyncedElements = elements;
      this.lastSyncedVueNode = nodeElement;
      this.signature = signature;
      for (const element of [nodeElement, ...elements]) this.remember(element);
      if (this.hoverHost !== nodeElement) {
        this.hoverHost = nodeElement;
        nodeElement.addEventListener("pointermove", this.hoverMove);
        nodeElement.addEventListener("pointerleave", this.hoverLeave);
      }
      const presented = new Set(), touched = new Set();
      const present = (element, slot, kind, hidden, widget = false) => {
        hidden ||= presented.has(slot);
        if (!hidden) presented.add(slot);
        touched.add(element);
        this.socketElements.set(element, { slot, kind });
        setVueSocketState(element, { hidden, widget,
          showLabels,
          label: socketDisplayLabel(slot, kind === "input" ? this.inputDefs : this.outputDefs) });
        const position = positions.get(slot);
        if (position) {
          element.style.setProperty("--pp-socket-x", `${position[0]}px`);
          element.style.setProperty("--pp-socket-y", `${position[1]}px`);
        }
        return hidden;
      };
      let visibleCount = 0;
      rail.inputElements.forEach((element, index) => {
        const keyedIndex = slotIndexFromVueSocket(element, this.node?.id, "input");
        const slot = keyedIndex >= 0 ? this.node.inputs?.[keyedIndex] : inputSlots[index];
        const hidden = !slot || !inputGroups.visibleSet.has(slot);
        if (!hidden) visibleCount += 1;
        present(element, slot, "input", hidden);
      });
      widgetSocketEntries.forEach(({ element, row, widget, inputIndex }) => {
        const slot = this.node?.inputs?.[inputIndex];
        const hidden = present(element, slot, "input", !slot || !inputGroups.visibleSet.has(slot), true);
        hideWidgetRowControl(row, element => this.remember(element));
        if (row) {
          row.hidden = hidden;
          row.setAttribute('aria-hidden', hidden ? 'true' : 'false');
        }
        widget.__ppSocketOnly = !hidden;
        if (!hidden) exposeWidgetSocket(element, element => this.remember(element));
        // Keep the actual Vue socket in its widget row. Flatten only its wrapper
        // chain in compact mode so no invisible widget-input rows consume space.
        const widgetsRoot = element.closest('[data-testid="node-widgets"]');
        for (let parent = element.parentElement; parent && parent !== rail.body; parent = parent.parentElement) {
          this.remember(parent);
          parent.dataset.ppSocketWidgetPath = parent === widgetsRoot ? "root" : "true";
          if (parent === widgetsRoot) break;
        }
      });
      rail.outputElements.forEach((element, index) => {
        const keyedIndex = slotIndexFromVueSocket(element, this.node?.id, "output");
        const slot = keyedIndex >= 0 ? outputSlots[keyedIndex] : outputSlots[index];
        const hidden = !slot || !outputGroups.visibleSet.has(slot);
        if (!hidden) visibleCount += 1;
        present(element, slot, "output", hidden);
      });
      // Some host versions briefly mount both widget and NodeSlots versions of
      // the same index. Present each real socket once, without cloning or moving it.
      for (const element of allSocketElements) {
        if (touched.has(element)) continue;
        const kind = element.classList.contains('lg-slot--input') ? "input" : "output";
        const index = slotIndexFromVueSocket(element, this.node.id, kind);
        if (index < 0) continue;
        const slot = (kind === "input" ? this.node.inputs : this.node.outputs)?.[index];
        const visible = (kind === "input" ? inputGroups : outputGroups).visibleSet.has(slot);
        present(element, slot, kind, !slot || !visible);
      }
      rail.root.dataset.ppSocketRail = "true";
      rail.root.dataset.ppSocketEmpty = visibleCount === 0 ? "true" : "false";
      rail.root.dataset.ppSocketCompact = showLabels ? "false" : "true";
      if (rail.inputGroup) rail.inputGroup.dataset.ppSocketRailGroup = "input";
      if (rail.outputGroup) rail.outputGroup.dataset.ppSocketRailGroup = "output";
      nodeElement.dataset.ppSocketRailBody = "true";
      nodeElement.dataset.ppSocketCompact = showLabels ? "false" : "true";
      nodeElement.dataset.ppSocketNativeCollapsed = this.node.flags?.collapsed ? "true" : "false";
      rail.body.dataset.ppSocketBody = "true";
      rail.body.style.setProperty("--pp-socket-rail-height", `${compact.height}px`);
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
    this.lastSyncedElements = [];
    this.inSync = false;
    this.mode = null;
    this.releaseDom();
    this.vueNode = null;
    this.lastMissEpoch = -1;
  }
}

export function nodes2ObserverCount() { return lifecycleObserver.count(); }
