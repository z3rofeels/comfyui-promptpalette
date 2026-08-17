import { app } from "../../scripts/app.js";
import {
  loadExtensionStylesheet, svgIcon,
  installPromptPaletteKeyboardBoundary, registerPromptPaletteSettingsDrawer,
} from "./prompt_palette_shared.js";
import { bindSuiteAppearance } from "./editor/suite_appearance.js";
import {
  escapeHtml, isDialogOpen, editorStylesReady,
  ensureNodeLifecycle, nodeIsActive,
  hideNativeWidget, installResponsiveDomWidgetWidth, getDomWidgetAvailableHeight, scheduleDomWidgetRemeasure,
  ioEnabled, syncIoSocket, migrateIoState, canonicalizeOutputs,
  setupIoRail, installSocketRailLayout, cleanupSocketRailLayout, queueSocketRailLayout,
} from "./wildcard_editor.js";

const CSS_HREF = new URL("./css/weight_controller_ui.css", import.meta.url).href;
const weightControllerStylesReady = loadExtensionStylesheet(CSS_HREF, "prompt-palette-weight-controller").catch((error) => {
  console.error("Prompt Palette: failed to load Weight Controller stylesheet", error);
  throw error;
});
const CONTROLLER_WIDGET_NAMES = ["text", "weighting_mode", "advanced_controls", "weight_clamping", "negative_routing"];
const IO_INPUT_DEFS = [
  { key: "clip", type: "CLIP", label: "CLIP", default: true, desc: "Optional CLIP input for direct conditioning output." },
  { key: "model", type: "MODEL", label: "Model", default: true, desc: "Optional model passthrough for compact workflow wiring." },
];
const IO_OUTPUT_DEFS = [
  { key: "text", slotIndex: 0, type: "STRING", label: "Weighted text", default: true, desc: "Text formatted for the selected weighting mode." },
  { key: "weight_dict", slotIndex: 1, type: "DICT", label: "Weight dictionary", default: false, desc: "Parsed phrase-to-weight values." },
  { key: "negpip_compatible", slotIndex: 2, type: "STRING", label: "NegPip text", default: false, desc: "Bracketed text compatible with negative-weight pipelines." },
  { key: "conditioning", slotIndex: 3, type: "CONDITIONING", label: "Conditioning", default: true, desc: "Encoded conditioning when CLIP is connected." },
  { key: "model", slotIndex: 4, type: "MODEL", label: "Model", default: false, desc: "Model passthrough." },
  { key: "clip", slotIndex: 5, type: "CLIP", label: "CLIP", default: false, desc: "CLIP passthrough." },
  { key: "clip_token_count", slotIndex: 6, type: "INT", label: "CLIP tokens", default: true, desc: "CLIP-L token count, or -1 when unavailable." },
];

function applyVisibility(node) {
  for (const name of CONTROLLER_WIDGET_NAMES) {
    hideNativeWidget(node.widgets?.find((widget) => widget.name === name));
  }
  node._ppwcSyncControls?.();
  scheduleDomWidgetRemeasure(node);
}

