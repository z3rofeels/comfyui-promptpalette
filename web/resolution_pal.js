/**
 * Resolution Selector (PromptPaletteResolutionSelector) — Standalone ComfyUI Utility UI.
 *
 * Provides model-aware aspect-ratio presets, orientation swap, predictable
 * dimension snapping, live aspect preview, and bidirectional sync with the
 * node's backing ComfyUI widgets (Classic LiteGraph & Nodes 2.0).
 */
import { app } from "../../scripts/app.js";

const CSS_HREF = new URL("./css/resolution_pal.css", import.meta.url).href;
const PROPERTY_KEY = "resolution_pal_v1";
const WIDGET_NAMES = ["model_profile", "width", "height", "batch_size", "snap_to_multiple"];

const MP_TIERS = Object.freeze([0.25, 0.5, 1, 1.5, 2, 3, 4]);

const PROFILES = Object.freeze([
  {
    name: "SDXL / Pony / Illustrious",
    badge: "4ch · ÷64",
    channels: 4,
    downscale: 8,
    step: 64,
    min: 512,
    max: 4096,
    defaultW: 1024,
    defaultH: 1024,
    defaultMp: 1,
    sweetMp: [1, 1.5],
    maxSafeMp: 2.2,
    presets: [
      { ratio: "1:1", rw: 1, rh: 1, w: 1024, h: 1024 },
      { ratio: "4:5", rw: 4, rh: 5, w: 896, h: 1152 },
      { ratio: "2:3", rw: 2, rh: 3, w: 832, h: 1216 },
      { ratio: "9:16", rw: 9, rh: 16, w: 768, h: 1344 },
      { ratio: "4:3", rw: 4, rh: 3, w: 1152, h: 896 },
      { ratio: "3:2", rw: 3, rh: 2, w: 1216, h: 832 },
      { ratio: "16:9", rw: 16, rh: 9, w: 1344, h: 768 },
      { ratio: "21:9", rw: 21, rh: 9, w: 1536, h: 640 },
    ],
  },
  {
    name: "Flux.1 / SD3 / Z-Image / Anima / Krea 2",
    badge: "16ch · ÷16",
    channels: 16,
    downscale: 8,
    step: 16,
    min: 256,
    max: 4096,
    defaultW: 1024,
    defaultH: 1024,
    defaultMp: 1,
    sweetMp: [1, 1.5, 2],
    maxSafeMp: 4,
    presets: [
      { ratio: "1:1", rw: 1, rh: 1, w: 1024, h: 1024 },
      { ratio: "4:5", rw: 4, rh: 5, w: 896, h: 1120 },
      { ratio: "3:4", rw: 3, rh: 4, w: 864, h: 1152 },
      { ratio: "2:3", rw: 2, rh: 3, w: 832, h: 1248 },
      { ratio: "9:16", rw: 9, rh: 16, w: 768, h: 1360 },
      { ratio: "4:3", rw: 4, rh: 3, w: 1152, h: 864 },
      { ratio: "3:2", rw: 3, rh: 2, w: 1248, h: 832 },
      { ratio: "16:9", rw: 16, rh: 9, w: 1360, h: 768 },
    ],
  },
  {
    name: "Qwen-Image",
    badge: "16ch · ÷16",
    channels: 16,
    downscale: 8,
    step: 16,
    min: 256,
    max: 4096,
    defaultW: 1328,
    defaultH: 1328,
    defaultMp: 1.5,
    sweetMp: [1.5, 2],
    maxSafeMp: 4,
    presets: [
      { ratio: "1:1", rw: 1, rh: 1, w: 1328, h: 1328 },
      { ratio: "4:5", rw: 4, rh: 5, w: 1152, h: 1440 },
      { ratio: "3:4", rw: 3, rh: 4, w: 1104, h: 1472 },
      { ratio: "2:3", rw: 2, rh: 3, w: 1056, h: 1584 },
      { ratio: "9:16", rw: 9, rh: 16, w: 928, h: 1664 },
      { ratio: "4:3", rw: 4, rh: 3, w: 1472, h: 1104 },
      { ratio: "3:2", rw: 3, rh: 2, w: 1584, h: 1056 },
      { ratio: "16:9", rw: 16, rh: 9, w: 1664, h: 928 },
    ],
  },
  {
    name: "MOSS-Image / Flux.2",
    badge: "128ch · ÷16",
    channels: 128,
    downscale: 16,
    step: 16,
    min: 256,
    max: 4096,
    defaultW: 1024,
    defaultH: 1024,
    defaultMp: 1,
    sweetMp: [1, 1.5, 2],
    maxSafeMp: 4,
    presets: [
      { ratio: "1:1", rw: 1, rh: 1, w: 1024, h: 1024 },
      { ratio: "4:5", rw: 4, rh: 5, w: 896, h: 1120 },
      { ratio: "3:4", rw: 3, rh: 4, w: 864, h: 1152 },
      { ratio: "2:3", rw: 2, rh: 3, w: 832, h: 1248 },
      { ratio: "9:16", rw: 9, rh: 16, w: 768, h: 1360 },
      { ratio: "4:3", rw: 4, rh: 3, w: 1152, h: 864 },
      { ratio: "3:2", rw: 3, rh: 2, w: 1248, h: 832 },
      { ratio: "16:9", rw: 16, rh: 9, w: 1344, h: 768 },
    ],
  },
  {
    name: "SD 1.5",
    badge: "4ch · ÷64",
    channels: 4,
    downscale: 8,
    step: 64,
    min: 256,
    max: 2048,
    defaultW: 512,
    defaultH: 512,
    defaultMp: 0.25,
    sweetMp: [0.25, 0.5],
    maxSafeMp: 1,
    presets: [
      { ratio: "1:1", rw: 1, rh: 1, w: 512, h: 512 },
      { ratio: "4:5", rw: 4, rh: 5, w: 512, h: 640 },
      { ratio: "2:3", rw: 2, rh: 3, w: 512, h: 768 },
      { ratio: "9:16", rw: 9, rh: 16, w: 448, h: 768 },
      { ratio: "4:3", rw: 4, rh: 3, w: 640, h: 512 },
      { ratio: "3:2", rw: 3, rh: 2, w: 768, h: 512 },
      { ratio: "16:9", rw: 16, rh: 9, w: 768, h: 448 },
      { ratio: "1:1 HD", rw: 1, rh: 1, w: 768, h: 768 },
    ],
  },
]);

