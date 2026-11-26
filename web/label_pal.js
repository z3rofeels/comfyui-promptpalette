/**
 * LabelPal — Standalone ComfyUI Label, Section Banner & Sticky Note Node UI.
 *
 * Intentionally decoupled from Prompt Palette's editor/library runtime so it
 * operates independently on any ComfyUI canvas (Classic LiteGraph & Nodes 2.0).
 */
import { app } from "../../scripts/app.js";

const CSS_HREF = new URL("./css/label_pal.css", import.meta.url).href;
const PROPERTY_KEY = "label_pal_v1";
const WIDGET_NAMES = ["title", "note", "color_preset", "style_variant", "text_size"];

const COLOR_PRESETS = Object.freeze([
  { id: "amber", label: "Cinder Amber", color: "#332617", bgcolor: "#191613" },
  { id: "cherry", label: "Cherry Cola", color: "#381d20", bgcolor: "#1c1416" },
  { id: "tangerine", label: "Orange Fizz", color: "#382316", bgcolor: "#1c1613" },
  { id: "lime", label: "Lime Mint", color: "#193328", bgcolor: "#131b17" },
  { id: "cyan", label: "Ocean Cyan", color: "#183038", bgcolor: "#131a1f" },
  { id: "plum", label: "Grape Pop", color: "#29213b", bgcolor: "#171520" },
  { id: "cream", label: "Cream Soda", color: "#302a21", bgcolor: "#1b1916" },
  { id: "slate", label: "Graphite", color: "#232a32", bgcolor: "#15181d" },
]);

const COLOR_MAP = new Map(COLOR_PRESETS.map((item) => [item.id, item]));

const STYLE_VARIANTS = Object.freeze([
  { id: "card", label: "Card", tip: "Structured card with glowing left bar" },
  { id: "banner", label: "Banner", tip: "Section header banner" },
  { id: "sticky", label: "Sticky", tip: "Warm sticky-note style" },
  { id: "minimal", label: "Minimal", tip: "Quiet floating heading" },
  { id: "text", label: "Text", tip: "No node box — clean floating text only" },
]);

const TEXT_SIZES = Object.freeze([
  { id: "sm", label: "S", tip: "Compact text" },
  { id: "md", label: "M", tip: "Standard text" },
  { id: "lg", label: "L", tip: "Large text" },
  { id: "xl", label: "XL", tip: "Display header text" },
]);

const VALID_VARIANTS = new Set(STYLE_VARIANTS.map((item) => item.id));
const VALID_SIZES = new Set(TEXT_SIZES.map((item) => item.id));

let stylesheetPromise = null;

function ensureLabelPalStylesheet() {
  if (stylesheetPromise) return stylesheetPromise;
  if (typeof document === "undefined") return Promise.resolve(null);
  const existing = document.querySelector('link[data-label-pal-style="label-pal"]');
  if (existing) {
    stylesheetPromise = Promise.resolve(existing);
    return stylesheetPromise;
  }
  stylesheetPromise = new Promise((resolve, reject) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = CSS_HREF;
    link.dataset.labelPalStyle = "label-pal";
    link.addEventListener("load", () => resolve(link), { once: true });
    link.addEventListener("error", () => {
      link.remove();
      stylesheetPromise = null;
      reject(new Error(`LabelPal failed to load stylesheet: ${CSS_HREF}`));
    }, { once: true });
    document.head.appendChild(link);
  });
  return stylesheetPromise;
}

function isComfyQueueShortcut(event) {
  return !event.isComposing && event.keyCode !== 229 && !event.altKey
    && (event.ctrlKey || event.metaKey) && event.key === "Enter";
}

function installKeyboardBoundary(target) {
  if (!target?.addEventListener) return () => {};
  const stop = (event) => {
    if (!isComfyQueueShortcut(event)) event.stopPropagation();
  };
  const events = ["keydown", "keyup", "keypress", "copy", "cut", "paste"];
  for (const type of events) target.addEventListener(type, stop);
  return () => {
    for (const type of events) target.removeEventListener(type, stop);
  };
}

function nodeIsActive(node) {
  return Boolean(node && !node._lpDisposed && (node.graph || app?.graph?.getNodeById?.(node.id)));
}

