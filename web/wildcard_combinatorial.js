import { installSettingsDiscovery } from "./editor/settings_discovery.js";
import { sidebarEditingHandlers } from "./editor/sidebar_targets.js";
import { registerPromptPaletteCommandTarget } from "./prompt_palette_command_bus.js";
import { bindEditorWildcardHover } from "./editor/editor_hover.js";
import { historyShortcut } from "./editor/history_keys.js";
import { saveEditorSelection } from "./editor/selection_library.js";
import { attachEditorContextMenu } from "./editor/context_menu.js";
import { app } from "../../scripts/app.js";
import {
  loadExtensionStylesheet, svgIcon, copyPromptPaletteThemeScope, positionPromptPaletteTip,
  installPromptPaletteKeyboardBoundary, registerPromptPaletteSettingsDrawer, navigatePromptPaletteTabs,
} from "./prompt_palette_shared.js";
import { bindSuiteAppearance } from "./editor/suite_appearance.js";
import { applyToolbarVisibility } from "./editor/toolbar.js";
import { bindPromptSeedInput } from "./editor/text_utils.js";
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
import {
  API, loadTheme, escapeHtml, highlightMatch, categoryOf, hashStr,
  editorStylesReady,
  sanitizeHexColor, categoryColorFromHue, currentUiSurface,
  getBooruAutocompleteMatches, attachAutocomplete,
  loadPinned, savePinned, loadExpandedCats, saveExpandedCats, loadCatOrder, saveCatOrder,
  notify, livePromptPaletteNodes, cleanupSharedPromptPaletteDom,

  loadPickerView, savePickerView, openCtxMenu, closeCtxMenu, ctxMenuOpen,
  pickThumbnailFile, thumbnailFileError,

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
  const pickerViewToggleBtn = el("pickerViewToggle");
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
    if (node._wgIoRailOpen) ioRail.close();
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
      el("toggleImportImageBtn").checked = theme.showImportImageBtn !== false;
      if (!initial) render();
    },
  });

  el("toggleImportImageBtn").addEventListener("change", event => {
    saveTheme({ ...loadTheme(), showImportImageBtn: event.target.checked, layoutPreset: "custom" });
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
  function highlightText(text) {
    return renderPromptSyntax(syntaxCache.parse(text), {
      isKnown, categoryOf, buildCategoryColorMap, colorForToken, tagPainter: createTagPainter(theme),
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
  async function showTipForName(x, y, name, known) {
    const requestVersion = ++hoverRequestVersion;
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
  });
  recipeWorkspace = createRecipeWorkspaceController({
    node, root, textarea, render, flushHistory: () => refinementUndo.flush(), holdHistory: () => refinementUndo.hold(), releaseHistory: () => { refinementUndo.release(); refinementUndo.flush(); }, onUndo: performUndo, onRedo: performRedo,
    onShowEditor: powerTools.showEditor,
    host: el("variationPopup").querySelector(".wg-settings-body"), openHost: () => powerTools.openSelectionLab(),
    openVariations: scope => powerTools.openVariations(scope),
    bindHover: (editor, getRanges) => bindEditorWildcardHover({ node, editor, getRanges, show: showTipForName, hide: hideTip }),
    onLibrarySaved: async path => { previewCache.delete(path); await refreshLibrary(); },
    getMatches: getAcMatches, onCommit: item => { if (item?.kind === "booru" || item?.kind === "custom") usageStore.recordTag(item.value, item.kind, item.category); else if (item?.value && item.kind !== "syntax") usageStore.recordLibrary(item.value); },
    paintSyntax: highlightText, getSeed: () => seedWidget?.value ?? 0, getMode: () => "entire text as one",
    getLibrary: () => libraryCache, refreshLibrary,
  });
  node._ppRecipeWorkspace = recipeWorkspace;
  const syncHighlightScroll = () => { highlight.scrollTop = textarea.scrollTop; highlight.scrollLeft = textarea.scrollLeft; };
  textarea.addEventListener("scroll", syncHighlightScroll);

  const cleanupEditorContext = attachEditorContextMenu(textarea, {
    render, beforeOpen: () => { hideTip(); closeInjectMenu(); },
    promptTools: { node, apply: atomicEdit },
    syntaxEnabled: () => theme.syntaxInjectorEnabled !== false,
    tokenContext: (event, selection, handle) => {
      if (theme.syntaxInjectorEnabled === false) return false;
      const tok = tokenRanges.find(t => t.start <= selection.start && selection.start < t.end);
      if (!tok) return false;
      handle(); closeCtxMenu(); textarea.setSelectionRange(tok.start, tok.end);
      openInjectMenuAtPoint(event.clientX, event.clientY, tok.name, textarea, render, { start: tok.start, end: tok.end });
      return true;
    },
    syntaxAction: (event, selection) => {
      if (theme.syntaxInjectorEnabled === false) return;
      openInjectMenuAtPoint(event.clientX, event.clientY, "", textarea, render, selection.start === selection.end ? null : selection);
    },
  });

  function insertWildcard(path) {
    if (node._ppInsertAdjustableRecipe?.(path)) return;
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
        { label: "Copy path", icon: "path", group: "item", onSelect: () => { navigator.clipboard.writeText(`__${item.path}__`).catch(() => {}); } },
        {
          label: nowPinned ? "Unpin" : "Pin", icon: "pin", group: "item",
          onSelect: () => {
            if (pinned.has(item.path)) pinned.delete(item.path); else pinned.add(item.path);
            savePinned(pinned);
            renderPickerList(searchInput.value);
          },
        },
        { label: hasThumb ? "Change Thumbnail\u2026" : "Set Thumbnail\u2026", icon: "image", group: "thumb", onSelect: () => setThumbnailForItem(item.path) },
        ...(hasThumb ? [{ label: "Remove Thumbnail", icon: "trash", group: "thumb", danger: true, onSelect: () => removeThumbnailForItem(item.path) }] : []),
        { label: `Jump to "${cat}"`, icon: "jump", group: "nav", onSelect: () => jumpToCategory(cat) },
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
        { label: "Copy path", icon: "path", group: "item", onSelect: () => { navigator.clipboard.writeText(`__${item.path}__`).catch(() => {}); } },
        {
          label: nowPinned ? "Unpin" : "Pin", icon: "pin", group: "item",
          onSelect: () => {
            if (pinned.has(item.path)) pinned.delete(item.path); else pinned.add(item.path);
            savePinned(pinned);
            renderPickerList(searchInput.value);
          },
        },
        { label: hasThumb ? "Change Thumbnail\u2026" : "Set Thumbnail\u2026", icon: "image", group: "thumb", onSelect: () => setThumbnailForItem(item.path) },
        ...(hasThumb ? [{ label: "Remove Thumbnail", icon: "trash", group: "thumb", danger: true, onSelect: () => removeThumbnailForItem(item.path) }] : []),
        { label: `Jump to "${cat}"`, icon: "jump", group: "nav", onSelect: () => jumpToCategory(cat) },
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
      libraryDisposed = true; libraryRequestVersion++;
      cleanupLibrarySubscription();
      if (node._wgRefreshLibrary === refreshLibrary) delete node._wgRefreshLibrary;
      hideTip(); previewCache.clear();
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
      cleanupEditorContext();
      delete textarea.__ppExtractSelectionToWildcard;
      delete textarea.__ppSaveSelectionAsList;
      cleanupAutocompleteBinding?.();
      unsubscribeTagColors();
      cleanupEditorHover();
      textarea.removeEventListener("scroll", syncHighlightScroll);
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
