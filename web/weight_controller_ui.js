import { app } from "../../scripts/app.js";
import { addStylesheet } from "../../scripts/utils.js";
import {
  UI_THEME_KEYS,
  BUILTIN_UI_THEMES,
  loadUiThemes,
  saveUiThemes,
  loadActiveUiThemeName,
  saveActiveUiThemeName,
  sanitizeHexColor,
  escapeHtml,
  dialogPrompt,
  isDialogOpen,
  editorStylesReady,
} from "./wildcard_editor.js";

// PromptPaletteWeightController already enforces the "clean default"
// behavior in Python regardless of what weight_clamping/negative_routing
// are set to (see execute() in nodes.py -- advanced_controls gates their
// *values*, not just their visibility). This extension hides those two
// widgets from the node body until advanced_controls is turned on, so the
// node looks as simple as the brief asked for by default, and adds a
// settings gear (Interface theme + weighting-behavior notes) built the
// same way the rest of the Prompt Palette suite builds its own settings
// panel -- Prompt Palette (wildcard_editor.js) is the main node here;
// this is one of its pal nodes, reusing its exported theme/dialog
// bindings rather than forking its own copy of them.

const CSS_HREF = "extensions/comfyui-promptpalette/css/weight_controller_ui.css";
const weightControllerStylesReady = addStylesheet(CSS_HREF).catch((error) => {
  console.error("Prompt Palette: failed to load Weight Controller stylesheet", error);
  throw error;
});

const ADVANCED_WIDGET_NAMES = ["weight_clamping", "negative_routing"];

function setWidgetVisible(node, widget, visible) {
  if (!widget) return;
  const alreadyHidden = !!widget.ppwcHiddenState;

  if (visible && alreadyHidden) {
    const state = widget.ppwcHiddenState;
    widget.type = state.type;
    widget.hidden = state.hiddenProperty;
    widget.computeSize = state.computeSize;
    widget.draw = state.draw;

    widget.options ||= {};
    if (state.hadCanvasOnly) widget.options.canvasOnly = state.canvasOnly;
    else delete widget.options.canvasOnly;
    if (state.hadHidden) widget.options.hidden = state.hidden;
    else delete widget.options.hidden;

    if (widget.inputEl) {
      if (state.inputDisplay) {
        widget.inputEl.style.setProperty("display", state.inputDisplay, state.inputDisplayPriority);
      } else {
        widget.inputEl.style.removeProperty("display");
      }
      const wrapperEl = widget.inputEl.parentElement;
      if (wrapperEl) {
        if (state.wrapperDisplay) {
          wrapperEl.style.setProperty("display", state.wrapperDisplay, state.wrapperDisplayPriority);
        } else {
          wrapperEl.style.removeProperty("display");
        }
      }
    }

    delete widget.ppwcHiddenState;
  } else if (!visible && !alreadyHidden) {
    const options = widget.options || {};
    const inputEl = widget.inputEl;
    const wrapperEl = inputEl?.parentElement;
    Object.defineProperty(widget, "ppwcHiddenState", {
      value: {
        type: widget.type,
        computeSize: widget.computeSize,
        draw: widget.draw,
        hiddenProperty: widget.hidden,
        hadCanvasOnly: Object.prototype.hasOwnProperty.call(options, "canvasOnly"),
        canvasOnly: options.canvasOnly,
        hadHidden: Object.prototype.hasOwnProperty.call(options, "hidden"),
        hidden: options.hidden,
        inputDisplay: inputEl?.style.getPropertyValue("display") || "",
        inputDisplayPriority: inputEl?.style.getPropertyPriority("display") || "",
        wrapperDisplay: wrapperEl?.style.getPropertyValue("display") || "",
        wrapperDisplayPriority: wrapperEl?.style.getPropertyPriority("display") || "",
      },
      configurable: true,
      writable: true,
    });

    widget.type = "ppwc_hidden";
    widget.hidden = true;
    widget.computeSize = () => [0, -4];
    widget.draw = () => {};
    widget.options ||= {};
    widget.options.canvasOnly = true;
    widget.options.hidden = true;

    if (inputEl) {
      inputEl.style.setProperty("display", "none", "important");
      if (wrapperEl) wrapperEl.style.setProperty("display", "none", "important");
    }
  }
}

