import { app } from "../../scripts/app.js";
import { addStylesheet } from "../../scripts/utils.js";
import {
  API, loadTheme, saveTheme, defaultTheme, escapeHtml, highlightMatch, categoryOf, hashStr,
  editorStylesReady,
  UI_THEME_KEYS, BUILTIN_UI_THEMES, loadUiThemes, saveUiThemes, loadActiveUiThemeName, saveActiveUiThemeName,
  sanitizeHexColor, hslToHex,
  findWildcardFragment, getCaretCoords, openOrUpdateAcMenu, closeAcMenu, acState,
  loadPinned, savePinned, loadExpandedCats, saveExpandedCats, loadCatOrder, saveCatOrder,
  notify, livePromptPaletteNodes,
  // Thumbnail gallery: reuse the Editor node's view-mode persistence, shared
  // right-click context menu, and shared native file-picker as-is rather
  // than standing up a second copy of any of them (see their doc comments
  // in wildcard_editor.js).
  loadPickerView, savePickerView, openCtxMenu, closeCtxMenu, ctxMenuOpen,
  pickThumbnailFile, thumbnailFileError,
  // Syntax Injector: the per-row ⚡ flyout (modifiers/templates/edit actions)
  // and its right-click-on-token entry point in the textarea. Combinatorial
  // mode leans on this heavily -- reused as-is rather than reimplemented,
  // same one-shared-floating-element reasoning as the ctx menu above.
  openInjectMenu, openInjectMenuAtPoint, closeInjectMenu, scheduleCloseInjectMenu, injectState,
  hideNativeWidget, getDomWidgetAvailableHeight, scheduleDomWidgetRemeasure,
  // Optional-output-socket toggle: same node.properties.wg_io shape and same
  // addOutput/removeOutput calls PromptPaletteEditor's own (larger) settings
  // section uses, so "prompt" hides/shows here exactly like every toggleable
  // output does over there -- see the helpers' definitions in wildcard_editor.js
  // for the full rationale.
  ioState, ioEnabled, syncIoSocket, renderIoToggleRow, migrateIoState,
  dialogPrompt, isDialogOpen,
} from "./wildcard_editor.js";

// The Editor stylesheet supplies the shared .wg-* controls used here. Await
// both sheets before mounting the DOM widget so Nodes 2.0 never measures the
// large picker tree in an unstyled state on a cold Desktop launch.
const CSS_HREF = "extensions/comfyui-promptpalette/css/wildcard_combinatorial.css";
const combinatorialStylesReady = addStylesheet(CSS_HREF).catch((error) => {
  console.error("Prompt Palette: failed to load combinatorial stylesheet", error);
  throw error;
});

// What each seed_mode option does (tooltip content -- see backend contract:
// seed_mode is "sequential" | "fixed" | "random"). Kept as its own map,
// separate from the Editor node's own SEED_MODE_LABELS, since the two nodes'
// seed_mode vocabularies are different (this node has no increment/decrement
// split -- "sequential" covers that single direction).
const SEED_MODE_INFO = {
  sequential: { label: "Sequential", desc: "Steps to the next seed value each run \u2014 paired with Combinatorial mode, walks every combination in order without repeats." },
  fixed: { label: "Fixed", desc: "Reuses the same seed for every run \u2014 re-running reproduces the exact same prompt(s)." },
  random: { label: "Random", desc: "Rolls a fresh random seed every run." },
};

const ESTIMATE_DEBOUNCE_MS = 350;
const DEFAULT_MAX_PROMPTS = 5000; // mirrors WildcardResolver.MAX_COMBINATORIAL_PROMPTS