const PROFILE_MAP = new Map(PROFILES.map((p) => [p.name, p]));
const DEFAULT_PROFILE = PROFILES[0];

let stylesheetPromise = null;

function ensureStylesheet() {
  if (stylesheetPromise) return stylesheetPromise;
  if (typeof document === "undefined") return Promise.resolve(null);
  const existing = document.querySelector('link[data-resolution-pal-style="resolution-pal"]');
  if (existing) {
    stylesheetPromise = Promise.resolve(existing);
    return stylesheetPromise;
  }
  stylesheetPromise = new Promise((resolve, reject) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = CSS_HREF;
    link.dataset.resolutionPalStyle = "resolution-pal";
    link.addEventListener("load", () => resolve(link), { once: true });
    link.addEventListener("error", () => {
      link.remove();
      stylesheetPromise = null;
      reject(new Error(`Resolution Selector failed to load stylesheet: ${CSS_HREF}`));
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

function getProfile(name) {
  return PROFILE_MAP.get(name) || DEFAULT_PROFILE;
}

function snapDimension(value, multiple, minDim, maxDim) {
  const num = Number(value);
  const safe = Number.isFinite(num) ? num : minDim;
  const step = Math.max(1, Math.round(multiple));
  const clamped = Math.max(minDim, Math.min(maxDim, safe));
  let snapped = Math.round(clamped / step) * step;
  if (snapped < minDim) snapped = Math.ceil(minDim / step) * step;
  if (snapped > maxDim) snapped = Math.floor(maxDim / step) * step;
  return Math.max(step, snapped);
}

function dimensionsForAspectAndMp(profile, rw, rh, mp, snapToMultiple) {
  const safeRw = Math.max(0.01, Number(rw) || 1);
  const safeRh = Math.max(0.01, Number(rh) || 1);
  const safeMp = Math.max(0.1, Number(mp) || 1);
  // Diffusion models use 1024x1024 = 1,048,576 px as 1 MP (so 4 MP = 2048x2048).
  const targetPixels = safeMp * 1_048_576;
  const ratio = safeRw / safeRh;
  const multiple = Math.max(profile.downscale, snapToMultiple ? profile.step : profile.downscale);
  return {
    w: snapDimension(Math.sqrt(targetPixels * ratio), multiple, profile.min, profile.max),
    h: snapDimension(Math.sqrt(targetPixels / ratio), multiple, profile.min, profile.max),
  };
}

function inferClosestMp(w, h) {
  const actualMp = (w * h) / 1_048_576;
  let best = MP_TIERS[0];
  let bestDiff = Infinity;
  for (const tier of MP_TIERS) {
    const diff = Math.abs(actualMp - tier);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = tier;
    }
  }
  return best;
}

function normalizeState(raw) {
  const profile = getProfile(raw?.model_profile);
  const snap = raw?.snap_to_multiple !== false;
  const multiple = Math.max(profile.downscale, snap ? profile.step : profile.downscale);
  const width = snapDimension(raw?.width ?? profile.defaultW, multiple, profile.min, profile.max);
  const height = snapDimension(raw?.height ?? profile.defaultH, multiple, profile.min, profile.max);
  const batchRaw = Number(raw?.batch_size);
  const batch_size = Number.isFinite(batchRaw) ? Math.max(1, Math.min(4096, Math.round(batchRaw))) : 1;
  const mpRaw = Number(raw?.target_mp);
  const target_mp = Number.isFinite(mpRaw) && mpRaw > 0 ? mpRaw : inferClosestMp(width, height);
  return {
    model_profile: profile.name,
    width,
    height,
    batch_size,
    snap_to_multiple: snap,
    target_mp,
  };
}

function gcd(a, b) {
  let x = Math.abs(Math.round(a));
  let y = Math.abs(Math.round(b));
  while (y) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x || 1;
}

function formatAspect(w, h) {
  const d = gcd(w, h);
  const rw = Math.round(w / d);
  const rh = Math.round(h / d);
  if (rw <= 25 && rh <= 25) return `${rw}:${rh}`;
  const decimal = (w / Math.max(1, h)).toFixed(2);
  return `${decimal}:1`;
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

function hideBackingWidget(node, widget) {
  if (!widget) return;
  widget.options ||= {};
  widget.hidden = true;
  widget.options.hidden = true;
  widget.options.canvasOnly = true;
  if (!findVueNodeElement(node)) {
    widget.type = "hidden";
    widget.draw = () => {};
    widget.computeSize = () => [0, -4];
  }
}

function hideAllBackingWidgets(node) {
  for (const name of WIDGET_NAMES) {
    const w = node.widgets?.find((item) => item?.name === name);
    if (w) hideBackingWidget(node, w);
  }
}

function readNodeState(node, info) {
  const named = info?.widgets_values_named || node?.widgets_values_named;
  if (named && typeof named === "object" && !Array.isArray(named)) {
    return normalizeState(named);
  }
  const prop = info?.properties?.[PROPERTY_KEY] || node?.properties?.[PROPERTY_KEY];
  if (prop && typeof prop === "object") {
    return normalizeState(prop);
  }
  const values = Array.isArray(info?.widgets_values) ? info.widgets_values : null;
  if (values && values.length >= 4) {
    return normalizeState({
      model_profile: values[0],
      width: values[1],
      height: values[2],
      batch_size: values[3],
      snap_to_multiple: values[4] ?? true,
    });
  }
  const fromWidgets = {};
  for (const name of WIDGET_NAMES) {
    const w = node.widgets?.find((item) => item?.name === name);
    if (w && w.value !== undefined) fromWidgets[name] = w.value;
  }
  return normalizeState(fromWidgets);
}

function writeNodeState(node, state) {
  const clean = normalizeState(state);
  node.properties ||= {};
  node.properties[PROPERTY_KEY] = { ...clean };
  for (const name of WIDGET_NAMES) {
    const w = node.widgets?.find((item) => item?.name === name);
    if (w) w.value = clean[name];
  }
  return clean;
}

function buildSurface(node) {
  const surface = document.createElement("div");
  surface.className = "rp-surface";
  const removeBoundary = installKeyboardBoundary(surface);

  const header = document.createElement("div");
  header.className = "rp-header";

  const profileSelect = document.createElement("select");
  profileSelect.className = "rp-profile-select";
  profileSelect.title = "Model profile (latent format & snapping)";
  for (const p of PROFILES) {
    const opt = document.createElement("option");
    opt.value = p.name;
    opt.textContent = p.name;
    profileSelect.appendChild(opt);
  }

  const specPill = document.createElement("span");
  specPill.className = "rp-spec-pill";

  header.append(profileSelect, specPill);

  const previewCard = document.createElement("div");
  previewCard.className = "rp-preview-card";

  const previewStage = document.createElement("div");
  previewStage.className = "rp-preview-stage";
  const previewBox = document.createElement("div");
  previewBox.className = "rp-preview-box";
  previewStage.appendChild(previewBox);

  const previewMeta = document.createElement("div");
  previewMeta.className = "rp-preview-meta";
  const previewDims = document.createElement("div");
  previewDims.className = "rp-preview-dims";
  const previewSub = document.createElement("div");
  previewSub.className = "rp-preview-sub";
  previewMeta.append(previewDims, previewSub);

  const swapBtn = document.createElement("button");
  swapBtn.type = "button";
  swapBtn.className = "rp-swap-btn";
  swapBtn.title = "Swap width and height (portrait / landscape)";
  swapBtn.textContent = "⇄ Swap";

  previewCard.append(previewStage, previewMeta, swapBtn);

  const mpRow = document.createElement("div");
  mpRow.className = "rp-mp-row";
  const mpLabel = document.createElement("span");
  mpLabel.className = "rp-mp-label";
  mpLabel.textContent = "MP";
  const mpPills = document.createElement("div");
  mpPills.className = "rp-mp-pills";
  mpRow.append(mpLabel, mpPills);

  const presetsGrid = document.createElement("div");
  presetsGrid.className = "rp-presets-grid";

  const warningPill = document.createElement("div");
  warningPill.className = "rp-warning-pill";
  warningPill.hidden = true;

  const controlsRow = document.createElement("div");
  controlsRow.className = "rp-controls-row";

  const makeNumberField = (labelText, title) => {
    const wrap = document.createElement("label");
    wrap.className = "rp-field";
    const lbl = document.createElement("span");
    lbl.className = "rp-field-label";
    lbl.textContent = labelText;
    const input = document.createElement("input");
    input.type = "number";
    input.className = "rp-num-input";
    input.title = title;
    wrap.append(lbl, input);
    return { wrap, input };
  };

  const widthField = makeNumberField("Width", "Custom width in pixels");
  const heightField = makeNumberField("Height", "Custom height in pixels");
  const batchField = makeNumberField("Batch", "Latent batch size");
  batchField.input.min = "1";
  batchField.input.max = "4096";
  batchField.input.step = "1";

  const snapBtn = document.createElement("button");
  snapBtn.type = "button";
  snapBtn.className = "rp-snap-btn";
  snapBtn.title = "Toggle rounding to recommended model step";

  controlsRow.append(widthField.wrap, heightField.wrap, batchField.wrap, snapBtn);
  surface.append(header, previewCard, mpRow, presetsGrid, controlsRow, warningPill);

  let state = writeNodeState(node, readNodeState(node));

  const render = () => {
    const profile = getProfile(state.model_profile);
    profileSelect.value = profile.name;
    specPill.textContent = profile.badge;

    widthField.input.min = String(profile.min);
    widthField.input.max = String(profile.max);
    widthField.input.step = String(state.snap_to_multiple ? profile.step : profile.downscale);
    widthField.input.value = String(state.width);

    heightField.input.min = String(profile.min);
    heightField.input.max = String(profile.max);
    heightField.input.step = String(state.snap_to_multiple ? profile.step : profile.downscale);
    heightField.input.value = String(state.height);

    batchField.input.value = String(state.batch_size);

    snapBtn.classList.toggle("is-on", state.snap_to_multiple);
    snapBtn.textContent = state.snap_to_multiple ? `Snap ÷${profile.step}` : `Min ÷${profile.downscale}`;

    const actualBinMp = (state.width * state.height) / 1_048_576;
    const mpDisplay = actualBinMp.toFixed(2);
    const orient = state.width === state.height ? "Square" : state.width > state.height ? "Landscape" : "Portrait";
    previewDims.textContent = `${state.width} × ${state.height}`;
    previewSub.textContent = `${formatAspect(state.width, state.height)} · ${orient} · ${mpDisplay} MP`;

    if (actualBinMp > profile.maxSafeMp + 0.08) {
      warningPill.hidden = false;
      warningPill.textContent = `Above ${profile.maxSafeMp} MP recommended ceiling for ${profile.name}`;
    } else {
      warningPill.hidden = true;
    }

    mpPills.replaceChildren();
    for (const tier of MP_TIERS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "rp-mp-btn";
      if (Math.abs(state.target_mp - tier) < 0.05) btn.classList.add("is-active");
      if (profile.sweetMp?.includes(tier)) btn.classList.add("is-sweet");
      if (tier > profile.maxSafeMp) btn.classList.add("is-over-ceiling");
      btn.textContent = `${tier}`;
      btn.title = profile.sweetMp?.includes(tier)
        ? `${tier} MP (recommended sweet spot for ${profile.name})`
        : tier > profile.maxSafeMp
          ? `${tier} MP (above ${profile.maxSafeMp} MP recommended ceiling)`
          : `${tier} MP`;
      btn.addEventListener("click", () => {
        const { w, h } = dimensionsForAspectAndMp(
          profile,
          state.width,
          state.height,
          tier,
          state.snap_to_multiple,
        );
        apply({ target_mp: tier, width: w, height: h });
      });
      mpPills.appendChild(btn);
    }

    const maxW = 46;
    const maxH = 34;
    const scale = Math.min(maxW / Math.max(1, state.width), maxH / Math.max(1, state.height));
    previewBox.style.width = `${Math.max(10, Math.round(state.width * scale))}px`;
    previewBox.style.height = `${Math.max(10, Math.round(state.height * scale))}px`;

    presetsGrid.replaceChildren();
    const useNativeDefault = Math.abs(state.target_mp - profile.defaultMp) < 0.05;
    for (const preset of profile.presets) {
      const dims = useNativeDefault
        ? { w: preset.w, h: preset.h }
        : dimensionsForAspectAndMp(profile, preset.rw, preset.rh, state.target_mp, state.snap_to_multiple);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "rp-preset-btn";
      if (state.width === dims.w && state.height === dims.h) {
        btn.classList.add("is-active");
      }
      const r = document.createElement("span");
      r.className = "rp-preset-ratio";
      r.textContent = preset.ratio;
      const px = document.createElement("span");
      px.className = "rp-preset-px";
      px.textContent = `${dims.w}×${dims.h}`;
      btn.append(r, px);
      btn.addEventListener("click", () => {
        apply({ width: dims.w, height: dims.h });
      });
      presetsGrid.appendChild(btn);
    }
  };

  const apply = (patch) => {
    state = writeNodeState(node, { ...state, ...patch });
    render();
    node.setDirtyCanvas?.(true, true);
  };

  profileSelect.addEventListener("change", () => {
    const nextProfile = getProfile(profileSelect.value);
    const prevProfile = getProfile(state.model_profile);
    const wasDefault = state.width === prevProfile.defaultW && state.height === prevProfile.defaultH;
    apply({
      model_profile: nextProfile.name,
      target_mp: wasDefault ? nextProfile.defaultMp : state.target_mp,
      width: wasDefault ? nextProfile.defaultW : state.width,
      height: wasDefault ? nextProfile.defaultH : state.height,
    });
  });

  swapBtn.addEventListener("click", () => {
    apply({ width: state.height, height: state.width });
  });

  snapBtn.addEventListener("click", () => {
    apply({ snap_to_multiple: !state.snap_to_multiple });
  });

  widthField.input.addEventListener("change", () => {
    apply({ width: widthField.input.value });
  });
  heightField.input.addEventListener("change", () => {
    apply({ height: heightField.input.value });
  });
  batchField.input.addEventListener("change", () => {
    apply({ batch_size: batchField.input.value });
  });

  render();

  return {
    surface,
    getState: () => state,
    syncFromConfigure: (info) => {
      state = writeNodeState(node, readNodeState(node, info));
      render();
    },
    syncForSerialize: (serialized) => {
      const clean = writeNodeState(node, state);
      if (serialized && typeof serialized === "object") {
        serialized.properties ||= {};
        serialized.properties[PROPERTY_KEY] = { ...clean };
        serialized.widgets_values_named = { ...clean };
      }
    },
    cleanup: () => {
      removeBoundary();
    },
  };
}

app.registerExtension({
  name: "z3rofeels.PromptPaletteResolutionSelector",

  async nodeCreated(node) {
    if (
      node.comfyClass !== "PromptPaletteResolutionSelector"
      && node.type !== "PromptPaletteResolutionSelector"
    ) {
      return;
    }
    if (node.__rpInitialized || node.__rpInitializing) return;
    Object.defineProperty(node, "__rpInitializing", { value: true, configurable: true });

    node.resizable = true;
    const minSize = [320, 336];
    if (!Array.isArray(node.size) || node.size[0] < minSize[0] || node.size[1] < minSize[1]) {
      if (typeof node.setSize === "function") node.setSize([...minSize]);
      else node.size = [...minSize];
    }

    hideAllBackingWidgets(node);
    let ui = null;

    try {
      await ensureStylesheet();
      if (node._rpDisposed) return;

      hideAllBackingWidgets(node);
      ui = buildSurface(node);

      node.addDOMWidget("resolution_pal_surface", "div", ui.surface, {
        getValue: () => `${ui.getState().width}x${ui.getState().height}`,
        setValue: () => {},
        serialize: false,
        hideOnZoom: false,
        getMinHeight: () => 260,
        afterResize: () => {
          node.setDirtyCanvas?.(true, true);
        },
      });

      const prevComputeSize = node.computeSize;
      node.computeSize = function () {
        return [320, 336];
      };

      const prevOnConfigure = node.onConfigure;
      node.onConfigure = function (info) {
        const res = prevOnConfigure?.apply(this, arguments);
        if (!this._rpDisposed) {
          hideAllBackingWidgets(this);
          ui.syncFromConfigure(info);
        }
        return res;
      };

      const prevOnSerialize = node.onSerialize;
      node.onSerialize = function (serialized) {
        const res = prevOnSerialize?.apply(this, arguments);
        ui.syncForSerialize(serialized);
        return res;
      };

      const prevOnRemoved = node.onRemoved;
      node.onRemoved = function () {
        this._rpDisposed = true;
        ui?.cleanup();
        if (prevComputeSize) this.computeSize = prevComputeSize;
        if (prevOnConfigure) this.onConfigure = prevOnConfigure;
        if (prevOnSerialize) this.onSerialize = prevOnSerialize;
        if (prevOnRemoved) this.onRemoved = prevOnRemoved;
        return prevOnRemoved?.apply(this, arguments);
      };

      Object.defineProperty(node, "__rpInitialized", { value: true, configurable: true });
    } catch (error) {
      ui?.cleanup();
      console.error("Resolution Selector initialization failed:", error);
    } finally {
      delete node.__rpInitializing;
    }
  },

  loadedGraphNode(node) {
    if (
      node.comfyClass !== "PromptPaletteResolutionSelector"
      && node.type !== "PromptPaletteResolutionSelector"
    ) {
      return;
    }
    hideAllBackingWidgets(node);
  },
});
