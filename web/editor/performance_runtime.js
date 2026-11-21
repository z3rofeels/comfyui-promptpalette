import { readEditorPreference, writeEditorPreference } from "../prompt_palette_state.js";

const PREF_KEY = "performanceDiagnostics";
const SAMPLE_LIMIT = 180;

function now() { return globalThis.performance?.now?.() ?? Date.now(); }

class Metric {
  constructor() { this.samples = []; this.total = 0; this.max = 0; this.count = 0; }
  push(value) {
    const n = Math.max(0, Number(value) || 0);
    this.samples.push(n);
    if (this.samples.length > SAMPLE_LIMIT) this.samples.shift();
    this.total += n;
    this.count += 1;
    this.max = Math.max(this.max, n);
  }
  snapshot() {
    const recentTotal = this.samples.reduce((sum, value) => sum + value, 0);
    return {
      count: this.count,
      average: this.samples.length ? recentTotal / this.samples.length : 0,
      worst: this.max,
      last: this.samples.at(-1) || 0,
    };
  }
}

export class PromptPaletteProfiler {
  constructor(node, enabled = false) {
    this.node = node;
    this.enabled = !!enabled;
    this.metrics = new Map();
    this.counters = new Map();
    this.gauges = new Map();
    this.startedAt = now();
  }
  setEnabled(enabled) { this.enabled = !!enabled; }
  measure(name, fn) {
    if (!this.enabled) return fn();
    const start = now();
    try { return fn(); }
    finally { this.record(name, now() - start); }
  }
  async measureAsync(name, fn) {
    if (!this.enabled) return await fn();
    const start = now();
    try { return await fn(); }
    finally { this.record(name, now() - start); }
  }
  record(name, duration) {
    if (!this.enabled) return;
    if (!this.metrics.has(name)) this.metrics.set(name, new Metric());
    this.metrics.get(name).push(duration);
  }
  count(name, amount = 1) {
    if (!this.enabled) return;
    this.counters.set(name, (this.counters.get(name) || 0) + amount);
  }
  gauge(name, value) {
    if (!this.enabled) return;
    this.gauges.set(name, Number(value) || 0);
  }
  snapshot(extra = {}) {
    const metrics = Object.fromEntries(Array.from(this.metrics, ([key, metric]) => [key, metric.snapshot()]));
    return {
      enabled: this.enabled,
      uptimeMs: now() - this.startedAt,
      metrics,
      counters: Object.fromEntries(this.counters),
      gauges: Object.fromEntries(this.gauges),
      ...extra,
    };
  }
  reset() {
    this.metrics.clear();
    this.counters.clear();
    this.gauges.clear();
    this.startedAt = now();
  }
}

export function performanceDiagnosticsEnabled() {
  return readEditorPreference(PREF_KEY, false) === true;
}

export function setPerformanceDiagnosticsEnabled(enabled) {
  writeEditorPreference(PREF_KEY, !!enabled);
  return !!enabled;
}

// Portaled windows follow the existing DOM-widget geometry. Changes to that
// geometry arrive through its ancestry, resize and scroll events; an idle window
// does not need to measure the node every animation frame.
export function observePanelAnchor(anchor, onChange, { content = null } = {}) {
  let disposed = false, frame = null, ancestry = [];
  const raf = globalThis.requestAnimationFrame || (fn => setTimeout(fn, 0));
  const cancel = globalThis.cancelAnimationFrame || clearTimeout;
  const mutation = typeof MutationObserver === "function" ? new MutationObserver(schedule) : null;
  const resize = typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : null;
  function bind() {
    const next = [];
    for (let element = anchor; element; element = element.parentElement) next.push(element);
    if (next.length === ancestry.length && next.every((element, i) => element === ancestry[i])) return;
    mutation?.disconnect(); resize?.disconnect(); ancestry = next;
    for (const element of ancestry) {
      mutation?.observe(element, { attributes: true, attributeFilter: ["style", "class", "hidden", "aria-hidden"], childList: true });
      resize?.observe(element);
    }
    if (content) {
      mutation?.observe(content, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["style", "class", "hidden", "open"] });
      resize?.observe(content);
    }
  }
  function schedule() {
    if (disposed || frame !== null) return;
    frame = raf(() => {
      frame = null;
      if (disposed || document.hidden) return;
      bind(); onChange();
      // Follow a CSS transition smoothly, stopping as soon as it finishes.
      if (ancestry.some(element => element.getAnimations?.().some(animation => animation.playState === "running" && Number.isFinite(animation.effect?.getComputedTiming?.().endTime)))) schedule();
    });
  }
  const visibility = () => { if (!document.hidden) schedule(); };
  const transition = event => { if (ancestry.includes(event.target)) schedule(); };
  const onScroll = event => {
    const target = event?.target;
    if (!target || target === document || target === window || target === document.documentElement || target === document.body
      || (typeof target.contains === "function" && (target === anchor || target.contains(anchor)))) {
      schedule();
    }
  };
  window.addEventListener("resize", schedule, { passive: true });
  window.addEventListener("scroll", onScroll, { passive: true, capture: true });
  document.addEventListener("visibilitychange", visibility);
  document.addEventListener("transitionrun", transition, true);
  document.addEventListener("transitionend", transition, true);
  bind(); schedule();
  return () => {
    if (disposed) return;
    disposed = true;
    if (frame !== null) cancel(frame);
    frame = null; mutation?.disconnect(); resize?.disconnect(); ancestry = [];
    window.removeEventListener("resize", schedule);
    window.removeEventListener("scroll", onScroll, true);
    document.removeEventListener("visibilitychange", visibility);
    document.removeEventListener("transitionrun", transition, true);
    document.removeEventListener("transitionend", transition, true);
  };
}

