import { getPromptPaletteRenderer, cleanupPromptPaletteRenderer } from "./renderer/prompt_palette_renderer.js";
import { ensureSchemaSocket as rendererEnsureSchemaSocket } from "./renderer/base_renderer_adapter.js";
const IO_SLOT_HEIGHT = 20;
const HIDDEN_SOCKET_LABEL = "\u200B";

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  }[char]));
}

function nextFrame(callback) {
  const raf = globalThis.requestAnimationFrame;
  return typeof raf === "function" ? raf(callback) : setTimeout(callback, 0);
}

function cancelFrame(handle) {
  if (!handle) return;
  if (typeof globalThis.cancelAnimationFrame === "function") globalThis.cancelAnimationFrame(handle);
  else clearTimeout(handle);
}


function ensureNodeLifecycle(node) {
  if (node?._ppLifecycle) return node._ppLifecycle;
  const controller = new AbortController();
  const cleanups = new Set();
  const originalOnRemoved = node?.onRemoved;
  const lifecycle = {
    signal: controller.signal,
    add(cleanup) {
      if (typeof cleanup !== "function") return;
      if (controller.signal.aborted) {
        try { cleanup(); } catch (error) { console.error("Prompt Palette cleanup failed", error); }
      } else {
        cleanups.add(cleanup);
      }
    },
  };
  node._ppLifecycle = lifecycle;
  node.onRemoved = function () {
    if (!controller.signal.aborted) {
      controller.abort();
      for (const cleanup of cleanups) {
        try { cleanup(); } catch (error) { console.error("Prompt Palette cleanup failed", error); }
      }
      cleanups.clear();
    }
    return originalOnRemoved ? originalOnRemoved.apply(this, arguments) : undefined;
  };
  return lifecycle;
}

function nodeIsActive(node) {
  return !node?._ppLifecycle?.signal.aborted;
}

function scheduleNodeTimer(node, callback, delay = 0) {
  node._ppLifecycleTimers ||= new Set();
  const timer = setTimeout(() => {
    node._ppLifecycleTimers?.delete(timer);
    if (nodeIsActive(node)) callback();
  }, delay);
  node._ppLifecycleTimers.add(timer);
  return timer;
}

function cancelNodeTimer(node, timer) {
  if (timer == null) return;
  clearTimeout(timer);
  node?._ppLifecycleTimers?.delete(timer);
}

function clearNodeTimers(node) {
  for (const timer of node?._ppLifecycleTimers || []) clearTimeout(timer);
  node?._ppLifecycleTimers?.clear();
}

function scheduleNodeFrame(node, callback) {
  if (!node || !nodeIsActive(node)) return 0;
  node._ppLifecycleFrames ||= new Set();
  if (!node._ppLifecycleFrameCleanup) {
    node._ppLifecycleFrameCleanup = true;
    ensureNodeLifecycle(node).add(() => {
      for (const handle of node._ppLifecycleFrames || []) cancelFrame(handle);
      node._ppLifecycleFrames?.clear();
    });
  }
  const handle = nextFrame(() => {
    node._ppLifecycleFrames?.delete(handle);
    if (nodeIsActive(node)) callback();
  });
  node._ppLifecycleFrames.add(handle);
  return handle;
}

function nodeIsActuallyNodes2(node) {
  // `LiteGraph.vueNodesMode` is a global renderer capability flag, not a
  // reliable per-node ownership signal. ComfyUI can keep it true while a
  // node is still mounted through the legacy canvas renderer. Prompt Palette
  // must follow the renderer that actually owns this node.
  try {
    const snapshot = node?._ppRendererAdapter?.snapshot?.();
    if (snapshot?.mode === "nodes2") return true;
    if (snapshot?.mode === "classic") return false;
  } catch {}
  const nodeId = node?.id;
  if (nodeId != null && typeof document !== "undefined") {
    try {
      const escaped = String(nodeId).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      if (document.querySelector?.(`.lg-node[data-node-id="${escaped}"]`)) return true;
    } catch {}
  }
  // Before the Nodes 2 DOM mount exists, prefer the safe classic path. The
  // shared Nodes 2 renderer will call _wgRendererModeChanged after mounting
  // and reassert the widget-backed sockets from the real renderer state.
  return false;
}