function buildSettingsPopup() {
  const popup = document.createElement("div");
  popup.className = "ppwc-settings-popup wg-settings-pro wg-root wg-global-settings-popup";
  popup.setAttribute("role", "dialog");
  popup.setAttribute("aria-label", "Weight Controller settings");
  popup.setAttribute("aria-hidden", "true");
  popup.setAttribute("inert", "");
  popup.innerHTML = `
    <div class="wg-settings-head wg-settings-head-pro">
      <div><span>Weight Controller</span><small>Node settings</small></div>
      <button type="button" class="wg-close-btn" data-act="close" title="Close settings" aria-label="Close Weight Controller settings">${svgIcon("close", 15)}</button>
    </div>
    <div class="wg-settings-shell ppwc-settings-shell">
      <nav class="wg-settings-nav" aria-label="Settings sections">
        <button type="button" class="active" aria-current="page"><span>Weighting</span><small>Mode &amp; routing</small></button>
      </nav>
      <div class="wg-settings-body">
        <section class="wg-settings-panel active">
          <div class="wg-panel-title"><div><h3>Weight Controller behavior</h3><p>These controls mirror the node. Suite themes, fonts, colors, and surfaces live in the main Prompt Palette settings.</p></div></div>
          <div class="wg-settings-card-grid">
            <section class="wg-settings-card">
              <label class="wg-field"><span>Weighting mode</span><select class="wg-theme-select" data-el="settingsModeSelect"></select></label>
              <label class="ppwc-toggle-card"><div><strong>Advanced controls</strong><small>Optional clamping and negative routing</small></div><input type="checkbox" data-el="settingsAdvancedToggle"></label>
            </section>
            <section class="wg-settings-card" data-el="settingsAdvancedPanel">
              <label class="wg-field"><span>Weight clamping</span><select class="wg-theme-select" data-el="settingsClampSelect"></select></label>
              <label class="wg-field"><span>Negative routing</span><select class="wg-theme-select" data-el="settingsRoutingSelect"></select></label>
            </section>
          </div>
          <div class="ppwc-help-card"><strong>Advanced controls</strong><span>When off, Weight Controller executes with None clamping and Direct routing.</span></div>
          <div class="ppwc-help-card"><strong>Soft Safety Clamp</strong><span>Compresses weights toward 1.0 as they move farther away, while barely touching values close to neutral.</span></div>
          <div class="ppwc-help-card"><strong>Zero Inversion Null</strong><span>For plain-prose model output, suppressed phrases are removed instead of rendered without their negative multiplier.</span></div>
        </section>
      </div>
    </div>
    <div class="wg-settings-footer">
      <a class="wg-credit-link" href="https://github.com/z3rofeels/comfyui-promptpalette" target="_blank" rel="noopener noreferrer" title="Prompt Palette on GitHub">
        <span class="wg-credit-icon">${svgIcon("github", 13)}</span><span>made by <strong>z3rofeels</strong></span>
      </a>
    </div>
  `;
  return popup;
}