export function createPerformanceRuntime({ node, root }) {
  const profiler = new PromptPaletteProfiler(node, performanceDiagnosticsEnabled());
  const frames = new Map();
  const timers = new Map();
  const requests = new Map();
  let viewportVisible = true;
  let viewportObserver = null;
  let onWake = null;
  let lastVisualActive = true;
  let disposed = false;

  const active = () => !disposed && !node?._ppLifecycle?.signal?.aborted;
  const rootDisplayed = () => {
    if (!root || root.isConnected === false) return false;
    const rects = root.getClientRects?.();
    if (rects && rects.length === 0) return false;
    return !root.closest?.('[hidden], [aria-hidden="true"]');
  };
  const visualActive = () => active()
    && !node?.flags?.collapsed
    && viewportVisible
    && (typeof document === "undefined" || document.visibilityState !== "hidden")
    && rootDisplayed();
  const surfaceActive = (surface) => visualActive()
    && !!surface
    && surface.isConnected !== false
    && surface.hidden !== true
    && surface.getAttribute?.("aria-hidden") !== "true"
    && !surface.hasAttribute?.("inert");

  function wakeIfNeeded() {
    const nextActive = visualActive();
    const woke = !lastVisualActive && nextActive;
    lastVisualActive = nextActive;
    profiler.gauge("viewportVisible", viewportVisible ? 1 : 0);
    if (woke) onWake?.();
  }

  if (typeof IntersectionObserver !== "undefined" && root) {
    viewportObserver = new IntersectionObserver((entries) => {
      viewportVisible = entries.some((entry) => entry.isIntersecting || entry.intersectionRatio > 0);
      wakeIfNeeded();
    }, { root: null, rootMargin: "500px" });
    viewportObserver.observe(root);
  }

  const handleVisibilityChange = () => wakeIfNeeded();
  if (typeof document !== "undefined") document.addEventListener?.("visibilitychange", handleVisibilityChange);
  lastVisualActive = visualActive();

  function scheduleFrame(key, fn, { visual = true } = {}) {
    if (!active()) return null;
    if (frames.has(key)) return frames.get(key);
    const callback = () => {
      frames.delete(key);
      profiler.gauge("scheduledFrames", frames.size);
      if (!active()) return;
      if (visual && !visualActive()) {
        profiler.count("framesSkippedInactive");
        return;
      }
      profiler.measure(`frame:${key}`, fn);
    };
    const handle = typeof globalThis.requestAnimationFrame === "function"
      ? globalThis.requestAnimationFrame(callback)
      : setTimeout(callback, 0);
    frames.set(key, handle);
    profiler.gauge("scheduledFrames", frames.size);
    return handle;
  }

  function debounce(key, delay, fn, { visual = false } = {}) {
    if (!active()) return null;
    const existing = timers.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      timers.delete(key);
      profiler.gauge("scheduledTimers", timers.size);
      if (!active()) return;
      if (visual && !visualActive()) {
        profiler.count("timersSkippedInactive");
        return;
      }
      profiler.measure(`timer:${key}`, fn);
    }, Math.max(0, Number(delay) || 0));
    timers.set(key, timer);
    profiler.gauge("scheduledTimers", timers.size);
    return timer;
  }

  function cancelTimer(key) {
    const timer = timers.get(key);
    if (!timer) return;
    clearTimeout(timer);
    timers.delete(key);
    profiler.gauge("scheduledTimers", timers.size);
  }

  function beginRequest(key) {
    requests.get(key)?.abort?.();
    const controller = new AbortController();
    if (!active()) { controller.abort(); return controller; }
    requests.set(key, controller);
    profiler.gauge("outstandingRequests", requests.size);
    return controller;
  }

  function endRequest(key, controller) {
    if (requests.get(key) === controller) requests.delete(key);
    profiler.gauge("outstandingRequests", requests.size);
  }

  function abortRequest(key) {
    const controller = requests.get(key);
    if (!controller) return;
    controller.abort();
    requests.delete(key);
    profiler.gauge("outstandingRequests", requests.size);
  }

  function snapshot(extra = {}) {
    return profiler.snapshot({
      activeTimers: timers.size + (node?._ppLifecycleTimers?.size || 0),
      activeFrames: frames.size,
      outstandingRequests: requests.size,
      viewportVisible,
      nodeCollapsed: !!node?.flags?.collapsed,
      rootDisplayed: rootDisplayed(),
      ...extra,
    });
  }

  function cleanup() {
    if (disposed) return;
    disposed = true; onWake = null;
    if (typeof document !== "undefined") document.removeEventListener?.("visibilitychange", handleVisibilityChange);
    viewportObserver?.disconnect();
    viewportObserver = null;
    for (const handle of frames.values()) {
      if (typeof globalThis.cancelAnimationFrame === "function") globalThis.cancelAnimationFrame(handle);
      else clearTimeout(handle);
    }
    frames.clear();
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    for (const controller of requests.values()) controller.abort();
    requests.clear();
  }

  return {
    profiler,
    visualActive,
    surfaceActive,
    scheduleFrame,
    debounce,
    cancelTimer,
    beginRequest,
    endRequest,
    abortRequest,
    snapshot,
    setOnWake(callback) { onWake = typeof callback === "function" ? callback : null; },
    cleanup,
  };
}
