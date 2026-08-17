class DomMountPoint {
  constructor(element, name) {
    this.element = element;
    this.anchor = typeof document !== "undefined" ? document.createComment(`prompt-palette:${name}`) : null;
    this.parent = element?.parentNode || null;
    this.next = element?.nextSibling || null;
    this.mounted = !!element?.isConnected;
  }
  unmount() {
    if (!this.element?.parentNode || !this.anchor) { this.mounted = false; return; }
    this.element.parentNode.replaceChild(this.anchor, this.element);
    this.mounted = false;
  }
  mount() {
    if (!this.anchor?.parentNode || !this.element) { this.mounted = !!this.element?.isConnected; return; }
    this.anchor.parentNode.replaceChild(this.element, this.anchor);
    this.mounted = true;
  }
  cleanup() {
    if (this.anchor?.parentNode) this.mount();
    this.anchor = null; this.parent = null; this.next = null;
  }
}

export class PromptPaletteToolRegistry {
  constructor({ onChange = null } = {}) {
    this.tools = new Map();
    this.onChange = onChange;
  }
  register(definition) {
    const id = String(definition?.id || "").trim();
    if (!id) throw new Error("Prompt Palette tool id is required");
    if (this.tools.has(id)) throw new Error(`Prompt Palette tool already registered: ${id}`);
    const mounts = (definition.elements || []).filter(Boolean).map((element, index) => new DomMountPoint(element, `${id}:${index}`));
    const tool = { ...definition, id, mounts, enabled: true, mounted: mounts.every((m) => m.mounted) };
    this.tools.set(id, tool);
    return tool;
  }
  setEnabled(id, enabled, context = {}) {
    const tool = this.tools.get(id); if (!tool) return false;
    const next = !!enabled;
    if (tool.enabled === next && tool.mounted === next) return next;
    tool.enabled = next;
    if (next) {
      for (const mount of tool.mounts) mount.mount();
      tool.mount?.(context);
      tool.mounted = true;
    } else {
      tool.unmount?.(context);
      for (const mount of tool.mounts) mount.unmount();
      tool.mounted = false;
    }
    this.onChange?.(tool, next);
    return next;
  }
  get(id) { return this.tools.get(id) || null; }
  enabled(id) { return this.tools.get(id)?.enabled === true; }
  snapshot() { return Object.fromEntries(Array.from(this.tools, ([id, tool]) => [id, { enabled: tool.enabled, mounted: tool.mounted, elementCount: tool.mounts.length }])); }
  cleanup() { for (const tool of this.tools.values()) { try { tool.unmount?.({ cleanup: true }); } catch {} for (const mount of tool.mounts) mount.cleanup(); } this.tools.clear(); }
}

export function createToolRegistry(options) { return new PromptPaletteToolRegistry(options); }