function hideNativeWidget(widget, { keepSocketForNodes2 = false } = {}) {
  if (!widget) return;
  const node = widget?.__ppOwnerNode || widget?.node || widget?._node || null;
  widget.options ||= {};
  if (keepSocketForNodes2 && node) widget.__ppSocketRailCandidate = true;
  const keepNodes2Socket = !!keepSocketForNodes2 && !!node && nodeIsActuallyNodes2(node);
  widget.__ppSocketOnly = keepNodes2Socket ? true : !!widget.__ppSocketOnly;
  widget.hidden = !keepNodes2Socket;
  widget.options.hidden = !keepNodes2Socket;
  widget.options.canvasOnly = true;
  if (keepNodes2Socket) {
    widget.options.disabled = true;
    return;
  }

  // Nodes 2 honors canvasOnly/hidden in the Vue widget renderer. Classic
  // LiteGraph still lays out and draws native widgets from widget.type/draw/
  // computeSize, so keep the long-standing zero-size fallback there only.
  // Without it the hidden backing controls reappear above the themed DOM UI
  // and consume most of the node body (especially Combinatorial).
  if (!nodeIsActuallyNodes2(node)) {
    if (!widget._ppClassicHiddenState) {
      widget._ppClassicHiddenState = {
        type: widget.type,
        draw: widget.draw,
        computeSize: widget.computeSize,
      };
    }
    widget.type = "hidden";
    widget.draw = () => {};
    widget.computeSize = () => [0, -4];
  } else if (widget._ppClassicHiddenState) {
    // Switching a live workflow from Nodes 1 to Nodes 2 must not carry the
    // classic canvas fallback into Vue. Nodes 2 uses canvasOnly/hidden itself.
    widget.type = widget._ppClassicHiddenState.type;
    widget.draw = widget._ppClassicHiddenState.draw;
    widget.computeSize = widget._ppClassicHiddenState.computeSize;
  }

  if (widget.element?.style) {
    // Keep the direct assignment for older frontend contracts, then promote it
    // to !important because modern DOM-widget remounts may rewrite inline style.
    widget.element.style.display = "none";
    widget.element.style.setProperty("display", "none", "important");
    widget.element.hidden = true;
    widget.element.setAttribute?.("aria-hidden", "true");
  }
}

function scheduleDomWidgetVisualRefresh(node) {
  if (!node || !nodeIsActive(node) || node._ppDomVisualRefreshFrame) return;
  node._ppDomVisualRefreshFrame = scheduleNodeFrame(node, () => {
    node._ppDomVisualRefreshFrame = 0;
    if (!nodeIsActive(node)) return;
    const painted = node._wgRefreshVisuals?.();
    if (painted !== false || node._ppDomVisualRefreshRetry) {
      node._ppDomVisualRefreshRetry = false;
      return;
    }
    // A renderer switch can measure the widget one frame before its DOM frame is
    // attached. Retry once after attachment; never poll or own layout.
    node._ppDomVisualRefreshRetry = true;
    scheduleDomWidgetVisualRefresh(node);
  });
}

function installResponsiveDomWidgetWidth(node, widget) {
  if (!widget || widget._ppResponsiveWidthGuard) return widget;

  // ComfyUI frontend currently lets the Vue legacy-widget bridge write its
  // measured pixel width onto the shared widget object even while Nodes 1
  // (LiteGraph) is active. In Nodes 1 both the canvas widget renderer and the
  // DOM overlay treat an existing widget.width as authoritative, so that one
  // cross-renderer write freezes the DOM UI at a stale width after a move or
  // interaction.
  //
  // Prompt Palette never owns a node width here. In Nodes 1 this accessor
  // simply makes the Vue-only measurement absent, which restores ComfyUI's
  // native fallback to the live node width. In Nodes 2 the measured width is
  // stored/read normally. No pixel width, minimum, resize loop, or outer-node geometry mutation
  // is introduced. This mirrors the renderer ownership boundary of upstream
  // ComfyUI_frontend PR #12444, but only on Prompt Palette's own DOM widgets.
  const original = Object.getOwnPropertyDescriptor(widget, "width");
  if (original && original.configurable === false) return widget;

  let vueWidth;
  try {
    vueWidth = original?.get ? original.get.call(widget) : original?.value ?? widget.width;
  } catch {
    vueWidth = undefined;
  }

  const inVueNodesMode = () => nodeIsActuallyNodes2(node);
  Object.defineProperty(widget, "width", {
    configurable: true,
    enumerable: original?.enumerable ?? true,
    get() {
      if (!inVueNodesMode()) return undefined;
      if (original?.get) {
        try { return original.get.call(this); } catch { return vueWidth; }
      }
      return vueWidth;
    },
    set(value) {
      // Ignore the renderer-crossing write only while classic Nodes 1 is
      // active. The live node remains the sole width source in that mode.
      // A renderer mount/remeasure can also invalidate CSS Highlight ranges,
      // so schedule a visual repaint without mutating any geometry.
      if (!inVueNodesMode()) { scheduleDomWidgetVisualRefresh(node); return; }
      if (original?.set) {
        try { original.set.call(this, value); scheduleDomWidgetVisualRefresh(node); return; } catch {}
      }
      vueWidth = value;
      scheduleDomWidgetVisualRefresh(node);
    },
  });

  Object.defineProperty(widget, "_ppResponsiveWidthGuard", {
    value: true,
    configurable: true,
  });

  ensureNodeLifecycle(node).add(() => {
    try {
      delete widget._ppResponsiveWidthGuard;
      if (original) Object.defineProperty(widget, "width", original);
      else delete widget.width;
    } catch {}
  });
  return widget;
}

function getDomWidgetAvailableHeight(node, domWidget) {
  const bodyHeight = Number(node?._ppNodeGeometry?.restoringSize()?.[1] ?? node?.size?.[1]) || 0;
  const widgetY = Number.isFinite(domWidget?.y)
    ? Number(domWidget.y)
    : (Number(node?.widgets_start_y) || 0);
  return Math.max(0, bodyHeight - widgetY);
}

function numericNodeSize(value) {
  if (!value || typeof value.length !== "number" || value.length < 2) return null;
  const size = [Number(value[0]), Number(value[1])];
  return size.every(n => Number.isFinite(n) && n > 0) ? size : null;
}

