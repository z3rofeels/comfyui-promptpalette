const DEFAULT_CHANNELS = ["prompt", "theme", "library", "socket", "layout", "seed", "preview", "doctor", "workspace", "accessibility"];

function nextFrame(callback) {
  const raf = globalThis.requestAnimationFrame;
  return typeof raf === "function" ? raf(callback) : setTimeout(callback, 0);
}
function cancelFrame(handle) {
  if (!handle) return;
  if (typeof globalThis.cancelAnimationFrame === "function") globalThis.cancelAnimationFrame(handle);
  else clearTimeout(handle);
}

export class PromptPaletteReactiveRuntime {
  constructor({ node = null, profiler = null, visualActive = () => true } = {}) {
    this.node = node;
    this.profiler = profiler;
    this.visualActive = visualActive;
    this.channels = new Map(DEFAULT_CHANNELS.map((name) => [name, new Set()]));
    this.pending = new Map();
    this.frames = new Map();
    this.microtasks = new Set();
    this.batchDepth = 0;
    this.batched = new Map();
    this.disposed = false;
    this.state = new Map();
    this.versions = new Map(DEFAULT_CHANNELS.map((name) => [name, 0]));
  }

  signal(name, initialValue) {
    if (!this.state.has(name)) this.state.set(name, initialValue);
    return {
      get: () => this.state.get(name),
      set: (value, { channel = name, equals = Object.is } = {}) => {
        const previous = this.state.get(name);
        if (equals(previous, value)) return false;
        this.state.set(name, value);
        this.invalidate(channel, { value, previous, signal: name });
        return true;
      },
    };
  }

  subscribe(channels, callback, { schedule = "frame", visual = true, key = null } = {}) {
    const list = Array.isArray(channels) ? channels : [channels];
    const effect = { callback, schedule, visual, key: key || `effect-${Math.random().toString(36).slice(2)}`, channels: list };
    for (const channel of list) {
      if (!this.channels.has(channel)) this.channels.set(channel, new Set());
      this.channels.get(channel).add(effect);
    }
    return () => { for (const channel of list) this.channels.get(channel)?.delete(effect); };
  }

  batch(callback) {
    this.batchDepth += 1;
    try { return callback(); }
    finally {
      this.batchDepth -= 1;
      if (this.batchDepth === 0 && this.batched.size) {
        const pending = Array.from(this.batched.entries());
        this.batched.clear();
        for (const [channel, payload] of pending) this.invalidate(channel, payload);
      }
    }
  }

  invalidate(channel, payload = null) {
    if (this.disposed) return;
    if (this.batchDepth > 0) { this.batched.set(channel, payload); return; }
    this.versions.set(channel, (this.versions.get(channel) || 0) + 1);
    const effects = this.channels.get(channel);
    if (!effects?.size) return;
    for (const effect of effects) this._schedule(effect, channel, payload);
  }

  _schedule(effect, channel, payload) {
    if (this.disposed) return;
    const key = effect.key;
    const existing = this.pending.get(key) || { channels: new Set(), payloads: new Map() };
    existing.channels.add(channel);
    existing.payloads.set(channel, payload);
    this.pending.set(key, existing);

    if (effect.schedule === "sync") return this._run(effect);
    if (effect.schedule === "microtask") {
      if (this.microtasks.has(key)) return;
      this.microtasks.add(key);
      queueMicrotask(() => { this.microtasks.delete(key); this._run(effect); });
      return;
    }
    if (this.frames.has(key)) return;
    const handle = nextFrame(() => { this.frames.delete(key); this._run(effect); });
    this.frames.set(key, handle);
  }

  _run(effect) {
    if (this.disposed) return;
    if (effect.visual && !this.visualActive()) {
      this.profiler?.count?.("reactiveEffectsSkippedInactive");
      return;
    }
    const pending = this.pending.get(effect.key) || { channels: new Set(), payloads: new Map() };
    this.pending.delete(effect.key);
    const info = {
      channels: Array.from(pending.channels),
      payloads: pending.payloads,
      versions: Object.fromEntries(Array.from(this.versions)),
    };
    const run = () => effect.callback(info);
    if (this.profiler?.measure) this.profiler.measure(`reactive:${effect.key}`, run); else run();
    this.profiler?.count?.("reactiveEffects");
  }

  version(channel) { return this.versions.get(channel) || 0; }

  snapshot() {
    return {
      channels: Object.fromEntries(Array.from(this.channels, ([name, effects]) => [name, effects.size])),
      pendingEffects: this.pending.size,
      scheduledFrames: this.frames.size,
      scheduledMicrotasks: this.microtasks.size,
      versions: Object.fromEntries(this.versions),
    };
  }

  cleanup() {
    this.disposed = true;
    for (const handle of this.frames.values()) cancelFrame(handle);
    this.frames.clear(); this.microtasks.clear(); this.pending.clear(); this.batched.clear();
    for (const effects of this.channels.values()) effects.clear();
    this.channels.clear(); this.state.clear();
  }
}

export function createReactiveRuntime(options) { return new PromptPaletteReactiveRuntime(options); }