function applyVisibility(node) {
  const advancedWidget = node.widgets?.find((w) => w.name === "advanced_controls");
  if (!advancedWidget) return;
  const visible = !!advancedWidget.value;
  for (const name of ADVANCED_WIDGET_NAMES) {
    const w = node.widgets?.find((w2) => w2.name === name);
    setWidgetVisible(node, w, visible);
  }
  const computedSize = node.computeSize();
  const currentWidth = Number(node.size?.[0]) || 0;
  const computedWidth = Number(computedSize?.[0]) || 0;
  const computedHeight = Number(computedSize?.[1]) || Number(node.size?.[1]) || 0;
  // Toggling advanced controls may change height, but should never discard a
  // width the user deliberately chose by dragging the node wider.
  node.setSize([Math.max(currentWidth, computedWidth), computedHeight]);
  node.setDirtyCanvas(true, true);
}

// ---- Interface theme + weighting-behavior settings popup ----
// Anchors to the viewport's right edge (position: fixed in
// weight_controller_ui.css) rather than the node's own box: unlike
// PromptPaletteEditor, this node's real UI is plain native ComfyUI
// widgets, not one big addDOMWidget frame sized to the node, so there's
// no full-node .wg-node ancestor to slide an absolutely-positioned drawer
// inside. Same slide-in drawer chrome either way.
function buildSettingsPopup() {
  const popup = document.createElement("div");
  popup.className = "ppwc-settings-popup";
  popup.innerHTML = `
    <div class="wg-settings-head">
      <span>Weight Controller settings</span>
      <button type="button" class="wg-close-btn" data-act="close" title="Close">&#10005;</button>
    </div>
    <div class="wg-settings-body">
      <details class="wg-settings-section" open>
        <summary>Interface theme</summary>
        <div class="wg-settings-section-body">
          <div class="wg-srow">
            <select class="wg-theme-select" data-el="uiThemeSelect"></select>
          </div>
          <div class="wg-swatch-grid" data-el="uiThemeSwatches"></div>
          <div class="wg-drawer-btns" style="margin-top:6px;">
            <button type="button" data-act="uiThemeNew" title="Duplicate the current theme as an editable copy">New</button>
            <button type="button" data-act="uiThemeRename" title="Rename the current custom theme">Rename</button>
            <button type="button" data-act="uiThemeDelete" title="Delete the current custom theme">Delete</button>
          </div>
          <div class="wg-drawer-btns" style="margin-top:4px;">
            <button type="button" data-act="uiThemeImport">Import JSON</button>
            <button type="button" data-act="uiThemeExport">Export JSON</button>
          </div>
          <div class="wg-status" data-el="uiThemeStatus"></div>
        </div>
      </details>
      <details class="wg-settings-section" open>
        <summary>Weighting behavior</summary>
        <div class="wg-settings-section-body">
          <div class="ppwc-help-text"><strong>Advanced controls</strong> off (the default) forces "None" clamping and "Direct" routing at execution time no matter what the two widgets below are set to -- see execute() in nodes.py.</div>
          <div class="ppwc-help-text"><strong>Weight clamping \u2014 Soft Safety Clamp</strong> compresses weights toward 1.0 the further they drift from it, instead of letting them grow linearly. Values near 1.0 are barely touched.</div>
          <div class="ppwc-help-text"><strong>Negative routing \u2014 Zero Inversion Null</strong> only affects the plain-prose text output (Krea 2/LTX mode). Since that output can't carry a negative multiplier, a suppressed phrase is dropped from the sentence instead of rendering unweighted.</div>
        </div>
      </details>
    </div>
    <div class="wg-settings-footer">
      <a class="wg-credit-link" href="https://github.com/z3rofeels/comfyui-promptpalette" target="_blank" rel="noopener noreferrer" title="comfyui-promptpalette on GitHub">
        <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>
        <span>Made by <strong>z3rofeels</strong></span>
      </a>
    </div>
  `;
  return popup;
}