function findVueNodeElement(node) {
  if (typeof document === "undefined" || node?.id == null) return null;
  try {
    const escaped = String(node.id).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return document.querySelector(`.lg-node[data-node-id="${escaped}"]`);
  } catch {
    return null;
  }
}

function nodeUsesVueDom(node) {
  return Boolean(findVueNodeElement(node));
}

function hideBackingWidget(node, widget) {
  if (!widget) return;
  widget.options ||= {};
  widget.hidden = true;
  widget.options.hidden = true;
  widget.options.canvasOnly = true;
  if (!nodeUsesVueDom(node)) {
    if (!widget._lpClassicHiddenState) {
      widget._lpClassicHiddenState = {
        type: widget.type,
        draw: widget.draw,
        computeSize: widget.computeSize,
      };
    }
    widget.type = "hidden";
    widget.draw = () => {};
    widget.computeSize = () => [0, -4];
  } else if (widget._lpClassicHiddenState) {
    widget.type = widget._lpClassicHiddenState.type;
    widget.draw = widget._lpClassicHiddenState.draw;
    widget.computeSize = widget._lpClassicHiddenState.computeSize;
  }
  if (widget.element) {
    widget.element.hidden = true;
    widget.element.classList?.add("lp-hidden-native-widget");
    widget.element.setAttribute?.("aria-hidden", "true");
  }
}

function hideAllBackingWidgets(node) {
  for (const name of WIDGET_NAMES) {
    const widget = node.widgets?.find((candidate) => candidate?.name === name);
    if (widget) hideBackingWidget(node, widget);
  }
}

function installResponsiveWidgetWidth(node, domWidget) {
  if (!domWidget || domWidget._lpWidthGuard) return () => {};
  const original = Object.getOwnPropertyDescriptor(domWidget, "width");
  if (original && original.configurable === false) return () => {};
  let vueWidth = original?.value ?? domWidget.width;
  Object.defineProperty(domWidget, "width", {
    configurable: true,
    enumerable: original?.enumerable ?? true,
    get() {
      if (!nodeUsesVueDom(node)) return undefined;
      if (original?.get) {
        try { return original.get.call(this); } catch { return vueWidth; }
      }
      return vueWidth;
    },
    set(value) {
      if (!nodeUsesVueDom(node)) return;
      if (original?.set) {
        try { original.set.call(this, value); return; } catch {}
      }
      vueWidth = value;
    },
  });
  Object.defineProperty(domWidget, "_lpWidthGuard", { value: true, configurable: true });
  return () => {
    try {
      delete domWidget._lpWidthGuard;
      if (original) Object.defineProperty(domWidget, "width", original);
      else delete domWidget.width;
    } catch {}
  };
}

function parseNumericSize(size) {
  if (!size || typeof size.length !== "number" || size.length < 2) return null;
  const w = Number(size[0]);
  const h = Number(size[1]);
  return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 ? [w, h] : null;
}

function normalizeState(raw = {}) {
  const title = typeof raw.title === "string" ? raw.title : "Section Label";
  const note = typeof raw.note === "string" ? raw.note : "";
  const colorPreset = COLOR_MAP.has(raw.color_preset) ? raw.color_preset : "amber";
  const styleVariant = VALID_VARIANTS.has(raw.style_variant) ? raw.style_variant : "card";
  const textSize = VALID_SIZES.has(raw.text_size) ? raw.text_size : "md";
  return {
    version: 1,
    title,
    note,
    color_preset: colorPreset,
    style_variant: styleVariant,
    text_size: textSize,
  };
}

function readStateFromNodeOrInfo(node, info = null) {
  const propCandidate = info?.properties?.[PROPERTY_KEY] ?? node?.properties?.[PROPERTY_KEY];
  if (propCandidate && typeof propCandidate === "object") {
    return normalizeState(propCandidate);
  }
  const named = info?.widgets_values_named;
  if (named && typeof named === "object") {
    return normalizeState(named);
  }
  const values = Array.isArray(info?.widgets_values) ? info.widgets_values : null;
  if (values) {
    return normalizeState({
      title: values[0],
      note: values[1],
      color_preset: values[2],
      style_variant: values[3],
      text_size: values[4],
    });
  }
  const fromWidgets = {};
  for (const name of WIDGET_NAMES) {
    const widget = node?.widgets?.find((candidate) => candidate?.name === name);
    if (widget && widget.value !== undefined) fromWidgets[name] = widget.value;
  }
  return normalizeState(fromWidgets);
}

