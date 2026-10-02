import { app } from "../../scripts/app.js";
import {
  loadExtensionStylesheet, svgIcon, copyPromptPaletteThemeScope,
  installPromptPaletteKeyboardBoundary, registerPromptPaletteSettingsDrawer,
} from "./prompt_palette_shared.js";
import { bindSuiteAppearance } from "./editor/suite_appearance.js";
import { readCombinatorialPreference, writeCombinatorialPreference } from "./prompt_palette_state.js";
import { upgradeEditorSurface } from "./editor/editor_surface.js";
import { createSyntaxHighlighter } from "./editor/syntax_highlighter.js";
import { libraryAcRows, recentAcRows, mergeUnifiedRows, rankLibraryPaths } from "./editor/autocomplete_sources.js";
import { createPromptUsageStore } from "./prompt_quickness.js";
import { createTagPainter, onTagColorsChanged, TAG_CATEGORY_KEYS, TAG_CATEGORY_LABELS } from "./editor/booru_tag_colors.js";
import {
  API, loadTheme, escapeHtml, highlightMatch, categoryOf, hashStr, normalizeLibraryEntryPath,
  editorStylesReady,
  sanitizeHexColor, categoryColorFromHue, currentUiSurface,
  getBooruAutocompleteMatches, attachAutocomplete,
  loadPinned, savePinned, loadExpandedCats, saveExpandedCats, loadCatOrder, saveCatOrder,
  notify, dialogPrompt, dialogConfirm, livePromptPaletteNodes, cleanupSharedPromptPaletteDom,

  loadPickerView, savePickerView, openCtxMenu, closeCtxMenu, ctxMenuOpen,
  pickThumbnailFile, thumbnailFileError,

  openInjectMenu, openInjectMenuAtPoint, closeInjectMenu, scheduleCloseInjectMenu, injectState,
  hideNativeWidget, installResponsiveDomWidgetWidth, getDomWidgetAvailableHeight, scheduleDomWidgetRemeasure,
  ensureNodeLifecycle, nodeIsActive, scheduleNodeTimer, cancelNodeTimer, clearNodeTimers, scheduleNodeFrame,
  installPromptStateGuard, installPromptMetadataCapture,

  ioEnabled, syncIoSocket, migrateIoState, canonicalizeOutputs, setupIoRail,
  installSocketRailLayout, cleanupSocketRailLayout, queueSocketRailLayout,
  isDialogOpen,
} from "./wildcard_editor.js";

const CSS_HREF = new URL("./css/wildcard_combinatorial.css", import.meta.url).href;
const combinatorialStylesReady = loadExtensionStylesheet(CSS_HREF, "prompt-palette-combinatorial").catch((error) => {
  console.error("Prompt Palette: failed to load combinatorial stylesheet", error);
  throw error;
});
const SEED_MODE_INFO = {
  sequential: { label: "Sequential", desc: "Steps to the next seed value each run \u2014 paired with Combinatorial mode, walks every combination in order without repeats." },
  fixed: { label: "Fixed", desc: "Reuses the same seed for every run \u2014 re-running reproduces the exact same prompt(s)." },
  random: { label: "Random", desc: "Rolls a fresh random seed every run." },
};

const ESTIMATE_DEBOUNCE_MS = 350;
const DEFAULT_MAX_PROMPTS = 5000;