// Keep a serialized size authoritative while its DOM widget is mounting. No
// ResizeObserver writes geometry, and no saved-height band is migrated. Outside
// configure/remount the frontend's live size remains the only source of truth.
function installNodeGeometryGuard(node) {
  if (!node || node._ppNodeGeometry) return node?._ppNodeGeometry;
  const lifecycle = ensureNodeLifecycle(node);
  const originals = { computeSize: node.computeSize, onConfigure: node.onConfigure, onSerialize: node.onSerialize };
  let target = null, surface = null, restoring = false, generation = 0, disposed = false;
  const frames = new Set();
  const stop = () => {
    restoring = false; generation++;
    for (const handle of frames) { cancelFrame(handle); node._ppLifecycleFrames?.delete(handle); }
    frames.clear();
    if (typeof document !== "undefined") {
      document.removeEventListener("pointerdown", stop, true);
      document.removeEventListener("keydown", stop, true);
    }
  };
  function queue(callback) {
    const handle = scheduleNodeFrame(node, () => { frames.delete(handle); callback(); });
    frames.add(handle);
  }
  function settle() {
    if (!surface || !restoring || disposed) return;
    const token = generation;
    queue(() => queue(() => {
      if (disposed || !nodeIsActive(node) || token !== generation || !restoring) return;
      try {
        const live = numericNodeSize(node.size);
        if (target && live && target.some((value, i) => Math.abs(value - live[i]) > 0.75)) {
          if (typeof node.setSize === "function") node.setSize([...target]);
          else node.size = [...target];
          node.graph?.setDirtyCanvas?.(true, true);
        }
      } finally { stop(); }
    }));
  }
  function restore(size) {
    const saved = numericNodeSize(size);
    if (!saved || disposed) return;
    stop(); target = saved; restoring = true;
    // Any user interaction ends restoration before a drag/key resize. A late
    // mount must never undo a user's intentional size change.
    if (typeof document !== "undefined") {
      document.addEventListener("pointerdown", stop, true);
      document.addEventListener("keydown", stop, true);
    }
    settle();
  }
  function naturalHeight() {
    const kind = node.comfyClass || node.type;
    const fallback = kind === "PromptPaletteCombinatorial" ? 240 : kind === "PromptPaletteWeightController" ? 180 : 140;
    const sockets = [...(node.inputs || []), ...(node.outputs || [])].filter(slot => !slot.ppHidden);
    const socketFloor = sockets.reduce((max, slot) => Math.max(max, Number(slot.pos?.[1]) + IO_SLOT_HEIGHT || 0), 0);
    const railHeight = Math.max(socketFloor, Number(node.widgets_start_y) || 0);
    const body = surface?.querySelector?.(".wg-body");
    if (!surface || typeof getComputedStyle !== "function") return Math.ceil(railHeight + fallback);
    const height = el => {
      if (!el || el.hidden || getComputedStyle(el).display === "none") return 0;
      const css = getComputedStyle(el);
      return el.offsetHeight + (parseFloat(css.marginTop) || 0) + (parseFloat(css.marginBottom) || 0);
    };
    if (!body) {
      const main = surface.querySelector?.(".ppwc-main");
      if (!main) return Math.ceil(railHeight + fallback);
      const css = getComputedStyle(main);
      const controls = Array.from(main.children).filter(el => !el.matches(".ppwc-editor-wrap"));
      const chrome = controls.reduce((sum, el) => sum + height(el), height(surface.querySelector(".ppwc-settings-row")) + height(surface.querySelector(".wg-io-rail")));
      const padding = (parseFloat(css.paddingTop) || 0) + (parseFloat(css.paddingBottom) || 0);
      const gaps = (parseFloat(css.rowGap) || 0) * controls.length;
      const textCSS = getComputedStyle(main.querySelector(".ppwc-textarea"));
      const line = parseFloat(textCSS.lineHeight) || 20;
      const textPadding = (parseFloat(textCSS.paddingTop) || 0) + (parseFloat(textCSS.paddingBottom) || 0);
      return Math.ceil(railHeight + chrome + padding + gaps + Math.max(40, line * 2 + textPadding) + 8);
    }
    const shell = surface.matches?.(".wg-root") ? surface : surface.querySelector(".wg-root");
    const topChrome = Array.from(shell?.children || []).filter(el => el !== body.parentElement && !el.matches(".wg-status-measure")).reduce((sum, el) => sum + height(el), 0);
    const chrome = Array.from(body.children).filter(el => !el.matches(".wg-editor-wrap, .pp-recipe-workspace")).reduce((sum, el) => sum + height(el), topChrome);
    const workspace = body.querySelector(".pp-recipe-workspace");
    const text = body.querySelector(".wg-textarea");
    const textCSS = text ? getComputedStyle(text) : null;
    const line = parseFloat(textCSS?.lineHeight) || 20;
    const textPadding = (parseFloat(textCSS?.paddingTop) || 0) + (parseFloat(textCSS?.paddingBottom) || 0);
    const readingSpace = workspace && !workspace.hidden ? Math.max(120, line * 4) : Math.max(40, line * 2 + textPadding);
    // Labeled/connected sockets still need their real vertical rail space.
    return Math.ceil(railHeight + chrome + readingSpace + 8);
  }
  const computeSize = function (...args) {
    const natural = originals.computeSize?.apply(this, args);
    const size = numericNodeSize(natural);
    if (disposed || !size) return natural;
    return [restoring && target ? Math.min(size[0], target[0]) : size[0],
      restoring && target ? Math.min(size[1], target[1]) : naturalHeight()];
  };
  const onConfigure = function (info) {
    // Arm before chained callbacks can trigger a content-fit measurement.
    restore(info?.size ?? info?.node?.size);
    return originals.onConfigure?.apply(this, arguments);
  };
  const onSerialize = function (data) {
    const result = originals.onSerialize?.apply(this, arguments);
    if (!disposed && restoring && target) data.size = [...target];
    return result;
  };
  node.computeSize = computeSize; node.onConfigure = onConfigure; node.onSerialize = onSerialize;
  const guard = {
    restoringSize: () => restoring && target ? [...target] : null,
    mounted(frame) { surface = frame; settle(); },
    remount() { restore(restoring && target ? target : node.size); },
  };
  Object.defineProperty(node, "_ppNodeGeometry", { configurable: true, value: guard });
  lifecycle.add(() => {
    disposed = true; stop(); surface = null;
    for (const [key, wrapper] of Object.entries({ computeSize, onConfigure, onSerialize })) {
      if (node[key] === wrapper) node[key] = originals[key];
    }
    delete node._ppNodeGeometry;
  });
  return guard;
}

