// Text editors record one undo step per input event (coalesceMs: 0). A single paste, cut, drop
// or programmatic replacement fires one input event, so it stays one step. The limit is larger
// than the old 100 because keystroke-level history would otherwise cover very little typing.
export const TEXT_UNDO_LIMIT = 300;

export class EditorUndoManager {
  constructor({ initialValue = "", limit = 100, coalesceMs = 600, schedule = null, cancel = null, onState = null } = {}) {
    this.limit = Math.max(1, Number(limit) || 100);
    this.coalesceMs = Math.max(0, Number(coalesceMs) || 0);
    this.schedule = schedule || ((fn, ms) => setTimeout(fn, ms));
    this.cancel = cancel || ((handle) => clearTimeout(handle));
    this.onState = onState;
    this.undoStack = [];
    this.redoStack = [];
    this.lastValue = String(initialValue ?? "");
    this.burstStart = null;
    this.timer = null;
    this.holds = 0;
  }

  _changed() { this.onState?.(this.snapshot()); }
  _cancelTimer() { if (this.timer != null) this.cancel(this.timer); this.timer = null; }
  _pushUndo(value) {
    this.undoStack.push(String(value ?? ""));
    if (this.undoStack.length > this.limit) this.undoStack.splice(0, this.undoStack.length - this.limit);
  }

  reset(value = "") {
    this._cancelTimer();
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.lastValue = String(value ?? "");
    this.burstStart = null;
    this.holds = 0;
    this._changed();
  }

  // Keeps several notes (an IME composition) together as one step until release().
  hold() { this.holds += 1; }
  release() {
    if (this.holds > 0) this.holds -= 1;
    return this.holds === 0 ? this.flush() : false;
  }

  note(value) {
    const current = String(value ?? "");
    if (current === this.lastValue) return false;
    const stepwise = this.coalesceMs === 0 && this.holds === 0;
    if (stepwise) {
      this._cancelTimer();
      // Fold in any pending burst first so it keeps its own start value.
      if (this.burstStart !== null) { this._pushUndo(this.burstStart); this.burstStart = null; }
      this._pushUndo(this.lastValue);
      this.redoStack.length = 0;
      this.lastValue = current;
      this._changed();
      return true;
    }
    if (this.burstStart === null) this.burstStart = this.lastValue;
    this.redoStack.length = 0;
    this.lastValue = current;
    this._cancelTimer();
    if (this.holds > 0) { this._changed(); return true; }
    this.timer = this.schedule(() => { this.timer = null; this.flush(); }, this.coalesceMs);
    this._changed();
    return true;
  }

  flush() {
    this._cancelTimer();
    if (this.burstStart === null) return false;
    this._pushUndo(this.burstStart);
    this.burstStart = null;
    this._changed();
    return true;
  }

  undo(currentValue = this.lastValue) {
    this.flush();
    if (!this.undoStack.length) return null;
    this.redoStack.push(String(currentValue ?? ""));
    const value = this.undoStack.pop();
    this.lastValue = value;
    this._changed();
    return value;
  }

  redo(currentValue = this.lastValue) {
    this.flush();
    if (!this.redoStack.length) return null;
    this._pushUndo(String(currentValue ?? ""));
    const value = this.redoStack.pop();
    this.lastValue = value;
    this._changed();
    return value;
  }

  canUndo() { return this.undoStack.length > 0 || this.burstStart !== null; }
  canRedo() { return this.redoStack.length > 0; }
  snapshot() { return { undo: this.undoStack.length, redo: this.redoStack.length, pendingBurst: this.burstStart !== null }; }
  cleanup() { this._cancelTimer(); this.burstStart = null; this.holds = 0; }
}

export class ReversibleLibraryHistory {
  constructor({ limit = 30 } = {}) { this.limit = Math.max(1, Number(limit) || 30); this.entries = []; }
  push(entry) {
    if (!entry || typeof entry.undo !== "function") return false;
    this.entries.push(entry);
    if (this.entries.length > this.limit) this.entries.shift();
    return true;
  }
  canUndo() { return this.entries.length > 0; }
  peek() { return this.entries.at(-1) || null; }
  async undo() {
    const entry = this.entries.pop();
    if (!entry) return { ok: false, error: "Nothing to undo" };
    try {
      const result = await entry.undo();
      if (result?.ok === false) { this.entries.push(entry); return result; }
      return { ok: true, label: entry.label || "Library change undone", result };
    } catch (error) {
      this.entries.push(entry);
      return { ok: false, error: error?.message || "Could not undo library change" };
    }
  }
  clear() { this.entries.length = 0; }
}
