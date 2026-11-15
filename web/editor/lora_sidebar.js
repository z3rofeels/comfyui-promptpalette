import { createLoraPicker } from "./lora_picker.js";

// The sidebar mounts the same LoraPal tools against its existing editing target.
// No hidden textarea or second prompt state: all writes pass through sidebarInsert.
export function createLoraSidebar(host, { target, selection, presentation, uiScale, announce }) {
  let picker = null, boundTarget = null, boundEditor = null, captured = null, snapshot = null, active = false;
  const toolbar = document.createElement("div"); toolbar.className = "pp-sidebar-actions";
  const cursor = document.createElement("button"); cursor.type = "button"; cursor.textContent = "Use cursor / selection";
  cursor.title = "Capture the selected prompt’s current cursor or LoRA tag for insertion or swapping";
  const hint = document.createElement("p"); hint.className = "pp-sidebar-note";
  const body = document.createElement("div"); body.className = "pp-sidebar-lora-body";
  toolbar.append(cursor); host.append(toolbar, hint, body);
  function readSelection(t = target() || null) {
    if (!t) throw new Error("Choose a target prompt below.");
    if (t.handlers.sidebarLoraTarget) {
      const resolved = t.handlers.sidebarLoraTarget();
      if (!resolved?.editor?.isConnected) throw new Error("Choose a prompt node or text field above.");
      if (resolved.readOnly) throw new Error("Choose an editable prompt field in the node first.");
      return resolved;
    }
    return selection();
  }
  function syncUiState(t) {
    cursor.disabled = !captured;
    hint.textContent = !captured ? "Browse your local LoRAs. Choose a target below to insert or test."
      : t?.handlers.sidebarRequiresResolvedText
      ? "Text insertion only. This field needs a compatible LoRA loader; Palette’s patched MODEL/CLIP outputs apply LoRAs."
      : "Select LoRAs to build a stack or strength trial. Use the active deck to swap, mute or edit strengths.";
  }
  function refresh(force = false) {
    if (!active) return;
    const nextTarget = target() || null;
    const nextLora = nextTarget?.handlers.sidebarLoraTarget?.() || null;
    const nextEditor = nextLora?.editor || nextTarget?.handlers.sidebarEditor?.() || null;
    if (picker && !force && nextTarget === boundTarget && nextEditor === boundEditor) {
      if (!captured && nextTarget) {
        try {
          captured = readSelection(nextTarget);
          if (captured && snapshot) Object.assign(snapshot, { source: captured.source, start: captured.start, end: captured.end });
        } catch {
          captured = null;
        }
      }
      syncUiState(nextTarget);
      return;
    }
    const draft = picker?.draft();
    picker?.cleanup(); body.replaceChildren();
    boundTarget = nextTarget; boundEditor = nextEditor;
    captured = null;
    try { if (nextTarget) captured = readSelection(nextTarget); } catch { /* Catalog remains browsable. */ }
    syncUiState(nextTarget);
    // Widget-only renderers expose no DOM editor. Read their authoritative widget
    // through the existing selection boundary, and guard every write against it.
    const editor = nextEditor || {
      get value() { try { return nextTarget ? readSelection(nextTarget).source : ""; } catch { return ""; } },
      get selectionStart() { try { return readSelection(nextTarget).start; } catch { return 0; } },
      get selectionEnd() { try { return readSelection(nextTarget).end; } catch { return 0; } },
      readOnly: !captured, disabled: false, getAttribute: () => null,
      addEventListener() {}, removeEventListener() {}, focus() {},
    };
    snapshot = { source: captured?.source || "", start: captured?.start || 0, end: captured?.end || 0 };
    const guard = () => {
      if (!nextTarget || target() !== nextTarget) throw new Error("Choose a target prompt below.");
      const live = readSelection(nextTarget);
      if (live.editor !== captured?.editor || live.source !== snapshot.source) throw new Error("The prompt changed. Use cursor / selection to capture it again.");
    };
    picker = createLoraPicker({ host: body, editor, snapshot, draft,
      context: { node: nextTarget?.handlers.sidebarRequiresResolvedText ? null : nextTarget?.node,
        apply(next, start, end) {
          guard();
          const live = readSelection(nextTarget);
          nextTarget.handlers.sidebarInsert({ ...live, start: 0, end: live.source.length }, next, [start, end], { focus: false });
        } },
      applied(next) {
        Object.assign(snapshot, next);
        if (captured) captured = { ...captured, source: next.source, start: next.start, end: next.end };
      },
      guard, close() {}, message: announce, keepOpen: true, sidebar: { presentation, uiScale } });
  }
  cursor.addEventListener("click", () => {
    try {
      const nextTarget = target() || null;
      const live = readSelection(nextTarget);
      refresh();
      captured = live;
      if (snapshot) Object.assign(snapshot, { source: live.source, start: live.start, end: live.end });
      syncUiState(nextTarget);
      picker?.syncTarget({ start: live.start, end: live.end });
      announce("Captured the target’s current cursor or selection.");
    } catch (error) { announce(error.message, true); }
  });
  return {
    activate(value) { active = value; picker?.setActive(active); if (active) { refresh(); picker?.refreshAppearance(); } },
    refresh,
    refreshAppearance() { if (active) picker?.refreshAppearance(); },
    cleanup() { picker?.cleanup(); toolbar.remove(); hint.remove(); body.remove(); },
  };
}