function restoreNodeGetTitle(node) {
  if (!node || !node._lpTitleWrapped) return;
  if (node._lpHadOwnGetTitle) {
    node.getTitle = node._lpOrigGetTitle;
  } else {
    delete node.getTitle;
  }
  delete node._lpTitleWrapped;
  delete node._lpHadOwnGetTitle;
  delete node._lpOrigGetTitle;
}

function applyNodeChrome(node, toneId, { frameless = false } = {}) {
  if (!node) return;
  const preset = COLOR_MAP.get(toneId) || COLOR_PRESETS[0];
  const graph = node.graph;

  if (frameless) {
    if (!node._lpTitleWrapped) {
      node._lpTitleWrapped = true;
      node._lpHadOwnGetTitle = Object.prototype.hasOwnProperty.call(node, "getTitle");
      node._lpOrigGetTitle = node.getTitle;
      node.getTitle = () => "";
    }
  } else {
    restoreNodeGetTitle(node);
  }

  const vueNode = findVueNodeElement(node);
  vueNode?.classList?.toggle("lp-vue-frameless", Boolean(frameless));

  const updates = frameless
    ? [
        ["color", "transparent"],
        ["bgcolor", "transparent"],
        ["boxcolor", "transparent"],
      ]
    : [
        ["color", preset.color],
        ["bgcolor", preset.bgcolor],
        ["boxcolor", preset.color],
      ];
  for (const [property, newValue] of updates) {
    const oldValue = node[property];
    node[property] = newValue;
    if ((property === "color" || property === "bgcolor") && typeof graph?.trigger === "function") {
      try {
        graph.trigger("node:property:changed", {
          nodeId: node.id,
          property,
          oldValue,
          newValue,
        });
      } catch {}
    }
  }
  node.setDirtyCanvas?.(true, true);
  graph?.setDirtyCanvas?.(true, true);
}

function splitTitleParts(rawTitle) {
  const trimmed = String(rawTitle ?? "").trim();
  if (!trimmed) return { kicker: "", heading: "Untitled Label", empty: true };
  for (const sep of [" · ", " // "]) {
    const idx = trimmed.indexOf(sep);
    if (idx > 0 && idx + sep.length < trimmed.length) {
      const kicker = trimmed.slice(0, idx).trim();
      const heading = trimmed.slice(idx + sep.length).trim();
      if (kicker && heading && kicker.length <= 36) {
        return { kicker, heading, empty: false };
      }
    }
  }
  return { kicker: "", heading: trimmed, empty: false };
}

function appendFormattedInline(container, text) {
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g;
  let lastIndex = 0;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      container.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
    }
    const token = match[0];
    if (token.startsWith("`") && token.endsWith("`")) {
      const code = document.createElement("code");
      code.className = "lp-code";
      code.textContent = token.slice(1, -1);
      container.appendChild(code);
    } else if (token.startsWith("**") && token.endsWith("**")) {
      const strong = document.createElement("strong");
      strong.textContent = token.slice(2, -2);
      container.appendChild(strong);
    }
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < text.length) {
    container.appendChild(document.createTextNode(text.slice(lastIndex)));
  }
}

function renderFormattedNote(container, rawNote) {
  container.replaceChildren();
  const text = String(rawNote ?? "").replace(/\r\n/g, "\n").trim();
  if (!text) {
    container.hidden = true;
    return;
  }
  container.hidden = false;
  const lines = text.split("\n");
  let currentList = null;

  const flushList = () => {
    if (currentList) {
      container.appendChild(currentList);
      currentList = null;
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flushList();
      continue;
    }
    const bulletMatch = /^(?:[-*•])\s+(.+)$/.exec(line);
    const stepMatch = !bulletMatch ? /^(\d{1,2})[.)]\s+(.+)$/.exec(line) : null;

    if (bulletMatch || stepMatch) {
      if (!currentList) {
        currentList = document.createElement("ul");
        currentList.className = "lp-note-list";
      }
      const li = document.createElement("li");
      li.className = "lp-note-item";
      if (stepMatch) {
        const step = document.createElement("span");
        step.className = "lp-note-step";
        step.textContent = stepMatch[1];
        li.appendChild(step);
      } else {
        const dot = document.createElement("span");
        dot.className = "lp-note-bullet";
        dot.setAttribute("aria-hidden", "true");
        li.appendChild(dot);
      }
      const body = document.createElement("span");
      body.className = "lp-note-item-text";
      appendFormattedInline(body, stepMatch ? stepMatch[2] : bulletMatch[1]);
      li.appendChild(body);
      currentList.appendChild(li);
      continue;
    }

    flushList();
    const para = document.createElement("p");
    para.className = "lp-note-para";
    appendFormattedInline(para, line);
    container.appendChild(para);
  }
  flushList();
}