function preparePromptBackingWidgets(node) {
  installPositiveAntonymsState(node);
  installNegativePromptState(node);
  const combinatorial = (node.comfyClass || node.type) === "PromptPaletteCombinatorial";
  const names = combinatorial
    ? new Set(["text", "mode", "count", "seed", "seed_mode", "max_prompts", "prepared_batch", "positive_antonyms"])
    : new Set(["text", "seed", "processing_mode", "prepared_batch", "positive_antonyms"]);
  const socketWidgets = new Set(["mode", "count", "seed", "seed_mode", "max_prompts"]);
  for (const widget of node.widgets || []) {
    if (!names.has(widget.name) && !widget.__ppRecipeNegative && !/control.*generate/i.test(widget.name || "")) continue;
    widget.__ppOwnerNode = node;
    hideNativeWidget(widget, { keepSocketForNodes2: combinatorial && socketWidgets.has(widget.name) });
  }
  const seed = node.widgets?.find(w => w.name === "seed");
  for (const widget of seed?.linkedWidgets || []) {
    widget.__ppOwnerNode = node;
    hideNativeWidget(widget, { keepSocketForNodes2: combinatorial });
  }
  installNodeGeometryGuard(node);
}

// Use the same named property + backing-widget contract as local negatives.
// Explicit commits can disable the flag; renderer-default writes cannot erase a
// saved enabled value while Nodes 1/2 remount. Older positional text defaults off.
function installPositiveAntonymsState(node) {
  if (node._ppPositiveAntonymsState) return node._ppPositiveAntonymsState;
  const widget = node.widgets?.find(candidate => candidate.name === "positive_antonyms");
  if (!widget) return null;
  const key = "prompt_palette_positive_antonyms_v1";
  node.properties ||= {};
  let current = typeof node.properties[key] === "boolean" ? node.properties[key] : widget.value === true;
  const descriptor = Object.getOwnPropertyDescriptor(widget, "value");
  function commit(value) {
    if (typeof value !== "boolean") return current;
    current = value; node.properties ||= {}; node.properties[key] = current;
    if (descriptor?.set) descriptor.set.call(widget, current);
    if (descriptor?.configurable === false) widget.value = current;
    return current;
  }
  commit(current);
  if (descriptor?.configurable !== false) Object.defineProperty(widget, "value", {
    configurable: true, enumerable: true, get: () => current,
    set: value => { if (value === true || !current) commit(value); },
  });
  widget.serializeValue = () => current;
  const configured = node.onConfigure;
  node.onConfigure = function (info) {
    const saved = info?.properties?.[key], named = info?.widgets_values_named?.positive_antonyms;
    const positional = info?.widgets_values?.[this.widgets?.indexOf(widget) ?? -1];
    const result = configured?.apply(this, arguments);
    commit(typeof saved === "boolean" ? saved : typeof named === "boolean" ? named : positional === true);
    return result;
  };
  const serialized = node.onSerialize;
  node.onSerialize = function (data) {
    const result = serialized?.apply(this, arguments);
    data.properties ||= {}; data.properties[key] = current;
    if (data.widgets_values_named) data.widgets_values_named.positive_antonyms = current;
    return result;
  };
  return node._ppPositiveAntonymsState = { commit, current: () => current };
}