function buildCombinatorialWidget(node, hiddenWidget) {
  const theme = loadTheme();
  const pinned = loadPinned();
  const expandedCats = loadExpandedCats();
  let catOrder = loadCatOrder();

  let libraryCache = [];    // last fetched flat list of {path, ...}
  let knownSet = new Set(); // full paths known to backend
  let thumbMap = {};        // wildcard path -> matching thumbnail image path (or null), from /categories
  let thumbBust = {};       // wildcard path -> cache-busting token, bumped by setThumbnailForItem/removeThumbnailForItem
  let pickerViewMode = loadPickerView(); // "list" | "grid", persisted across sessions (shared key with the Editor node)
  let tokenRanges = [];     // populated by highlightText(), read by hover-preview hit-test
  const previewCache = new Map(); // name -> {found, lines}, same shape as API.preview()

  const root = document.createElement("div");
  root.className = "pp-node";
  root.innerHTML = `
    <div class="pp-header">
      <div class="pp-badge"><span class="pp-badge-icon">&#9095;</span><span>Combinatorial</span></div>
      <div class="pp-header-actions">
        <button type="button" class="wg-icon-btn" data-act="picker" data-el="btnGallery" title="Gallery \u2014 browse &amp; insert wildcards">&#128193;</button>
        <button type="button" class="wg-icon-btn" data-act="refresh" data-el="btnRefresh" title="Re-scan wildcards directory">&#8635;</button>
        <button type="button" class="wg-icon-btn" data-act="dayNightToggle" data-el="dayNightBtn" title="Toggle day/night theme">&#127769;</button>
        <button type="button" class="wg-icon-btn" data-act="settings" title="Settings">&#9881;</button>
      </div>
    </div>
    <div class="pp-fanout-banner" data-el="fanoutBanner" title="This node's outputs are lists, one entry per generated prompt. Anything wired to model / clip / conditioning / prompt / seed_out / wildcards_used runs once per prompt in that list, not once per queue run.">
      <span class="pp-fanout-icon">&#9095;</span>
      <span>Fans out into <span class="pp-fanout-count" data-el="fanoutCount">1</span> prompt<span data-el="fanoutPlural"></span> \u2014 every wired output fires once per prompt.</span>
    </div>
    <div class="wg-settings-popup" data-el="settingsPopup">
      <div class="wg-settings-head">
        <span>Combinatorial settings</span>
        <button type="button" class="wg-icon-btn" data-act="closeSettings" title="Close">&#10005;</button>
      </div>
      <div class="wg-settings-body">
        <details class="wg-settings-section" open>
          <summary>Outputs</summary>
          <div class="wg-settings-section-body">
            <div style="font-size:9px; color:var(--wg-text-faint,#8a836f); line-height:1.5; margin-bottom:6px;">Every output below is a list (one entry per generated prompt) \u2014 the backend always produces it regardless of this toggle. Turning it off just hides the socket on this node instance.</div>
            <div data-el="ioOutputToggles"></div>
          </div>
        </details>
        <details class="wg-settings-section" open>
          <summary>Accessibility</summary>
          <div class="wg-settings-section-body">
            <div class="wg-srow">
              <label>Font family</label>
              <input type="text" class="wg-theme-select" data-el="fontFamilyInput" list="wg-font-suggestions"
                     placeholder="Leave blank for default (monospace editor / system UI font)">
              <datalist id="wg-font-suggestions">
                <option value="Atkinson Hyperlegible">
                <option value="OpenDyslexic">
                <option value="Arial">
                <option value="Verdana">
                <option value="Tahoma">
                <option value="Segoe UI">
                <option value="Georgia">
                <option value="Consolas">
                <option value="Cascadia Code">
                <option value="Courier New">
              </datalist>
              <div class="wg-drawer-btns" style="margin-top:6px;">
                <button type="button" data-act="fontBrowseLocal" title="Pick from fonts actually installed on your system (Chrome/Edge only)">Browse installed fonts&#8230;</button>
                <button type="button" data-act="fontClear" title="Clear override, use built-in default fonts">Use default</button>
              </div>
              <div class="wg-status" data-el="fontStatus"></div>
            </div>
            <div class="wg-srow">
              <div class="wg-rowline"><label style="margin:0;">Prompt text size</label><span data-el="editorFontOut">12.5px</span></div>
              <input type="range" class="wg-range" data-el="editorFontRange" min="10" max="28" step="0.5" value="12.5">
            </div>
            <div class="wg-srow">
              <div class="wg-rowline"><label style="margin:0;">Folder / sidebar text size</label><span data-el="uiFontOut">100%</span></div>
              <input type="range" class="wg-range" data-el="uiFontRange" min="80" max="200" step="5" value="100">
            </div>
            <div class="wg-srow">
              <label>Prompt text color <span style="opacity:.6;">(plain text, not wildcard tokens)</span></label>
              <input type="color" data-el="promptTextColor" value="#e8e2d4">
            </div>
          </div>
        </details>
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
            <div class="wg-srow" style="margin-top:10px;">
              <label>Day theme</label>
              <select class="wg-theme-select" data-el="dayThemeSelect"></select>
            </div>
            <div class="wg-srow">
              <label>Night theme</label>
              <select class="wg-theme-select" data-el="nightThemeSelect"></select>
            </div>
          </div>
        </details>
        <details class="wg-settings-section">
          <summary>Wildcard token colors</summary>
          <div class="wg-settings-section-body">
            <div class="wg-srow">
              <div class="wg-rowline"><label style="margin:0;">Hue rotation</label><span data-el="hueOut">0°</span></div>
              <input type="range" class="wg-range" data-el="hueRange" min="0" max="359" value="0">
            </div>
            <div class="wg-srow">
              <div class="wg-rowline"><label style="margin:0;">Color intensity</label><span data-el="satOut">65%</span></div>
              <input type="range" class="wg-range" data-el="satRange" min="30" max="90" step="5" value="65">
            </div>
          </div>
        </details>
        <details class="wg-settings-section">
          <summary>Category colors</summary>
          <div class="wg-settings-section-body">
            <div data-el="catPins"></div>
          </div>
        </details>
        <details class="wg-settings-section">
          <summary>Import / export token theme</summary>
          <div class="wg-settings-section-body">
            <div class="wg-theme-export"><textarea data-el="themeJson" readonly></textarea></div>
            <button type="button" class="wg-pill" data-act="copyTheme">Copy JSON</button>
            <button type="button" class="wg-pill" data-act="pasteTheme">Paste + apply</button>
            <button type="button" class="wg-pill" data-act="resetTheme">Reset</button>
          </div>
        </details>
      </div>
      <div class="wg-settings-footer">
        <button type="button" class="wg-pill" data-act="closeSettings">Done</button>
      </div>
    </div>
    <div class="wg-main">
      <div class="wg-drawer left" data-drawer="picker">
        <div class="wg-drawer-inner">
          <div class="wg-drawer-head">
            <h4>Browse wildcards</h4>
            <div class="wg-drawer-head-actions">
              <button type="button" class="wg-icon-btn" data-act="pickerViewToggle" data-el="pickerViewToggle" title="Toggle grid/list view">&#9638;</button>
            </div>
          </div>
          <div class="wg-search"><input type="text" placeholder="Search wildcards..." data-el="search"></div>
          <div class="wg-list" data-el="pickerList"></div>
        </div>
      </div>
      <div class="wg-body">
        <div class="wg-editor-wrap">
          <div class="wg-editor-real" data-el="editorReal">
            <div class="wg-editor-layer wg-highlight" data-el="highlight"></div>
            <textarea class="wg-editor-layer wg-textarea" data-el="textarea" spellcheck="true"></textarea>
          </div>
        </div>
        <div class="wg-legend" data-el="legend"></div>
        <div class="wg-footer">
          <span class="wg-hint" data-el="hintLeft">colored by folder</span>
          <span class="wg-hint" data-el="charCount"></span>
          <span class="wg-hint" data-el="hintRight"></span>
        </div>
        <div class="pp-controls">
          <div class="pp-mode-toggle" data-el="modeToggle">
            <button type="button" class="pp-mode-btn" data-mode="random" title="Produces \u2018count\u2019 prompts, each an independent random pick.">Random</button>
            <button type="button" class="pp-mode-btn" data-mode="combinatorial" title="Produces every combination of the text\u2019s wildcard/brace groups, up to \u2018max_prompts\u2019.">Combinatorial</button>
          </div>
          <div class="pp-row" data-el="countRow">
            <label>Count</label>
            <input type="number" min="1" step="1" data-el="countInput" title="How many random prompts to generate this run. Ignored in Combinatorial mode.">
          </div>
          <div class="pp-row" data-el="maxPromptsRow">
            <label>Max prompts</label>
            <input type="number" min="0" step="1" placeholder="5000 (default)" data-el="maxPromptsInput" title="Safety cap on the combinatorial expansion. 0 = default cap (5000). Ignored in Random mode.">
          </div>
          <div class="pp-row">
            <label>Seed</label>
            <input type="number" min="0" step="1" data-el="seedInput" title="Prompt seed.">
            <button type="button" class="wg-icon-btn" data-act="seedRandomizeNow" title="Roll a new random seed now">&#127922;</button>
          </div>
          <div class="pp-row">
            <label>Seed mode</label>
            <select data-el="seedModeSelect"></select>
          </div>
          <div class="pp-estimate" data-el="estimateBox">
            <div class="pp-estimate-main">
              <span>Estimated output</span>
              <span class="pp-estimate-count" data-el="estimateCount">1 prompt</span>
            </div>
            <div class="pp-estimate-warning-text" data-el="estimateWarning"></div>
          </div>
        </div>
      </div>
    </div>
  `;

  const el = sel => root.querySelector(`[data-el="${sel}"]`);
  const textarea = el("textarea");
  const highlight = el("highlight");
  const legend = el("legend");
  const hintRight = el("hintRight");
  const charCount = el("charCount");
  const pickerDrawer = root.querySelector('[data-drawer="picker"]');
  const searchInput = el("search");
  const pickerList = el("pickerList");
  const pickerViewToggleBtn = el("pickerViewToggle");
  const fanoutBanner = el("fanoutBanner");
  const fanoutCount = el("fanoutCount");
  const fanoutPlural = el("fanoutPlural");
  const modeButtons = Array.from(root.querySelectorAll(".pp-mode-btn"));
  const countRow = el("countRow");
  const countInput = el("countInput");
  const maxPromptsRow = el("maxPromptsRow");
  const maxPromptsInput = el("maxPromptsInput");
  const seedInput = el("seedInput");
  const seedModeSelect = el("seedModeSelect");
  const estimateBox = el("estimateBox");
  const estimateCount = el("estimateCount");
  const estimateWarning = el("estimateWarning");

  // ---- pull mode / count / seed / seed_mode / max_prompts off the node body
  // into this UI. All five are still real LiteGraph widgets underneath (so
  // queueing/serialization work exactly as before) -- we just hide their
  // canvas-drawn rows and mirror their values into these DOM controls
  // instead. Same hide technique as the Editor node's seed/processing_mode
  // widgets (see buildWildcardWidget in wildcard_editor.js). ----
  const modeWidget = node.widgets.find(w => w.name === "mode");
  const countWidget = node.widgets.find(w => w.name === "count");
  const seedWidget = node.widgets.find(w => w.name === "seed");
  const seedModeWidget = node.widgets.find(w => w.name === "seed_mode");
  const maxPromptsWidget = node.widgets.find(w => w.name === "max_prompts");
  [modeWidget, countWidget, seedWidget, seedModeWidget, maxPromptsWidget].forEach(hideNativeWidget);
  // ComfyUI's own node-restore step (onConfigure: workflow load, tab switch,
  // undo/redo) re-touches/recreates these widgets' DOM elements AFTER this
  // initial hide already ran, undoing it. Exposed so the onConfigure hook
  // below can call this again once that restore step has finished.
  function reassertHiddenWidgets() {
    hideNativeWidget(hiddenWidget);
    [modeWidget, countWidget, seedWidget, seedModeWidget, maxPromptsWidget].forEach(hideNativeWidget);
  }

  function buildSeedModeOptions() {
    const values = (seedModeWidget && seedModeWidget.options && seedModeWidget.options.values) || Object.keys(SEED_MODE_INFO);
    seedModeSelect.innerHTML = values.map(v => {
      const info = SEED_MODE_INFO[v] || { label: v, desc: "" };
      return `<option value="${escapeHtml(v)}" title="${escapeHtml(info.desc)}">${escapeHtml(info.label)}</option>`;
    }).join("");
    seedModeSelect.title = Object.values(SEED_MODE_INFO).map(v => `${v.label}: ${v.desc}`).join("  \u2022  ");
  }
  buildSeedModeOptions();

  function syncControlsFromWidgets() {
    if (countWidget) countInput.value = countWidget.value; else countInput.disabled = true;
    if (maxPromptsWidget) maxPromptsInput.value = maxPromptsWidget.value; else maxPromptsInput.disabled = true;
    if (seedWidget) seedInput.value = seedWidget.value; else seedInput.disabled = true;
    if (seedModeWidget) seedModeSelect.value = seedModeWidget.value; else seedModeSelect.disabled = true;
    updateModeUI();
  }

  countInput.addEventListener("input", () => {
    if (!countWidget || countInput.value === "") return;
    countWidget.value = Math.max(1, Math.floor(Number(countInput.value)) || 1);
    if (typeof countWidget.callback === "function") countWidget.callback(countWidget.value, node.graph?.canvas, node);
    node.graph?.setDirtyCanvas(true, true);
    updateEstimate();
  });
  maxPromptsInput.addEventListener("input", () => {
    if (!maxPromptsWidget) return;
    maxPromptsWidget.value = maxPromptsInput.value === "" ? 0 : Math.max(0, Math.floor(Number(maxPromptsInput.value)) || 0);
    if (typeof maxPromptsWidget.callback === "function") maxPromptsWidget.callback(maxPromptsWidget.value, node.graph?.canvas, node);
    node.graph?.setDirtyCanvas(true, true);
    updateEstimate();
  });
  seedInput.addEventListener("input", () => {
    if (!seedWidget || seedInput.value === "") return;
    seedWidget.value = Number(seedInput.value);
    if (typeof seedWidget.callback === "function") seedWidget.callback(seedWidget.value, node.graph?.canvas, node);
    node.graph?.setDirtyCanvas(true, true);
    updateEstimate();
  });
  seedModeSelect.addEventListener("change", () => {
    if (!seedModeWidget) return;
    seedModeWidget.value = seedModeSelect.value;
    if (typeof seedModeWidget.callback === "function") seedModeWidget.callback(seedModeWidget.value, node.graph?.canvas, node);
    node.graph?.setDirtyCanvas(true, true);
  });
  root.querySelector('[data-act="seedRandomizeNow"]').addEventListener("click", () => {
    if (!seedWidget) return;
    const maxSeed = Number.MAX_SAFE_INTEGER; // native widget's real ceiling is 2^64-1, JS numbers only carry 2^53-1 safely
    const randomSeed = Math.floor(Math.random() * maxSeed);
    seedWidget.value = randomSeed;
    seedInput.value = randomSeed;
    if (typeof seedWidget.callback === "function") seedWidget.callback(randomSeed, node.graph?.canvas, node);
    node.graph?.setDirtyCanvas(true, true);
    updateEstimate();
  });

  // ---- optional output: toggleable "prompt" socket, same pattern as the
  // Editor node's full input+output settings section (wildcard_editor.js) --
  // this node only ever needs the one entry, since none of its other
  // outputs (model/clip/conditioning/seed_out/wildcards_used) were ever
  // asked for here and clip_token_count doesn't exist on this node at all.
  // `default: true` keeps "prompt" visible exactly as before on every
  // already-saved workflow -- see renderIoToggleRow's doc comment in
  // wildcard_editor.js for why that matters.
  const IO_OUTPUT_DEFS = [
    { key: "prompt", type: "STRING", label: "Prompt", default: true, desc: "The list of resolved prompt texts, one per generated combination/random pick. This node's primary output \u2014 hide only if you're chaining purely through the other outputs (model/clip/conditioning/seed_out/wildcards_used)." },
  ];

  node.properties = node.properties || {};
  node.properties.wg_io = node.properties.wg_io || { inputs: {}, outputs: {} };

  const outWrap = el("ioOutputToggles");
  function renderIoToggles() {
    outWrap.innerHTML = "";
    IO_OUTPUT_DEFS.forEach(def => renderIoToggleRow(node, "output", def, outWrap, "data-io-out"));
  }
  renderIoToggles();
  // Backend declares this output unconditionally, so LiteGraph auto-creates
  // the slot the moment the node is built. Sync it against saved state (or
  // `default: true` for a brand-new node/first load) so it starts exactly
  // where it should rather than always-on regardless of the toggle.
  //
  // DEFERRED (setTimeout 0) -- same fix and same reasoning as
  // wildcard_editor.js's own onNodeCreated: this is the "prompt" output's
  // own socket-restore race, which can silently steal or misplace a saved
  // link the same way (see that file's comment, right above the matching
  // line, for the full explanation of why a synchronous call here reads
  // this node's not-yet-restored wg_io and mutates the live socket array
  // right as ComfyUI is reconnecting saved links against it).
  setTimeout(() => {
    if (node._wgConfigured) migrateIoState(node, "output", IO_OUTPUT_DEFS);
    IO_OUTPUT_DEFS.forEach(def => syncIoSocket(node, "output", def, ioEnabled(node, "output", def)));
  }, 0);
  node._wgRefreshIoToggles = function () {
    renderIoToggles();
    if (node._wgConfigured) migrateIoState(node, "output", IO_OUTPUT_DEFS);
    IO_OUTPUT_DEFS.forEach(def => syncIoSocket(node, "output", def, ioEnabled(node, "output", def)));
  };

  const settingsPopup = el("settingsPopup");
  const settingsBtn = root.querySelector('[data-act="settings"]');
  function openSettings() { settingsPopup.classList.add("open"); }
  function closeSettings() { settingsPopup.classList.remove("open"); }
  settingsBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (settingsPopup.classList.contains("open")) closeSettings();
    else openSettings();
  });
  root.querySelectorAll('[data-act="closeSettings"]').forEach(btn => btn.addEventListener("click", closeSettings));
  // Named (not inline) so cleanup() below can remove it -- an anonymous
  // listener here would otherwise stay registered on `document` forever
  // after this node is deleted, referencing its now-detached settingsPopup.
  const handleSettingsOutsideClick = (e) => {
    // A native app.extensionManager dialog (New Theme, Rename Theme, ...)
    // renders outside settingsPopup's DOM subtree -- see the matching guard
    // in wildcard_editor.js's own handleOutsideClick for why this has to be
    // skipped while one is open.
    if (isDialogOpen()) return;
    if (settingsPopup.classList.contains("open") && !settingsPopup.contains(e.target) && e.target !== settingsBtn) {
      closeSettings();
    }
  };
  document.addEventListener("mousedown", handleSettingsOutsideClick);

  // ---- accessibility: font family / sizes / prompt text color ----
  // Ported from the Editor node's own "Accessibility" section
  // (wildcard_editor.js). Applied to document.documentElement, same as
  // there, so it's a single global legibility preference shared by every
  // Prompt Palette node on the canvas -- not just this one -- and, unlike
  // before this port, now takes effect even in workflows that only use
  // Combinatorial nodes and never touch an Editor node's own settings panel.
  const fontFamilyInput = el("fontFamilyInput");
  const fontStatus = el("fontStatus");
  const editorFontRange = el("editorFontRange"), editorFontOut = el("editorFontOut");
  const uiFontRange = el("uiFontRange"), uiFontOut = el("uiFontOut");
  const promptTextColorInput = el("promptTextColor");

  function setFontStatus(msg, isErr) {
    fontStatus.textContent = msg || "";
    fontStatus.className = "wg-status" + (isErr ? " err" : "");
  }

  function applyFontSettings() {
    const r = document.documentElement.style;
    if (theme.fontFamily && theme.fontFamily.trim()) {
      r.setProperty("--wg-font-family", `"${theme.fontFamily.trim()}"`);
    } else {
      r.removeProperty("--wg-font-family");
    }
    r.setProperty("--wg-editor-font-size", `${theme.editorFontSize}px`);
    r.setProperty("--wg-ui-font-scale", theme.uiFontScale);
    r.setProperty("--wg-prompt-text", theme.promptTextColor);
  }

  function refreshFontControlsUI() {
    fontFamilyInput.value = theme.fontFamily || "";
    editorFontRange.value = theme.editorFontSize;
    editorFontOut.textContent = `${theme.editorFontSize}px`;
    uiFontRange.value = Math.round(theme.uiFontScale * 100);
    uiFontOut.textContent = `${Math.round(theme.uiFontScale * 100)}%`;
    promptTextColorInput.value = theme.promptTextColor;
  }
  refreshFontControlsUI();

  fontFamilyInput.addEventListener("input", () => {
    theme.fontFamily = fontFamilyInput.value;
    saveTheme(theme); applyFontSettings();
  });
  editorFontRange.addEventListener("input", () => {
    theme.editorFontSize = parseFloat(editorFontRange.value);
    editorFontOut.textContent = `${theme.editorFontSize}px`;
    saveTheme(theme); applyFontSettings();
  });
  uiFontRange.addEventListener("input", () => {
    theme.uiFontScale = parseInt(uiFontRange.value, 10) / 100;
    uiFontOut.textContent = `${uiFontRange.value}%`;
    saveTheme(theme); applyFontSettings();
  });
  promptTextColorInput.addEventListener("input", () => {
    theme.promptTextColor = promptTextColorInput.value;
    saveTheme(theme); applyFontSettings();
  });
  root.querySelector('[data-act="fontClear"]').addEventListener("click", () => {
    theme.fontFamily = "";
    fontFamilyInput.value = "";
    saveTheme(theme); applyFontSettings();
    setFontStatus("using default fonts");
  });
  root.querySelector('[data-act="fontBrowseLocal"]').addEventListener("click", async () => {
    // Local Font Access API: Chrome/Edge 103+ only, requires a user gesture and a
    // one-time permission grant. Lets the page read the *names* of fonts actually
    // installed on the user's system (not the font files) so the family typed
    // into the input above is guaranteed to exist, instead of guessing.
    if (typeof window.queryLocalFonts !== "function") {
      setFontStatus("Your browser doesn't support browsing installed fonts (Chrome/Edge only). Type a font name manually \u2014 it must already be installed on your system for the browser to render it.", true);
      return;
    }
    try {
      const fonts = await window.queryLocalFonts();
      const families = Array.from(new Set(fonts.map(f => f.family))).sort();
      if (!families.length) { setFontStatus("no local fonts found", true); return; }
      fontStatus.innerHTML = "";
      fontStatus.className = "wg-status";
      const sel = document.createElement("select");
      sel.className = "wg-theme-select";
      sel.style.marginTop = "4px";
      sel.innerHTML = `<option value="">${families.length} installed fonts found \u2014 pick one\u2026</option>` +
        families.map(f => `<option value="${escapeHtml(f)}">${escapeHtml(f)}</option>`).join("");
      sel.addEventListener("change", () => {
        if (!sel.value) return;
        theme.fontFamily = sel.value;
        fontFamilyInput.value = sel.value;
        saveTheme(theme); applyFontSettings();
        setFontStatus(`using "${sel.value}"`);
      });
      fontStatus.appendChild(sel);
    } catch (e) {
      setFontStatus("font permission denied or unavailable", true);
    }
  });
  applyFontSettings();

  // ---- interface theme (UI chrome, not the token/text colors below) ----
  // Ported from the Editor node's own "Interface theme" section. Applied to
  // document.documentElement, same as there, so this node's theme choice
  // stays in sync with every other Prompt Palette node on the canvas
  // (Editor or Combinatorial) -- it's one shared global setting either way.
  const uiThemeSelect = el("uiThemeSelect");
  const uiThemeSwatches = el("uiThemeSwatches");
  const uiThemeStatus = el("uiThemeStatus");

  let customUiThemes = loadUiThemes();
  let activeUiThemeName = loadActiveUiThemeName();

  function allUiThemes() { return { ...BUILTIN_UI_THEMES, ...customUiThemes }; }
  function isBuiltinUiTheme(name) { return !!BUILTIN_UI_THEMES[name] && !customUiThemes[name]; }
  if (!allUiThemes()[activeUiThemeName]) activeUiThemeName = "Amber";

  function applyUiTheme() {
    const t = allUiThemes()[activeUiThemeName] || BUILTIN_UI_THEMES.Amber;
    UI_THEME_KEYS.forEach(([key]) => {
      document.documentElement.style.setProperty(`--wg-${key}`, t[key]);
    });
    // Also recolor the underlying LiteGraph node itself (title bar + body),
    // same as the Editor node does, so no strip of the default grey node
    // canvas shows around/behind the UI on light themes like Daylight.
    node.bgcolor = t.bg;
    node.color = t.accent;
    node.graph?.setDirtyCanvas(true, true);
    updateDayNightIcon();
  }
  function setUiThemeStatus(msg, isErr) {
    uiThemeStatus.textContent = msg || "";
    uiThemeStatus.className = "wg-status" + (isErr ? " err" : "");
  }
  function renderUiThemeSelect() {
    const themes = allUiThemes();
    uiThemeSelect.innerHTML = Object.keys(themes).sort().map(name =>
      `<option value="${escapeHtml(name)}" ${name === activeUiThemeName ? "selected" : ""}>${escapeHtml(name)}${isBuiltinUiTheme(name) ? "" : " (custom)"}</option>`
    ).join("");
  }
  function renderUiThemeSwatches() {
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
        applyUiTheme();
      });
      uiThemeSwatches.appendChild(item);
    });
    setUiThemeStatus(locked ? "built-in theme \u2014 hit \u201cNew\u201d to make an editable copy" : "");
  }
  function refreshUiThemeUI() { renderUiThemeSelect(); renderUiThemeSwatches(); refreshDayNightSelects(); }

  // ---- Day/Night quick toggle (header button) ----
  const dayNightBtn = el("dayNightBtn");
  const dayThemeSelect = el("dayThemeSelect");
  const nightThemeSelect = el("nightThemeSelect");

  function refreshDayNightSelects() {
    const themes = allUiThemes();
    const names = Object.keys(themes).sort();
    if (!themes[theme.dayTheme]) theme.dayTheme = names.includes("Daylight") ? "Daylight" : names[0];
    if (!themes[theme.nightTheme]) theme.nightTheme = names.includes("Amber") ? "Amber" : names[0];
    saveTheme(theme);
    [[dayThemeSelect, "dayTheme"], [nightThemeSelect, "nightTheme"]].forEach(([sel, key]) => {
      sel.innerHTML = names.map(n =>
        `<option value="${escapeHtml(n)}" ${n === theme[key] ? "selected" : ""}>${escapeHtml(n)}</option>`
      ).join("");
    });
  }
  // Icon reflects the ACTION (what clicking will do): moon while in the day
  // theme (click to go dark), sun once night theme is active (click for day).
  function updateDayNightIcon() {
    const inNight = theme.nightTheme && activeUiThemeName === theme.nightTheme;
    dayNightBtn.innerHTML = inNight ? "&#9728;" : "&#127769;";
    dayNightBtn.title = inNight ? "Switch to day theme" : "Switch to night theme";
  }
  dayThemeSelect.addEventListener("change", () => {
    theme.dayTheme = dayThemeSelect.value;
    saveTheme(theme);
    updateDayNightIcon();
  });
  nightThemeSelect.addEventListener("change", () => {
    theme.nightTheme = nightThemeSelect.value;
    saveTheme(theme);
    updateDayNightIcon();
  });
  dayNightBtn.addEventListener("click", () => {
    const target = activeUiThemeName === theme.nightTheme ? theme.dayTheme : theme.nightTheme;
    if (!target || !allUiThemes()[target]) return; // configured theme got renamed/deleted — nothing to switch to
    activeUiThemeName = target;
    saveActiveUiThemeName(activeUiThemeName);
    applyUiTheme();
    refreshUiThemeUI();
  });

  uiThemeSelect.addEventListener("change", () => {
    activeUiThemeName = uiThemeSelect.value;
    saveActiveUiThemeName(activeUiThemeName);
    applyUiTheme();
    renderUiThemeSwatches();
  });
  root.querySelector('[data-act="uiThemeNew"]').addEventListener("click", async () => {
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
    applyUiTheme();
    refreshUiThemeUI();
  });
  root.querySelector('[data-act="uiThemeRename"]').addEventListener("click", async () => {
    if (isBuiltinUiTheme(activeUiThemeName)) return setUiThemeStatus("built-in themes can't be renamed", true);
    let name = await dialogPrompt({
      title: "Rename Theme",
      message: "Rename theme:",
      defaultValue: activeUiThemeName,
    });
    if (!name) return;
    name = name.trim();
    if (!name || name === activeUiThemeName) return;
    if (allUiThemes()[name]) return setUiThemeStatus("a theme with that name already exists", true);
    customUiThemes[name] = customUiThemes[activeUiThemeName];
    delete customUiThemes[activeUiThemeName];
    saveUiThemes(customUiThemes);
    activeUiThemeName = name;
    saveActiveUiThemeName(name);
    refreshUiThemeUI();
  });
  root.querySelector('[data-act="uiThemeDelete"]').addEventListener("click", () => {
    if (isBuiltinUiTheme(activeUiThemeName)) return setUiThemeStatus("built-in themes can't be deleted", true);
    delete customUiThemes[activeUiThemeName];
    saveUiThemes(customUiThemes);
    activeUiThemeName = "Amber";
    saveActiveUiThemeName(activeUiThemeName);
    applyUiTheme();
    refreshUiThemeUI();
  });
  root.querySelector('[data-act="uiThemeImport"]').addEventListener("click", async () => {
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
      applyUiTheme();
      refreshUiThemeUI();
      setUiThemeStatus(`imported "${name}"`);
    } catch (e) {
      setUiThemeStatus("clipboard doesn't contain a valid theme JSON", true);
    }
  });
  root.querySelector('[data-act="uiThemeExport"]').addEventListener("click", async () => {
    const t = allUiThemes()[activeUiThemeName] || BUILTIN_UI_THEMES.Amber;
    const payload = { name: activeUiThemeName, ...t };
    await navigator.clipboard.writeText(JSON.stringify(payload, null, 2)).catch(() => {});
    setUiThemeStatus("copied theme JSON to clipboard \u2014 share the file to let others import it");
  });

  // ---- wildcard token colors (hue/saturation) + category colors ----
  // These two already drove this node's own token-coloring logic before this
  // port (see colorForWildcard's use of theme.hueRotate/theme.saturation/
  // theme.categoryPins above) -- what was missing was just the settings UI
  // to change them, which is what's wired up here now.
  const hueRange = el("hueRange"), hueOut = el("hueOut");
  const satRange = el("satRange"), satOut = el("satOut");
  hueRange.value = theme.hueRotate; hueOut.textContent = theme.hueRotate + "\u00b0";
  satRange.value = theme.saturation; satOut.textContent = theme.saturation + "%";
  hueRange.addEventListener("input", () => { theme.hueRotate = parseInt(hueRange.value, 10); hueOut.textContent = theme.hueRotate + "\u00b0"; saveTheme(theme); render(); });
  satRange.addEventListener("input", () => { theme.saturation = parseInt(satRange.value, 10); satOut.textContent = theme.saturation + "%"; saveTheme(theme); render(); });

  function renderCatPins() {
    const wrap = el("catPins");
    const categories = Array.from(new Set(libraryCache.map(l => categoryOf(l.path)))).sort();
    wrap.innerHTML = "";
    categories.forEach(cat => {
      const row = document.createElement("div"); row.className = "wg-catpin-row";
      const current = theme.categoryPins[cat] || hslToHex((hashStr(cat) % 360 + theme.hueRotate) % 360, theme.saturation, 66);
      row.innerHTML = `<span>${escapeHtml(cat)}</span><input type="color" value="${current}">`;
      row.querySelector("input").addEventListener("input", (e) => { theme.categoryPins[cat] = e.target.value; saveTheme(theme); render(); });
      wrap.appendChild(row);
    });
  }

  // ---- import / export token theme (font + token/category color prefs) ----
  function updateThemeJson() {
    el("themeJson").value = JSON.stringify(theme, null, 2);
  }
  root.querySelector('[data-act="copyTheme"]').addEventListener("click", async (e) => {
    await navigator.clipboard.writeText(el("themeJson").value).catch(() => {});
    e.target.textContent = "Copied"; setTimeout(() => e.target.textContent = "Copy JSON", 1200);
  });
  root.querySelector('[data-act="pasteTheme"]').addEventListener("click", async () => {
    try {
      const text = await navigator.clipboard.readText();
      const parsed = JSON.parse(text);
      Object.assign(theme, { ...defaultTheme(), ...parsed });
      hueRange.value = theme.hueRotate || 0; hueOut.textContent = (theme.hueRotate || 0) + "\u00b0";
      satRange.value = theme.saturation || 65; satOut.textContent = (theme.saturation || 65) + "%";
      refreshFontControlsUI();
      saveTheme(theme); applyFontSettings(); render(); renderCatPins();
    } catch (e) { notify("error", "Paste failed", "Clipboard doesn't contain valid theme JSON."); }
  });
  root.querySelector('[data-act="resetTheme"]').addEventListener("click", () => {
    Object.assign(theme, defaultTheme());
    hueRange.value = 0; hueOut.textContent = "0\u00b0";
    satRange.value = 65; satOut.textContent = "65%";
    refreshFontControlsUI();
    saveTheme(theme); applyFontSettings(); render(); renderCatPins();
  });

  applyUiTheme();
  refreshUiThemeUI();

  modeButtons.forEach(btn => {
    btn.addEventListener("click", () => {
      if (!modeWidget || modeWidget.value === btn.dataset.mode) return;
      modeWidget.value = btn.dataset.mode;
      if (typeof modeWidget.callback === "function") modeWidget.callback(modeWidget.value, node.graph?.canvas, node);
      node.graph?.setDirtyCanvas(true, true);
      updateModeUI();
    });
  });

  // ---- mode-aware show/hide: count only matters in random mode,
  // max_prompts only matters in combinatorial mode (requirement #2) ----
  function updateModeUI() {
    const mode = modeWidget ? modeWidget.value : "random";
    modeButtons.forEach(b => b.classList.toggle("pp-active", b.dataset.mode === mode));
    countRow.classList.toggle("pp-hidden", mode !== "random");
    maxPromptsRow.classList.toggle("pp-hidden", mode !== "combinatorial");
    updateEstimate();
  }

  // ---- live combination-count estimate + cap warning (requirement #3) ----
  // Random mode is exactly `count` -- no backend round-trip needed, it's
  // already known from the widget's own value. Combinatorial mode depends on
  // the text's wildcard/brace structure, which only the Python resolver can
  // size correctly (see wildcard_combinatorial_routes.py /
  // WildcardResolver.count_combinatorial) -- debounced so it isn't fired on
  // every keystroke.
  let estimateDebounceTimer = null;
  let estimateSeq = 0;

  function renderEstimate(count, truncated, cap) {
    const displayCount = truncated ? `${count.toLocaleString()}+` : count.toLocaleString();
    estimateCount.textContent = `${displayCount} prompt${count === 1 && !truncated ? "" : "s"}`;
    const willCap = truncated || count > cap;
    estimateBox.classList.toggle("pp-warning", willCap);
    estimateWarning.textContent = willCap
      ? `Hits the ${cap.toLocaleString()}-prompt cap \u2014 only the first ${cap.toLocaleString()} combinations will run this queue.`
      : "";
    const fanoutN = willCap ? cap : count;
    fanoutCount.textContent = fanoutN.toLocaleString();
    fanoutPlural.textContent = fanoutN === 1 ? "" : "s";
    fanoutBanner.classList.toggle("pp-warning", willCap);
  }

  async function runCombinatorialEstimate() {
    const mySeq = ++estimateSeq;
    const maxPromptsRaw = maxPromptsWidget ? Math.floor(Number(maxPromptsWidget.value)) || 0 : 0;
    const cap = maxPromptsRaw > 0 ? maxPromptsRaw : DEFAULT_MAX_PROMPTS;
    const seed = seedWidget ? seedWidget.value : 0;
    try {
      const { count, truncated } = await API.countCombinatorial(textarea.value, seed, maxPromptsRaw);
      if (mySeq !== estimateSeq) return; // superseded by a newer edit -- discard this stale response
      renderEstimate(count, truncated, cap);
    } catch (e) {
      if (mySeq !== estimateSeq) return;
      estimateCount.textContent = "unavailable";
      estimateWarning.textContent = "";
      estimateBox.classList.remove("pp-warning");
    } finally {
      if (mySeq === estimateSeq) estimateBox.classList.remove("pp-loading");
    }
  }

  function updateEstimate() {
    clearTimeout(estimateDebounceTimer);
    const mode = modeWidget ? modeWidget.value : "random";
    if (mode === "random") {
      estimateBox.classList.remove("pp-loading");
      const n = countWidget ? Math.max(1, Math.floor(Number(countWidget.value)) || 1) : 1;
      renderEstimate(n, false, n);
      return;
    }
    estimateBox.classList.add("pp-loading");
    estimateDebounceTimer = setTimeout(runCombinatorialEstimate, ESTIMATE_DEBOUNCE_MS);
  }

  // ---- syntax highlighting (ported from highlightText()/render() in
  // wildcard_editor.js -- same tokenizing regex, same .wg-tok-* classes, so
  // this reads as identical output, not a plainer version) ----
  function isKnown(name) {
    return knownSet.has(name) || Array.from(knownSet).some(n => n.split("/").pop() === name.split("/").pop());
  }
  function extractWildcardNames(text) {
    const names = new Set(); const re = /__[+*]?([A-Za-z0-9_\-\/]+)__/g; let m;
    while ((m = re.exec(text))) names.add(m[1]);
    return Array.from(names);
  }
  function buildCategoryColorMap(categoriesInUse) {
    const hues = {};
    categoriesInUse.forEach(cat => { hues[cat] = theme.categoryPins[cat] ? null : (hashStr(cat) % 360 + theme.hueRotate) % 360; });
    const entries = Object.entries(hues).filter(([, v]) => v !== null);
    entries.sort((a, b) => a[1] - b[1]);
    for (let i = 1; i < entries.length; i++) {
      if (entries[i][1] - entries[i - 1][1] < 20) entries[i][1] = entries[i - 1][1] + 20;
    }
    entries.forEach(([cat, hue]) => { hues[cat] = hue % 360; });
    return hues;
  }
  function colorForToken(name, categoryHueMap) {
    const cat = categoryOf(name);
    if (theme.categoryPins[cat]) return theme.categoryPins[cat];
    const hue = categoryHueMap[cat] !== undefined ? categoryHueMap[cat] : (hashStr(cat) % 360 + theme.hueRotate) % 360;
    const leaf = name.split("/").pop();
    const shadeShift = (hashStr(leaf) % 20) - 10;
    return `hsl(${hue}, ${theme.saturation}%, ${Math.min(78, Math.max(52, 66 + shadeShift))}%)`;
  }
  function highlightText(text) {
    const names = extractWildcardNames(text);
    const categoriesInUse = Array.from(new Set(names.map(categoryOf)));
    const categoryHueMap = buildCategoryColorMap(categoriesInUse);
    let out = ""; let i = 0; const ranges = [];
    while (i < text.length) {
      const rest = text.slice(i);
      const wildcardMatch = rest.match(/^__[+*]?[A-Za-z0-9_\-\/]+__/);
      if (wildcardMatch) {
        const token = wildcardMatch[0];
        const innerName = token.replace(/^__[+*]?/, "").replace(/__$/, "");
        const start = i, end = i + token.length;
        if (isKnown(innerName)) {
          const color = colorForToken(innerName, categoryHueMap);
          out += `<span class="wg-token" style="color:${color}; font-weight:600;">${escapeHtml(token)}</span>`;
          ranges.push({ start, end, name: innerName, known: true });
        } else {
          out += `<span class="wg-tok-error">${escapeHtml(token)}</span>`;
          ranges.push({ start, end, name: innerName, known: false });
        }
        i = end; continue;
      }
      const weightMatch = rest.match(/^\d+::/);
      if (weightMatch) { out += `<span class="wg-tok-weight">${escapeHtml(weightMatch[0])}</span>`; i += weightMatch[0].length; continue; }
      const quantMatch = rest.match(/^(\d+(-\d+)?\$\$[^$]*\$\$|\d+#)/);
      if (quantMatch) { out += `<span class="wg-tok-mod">${escapeHtml(quantMatch[0])}</span>`; i += quantMatch[0].length; continue; }
      const ch = text[i];
      if (ch === "{" || ch === "}") { out += `<span class="wg-tok-bracket">${ch}</span>`; i++; continue; }
      if (ch === "|") { out += `<span class="wg-tok-pipe">|</span>`; i++; continue; }
      if (ch === "#" && (i === 0 || text[i - 1] === "\n")) {
        const lineEnd = text.indexOf("\n", i);
        const line = lineEnd === -1 ? text.slice(i) : text.slice(i, lineEnd);
        out += `<span class="wg-tok-comment">${escapeHtml(line)}</span>`; i += line.length; continue;
      }
      out += escapeHtml(ch); i++;
    }
    tokenRanges = ranges;
    return { html: out, names, categoriesInUse, categoryHueMap };
  }

  function syncHiddenWidget() {
    hiddenWidget.value = textarea.value;
    if (typeof hiddenWidget.callback === "function") hiddenWidget.callback(hiddenWidget.value);
    node.properties = node.properties || {};
    node.properties.wg_text = textarea.value;
    node.graph?.setDirtyCanvas(true, true);
  }

  function render() {
    const { html, names, categoriesInUse, categoryHueMap } = highlightText(textarea.value);
    highlight.innerHTML = html + "\n";
    legend.innerHTML = "";
    categoriesInUse.forEach(cat => {
      const color = theme.categoryPins[cat] || `hsl(${categoryHueMap[cat]}, ${theme.saturation}%, 66%)`;
      const chip = document.createElement("div");
      chip.className = "wg-chip";
      chip.innerHTML = `<span class="wg-sw" style="background:${color}; border-radius:50%;"></span>${escapeHtml(cat)}`;
      legend.appendChild(chip);
    });
    const knownCount = names.filter(isKnown).length;
    const missingCount = names.length - knownCount;
    hintRight.textContent = `${knownCount} resolved-ready \u00b7 ${missingCount} missing`;
    const len = textarea.value.length;
    charCount.textContent = `${len.toLocaleString()} char${len === 1 ? "" : "s"}`;
    syncHiddenWidget();
    updateEstimate();
    updateThemeJson();
  }

  function refreshFromHidden() {
    const restored =
      (node.properties && typeof node.properties.wg_text === "string" && node.properties.wg_text) ||
      hiddenWidget.value ||
      "";
    if (restored !== textarea.value) {
      textarea.value = restored;
      render();
    }
    syncControlsFromWidgets();
  }

  // ---- "__" wildcard autocomplete (reused as-is: findWildcardFragment /
  // openOrUpdateAcMenu / closeAcMenu are the same module-level singleton
  // menu the Editor node's textarea drives -- see wildcard_editor.js) ----
  function getAcMatches(query) {
    const q = query.toLowerCase();
    return libraryCache.map(i => i.path).filter(p => p.toLowerCase().includes(q)).slice(0, 20);
  }
  function recheckAcOnCaretMove() {
    const fragment = findWildcardFragment(textarea.value, textarea.selectionStart);
    if (!fragment) { closeAcMenu(); return; }
    openOrUpdateAcMenu(textarea, fragment, getAcMatches, () => render());
  }
  textarea.addEventListener("input", () => { render(); recheckAcOnCaretMove(); });
  textarea.addEventListener("keyup", (e) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Home" || e.key === "End") recheckAcOnCaretMove();
  });
  textarea.addEventListener("click", recheckAcOnCaretMove);
  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { closeAcMenu(); closeInjectMenu(); }
  });

  // ---- hover preview (ported from wildcard_editor.js's charIndexFromEvent /
  // showTipForName -- same approximate monospace hit-test, same .wg-tip
  // singleton element, so a hovered token looks and behaves identically to
  // the Editor node's) ----
  let hoverTip = document.querySelector(".wg-tip");
  if (!hoverTip) {
    hoverTip = document.createElement("div");
    hoverTip.className = "wg-tip";
    document.body.appendChild(hoverTip);
  }
  function charIndexFromEvent(e) {
    const cs = getComputedStyle(textarea);
    const lineH = parseFloat(cs.lineHeight) || 20;
    const padT = parseFloat(cs.paddingTop) || 8;
    const padL = parseFloat(cs.paddingLeft) || 10;
    const charW = 7.4;
    const rect = textarea.getBoundingClientRect();
    const x = e.clientX - rect.left + textarea.scrollLeft - padL;
    const y = e.clientY - rect.top + textarea.scrollTop - padT;
    const row = Math.max(0, Math.floor(y / lineH));
    const col = Math.max(0, Math.round(x / charW));
    const lines = textarea.value.split("\n");
    if (row >= lines.length) return -1;
    let idx = 0;
    for (let i = 0; i < row; i++) idx += lines[i].length + 1;
    return idx + Math.min(col, lines[row].length);
  }
  async function showTipForName(x, y, name, known) {
    let entry = previewCache.get(name);
    if (!entry) {
      entry = await API.preview(name);
      previewCache.set(name, entry);
    }
    const lines = (entry.lines || []).slice(0, 4);
    hoverTip.innerHTML = `<div class="wg-tip-title">${escapeHtml(known ? name : name + " (not found)")}</div>` +
      (lines.length ? lines.map(l => `<div class="wg-tip-line">${escapeHtml(l)}</div>`).join("") :
        `<div class="wg-tip-line">${known ? "no preview available" : "file missing"}</div>`);
    hoverTip.style.left = (x + 14) + "px";
    hoverTip.style.top = (y + 14) + "px";
    hoverTip.style.display = "block";
  }
  function hideTip() { hoverTip.style.display = "none"; }
  let hoverDebounce = null;
  textarea.addEventListener("mousemove", (e) => {
    const idx = charIndexFromEvent(e);
    const tok = tokenRanges.find(t => idx >= t.start && idx < t.end);
    clearTimeout(hoverDebounce);
    if (tok) hoverDebounce = setTimeout(() => showTipForName(e.clientX, e.clientY, tok.name, tok.known), 120);
    else hideTip();
  });
  textarea.addEventListener("mouseleave", hideTip);
  textarea.addEventListener("scroll", () => { highlight.scrollTop = textarea.scrollTop; highlight.scrollLeft = textarea.scrollLeft; });

  // ---- Syntax Injector: right-click a wildcard token to open the same
  // ⚡ flyout (Random/Sequential modifiers, {…} templates, Cut/Copy/Paste)
  // the picker row's trigger opens, scoped to that exact token occurrence
  // (see insertWildcard/pickerItemRow below for the picker-row entry point).
  // Ported from wildcard_editor.js's textarea "contextmenu" handler, minus
  // the selection-based "extract to new wildcard / Palette Recipe" actions,
  // which are Editor-only features this node doesn't have. ----
  textarea.addEventListener("contextmenu", (e) => {
    if (theme.syntaxInjectorEnabled === false) return; // Zen mode -- off, same as the picker's ⚡ trigger
    const idx = textarea.selectionStart;
    const tok = tokenRanges.find(t => t.start <= idx && t.end >= idx);
    if (!tok) return; // not on a wildcard token -- leave the browser's native menu alone
    e.preventDefault();
    hideTip();
    if (ctxMenuOpen) closeCtxMenu();
    textarea.selectionStart = tok.start;
    textarea.selectionEnd = tok.end;
    openInjectMenuAtPoint(e.clientX, e.clientY, tok.name, textarea, render, { start: tok.start, end: tok.end });
  });

  // ---- folder picker drawer (ported subset of wildcard_editor.js's
  // renderPickerList/pickerRow: search + category folders + pin + click-to-
  // insert + hover-preview, sharing the same pp_pinned/pp_expanded_cats/
  // pp_cat_order localStorage keys so folder state stays consistent between
  // this node and the Editor node) ----
  function insertWildcard(path) {
    const start = textarea.selectionStart, end = textarea.selectionEnd;
    const tag = `__${path}__`;
    textarea.value = textarea.value.slice(0, start) + tag + textarea.value.slice(end);
    const caret = start + tag.length;
    textarea.selectionStart = textarea.selectionEnd = caret;
    textarea.focus();
    render();
  }
  function pickerItemRow(item, filter) {
    const row = document.createElement("div");
    row.className = "wg-item";
    const cat = categoryOf(item.path);
    const hueMap = buildCategoryColorMap([cat]);
    const color = colorForToken(item.path, hueMap);
    const isPinned = pinned.has(item.path);
    row.innerHTML =
      `<span class="wg-sw" style="background:${color}; border-radius:50%;"></span>` +
      `<span class="wg-name">${highlightMatch(item.path.split("/").pop(), filter)}</span>` +
      `<span class="wg-pin ${isPinned ? "pinned" : ""}">${isPinned ? "\u2605" : "\u2606"}</span>`;
    row.addEventListener("click", (e) => {
      if (e.target.classList.contains("wg-pin")) return;
      insertWildcard(item.path);
    });
    row.querySelector(".wg-pin").addEventListener("click", (e) => {
      e.stopPropagation();
      if (pinned.has(item.path)) pinned.delete(item.path); else pinned.add(item.path);
      savePinned(pinned);
      renderPickerList(searchInput.value);
    });

    // ---- Syntax Injector trigger (hover/click ⚡) ----
    // Combinatorial mode leans on __+/__*/{…} syntax more than most, so this
    // stays on by default (theme.syntaxInjectorEnabled, toggled from the
    // Editor node's Zen-mode setting -- shared theme, so switching it off
    // there hides it here too). Ported from wildcard_editor.js's pickerRow.
    if (theme.syntaxInjectorEnabled !== false) {
      const trigger = document.createElement("button");
      trigger.type = "button";
      trigger.className = "wg-inject-trigger";
      trigger.title = `Insert wildcard syntax for "${item.path}"`;
      trigger.innerHTML = "&#9889;"; // ⚡
      trigger.setAttribute("draggable", "false");
      trigger.addEventListener("mousedown", (e) => e.stopPropagation());
      let openDelay = null;
      trigger.addEventListener("click", (e) => {
        e.stopPropagation();
        clearTimeout(openDelay);
        if (injectState && injectState.trigger === trigger) closeInjectMenu();
        else openInjectMenu(trigger, item.path, textarea, render);
      });
      trigger.addEventListener("mouseenter", () => {
        clearTimeout(openDelay);
        openDelay = setTimeout(() => openInjectMenu(trigger, item.path, textarea, render), 90);
      });
      trigger.addEventListener("mouseleave", () => {
        clearTimeout(openDelay);
        scheduleCloseInjectMenu();
      });
      row.insertBefore(trigger, row.querySelector(".wg-pin"));
    }
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      closeInjectMenu();
      const nowPinned = pinned.has(item.path);
      const hasThumb = !!thumbMap[item.path];
      openCtxMenu(e.clientX, e.clientY, [
        { label: "Copy path", onSelect: () => { navigator.clipboard.writeText(`__${item.path}__`).catch(() => {}); } },
        {
          label: nowPinned ? "Unpin" : "Pin",
          onSelect: () => {
            if (pinned.has(item.path)) pinned.delete(item.path); else pinned.add(item.path);
            savePinned(pinned);
            renderPickerList(searchInput.value);
          },
        },
        { label: hasThumb ? "Change Thumbnail\u2026" : "Set Thumbnail\u2026", onSelect: () => setThumbnailForItem(item.path) },
        ...(hasThumb ? [{ label: "Remove Thumbnail", onSelect: () => removeThumbnailForItem(item.path) }] : []),
        { label: `Jump to "${cat}"`, onSelect: () => jumpToCategory(cat) },
      ]);
    });
    row.addEventListener("mousemove", (e) => showTipForName(e.clientX, e.clientY, item.path, true));
    row.addEventListener("mouseleave", hideTip);
    return row;
  }

  // Grid-view counterpart to pickerItemRow above -- same click-to-insert/
  // pin/context-menu behavior, laid out as a thumbnail tile instead of a
  // row. Ported from wildcard_editor.js's pickerTile, minus the Palette
  // Recipe/select-mode branches that node has and this one doesn't.
  function pickerTile(item) {
    const cat = categoryOf(item.path);
    const hueMap = buildCategoryColorMap([cat]);
    const color = colorForToken(item.path, hueMap);
    const isPinned = pinned.has(item.path);
    const name = item.path.split("/").pop();
    const thumbRel = thumbMap[item.path];
    const thumbBustQs = thumbBust[item.path] ? `&v=${thumbBust[item.path]}` : "";

    const thumbHtml = thumbRel
      ? `<img class="wg-thumb-img" src="/prompt_palette/thumb?file=${encodeURIComponent(thumbRel)}${thumbBustQs}" alt="" loading="lazy">`
      : `<div class="wg-thumb-fallback" style="background:color-mix(in srgb, ${color} 20%, var(--wg-surface, #131211));"><span class="wg-thumb-fallback-glyph" style="color:${color};">&#128193;</span></div>`;

    const tile = document.createElement("div");
    tile.className = "wg-thumb-item";
    tile.title = item.path;
    tile.innerHTML = `${thumbHtml}<span class="wg-thumb-pin ${isPinned ? "pinned" : ""}">${isPinned ? "\u2605" : "\u2606"}</span><span class="wg-thumb-name">${escapeHtml(name)}</span>`;

    tile.addEventListener("click", (e) => {
      if (e.target.closest(".wg-thumb-pin")) return;
      insertWildcard(item.path);
    });
    tile.querySelector(".wg-thumb-pin").addEventListener("click", (e) => {
      e.stopPropagation();
      if (pinned.has(item.path)) pinned.delete(item.path); else pinned.add(item.path);
      savePinned(pinned);
      renderPickerList(searchInput.value);
    });
    tile.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      closeInjectMenu();
      const nowPinned = pinned.has(item.path);
      const hasThumb = !!thumbMap[item.path];
      openCtxMenu(e.clientX, e.clientY, [
        { label: "Copy path", onSelect: () => { navigator.clipboard.writeText(`__${item.path}__`).catch(() => {}); } },
        {
          label: nowPinned ? "Unpin" : "Pin",
          onSelect: () => {
            if (pinned.has(item.path)) pinned.delete(item.path); else pinned.add(item.path);
            savePinned(pinned);
            renderPickerList(searchInput.value);
          },
        },
        { label: hasThumb ? "Change Thumbnail\u2026" : "Set Thumbnail\u2026", onSelect: () => setThumbnailForItem(item.path) },
        ...(hasThumb ? [{ label: "Remove Thumbnail", onSelect: () => removeThumbnailForItem(item.path) }] : []),
        { label: `Jump to "${cat}"`, onSelect: () => jumpToCategory(cat) },
      ]);
    });
    tile.addEventListener("mousemove", (e) => showTipForName(e.clientX, e.clientY, item.path, true));
    tile.addEventListener("mouseleave", hideTip);
    return tile;
  }

  // Appends `items` into `container` as either picker rows or a thumbnail
  // grid, depending on pickerViewMode -- shared by both the pinned section
  // and the category groups below so neither has to know which view is
  // active. Ported from wildcard_editor.js's appendItems.
  function appendItems(container, items, filter = "") {
    if (pickerViewMode === "grid") {
      const grid = document.createElement("div");
      grid.className = "wg-thumb-grid";
      items.forEach(item => grid.appendChild(pickerTile(item)));
      container.appendChild(grid);
    } else {
      items.forEach(item => container.appendChild(pickerItemRow(item, filter)));
    }
  }

  // Used by each row/tile's right-click context menu ("Jump to category").
  // Category folders only exist in the idle browse view, so an active
  // search filter is cleared first to bring the folder list back. Ported
  // from wildcard_editor.js's jumpToCategory.
  function jumpToCategory(cat) {
    searchInput.value = "";
    if (!expandedCats.has(cat)) {
      expandedCats.add(cat);
      saveExpandedCats(expandedCats);
    }
    renderPickerList("");
    requestAnimationFrame(() => {
      const header = pickerList.querySelector(`.wg-folder[data-cat="${CSS.escape(cat)}"]`);
      if (!header) return;
      header.scrollIntoView({ block: "center" });
      header.classList.add("wg-jump-flash");
      setTimeout(() => header.classList.remove("wg-jump-flash"), 900);
    });
  }

  // ---- Thumbnails: "Set Thumbnail..." / "Remove Thumbnail" context menu ----
  // Re-fetches just thumbMap + repaints the picker (not a full refreshLibrary)
  // so this stays fast and doesn't disturb pinned/scroll state. Ported from
  // wildcard_editor.js's refreshThumbMap/setThumbnailForItem/removeThumbnailForItem.
  async function refreshThumbMap() {
    try { thumbMap = await API.categories(); } catch (e) {}
    renderPickerList(searchInput.value);
  }
  async function setThumbnailForItem(path) {
    const file = await pickThumbnailFile();
    if (!file) return;
    const err = thumbnailFileError(file);
    if (err) { notify("error", "Thumbnail not set", err); return; }
    try {
      const res = await API.setThumbnail(path, file);
      if (!res.ok) { notify("error", "Thumbnail not set", res.error || "the server rejected the upload"); return; }
      thumbBust[path] = Date.now();
      await refreshThumbMap();
      notify("success", "Thumbnail updated", path.split("/").pop());
    } catch (e) {
      notify("error", "Thumbnail not set", "network error while uploading");
    }
  }
  async function removeThumbnailForItem(path) {
    try {
      const res = await API.removeThumbnail(path);
      if (!res.ok) { notify("error", "Thumbnail not removed", res.error || "the server rejected the request"); return; }
      thumbBust[path] = Date.now();
      await refreshThumbMap();
      notify("success", "Thumbnail removed", path.split("/").pop());
    } catch (e) {
      notify("error", "Thumbnail not removed", "network error");
    }
  }

  function renderPickerList(filter = "") {
    // The rows/tiles (and any context menu anchored to one) are about to be
    // torn down and rebuilt below -- close both flyouts first rather than
    // leaving them anchored to a DOM node that's about to be discarded.
    if (ctxMenuOpen) closeCtxMenu();
    if (injectState && injectState.textarea === textarea) closeInjectMenu();
    const q = (filter || "").trim().toLowerCase();
    let items = libraryCache;
    if (q) items = items.filter(i => i.path.toLowerCase().includes(q));
    pickerList.innerHTML = "";

    if (pinned.size && !q) {
      const pinnedItems = items.filter(i => pinned.has(i.path));
      if (pinnedItems.length) {
        const lbl = document.createElement("div");
        lbl.className = "wg-section-label"; lbl.textContent = "PINNED";
        pickerList.appendChild(lbl);
        appendItems(pickerList, pinnedItems, q);
      }
    }

    const grouped = {};
    items.forEach(item => { const cat = categoryOf(item.path); (grouped[cat] = grouped[cat] || []).push(item); });
    const cats = Object.keys(grouped).sort((a, b) => {
      const ia = catOrder.indexOf(a), ib = catOrder.indexOf(b);
      if (ia !== -1 && ib !== -1) return ia - ib;
      if (ia !== -1) return -1;
      if (ib !== -1) return 1;
      return a.localeCompare(b);
    });
    cats.forEach(cat => {
      if (!catOrder.includes(cat)) { catOrder.push(cat); saveCatOrder(catOrder); }
      const isExpanded = q ? true : expandedCats.has(cat);
      const header = document.createElement("div");
      header.className = "wg-folder" + (isExpanded ? " expanded" : "");
      header.dataset.cat = cat;
      header.innerHTML = `<span class="wg-folder-caret">${isExpanded ? "\u25BE" : "\u25B8"}</span><span class="wg-folder-name">${escapeHtml(cat)}</span><span class="wg-folder-count">${grouped[cat].length}</span>`;
      header.addEventListener("click", () => {
        if (expandedCats.has(cat)) expandedCats.delete(cat); else expandedCats.add(cat);
        saveExpandedCats(expandedCats);
        renderPickerList(searchInput.value);
      });
      pickerList.appendChild(header);
      if (isExpanded) appendItems(pickerList, grouped[cat], q);
    });

    if (!items.length) pickerList.innerHTML = `<div class="wg-hint" style="padding:6px;">no matches</div>`;
  }
  let searchDebounce = null;
  searchInput.addEventListener("input", () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => renderPickerList(searchInput.value), 150);
  });
  // ---- resizable picker sidebar (drag right edge, 220-640px) ----
  // Ported from wildcard_editor.js's identical feature -- this node's drawer
  // never had it, so it was stuck at the CSS-default 220px with no drag
  // handle. Shares the "pp_picker_width" localStorage key with the Editor
  // node's picker, same reasoning as the shared pickerViewMode key above:
  // one picker sidebar concept, one remembered width across both nodes.
  const PICKER_MIN_WIDTH = 220;
  const PICKER_MAX_WIDTH = 640;
  function loadPickerWidth() {
    try {
      const w = parseInt(localStorage.getItem("pp_picker_width"), 10);
      if (Number.isFinite(w)) return Math.min(PICKER_MAX_WIDTH, Math.max(PICKER_MIN_WIDTH, w));
    } catch (e) {}
    return PICKER_MIN_WIDTH;
  }
  function savePickerWidth(w) {
    try { localStorage.setItem("pp_picker_width", String(w)); } catch (e) {}
  }
  let pickerWidth = loadPickerWidth();

  const pickerResizeHandle = document.createElement("div");
  pickerResizeHandle.className = "wg-drawer-resize-handle";
  pickerResizeHandle.title = "Drag to resize";
  pickerDrawer.appendChild(pickerResizeHandle);

  let resizingPicker = false;
  let resizeStartX = 0;
  let resizeStartWidth = 0;
  pickerResizeHandle.addEventListener("mousedown", (e) => {
    if (!pickerDrawer.classList.contains("open")) return;
    resizingPicker = true;
    resizeStartX = e.clientX;
    resizeStartWidth = pickerDrawer.getBoundingClientRect().width;
    pickerDrawer.classList.add("resizing");
    document.body.style.userSelect = "none";
    e.preventDefault();
  });
  // Named (not inline), same reason as handleSettingsOutsideClick above --
  // removed on node delete in cleanup() below instead of leaking forever.
  const handlePickerResizeMove = (e) => {
    if (!resizingPicker) return;
    pickerWidth = Math.min(PICKER_MAX_WIDTH, Math.max(PICKER_MIN_WIDTH, resizeStartWidth + (e.clientX - resizeStartX)));
    pickerDrawer.style.width = pickerWidth + "px";
  };
  const handlePickerResizeUp = () => {
    if (!resizingPicker) return;
    resizingPicker = false;
    pickerDrawer.classList.remove("resizing");
    document.body.style.userSelect = "";
    savePickerWidth(pickerWidth);
  };
  document.addEventListener("mousemove", handlePickerResizeMove);
  document.addEventListener("mouseup", handlePickerResizeUp);

  function openPickerDrawer() {
    pickerDrawer.classList.add("open");
    root.querySelector('[data-act="picker"]').classList.add("active");
    pickerDrawer.style.width = pickerWidth + "px";
  }
  function closePickerDrawer() {
    pickerDrawer.classList.remove("open");
    root.querySelector('[data-act="picker"]').classList.remove("active");
    pickerDrawer.style.width = "";
  }
  root.querySelector('[data-act="picker"]').addEventListener("click", () => {
    if (pickerDrawer.classList.contains("open")) closePickerDrawer(); else openPickerDrawer();
  });

  // ---- picker grid/list view toggle ----
  // Ported from wildcard_editor.js's syncPickerViewToggleBtn/click handler,
  // sharing the pp_picker_view localStorage key (loadPickerView/savePickerView)
  // so the mode stays consistent between this node and the Editor node.
  function syncPickerViewToggleBtn() {
    pickerViewToggleBtn.classList.toggle("active", pickerViewMode === "grid");
    pickerViewToggleBtn.title = pickerViewMode === "grid" ? "Switch to list view" : "Switch to grid view";
  }
  syncPickerViewToggleBtn();
  pickerViewToggleBtn.addEventListener("click", () => {
    pickerViewMode = pickerViewMode === "grid" ? "list" : "grid";
    savePickerView(pickerViewMode);
    syncPickerViewToggleBtn();
    renderPickerList(searchInput.value);
  });

  async function refreshLibrary() {
    try { libraryCache = await API.list(); } catch (e) { libraryCache = []; }
    knownSet = new Set(libraryCache.map(i => i.path));
    try { thumbMap = await API.categories(); } catch (e) { thumbMap = {}; }
    render();
    renderPickerList(searchInput.value);
  }
  node._wgRefreshLibrary = refreshLibrary;

  root.querySelector('[data-act="refresh"]').addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.classList.add("active");
    try {
      await API.refreshWildcards();
      await refreshLibrary();
      notify("success", "Wildcards refreshed", "");
    } catch (err) {
      notify("error", "Refresh failed", String(err));
    } finally {
      btn.classList.remove("active");
    }
  });

  syncControlsFromWidgets();
  render();
  refreshLibrary().then(() => renderCatPins());

  const frame = document.createElement("div");
  frame.className = "pp-node-frame";
  frame.appendChild(root);

  return {
    root: frame,
    refreshFromHidden,
    reassertHiddenWidgets,
    cleanup: () => {
      if (acState && acState.textarea === textarea) closeAcMenu();
      document.removeEventListener("mousedown", handleSettingsOutsideClick);
      document.removeEventListener("mousemove", handlePickerResizeMove);
      document.removeEventListener("mouseup", handlePickerResizeUp);
    },
  };
}