function iconMarkup(kind) {
  if (kind === "edit") {
    return '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg>';
  }
  return '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 12 5 5L20 6"/></svg>';
}

function installLabelGeometryGuard(node) {
  const originals = {
    computeSize: node.computeSize,
    onConfigure: node.onConfigure,
    onSerialize: node.onSerialize,
  };
  let targetSize = null;
  let restoring = false;
  let disposed = false;
  const frames = new Set();
  const raf = globalThis.requestAnimationFrame || ((cb) => setTimeout(cb, 0));
  const caf = globalThis.cancelAnimationFrame || clearTimeout;

  const stopRestore = () => {
    restoring = false;
    for (const id of frames) caf(id);
    frames.clear();
    if (typeof document !== "undefined") {
      document.removeEventListener("pointerdown", stopRestore, true);
      document.removeEventListener("keydown", stopRestore, true);
    }
  };

  const restoreSize = (size) => {
    const parsed = parseNumericSize(size);
    if (!parsed || disposed) return;
    stopRestore();
    targetSize = parsed;
    restoring = true;
    if (typeof document !== "undefined") {
      document.addEventListener("pointerdown", stopRestore, true);
      document.addEventListener("keydown", stopRestore, true);
    }
    const f1 = raf(() => {
      frames.delete(f1);
      const f2 = raf(() => {
        frames.delete(f2);
        if (disposed || !restoring || !nodeIsActive(node)) return;
        try {
          const live = parseNumericSize(node.size);
          if (targetSize && (!live || Math.abs(live[0] - targetSize[0]) > 0.75 || Math.abs(live[1] - targetSize[1]) > 0.75)) {
            if (typeof node.setSize === "function") node.setSize([...targetSize]);
            else node.size = [...targetSize];
            node.graph?.setDirtyCanvas?.(true, true);
          }
        } finally {
          stopRestore();
        }
      });
      frames.add(f2);
    });
    frames.add(f1);
  };

  const computeSize = function () {
    const minWidth = this._lpEditing ? 260 : 100;
    const minHeight = this._lpEditing ? 220 : 36;
    const saved = restoring ? targetSize : null;
    if (saved) {
      return [
        Math.max(80, Math.min(minWidth, Math.ceil(saved[0]))),
        Math.max(28, Math.min(minHeight, Math.ceil(saved[1]))),
      ];
    }
    return [minWidth, minHeight];
  };

  node.computeSize = computeSize;

  return {
    restoreSize,
    restoringSize: () => (restoring ? targetSize : null),
    cleanup() {
      disposed = true;
      stopRestore();
      if (node.computeSize === computeSize) {
        if (originals.computeSize) node.computeSize = originals.computeSize;
        else delete node.computeSize;
      }
    },
  };
}