// negative_text is a force-input socket. Locally compiled negatives need a
// named, persistent backing value because the schema does not recreate a widget.
function installNegativePromptState(node) {
  if (node._ppNegativePromptState) return node._ppNegativePromptState;
  const key = "prompt_palette_negative_text_v1";
  node.properties ||= {};
  let widget = node.widgets?.find(w => w.name === "negative_text");
  let nativeSetter = null;
  let current = typeof node.properties[key] === "string" ? node.properties[key] : String(widget?.value || "");
  function attach() {
    if (!widget && current) {
      if (typeof node.addWidget !== "function") throw new Error("This node cannot retain a local negative prompt.");
      widget = node.addWidget("text", "negative_text", current, () => {}, { serialize: true });
    }
    if (!widget) return;
    widget.__ppRecipeNegative = true;
    widget.__ppOwnerNode = node;
    hideNativeWidget(widget);
    widget.serializeValue = () => current;
    const descriptor = Object.getOwnPropertyDescriptor(widget, "value");
    if (!widget.__ppNegativeStateBound && descriptor?.configurable !== false) {
      nativeSetter = descriptor?.set ? descriptor.set.bind(widget) : null;
      Object.defineProperty(widget, "value", { configurable: true, enumerable: true,
        get: () => current,
        set: value => { if (typeof value === "string" && (value || !current)) write(value); },
      });
      widget.__ppNegativeStateBound = true;
    }
  }
  function write(value) {
    if (typeof value !== "string") return current;
    current = value;
    node.properties ||= {};
    node.properties[key] = current;
    attach();
    nativeSetter?.(current);
    if (widget && !widget.__ppNegativeStateBound) widget.value = current;
    return current;
  }
  write(current);
  const configured = node.onConfigure;
  node.onConfigure = function (info) {
    const result = configured?.apply(this, arguments);
    const saved = info?.properties?.[key];
    const named = info?.widgets_values_named?.negative_text;
    const index = widget ? this.widgets?.indexOf(widget) : -1;
    const positional = index >= 0 ? info?.widgets_values?.[index] : undefined;
    write(typeof saved === "string" ? saved : typeof named === "string" ? named : typeof positional === "string" ? positional : "");
    return result;
  };
  const serialized = node.onSerialize;
  node.onSerialize = function (data) {
    const result = serialized?.apply(this, arguments);
    data.properties ||= {};
    data.properties[key] = current;
    if (data.widgets_values_named && widget) data.widgets_values_named.negative_text = current;
    return result;
  };
  const guard = { commit: write, current: () => current };
  node._ppNegativePromptState = guard;
  return guard;
}

function scheduleDomWidgetRemeasure(node) {
  if (!node || !nodeIsActive(node) || node._ppDomRemeasureFrame) return;
  node._ppDomRemeasureFrame = nextFrame(() => {
    node._ppDomRemeasureFrame = 0;
    if (!nodeIsActive(node)) return;
    node.graph?.setDirtyCanvas?.(true, true);
    node.setDirtyCanvas?.(true, true);
    // Nodes 1/2 can detach and remount the DOM widget without changing the
    // prompt value. CSS Highlight ranges are tied to the mounted editor DOM,
    // so repaint syntax colors after ComfyUI finishes that measurement frame.
    // This never changes node geometry; it only re-registers the visual layer.
    scheduleDomWidgetVisualRefresh(node);
    queueSocketRailLayout(node);
  });
}

const PROMPT_STATE_VERSION = 1;
const PROMPT_STATE_KEY = "prompt_palette_prompt_state";

function cloneSerializable(value) {
  if (value == null) return value;
  try { return typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value)); }
  catch { return value; }
}

function installPromptStateGuard(node, hiddenWidget) {
  if (!node || !hiddenWidget) return null;
  if (node._ppPromptStateGuard?.widget === hiddenWidget) return node._ppPromptStateGuard;

  node.properties ||= {};
  let established = false;
  let current = "";

  const savedState = () => {
    const state = node.properties?.[PROMPT_STATE_KEY];
    return state && state.version === PROMPT_STATE_VERSION && typeof state.source_text === "string"
      ? state
      : null;
  };

  const discover = () => {
    const state = savedState();
    if (state) { established = true; return state.source_text; }
    const widgetText = typeof hiddenWidget.value === "string" ? hiddenWidget.value : null;
    const hasLegacy = Object.prototype.hasOwnProperty.call(node.properties || {}, "wg_text")
      && typeof node.properties.wg_text === "string";
    if (widgetText) { established = true; return widgetText; }
    if (hasLegacy) { established = true; return node.properties.wg_text; }
    return widgetText || "";
  };

  const write = (value, { notify = false, dirty = false, establish = true } = {}) => {
    if (typeof value !== "string") return current;
    current = value;
    if (establish) established = true;
    if (established) {
      node.properties[PROMPT_STATE_KEY] = { version: PROMPT_STATE_VERSION, source_text: value };
      node.properties.wg_text = value;
    }
    hiddenWidget.value = value;
    if (notify && typeof hiddenWidget.callback === "function") {
      hiddenWidget.callback(value, node.graph?.canvas, node);
    }
    if (dirty) node.graph?.setDirtyCanvas?.(true, true);
    return current;
  };

  const restore = () => {
    const discovered = discover();
    return write(discovered, { notify: false, dirty: false, establish: established });
  };

  const acceptRendererValue = (value) => {
    if (typeof value !== "string") return current;
    // Nodes 2 can remount a hidden widget with its schema default. Never let that
    // presentation event erase an established prompt; intentional clearing uses commit().
    if (value === "" && established && current !== "") {
      hiddenWidget.value = current;
      return current;
    }
    return write(value, { notify: false, dirty: false, establish: established || value !== "" });
  };

  const loadSerialized = (info) => {
    const properties = info?.properties && typeof info.properties === "object"
      ? info.properties
      : null;
    const state = properties?.[PROMPT_STATE_KEY];
    let found = false;
    let value = "";
    if (state?.version === PROMPT_STATE_VERSION && typeof state.source_text === "string") {
      found = true;
      value = state.source_text;
    } else {
      const index = node.widgets?.indexOf(hiddenWidget) ?? -1;
      const namedValue = info?.widgets_values_named?.[hiddenWidget.name];
      const widgetValue = typeof namedValue === "string" ? namedValue : index >= 0 && Array.isArray(info?.widgets_values)
        ? info.widgets_values[index]
        : undefined;
      if (typeof widgetValue === "string") {
        found = true;
        value = widgetValue;
      } else if (properties && Object.prototype.hasOwnProperty.call(properties, "wg_text")
        && typeof properties.wg_text === "string") {
        found = true;
        value = properties.wg_text;
      }
    }
    if (!found) return current;
    established = true;
    return write(value, { notify: false, dirty: false, establish: true });
  };

  current = restore();

  if (!node._ppPromptStateConfigureHook) {
    node._ppPromptStateConfigureHook = true;
    const onConfigure = node.onConfigure;
    node.onConfigure = function (info) {
      const result = onConfigure ? onConfigure.apply(this, arguments) : undefined;
      this._ppPromptStateGuard?.loadSerialized(info);
      this._wgRefreshFromHidden?.();
      return result;
    };
  }

  if (!node._ppPromptStateSerializeHook) {
    node._ppPromptStateSerializeHook = true;
    const onSerialize = node.onSerialize;
    node.onSerialize = function (data) {
      const result = onSerialize ? onSerialize.apply(this, arguments) : undefined;
      const guard = this._ppPromptStateGuard;
      if (!guard) return result;
      const value = guard.commit(guard.current(), { notify: false, dirty: false });
      data.properties ||= {};
      data.properties[PROMPT_STATE_KEY] = { version: PROMPT_STATE_VERSION, source_text: value };
      data.properties.wg_text = value;
      if (data.widgets_values_named) data.widgets_values_named[guard.widget.name] = value;
      const index = this.widgets?.indexOf(guard.widget) ?? -1;
      if (index >= 0 && Array.isArray(data.widgets_values) && index < data.widgets_values.length) {
        data.widgets_values[index] = value;
      }
      return result;
    };
  }

  const guard = {
    widget: hiddenWidget,
    current: () => current,
    isEstablished: () => established,
    restore,
    loadSerialized,
    commit: (value, options = {}) => write(value, { notify: true, dirty: true, ...options, establish: true }),
    acceptRendererValue,
  };
  node._ppPromptStateGuard = guard;
  return guard;
}