// Builds the gear button + slide-in popup for one node instance and wires
// every event listener up. Returns a cleanup() to run from node.onRemoved.
function setupSettingsUI(node) {
  const row = document.createElement("div");
  row.className = "ppwc-settings-row";
  row.innerHTML = `<button type="button" class="wg-icon-btn" data-act="openSettings" title="Weight Controller settings">&#9881;&#65039;</button>`;
  const gearBtn = row.querySelector('[data-act="openSettings"]');

  const popup = buildSettingsPopup();
  document.body.appendChild(popup);

  const el = (sel) => popup.querySelector(`[data-el="${sel}"]`);
  const uiThemeSelect = el("uiThemeSelect");
  const uiThemeSwatches = el("uiThemeSwatches");
  const uiThemeStatus = el("uiThemeStatus");

  let customUiThemes = loadUiThemes();
  let activeUiThemeName = loadActiveUiThemeName();

  function allUiThemes() { return { ...BUILTIN_UI_THEMES, ...customUiThemes }; }
  function isBuiltinUiTheme(name) { return !!BUILTIN_UI_THEMES[name] && !customUiThemes[name]; }
  if (!allUiThemes()[activeUiThemeName]) activeUiThemeName = "Amber";

  // Applied to document.documentElement (not just this node) so it stays
  // in sync with every other Prompt Palette node on the canvas, same
  // pattern and same "pp_ui_*" localStorage keys wildcard_editor.js's own
  // applyUiTheme() uses.
  function applyTheme() {
    const t = allUiThemes()[activeUiThemeName] || BUILTIN_UI_THEMES.Amber;
    UI_THEME_KEYS.forEach(([key]) => {
      document.documentElement.style.setProperty(`--wg-${key}`, t[key]);
    });
    node.bgcolor = t.bg;
    node.color = t.accent;
    node.graph?.setDirtyCanvas(true, true);
  }
  function setStatus(msg, isErr) {
    uiThemeStatus.textContent = msg || "";
    uiThemeStatus.className = "wg-status" + (isErr ? " err" : "");
  }
  function renderSelect() {
    const themes = allUiThemes();
    uiThemeSelect.innerHTML = Object.keys(themes).sort().map((name) =>
      `<option value="${escapeHtml(name)}" ${name === activeUiThemeName ? "selected" : ""}>${escapeHtml(name)}${isBuiltinUiTheme(name) ? "" : " (custom)"}</option>`
    ).join("");
  }
  function renderSwatches() {
    const t = allUiThemes()[activeUiThemeName] || BUILTIN_UI_THEMES.Amber;
    const locked = isBuiltinUiTheme(activeUiThemeName);
    uiThemeSwatches.innerHTML = "";
    UI_THEME_KEYS.forEach(([key, label]) => {
      const item = document.createElement("div");
      item.className = "wg-swatch-item";
      const swatchLabel = document.createElement("span");
      swatchLabel.textContent = label;
      const input = document.createElement("input");
      input.type = "color";
      input.value = sanitizeHexColor(t[key]);
      input.disabled = locked;
      item.appendChild(swatchLabel);
      item.appendChild(input);
      input.addEventListener("input", (e) => {
        if (locked) return;
        customUiThemes[activeUiThemeName][key] = e.target.value;
        saveUiThemes(customUiThemes);
        applyTheme();
      });
      uiThemeSwatches.appendChild(item);
    });
    setStatus(locked ? "built-in theme \u2014 hit \u201cNew\u201d to make an editable copy" : "");
  }
  function refreshThemeUI() { renderSelect(); renderSwatches(); }

  uiThemeSelect.addEventListener("change", () => {
    activeUiThemeName = uiThemeSelect.value;
    saveActiveUiThemeName(activeUiThemeName);
    applyTheme();
    renderSwatches();
  });

  popup.querySelector('[data-act="uiThemeNew"]').addEventListener("click", async () => {
    const base = allUiThemes()[activeUiThemeName] || BUILTIN_UI_THEMES.Amber;
    let name = await dialogPrompt({
      title: "New Theme",
      message: "Name for the new theme:",
      defaultValue: `${activeUiThemeName} copy`,
    });
    if (!name) return;
    name = name.trim();
    if (!name) return;
    customUiThemes[name] = { ...base };
    saveUiThemes(customUiThemes);
    activeUiThemeName = name;
    saveActiveUiThemeName(name);
    applyTheme();
    refreshThemeUI();
  });
  popup.querySelector('[data-act="uiThemeRename"]').addEventListener("click", async () => {
    if (isBuiltinUiTheme(activeUiThemeName)) return setStatus("built-in themes can't be renamed", true);
    let name = await dialogPrompt({
      title: "Rename Theme",
      message: "Rename theme:",
      defaultValue: activeUiThemeName,
    });
    if (!name) return;
    name = name.trim();
    if (!name || name === activeUiThemeName) return;
    if (allUiThemes()[name]) return setStatus("a theme with that name already exists", true);
    customUiThemes[name] = customUiThemes[activeUiThemeName];
    delete customUiThemes[activeUiThemeName];
    saveUiThemes(customUiThemes);
    activeUiThemeName = name;
    saveActiveUiThemeName(name);
    refreshThemeUI();
  });
  popup.querySelector('[data-act="uiThemeDelete"]').addEventListener("click", () => {
    if (isBuiltinUiTheme(activeUiThemeName)) return setStatus("built-in themes can't be deleted", true);
    delete customUiThemes[activeUiThemeName];
    saveUiThemes(customUiThemes);
    activeUiThemeName = "Amber";
    saveActiveUiThemeName(activeUiThemeName);
    applyTheme();
    refreshThemeUI();
  });
  popup.querySelector('[data-act="uiThemeImport"]').addEventListener("click", async () => {
    try {
      const text = await navigator.clipboard.readText();
      const parsed = JSON.parse(text);
      const source = parsed.colors || parsed;
      const name = (parsed.name && String(parsed.name).trim()) || `Imported ${Object.keys(customUiThemes).length + 1}`;
      const colors = {};
      UI_THEME_KEYS.forEach(([key]) => {
        colors[key] = sanitizeHexColor(source[key], BUILTIN_UI_THEMES.Amber[key]);
      });
      customUiThemes[name] = colors;
      saveUiThemes(customUiThemes);
      activeUiThemeName = name;
      saveActiveUiThemeName(name);
      applyTheme();
      refreshThemeUI();
      setStatus(`imported "${name}"`);
    } catch (e) {
      setStatus("clipboard doesn't contain a valid theme JSON", true);
    }
  });
  popup.querySelector('[data-act="uiThemeExport"]').addEventListener("click", async () => {
    const t = allUiThemes()[activeUiThemeName] || BUILTIN_UI_THEMES.Amber;
    const payload = { name: activeUiThemeName, ...t };
    await navigator.clipboard.writeText(JSON.stringify(payload, null, 2)).catch(() => {});
    setStatus("copied theme JSON to clipboard \u2014 share the file to let others import it");
  });

  function openPopup() {
    popup.classList.add("open");
    gearBtn.classList.add("active");
  }
  function closePopup() {
    popup.classList.remove("open");
    gearBtn.classList.remove("active");
  }
  gearBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (popup.classList.contains("open")) { closePopup(); return; }
    openPopup();
  });
  popup.querySelector('[data-act="close"]').addEventListener("click", closePopup);
  popup.addEventListener("click", (e) => e.stopPropagation());

  const handleOutsideClick = (e) => {
    if (isDialogOpen()) return;
    if (popup.classList.contains("open") && !popup.contains(e.target) && e.target !== gearBtn) {
      closePopup();
    }
  };
  const handleEscapeKey = (e) => {
    if (e.key !== "Escape") return;
    if (popup.classList.contains("open")) closePopup();
  };
  document.addEventListener("click", handleOutsideClick);
  document.addEventListener("keydown", handleEscapeKey);

  applyTheme();
  refreshThemeUI();

  return {
    row,
    cleanup() {
      document.removeEventListener("click", handleOutsideClick);
      document.removeEventListener("keydown", handleEscapeKey);
      popup.remove();
    },
  };
}

