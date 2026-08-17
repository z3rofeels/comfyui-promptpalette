import { ClassicRendererAdapter } from "./classic_renderer_adapter.js";
import { Nodes2RendererAdapter, nodes2ObserverCount } from "./nodes2_renderer_adapter.js";
import { ensureSchemaSocket } from "./base_renderer_adapter.js";

const adapters = new WeakMap();

export class PromptPaletteRenderer {
  constructor(node, options = {}) {
    this.node = node;
    this.classic = new ClassicRendererAdapter(node, { ...options, onLayout: () => this.nodes2.requestSync() });
    this.nodes2 = new Nodes2RendererAdapter(node, options);
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
    return this;
  }
  hideSocket(kind, def, hidden) { this.classic.hideSocket(kind, def, hidden); this.nodes2.requestSync(); }
  requestLayout() { this.classic.requestLayout(); this.nodes2.requestSync(); }
  sync() { this.nodes2.sync(); }
  isVisible() { return this.nodes2.findVueNode() ? this.nodes2.isVisible() : this.classic.isVisible(); }
  getViewportScale() { return this.classic.getViewportScale(); }
  snapshot() {
    const vueNode = this.nodes2.findVueNode();
    return { mode: vueNode ? "nodes2" : "classic", nodes2Mounted: !!vueNode, observerCount: nodes2ObserverCount(), viewportScale: this.getViewportScale() };
  }
  ensureSocket(kind, def) { return ensureSchemaSocket(this.node, kind, def); }
  cleanup() { this.nodes2.cleanup(); this.classic.cleanup(); }
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