function installPromptMetadataCapture(node) {
  if (!node || node._ppPromptMetadataCaptureHook) return;
  node._ppPromptMetadataCaptureHook = true;
  const onExecuted = node.onExecuted;
  node.onExecuted = function (message) {
    const result = onExecuted ? onExecuted.apply(this, arguments) : undefined;
    let metadata = message?.prompt_palette;
    if (Array.isArray(metadata) && metadata.length === 1 && metadata[0] && typeof metadata[0] === "object") {
      metadata = metadata[0];
    }
    if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
      const stored = cloneSerializable(metadata);
      this.properties ||= {};
      this.properties.prompt_palette_last_result = stored;
      this._wgAcceptPromptMetadata?.(stored);
    }
    return result;
  };
}

function ioState(node) {
  node.properties ||= {};
  const state = node.properties.wg_io || (node.properties.wg_io = { inputs: {}, outputs: {}, labels: false });
  state.inputs = state.inputs && typeof state.inputs === "object" ? state.inputs : {};
  state.outputs = state.outputs && typeof state.outputs === "object" ? state.outputs : {};
  // Migrate earlier experimental label flags into one renderer-neutral persisted switch.
  if (state.labels === undefined) {
    state.labels = !!(state.showLabels || state.showInputLabels || state.showOutputLabels);
  } else {
    state.labels = !!state.labels;
  }
  delete state.showLabels;
  delete state.showInputLabels;
  delete state.showOutputLabels;
  return state;
}

function ioEnabled(node, kind, def) {
  const bucket = kind === "input" ? ioState(node).inputs : ioState(node).outputs;
  return bucket[def.key] === undefined ? !!def.default : !!bucket[def.key];
}

function ioLabelsShown(node) {
  return !!(node && ioState(node).labels);
}


function ioSocketIndex(list, name) {
  return (list || []).findIndex((slot) => slot?.name === name);
}

function socketConnected(kind, slot) {
  return kind === "input" ? slot?.link != null : Number(slot?.links?.length) > 0;
}

function ensureSchemaSocket(node, kind, def) {
  return rendererEnsureSchemaSocket(node, kind, def);
}