function buildLabelPalSurface(node, geometry) {
  const surface = document.createElement("div");
  surface.className = "lp-surface wg-root";
  surface.tabIndex = 0;
  surface.setAttribute("role", "region");
  surface.setAttribute("aria-label", "Workflow label");

  const cleanupKeyboard = installKeyboardBoundary(surface);

  const swatchButtonsHtml = COLOR_PRESETS.map((preset) => (
    `<button type="button" class="lp-swatch" role="radio" data-swatch="${preset.id}" `
    + `aria-label="${preset.label}" aria-checked="false" title="${preset.label}">${iconMarkup("check")}</button>`
  )).join("");

  const variantButtonsHtml = STYLE_VARIANTS.map((variant) => (
    `<button type="button" class="lp-seg-btn" data-variant-btn="${variant.id}" `
    + `aria-pressed="false" title="${variant.tip}">${variant.label}</button>`
  )).join("");

  const sizeButtonsHtml = TEXT_SIZES.map((size) => (
    `<button type="button" class="lp-seg-btn" data-size-btn="${size.id}" `
    + `aria-pressed="false" title="${size.tip}" aria-label="${size.tip}">${size.label}</button>`
  )).join("");

  surface.innerHTML = `
    <button type="button" class="lp-edit-btn" data-act="edit" title="Edit label (Double-click or Enter)" aria-label="Edit label">
      ${iconMarkup("edit")}
    </button>
    <div class="lp-view" data-el="view">
      <div class="lp-header-block">
        <div class="lp-kicker-row" data-el="kickerRow" hidden>
          <span class="lp-kicker-dot" aria-hidden="true"></span>
          <span class="lp-kicker" data-el="kickerText"></span>
        </div>
        <h3 class="lp-title" data-el="titleText"></h3>
      </div>
      <div class="lp-note" data-el="noteBody" hidden></div>
    </div>
    <div class="lp-editor" data-el="editor" aria-hidden="true">
      <div class="lp-toolbar">
        <div class="lp-swatches" role="radiogroup" aria-label="Label color">${swatchButtonsHtml}</div>
        <button type="button" class="lp-done-btn" data-act="done" title="Finish editing (Esc)" aria-label="Finish editing">${iconMarkup("check")}<span>Done</span></button>
      </div>
      <div class="lp-controls-row">
        <div class="lp-seg-group" role="group" aria-label="Label style">${variantButtonsHtml}</div>
        <div class="lp-seg-group" role="group" aria-label="Text size">${sizeButtonsHtml}</div>
      </div>
      <input type="text" class="lp-input" data-el="titleInput" placeholder="Heading (or TAG · Heading)" aria-label="Label title" spellcheck="true" />
      <textarea class="lp-textarea" data-el="noteInput" placeholder="Optional note — supports - bullets, 1. steps, **bold**, and \`code\`" aria-label="Supporting note" spellcheck="true"></textarea>
      <div class="lp-hint">Tip: Use "STAGE 01 · Title" for an eyebrow badge · Esc when done</div>
    </div>
  `;

  const editBtn = surface.querySelector('[data-act="edit"]');
  const doneBtn = surface.querySelector('[data-act="done"]');
  const viewEl = surface.querySelector('[data-el="view"]');
  const editorEl = surface.querySelector('[data-el="editor"]');
  const kickerRow = surface.querySelector('[data-el="kickerRow"]');
  const kickerText = surface.querySelector('[data-el="kickerText"]');
  const titleText = surface.querySelector('[data-el="titleText"]');
  const noteBody = surface.querySelector('[data-el="noteBody"]');
  const titleInput = surface.querySelector('[data-el="titleInput"]');
  const noteInput = surface.querySelector('[data-el="noteInput"]');
  const swatchButtons = Array.from(surface.querySelectorAll("[data-swatch]"));
  const variantButtons = Array.from(surface.querySelectorAll("[data-variant-btn]"));
  const sizeButtons = Array.from(surface.querySelectorAll("[data-size-btn]"));

  let state = readStateFromNodeOrInfo(node);
  let editing = false;
  let preEditSize = null;
  let expandedSize = null;
  let hadEmptyNoteOnEnter = false;
  let removeOutsidePointer = null;

  const isFrameless = () => state.style_variant === "text" && !editing;

  function writeWidgetsAndProperties(nextState, { markDirty = true } = {}) {
    state = normalizeState(nextState);
    node.properties ||= {};
    node.properties[PROPERTY_KEY] = { ...state };
    for (const name of WIDGET_NAMES) {
      const widget = node.widgets?.find((candidate) => candidate?.name === name);
      if (widget) widget.value = state[name];
    }
    applyNodeChrome(node, state.color_preset, { frameless: isFrameless() });
    if (markDirty) {
      node.setDirtyCanvas?.(true, true);
      node.graph?.setDirtyCanvas?.(true, true);
    }
  }

  function render({ syncInputs = false } = {}) {
    surface.dataset.tone = state.color_preset;
    surface.dataset.variant = state.style_variant;
    surface.dataset.size = state.text_size;
    surface.dataset.editing = editing ? "true" : "false";
    editorEl.setAttribute("aria-hidden", editing ? "false" : "true");

    const { kicker, heading, empty } = splitTitleParts(state.title);
    surface.dataset.emptyTitle = empty ? "true" : "false";
    kickerRow.hidden = !kicker;
    kickerText.textContent = kicker;
    titleText.textContent = heading;
    surface.setAttribute("aria-label", kicker ? `${kicker}: ${heading}` : heading);

    renderFormattedNote(noteBody, state.note);

    for (const btn of swatchButtons) {
      const active = btn.dataset.swatch === state.color_preset;
      btn.setAttribute("aria-checked", active ? "true" : "false");
      btn.tabIndex = active ? 0 : -1;
    }
    for (const btn of variantButtons) {
      btn.setAttribute("aria-pressed", btn.dataset.variantBtn === state.style_variant ? "true" : "false");
    }
    for (const btn of sizeButtons) {
      btn.setAttribute("aria-pressed", btn.dataset.sizeBtn === state.text_size ? "true" : "false");
    }

    if (syncInputs) {
      if (document.activeElement !== titleInput) titleInput.value = state.title;
      if (document.activeElement !== noteInput) noteInput.value = state.note;
    }
  }

  function detachOutsideClose() {
    if (removeOutsidePointer) {
      removeOutsidePointer();
      removeOutsidePointer = null;
    }
  }

  function enterEditMode({ focusTarget = "title" } = {}) {
    if (editing) return;
    editing = true;
    node._lpEditing = true;
    hadEmptyNoteOnEnter = !state.note.trim();
    titleInput.value = state.title;
    noteInput.value = state.note;

    const currentSize = parseNumericSize(node.size);
    if (currentSize && (currentSize[0] < 300 || currentSize[1] < 248)) {
      preEditSize = [currentSize[0], currentSize[1]];
      expandedSize = [Math.max(currentSize[0], 300), Math.max(currentSize[1], 248)];
      if (typeof node.setSize === "function") node.setSize([...expandedSize]);
      else node.size = [...expandedSize];
    } else {
      preEditSize = null;
      expandedSize = null;
    }

    applyNodeChrome(node, state.color_preset, { frameless: false });
    render({ syncInputs: false });
    node.setDirtyCanvas?.(true, true);
    node.graph?.setDirtyCanvas?.(true, true);

    detachOutsideClose();
    if (typeof document !== "undefined") {
      const onPointerDown = (event) => {
        if (!surface.contains(event.target)) {
          exitEditMode({ restoreFocus: false });
        }
      };
      document.addEventListener("pointerdown", onPointerDown, true);
      removeOutsidePointer = () => document.removeEventListener("pointerdown", onPointerDown, true);
    }

    const target = focusTarget === "note" ? noteInput : titleInput;
    target.focus({ preventScroll: true });
    if (target === titleInput) target.select?.();
  }

  function exitEditMode({ restoreFocus = true } = {}) {
    if (!editing) return;
    editing = false;
    node._lpEditing = false;
    detachOutsideClose();

    if (preEditSize != null && expandedSize != null) {
      const liveSize = parseNumericSize(node.size);
      // Only snap back to compact dimensions the user didn't manually drag-resize while editing.
      if (liveSize) {
        const nextWidth = Math.abs(liveSize[0] - expandedSize[0]) < 2 ? preEditSize[0] : liveSize[0];
        let nextHeight = liveSize[1];
        if (Math.abs(liveSize[1] - expandedSize[1]) < 2) {
          nextHeight = (hadEmptyNoteOnEnter && state.note.trim())
            ? Math.max(preEditSize[1], 132)
            : preEditSize[1];
        }
        if (nextWidth !== liveSize[0] || nextHeight !== liveSize[1]) {
          if (typeof node.setSize === "function") node.setSize([nextWidth, nextHeight]);
          else node.size = [nextWidth, nextHeight];
        }
      }
    }
    preEditSize = null;
    expandedSize = null;
    hadEmptyNoteOnEnter = false;

    applyNodeChrome(node, state.color_preset, { frameless: isFrameless() });
    render({ syncInputs: true });
    node.setDirtyCanvas?.(true, true);
    node.graph?.setDirtyCanvas?.(true, true);
    if (restoreFocus) editBtn.focus({ preventScroll: true });
  }

  editBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    enterEditMode({ focusTarget: "title" });
  });

  doneBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    exitEditMode({ restoreFocus: true });
  });

  viewEl.addEventListener("dblclick", (event) => {
    event.stopPropagation();
    const clickedNote = Boolean(event.target?.closest?.(".lp-note"));
    enterEditMode({ focusTarget: clickedNote ? "note" : "title" });
  });

  // In view mode, only capture wheel scrolling when the note actually overflows.
  viewEl.addEventListener("wheel", (event) => {
    if (viewEl.scrollHeight > viewEl.clientHeight + 2) {
      event.stopPropagation();
    }
  }, { passive: true });

  editorEl.addEventListener("wheel", (event) => {
    event.stopPropagation();
  }, { passive: true });

  surface.addEventListener("keydown", (event) => {
    if (isComfyQueueShortcut(event) || event.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape" && editing) {
      event.preventDefault();
      exitEditMode({ restoreFocus: true });
      return;
    }
    if (!editing && (event.key === "Enter" || event.key === "F2") && event.target === surface) {
      event.preventDefault();
      enterEditMode({ focusTarget: "title" });
    }
  });

  titleInput.addEventListener("input", () => {
    writeWidgetsAndProperties({ ...state, title: titleInput.value });
    render({ syncInputs: false });
  });

  titleInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.ctrlKey && !event.metaKey && !event.isComposing) {
      event.preventDefault();
      noteInput.focus({ preventScroll: true });
    }
  });

  noteInput.addEventListener("input", () => {
    writeWidgetsAndProperties({ ...state, note: noteInput.value });
    render({ syncInputs: false });
  });

  for (const [index, btn] of swatchButtons.entries()) {
    btn.addEventListener("click", () => {
      writeWidgetsAndProperties({ ...state, color_preset: btn.dataset.swatch });
      render({ syncInputs: false });
    });
    btn.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const nextIndex = event.key === "Home"
        ? 0
        : event.key === "End"
          ? swatchButtons.length - 1
          : (index + (event.key === "ArrowRight" ? 1 : -1) + swatchButtons.length) % swatchButtons.length;
      const target = swatchButtons[nextIndex];
      target.focus({ preventScroll: true });
      writeWidgetsAndProperties({ ...state, color_preset: target.dataset.swatch });
      render({ syncInputs: false });
    });
  }

  for (const btn of variantButtons) {
    btn.addEventListener("click", () => {
      writeWidgetsAndProperties({ ...state, style_variant: btn.dataset.variantBtn });
      render({ syncInputs: false });
    });
  }

  for (const btn of sizeButtons) {
    btn.addEventListener("click", () => {
      writeWidgetsAndProperties({ ...state, text_size: btn.dataset.sizeBtn });
      render({ syncInputs: false });
    });
  }

  writeWidgetsAndProperties(state, { markDirty: false });
  render({ syncInputs: true });

  return {
    surface,
    getState: () => ({ ...state }),
    syncFromConfigure(info) {
      const restored = readStateFromNodeOrInfo(node, info);
      writeWidgetsAndProperties(restored, { markDirty: false });
      render({ syncInputs: true });
      if (info?.size) geometry.restoreSize(info.size);
    },
    syncForSerialize(serialized) {
      if (!serialized || typeof serialized !== "object") return;
      serialized.properties ||= {};
      serialized.properties[PROPERTY_KEY] = { ...state };
      serialized.widgets_values = WIDGET_NAMES.map((name) => state[name]);
      serialized.widgets_values_named = {
        ...(serialized.widgets_values_named && typeof serialized.widgets_values_named === "object"
          ? serialized.widgets_values_named
          : {}),
        ...Object.fromEntries(WIDGET_NAMES.map((name) => [name, state[name]])),
      };
    },
    reassert() {
      hideAllBackingWidgets(node);
      applyNodeChrome(node, state.color_preset, { frameless: isFrameless() });
      render({ syncInputs: true });
    },
    cleanup() {
      detachOutsideClose();
      cleanupKeyboard();
      restoreNodeGetTitle(node);
      findVueNodeElement(node)?.classList?.remove("lp-vue-frameless");
    },
  };
}

