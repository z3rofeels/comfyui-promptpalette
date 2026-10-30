import { installLoraSidecar } from "./editor/lora_sidecar.js";
import { bindPromptQueueSync } from "./prompt_palette_compat.js";
import { addSeedHistory } from "./editor/seed_fortune.js";
import { mountLibraryFeatures } from "./editor/library_features.js";
import { reviewHistoryRestore, applyHistoryText, historyTargetEditor } from "./editor/history_restore.js";
import "./editor/styles.js";
import { VirtualCollectionManager } from "./library/virtual_collection.js";
import { libraryVirtualLayout } from "./editor/library_display.js";
import { bindLibraryResize } from "./editor/library_resize.js";
import {
  libraryDisplayMarkup,
  libraryFilterBarMarkup,
  libraryThumbnailMarkup,
  libraryScrollbarMarkup,
  bindLibraryDisplay,
  bindLibraryViewControls,
  getLibraryOrganization,
  sortLibraryCategories,
  sortLibraryItems,
  renderLibraryHoverTip,
} from "./editor/library_display.js";
import { installSettingsDiscovery } from "./editor/settings_discovery.js";
import { sidebarEditingHandlers } from "./editor/sidebar_targets.js";
import { registerPromptPaletteCommandTarget } from "./prompt_palette_command_bus.js";
import { bindEditorWildcardHover } from "./editor/editor_hover.js";
import { historyShortcut } from "./editor/history_keys.js";
import { saveEditorSelection } from "./editor/selection_library.js";
import { libraryThumbnailActions } from "./editor/thumbnails.js";
import { attachEditorContextMenu, attachLibraryContextMenu } from "./editor/context_menu.js";
import { app } from "../../scripts/app.js";
import {
  loadExtensionStylesheet, svgIcon, copyPromptPaletteThemeScope, positionPromptPaletteTip,
  installPromptPaletteKeyboardBoundary, registerPromptPaletteSettingsDrawer, navigatePromptPaletteTabs,
} from "./prompt_palette_shared.js";
import { bindSuiteAppearance } from "./editor/suite_appearance.js";
import { applyToolbarVisibility } from "./editor/toolbar.js";
import { bindPromptSeedInput, isRecipeCategory } from "./editor/text_utils.js";
import { saveTheme } from "./editor/preferences.js";
import { readCombinatorialPreference, writeCombinatorialPreference } from "./prompt_palette_state.js";
import { upgradeEditorSurface } from "./editor/editor_surface.js";
import { createRefinementController } from "./editor/refinement_controller.js";
import { createRecipeWorkspaceController } from "./editor/recipe_workspace_controller.js";
import { WORKSPACE_KEY } from "./editor/recipe_workspace_model.js";
import { installPreparedBatchState } from "./editor/prompt_refinement.js";
import { mountCombinatorialTools, createCombinatorialTools } from "./editor/combinatorial_tools.js";
import { attachImageImport } from "./editor/image_import.js";
import { editCompiledPrompt } from "./editor/recipe_text_edit.js";
import { tagSearch } from "./editor/tag_search.js";
import { EditorUndoManager, TEXT_UNDO_LIMIT } from "./editor/undo_manager.js";
import { createSyntaxHighlighter } from "./editor/syntax_highlighter.js";
import { PromptSyntaxCache, renderPromptSyntax } from "./editor/prompt_parser.js";
import { createLibraryLookup } from "./engine/library_lookup.js";
import { libraryAcRows, recentAcRows, mergeUnifiedRows, rankLibraryPaths } from "./editor/autocomplete_sources.js";
import { createPromptUsageStore } from "./prompt_quickness.js";
import { createTagPainter, onTagColorsChanged } from "./editor/booru_tag_colors.js";
import { createStatusBar, statusBarMarkup, wildcardStatusText } from "./editor/status_bar.js";
import { installPromptSlots } from "./editor/prompt_slots.js";
import { attachEditorFindReplace } from "./editor/editor_find_replace.js";
import {
  API, loadTheme, escapeHtml, highlightMatch, categoryOf, hashStr,
  editorStylesReady,
  categoryColorFromHue, currentUiSurface,
  getBooruAutocompleteMatches, attachAutocomplete,
  loadPinned, savePinned, loadExpandedCats, saveExpandedCats, loadCatOrder, saveCatOrder,
  notify, livePromptPaletteNodes, cleanupSharedPromptPaletteDom,

  loadPickerView, savePickerView, openCtxMenu, closeCtxMenu, ctxMenuOpen,

  openInjectMenu, openInjectMenuAtPoint, closeInjectMenu, scheduleCloseInjectMenu, injectState,
  hideNativeWidget, installResponsiveDomWidgetWidth, getDomWidgetAvailableHeight, scheduleDomWidgetRemeasure,
  ensureNodeLifecycle, nodeIsActive, scheduleNodeTimer, cancelNodeTimer, clearNodeTimers, scheduleNodeFrame,
  installPromptStateGuard, installPromptMetadataCapture, preparePromptBackingWidgets,

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
  sequential: { label: "Sequential", desc: "Adds one to the base seed for each prompt in the batch, wrapping at the 64-bit limit." },
  fixed: { label: "Fixed", desc: "Uses the base seed for every prompt in the batch. Seeded wildcards repeat in Random mode." },
  random: { label: "Random", desc: "Derives reproducible randomized per-prompt seeds from the base seed. Change the base seed for a new batch." },
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
  let lookupWildcard = createLibraryLookup([]);
  const syntaxCache = new PromptSyntaxCache();
  let thumbMap = {};
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
        <button type="button" class="wg-icon-btn wg-settings-anchor" data-act="settings" title="Combinatorial settings" aria-label="Open Combinatorial settings">${svgIcon("settings")}</button>
      </div>
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
      <div class="wg-drawer left wg-library-popup" data-drawer="picker" role="region" aria-label="My Library" aria-hidden="true" hidden inert>
        <div class="wg-drawer-inner">
          <div class="wg-drawer-head">
            <h4>My Library</h4>
            <div class="wg-search wg-library-head-search"><input type="search" placeholder="Search prompts…" data-el="search" aria-label="Search My Library"></div>
            <div class="wg-drawer-head-actions">
              <button type="button" class="wg-icon-btn" data-act="pickerViewToggle" data-el="pickerViewToggle" title="Toggle grid/list view">${svgIcon("grid")}</button>
              <button type="button" class="wg-icon-btn wg-lib-customize-btn" data-library-customize-toggle aria-expanded="false" title="Library settings: thumbnail size, aspect ratio, sections &amp; sorting" aria-label="Library settings">${svgIcon("settings", 13)}</button>
              <button type="button" class="wg-close-btn" data-act="closePickerDrawer" title="Close My Library" aria-label="Close My Library">${svgIcon("close", 14)}</button>
            </div>
          </div>
          ${libraryDisplayMarkup()}
          ${libraryFilterBarMarkup()}
          <div class="wg-list" data-el="pickerList"></div>
          ${libraryScrollbarMarkup("personal")}
        </div>
      </div>
      <div class="wg-body">
        <div class="wg-editor-wrap">
          <div class="wg-editor-real" data-el="editorReal">
            <div class="wg-editor-layer wg-highlight" data-el="highlight"></div>
            <textarea class="wg-editor-layer wg-textarea" data-el="textarea" spellcheck="true"></textarea>
          </div>
        </div>
        ${statusBarMarkup({ doctor: true })}
        <div class="pp-controls">
          <div class="pp-mode-toggle" data-el="modeToggle">
            <button type="button" class="pp-mode-btn" data-mode="random" title="Produces \u2018count\u2019 prompts, each an independent random pick.">Random</button>
            <button type="button" class="pp-mode-btn" data-mode="combinatorial" title="Produces every combination of the text\u2019s wildcard/brace groups, up to \u2018max_prompts\u2019.">All combinations</button>
          </div>
          <div class="pp-row" data-el="countRow">
            <label>Count</label>
            <input type="number" min="1" step="1" data-el="countInput" aria-label="Number of random prompts" title="How many random prompts to generate this run. Ignored in Combinatorial mode.">
          </div>
          <div class="pp-row" data-el="maxPromptsRow">
            <label>Max prompts</label>
            <input type="number" min="0" step="1" placeholder="5000 (default)" data-el="maxPromptsInput" aria-label="Maximum prompts" title="Safety cap on the combinatorial expansion. 0 = default cap (5000). Ignored in Random mode.">
          </div>
          <div class="pp-row">
            <label>Seed</label>
            <input type="number" min="0" step="1" data-el="seedInput" aria-label="Prompt seed" title="Prompt seed.">
            <button type="button" class="wg-icon-btn" data-act="seedRandomizeNow" title="Roll a new random seed now" aria-label="Randomize seed">${svgIcon("dice", 13)}</button>
          </div>
          <div class="pp-row">
            <label>Seed mode</label>
            <select data-el="seedModeSelect" aria-label="Seed behavior"></select>
          </div>
          <div class="pp-estimate" data-el="estimateBox" title="Estimated batch size. Each list output contains one item per generated prompt; single-value outputs run once.">
            <div class="pp-estimate-main">
              <span class="pp-output-label">${svgIcon("branch", 13)} Output</span>
              <span class="pp-estimate-count" data-el="estimateCount">1 prompt</span>
            </div>
            <div class="pp-estimate-warning-text" data-el="estimateWarning"></div>
          </div>
        </div>
      </div>
    </div>
  `;

  mountCombinatorialTools(root, root.querySelector('[data-el="settingsPopup"]'));
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
  const statusBar = createStatusBar(root);
  const hintRight = el("hintRight");
  const charCount = el("charCount");
  const pickerDrawer = root.querySelector('[data-drawer="picker"]');
  const searchInput = el("search");
  const pickerList = el("pickerList");
  let libraryFeatures = null;
  const visualCollections = new VirtualCollectionManager(pickerList);
  const libraryDisplay = bindLibraryDisplay(pickerDrawer, () => {
    for (const collection of visualCollections.collections) collection.updateLayout(libraryVirtualLayout(pickerDrawer));
  });
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
  const preparedWidget = node.widgets.find(w => w.name === "prepared_batch");
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
    node._ppSyncPositiveAntonyms?.();
    if (preparedWidget) hideNativeWidget(preparedWidget);
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
    node._ppSyncPositiveAntonyms?.();
    const artistToggle = el("toggleAnimaArtistFormatting");
    if (artistToggle) artistToggle.checked = loadTheme().animaArtistFormatting === true;
    if (countWidget) countInput.value = countWidget.value;
    if (maxPromptsWidget) maxPromptsInput.value = maxPromptsWidget.value;
    if (seedWidget) {
      seedInput.value = seedWidget.value;
      seedInput.removeAttribute("aria-invalid");
    }
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
  const cleanupSeedInput = bindPromptSeedInput(seedInput, seedWidget, value => {
    seedWidget.value = value;
    if (typeof seedWidget.callback === "function") seedWidget.callback(seedWidget.value, node.graph?.canvas, node);
    node.graph?.setDirtyCanvas(true, true);
    seedInput.value = String(seedWidget.value);
    updateEstimate();
  });
  seedModeSelect.addEventListener("change", () => {
    if (!seedModeWidget) return;
    seedModeWidget.value = seedModeSelect.value;
    if (typeof seedModeWidget.callback === "function") seedModeWidget.callback(seedModeWidget.value, node.graph?.canvas, node);
    node.graph?.setDirtyCanvas(true, true);
    refinementController?.sourceChanged();
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
    refinementController?.sourceChanged();
  });
  action("seedRandomizeNow").addEventListener("click", () => {
    if (!seedWidget) return;
    const maxSeed = Number.MAX_SAFE_INTEGER;
    const randomSeed = Math.floor(Math.random() * maxSeed);
    seedWidget.value = randomSeed;
    seedInput.value = randomSeed;
    if (typeof seedWidget.callback === "function") seedWidget.callback(randomSeed, node.graph?.canvas, node);
    seedInput.value = String(seedWidget.value);
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
    { key: "vars_in", type: "STRING", label: "Variables in", default: false, desc: "Receive resolved ${variable} values from an upstream Prompt Palette node's Variables output (or key=value lines)." },
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
    { key: "negative_conditioning", slotIndex: 10, type: "CONDITIONING", label: "Negative conditioning", default: false, desc: "First resolved negative encoded with the paired LoRA-patched CLIP. For varying negatives use Negative conditioning list." },
    { key: "first_prompt", slotIndex: 11, type: "STRING", label: "Prompt (first)", default: false, desc: "The first generated prompt. Use Prompt list for every prompt." },
    { key: "negative_prompt", slotIndex: 12, type: "STRING", label: "Negative prompt", default: false, desc: "First resolved negative text. For varying negatives use Negative prompt list." },
    { key: "first_seed", slotIndex: 13, type: "INT", label: "Seed used (first)", default: false, desc: "Seed used for the first generated prompt. Use Seed list for every prompt." },
    { key: "wildcards_used_json", slotIndex: 14, type: "STRING", label: "Wildcards used (JSON)", default: false, desc: "A JSON list of every wildcard file picked during this batch, as one value." },
    { key: "raw_text", slotIndex: 15, type: "STRING", label: "Raw text (unresolved)", default: false, desc: "Exactly what is typed into this node before wildcard resolution." },
    { key: "wildcards_used_count", slotIndex: 16, type: "INT", label: "Wildcards used (count)", default: false, desc: "How many distinct wildcard files were picked during this batch." },
    { key: "used_enhancer", slotIndex: 17, type: "BOOLEAN", label: "Used enhancer override", default: false, desc: "True if the enhancer override replaced the generated prompts." },
    { key: "clip_token_count", slotIndex: 18, type: "INT", label: "CLIP token count (max)", default: false, desc: "Highest CLIP-L token count across the batch. -1 if unavailable or the connected text encoder is not CLIP-based." },
    { key: "batch_metadata_json", slotIndex: 19, type: "STRING", label: "Batch metadata (JSON)", default: false, desc: "One JSON record for the whole batch, including every generated prompt's metadata." },
    { key: "prompt_count", slotIndex: 20, type: "INT", label: "Prompt count", default: false, desc: "How many prompts this batch generated." },
    { key: "negative_prompt_list", slotIndex: 21, type: "STRING", label: "Negative prompt list", default: false, desc: "One negative text per positive prompt, in matching order. Use for prepared variations with different negatives." },
    { key: "negative_conditioning_list", slotIndex: 22, type: "CONDITIONING", label: "Negative conditioning list", default: false, desc: "One negative conditioning per positive prompt, encoded with the paired LoRA-patched CLIP. Needs CLIP connected." },
    { key: "variables", slotIndex: 23, type: "STRING", label: "Variables (JSON)", default: false, desc: "Resolved ${variable} assignments from this batch as JSON — connect to another Prompt Palette node's Variables in socket." },
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
  el("toggleAnimaArtistFormatting")?.addEventListener("change", event => {
    saveTheme({ ...loadTheme(), animaArtistFormatting: event.target.checked });
  });
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
  settingsTabs.forEach(button => {
    const panel = settingsPanels.find(item => item.dataset.settingsPanel === button.dataset.settingsTab);
    if (panel) {
      button.id = `${settingsPopup.id}-tab-${button.dataset.settingsTab}`; panel.id = `${settingsPopup.id}-panel-${button.dataset.settingsTab}`;
      button.setAttribute("aria-controls", panel.id); panel.setAttribute("aria-labelledby", button.id);
    }
    button.addEventListener("keydown", event => navigatePromptPaletteTabs(event, settingsTabs, next => activateSettingsTab(next.dataset.settingsTab)));
  });
  const cleanupSettingsDiscovery = installSettingsDiscovery(settingsPopup, activateSettingsTab);
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
    settingsTabs.find(button => button.classList.contains("active"))?.focus({ preventScroll: true });
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
    if (event.key !== "Escape" || event.defaultPrevented || isDialogOpen() || !root.contains(event.target)) return;
    if (findReplaceController?.isOpen?.()) { findReplaceController.closeFind({ restoreFocus: true }); }
    else if (node._wgIoRailOpen) ioRail.close();
    else if (node._ppLoraSidecar?.isOpen()) { node._ppLoraSidecar.close({ restoreFocus: true }); }
    else if (pickerDrawer.classList.contains("open")) { closePickerDrawer(); root.querySelector('[data-act="picker"]')?.focus({ preventScroll: true }); }
    else return;
    event.preventDefault(); event.stopPropagation();
  };
  root.addEventListener("keydown", handleWorkspaceEscape);
  document.addEventListener("keydown", handleWorkspaceEscape);

  // Reuse suite toolbar preferences. Themes and full toolbar controls remain in
  // main Settings; the import shortcut can also be toggled here.
  const appearanceBinding = bindSuiteAppearance({
    node,
    targets: [root, settingsPopup],
    onApplied(snapshot, { initial }) {
      Object.assign(theme, snapshot.theme);
      applyToolbarVisibility(root, theme);
      el("toggleLorasBtn").checked = theme.showLorasBtn !== false;
      el("toggleImportImageBtn").checked = theme.showImportImageBtn !== false;
      if (el("toggleRecipesBtn")) el("toggleRecipesBtn").checked = theme.showRecipesBtn !== false;
      if (el("toggleSlotsBtn")) el("toggleSlotsBtn").checked = theme.showSlotsBtn !== false;
      if (el("toggleLayoutsShortcut")) el("toggleLayoutsShortcut").checked = theme.showLayoutsShortcut !== false;
      if (el("toggleWorkspaceSnapGrid")) el("toggleWorkspaceSnapGrid").checked = theme.workspaceSnapGrid === true;
      node._ppRecipeWorkspace?.refreshChrome?.();
      if (!initial) render();
    },
  });

  el("toggleLorasBtn").addEventListener("change", event => saveTheme({ ...loadTheme(), showLorasBtn: event.target.checked, layoutPreset: "custom" }));
  el("toggleImportImageBtn").addEventListener("change", event => {
    saveTheme({ ...loadTheme(), showImportImageBtn: event.target.checked, layoutPreset: "custom" });
  });
  el("toggleRecipesBtn")?.addEventListener("change", event => {
    saveTheme({ ...loadTheme(), showRecipesBtn: event.target.checked, layoutPreset: "custom" });
  });
  el("toggleSlotsBtn")?.addEventListener("change", event => {
    saveTheme({ ...loadTheme(), showSlotsBtn: event.target.checked, layoutPreset: "custom" });
  });
  el("toggleLayoutsShortcut")?.addEventListener("change", event => {
    saveTheme({ ...loadTheme(), showLayoutsShortcut: event.target.checked, layoutPreset: "custom" });
    node._ppRecipeWorkspace?.refreshChrome?.();
  });
  el("toggleWorkspaceSnapGrid")?.addEventListener("change", event => {
    saveTheme({ ...loadTheme(), workspaceSnapGrid: event.target.checked });
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
    modeButtons.forEach(b => {
      b.classList.toggle("pp-active", b.dataset.mode === mode);
      b.setAttribute("aria-pressed", String(b.dataset.mode === mode));
    });
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
    estimateBox.dataset.estimateKind = willCap ? "capped" : "ready";
    estimateBox.title = `${fanoutN.toLocaleString()} prompts will run. Each list output contains one item per prompt; single-value outputs run once.`;
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
    // Invalidate an in-flight response as soon as text or controls change,
    // including while the replacement request is still being debounced.
    estimateSeq++;
    if (preparedWidget?.value) {
      try {
        const batch = JSON.parse(preparedWidget.value);
        if (batch.source === textarea.value && Array.isArray(batch.prompts)) {
          cancelNodeTimer(node, estimateDebounceTimer); estimateDebounceTimer = null;
          estimateBox.classList.remove("pp-loading");
          renderEstimate(batch.prompts.length, false, batch.prompts.length); return;
        }
      } catch { /* normal estimate below */ }
    }
    if (["mode", "count", "seed", "seed_mode", "max_prompts"].some(inputSocketLinked)) {
      cancelNodeTimer(node, estimateDebounceTimer);
      estimateDebounceTimer = null;
      estimateCount.textContent = "Connected inputs";
      estimateWarning.textContent = "Batch size is set by connected controls.";
      estimateBox.classList.remove("pp-warning", "pp-loading");
      estimateBox.dataset.estimateKind = "connected";
      estimateBox.title = estimateWarning.textContent;
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
    return lookupWildcard(String(name || "")).length > 0;
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
  let lastExecutionMetadata = null;
  let lastPreviewBranchSelections = [];
  let lastPreviewBranchSource = "";
  let findReplaceController = null;
  let promptSlotsController = null;

  function activeBranchSelections(sourceText = textarea.value) {
    const meta = lastExecutionMetadata;
    if (meta && typeof meta === "object") {
      const metaSource = typeof meta.source_text === "string" ? meta.source_text : meta.source_prompt;
      if (metaSource === sourceText) {
        const execBranches = meta.branch_selections || meta.extra?.branch_selections || meta.prompts?.[0]?.extra?.branch_selections;
        if (Array.isArray(execBranches) && execBranches.length) return execBranches;
      }
    }
    if (lastPreviewBranchSource === sourceText && Array.isArray(lastPreviewBranchSelections) && lastPreviewBranchSelections.length) {
      return lastPreviewBranchSelections;
    }
    return null;
  }

  function highlightText(text) {
    return renderPromptSyntax(syntaxCache.parse(text), {
      isKnown,
      categoryOf,
      buildCategoryColorMap,
      colorForToken,
      tagPainter: createTagPainter(theme),
      branchSelections: activeBranchSelections(text),
      extraDecorations: findReplaceController?.getDecorations?.() || null,
    });
  }

  function syncHiddenWidget() {
    if (promptState.current() !== textarea.value || promptState.isEstablished()) {
      promptState.commit(textarea.value);
    }
  }

  let refinementController = null, recipeWorkspace = null, powerTools = null, refinementUndo = null;
  const preparedState = installPreparedBatchState(node, preparedWidget);
  function historyValue() {
    const workspace = node.properties?.[WORKSPACE_KEY];
    return JSON.stringify({ text: textarea.value, negative: node._ppNegativePromptState?.current() || "",
      prepared: preparedState?.current() || "", workspace: workspace ? { ...workspace, view: "workspace" } : null });
  }
  function restoreHistory(value) {
    const active = document.activeElement;
    const fieldId = root.contains(active) ? active.closest?.('[data-field-id]')?.dataset.fieldId : null;
    const saved = JSON.parse(value);
    if (saved.workspace) saved.workspace.view = fieldId ? "workspace" : "editor";
    textarea.value = saved.text;
    node._ppNegativePromptState?.commit(saved.negative || "");
    preparedState?.commit(saved.prepared || "");
    recipeWorkspace?.restore(saved.workspace, { commit: false });
    render();
    if (fieldId && saved.workspace) recipeWorkspace.focusField(fieldId);
    else { textarea.focus({ preventScroll: true }); textarea.setSelectionRange(textarea.value.length, textarea.value.length); }
  }
  function performUndo() { const value = refinementUndo.undo(historyValue()); if (value !== null) restoreHistory(value); }
  function performRedo() { const value = refinementUndo.redo(historyValue()); if (value !== null) restoreHistory(value); }
  function atomicEdit(text, start = text.length, end = start) {
    refinementUndo.note(historyValue()); refinementUndo.flush();
    textarea.value = text; textarea.setSelectionRange(start, end); render(); refinementUndo.flush();
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }
  const cleanupImageImport = attachImageImport({ node, root, getState: historyValue, apply: ({ positive, negative, hasNegative }) => {
    const saved = recipeWorkspace?.snapshot();
    if (saved) {
      saved.recipe = editCompiledPrompt(saved.recipe, positive);
      if (hasNegative) saved.recipe = editCompiledPrompt(saved.recipe, negative, { channel: "negative" });
    }
    refinementUndo.note(historyValue()); refinementUndo.flush();
    preparedState?.commit("");
    if (saved) recipeWorkspace.restore(saved);
    else { textarea.value = positive; if (hasNegative) node._ppNegativePromptState.commit(negative); render(); }
    textarea.setSelectionRange(positive.length, positive.length);
    refinementUndo.note(historyValue()); refinementUndo.flush();
  } });
  function render() {
    recipeWorkspace?.reconcile(); recipeWorkspace?.contextChanged();
    refinementController?.sourceChanged();
    const { html, names, categoriesInUse, decorations, ranges } = highlightText(textarea.value);
    tokenRanges = ranges;
    if (!syntaxHighlighter.render(decorations, textarea.value)) highlight.innerHTML = html + "\n";
    statusBar.renderLegend(categoriesInUse.map(cat => {
      const color = theme.categoryPins[cat] || categoryColorFromHue((hashStr(cat) % 360 + theme.hueRotate) % 360, theme.saturation, currentUiSurface());
      return [cat, color];
    }));
    const knownCount = names.filter(isKnown).length;
    const missingCount = names.length - knownCount;
    hintRight.textContent = wildcardStatusText(knownCount, missingCount);
    const len = textarea.value.length;
    charCount.textContent = `${len.toLocaleString()} char${len === 1 ? "" : "s"}`;
    statusBar.refresh();
    syncHiddenWidget();
    refinementUndo?.note(historyValue());
    powerTools?.refresh();
    updateEstimate();
  }

  function refreshFromHidden() {
    recipeWorkspace?.refresh();
    const restored = recipeWorkspace?.snapshot() ? textarea.value : promptState.restore();
    if (restored !== textarea.value) {
      textarea.value = restored;
      render();
      refinementUndo?.reset(historyValue());
    }
    syncControlsFromWidgets();
  }

  // Same provider the main Prompt Palette node uses: the library is already cached locally, so no
  // request goes to the server per keystroke. Recents are shared between nodes through the same
  // stored usage list.
  refinementUndo = new EditorUndoManager({ initialValue: historyValue(), limit: TEXT_UNDO_LIMIT, coalesceMs: 0 });
  refinementController = createRefinementController({
    node, root, textarea, render, preparedWidget,
    onOpenWorkspace: (...args) => recipeWorkspace.open(...args),
    variationGuard: () => { if (recipeWorkspace?.isActive()) throw new Error("Use Selection in a workspace field or choose a workspace Variation Lab scope."); },
    host: el("variationPopup").querySelector(".wg-settings-body"), openHost: () => powerTools.openSelectionLab(),
    getSeed: () => seedWidget?.value ?? 0,
    getLibrary: () => libraryCache, refreshLibrary,
    atomicEdit,
  });
  const noteRefinementInput = () => refinementUndo.note(historyValue());
  const undoRefinementKey = event => {
    const action = historyShortcut(event);
    if (!action) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (action === "redo") performRedo(); else performUndo();
  };
  textarea.addEventListener("input", noteRefinementInput);
  textarea.addEventListener("keydown", undoRefinementKey, true);
  const holdRefinementComposition = () => refinementUndo.hold();
  const releaseRefinementComposition = () => { refinementUndo.release(); noteRefinementInput(); refinementUndo.flush(); };
  textarea.addEventListener("compositionstart", holdRefinementComposition);
  textarea.addEventListener("compositionend", releaseRefinementComposition);
  const usageStore = createPromptUsageStore();
  async function getAcMatches(query, contextKind = "wildcard") {
    const q = String(contextKind === "booru" ? tagSearch(query).query : query || "").trim().toLowerCase();
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
    const tagRows = await getBooruAutocompleteMatches(query);
    return mergeUnifiedRows(tagRows, [...recentRows, ...libraryRows]);
  }
  const cleanupAutocompleteBinding = attachAutocomplete(textarea, {
    getMatches: getAcMatches,
    onCommit: (item) => {
      if (item?.kind === "booru" || item?.kind === "custom") {
        try { usageStore.recordTag(item.value, item.kind, item.category); } catch { /* recents are a convenience */ }
      } else if (item && item.kind !== "syntax" && item.kind !== "lora" && item.value) {
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
  function getCategoryColor(cat) {
    return theme.categoryPins[cat] || categoryColorFromHue((hashStr(cat) % 360 + theme.hueRotate) % 360, theme.saturation);
  }
  async function showTipForName(x, y, name, known) {
    const requestVersion = ++hoverRequestVersion;
    hoverTip.__lastClientX = x;
    hoverTip.__lastClientY = y;
    let entry = previewCache.get(name);
    if (!entry && known) {
      try {
        entry = await API.preview(name);
        if (requestVersion === hoverRequestVersion && nodeIsActive(node)) previewCache.set(name, entry);
      } catch {
        entry = null;
      }
    }
    if (requestVersion !== hoverRequestVersion || !nodeIsActive(node)) return;
    if (known) {
      const cat = categoryOf(name);
      const color = getCategoryColor(cat);
      const thumbRel = thumbMap?.[name];
      const thumbUrl = thumbRel ? API.thumbnailUrl(thumbRel) : "";
      copyPromptPaletteThemeScope(root, hoverTip);
      renderLibraryHoverTip(hoverTip, {
        name,
        lines: entry?.lines || [],
        totalLines: entry?.total ?? entry?.lines?.length ?? 0,
        thumbUrl,
        category: cat,
        accent: color,
        isPinned: pinned.has(name),
        isRecipe: isRecipeCategory(cat),
        error: !entry,
      });
      positionPromptPaletteTip(hoverTip, hoverTip.__lastClientX ?? x, hoverTip.__lastClientY ?? y);
      const img = hoverTip.querySelector(".wg-tip-thumb");
      if (img) {
        img.addEventListener("load", () => {
          if (hoverTip.style.display === "block") {
            positionPromptPaletteTip(hoverTip, hoverTip.__lastClientX ?? x, hoverTip.__lastClientY ?? y);
          }
        }, { once: true });
      }
      return;
    }
    const lines = (entry?.lines || []).slice(0, 4);
    copyPromptPaletteThemeScope(root, hoverTip);
    hoverTip.innerHTML = `<div class="wg-tip-title">${escapeHtml(known ? name : name + " (not found)")}</div>` +
      (lines.length ? lines.map(l => `<div class="wg-tip-line">${escapeHtml(l)}</div>`).join("") :
        `<div class="wg-tip-line">${known ? "no preview available" : "file missing"}</div>`);
    positionPromptPaletteTip(hoverTip, x, y);
  }
  function hideTip() { hoverRequestVersion += 1; hoverTip.style.display = "none"; }
  const cleanupEditorHover = bindEditorWildcardHover({ node, editor: textarea, getRanges: () => tokenRanges,
    show: showTipForName, hide: hideTip });
  powerTools = createCombinatorialTools({
    node, root, settingsPopup, el, textarea, seedWidget, ioRail, previewCache, expandedCats, searchInput, getMatches: getAcMatches,
    getLibrary: () => libraryCache, getKnown: () => knownSet, getSourcePaths: () => tokenRanges.flatMap(t => lookupWildcard(t.name).map(entry => entry.path)),
    closeSettings, closePickerDrawer, openPickerDrawer, syncControlsFromWidgets, refreshLibrary, renderPickerList,
    applyEdit: atomicEdit, undo: performUndo, redo: performRedo, canUndo: () => refinementUndo.canUndo(), canRedo: () => refinementUndo.canRedo(),
    onPreviewResolved: ({ source, branchSelections }) => {
      lastPreviewBranchSelections = Array.isArray(branchSelections) ? branchSelections : [];
      lastPreviewBranchSource = source;
      if (lastPreviewBranchSelections.length) render();
    },
  });
  node._wgAcceptPromptMetadata = (metadata) => {
    if (!metadata || typeof metadata !== "object") return;
    lastExecutionMetadata = metadata;
    render();
  };
  recipeWorkspace = createRecipeWorkspaceController({
    node, root, textarea, render, flushHistory: () => refinementUndo.flush(), holdHistory: () => refinementUndo.hold(), releaseHistory: () => { refinementUndo.release(); refinementUndo.flush(); }, onUndo: performUndo, onRedo: performRedo,
    onShowEditor: powerTools.showEditor,
    host: el("variationPopup").querySelector(".wg-settings-body"), openHost: () => powerTools.openSelectionLab(),
    openVariations: scope => powerTools.openVariations(scope),
    bindHover: (editor, getRanges) => bindEditorWildcardHover({ node, editor, getRanges, show: showTipForName, hide: hideTip }),
    onLibrarySaved: async path => { previewCache.delete(path); await refreshLibrary(); },
    getMatches: getAcMatches, onCommit: item => { if (item?.kind === "booru" || item?.kind === "custom") usageStore.recordTag(item.value, item.kind, item.category); else if (item?.value && item.kind !== "syntax" && item.kind !== "lora") usageStore.recordLibrary(item.value); },
    paintSyntax: highlightText, getSeed: () => seedWidget?.value ?? 0, getMode: () => "entire text as one",
    getLibrary: () => libraryCache, refreshLibrary,
  });
  node._ppRecipeWorkspace = recipeWorkspace;
  const syncHighlightScroll = () => { highlight.scrollTop = textarea.scrollTop; highlight.scrollLeft = textarea.scrollLeft; };
  textarea.addEventListener("scroll", syncHighlightScroll);

  findReplaceController = attachEditorFindReplace({
    root,
    textarea,
    applyEdit: atomicEdit,
    onStateChange: () => {
      const { html, decorations } = highlightText(textarea.value);
      if (!syntaxHighlighter.render(decorations, textarea.value)) highlight.innerHTML = html + "\n";
    },
  });
  node._ppFindReplace = findReplaceController;

  promptSlotsController = installPromptSlots({
    node,
    root,
    textarea,
    getNegative: () => node._ppNegativePromptState?.current?.() || "",
    setNegative: (val) => node._ppNegativePromptState?.commit?.(val || ""),
    getWorkspace: () => recipeWorkspace?.snapshot?.() || null,
    setWorkspace: (ws) => recipeWorkspace?.restore?.(ws, { commit: true }),
    onSlotSwitched: (slotKey, _slot, { duplicated }) => {
      refinementUndo.note(historyValue());
      refinementUndo.flush();
      render();
      notify(
        "info",
        duplicated ? `Copied to Slot ${slotKey}` : `Switched to Slot ${slotKey}`,
        duplicated ? `Duplicated current prompt into Slot ${slotKey}.` : `Active prompt slot: ${slotKey}`
      );
    },
  });
  node._ppPromptSlots = promptSlotsController;

  const cleanupEditorContext = attachEditorContextMenu(textarea, {
    render, beforeOpen: () => { hideTip(); closeInjectMenu(); },
    promptTools: { node, apply: atomicEdit },
    syntaxEnabled: () => theme.syntaxInjectorEnabled !== false,
    findAction: (opts) => findReplaceController.openFind(opts),
    syntaxAction: (event, selection) => {
      if (theme.syntaxInjectorEnabled === false) return;
      openInjectMenuAtPoint(event.clientX, event.clientY, "", textarea, render, selection.start === selection.end ? null : selection);
    },
  });
  const loraSidecar = installLoraSidecar({ root, node, editor: textarea, beforeOpen: () => { closeSettings(); closePickerDrawer(); powerTools?.closeAllPowerPopups(); ioRail.close(); } });

  let activeQuickFilter = "all";
  let pickerKbIndex = -1;
  function pickerRows() { return Array.from(pickerList.querySelectorAll(".wg-item[data-path], .wg-thumb-item[data-path]")); }
  function movePickerKbIndex(delta) {
    const rows = pickerRows();
    rows.forEach((r) => r.classList.remove("wg-kb-active"));
    if (!rows.length) { pickerKbIndex = -1; return; }
    pickerKbIndex = pickerKbIndex === -1
      ? (delta > 0 ? 0 : rows.length - 1)
      : (pickerKbIndex + delta + rows.length) % rows.length;
    const row = rows[pickerKbIndex];
    row.classList.add("wg-kb-active");
    row.scrollIntoView({ block: "nearest" });
  }

  function insertWildcard(path) {
    if (node._ppInsertAdjustableRecipe?.(path)) return;
    const start = textarea.selectionStart, end = textarea.selectionEnd;
    const tag = `__${path}__`;
    textarea.value = textarea.value.slice(0, start) + tag + textarea.value.slice(end);
    const caret = start + tag.length;
    textarea.selectionStart = textarea.selectionEnd = caret;
    textarea.focus();
    usageStore.recordLibrary(path);
    render();
    renderPickerList(searchInput.value);
  }

  async function copyLibraryPath(path, button = null) {
    try {
      await navigator.clipboard.writeText(`__${path}__`);
      if (!button) return;
      const previous = button.innerHTML;
      button.innerHTML = "&#10003;";
      button.classList.add("copied");
      scheduleNodeTimer(node, () => { button.innerHTML = previous; button.classList.remove("copied"); }, 900);
    } catch {
      if (button) button.title = "Copy failed — clipboard permission denied";
    }
  }

  function pickerItemRow(item, filter) {
    const cat = categoryOf(item.path);
    const isRecipe = isRecipeCategory(cat);
    const color = getCategoryColor(cat);
    const isPinned = pinned.has(item.path);
    const thumbRel = thumbMap?.[item.path];
    const showListThumb = Boolean(thumbRel) && pickerDrawer?.dataset.listThumbs !== "false";
    const row = document.createElement("div");
    row.className = "wg-item" + (isRecipe ? " wg-item-recipe" : "") + (showListThumb ? " has-list-thumb" : "");
    row.dataset.path = item.path;
    const swatchHtml = isRecipe
      ? `<span class="wg-sw wg-sw-recipe" style="background:${color};" title="Palette Recipe">&#128214;</span>`
      : `<span class="wg-sw" style="background:${color}; border-radius:50%;"></span>`;
    const miniThumbHtml = showListThumb
      ? `<span class="wg-item-thumb-wrap" style="--wg-item-accent:${color};"><img class="wg-item-thumb" src="${escapeHtml(API.thumbnailUrl(thumbRel))}" alt="" loading="lazy" decoding="async" fetchpriority="low"></span>`
      : "";
    const injectHtml = theme.syntaxInjectorEnabled !== false
      ? `<button type="button" class="wg-inject-trigger" title="Insert wildcard syntax for &quot;${escapeHtml(item.path)}&quot;" draggable="false">&#9889;</button>`
      : "";
    row.innerHTML =
      `${swatchHtml}${miniThumbHtml}` +
      `<span class="wg-name">${highlightMatch(item.path.split("/").pop(), filter)}</span>` +
      `<button type="button" class="wg-copy-trigger" title="Copy __${escapeHtml(item.path)}__" draggable="false">&#128203;</button>` +
      `${injectHtml}` +
      `<span class="wg-pin ${isPinned ? "pinned" : ""}">${isPinned ? "\u2605" : "\u2606"}</span>`;
    return row;
  }

  function pickerTile(item) {
    const cat = categoryOf(item.path);
    const isRecipe = isRecipeCategory(cat);
    const color = getCategoryColor(cat);
    const isPinned = pinned.has(item.path);
    const name = item.path.split("/").pop();
    const thumbRel = thumbMap[item.path];

    const thumbHtml = libraryThumbnailMarkup(thumbRel ? API.thumbnailUrl(thumbRel, "") : "", isRecipe);

    const tile = document.createElement("div");
    tile.className = "wg-thumb-item" + (isRecipe ? " wg-item-recipe" : "") + (thumbRel ? " has-thumb" : "");
    tile.dataset.path = item.path;
    tile.style.setProperty("--wg-card-accent", color);
    tile.title = isRecipe ? `${item.path} (Palette Recipe)` : item.path;
    const injectHtml = theme.syntaxInjectorEnabled !== false
      ? `<button type="button" class="wg-inject-trigger wg-thumb-inject" title="Insert wildcard syntax for &quot;${escapeHtml(item.path)}&quot;" draggable="false">&#9889;</button>`
      : "";
    tile.innerHTML = `${thumbHtml}${injectHtml}<span class="wg-thumb-pin ${isPinned ? "pinned" : ""}">${isPinned ? "\u2605" : "\u2606"}</span><span class="wg-thumb-name">${escapeHtml(name)}</span><span class="wg-thumb-meta">${escapeHtml(item.path.includes("/") ? item.path.slice(0, item.path.lastIndexOf("/")) : "Unfiled")}</span>`;
    return tile;
  }

  function moveCategoryByOffset(cat, delta) {
    const present = Array.from(new Set(libraryCache.map((e) => categoryOf(e.path))));
    const known = catOrder.filter((c) => present.includes(c));
    const unseen = present.filter((c) => !catOrder.includes(c)).sort();
    const order = [...known, ...unseen];
    const idx = order.indexOf(cat);
    if (idx === -1) return;
    const targetIdx = idx + delta;
    if (targetIdx < 0 || targetIdx >= order.length) return;
    const [moved] = order.splice(idx, 1);
    order.splice(targetIdx, 0, moved);
    catOrder = order;
    saveCatOrder(catOrder);
    pickerDrawer.__ppLibraryDisplayBinding?.setState?.({ catSort: "custom" }, { persist: true, notify: false });
    renderPickerList(searchInput.value);
  }

  const searchCollapsedCats = new Set();

  function isCatExpanded(cat, q = "") {
    if (q) return !searchCollapsedCats.has(cat);
    return expandedCats.has(cat);
  }

  function toggleCategoryExpanded(cat) {
    const q = (searchInput.value || "").trim().toLowerCase();
    if (q) {
      if (searchCollapsedCats.has(cat)) searchCollapsedCats.delete(cat);
      else searchCollapsedCats.add(cat);
    } else {
      if (expandedCats.has(cat)) expandedCats.delete(cat);
      else expandedCats.add(cat);
      saveExpandedCats(expandedCats);
    }
    renderPickerList(searchInput.value);
  }

  function toggleSectionCollapsed(secId) {
    const org = getLibraryOrganization(pickerDrawer);
    const collapsed = new Set(org.collapsedSections || []);
    if (collapsed.has(secId)) collapsed.delete(secId);
    else collapsed.add(secId);
    pickerDrawer.__ppLibraryDisplayBinding?.setState?.({ collapsedSections: Array.from(collapsed) });
  }

  function hideCategory(cat) {
    const org = getLibraryOrganization(pickerDrawer);
    const hidden = new Set(org.hiddenCats || []);
    hidden.add(cat);
    pickerDrawer.__ppLibraryDisplayBinding?.setState?.({ hiddenCats: Array.from(hidden) });
  }

  function expandAllCategories() {
    searchCollapsedCats.clear();
    for (const entry of libraryCache) expandedCats.add(categoryOf(entry.path));
    saveExpandedCats(expandedCats);
    renderPickerList(searchInput.value);
  }

  function collapseAllCategories() {
    const q = (searchInput.value || "").trim().toLowerCase();
    if (q) {
      for (const entry of libraryCache) searchCollapsedCats.add(categoryOf(entry.path));
    } else {
      expandedCats.clear();
      saveExpandedCats(expandedCats);
    }
    renderPickerList(searchInput.value);
  }

  function openCategoryContextMenu(event, cat) {
    const q = (searchInput.value || "").trim().toLowerCase();
    const isExpanded = isCatExpanded(cat, q);
    const org = getLibraryOrganization(pickerDrawer);
    closeInjectMenu();
    const actions = [
      {
        label: isExpanded ? `Collapse "${cat}"` : `Expand "${cat}"`,
        icon: "jump",
        group: "folder",
        onSelect: () => toggleCategoryExpanded(cat),
      },
      { label: "Expand all folders", icon: "jump", group: "folder", onSelect: expandAllCategories },
      { label: "Collapse all folders", icon: "jump", group: "folder", onSelect: collapseAllCategories },
      { label: `Move "${cat}" up`, icon: "jump", group: "order", onSelect: () => moveCategoryByOffset(cat, -1) },
      { label: `Move "${cat}" down`, icon: "jump", group: "order", onSelect: () => moveCategoryByOffset(cat, 1) },
      { label: `Hide "${cat}" folder`, icon: "pin", group: "visibility", onSelect: () => hideCategory(cat) },
    ];
    if (org.hiddenCats?.length) {
      actions.push({
        label: `Show all hidden folders (${org.hiddenCats.length})`,
        icon: "pin",
        group: "visibility",
        onSelect: () => pickerDrawer.__ppLibraryDisplayBinding?.setState?.({ hiddenCats: [] }),
      });
    }
    openCtxMenu(event.clientX, event.clientY, actions);
  }

  function openLibraryContextMenu(event, path) {
    const cat = categoryOf(path);
    const nowPinned = pinned.has(path);
    const item = libraryCache.find((entry) => entry.path === path);
    closeInjectMenu();
    openCtxMenu(event.clientX, event.clientY, [
      { label: "Insert wildcard", icon: "plus", group: "insert", onSelect: () => insertWildcard(path) },
      ...(theme.syntaxInjectorEnabled !== false ? [{ label: "Insert with syntax…", icon: "bolt", group: "insert", onSelect: () => openInjectMenuAtPoint(event.clientX, event.clientY, path, textarea, render) }] : []),
      ...(powerTools?.openEditForItem ? [{ label: "Edit library entry…", icon: "edit", group: "item", onSelect: () => powerTools.openEditForItem(path) }] : []),
      { label: "Copy wildcard reference", icon: "path", group: "item", onSelect: () => copyLibraryPath(path) },
      {
        label: nowPinned ? "Unpin entry" : "Pin entry", icon: "pin", group: "item",
        onSelect: () => {
          if (pinned.has(path)) pinned.delete(path); else pinned.add(path);
          savePinned(pinned);
          renderPickerList(searchInput.value);
        },
      },
      ...libraryThumbnailActions(path, { hasThumbnail: !!thumbMap[path], editable: !item?.type || item.type === "txt",
        isActive: () => !libraryDisposed && nodeIsActive(node) }),
      { label: `Jump to "${cat}"`, icon: "jump", group: "nav", onSelect: () => jumpToCategory(cat) },
      { label: `Hide "${cat}" folder`, icon: "pin", group: "nav", onSelect: () => hideCategory(cat) },
    ]);
  }

  let delegatedInjectTimer = null;
  pickerList.addEventListener("click", (event) => {
    const resetFiltersBtn = event.target.closest('[data-act="libResetFilters"]');
    if (resetFiltersBtn) {
      event.stopPropagation();
      resetLibraryFilters();
      return;
    }
    const clearRecent = event.target.closest('[data-act="clearRecent"]');
    if (clearRecent) {
      event.stopPropagation();
      usageStore.clearRecent();
      renderPickerList(searchInput.value);
      return;
    }
    const showHiddenBtn = event.target.closest('[data-act="showHiddenCats"]');
    if (showHiddenBtn) {
      event.stopPropagation();
      pickerDrawer.__ppLibraryDisplayBinding?.setState?.({ hiddenCats: [] });
      return;
    }
    const catActBtn = event.target.closest("[data-cat-act]");
    if (catActBtn) {
      event.stopPropagation();
      const folderEl = catActBtn.closest(".wg-folder[data-cat]");
      const cat = folderEl?.dataset.cat;
      if (!cat) return;
      const act = catActBtn.dataset.catAct;
      if (act === "up") moveCategoryByOffset(cat, -1);
      else if (act === "down") moveCategoryByOffset(cat, 1);
      else if (act === "hide") hideCategory(cat);
      return;
    }
    const secToggle = event.target.closest("[data-sec-collapse]");
    if (secToggle) {
      event.stopPropagation();
      toggleSectionCollapsed(secToggle.dataset.secCollapse);
      return;
    }
    const folder = event.target.closest(".wg-folder[data-cat]");
    if (folder) {
      toggleCategoryExpanded(folder.dataset.cat);
      return;
    }
    const host = event.target.closest(".wg-item[data-path], .wg-thumb-item[data-path]");
    if (!host) return;
    const path = host.dataset.path;
    if (event.target.closest(".wg-copy-trigger")) {
      event.stopPropagation();
      copyLibraryPath(path, event.target.closest(".wg-copy-trigger"));
      return;
    }
    if (event.target.closest(".wg-inject-trigger")) {
      event.stopPropagation();
      cancelNodeTimer(node, delegatedInjectTimer);
      const trigger = event.target.closest(".wg-inject-trigger");
      if (injectState && injectState.trigger === trigger) closeInjectMenu();
      else openInjectMenu(trigger, path, textarea, render);
      return;
    }
    if (event.target.closest(".wg-pin, .wg-thumb-pin")) {
      event.stopPropagation();
      if (pinned.has(path)) pinned.delete(path); else pinned.add(path);
      savePinned(pinned);
      renderPickerList(searchInput.value);
      return;
    }
    insertWildcard(path);
  });

  const contextEntry = (event) => event.target.closest?.(".wg-item[data-path], .wg-thumb-item[data-path], .wg-folder[data-cat]");
  const cleanupPickerContext = attachLibraryContextMenu(pickerList, (event) => {
    hideTip();
    cancelNodeTimer(node, delegatedInjectTimer);
    const target = contextEntry(event);
    if (!target) return;
    if (target.classList.contains("wg-folder") && target.dataset.cat) {
      openCategoryContextMenu(event, target.dataset.cat);
    } else if (target.dataset.path) {
      openLibraryContextMenu(event, target.dataset.path);
    }
  }, contextEntry);

  pickerList.addEventListener("mousemove", (event) => {
    const host = event.target.closest(".wg-item[data-path], .wg-thumb-item[data-path]");
    if (!host) return;
    hoverTip.__lastClientX = event.clientX;
    hoverTip.__lastClientY = event.clientY;
    if (hoverTip.style.display === "block") positionPromptPaletteTip(hoverTip, event.clientX, event.clientY);
  });
  pickerList.addEventListener("mouseover", (event) => {
    const trigger = event.target.closest(".wg-inject-trigger");
    if (trigger && !trigger.contains(event.relatedTarget)) {
      cancelScheduledCloseInjectMenu();
      cancelNodeTimer(node, delegatedInjectTimer);
      const path = trigger.closest("[data-path]")?.dataset.path;
      delegatedInjectTimer = scheduleNodeTimer(node, () => { if (path) openInjectMenu(trigger, path, textarea, render); }, 90);
      return;
    }
    const host = event.target.closest(".wg-item[data-path], .wg-thumb-item[data-path]");
    if (host && !host.contains(event.relatedTarget)) showTipForName(event.clientX, event.clientY, host.dataset.path, true);
  });
  pickerList.addEventListener("mouseout", (event) => {
    const trigger = event.target.closest(".wg-inject-trigger");
    if (trigger && !trigger.contains(event.relatedTarget)) {
      cancelNodeTimer(node, delegatedInjectTimer);
      scheduleCloseInjectMenu();
    }
    const host = event.target.closest(".wg-item[data-path], .wg-thumb-item[data-path]");
    if (host && !host.contains(event.relatedTarget)) hideTip();
  });

  let dragCat = null;
  pickerList.addEventListener("dragstart", (event) => {
    const header = event.target.closest?.(".wg-folder.wg-draggable[data-cat]");
    if (!header) return;
    dragCat = header.dataset.cat;
    header.classList.add("dragging");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", dragCat);
  });
  pickerList.addEventListener("dragend", (event) => {
    event.target.closest?.(".wg-folder")?.classList.remove("dragging");
    dragCat = null;
    pickerList.querySelectorAll(".wg-folder.drag-over").forEach((el) => el.classList.remove("drag-over"));
  });
  pickerList.addEventListener("dragover", (event) => {
    const header = event.target.closest?.(".wg-folder.wg-draggable[data-cat]");
    if (!header || !dragCat || dragCat === header.dataset.cat) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    header.classList.add("drag-over");
  });
  pickerList.addEventListener("dragleave", (event) => event.target.closest?.(".wg-folder")?.classList.remove("drag-over"));
  pickerList.addEventListener("drop", (event) => {
    const header = event.target.closest?.(".wg-folder.wg-draggable[data-cat]");
    if (!header) return;
    event.preventDefault();
    header.classList.remove("drag-over");
    const dragged = dragCat || event.dataTransfer.getData("text/plain");
    const cat = header.dataset.cat;
    if (!dragged || dragged === cat) return;
    const from = catOrder.indexOf(dragged), to = catOrder.indexOf(cat);
    if (from === -1 || to === -1) return;
    catOrder.splice(from, 1);
    catOrder.splice(to, 0, dragged);
    saveCatOrder(catOrder);
    renderPickerList(searchInput.value);
  });

  function appendItems(container, items, filter = "", category = "") {
    if (["masonry", "filmstrip"].includes(pickerViewMode)) {
      visualCollections.mount(container, { ...libraryVirtualLayout(pickerDrawer), items, mode: pickerViewMode, renderItem: pickerTile });
      return;
    }
    const categoryColor = category ? getCategoryColor(category) : "";
    if (pickerViewMode !== "list") {
      const grid = document.createElement("div");
      grid.className = "wg-thumb-grid wg-static-collection" + (category ? " wg-category-content" : "");
      if (categoryColor) grid.style.setProperty("--wg-category-accent", categoryColor);
      items.forEach((item) => grid.appendChild(pickerTile(item)));
      container.appendChild(grid);
    } else {
      items.forEach((item, index) => {
        const row = pickerItemRow(item, filter);
        if (category) {
          row.classList.add("wg-category-entry");
          if (index === 0) row.classList.add("wg-category-first");
          if (index === items.length - 1) row.classList.add("wg-category-last");
          if (categoryColor) row.style.setProperty("--wg-category-accent", categoryColor);
        }
        container.appendChild(row);
      });
    }
  }

  function jumpToCategory(cat) {
    searchInput.value = "";
    activeQuickFilter = "all";
    quickFilterBtns.forEach((candidate) => {
      const active = candidate.dataset.libQuickFilter === "all";
      candidate.classList.toggle("active", active);
      candidate.setAttribute("aria-pressed", String(active));
    });
    const org = getLibraryOrganization(pickerDrawer);
    if (org.hiddenCats?.includes(cat)) {
      pickerDrawer.__ppLibraryDisplayBinding?.setState?.({
        hiddenCats: org.hiddenCats.filter((c) => c !== cat),
      }, { persist: true, notify: false });
    }
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

  function renderPickerList(filter = "") {
    visualCollections.clear();
    if (ctxMenuOpen) closeCtxMenu();
    if (injectState && injectState.textarea === textarea) closeInjectMenu();
    pickerKbIndex = -1;
    const q = (filter || "").trim().toLowerCase();
    const org = getLibraryOrganization(pickerDrawer);
    org.quickFilter = activeQuickFilter !== "all" ? activeQuickFilter : "";
    const hiddenSecSet = new Set(org.hiddenSections || []);

    const allCatsSet = new Set();
    for (const entry of libraryCache) allCatsSet.add(categoryOf(entry.path));
    const allPresentCats = Array.from(allCatsSet);
    const knownOrder = catOrder.filter((c) => allCatsSet.has(c));
    const unseenOrder = allPresentCats.filter((c) => !catOrder.includes(c)).sort();
    const canonicalCatOrder = [...knownOrder, ...unseenOrder];
    if (unseenOrder.length && !q) {
      catOrder = canonicalCatOrder.slice();
      saveCatOrder(catOrder);
    }
    pickerDrawer.__ppLibraryDisplayBinding?.syncCategories?.(canonicalCatOrder, getCategoryColor);

    let rawItems = libraryCache;
    if (q) rawItems = rawItems.filter((i) => i.path.toLowerCase().includes(q));
    const items = sortLibraryItems(libraryFeatures?.filter(rawItems) || rawItems, org, pinned, thumbMap);
    const prevScrollTop = pickerList.scrollTop;
    pickerList.innerHTML = "";

    const renderCategoriesSection = () => {
      const grouped = new Map();
      items.forEach((item) => {
        const cat = categoryOf(item.path);
        if (!grouped.has(cat)) grouped.set(cat, []);
        grouped.get(cat).push(item);
      });
      const canReorder = !q && !org.quickFilter && (org.catSort || "custom") === "custom";
      const cats = sortLibraryCategories(
        Array.from(grouped.keys()),
        grouped,
        { ...org, includeHidden: Boolean(q || org.quickFilter) },
        canonicalCatOrder
      );
      cats.forEach((cat, idx) => {
        const catItems = grouped.get(cat) || [];
        const isExpanded = isCatExpanded(cat, q);
        const header = document.createElement("div");
        header.className = "wg-folder" + (isExpanded ? " expanded" : "") + (isRecipeCategory(cat) ? " wg-folder-recipe" : "") + (canReorder ? " wg-draggable" : "");
        header.dataset.cat = cat;
        header.draggable = canReorder;
        const categoryColor = getCategoryColor(cat);
        header.style.setProperty("--wg-category-accent", categoryColor);
        const folderLabel = isRecipeCategory(cat) ? `&#128214; ${escapeHtml(cat)}` : escapeHtml(cat);
        const toolsHtml = !q && !org.quickFilter
          ? `<span class="wg-folder-tools">
              ${canReorder ? `<button type="button" class="wg-folder-act" data-cat-act="up" ${idx === 0 ? "disabled" : ""} title="Move folder up" aria-label="Move ${escapeHtml(cat)} up">↑</button><button type="button" class="wg-folder-act" data-cat-act="down" ${idx === cats.length - 1 ? "disabled" : ""} title="Move folder down" aria-label="Move ${escapeHtml(cat)} down">↓</button>` : ""}
              <button type="button" class="wg-folder-act wg-folder-act-hide" data-cat-act="hide" title="Hide &quot;${escapeHtml(cat)}&quot; folder" aria-label="Hide ${escapeHtml(cat)} folder">✕</button>
            </span>`
          : "";
        header.innerHTML = `<span class="wg-folder-caret">${isExpanded ? "\u25BE" : "\u25B8"}</span><span class="wg-folder-name">${folderLabel}</span>${toolsHtml}<span class="wg-folder-count">${catItems.length}</span>`;
        header.title = isExpanded ? "Click to collapse · Right-click for folder options" : "Click to expand · Right-click for folder options";
        pickerList.appendChild(header);
        if (isExpanded) appendItems(pickerList, catItems, q, cat);
      });

      if (!q && !org.quickFilter && org.hiddenCats?.length) {
        const hiddenNote = document.createElement("div");
        hiddenNote.className = "wg-hidden-cats-bar";
        hiddenNote.innerHTML = `<span>${org.hiddenCats.length} ${org.hiddenCats.length === 1 ? "folder" : "folders"} hidden</span><button type="button" class="wg-clear-recent" data-act="showHiddenCats">Show all</button>`;
        pickerList.appendChild(hiddenNote);
      }
    };

    const collapsedSecSet = new Set(org.collapsedSections || []);
    if (!q && !org.quickFilter) {
      const sectionOrder = Array.isArray(org.sectionOrder) ? org.sectionOrder : ["pinned", "recent", "categories"];
      const byPath = new Map(libraryCache.map((entry) => [entry.path, entry]));
      for (const secId of sectionOrder) {
        if (hiddenSecSet.has(secId)) continue;
        if (secId === "pinned") {
          const pinnedItems = sortLibraryItems(
            libraryCache.filter((i) => pinned.has(i.path)),
            org,
            pinned,
            thumbMap
          );
          if (pinnedItems.length) {
            const secCollapsed = collapsedSecSet.has("pinned");
            const lbl = document.createElement("div");
            lbl.className = "wg-section-label wg-section-label-row wg-section-collapsible" + (secCollapsed ? " is-collapsed" : "");
            lbl.dataset.secCollapse = "pinned";
            lbl.title = secCollapsed ? "Click to expand Pinned" : "Click to collapse Pinned";
            lbl.innerHTML = `<span class="wg-sec-label-main"><span class="wg-folder-caret">${secCollapsed ? "\u25B8" : "\u25BE"}</span><span>★ Pinned</span></span><span class="wg-section-count">${pinnedItems.length}</span>`;
            pickerList.appendChild(lbl);
            if (!secCollapsed) appendItems(pickerList, pinnedItems, q);
          }
        } else if (secId === "recent") {
          const recentPaths = usageStore.libraryRecent(12).filter((p) => !pinned.has(p));
          const recentItems = sortLibraryItems(
            recentPaths.map((p) => byPath.get(p)).filter(Boolean),
            org,
            pinned,
            thumbMap
          );
          if (recentItems.length) {
            const secCollapsed = collapsedSecSet.has("recent");
            const lbl = document.createElement("div");
            lbl.className = "wg-section-label wg-section-label-row wg-section-collapsible" + (secCollapsed ? " is-collapsed" : "");
            lbl.dataset.secCollapse = "recent";
            lbl.title = secCollapsed ? "Click to expand Recent" : "Click to collapse Recent";
            lbl.innerHTML = `<span class="wg-sec-label-main"><span class="wg-folder-caret">${secCollapsed ? "\u25B8" : "\u25BE"}</span><span>↺ Recent</span></span><button type="button" class="wg-clear-recent" data-act="clearRecent" title="Clear recent list">Clear</button>`;
            pickerList.appendChild(lbl);
            if (!secCollapsed) appendItems(pickerList, recentItems, q);
          }
        } else if (secId === "categories") {
          renderCategoriesSection();
        }
      }
    } else {
      renderCategoriesSection();
    }

    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "wg-hint wg-lib-empty-state";
      const message = document.createElement("span");
      message.textContent = org.quickFilter ? `No ${org.quickFilter} entries match` : "No matching entries";
      empty.appendChild(message);
      if (q || org.quickFilter) {
        const resetFilters = document.createElement("button");
        resetFilters.type = "button";
        resetFilters.className = "wg-lib-empty-reset";
        resetFilters.dataset.act = "libResetFilters";
        resetFilters.textContent = q && org.quickFilter ? "Clear search & filter" : q ? "Clear search" : "Show all";
        empty.appendChild(resetFilters);
      }
      pickerList.appendChild(empty);
    }
    pickerList.scrollTop = Math.min(prevScrollTop, Math.max(0, pickerList.scrollHeight - pickerList.clientHeight));
    const quickFilterCounts = { all: libraryCache.length };
    for (const key of ["pinned", "thumbs", "recipes"]) {
      quickFilterCounts[key] = sortLibraryItems(libraryCache, { quickFilter: key }, pinned, thumbMap).length;
    }
    pickerDrawer.__ppLibraryDisplayBinding?.afterListRender?.({ counts: quickFilterCounts });
  }

  pickerDrawer.addEventListener("pp-library-organize-change", () => {
    renderPickerList(searchInput.value);
  });

  const quickFilterBtns = Array.from(pickerDrawer.querySelectorAll("[data-lib-quick-filter]"));
  quickFilterBtns.forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      const next = btn.dataset.libQuickFilter || "all";
      activeQuickFilter = activeQuickFilter === next && next !== "all" ? "all" : next;
      quickFilterBtns.forEach((candidate) => {
        const active = candidate.dataset.libQuickFilter === activeQuickFilter;
        candidate.classList.toggle("active", active);
        candidate.setAttribute("aria-pressed", String(active));
      });
      renderPickerList(searchInput.value);
    });
  });

  function resetLibraryFilters() {
    searchInput.value = "";
    searchCollapsedCats.clear();
    activeQuickFilter = "all";
    quickFilterBtns.forEach((candidate) => {
      const active = candidate.dataset.libQuickFilter === "all";
      candidate.classList.toggle("active", active);
      candidate.setAttribute("aria-pressed", String(active));
    });
    renderPickerList("");
    searchInput.focus({ preventScroll: true });
  }

  pickerDrawer.querySelector('[data-act="libExpandAll"]')?.addEventListener("click", (e) => {
    e.preventDefault();
    expandAllCategories();
  });
  pickerDrawer.querySelector('[data-act="libCollapseAll"]')?.addEventListener("click", (e) => {
    e.preventDefault();
    collapseAllCategories();
  });
  pickerDrawer.querySelector('[data-act="closePickerDrawer"]')?.addEventListener("click", (e) => {
    e.preventDefault();
    closePickerDrawer();
  });

  let searchDebounce = null;
  searchInput.addEventListener("input", () => {
    searchCollapsedCats.clear();
    cancelNodeTimer(node, searchDebounce);
    searchDebounce = scheduleNodeTimer(node, () => renderPickerList(searchInput.value), 60);
  });
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      if (!pickerRows().length) return;
      e.preventDefault();
      movePickerKbIndex(1);
    } else if (e.key === "ArrowUp") {
      if (!pickerRows().length) return;
      e.preventDefault();
      movePickerKbIndex(-1);
    } else if (e.key === "Enter") {
      const rows = pickerRows();
      if (pickerKbIndex < 0 || !rows[pickerKbIndex]) return;
      e.preventDefault();
      rows[pickerKbIndex].click();
    } else if (e.key === "Escape" && searchInput.value) {
      e.preventDefault();
      e.stopPropagation();
      searchInput.value = "";
      searchCollapsedCats.clear();
      renderPickerList("");
    }
  });

  const pickerResizeHandle = document.createElement("div");
  pickerResizeHandle.className = "wg-drawer-resize-handle wg-library-resize-handle";
  pickerResizeHandle.title = "Drag to resize Library · Double-click to reset";
  pickerResizeHandle.tabIndex = 0;
  pickerResizeHandle.setAttribute("role", "separator");
  pickerResizeHandle.setAttribute("aria-orientation", "vertical");
  pickerResizeHandle.setAttribute("aria-label", "Resize Library");
  pickerDrawer.appendChild(pickerResizeHandle);
  const libraryResize = bindLibraryResize({
    drawer: pickerDrawer, handle: pickerResizeHandle,
    load: () => readCombinatorialPreference("pickerWidth", null),
    save: width => writeCombinatorialPreference("pickerWidth", width),
  });

  function openPickerDrawer() {
    libraryFeatures?.setActive(true);
    pickerDrawer.hidden = false;
    pickerDrawer.removeAttribute("inert");
    pickerDrawer.setAttribute("aria-hidden", "false");
    pickerDrawer.classList.add("open");
    action("picker").classList.add("active");
    libraryResize.apply();
    pickerDrawer.__ppLibraryDisplayBinding?.refreshScrollbars?.();
  }
  function closePickerDrawer() {
    libraryFeatures?.setActive(false);
    libraryResize.finish();
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

  const cleanupLibraryViewControls = bindLibraryViewControls(pickerDrawer, {
    getView: () => pickerViewMode,
    setView: (mode) => {
      pickerViewMode = mode;
      savePickerView(mode);
      renderPickerList(searchInput.value);
    },
  });

  // The customize panel is portaled outside the drawer while open; retain the
  // authoritative view control instead of querying only the old DOM ancestry.
  const collectionViewSelect = pickerDrawer.querySelector("[data-library-view]");
  libraryFeatures = mountLibraryFeatures({ host: pickerDrawer.querySelector(".wg-drawer-inner"), settingsHost: pickerDrawer.querySelector("[data-library-customize-panel]") || pickerDrawer, node, getItems: () => libraryCache, getPinned: () => pinned, getThumbnails: () => thumbMap, onFilter: () => renderPickerList(searchInput.value), onView: view => { if(collectionViewSelect){collectionViewSelect.value=view==="gallery"?"grid":view;collectionViewSelect.dispatchEvent(new Event("change",{bubbles:true}));} }, onOpenEntry: (path, options) => powerTools.openEditForItem?.(path, options), content: [pickerList], restore: ({text,channel="positive"}) => reviewHistoryRestore(historyTargetEditor(node,textarea,channel),text,applyHistoryText,channel) });

  let libraryRequestVersion = 0;
  let libraryDisposed = false;
  async function refreshLibrary(data = null) {
    const requestVersion = ++libraryRequestVersion;
    hideTip(); previewCache.clear();
    let nextLibrary;
    try {
      nextLibrary = Array.isArray(data?.items) ? data.items : await API.list();
    } catch (error) {
      console.error("Prompt Palette: wildcard refresh failed", error);
      throw error;
    }
    if (libraryDisposed || requestVersion !== libraryRequestVersion || !nodeIsActive(node)) return false;
    let nextThumbMap = thumbMap;
    try {
      nextThumbMap = await API.categories();
    } catch (error) {
      console.error("Prompt Palette: thumbnail refresh failed", error);
    }
    if (libraryDisposed || requestVersion !== libraryRequestVersion || !nodeIsActive(node)) return false;
    libraryCache = nextLibrary;
    knownSet = new Set(nextLibrary.map((item) => item.path));
    lookupWildcard = createLibraryLookup(nextLibrary);
    thumbMap = nextThumbMap;
    recipeWorkspace?.refresh();
    render();
    renderPickerList(searchInput.value);
    return true;
  }
  function promptSaveSelectionAsList(start, end) {
    return saveEditorSelection(textarea, start, end, { list: true, hasPath: path => knownSet.has(path), onSaved: async path => { previewCache.delete(path); await refreshLibrary(); } });
  }
  textarea.__ppSaveSelectionAsList = promptSaveSelectionAsList;
  textarea.__ppExtractSelectionToWildcard = (start, end) => saveEditorSelection(textarea, start, end, {
    hasPath: path => knownSet.has(path), onSaved: async path => { previewCache.delete(path); await refreshLibrary(); },
  });
  node._wgRefreshLibrary = refreshLibrary;
  const cleanupLibrarySubscription = API.onLibraryChanged(refreshLibrary);

  action("refresh").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.classList.add("active");
    btn.disabled = true;
    try {
      const data = await API.refreshWildcards();
      await refreshLibrary(data);
      notify("success", "Wildcards refreshed", "");
    } catch (err) {
      notify("error", "Refresh failed", String(err));
    } finally {
      btn.classList.remove("active");
      btn.disabled = false;
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

  const commandTarget = registerPromptPaletteCommandTarget(node, {
    ...sidebarEditingHandlers({
      getEditor: () => recipeWorkspace?.editingSurface() || textarea,
      useLibraryEntry: insertWildcard,
      openLibraryItem: path => { searchInput.value = path; openPickerDrawer(); renderPickerList(path); },
    }),
    openLibrary: openPickerDrawer,
    focusEditor: () => { powerTools.closeAllPowerPopups(); closeSettings(); closePickerDrawer(); powerTools.showEditor(); recipeWorkspace?.showEditor(); textarea.focus({ preventScroll: true }); },
    openDoctor: powerTools.openDoctor,
    openVariations: powerTools.openVariations,
    openLibraryManager: powerTools.openLibraryManager,
    togglePreview: () => el("btnResolve").click(),
    toggleIo: () => root.querySelector('[data-act="ioRailToggle"]')?.click(),
  });
  root.addEventListener("pointerdown", commandTarget.activate, true);
  root.addEventListener("focusin", commandTarget.activate, true);

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

  const cleanupQueueSync = bindPromptQueueSync(node, () => {
    syncControlsFromWidgets();
    if (seedWidget) addSeedHistory(seedWidget.value);
    updateEstimate();
  });

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
      commandTarget.cleanup();
      root.removeEventListener("pointerdown", commandTarget.activate, true);
      root.removeEventListener("focusin", commandTarget.activate, true);
      cleanupImageImport();
      libraryFeatures?.cleanup();
      libraryDisposed = true; libraryRequestVersion++;
      cleanupLibrarySubscription();
      cleanupLibraryViewControls();
      visualCollections.cleanup();
      libraryDisplay.cleanup();
      if (node._wgRefreshLibrary === refreshLibrary) delete node._wgRefreshLibrary;
      hideTip(); previewCache.clear();
      cleanupQueueSync();
      cleanupSeedInput();
      refinementController.cleanup(); refinementUndo.cleanup();
      recipeWorkspace?.cleanup(); powerTools?.cleanup();
      if (node._ppRecipeWorkspace === recipeWorkspace) delete node._ppRecipeWorkspace;
      textarea.removeEventListener("input", noteRefinementInput); textarea.removeEventListener("keydown", undoRefinementKey, true);
      textarea.removeEventListener("compositionstart", holdRefinementComposition); textarea.removeEventListener("compositionend", releaseRefinementComposition);
      delete node._wgBeforeIoRailOpen;
      ioRail.cleanup();
      syntaxHighlighter.clear();
      textarea.removeEventListener("focus", repaintEditorHighlights);
      textarea.removeEventListener("blur", repaintEditorHighlights);
      editorSurface.cleanup();
      statusBar.cleanup();
      loraSidecar?.cleanup();
      cleanupEditorContext();
      cleanupPickerContext?.();
      delete textarea.__ppExtractSelectionToWildcard;
      delete textarea.__ppSaveSelectionAsList;
      cleanupAutocompleteBinding?.();
      unsubscribeTagColors();
      cleanupEditorHover();
      textarea.removeEventListener("scroll", syncHighlightScroll);
      hoverTip.remove();
      root.removeEventListener("keydown", handleWorkspaceEscape);
      document.removeEventListener("keydown", handleWorkspaceEscape);
      libraryResize.cleanup();
      clearNodeTimers(node);
      appearanceBinding.cleanup();
      settingsDrawer.unregister();
      cleanupSettingsDiscovery();
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
    if (node.__promptPaletteCombinatorialInitialized || node.__promptPaletteCombinatorialInitializing) return;

    const lifecycle = ensureNodeLifecycle(node);
    const hiddenWidget = node.widgets?.find((widget) => widget.name === "text");
    if (!hiddenWidget) {
      console.error("Prompt Palette: Combinatorial UI could not find the V3 text widget.");
      return;
    }

    hideNativeWidget((Object.assign(hiddenWidget, { __ppOwnerNode: node })));
    installPromptStateGuard(node, hiddenWidget);
    installPromptMetadataCapture(node);
    preparePromptBackingWidgets(node);
    node.resizable = true;
    Object.defineProperty(node, "__promptPaletteCombinatorialInitializing", { value: true, configurable: true });
    let built = null;
    try {
      await Promise.all([editorStylesReady, combinatorialStylesReady]);
      if (!nodeIsActive(node)) return;
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
      node._ppNodeGeometry?.mounted(container);

      node._wgRefreshFromHidden = refreshFromHidden;
      node._wgRefreshVisuals = refreshVisuals;
      node._wgReassertHiddenWidgets = reassertHiddenWidgets;
      node._wgReapplyTheme = reapplyTheme;
      node._wgRendererModeChanged = () => {
        node._ppNodeGeometry?.remount();
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
      livePromptPaletteNodes.delete(node);
      cleanupSocketRailLayout(node);
      delete node.__promptPaletteCombinatorialInitialized;
      console.error("Prompt Palette: Combinatorial UI initialization failed", error);
    } finally { delete node.__promptPaletteCombinatorialInitializing; }
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