function setupSettingsUI(node) {
  const textWidget = node.widgets?.find((widget) => widget.name === "text");
  const modeWidget = node.widgets?.find((widget) => widget.name === "weighting_mode");
  const advancedWidget = node.widgets?.find((widget) => widget.name === "advanced_controls");
  const clampWidget = node.widgets?.find((widget) => widget.name === "weight_clamping");
  const routingWidget = node.widgets?.find((widget) => widget.name === "negative_routing");

  const surface = document.createElement("div");
  surface.className = "ppwc-surface wg-root";
  const cleanupSurfaceKeyboard = installPromptPaletteKeyboardBoundary(surface);
  surface.innerHTML = `
    <div class="ppwc-settings-row">
      <div class="ppwc-title-wrap">
        <span class="ppwc-title-mark" aria-hidden="true"></span>
        <div><strong>Weight Controller</strong><small>Phrase weighting without leaving Prompt Palette</small></div>
      </div>
      <div class="ppwc-row-actions">
        <button type="button" class="wg-icon-btn wg-io-toggle-btn" data-act="ioRailToggle" aria-expanded="false" title="Manage inputs, outputs, and socket labels" aria-label="Manage inputs, outputs, and socket labels">${svgIcon("io", 13)}<span class="wg-io-button-label">I/O</span><span data-io-count></span></button>
        <button type="button" class="wg-icon-btn" data-act="openSettings" title="Weight Controller settings" aria-label="Weight Controller settings" aria-expanded="false">${svgIcon("settings")}</button>
      </div>
    </div>
    <div class="ppwc-main">
      <div class="ppwc-editor-head"><span>Weighted prompt</span><small>Use (phrase:weight), for example (portrait lighting:1.2)</small></div>
      <div class="ppwc-editor-wrap"><textarea class="ppwc-textarea" data-el="textInput" spellcheck="true" aria-label="Weighted prompt text"></textarea></div>
      <div class="ppwc-controls">
        <label class="ppwc-field ppwc-mode-field"><span>Weighting mode</span><select data-el="modeSelect" aria-label="Weighting mode"></select></label>
        <label class="ppwc-toggle-card"><div><strong>Advanced controls</strong><small>Optional clamping and negative routing</small></div><input type="checkbox" data-el="advancedToggle"></label>
        <div class="ppwc-advanced" data-el="advancedPanel" hidden>
          <label class="ppwc-field"><span>Weight clamping</span><select data-el="clampSelect" aria-label="Weight clamping"></select></label>
          <label class="ppwc-field"><span>Negative routing</span><select data-el="routingSelect" aria-label="Negative routing"></select></label>
        </div>
      </div>
    </div>`;

  const row = surface.querySelector(".ppwc-settings-row");
  const textInput = surface.querySelector('[data-el="textInput"]');
  const modeSelect = surface.querySelector('[data-el="modeSelect"]');
  const advancedToggle = surface.querySelector('[data-el="advancedToggle"]');
  const advancedPanel = surface.querySelector('[data-el="advancedPanel"]');
  const clampSelect = surface.querySelector('[data-el="clampSelect"]');
  const routingSelect = surface.querySelector('[data-el="routingSelect"]');

  const widgetOptions = (widget, fallback = []) => {
    const values = widget?.options?.values;
    if (Array.isArray(values)) return values;
    return fallback;
  };
  const fillSelect = (select, widget, fallback = []) => {
    select.innerHTML = widgetOptions(widget, fallback).map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join("");
  };
  fillSelect(modeSelect, modeWidget, ["SDXL / CLIP (Standard)", "Krea 2 / ZIT (Qwen)", "LTX 2.3 / T5 (LLM)"]);
  fillSelect(clampSelect, clampWidget, ["None", "Soft Safety Clamp"]);
  fillSelect(routingSelect, routingWidget, ["Direct", "Zero Inversion Null"]);

  function commitWidget(widget, value) {
    if (!widget) return;
    widget.value = value;
    if (typeof widget.callback === "function") widget.callback(value, node.graph?.canvas, node);
    node.graph?.setDirtyCanvas?.(true, true);
    node.setDirtyCanvas?.(true, true);
  }
  let settingsModeSelect = null;
  let settingsAdvancedToggle = null;
  let settingsAdvancedPanel = null;
  let settingsClampSelect = null;
  let settingsRoutingSelect = null;

  function syncControls() {
    if (textWidget && document.activeElement !== textInput) textInput.value = String(textWidget.value ?? "");
    if (modeWidget) modeSelect.value = String(modeWidget.value ?? ""); else modeSelect.disabled = true;
    if (advancedWidget) advancedToggle.checked = !!advancedWidget.value; else advancedToggle.disabled = true;
    if (clampWidget) clampSelect.value = String(clampWidget.value ?? ""); else clampSelect.disabled = true;
    if (routingWidget) routingSelect.value = String(routingWidget.value ?? ""); else routingSelect.disabled = true;
    advancedPanel.hidden = !advancedToggle.checked;
    surface.classList.toggle("ppwc-advanced-open", advancedToggle.checked);
    if (settingsModeSelect) settingsModeSelect.value = String(modeWidget?.value ?? "");
    if (settingsAdvancedToggle) settingsAdvancedToggle.checked = !!advancedWidget?.value;
    if (settingsClampSelect) settingsClampSelect.value = String(clampWidget?.value ?? "");
    if (settingsRoutingSelect) settingsRoutingSelect.value = String(routingWidget?.value ?? "");
    if (settingsAdvancedPanel) settingsAdvancedPanel.hidden = !advancedWidget?.value;
  }
  node._ppwcSyncControls = syncControls;

  textInput.addEventListener("input", () => commitWidget(textWidget, textInput.value));
  modeSelect.addEventListener("change", () => commitWidget(modeWidget, modeSelect.value));
  advancedToggle.addEventListener("change", () => {
    commitWidget(advancedWidget, advancedToggle.checked);
    syncControls();
    scheduleDomWidgetRemeasure(node);
  });
  clampSelect.addEventListener("change", () => commitWidget(clampWidget, clampSelect.value));
  routingSelect.addEventListener("change", () => commitWidget(routingWidget, routingSelect.value));

  syncControls();
  const ioRail = setupIoRail(node, surface, IO_INPUT_DEFS, IO_OUTPUT_DEFS);
  const gearBtn = row.querySelector('[data-act="openSettings"]');

  const popup = buildSettingsPopup();
  popup.id = `prompt-palette-weight-${String(node.id ?? "node")}-settings`;
  gearBtn.setAttribute("aria-controls", popup.id);
  const cleanupPopupKeyboard = installPromptPaletteKeyboardBoundary(popup);
  settingsModeSelect = popup.querySelector('[data-el="settingsModeSelect"]');
  settingsAdvancedToggle = popup.querySelector('[data-el="settingsAdvancedToggle"]');
  settingsAdvancedPanel = popup.querySelector('[data-el="settingsAdvancedPanel"]');
  settingsClampSelect = popup.querySelector('[data-el="settingsClampSelect"]');
  settingsRoutingSelect = popup.querySelector('[data-el="settingsRoutingSelect"]');
  fillSelect(settingsModeSelect, modeWidget, ["SDXL / CLIP (Standard)", "Krea 2 / ZIT (Qwen)", "LTX 2.3 / T5 (LLM)"]);
  fillSelect(settingsClampSelect, clampWidget, ["None", "Soft Safety Clamp"]);
  fillSelect(settingsRoutingSelect, routingWidget, ["Direct", "Zero Inversion Null"]);
  settingsModeSelect?.addEventListener("change", () => { commitWidget(modeWidget, settingsModeSelect.value); syncControls(); });
  settingsAdvancedToggle?.addEventListener("change", () => {
    commitWidget(advancedWidget, settingsAdvancedToggle.checked);
    syncControls();
    scheduleDomWidgetRemeasure(node);
  });
  settingsClampSelect?.addEventListener("change", () => { commitWidget(clampWidget, settingsClampSelect.value); syncControls(); });
  settingsRoutingSelect?.addEventListener("change", () => { commitWidget(routingWidget, settingsRoutingSelect.value); syncControls(); });
  syncControls();

  // Weight Controller consumes Prompt Palette's suite appearance and never writes it.
  const appearanceBinding = bindSuiteAppearance({ node, targets: [surface, popup] });

  const settingsDrawer = registerPromptPaletteSettingsDrawer({
    popup,
    trigger: gearBtn,
    isBlocked: isDialogOpen,
  });
  function openPopup() {
    ioRail.close();
    syncControls();
    settingsDrawer.open();
  }
  function closePopup(options = {}) {
    settingsDrawer.close(options);
  }
  node._wgBeforeIoRailOpen = () => closePopup({ restoreFocus: false, reason: "io-rail" });
  gearBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (settingsDrawer.isOpen()) { closePopup(); return; }
    openPopup();
  });
  popup.querySelector('[data-act="close"]').addEventListener("click", closePopup);


  return {
    surface,
    reapplyTheme: appearanceBinding.apply,
    cleanup() {
      delete node._wgBeforeIoRailOpen;
      ioRail.cleanup();
      settingsDrawer.unregister();
      appearanceBinding.cleanup();
      cleanupSurfaceKeyboard();
      cleanupPopupKeyboard();
      popup.remove();
    },
  };
}

