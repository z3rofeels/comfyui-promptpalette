import { socketConnected, socketDisplayLabel } from "./base_renderer_adapter.js";
import { copyPromptPaletteThemeScope, positionPromptPaletteTip } from "../prompt_palette_shared.js";

// Feedback only: use native slot lookup, never capture or cancel pointer events.
export class SocketHover {
  constructor(node) {
    this.node = node;
    this.tip = null;
    this.hide = () => {
      if (this.tip) this.tip.hidden = true;
      globalThis.document?.removeEventListener("pointerdown", this.hide, true);
    };
  }
  show(event, slot, kind, defs) {
    if (!slot || slot.ppHidden && !socketConnected(kind, slot, this.node) || event.buttons
      || this.node.flags?.collapsed || this.node.collapsed
      || this.node.graph?.canvas?.linkConnector?.isConnecting) return this.hide();
    const doc = globalThis.document;
    if (!doc?.body || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
    if (!this.tip) {
      this.tip = doc.createElement("div");
      this.tip.hidden = true;
      this.tip.className = "wg-tip pp-socket-tip";
      this.tip.dataset.promptPaletteHover = "true";
      this.tip.dataset.promptPaletteOwner = String(this.node.id ?? "node");
      this.tip.setAttribute("role", "tooltip");
      doc.body.append(this.tip);
    }
    const name = String(slot.name ?? "Socket");
    const label = socketDisplayLabel(slot, defs);
    const status = socketConnected(kind, slot, this.node) ? "Connected" : "Not connected";
    const text = `${label}${label === name ? "" : ` · ${name}`}\n${String(slot.type ?? "*")} · ${status}`;
    if (this.tip.textContent !== text) this.tip.textContent = text;
    const scope = this.node._wgSocketDomRoot;
    if (scope && this.tip.hidden) copyPromptPaletteThemeScope(scope, this.tip);
    this.tip.hidden = false;
    positionPromptPaletteTip(this.tip, event.clientX, event.clientY);
    doc.addEventListener("pointerdown", this.hide, true);
  }
  cleanup() { this.hide(); this.tip?.remove(); this.tip = null; }
}
