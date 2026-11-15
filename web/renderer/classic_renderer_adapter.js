import {
  RendererAdapter, IO_SLOT_HEIGHT, IO_RAIL_GAP, HIDDEN_SOCKET_LABEL,
  nodeActive, socketDisplayLabel, socketConnected, managedSocketGroups, presentSocket, presentationApplied, compactSocketLayout,
  ensureSchemaSocket, rememberSocketState, restoreSocketState, frame, cancelFrame,
} from "./base_renderer_adapter.js";

export class ClassicRendererAdapter extends RendererAdapter {
  constructor(node, { onLayout = null, labelsShown = () => false, isNodes2 = () => false } = {}) {
    super(node);
    this.onLayout = onLayout;
    this.labelsShown = labelsShown;
    this.isNodes2 = isNodes2;
    this.inputDefs = [];
    this.outputDefs = [];
    this.layoutFrame = 0;
    this.signature = "";
    this.inLayout = false;
    this.lastSlots = [];
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
      const inputGroups = managedSocketGroups(node.inputs, this.inputDefs, "input", node);
      const outputGroups = managedSocketGroups(node.outputs, this.outputDefs, "output", node);
      const visibleInputs = inputGroups.visible;
      const visibleOutputs = outputGroups.visible;
      const hiddenInputs = inputGroups.hidden;
      const hiddenOutputs = outputGroups.hidden;
      const slots = [...visibleInputs, ...visibleOutputs, ...hiddenInputs, ...hiddenOutputs];
      const expanded = !!this.labelsShown();
      // Vue owns its label text; compact CSS removes its label boxes completely.
      const showLabels = this.isNodes2() || expanded;
      const compact = compactSocketLayout(width, visibleInputs.length, visibleOutputs.length, slotHeight);
      const applied = slots.every((slot) => presentationApplied(slot));
      const signature = JSON.stringify([width, startY, slotHeight, expanded, showLabels,
        [visibleInputs, visibleOutputs, hiddenInputs, hiddenOutputs].map((group, i) => {
          const defs = i % 2 ? this.outputDefs : this.inputDefs;
          return group.map(slot => {
            const original = rememberSocketState(slot);
            return [slot.name, slot.type, socketDisplayLabel(slot, defs), [original.label, original.localized_name, original.pos, original.color_on, original.color_off], socketConnected(i % 2 ? "output" : "input", slot, node)];
          });
        }),
      ]);
      if (applied && signature === this.signature && slots.length === this.lastSlots.length
        && slots.every((slot, index) => slot === this.lastSlots[index])) return false;
      this.signature = signature;
      this.lastSlots = slots;

      const placeVisible = (slots, output, defs) => {
        slots.forEach((slot, index) => {
          const label = socketDisplayLabel(slot, defs);
          const original = slot.__ppSocketRailState;
          const hideLabel = !showLabels;
          presentSocket(slot, {
            color_on: original.color_on, color_off: original.color_off,
            // Classic has no portable label-visibility hook; empty text falls back
            // to name. Keep the sentinel confined to presentation and out of saves.
            label: hideLabel ? HIDDEN_SOCKET_LABEL : original.label ?? label,
            localized_name: hideLabel ? HIDDEN_SOCKET_LABEL : original.localized_name,
            pos: expanded ? [output ? width : 0, startY + (index + 0.7) * slotHeight]
              : (output ? compact.outputs : compact.inputs)[index],
          });
        });
      };
      const hideSlots = (slots, output) => {
        slots.forEach((slot, index) => {
          const margin = slotHeight * 2;
          presentSocket(slot, { label: HIDDEN_SOCKET_LABEL, localized_name: HIDDEN_SOCKET_LABEL,
            color_on: "rgba(0,0,0,0)", color_off: "rgba(0,0,0,0)",
            pos: [output ? width + margin : -margin, -slotHeight - index] });
        });
      };

      placeVisible(visibleInputs, false, this.inputDefs);
      placeVisible(visibleOutputs, true, this.outputDefs);
      hideSlots(hiddenInputs, false);
      hideSlots(hiddenOutputs, true);

      if (!("_wgOriginalWidgetsStartY" in node)) node._wgOriginalWidgetsStartY = node.widgets_start_y;
      const originalStart = Number(node._wgOriginalWidgetsStartY);
      const baseStart = Number.isFinite(originalStart) ? originalStart : startY;
      const labeledRows = expanded ? Math.max(visibleInputs.length, visibleOutputs.length) : 0;
      const widgetsStart = expanded
        ? labeledRows ? Math.max(baseStart, startY + labeledRows * slotHeight + IO_RAIL_GAP) : baseStart
        : Math.max(baseStart, compact.height);
      if (node.widgets_start_y !== widgetsStart) node.widgets_start_y = widgetsStart;
      if (node.setDirtyCanvas) node.setDirtyCanvas(true, true);
      else node.graph?.setDirtyCanvas?.(true, true);
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
    this.lastSlots = [];
    this.inLayout = false;
    for (const slot of [...(this.node?.inputs || []), ...(this.node?.outputs || [])]) restoreSocketState(slot);
    if (this.node && "_wgOriginalWidgetsStartY" in this.node) {
      this.node.widgets_start_y = this.node._wgOriginalWidgetsStartY;
      delete this.node._wgOriginalWidgetsStartY;
    }
  }
}