function installSocketRailLayout(node, inputDefs, outputDefs, domRoot) {
  node._wgInputDefs = inputDefs || [];
  node._wgOutputDefs = outputDefs || [];
  node._wgSocketDomRoot = domRoot;
  const renderer = getPromptPaletteRenderer(node, { labelsShown: () => ioLabelsShown(node) });
  renderer.install(node._wgInputDefs, node._wgOutputDefs, domRoot);

  if (!node._wgSocketSerializeHook) {
    node._wgSocketSerializeHook = true;
    const onSerialize = node.onSerialize;
    node.onSerialize = function (data) {
      const result = onSerialize ? onSerialize.apply(this, arguments) : undefined;
      const restoreField = (serialized, original, key) => {
        if (!serialized) return;
        const value = original?.[key];
        if (value === undefined || value === HIDDEN_SOCKET_LABEL) delete serialized[key];
        else serialized[key] = Array.isArray(value) ? [...value] : value;
      };
      const restoreSlots = (serializedSlots, liveSlots) => {
        (serializedSlots || []).forEach((serialized, index) => {
          if (!serialized) return;
          delete serialized.ppHidden;
          delete serialized.__ppSocketRailTitle;
          delete serialized.__ppSocketRailState;
          const original = liveSlots?.[index]?.__ppSocketRailState;
          for (const key of ["label", "localized_name", "pos", "color_on", "color_off"]) restoreField(serialized, original, key);
        });
      };
      restoreSlots(data?.inputs, this.inputs);
      restoreSlots(data?.outputs, this.outputs);
      return result;
    };
  }

  if (!node._wgSocketConnectionHook) {
    node._wgSocketConnectionHook = true;
    const onConnectionsChange = node.onConnectionsChange;
    node.onConnectionsChange = function () {
      const result = onConnectionsChange ? onConnectionsChange.apply(this, arguments) : undefined;
      if (!this._wgSocketConnectionQueued) {
        this._wgSocketConnectionQueued = true;
        queueMicrotask(() => {
          this._wgSocketConnectionQueued = false;
          if (!nodeIsActive(this)) return;
          this._wgRefreshIoToggles?.();
          if (typeof this._ppInvalidateRuntime === "function") this._ppInvalidateRuntime("socket", { reason: "connection" });
          else getPromptPaletteRenderer(this, { labelsShown: () => ioLabelsShown(this) }).requestLayout();
        });
      }
      return result;
    };
  }
  renderer.requestLayout();
}

function cleanupSocketRailLayout(node) {
  cleanupPromptPaletteRenderer(node);
}

function queueSocketRailLayout(node) {
  if (!node || !nodeIsActive(node)) return;
  if (typeof node._ppInvalidateRuntime === "function") node._ppInvalidateRuntime("layout", { reason: "io-layout" });
  else getPromptPaletteRenderer(node, { labelsShown: () => ioLabelsShown(node) }).requestLayout();
}

function canonicalizeOutputs(node, defs) {
  if (!node) return;
  for (const def of defs || []) {
    const slot = ensureSchemaSocket(node, "output", def);
    if (!slot) continue;
    slot.name = def.key;
    slot.type ||= def.type;
    // Keep the schema-facing label authoritative for Nodes 2. The classic
    // renderer may temporarily use its compact zero-width label, but the Vue
    // slot component needs a real name/label to render its output text.
    slot.label = def.label || def.key;
    slot.localized_name = def.label || def.key;
    if (Number.isInteger(def.slotIndex)) slot.slot_index = def.slotIndex;
  }
  queueSocketRailLayout(node);
}

function syncIoSocket(node, kind, def, enabled) {
  const slot = ensureSchemaSocket(node, kind, def);
  if (!slot) return;
  slot.ppHidden = !(enabled || socketConnected(kind, slot));
  if (typeof node._ppInvalidateRuntime === "function") node._ppInvalidateRuntime("socket", { kind, key: def.key, visible: !slot.ppHidden });
  else queueSocketRailLayout(node);
}

function migrateIoState(node, kind, defs) {
  const bucket = kind === "input" ? ioState(node).inputs : ioState(node).outputs;
  for (const key of Object.keys(bucket)) {
    if (!defs.some((def) => def.key === key)) delete bucket[key];
    else bucket[key] = !!bucket[key];
  }
}