app.registerExtension({
  name: "PromptPalette.WeightControllerUI",
  async nodeCreated(node) {
    if (node.comfyClass !== "PromptPaletteWeightController") return;
    if (node.__promptPaletteWeightControllerUiInitialized) return;
    const lifecycle = ensureNodeLifecycle(node);
    await Promise.all([editorStylesReady, weightControllerStylesReady]);
    if (!nodeIsActive(node)) return;

    const advancedWidget = node.widgets?.find((w) => w.name === "advanced_controls");
    if (!advancedWidget) return;
    Object.defineProperty(node, "__promptPaletteWeightControllerUiInitialized", {
      value: true,
      configurable: true,
    });

    applyVisibility(node);

    const origCallback = advancedWidget.callback;
    advancedWidget.callback = (...args) => {
      const result = origCallback ? origCallback.apply(advancedWidget, args) : undefined;
      applyVisibility(node);
      return result;
    };

    node.properties ||= {};
    node.properties.wg_io ||= { inputs: {}, outputs: {} };
    migrateIoState(node, "input", IO_INPUT_DEFS);
    migrateIoState(node, "output", IO_OUTPUT_DEFS);
    canonicalizeOutputs(node, IO_OUTPUT_DEFS);
    IO_INPUT_DEFS.forEach((def) => syncIoSocket(node, "input", def, ioEnabled(node, "input", def)));
    IO_OUTPUT_DEFS.forEach((def) => syncIoSocket(node, "output", def, ioEnabled(node, "output", def)));

    const { surface, reapplyTheme, cleanup } = setupSettingsUI(node);
    installSocketRailLayout(node, IO_INPUT_DEFS, IO_OUTPUT_DEFS, surface);
    node._wgRefreshIoToggles = function () {
      canonicalizeOutputs(this, IO_OUTPUT_DEFS);
      IO_INPUT_DEFS.forEach((def) => syncIoSocket(this, "input", def, ioEnabled(this, "input", def)));
      IO_OUTPUT_DEFS.forEach((def) => syncIoSocket(this, "output", def, ioEnabled(this, "output", def)));
      this._wgRenderIoRail?.();
    };

    node.resizable = true;
    let domWidget;
    domWidget = node.addDOMWidget("ppwc_settings_row", "div", surface, {
      serialize: false,
      hideOnZoom: false,
      getMinHeight: () => 0,
      getMaxHeight: () => getDomWidgetAvailableHeight(node, domWidget),
      getHeight: () => getDomWidgetAvailableHeight(node, domWidget),
      afterResize: () => scheduleDomWidgetRemeasure(node),
    });
    installResponsiveDomWidgetWidth(node, domWidget);
    node._wgIoRailVisibilityChanged = () => scheduleDomWidgetRemeasure(node);
    node._ppwcReapplyTheme = reapplyTheme;
    const reassertSurface = () => {
      if (!nodeIsActive(node)) return;
      applyVisibility(node);
      node._ppwcReapplyTheme?.();
      scheduleDomWidgetRemeasure(node);
    };
    queueMicrotask(reassertSurface);
    const raf = globalThis.requestAnimationFrame || ((callback) => setTimeout(callback, 0));
    raf(reassertSurface);

    scheduleDomWidgetRemeasure(node);

    lifecycle.add(() => {
      node._ppwcRemoved = true;
      cleanupSocketRailLayout(node);
      delete node._wgIoRailVisibilityChanged;
      delete node._ppwcReapplyTheme;
      delete node._ppwcSyncControls;
      cleanup();
    });
  },

  loadedGraphNode(node) {
    if (node.comfyClass !== "PromptPaletteWeightController") return;
    if (!nodeIsActive(node)) return;
    applyVisibility(node);
    queueMicrotask(() => {
      if (!nodeIsActive(node)) return;
      applyVisibility(node);
      node._wgRefreshIoToggles?.();
      node._ppwcSyncControls?.();
      node._ppwcReapplyTheme?.();
      queueSocketRailLayout(node);
      scheduleDomWidgetRemeasure(node);
    });
    const raf = globalThis.requestAnimationFrame || ((callback) => setTimeout(callback, 0));
    raf(() => {
      if (!nodeIsActive(node)) return;
      applyVisibility(node);
      node._ppwcReapplyTheme?.();
      scheduleDomWidgetRemeasure(node);
    });
  },
});