function buildCombinatorialWidget(node, hiddenWidget) {
  const promptState = installPromptStateGuard(node, hiddenWidget);
  const theme = loadTheme();
  const pinned = loadPinned();
  const expandedCats = loadExpandedCats();
  let catOrder = loadCatOrder();

  let libraryCache = [];
  let knownSet = new Set();
  let thumbMap = {};
  let thumbBust = {};
  let pickerViewMode = loadPickerView();
  let tokenRanges = [];
  const previewCache = new Map();

  const root = document.createElement("div");
  root.className = "pp-node wg-root";
  const cleanupKeyboardBoundary = installPromptPaletteKeyboardBoundary(root);
  root.innerHTML = `
    <div class="pp-header">
      <div class="pp-badge"><span class="pp-badge-icon">${svgIcon("branch", 13)}</span><span>Combinatorial</span></div>
      <div class="pp-header-actions">
        <button type="button" class="wg-icon-btn" data-act="picker" data-el="btnGallery" title="My Library \u2014 browse and insert reusable entries" aria-label="Open My Library">${svgIcon("gallery")}</button>
        <button type="button" class="wg-icon-btn" data-act="refresh" data-el="btnRefresh" title="Rescan My Library files" aria-label="Rescan My Library">${svgIcon("refresh")}</button>
        <button type="button" class="wg-icon-btn wg-io-toggle-btn" data-act="ioRailToggle" aria-expanded="false" title="Manage inputs, outputs, and socket labels" aria-label="Manage inputs, outputs, and socket labels">${svgIcon("io", 13)}<span class="wg-io-button-label">I/O</span><span data-io-count></span></button>
        <button type="button" class="wg-icon-btn wg-settings-anchor" data-act="settings" title="Settings">${svgIcon("settings")}</button>
      </div>
    </div>
    <div class="pp-fanout-banner" data-el="fanoutBanner" title="The list outputs (Model list, CLIP list, Conditioning list, Prompt list, Seed list, Wildcards used, metadata list) hold one entry per generated prompt. Anything wired to one of those runs once per prompt, not once per queue run. The single-value outputs (passthrough, first, negative, count, raw text, ...) run once.">
      <span class="pp-fanout-icon">${svgIcon("branch", 14)}</span>
      <span>Fans out into <span class="pp-fanout-count" data-el="fanoutCount">1</span> prompt<span data-el="fanoutPlural"></span> \u2014 every wired list output fires once per prompt.</span>
    </div>
    <div class="wg-settings-popup wg-settings-pro pp-combo-settings" data-el="settingsPopup" role="dialog" aria-label="Combinatorial settings" aria-hidden="true" hidden inert>
      <div class="wg-settings-head wg-settings-head-pro">
        <div><span>Combinatorial</span><small>Node settings</small></div>
        <button type="button" class="wg-close-btn" data-act="closeSettings" title="Close settings" aria-label="Close Combinatorial settings">${svgIcon("close", 15)}</button>
      </div>
      <div class="wg-settings-shell">
        <nav class="wg-settings-nav" role="tablist" aria-label="Settings sections">
          <button type="button" role="tab" aria-selected="true" class="active" data-settings-tab="behavior"><span>Generation</span><small>Combinations &amp; seeds</small></button>
        </nav>
        <div class="wg-settings-body">
          <section role="tabpanel" class="wg-settings-panel active" data-settings-panel="behavior">
            <div class="wg-panel-title"><div><h3>Combinatorial behavior</h3><p>These mirror this node's generation controls. Suite themes, fonts, and colors live in the main Prompt Palette settings.</p></div></div>
            <div class="wg-settings-card-grid">
              <section class="wg-settings-card">
                <label class="wg-field"><span>Mode</span><select class="wg-theme-select" data-el="settingsModeSelect"><option value="random">Random</option><option value="combinatorial">Combinatorial</option></select></label>
                <label class="wg-field"><span>Count</span><input type="number" min="1" step="1" class="wg-theme-select" data-el="settingsCountInput"></label>
              </section>
              <section class="wg-settings-card">
                <label class="wg-field"><span>Seed behavior</span><select class="wg-theme-select" data-el="settingsSeedModeSelect"></select></label>
                <label class="wg-field"><span>Maximum prompts</span><input type="number" min="0" step="1" class="wg-theme-select" data-el="settingsMaxPromptsInput" placeholder="5000 (default)"></label>
              </section>
            </div>
            <div class="wg-inline-note">Maximum prompts is the safety cap for full Cartesian expansion. A value of 0 uses the default 5000-prompt cap.</div>
          </section>
        </div>
      </div>
      <div class="wg-settings-footer"><a class="wg-credit-link" href="https://github.com/z3rofeels/comfyui-promptpalette" target="_blank" rel="noopener noreferrer" title="Prompt Palette on GitHub"><span class="wg-credit-icon">${svgIcon("github", 13)}</span><span>made by <strong>z3rofeels</strong></span></a></div>
    </div>
    <div class="wg-main">
      <div class="wg-drawer left" data-drawer="picker" role="region" aria-label="My Library" aria-hidden="true" hidden inert>
        <div class="wg-drawer-inner">
          <div class="wg-drawer-head">
            <h4>My Library</h4>
            <div class="wg-drawer-head-actions">
              <button type="button" class="wg-icon-btn" data-act="pickerViewToggle" data-el="pickerViewToggle" title="Toggle grid/list view">${svgIcon("grid")}</button>
            </div>
          </div>
          <div class="wg-search"><input type="search" placeholder="Search My Library…" data-el="search"></div>
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
        <div class="wg-legend" data-el="legend" title="Wildcard colors follow your My Library category palette."></div>
        <div class="wg-footer">
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

  let detachedSettingsPopup = null;
  // Settings is portaled out of `root` immediately. Every lookup that can belong
  // to that drawer must continue to resolve after the reparent, otherwise setup
  // aborts midway (native widgets already hidden, DOM widget never mounted).
  const el = sel => root.querySelector(`[data-el="${sel}"]`) || detachedSettingsPopup?.querySelector(`[data-el="${sel}"]`);
  const action = name => root.querySelector(`[data-act="${name}"]`) || detachedSettingsPopup?.querySelector(`[data-act="${name}"]`);
  const originalTextarea = el("textarea");
  const editorSurface = upgradeEditorSurface(originalTextarea);
  const textarea = editorSurface.element;
  textarea.value = promptState.restore();
  const highlight = el("highlight");
  const syntaxHighlighter = createSyntaxHighlighter(textarea, highlight);
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
  const settingsModeSelect = el("settingsModeSelect");
  const settingsCountInput = el("settingsCountInput");
  const settingsSeedModeSelect = el("settingsSeedModeSelect");
  const settingsMaxPromptsInput = el("settingsMaxPromptsInput");
  const estimateBox = el("estimateBox");
  const estimateCount = el("estimateCount");
  const estimateWarning = el("estimateWarning");

  const modeWidget = node.widgets.find(w => w.name === "mode");
  const countWidget = node.widgets.find(w => w.name === "count");
  const seedWidget = node.widgets.find(w => w.name === "seed");
  const controlWidget =
    (seedWidget && seedWidget.linkedWidgets && seedWidget.linkedWidgets[0]) ||
    node.widgets.find(w => w !== seedWidget && /control.*generate/i.test(w.name || ""));
  const seedModeWidget = node.widgets.find(w => w.name === "seed_mode");
  const maxPromptsWidget = node.widgets.find(w => w.name === "max_prompts");
  const nativeBackingWidgets = [modeWidget, countWidget, seedWidget, controlWidget, seedModeWidget, maxPromptsWidget];
  nativeBackingWidgets.forEach((widget) => { if (widget) widget.__ppOwnerNode = node; hideNativeWidget(widget, { keepSocketForNodes2: true }); });

  const externalControlDefs = [
    { key: "mode", widgets: [modeWidget], elements: [...Array.from(modeButtons || []), settingsModeSelect] },
    { key: "count", widgets: [countWidget], elements: [countInput, settingsCountInput] },
    { key: "seed", widgets: [seedWidget], elements: [seedInput] },
    { key: "seed_mode", widgets: [seedModeWidget], elements: [seedModeSelect, settingsSeedModeSelect] },
    { key: "max_prompts", widgets: [maxPromptsWidget], elements: [maxPromptsInput, settingsMaxPromptsInput] },
  ];

  function inputSocketLinked(key) {
    const slot = (node.inputs || []).find((candidate) => candidate?.name === key);
    return slot?.link != null;
  }

  function syncExternalControlState() {
    for (const def of externalControlDefs) {
      const linked = inputSocketLinked(def.key);
      for (const element of def.elements || []) {
        if (!element) continue;
        if (!element.dataset.ppExternalBaseDisabled) {
          element.dataset.ppExternalBaseDisabled = element.disabled ? "true" : "false";
        }
        element.disabled = element.dataset.ppExternalBaseDisabled === "true" || linked;
        element.toggleAttribute("data-external-input", linked);
        if (linked) element.title = `${def.key.replace(/_/g, " ")} is driven by an external ComfyUI input.`;
      }
      for (const widget of def.widgets || []) {
        if (widget) widget.__ppExternallyDriven = linked;
      }
    }
    updateModeUI();
  }

  function reassertHiddenWidgets() {
    hideNativeWidget((Object.assign(hiddenWidget, { __ppOwnerNode: node })));
    nativeBackingWidgets.forEach((widget) => { if (widget) widget.__ppOwnerNode = node; hideNativeWidget(widget, { keepSocketForNodes2: true }); });
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
    if (countWidget) countInput.value = countWidget.value;
    if (maxPromptsWidget) maxPromptsInput.value = maxPromptsWidget.value;
    if (seedWidget) seedInput.value = seedWidget.value;
    if (seedModeWidget) seedModeSelect.value = seedModeWidget.value;
    if (settingsModeSelect) settingsModeSelect.value = modeWidget?.value || "random";
    if (settingsCountInput) settingsCountInput.value = countWidget?.value ?? 1;
    if (settingsMaxPromptsInput) settingsMaxPromptsInput.value = maxPromptsWidget?.value ?? 0;
    if (settingsSeedModeSelect) settingsSeedModeSelect.value = seedModeWidget?.value || "sequential";
    updateModeUI();
    syncExternalControlState();
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
  settingsModeSelect?.addEventListener("change", () => {
    if (!modeWidget) return;
    modeWidget.value = settingsModeSelect.value;
    if (typeof modeWidget.callback === "function") modeWidget.callback(modeWidget.value, node.graph?.canvas, node);
    node.graph?.setDirtyCanvas(true, true);
    syncControlsFromWidgets();
  });
  settingsCountInput?.addEventListener("input", () => {
    if (!countWidget || settingsCountInput.value === "") return;
    countWidget.value = Math.max(1, Math.floor(Number(settingsCountInput.value)) || 1);
    if (typeof countWidget.callback === "function") countWidget.callback(countWidget.value, node.graph?.canvas, node);
    node.graph?.setDirtyCanvas(true, true);
    syncControlsFromWidgets();
  });
  settingsMaxPromptsInput?.addEventListener("input", () => {
    if (!maxPromptsWidget) return;
    maxPromptsWidget.value = settingsMaxPromptsInput.value === "" ? 0 : Math.max(0, Math.floor(Number(settingsMaxPromptsInput.value)) || 0);
    if (typeof maxPromptsWidget.callback === "function") maxPromptsWidget.callback(maxPromptsWidget.value, node.graph?.canvas, node);
    node.graph?.setDirtyCanvas(true, true);
    syncControlsFromWidgets();
  });
  settingsSeedModeSelect?.addEventListener("change", () => {
    if (!seedModeWidget) return;
    seedModeWidget.value = settingsSeedModeSelect.value;
    if (typeof seedModeWidget.callback === "function") seedModeWidget.callback(seedModeWidget.value, node.graph?.canvas, node);
    node.graph?.setDirtyCanvas(true, true);
    syncControlsFromWidgets();
  });
  action("seedRandomizeNow").addEventListener("click", () => {
    if (!seedWidget) return;
    const maxSeed = Number.MAX_SAFE_INTEGER;
    const randomSeed = Math.floor(Math.random() * maxSeed);
    seedWidget.value = randomSeed;
    seedInput.value = randomSeed;
    if (typeof seedWidget.callback === "function") seedWidget.callback(randomSeed, node.graph?.canvas, node);
    node.graph?.setDirtyCanvas(true, true);
    updateEstimate();
  });

  const IO_INPUT_DEFS = [
    { key: "mode", type: "COMBO", label: "Mode", default: true, desc: "Drive Random vs Combinatorial generation from another node. The local control remains available when this socket is unlinked." },
    { key: "count", type: "INT", label: "Count", default: true, desc: "Externally drive how many random prompts to generate. The local Count control remains available when this socket is unlinked." },
    { key: "seed", type: "INT", label: "Seed", default: true, desc: "Externally drive the base wildcard-resolution seed. The local Seed control remains available when this socket is unlinked." },
    { key: "seed_mode", type: "COMBO", label: "Seed mode", default: true, desc: "Externally drive sequential, fixed, or randomized per-prompt seed behavior." },
    { key: "max_prompts", type: "INT", label: "Max prompts", default: true, desc: "Externally drive the combinatorial safety cap. 0 uses the resolver default." },
    { key: "clip", type: "CLIP", label: "CLIP", default: true, desc: "Optional CLIP input used to encode every generated prompt." },
    { key: "model", type: "MODEL", label: "Model", default: true, desc: "Optional Model input used when applying per-prompt LoRA tags." },
    // Prompt Palette's remaining sockets. Link-only (no widget), hidden until enabled, so saved workflows look the same.
    { key: "prompt_prefix", type: "STRING", label: "Prompt prefix", default: false, desc: "Prepend externally-supplied text (resolved for wildcards too) to every generated prompt." },
    { key: "prompt_suffix", type: "STRING", label: "Prompt suffix", default: false, desc: "Append externally-supplied text (resolved for wildcards too) to every generated prompt." },
    { key: "enhancer_override", type: "STRING", label: "LLM / enhancer override", default: false, desc: "If connected and non-empty, replaces every generated prompt. The batch keeps its length and seeds." },
    { key: "external_seed", type: "INT", label: "External seed", default: false, desc: "Drive wildcard resolution from another node's seed instead of this node's own Seed control." },
    { key: "negative_text", type: "STRING", label: "Negative prompt (text)", default: false, desc: "A wildcard-aware negative prompt, resolved once for the whole batch and returned on the Negative prompt / Negative conditioning outputs." },
    { key: "negative_prefix", type: "STRING", label: "Negative prefix", default: false, desc: "Prepend externally-supplied text (resolved for wildcards too) before the negative prompt." },
    { key: "negative_suffix", type: "STRING", label: "Negative suffix", default: false, desc: "Append externally-supplied text (resolved for wildcards too) after the negative prompt." },
  ];

  const IO_OUTPUT_DEFS = [
    { key: "model", slotIndex: 0, type: "MODEL", label: "Model list", default: true, desc: "One model value per generated prompt. LoRA tags may produce individually patched model entries." },
    { key: "clip", slotIndex: 1, type: "CLIP", label: "CLIP list", default: true, desc: "One CLIP value per generated prompt, patched alongside Model when LoRA tags are applied." },
    { key: "conditioning", slotIndex: 2, type: "CONDITIONING", label: "Conditioning list", default: true, desc: "One encoded conditioning entry per generated prompt when CLIP is connected." },
    { key: "prompt", slotIndex: 3, type: "STRING", label: "Prompt list", default: true, desc: "Resolved prompt texts, one per generated combination or random pick." },
    { key: "seed_out", slotIndex: 4, type: "INT", label: "Seed list", default: true, desc: "The resolve seed used for each generated prompt." },
    { key: "wildcards_used", slotIndex: 5, type: "STRING", label: "Wildcards used", default: true, desc: "The wildcard files used during this batch, repeated for list-compatible fan-out." },
    { key: "prompt_metadata_json", slotIndex: 6, type: "STRING", label: "Prompt metadata (JSON) list", default: false, desc: "One resolved/source metadata record per generated prompt." },
    // Single-value outputs: not lists, so whatever they feed runs once per queue, not once per prompt.
    // They follow the seven list outputs so saved links keep their slot index. Slot order matches nodes.py.
    { key: "model_passthrough", slotIndex: 7, type: "MODEL", label: "Model (passthrough)", default: false, desc: "The connected Model, unchanged. Per-prompt LoRA-patched models are on Model list." },
    { key: "clip_passthrough", slotIndex: 8, type: "CLIP", label: "CLIP (passthrough)", default: false, desc: "The connected CLIP, unchanged. Per-prompt LoRA-patched CLIPs are on CLIP list." },
    { key: "first_conditioning", slotIndex: 9, type: "CONDITIONING", label: "Conditioning (first)", default: false, desc: "Conditioning for the first generated prompt. None unless a CLIP input is connected. Use Conditioning list for every prompt." },
    { key: "negative_conditioning", slotIndex: 10, type: "CONDITIONING", label: "Negative conditioning", default: false, desc: "The resolved negative prompt encoded once with the connected CLIP (unpatched). None unless a CLIP input is connected." },
    { key: "first_prompt", slotIndex: 11, type: "STRING", label: "Prompt (first)", default: false, desc: "The first generated prompt. Use Prompt list for every prompt." },
    { key: "negative_prompt", slotIndex: 12, type: "STRING", label: "Negative prompt", default: false, desc: "Resolved text from the Negative prompt inputs, resolved once for the whole batch." },
    { key: "first_seed", slotIndex: 13, type: "INT", label: "Seed used (first)", default: false, desc: "Seed used for the first generated prompt. Use Seed list for every prompt." },
    { key: "wildcards_used_json", slotIndex: 14, type: "STRING", label: "Wildcards used (JSON)", default: false, desc: "A JSON list of every wildcard file picked during this batch, as one value." },
    { key: "raw_text", slotIndex: 15, type: "STRING", label: "Raw text (unresolved)", default: false, desc: "Exactly what is typed into this node before wildcard resolution." },
    { key: "wildcards_used_count", slotIndex: 16, type: "INT", label: "Wildcards used (count)", default: false, desc: "How many distinct wildcard files were picked during this batch." },
    { key: "used_enhancer", slotIndex: 17, type: "BOOLEAN", label: "Used enhancer override", default: false, desc: "True if the enhancer override replaced the generated prompts." },
    { key: "clip_token_count", slotIndex: 18, type: "INT", label: "CLIP token count (max)", default: false, desc: "Highest CLIP-L token count across the batch. -1 if unavailable or the connected text encoder is not CLIP-based." },
    { key: "batch_metadata_json", slotIndex: 19, type: "STRING", label: "Batch metadata (JSON)", default: false, desc: "One JSON record for the whole batch, including every generated prompt's metadata." },
    { key: "prompt_count", slotIndex: 20, type: "INT", label: "Prompt count", default: false, desc: "How many prompts this batch generated." },
  ];

  node.properties = node.properties || {};
  node.properties.wg_io = node.properties.wg_io || { inputs: {}, outputs: {} };

  const ioRail = setupIoRail(node, root, IO_INPUT_DEFS, IO_OUTPUT_DEFS);

  scheduleNodeTimer(node, () => {
    canonicalizeOutputs(node, IO_OUTPUT_DEFS);
    migrateIoState(node, "input", IO_INPUT_DEFS);
    migrateIoState(node, "output", IO_OUTPUT_DEFS);
    IO_INPUT_DEFS.forEach((def) => syncIoSocket(node, "input", def, ioEnabled(node, "input", def)));
    IO_OUTPUT_DEFS.forEach((def) => syncIoSocket(node, "output", def, ioEnabled(node, "output", def)));
    syncExternalControlState();
    ioRail.render();
  }, 0);
  node._wgRefreshIoToggles = function () {
    canonicalizeOutputs(node, IO_OUTPUT_DEFS);
    migrateIoState(node, "input", IO_INPUT_DEFS);
    migrateIoState(node, "output", IO_OUTPUT_DEFS);
    IO_INPUT_DEFS.forEach((def) => syncIoSocket(node, "input", def, ioEnabled(node, "input", def)));
    IO_OUTPUT_DEFS.forEach((def) => syncIoSocket(node, "output", def, ioEnabled(node, "output", def)));
    syncExternalControlState();
    ioRail.render();
  };
  node._wgSyncExternalControlState = syncExternalControlState;

  const settingsPopup = el("settingsPopup");
  detachedSettingsPopup = settingsPopup;
  const settingsBtn = action("settings");
  settingsPopup.id = `prompt-palette-combinatorial-${String(node.id ?? "node")}-settings`;
  settingsBtn.setAttribute("aria-controls", settingsPopup.id);
  settingsBtn.setAttribute("aria-expanded", "false");
  settingsBtn.setAttribute("aria-label", "Open Combinatorial settings");
  const settingsTabs = Array.from(settingsPopup.querySelectorAll("[data-settings-tab]"));
  const settingsPanels = Array.from(settingsPopup.querySelectorAll("[data-settings-panel]"));
  function activateSettingsTab(name) {
    settingsTabs.forEach((button) => {
      const active = button.dataset.settingsTab === name;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
    });
    settingsPanels.forEach((panel) => {
      const active = panel.dataset.settingsPanel === name;
      panel.classList.toggle("active", active);
      panel.setAttribute("aria-hidden", String(!active));
    });
    settingsPopup.dataset.activeTab = name;
  }
  settingsTabs.forEach((button) => button.addEventListener("click", () => activateSettingsTab(button.dataset.settingsTab)));
  const settingsDrawer = registerPromptPaletteSettingsDrawer({
    popup: settingsPopup,
    trigger: settingsBtn,
    isBlocked: isDialogOpen,
  });
  function openSettings() {
    ioRail.close();
    closePickerDrawer();
    settingsDrawer.open();
    activateSettingsTab("behavior");
    syncControlsFromWidgets();
  }
  function closeSettings(options = {}) {
    settingsDrawer.close(options);
  }
  node._wgBeforeIoRailOpen = () => {
    closeSettings({ restoreFocus: false, reason: "io-rail" });
    closePickerDrawer();
  };
  settingsBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (settingsDrawer.isOpen()) closeSettings();
    else openSettings();
  });
  settingsPopup.querySelectorAll('[data-act="closeSettings"]').forEach(btn => btn.addEventListener("click", closeSettings));

  const handleWorkspaceEscape = (event) => {
    if (event.key !== "Escape" || isDialogOpen()) return;
    if (node._wgIoRailOpen) ioRail.close();
    else if (pickerDrawer.classList.contains("open")) closePickerDrawer();
  };
  root.addEventListener("keydown", handleWorkspaceEscape);
  document.addEventListener("keydown", handleWorkspaceEscape);

  // Combinatorial consumes the suite appearance but never writes it. All presentation
  // controls live in the main Prompt Palette Settings > Appearance surface.
  const appearanceBinding = bindSuiteAppearance({
    node,
    targets: [root, settingsPopup],
    onApplied(snapshot, { initial }) {
      Object.assign(theme, snapshot.theme);
      if (!initial) render();
    },
  });

  let estimateDebounceTimer = null;
  let estimateSeq = 0;

  modeButtons.forEach(btn => {
    btn.addEventListener("click", () => {
      if (!modeWidget || modeWidget.value === btn.dataset.mode) return;
      modeWidget.value = btn.dataset.mode;
      if (typeof modeWidget.callback === "function") modeWidget.callback(modeWidget.value, node.graph?.canvas, node);
      node.graph?.setDirtyCanvas(true, true);
      updateModeUI();
    });
  });

  function updateModeUI() {
    const mode = modeWidget ? modeWidget.value : "random";
    modeButtons.forEach(b => b.classList.toggle("pp-active", b.dataset.mode === mode));
    countRow.classList.toggle("pp-hidden", mode !== "random");
    maxPromptsRow.classList.toggle("pp-hidden", mode !== "combinatorial");
    updateEstimate();
  }

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
      if (mySeq !== estimateSeq) return;
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
    if (["mode", "count", "seed", "seed_mode", "max_prompts"].some(inputSocketLinked)) {
      estimateSeq++;
      cancelNodeTimer(node, estimateDebounceTimer);
      estimateDebounceTimer = null;
      estimateCount.textContent = "runtime inputs";
      estimateWarning.textContent = "Generation controls are driven by connected inputs; exact fan-out is resolved when the workflow executes.";
      estimateBox.classList.remove("pp-warning", "pp-loading");
      fanoutCount.textContent = "—";
      fanoutPlural.textContent = "";
      fanoutBanner.classList.remove("pp-warning");
      return;
    }
    cancelNodeTimer(node, estimateDebounceTimer);
    const mode = modeWidget ? modeWidget.value : "random";
    if (mode === "random") {
      estimateBox.classList.remove("pp-loading");
      const n = countWidget ? Math.max(1, Math.floor(Number(countWidget.value)) || 1) : 1;
      renderEstimate(n, false, n);
      return;
    }
    estimateBox.classList.add("pp-loading");
    estimateDebounceTimer = scheduleNodeTimer(node, runCombinatorialEstimate, ESTIMATE_DEBOUNCE_MS);
  }

  function isKnown(name) {
    return knownSet.has(name) || Array.from(knownSet).some(n => n.split("/").pop() === name.split("/").pop());
  }
  function extractWildcardNames(text) {
    const names = new Set(); const re = /__[+\-*%~@]?([A-Za-z0-9_\-\/]+)__/g; let m;
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
    // Library entries use the same category color in the autocomplete/library UI and in the
    // prompt itself. Keep the token color tied to the entry category rather than a per-leaf
    // shade so selecting a Recent/Library row preserves the exact visual identity of the source.
    const hue = (hashStr(cat) % 360 + theme.hueRotate) % 360;
    return categoryColorFromHue(hue, theme.saturation, currentUiSurface());
  }
  function highlightText(text) {
    const names = extractWildcardNames(text);
    const categoriesInUse = Array.from(new Set(names.map(categoryOf)));
    const categoryHueMap = buildCategoryColorMap(categoriesInUse);
    let out = ""; let i = 0; const ranges = []; const decorations = [];
    // Plain text between tokens is where booru / custom-word tags live; known ones keep their
    // category color, like wildcards do.
    const tagPainter = createTagPainter(theme);
    let plain = ""; let plainStart = 0;
    const flushPlain = () => {
      if (!plain) return;
      let cursor = 0;
      for (const hit of tagPainter ? tagPainter.paint(plain, plainStart) : []) {
        const from = hit.start - plainStart, to = hit.end - plainStart;
        if (from > cursor) out += escapeHtml(plain.slice(cursor, from));
        out += `<span class="wg-token wg-token-booru" data-tag-category="${hit.category}" style="color:${hit.color}; text-shadow:0 0 0.35px currentColor;">${escapeHtml(plain.slice(from, to))}</span>`;
        decorations.push({ start: hit.start, end: hit.end, kind: "booru", color: hit.color });
        cursor = to;
      }
      out += escapeHtml(plain.slice(cursor));
      plain = "";
    };
    while (i < text.length) {
      const rest = text.slice(i);
      const wildcardMatch = rest.match(/^__[+\-*%~@]?[A-Za-z0-9_\-\/]+__/);
      if (wildcardMatch) { flushPlain();
        const token = wildcardMatch[0];
        const innerName = token.replace(/^__[+\-*%~@]?/, "").replace(/__$/, "");
        const start = i, end = i + token.length;
        if (isKnown(innerName)) {
          const color = colorForToken(innerName, categoryHueMap);
          out += `<span class="wg-token" style="color:${color}; font-weight:600;">${escapeHtml(token)}</span>`;
          ranges.push({ start, end, name: innerName, known: true });
          decorations.push({ start, end, kind: "wildcard", color });
        } else {
          out += `<span class="wg-tok-error">${escapeHtml(token)}</span>`;
          ranges.push({ start, end, name: innerName, known: false });
          decorations.push({ start, end, kind: "error" });
        }
        i = end; continue;
      }
      const conditionalMatch = rest.match(/^\[(?:if|elif|else|\/if)(?:\s+[^\]]+)?\]/i);
      if (conditionalMatch) { flushPlain(); const start = i; out += `<span class="wg-tok-conditional">${escapeHtml(conditionalMatch[0])}</span>`; i += conditionalMatch[0].length; decorations.push({ start, end: i, kind: "conditional" }); continue; }
      const weightMatch = rest.match(/^\d+::/);
      if (weightMatch) { flushPlain(); const start = i; out += `<span class="wg-tok-weight">${escapeHtml(weightMatch[0])}</span>`; i += weightMatch[0].length; decorations.push({ start, end: i, kind: "weight" }); continue; }
      const quantMatch = rest.match(/^(\d+(-\d+)?\$\$[^$]*\$\$|\d+#)/);
      if (quantMatch) { flushPlain(); const start = i; out += `<span class="wg-tok-mod">${escapeHtml(quantMatch[0])}</span>`; i += quantMatch[0].length; decorations.push({ start, end: i, kind: "modifier" }); continue; }
      const ch = text[i];
      if (ch === "{" || ch === "}") { flushPlain(); const start = i; out += `<span class="wg-tok-bracket">${ch}</span>`; i++; decorations.push({ start, end: i, kind: "bracket" }); continue; }
      if (ch === "|") { flushPlain(); const start = i; out += `<span class="wg-tok-pipe">|</span>`; i++; decorations.push({ start, end: i, kind: "pipe" }); continue; }
      if (ch === "#" && (i === 0 || text[i - 1] === "\n")) {
        flushPlain();
        const lineEnd = text.indexOf("\n", i);
        const line = lineEnd === -1 ? text.slice(i) : text.slice(i, lineEnd);
        const start = i; out += `<span class="wg-tok-comment">${escapeHtml(line)}</span>`; i += line.length; decorations.push({ start, end: i, kind: "comment" }); continue;
      }
      if (!plain) plainStart = i;
      plain += ch; i++;
    }
    flushPlain();
    tokenRanges = ranges;
    return {
      html: out, names, categoriesInUse, categoryHueMap, decorations,
      tagCategoriesInUse: tagPainter ? Array.from(tagPainter.used) : [], tagPalette: tagPainter?.palette || null,
    };
  }

  function syncHiddenWidget() {
    if (promptState.current() !== textarea.value || promptState.isEstablished()) {
      promptState.commit(textarea.value);
    }
  }

  function render() {
    const { html, names, categoriesInUse, categoryHueMap, decorations, tagCategoriesInUse, tagPalette } = highlightText(textarea.value);
    if (!syntaxHighlighter.render(decorations, textarea.value)) highlight.innerHTML = html + "\n";
    legend.innerHTML = "";
    categoriesInUse.forEach(cat => {
      const color = theme.categoryPins[cat] || categoryColorFromHue((hashStr(cat) % 360 + theme.hueRotate) % 360, theme.saturation, currentUiSurface());
      const chip = document.createElement("div");
      chip.className = "wg-chip";
      chip.innerHTML = `<span class="wg-sw" style="background:${color}; border-radius:50%;"></span>${escapeHtml(cat)}`;
      legend.appendChild(chip);
    });
    TAG_CATEGORY_KEYS.filter(key => tagPalette && tagCategoriesInUse.includes(key)).forEach(key => {
      const chip = document.createElement("div");
      chip.className = "wg-chip wg-chip-tag";
      chip.innerHTML = `<span class="wg-sw" style="background:${tagPalette[key]}; border-radius:3px;"></span>${escapeHtml(TAG_CATEGORY_LABELS[key] || key)}`;
      legend.appendChild(chip);
    });
    const knownCount = names.filter(isKnown).length;
    const missingCount = names.length - knownCount;
    hintRight.textContent = `${knownCount} resolved-ready \u00b7 ${missingCount} missing`;
    const len = textarea.value.length;
    charCount.textContent = `${len.toLocaleString()} char${len === 1 ? "" : "s"}`;
    syncHiddenWidget();
    updateEstimate();
  }

  function refreshFromHidden() {
    const restored = promptState.restore();
    if (restored !== textarea.value) {
      textarea.value = restored;
      render();
    }
    syncControlsFromWidgets();
  }

  // Same provider the main Prompt Palette node uses: the library is already cached locally, so no
  // request goes to the server per keystroke. Recents are shared between nodes through the same
  // stored usage list.
  const usageStore = createPromptUsageStore();
  async function getAcMatches(query, contextKind = "wildcard") {
    const q = String(query || "").trim().toLowerCase();
    const recentEntries = usageStore.recentEntries(16);
    const recentRows = recentAcRows(q, {
      entries: contextKind === "booru" ? recentEntries : recentEntries.filter((entry) => entry?.kind === "library"),
      pinned, theme, limit: 12,
    });
    const recentLibraryPaths = new Set(recentRows.filter((item) => item.kind !== "booru" && item.kind !== "custom").map((item) => item.value));
    const libraryRows = libraryAcRows(q, {
      rankedPaths: rankLibraryPaths(libraryCache, q, 32), pinned, recents: [],
      excludePaths: recentLibraryPaths, theme,
      limit: contextKind === "booru" ? 24 : 28,
    });
    if (contextKind !== "booru") return [...recentRows, ...libraryRows];
    const tagRows = await getBooruAutocompleteMatches(q);
    return mergeUnifiedRows(tagRows, [...recentRows, ...libraryRows]);
  }
  const cleanupAutocompleteBinding = attachAutocomplete(textarea, {
    getMatches: getAcMatches,
    onCommit: (item) => {
      if (item?.kind === "booru" || item?.kind === "custom") {
        try { usageStore.recordTag(item.value, item.kind, item.category); } catch { /* recents are a convenience */ }
      } else if (item && item.kind !== "syntax" && item.value) {
        try { usageStore.recordLibrary(item.value); } catch { /* recents are a convenience */ }
      }
      render();
    },
    onInput: () => render(),
    syntax: true,
  });
  // Tag categories arrive asynchronously (offline database lookup): repaint the overlay when they do.
  const unsubscribeTagColors = onTagColorsChanged(() => {
    if (!textarea.isConnected) return;
    const { html, decorations } = highlightText(textarea.value);
    if (!syntaxHighlighter.render(decorations, textarea.value)) highlight.innerHTML = html + "\n";
  });

  const hoverTip = document.createElement("div");
  hoverTip.className = "wg-tip";
  hoverTip.dataset.promptPaletteHover = "true";
  hoverTip.dataset.promptPaletteOwner = String(node.id ?? "node");
  document.body.appendChild(hoverTip);
  let hoverRequestVersion = 0;
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
    const requestVersion = ++hoverRequestVersion;
    let entry = previewCache.get(name);
    if (!entry && known) {
      try {
        entry = await API.preview(name);
        previewCache.set(name, entry);
      } catch {
        entry = null;
      }
    }
    if (requestVersion !== hoverRequestVersion || !nodeIsActive(node)) return;
    const lines = (entry?.lines || []).slice(0, 4);
    copyPromptPaletteThemeScope(root, hoverTip);
    hoverTip.innerHTML = `<div class="wg-tip-title">${escapeHtml(known ? name : name + " (not found)")}</div>` +
      (lines.length ? lines.map(l => `<div class="wg-tip-line">${escapeHtml(l)}</div>`).join("") :
        `<div class="wg-tip-line">${known ? "no preview available" : "file missing"}</div>`);
    hoverTip.style.left = (x + 14) + "px";
    hoverTip.style.top = (y + 14) + "px";
    hoverTip.style.display = "block";
  }
  function hideTip() { hoverRequestVersion += 1; hoverTip.style.display = "none"; }
  let hoverDebounce = null;
  textarea.addEventListener("mousemove", (e) => {
    const idx = charIndexFromEvent(e);
    const tok = tokenRanges.find(t => idx >= t.start && idx < t.end);
    cancelNodeTimer(node, hoverDebounce);
    if (tok) hoverDebounce = scheduleNodeTimer(node, () => showTipForName(e.clientX, e.clientY, tok.name, tok.known), 120);
    else hideTip();
  });
  textarea.addEventListener("mouseleave", hideTip);
  textarea.addEventListener("scroll", () => { highlight.scrollTop = textarea.scrollTop; highlight.scrollLeft = textarea.scrollLeft; });

  textarea.addEventListener("contextmenu", (e) => {
    if (theme.syntaxInjectorEnabled === false) return;
    const idx = textarea.selectionStart;
    const tok = tokenRanges.find(t => t.start <= idx && t.end >= idx);
    if (!tok) return;
    e.preventDefault();
    hideTip();
    if (ctxMenuOpen) closeCtxMenu();
    textarea.selectionStart = tok.start;
    textarea.selectionEnd = tok.end;
    openInjectMenuAtPoint(e.clientX, e.clientY, tok.name, textarea, render, { start: tok.start, end: tok.end });
  });

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

    if (theme.syntaxInjectorEnabled !== false) {
      const trigger = document.createElement("button");
      trigger.type = "button";
      trigger.className = "wg-inject-trigger";
      trigger.title = `Insert wildcard syntax for "${item.path}"`;
      trigger.innerHTML = "&#9889;";
      trigger.setAttribute("draggable", "false");
      trigger.addEventListener("mousedown", (e) => e.stopPropagation());
      let openDelay = null;
      trigger.addEventListener("click", (e) => {
        e.stopPropagation();
        cancelNodeTimer(node, openDelay);
        if (injectState && injectState.trigger === trigger) closeInjectMenu();
        else openInjectMenu(trigger, item.path, textarea, render);
      });
      trigger.addEventListener("mouseenter", () => {
        cancelNodeTimer(node, openDelay);
        openDelay = scheduleNodeTimer(node, () => openInjectMenu(trigger, item.path, textarea, render), 90);
      });
      trigger.addEventListener("mouseleave", () => {
        cancelNodeTimer(node, openDelay);
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

  function pickerTile(item) {
    const cat = categoryOf(item.path);
    const hueMap = buildCategoryColorMap([cat]);
    const color = colorForToken(item.path, hueMap);
    const isPinned = pinned.has(item.path);
    const name = item.path.split("/").pop();
    const thumbRel = thumbMap[item.path];
    const thumbBustQs = thumbBust[item.path] ? `&v=${thumbBust[item.path]}` : "";

    const thumbHtml = thumbRel
      ? `<img class="wg-thumb-img" src="${escapeHtml(API.thumbnailUrl(thumbRel, thumbBustQs))}" alt="" loading="lazy">`
      : `<div class="wg-thumb-fallback" style="background:color-mix(in srgb, ${color} 20%, var(--wg-surface, #121417));"><span class="wg-thumb-fallback-glyph" style="color:${color};">&#128193;</span></div>`;

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

  function jumpToCategory(cat) {
    searchInput.value = "";
    if (!expandedCats.has(cat)) {
      expandedCats.add(cat);
      saveExpandedCats(expandedCats);
    }
    renderPickerList("");
    scheduleNodeFrame(node, () => {
      const header = Array.from(pickerList.querySelectorAll(".wg-folder[data-cat]")).find((item) => item.dataset.cat === cat);
      if (!header) return;
      header.scrollIntoView({ block: "center" });
      header.classList.add("wg-jump-flash");
      scheduleNodeTimer(node, () => header.classList.remove("wg-jump-flash"), 900);
    });
  }

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
    cancelNodeTimer(node, searchDebounce);
    searchDebounce = scheduleNodeTimer(node, () => renderPickerList(searchInput.value), 150);
  });

  const PICKER_MIN_WIDTH = 220;
  const PICKER_MAX_WIDTH = 640;
  function loadPickerWidth() {
    const w = Number(readCombinatorialPreference("pickerWidth", PICKER_MIN_WIDTH));
    return Number.isFinite(w) ? Math.min(PICKER_MAX_WIDTH, Math.max(PICKER_MIN_WIDTH, w)) : PICKER_MIN_WIDTH;
  }
  function savePickerWidth(w) {
    writeCombinatorialPreference("pickerWidth", Number(w));
  }
  let pickerWidth = loadPickerWidth();

  const pickerResizeHandle = document.createElement("div");
  pickerResizeHandle.className = "wg-drawer-resize-handle";
  pickerResizeHandle.title = "Drag to resize";
  pickerDrawer.appendChild(pickerResizeHandle);

  let resizingPicker = false;
  let resizeStartX = 0;
  let resizeStartWidth = 0;
  let previousBodyUserSelect = null;
  pickerResizeHandle.addEventListener("mousedown", (e) => {
    if (!pickerDrawer.classList.contains("open")) return;
    resizingPicker = true;
    resizeStartX = e.clientX;
    resizeStartWidth = pickerDrawer.getBoundingClientRect().width;
    pickerDrawer.classList.add("resizing");
    previousBodyUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    e.preventDefault();
  });

  const handlePickerResizeMove = (e) => {
    if (!resizingPicker) return;
    pickerWidth = Math.min(PICKER_MAX_WIDTH, Math.max(PICKER_MIN_WIDTH, resizeStartWidth + (e.clientX - resizeStartX)));
    pickerDrawer.style.width = pickerWidth + "px";
  };
  const handlePickerResizeUp = () => {
    if (!resizingPicker) return;
    resizingPicker = false;
    pickerDrawer.classList.remove("resizing");
    document.body.style.userSelect = previousBodyUserSelect ?? "";
    previousBodyUserSelect = null;
    savePickerWidth(pickerWidth);
  };
  document.addEventListener("mousemove", handlePickerResizeMove);
  document.addEventListener("mouseup", handlePickerResizeUp);

  function openPickerDrawer() {
    pickerDrawer.hidden = false;
    pickerDrawer.removeAttribute("inert");
    pickerDrawer.setAttribute("aria-hidden", "false");
    pickerDrawer.classList.add("open");
    action("picker").classList.add("active");
    pickerDrawer.style.width = pickerWidth + "px";
  }
  function closePickerDrawer() {
    pickerDrawer.classList.remove("open");
    action("picker").classList.remove("active");
    pickerDrawer.style.width = "";
    pickerDrawer.setAttribute("aria-hidden", "true");
    pickerDrawer.setAttribute("inert", "");
    // A closed picker must not contribute intrinsic height to Nodes 2.
    // Hide it from layout immediately; opening restores it before painting.
    pickerDrawer.hidden = true;
  }
  action("picker").addEventListener("click", () => {
    if (pickerDrawer.classList.contains("open")) {
      closePickerDrawer();
    } else {
      closeSettings();
      ioRail.close();
      openPickerDrawer();
    }
  });

  function syncPickerViewToggleBtn() {
    pickerViewToggleBtn.classList.toggle("active", pickerViewMode === "grid");
    pickerViewToggleBtn.title = pickerViewMode === "grid" ? "Switch to list view" : "Switch to grid view";
    pickerViewToggleBtn.innerHTML = svgIcon(pickerViewMode === "grid" ? "list" : "grid");
  }
  syncPickerViewToggleBtn();
  pickerViewToggleBtn.addEventListener("click", () => {
    pickerViewMode = pickerViewMode === "grid" ? "list" : "grid";
    savePickerView(pickerViewMode);
    syncPickerViewToggleBtn();
    renderPickerList(searchInput.value);
  });

  async function refreshLibrary() {
    let nextLibrary;
    try {
      nextLibrary = await API.list();
    } catch (error) {
      console.error("Prompt Palette: wildcard refresh failed", error);
      return false;
    }
    if (!nodeIsActive(node)) return false;
    let nextThumbMap = thumbMap;
    try {
      nextThumbMap = await API.categories();
    } catch (error) {
      console.error("Prompt Palette: thumbnail refresh failed", error);
    }
    if (!nodeIsActive(node)) return false;
    libraryCache = nextLibrary;
    knownSet = new Set(nextLibrary.map((item) => item.path));
    thumbMap = nextThumbMap;
    render();
    renderPickerList(searchInput.value);
    return true;
  }
  async function promptSaveSelectionAsList(start, end) {
    const selectedText = textarea.value.slice(start, end);
    const values = selectedText
      .split(/[\r\n,]+/)
      .map(value => value.trim())
      .filter(Boolean);
    if (!values.length) return;
    const raw = await dialogPrompt({
      title: "Save as list",
      message: "Choose a My Library path for this tag list:",
      defaultValue: "lists/new_list",
    });
    if (raw === null || raw === undefined) return;
    const slug = normalizeLibraryEntryPath(raw);
    if (!slug) {
      notify("error", "List not saved", "Enter a valid path using letters, numbers, - _ or /.");
      return;
    }
    if (knownSet.has(slug)) {
      const overwrite = await dialogConfirm({ title: "Overwrite list", message: `"${slug}" already exists — overwrite it?` });
      if (!overwrite) return;
    }
    const res = await API.save(slug, values.join("\n"));
    if (!res.ok) {
      notify("error", "List not saved", res.error || "save failed");
      return;
    }
    await refreshLibrary();
    notify("success", "Saved list", `${values.length} tag${values.length === 1 ? "" : "s"} → __${slug}__`);
  }
  textarea.__ppSaveSelectionAsList = promptSaveSelectionAsList;
  node._wgRefreshLibrary = refreshLibrary;

  action("refresh").addEventListener("click", async (e) => {
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

  // The settings coordinator owns the viewport portal mount; library/editor/picker remain inside the node.
  const cleanupSettingsKeyboardBoundary = installPromptPaletteKeyboardBoundary(settingsPopup);

  const repaintEditorHighlights = () => {
    const raf = globalThis.requestAnimationFrame || ((callback) => setTimeout(callback, 0));
    raf(() => {
      if (!nodeIsActive(node) || !textarea.isConnected) return;
      render();
    });
  };
  textarea.addEventListener("focus", repaintEditorHighlights);
  textarea.addEventListener("blur", repaintEditorHighlights);

  syncControlsFromWidgets();
  render();
  refreshLibrary().catch((error) => {
    console.error("Prompt Palette: initial combinatorial refresh failed", error);
  });

  const frame = document.createElement("div");
  frame.className = "wg-node-frame pp-node-frame";
  frame.appendChild(root);
  // Match the main Prompt Palette lifecycle exactly: the DOM widget must exist
  // before the renderer adapter inspects/positions socket rails. Installing the
  // renderer while ComfyUI is still constructing the DOM row can feed transient
  // intrinsic content measurements back into Nodes 2.
  node._wgInstallSocketRailWhenReady = () => {
    delete node._wgInstallSocketRailWhenReady;
    installSocketRailLayout(node, IO_INPUT_DEFS, IO_OUTPUT_DEFS, frame);
  };

  return {
    root: frame,
    refreshFromHidden,
    refreshVisuals: () => {
      if (!frame.isConnected) return false;
      render();
      return true;
    },
    reassertHiddenWidgets,
    reapplyTheme: appearanceBinding.apply,
    cleanup: () => {
      delete node._wgBeforeIoRailOpen;
      ioRail.cleanup();
      syntaxHighlighter.clear();
      textarea.removeEventListener("focus", repaintEditorHighlights);
      textarea.removeEventListener("blur", repaintEditorHighlights);
      editorSurface.cleanup();
      cleanupAutocompleteBinding?.();
      unsubscribeTagColors();
      hoverRequestVersion += 1;
      hoverTip.remove();
      root.removeEventListener("keydown", handleWorkspaceEscape);
      document.removeEventListener("keydown", handleWorkspaceEscape);
      document.removeEventListener("mousemove", handlePickerResizeMove);
      document.removeEventListener("mouseup", handlePickerResizeUp);
      if (resizingPicker) {
        resizingPicker = false;
        pickerDrawer.classList.remove("resizing");
        document.body.style.userSelect = previousBodyUserSelect ?? "";
        previousBodyUserSelect = null;
      }
      clearNodeTimers(node);
      appearanceBinding.cleanup();
      settingsDrawer.unregister();
      cleanupSettingsKeyboardBoundary();
      settingsPopup.remove();
      cleanupKeyboardBoundary();
    },
  };
}

app.registerExtension({
  name: "comfyui.promptpalette.combinatorial",

  async nodeCreated(node) {
    if (node.comfyClass !== "PromptPaletteCombinatorial") return;
    if (node.__promptPaletteCombinatorialInitialized) return;

    const lifecycle = ensureNodeLifecycle(node);
    await Promise.all([editorStylesReady, combinatorialStylesReady]);
    if (!nodeIsActive(node) || node.__promptPaletteCombinatorialInitialized) return;

    const hiddenWidget = node.widgets?.find((widget) => widget.name === "text");
    if (!hiddenWidget) {
      console.error("Prompt Palette: Combinatorial UI could not find the V3 text widget.");
      return;
    }

    hideNativeWidget((Object.assign(hiddenWidget, { __ppOwnerNode: node })));
    installPromptStateGuard(node, hiddenWidget);
    installPromptMetadataCapture(node);
    node.resizable = true;

    let built = null;
    try {
      built = buildCombinatorialWidget(node, hiddenWidget);
      const {
        root: container,
        refreshFromHidden,
        refreshVisuals,
        reassertHiddenWidgets,
        reapplyTheme,
        cleanup,
      } = built;

      const domWidget = node.addDOMWidget("prompt_palette_combinatorial_ui", "div", container, {
        getValue: () => node._ppPromptStateGuard?.current() ?? hiddenWidget.value,
        setValue: (value) => {
          node._ppPromptStateGuard?.acceptRendererValue(value);
          node._wgRefreshFromHidden?.();
        },
        serialize: false,
        hideOnZoom: false,
        // Match the working Editor/Weight Controller contract: no hard minimum,
        // and only consume the height ComfyUI has already allocated to this row.
        getMinHeight: () => 0,
        getMaxHeight: () => getDomWidgetAvailableHeight(node, domWidget),
        getHeight: () => getDomWidgetAvailableHeight(node, domWidget),
        afterResize: () => scheduleDomWidgetRemeasure(node),
      });
      installResponsiveDomWidgetWidth(node, domWidget);

      node._wgRefreshFromHidden = refreshFromHidden;
      node._wgRefreshVisuals = refreshVisuals;
      node._wgReassertHiddenWidgets = reassertHiddenWidgets;
      node._wgReapplyTheme = reapplyTheme;
      node._wgRendererModeChanged = () => {
        node._wgReassertHiddenWidgets?.();
        node._wgReapplyTheme?.();
        node._wgRefreshVisuals?.();
        scheduleDomWidgetRemeasure(node);
      };
      livePromptPaletteNodes.add(node);

      Object.defineProperty(node, "__promptPaletteCombinatorialInitialized", {
        value: true,
        configurable: true,
      });

      const reassertSurface = () => {
        if (!nodeIsActive(node) || !node.__promptPaletteCombinatorialInitialized) return;
        node._wgRefreshFromHidden?.();
        node._wgRefreshIoToggles?.();
        node._wgReassertHiddenWidgets?.();
        node._wgReapplyTheme?.();
        queueSocketRailLayout(node);
        scheduleDomWidgetRemeasure(node);
      };
      node._wgReassertCombinatorialSurface = reassertSurface;

      // Let ComfyUI finish addDOMWidget before installing socket adapters, just
      // like the main Prompt Palette node. This prevents Combinatorial's much
      // larger library subtree from participating in a transient Nodes 2 mount
      // measurement.
      const raf = globalThis.requestAnimationFrame || ((callback) => setTimeout(callback, 0));
      raf(() => {
        if (!nodeIsActive(node)) return;
        node._wgInstallSocketRailWhenReady?.();
        queueSocketRailLayout(node);
        reassertSurface();
      });
      queueMicrotask(reassertSurface);
      scheduleDomWidgetRemeasure(node);

      lifecycle.add(() => {
        livePromptPaletteNodes.delete(node);
        cleanupSocketRailLayout(node);
        delete node._wgInstallSocketRailWhenReady;
        delete node._wgRendererModeChanged;
        delete node._wgReassertCombinatorialSurface;
        delete node._wgReapplyTheme;
        delete node._wgRefreshFromHidden;
        delete node._wgRefreshVisuals;
        delete node._wgReassertHiddenWidgets;
        cleanup?.();
        if (livePromptPaletteNodes.size === 0) cleanupSharedPromptPaletteDom();
      });
    } catch (error) {
      try { built?.cleanup?.(); } catch {}
      cleanupSocketRailLayout(node);
      delete node.__promptPaletteCombinatorialInitialized;
      console.error("Prompt Palette: Combinatorial UI initialization failed", error);
    }
  },

  loadedGraphNode(node) {
    if (node.comfyClass !== "PromptPaletteCombinatorial") return;
    const reassert = () => node._wgReassertCombinatorialSurface?.();
    queueMicrotask(reassert);
    const raf = globalThis.requestAnimationFrame || ((callback) => setTimeout(callback, 0));
    raf(reassert);
  },

  afterConfigureGraph() {
    // loadedGraphNode is intentionally followed by a graph-complete pass because
    // Nodes 2 may restore serialized shell/category colors later in configuration.
    // Reapplying the suite theme here keeps Combinatorial cohesive with the other
    // Prompt Palette nodes without hard-coding any color or geometry.
    const raf = globalThis.requestAnimationFrame || ((callback) => setTimeout(callback, 0));
    raf(() => {
      for (const node of livePromptPaletteNodes) {
        if (node?.comfyClass === "PromptPaletteCombinatorial") {
          node._wgReassertCombinatorialSurface?.();
        }
      }
    });
  },
});