app.registerExtension({
  name: "comfyui.promptpalette.combinatorial",
  async nodeCreated(node) {
    if (node.comfyClass !== "PromptPaletteCombinatorial") return;
    if (node.__promptPaletteCombinatorialInitialized) return;
    await Promise.all([editorStylesReady, combinatorialStylesReady]);

    const hiddenWidget = node.widgets?.find(w => w.name === "text");
    if (!hiddenWidget) return;
    Object.defineProperty(node, "__promptPaletteCombinatorialInitialized", {
      value: true,
      configurable: true,
    });

    hideNativeWidget(hiddenWidget);

    node.resizable = true;

    const MIN_WIDTH = 420;
    const MIN_HEIGHT = 430;

    const { root: container, refreshFromHidden, reassertHiddenWidgets, cleanup } = buildCombinatorialWidget(node, hiddenWidget);
    let domWidget;
    domWidget = node.addDOMWidget("prompt_palette_combinatorial_ui", "div", container, {
      getValue: () => hiddenWidget.value,
      setValue: (v) => {
        hiddenWidget.value = v;
        node.properties = node.properties || {};
        node.properties.wg_text = v;
      },
      serialize: false,
      // MIN_HEIGHT belongs to the whole node, not to this one widget row.
      // A widget-level minimum of MIN_HEIGHT makes Vue add the node header,
      // slots and padding on top and turns that oversized content minimum into
      // the node's effective locked height. Let LiteGraph allocate the row
      // from the current node body instead.
      getMinHeight: () => 0,
      getMaxHeight: () => getDomWidgetAvailableHeight(node, domWidget),
      getHeight: () => getDomWidgetAvailableHeight(node, domWidget),
      afterResize: () => scheduleDomWidgetRemeasure(node),
    });
    node._wgRefreshFromHidden = refreshFromHidden;
    node._wgReassertHiddenWidgets = reassertHiddenWidgets;
    livePromptPaletteNodes.add(node);

    // Same fix as wildcard_editor.js's onNodeCreated: ComfyUI mounts the
    // real DOM element for each hidden native widget (hiddenWidget,
    // modeWidget, countWidget, seedWidget, seedModeWidget,
    // maxPromptsWidget) asynchronously, after this onNodeCreated call
    // already returns -- stomping the synchronous hideNativeWidget() call
    // a few lines up the moment it mounts. onConfigure below already
    // re-runs reassertHiddenWidgets() (deferred the same way) for nodes
    // loaded from a saved workflow / restored on page refresh, which is
    // why reloading the page fixed existing nodes but any freshly created
    // node was broken again until the *next* reload routed it through
    // onConfigure instead. Deferring the same call here closes that gap
    // for fresh nodes too.
    setTimeout(() => reassertHiddenWidgets(), 0);
    scheduleDomWidgetRemeasure(node);

    const onRemoved = node.onRemoved;
    node.onRemoved = function () {
      livePromptPaletteNodes.delete(node);
      if (cleanup) cleanup();
      return onRemoved ? onRemoved.apply(this, arguments) : undefined;
    };

    function clampSize() {
      if (node.size[0] < MIN_WIDTH) node.size[0] = MIN_WIDTH;
      if (node.size[1] < MIN_HEIGHT) node.size[1] = MIN_HEIGHT;
    }
    const onResize = node.onResize;
    node.onResize = function (size) {
      const result = onResize ? onResize.apply(this, arguments) : undefined;
      clampSize();
      return result;
    };

    node.setSize([Math.max(node.size[0], MIN_WIDTH), Math.max(node.size[1], MIN_HEIGHT)]);

    const onConfigure = node.onConfigure;
    node.onConfigure = function () {
      this._wgConfigured = true;
      const r = onConfigure ? onConfigure.apply(this, arguments) : undefined;
      if (this._wgRefreshFromHidden) setTimeout(() => this._wgRefreshFromHidden(), 0);
      // node.properties (including wg_io) gets replaced wholesale by this same
      // restore step, *after* onNodeCreated already built the toggle UI off
      // the old reference -- re-render/re-sync against whatever came back,
      // same reasoning as wildcard_editor.js's own onConfigure hook.
      if (this._wgRefreshIoToggles) setTimeout(() => this._wgRefreshIoToggles(), 0);
      // See the matching comment in wildcard_editor.js's onConfigure: ComfyUI's
      // own restore step re-touches these widgets' DOM elements after the
      // onNodeCreated hide already ran, which is what left an invisible
      // click-blocking box below nodes loaded from a saved workflow. Re-hide
      // them here, after that restore has finished.
      if (this._wgReassertHiddenWidgets) setTimeout(() => this._wgReassertHiddenWidgets(), 0);
      scheduleDomWidgetRemeasure(this);
      return r;
    };
  },
});
