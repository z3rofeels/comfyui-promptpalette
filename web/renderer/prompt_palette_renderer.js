import { ClassicRendererAdapter } from "./classic_renderer_adapter.js";
import { Nodes2RendererAdapter, nodes2ObserverCount } from "./nodes2_renderer_adapter.js";
import { ensureSchemaSocket, serializeSocketRail, nodeActive } from "./base_renderer_adapter.js";
import { SocketHover } from "./socket_hover.js";

const adapters = new WeakMap();

export class PromptPaletteRenderer {
  constructor(node, options = {}) {
    this.node = node;
    this.hover = new SocketHover(node);
    this.classic = new ClassicRendererAdapter(node, { ...options,
      isNodes2: () => !!this.nodes2.findVueNode(), onLayout: () => this.nodes2.requestSyncIfActive() });
    this.nodes2 = new Nodes2RendererAdapter(node, { ...options, hover: this.hover });
    this.hooks = [];
    this.inputDefs = [];
    this.outputDefs = [];
  }
  install(inputDefs = [], outputDefs = [], domRoot = null) {
    this.inputDefs = inputDefs;
    this.outputDefs = outputDefs;
    this.domRoot = domRoot;
    this.node._wgSocketDomRoot = domRoot;
    this.classic.install(inputDefs, outputDefs);
    this.nodes2.install(inputDefs, outputDefs);
    if (!this.hooks.length) this.installHooks();
    return this;
  }
  installHooks() {
    const clipSockets = ctx => {
      // Hidden legacy slots are parked outside the node for native hit testing.
      // Transparent fill alone cannot suppress host outlines or multi-type dots.
      ctx.beginPath();
      ctx.rect(-16, -(Number(globalThis.LiteGraph?.NODE_TITLE_HEIGHT) || 30),
        (Number(this.node.size?.[0]) || 180) + 32,
        (Number(this.node.size?.[1]) || 0) + (Number(globalThis.LiteGraph?.NODE_TITLE_HEIGHT) || 30) + 16);
      ctx.clip();
    };
    const nativeDrawSlots = this.node.drawSlots;
    if (typeof nativeDrawSlots === "function") {
      const own = Object.hasOwn(this.node, "drawSlots");
      const renderer = this;
      const drawSlots = function (ctx, ...args) {
        // Vue already renders these exact slots. Never paint a second canvas rail.
        if (renderer.nodes2.findVueNode()) return;
        ctx.save();
        try { clipSockets(ctx); return nativeDrawSlots.call(this, ctx, ...args); }
        finally { ctx.restore(); }
      };
      this.node.drawSlots = drawSlots;
      this.hooks.push(() => {
        if (this.node.drawSlots !== drawSlots) return;
        if (own) this.node.drawSlots = nativeDrawSlots; else delete this.node.drawSlots;
      });
    }
    const wrap = (key, after) => {
      const original = this.node[key];
      const own = Object.hasOwn(this.node, key);
      const handler = function (...args) {
        const result = original?.apply(this, args);
        after(...args);
        return result;
      };
      this.node[key] = handler;
      this.hooks.push(() => {
        if (this.node[key] !== handler) return;
        if (own) this.node[key] = original; else delete this.node[key];
      });
    };
    if (typeof nativeDrawSlots !== "function") wrap("onDrawForeground", ctx => {
      if (this.node.flags?.collapsed || this.node.collapsed) return;
      // Older LiteGraph draws slots inline after onDrawForeground. Its caller
      // saves/restores the context per node, so this clip stays local to this node.
      if (this.nodes2.findVueNode()) { ctx.beginPath(); ctx.rect(0, 0, 0, 0); ctx.clip(); }
      else clipSockets(ctx);
    });
    wrap("onSerialize", data => serializeSocketRail(this.node, data));
    for (const key of ["onResize", "onConfigure", "onInputAdded", "onOutputAdded", "onInputRemoved", "onOutputRemoved"]) {
      wrap(key, () => {
        this.hover.hide(); this.requestLayout();
        if (key === "onConfigure") queueMicrotask(() => {
          if (nodeActive(this.node)) this.node._wgRefreshIoToggles?.();
        });
      });
    }
    if (typeof this.node.collapse === "function") wrap("collapse", () => {
      this.hover.hide(); this.requestLayout();
    });
    wrap("onMouseMove", (event, pos, canvas) => {
      if (this.nodes2.mode === "nodes2" || event.buttons || this.node.flags?.collapsed
        || canvas?.linkConnector?.isConnecting || canvas?.connecting_links?.length) return this.hover.hide();
      const x = Number(event.canvasX ?? (this.node.pos[0] + pos?.[0]));
      const y = Number(event.canvasY ?? (this.node.pos[1] + pos?.[1]));
      // Both APIs are native LiteGraph hit tests; no separate interaction regions.
      const found = this.node.getSlotOnPos?.([x, y]) ?? this.node.getSlotInPosition?.(x, y);
      const slot = found?.input || found?.output || found;
      const kind = this.node.inputs?.includes(slot) ? "input" : "output";
      if (!slot || !(kind === "input" ? this.node.inputs : this.node.outputs)?.includes(slot)) return this.hover.hide();
      this.hover.show(event, slot, kind, kind === "input" ? this.inputDefs : this.outputDefs);
    });
    wrap("onMouseLeave", () => this.hover.hide());
    this.labelChanged = () => this.requestLayout();
    // Native slot rename notification, where available. No graph recomputation.
    this.eventSource = this.node.graph?.events;
    this.eventSource?.addEventListener?.("node:slot-label:changed", this.labelChanged);
  }
  hideSocket(kind, def, hidden) { this.classic.hideSocket(kind, def, hidden); this.nodes2.requestSyncIfActive(); }
  requestLayout() { this.classic.requestLayout(); this.nodes2.requestSyncIfActive(); }
  sync() { this.nodes2.sync(); }
  isVisible() { return this.nodes2.findVueNode() ? this.nodes2.isVisible() : this.classic.isVisible(); }
  getViewportScale() { return this.classic.getViewportScale(); }
  snapshot() {
    const vueNode = this.nodes2.findVueNode();
    return { mode: vueNode ? "nodes2" : "classic", nodes2Mounted: !!vueNode, observerCount: nodes2ObserverCount(), viewportScale: this.getViewportScale() };
  }
  ensureSocket(kind, def) { return ensureSchemaSocket(this.node, kind, def); }
  cleanup() {
    this.hover.cleanup();
    this.eventSource?.removeEventListener?.("node:slot-label:changed", this.labelChanged);
    for (const cleanup of this.hooks.splice(0).reverse()) cleanup();
    this.nodes2.cleanup(); this.classic.cleanup();
  }
}

export function getPromptPaletteRenderer(node, options = {}) {
  let renderer = adapters.get(node);
  if (!renderer) { renderer = new PromptPaletteRenderer(node, options); adapters.set(node, renderer); node._ppRendererAdapter = renderer; }
  return renderer;
}

export function cleanupPromptPaletteRenderer(node) {
  const renderer = adapters.get(node) || node?._ppRendererAdapter;
  renderer?.cleanup?.();
  adapters.delete(node);
  if (node) delete node._ppRendererAdapter;
}