app.registerExtension({
  name: "PromptPalette.WeightControllerUI",
  async nodeCreated(node) {
    if (node.comfyClass !== "PromptPaletteWeightController") return;
    await Promise.all([editorStylesReady, weightControllerStylesReady]);
    if (node.__promptPaletteWeightControllerUiInitialized) return;

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

    // Appended after every other widget rather than reordered to the top,
    // so this never has to reach into node.widgets' existing order (that
    // order is exactly what execute()'s positional widgets_values mapping
    // and any already-saved workflow both rely on).
    const { row, cleanup } = setupSettingsUI(node);
    node.addDOMWidget("ppwc_settings_row", "div", row, {
      serialize: false,
      getMinHeight: () => 26,
      getMaxHeight: () => 26,
      getHeight: () => 26,
    });

    const origOnRemoved = node.onRemoved;
    node.onRemoved = function () {
      cleanup();
      return origOnRemoved ? origOnRemoved.apply(this, arguments) : undefined;
    };
  },
  // nodeCreated above runs before ComfyUI restores widgets_values from a
  // saved workflow, so advanced_controls.value is still its freshly-created
  // default at that point -- a saved node with advanced_controls=true would
  // apply visibility off the wrong value and stay stuck showing the simple
  // (hidden) layout until the checkbox was toggled by hand. Re-apply once
  // loading has actually restored the real value.
  loadedGraphNode(node) {
    if (node.comfyClass !== "PromptPaletteWeightController") return;
    applyVisibility(node);
  },
});
