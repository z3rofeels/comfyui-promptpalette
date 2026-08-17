import {
  RendererAdapter, IO_SLOT_HEIGHT, IO_RAIL_GAP, HIDDEN_SOCKET_LABEL,
  nodeActive, socketDisplayLabel, managedSocketGroups,
  ensureSchemaSocket, rememberSocketState, restoreSocketState, frame, cancelFrame,
} from "./base_renderer_adapter.js";

export class ClassicRendererAdapter extends RendererAdapter {
  constructor(node, { labelsShown = () => false, onLayout = null } = {}) {
    super(node);
    this.labelsShown = labelsShown;
    this.onLayout = onLayout;
    this.inputDefs = [];
    this.outputDefs = [];
    this.layoutFrame = 0;
    this.signature = "";
    this.inLayout = false;
  }

  install(inputDefs = [], outputDefs = []) {
    this.inputDefs = inputDefs;
    this.outputDefs = outputDefs;
    this.node._wgInputDefs = inputDefs;
    this.node._wgOutputDefs = outputDefs;
    for (const def of inputDefs) ensureSchemaSocket(this.node, "input", def);
    for (const def of outputDefs) ensureSchemaSocket(this.node, "output", def);
    this.requestLayout();
  }

  hideSocket(kind, def, hidden) {
    const slot = ensureSchemaSocket(this.node, kind, def);
    if (!slot) return;
    slot.ppHidden = !!hidden;
    this.requestLayout();
  }

  requestLayout() {
    if (!nodeActive(this.node) || this.layoutFrame) return;
    this.layoutFrame = frame(() => {
      this.layoutFrame = 0;
      if (nodeActive(this.node)) this.layout();
    });
  }

  layout() {
    const node = this.node;
    if (!nodeActive(node) || this.inLayout) return false;
    this.inLayout = true;
    try {
    const width = Math.max(180, Number(node.size?.[0]) || 180);
    const slotHeight = Number(globalThis.LiteGraph?.NODE_SLOT_HEIGHT) || IO_SLOT_HEIGHT;
    const startY = Number(node.constructor?.slot_start_y ?? node.slot_start_y ?? 0) || 0;
    const showLabels = !!this.labelsShown();
    const inputGroups = managedSocketGroups(node.inputs, this.inputDefs, "input");
    const outputGroups = managedSocketGroups(node.outputs, this.outputDefs, "output");
    const visibleInputs = inputGroups.visible;
    const visibleOutputs = outputGroups.visible;
    const hiddenInputs = inputGroups.hidden;
    const hiddenOutputs = outputGroups.hidden;
    const signature = JSON.stringify([
      width, startY, showLabels,
      visibleInputs.map((slot) => slot?.name), visibleOutputs.map((slot) => slot?.name),
      hiddenInputs.map((slot) => slot?.name), hiddenOutputs.map((slot) => slot?.name),
    ]);
    if (signature === this.signature) { this.onLayout?.(false); return false; }
    this.signature = signature;

    for (const slot of [...visibleInputs, ...visibleOutputs, ...hiddenInputs, ...hiddenOutputs]) rememberSocketState(slot);

    const placeCompact = (slots, output, defs) => {
      const available = Math.max(36, width * 0.46 - 18);
      const spacing = slots.length <= 1 ? 0 : Math.min(18, available / (slots.length - 1));
      slots.forEach((slot, index) => {
        slot.ppHidden = false;
        slot.color_on = undefined;
        slot.color_off = undefined;
        slot.label = HIDDEN_SOCKET_LABEL;
        slot.localized_name = HIDDEN_SOCKET_LABEL;
        slot.pos = [output ? width - 12 - index * spacing : 12 + index * spacing, -1];
        slot.__ppSocketRailTitle = socketDisplayLabel(slot, defs);
      });
    };
    const placeLabeled = (slots, output, defs) => {
      slots.forEach((slot, index) => {
        const label = socketDisplayLabel(slot, defs);
        slot.ppHidden = false;
        slot.color_on = undefined;
        slot.color_off = undefined;
        slot.label = label;
        slot.localized_name = label;
        slot.pos = [output ? width : 0, startY + (index + 0.7) * slotHeight];
        slot.__ppSocketRailTitle = label;
      });
    };
    const hideSlots = (slots, output) => {
      slots.forEach((slot, index) => {
        slot.ppHidden = true;
        slot.label = HIDDEN_SOCKET_LABEL;
        slot.localized_name = HIDDEN_SOCKET_LABEL;
        slot.color_on = "rgba(0,0,0,0)";
        slot.color_off = "rgba(0,0,0,0)";
        const margin = slotHeight * 2;
        slot.pos = [output ? width + margin : -margin, -slotHeight - index];
      });
    };

    if (showLabels) {
      placeLabeled(visibleInputs, false, this.inputDefs);
      placeLabeled(visibleOutputs, true, this.outputDefs);
    } else {
      placeCompact(visibleInputs, false, this.inputDefs);
      placeCompact(visibleOutputs, true, this.outputDefs);
    }
    hideSlots(hiddenInputs, false);
    hideSlots(hiddenOutputs, true);

    if (!("_wgOriginalWidgetsStartY" in node)) node._wgOriginalWidgetsStartY = node.widgets_start_y;
    const originalStart = Number(node._wgOriginalWidgetsStartY);
    const baseStart = Number.isFinite(originalStart) ? originalStart : startY;
    const labeledRows = showLabels ? Math.max(visibleInputs.length, visibleOutputs.length) : 0;
    node.widgets_start_y = labeledRows ? Math.max(baseStart, startY + labeledRows * slotHeight + IO_RAIL_GAP) : baseStart;
    node.graph?.setDirtyCanvas?.(true, true);
    node.setDirtyCanvas?.(true, true);
    this.onLayout?.(true);
    return true;
    } finally {
      this.inLayout = false;
    }
  }

  cleanup() {
    cancelFrame(this.layoutFrame);
    this.layoutFrame = 0;
    this.signature = "";
    this.inLayout = false;
    for (const slot of [...(this.node?.inputs || []), ...(this.node?.outputs || [])]) restoreSocketState(slot);
    if (this.node && "_wgOriginalWidgetsStartY" in this.node) {
      this.node.widgets_start_y = this.node._wgOriginalWidgetsStartY;
      delete this.node._wgOriginalWidgetsStartY;
    }
  }
}