function setupIoRail(node, root, inputDefs, outputDefs) {
  const toggle = root.querySelector('[data-act="ioRailToggle"]');
  const header = root.querySelector(".wg-toolbar, .pp-header, .ppwc-settings-row");
  if (!toggle || !header) return { render() {}, close() {}, cleanup() {} };

  node._wgIoRailOpen = false;
  const rail = document.createElement("div");
  rail.className = "wg-io-rail";
  rail.setAttribute("aria-label", "Manage visible inputs and outputs");
  header.insertAdjacentElement("afterend", rail);

  const isConnected = (kind, def) => {
    const list = kind === "input" ? node.inputs : node.outputs;
    return socketConnected(kind, list?.[ioSocketIndex(list, def.key)]);
  };

  const chip = (kind, def) => {
    const enabled = ioEnabled(node, kind, def);
    const connected = isConnected(kind, def);
    const visible = enabled || connected;
    const stateText = connected
      ? (enabled ? "connected and visible" : "connected; hides after disconnect")
      : (enabled ? "visible" : "hidden");
    return `<button type="button" class="wg-io-chip${visible ? " on" : ""}${connected ? " linked" : ""}" data-io-kind="${kind}" data-io-key="${escapeHtml(def.key)}" aria-pressed="${enabled}" title="${escapeHtml(def.label)} (${escapeHtml(def.type)}): ${stateText}"><i></i><span>${escapeHtml(def.label)}</span>${connected ? '<b aria-hidden="true">•</b>' : ""}</button>`;
  };

  function render() {
    const allDefs = [
      ...inputDefs.map((def) => ["input", def]),
      ...outputDefs.map((def) => ["output", def]),
    ];
    const visibleCount = allDefs.filter(([kind, def]) => ioEnabled(node, kind, def) || isConnected(kind, def)).length;
    const totalCount = allDefs.length;
    const open = !!node._wgIoRailOpen;
    rail.classList.toggle("open", open);
    rail.hidden = !open;
    rail.toggleAttribute("inert", !open);
    toggle.classList.toggle("active", open);
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-label", open
      ? "Close I/O manager"
      : "Manage inputs, outputs, and socket labels");
    toggle.title = open
      ? `Close I/O manager (${visibleCount} of ${totalCount} visible)`
      : `Manage I/O and socket labels (${visibleCount} of ${totalCount} visible)`;
    const count = toggle.querySelector("[data-io-count]");
    if (count) count.textContent = `${visibleCount}/${totalCount}`;

    rail.innerHTML = `
      <div class="wg-io-rail-head">
        <div><strong>Inputs &amp; outputs</strong><span>Socket visibility and labels are independent and saved with the workflow.</span></div>
        <span class="wg-io-visible-count">${visibleCount} of ${totalCount} visible</span>
      </div>
      <div class="wg-io-rail-content">
        <div class="wg-io-rail-group"><span class="wg-io-rail-label">IN</span><div class="wg-io-chip-strip">${inputDefs.map((def) => chip("input", def)).join("")}</div></div>
        <div class="wg-io-rail-group"><span class="wg-io-rail-label">OUT</span><div class="wg-io-chip-strip">${outputDefs.map((def) => chip("output", def)).join("")}</div></div>
        <div class="wg-io-rail-actions" aria-label="Socket visibility presets">
          <button type="button" data-io-bulk="on" title="Show every socket">Show all</button>
          <button type="button" data-io-bulk="defaults" title="Restore the recommended socket set">Recommended</button>
          <button type="button" data-io-bulk="off" title="Hide every unconnected socket">Hide unused</button>
          <button type="button" data-io-labels aria-pressed="${ioLabelsShown(node)}" title="Show or hide socket names without changing socket visibility">${ioLabelsShown(node) ? "Hide labels" : "Show labels"}</button>
        </div>
      </div>`;
  }

  function applyBulk(mode) {
    const state = ioState(node);
    inputDefs.forEach((def) => { state.inputs[def.key] = mode === "on" ? true : mode === "defaults" ? !!def.default : false; });
    outputDefs.forEach((def) => { state.outputs[def.key] = mode === "on" ? true : mode === "defaults" ? !!def.default : false; });
    inputDefs.forEach((def) => syncIoSocket(node, "input", def, ioEnabled(node, "input", def)));
    outputDefs.forEach((def) => syncIoSocket(node, "output", def, ioEnabled(node, "output", def)));
    node._wgRefreshIoToggles?.();
    render();
  }

  function setOpen(open) {
    const next = !!open;
    if (next === !!node._wgIoRailOpen) return;
    if (next) node._wgBeforeIoRailOpen?.();
    node._wgIoRailOpen = next;
    render();
    queueSocketRailLayout(node);
    node._wgIoRailVisibilityChanged?.(next);
    scheduleDomWidgetRemeasure(node);
  }

  toggle.addEventListener("click", () => setOpen(!node._wgIoRailOpen));
  rail.addEventListener("click", (event) => {
    const labelsButton = event.target.closest?.("[data-io-labels]");
    if (labelsButton) {
      ioState(node).labels = !ioLabelsShown(node);
      render();
      node._wgRefreshIoToggles?.();
      queueSocketRailLayout(node);
      return;
    }
    const bulkButton = event.target.closest?.("[data-io-bulk]");
    if (bulkButton) return applyBulk(bulkButton.dataset.ioBulk);
    const button = event.target.closest?.("[data-io-kind][data-io-key]");
    if (!button) return;
    const kind = button.dataset.ioKind;
    const defs = kind === "input" ? inputDefs : outputDefs;
    const def = defs.find((candidate) => candidate.key === button.dataset.ioKey);
    if (!def) return;
    const bucket = kind === "input" ? ioState(node).inputs : ioState(node).outputs;
    bucket[def.key] = !ioEnabled(node, kind, def);
    syncIoSocket(node, kind, def, bucket[def.key]);
    node._wgRefreshIoToggles?.();
    render();
  });

  node._wgRenderIoRail = render;
  render();
  return {
    render,
    close() { setOpen(false); },
    cleanup() {
      node._wgIoRailOpen = false;
      if (node._wgRenderIoRail === render) delete node._wgRenderIoRail;
      rail.remove();
      queueSocketRailLayout(node);
    },
  };
}

export {
  HIDDEN_SOCKET_LABEL,
  nodeIsActuallyNodes2,
  ensureNodeLifecycle, nodeIsActive,
  scheduleNodeTimer, cancelNodeTimer, clearNodeTimers, scheduleNodeFrame,
  hideNativeWidget, installResponsiveDomWidgetWidth, getDomWidgetAvailableHeight,
  installPromptStateGuard, installNegativePromptState, installPositiveAntonymsState, installPromptMetadataCapture, installNodeGeometryGuard, preparePromptBackingWidgets,
  scheduleDomWidgetRemeasure,
  ioState,
  ioLabelsShown,
  ioEnabled,
  syncIoSocket,
  migrateIoState,
  canonicalizeOutputs,
  setupIoRail,
  installSocketRailLayout,
  cleanupSocketRailLayout,
  queueSocketRailLayout,
};