function getAvailableDomHeight(node, domWidget, geometry) {
  const bodyHeight = Number(geometry?.restoringSize()?.[1] ?? node?.size?.[1]) || 0;
  const widgetY = Number.isFinite(domWidget?.y)
    ? Number(domWidget.y)
    : (Number(node?.widgets_start_y) || 0);
  return Math.max(0, bodyHeight - widgetY);
}

app.registerExtension({
  name: "z3rofeels.LabelPal",

  async nodeCreated(node) {
    if (node.comfyClass !== "LabelPal" && node.type !== "LabelPal") return;
    if (node.__labelPalInitialized || node.__labelPalInitializing) return;
    Object.defineProperty(node, "__labelPalInitializing", { value: true, configurable: true });

    node.isVirtualNode = true;
    node.resizable = true;

    const initialSize = parseNumericSize(node.size);
    if (!initialSize || (initialSize[0] <= 220 && initialSize[1] <= 120)) {
      if (typeof node.setSize === "function") node.setSize([340, 148]);
      else node.size = [340, 148];
    }

    hideAllBackingWidgets(node);
    const geometry = installLabelGeometryGuard(node);
    let ui = null;
    let cleanupWidthGuard = null;

    try {
      await ensureLabelPalStylesheet();
      if (node._lpDisposed) {
        geometry.cleanup();
        return;
      }

      hideAllBackingWidgets(node);
      ui = buildLabelPalSurface(node, geometry);

      let domWidget = null;
      domWidget = node.addDOMWidget("label_pal_surface", "div", ui.surface, {
        getValue: () => ui.getState().title,
        setValue: () => {},
        serialize: false,
        hideOnZoom: false,
        getMinHeight: () => 0,
        getMaxHeight: () => getAvailableDomHeight(node, domWidget, geometry),
        getHeight: () => getAvailableDomHeight(node, domWidget, geometry),
        afterResize: () => {
          node.setDirtyCanvas?.(true, true);
        },
      });

      cleanupWidthGuard = installResponsiveWidgetWidth(node, domWidget);

      const prevOnConfigure = node.onConfigure;
      const wrappedOnConfigure = function (info) {
        const result = prevOnConfigure?.apply(this, arguments);
        if (!this._lpDisposed) {
          hideAllBackingWidgets(this);
          ui.syncFromConfigure(info);
        }
        return result;
      };
      node.onConfigure = wrappedOnConfigure;

      const prevOnSerialize = node.onSerialize;
      const wrappedOnSerialize = function (serialized) {
        const result = prevOnSerialize?.apply(this, arguments);
        ui.syncForSerialize(serialized);
        return result;
      };
      node.onSerialize = wrappedOnSerialize;

      const prevOnRemoved = node.onRemoved;
      const wrappedOnRemoved = function () {
        this._lpDisposed = true;
        cleanupWidthGuard?.();
        ui?.cleanup();
        geometry.cleanup();
        if (this.onConfigure === wrappedOnConfigure) {
          if (prevOnConfigure) this.onConfigure = prevOnConfigure;
          else delete this.onConfigure;
        }
        if (this.onSerialize === wrappedOnSerialize) {
          if (prevOnSerialize) this.onSerialize = prevOnSerialize;
          else delete this.onSerialize;
        }
        if (this.onRemoved === wrappedOnRemoved) {
          if (prevOnRemoved) this.onRemoved = prevOnRemoved;
          else delete this.onRemoved;
        }
        delete this._lpReassert;
        return prevOnRemoved?.apply(this, arguments);
      };
      node.onRemoved = wrappedOnRemoved;

      node._lpReassert = () => {
        if (!nodeIsActive(node)) return;
        ui.reassert();
      };

      Object.defineProperty(node, "__labelPalInitialized", { value: true, configurable: true });
      queueMicrotask(() => node._lpReassert?.());
    } catch (error) {
      cleanupWidthGuard?.();
      ui?.cleanup();
      geometry.cleanup();
      console.error("LabelPal initialization failed:", error);
    } finally {
      delete node.__labelPalInitializing;
    }
  },

  loadedGraphNode(node) {
    if (node.comfyClass !== "LabelPal" && node.type !== "LabelPal") return;
    hideAllBackingWidgets(node);
    queueMicrotask(() => node._lpReassert?.());
    const raf = globalThis.requestAnimationFrame || ((cb) => setTimeout(cb, 0));
    raf(() => node._lpReassert?.());
  },
});
