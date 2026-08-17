import { readEditorPreference, getPowerToolPreferences, getWorkspacePreferences, setWorkspacePreference, replacePowerToolPreferences } from "../prompt_palette_state.js";
import { buildResolvedDiff } from "../prompt_palette_power_tools.js";
import { registerPromptPaletteCommandTarget } from "../prompt_palette_command_bus.js";
import { API } from "../prompt_palette_api.js";
import { createPromptUsageStore, createPromptHistoryStore, closestPromptEntries } from "../prompt_quickness.js";
import { installPromptPaletteKeyboardBoundary } from "../prompt_palette_shared.js";
import {
  hideNativeWidget, installPromptStateGuard, nodeIsActive, scheduleNodeTimer, cancelNodeTimer, clearNodeTimers,
  ioEnabled, syncIoSocket, migrateIoState, canonicalizeOutputs, setupIoRail, installSocketRailLayout,
} from "../prompt_palette_compat.js";
import { dialogConfirm, isDialogOpen, cleanupDialogOverlays } from "./dialogs.js";
import { loadTheme, loadPinned, loadExpandedCats, loadCatOrder, loadPickerView } from "./preferences.js";
import { hashStr, categoryOf, escapeHtml, currentUiSurface, categoryColorFromHue } from "./text_utils.js";
import { getCaretCoords, closeAcMenu, acState, cleanupAutocomplete } from "./autocomplete.js";
import { runTextareaEditCommand, openInjectMenuAtPoint, closeInjectMenu, injectState, cleanupInjector } from "./injector.js";
import { openCtxMenu, closeCtxMenu, ctxMenuOpen, cleanupContextMenu } from "./context_menu.js";
import { cleanupThumbnailPicker } from "./thumbnails.js";
import { createEditorShell } from "./shell.js";
import { createPowerToolsController } from "./power_tools_controller.js";
import { createThemeController } from "./theme_controller.js";
import { createUtilityController } from "./utility_controller.js";
import { createWorkspaceController, syncWorkspaceSettingsSurface } from "./workspace_controller.js";
import { createLibraryController } from "./library_controller.js";
import { PromptSyntaxCache, renderPromptSyntax } from "./prompt_parser.js";
import { createPerformanceRuntime } from "./performance_runtime.js";
import { createPerformanceDiagnosticsController } from "./performance_diagnostics_controller.js";
import { notify } from "./notifications.js";
import { createReactiveRuntime } from "../runtime/reactive_runtime.js";
import { WildcardWorkerClient } from "../engine/wildcard_worker_client.js";
import { EditorUndoManager } from "./undo_manager.js";
import { PromptLibraryModel } from "../library/library_model.js";
import { upgradeEditorSurface } from "./editor_surface.js";
import { createSyntaxHighlighter } from "./syntax_highlighter.js";

function buildWildcardWidget(node, hiddenWidget) {
  const promptState = installPromptStateGuard(node, hiddenWidget);
  const theme = loadTheme();
  let powerTools = getPowerToolPreferences();
  let workspacePrefs = getWorkspacePreferences();
  const pinned = loadPinned();
  const expandedCats = loadExpandedCats();
  let catOrder = loadCatOrder();
  const usageStore = createPromptUsageStore();
  const historyStore = createPromptHistoryStore({ limit: 40 });
  let recentList = usageStore.libraryRecent(12);
  let knownSet = new Set();
  let knownLeafSet = new Set();
  let libraryCache = [];
  const libraryModel = new PromptLibraryModel();
  let thumbMap = {};
  let thumbBust = {};
  let pickerViewMode = loadPickerView();
  let tokenRanges = [];
  let lastLegendSignature = "";
  const previewCache = new Map();
  let lastExecutionMetadata = node.properties?.prompt_palette_last_result || null;
  let starterAutocompleteRows = [];

  let recipeSelectMode = false;
  let recipeSelection = new Set();
  let starterSaveSuggestion = "";

  const STASH_LIMIT = 20;
  function loadStash() {
    const value = readEditorPreference("stash", []);
    return Array.isArray(value) ? value : [];
  }
  let stash = loadStash();


  const root = createEditorShell();
  const cleanupKeyboardBoundary = installPromptPaletteKeyboardBoundary(root);
  const performanceRuntime = createPerformanceRuntime({ node, root });
  const profiler = performanceRuntime.profiler;
  const reactiveRuntime = createReactiveRuntime({ node, profiler, visualActive: performanceRuntime.visualActive });
  const workerClient = new WildcardWorkerClient();
  function installLibraryRevision(value) {
    libraryCache = Array.isArray(value) ? value : [];
    const searchMode = "token";
    profiler.measure("library.index", () => libraryModel.rebuild(libraryCache, { buildSearchIndex: searchMode }));
    workerClient.setLibrary(libraryCache);
    return libraryCache;
  }
  const syntaxCache = new PromptSyntaxCache();
  let lastParsedPrompt = syntaxCache.parse("");
  let detachedSettingsPopup = null;
  const el = sel => root.querySelector(`[data-el="${sel}"]`) || detachedSettingsPopup?.querySelector(`[data-el="${sel}"]`);
  const originalTextarea = el("textarea");
  const editorSurface = upgradeEditorSurface(originalTextarea);
  const textarea = editorSurface.element;
  const highlight = el("highlight");
  const syntaxHighlighter = createSyntaxHighlighter(textarea, highlight);
  const legend = el("legend");
  const pickerDrawer = root.querySelector('[data-drawer="picker"]');
  const libraryTabs = Array.from(root.querySelectorAll("[data-library-tab]"));
  const libraryPanels = Array.from(root.querySelectorAll("[data-library-panel]"));
  const libraryDensityButtons = Array.from(root.querySelectorAll("[data-library-density]"));
  const libraryResizeHandle = el("libraryResizeHandle");
  const editDrawer = root.querySelector('[data-drawer="edit"]');
  const settingsPopup = el("settingsPopup");
  detachedSettingsPopup = settingsPopup;
  const stashPopup = el("stashPopup");
  const stashList = el("stashList");
  const historyList = el("historyList");
  const stashTabs = Array.from(stashPopup.querySelectorAll("[data-stash-tab]"));
  const stashPanels = Array.from(stashPopup.querySelectorAll("[data-stash-panel]"));
  const recipeSelectToggle = el("recipeSelectToggle");
  const recipeBar = el("recipeBar");
  const recipeBarCount = el("recipeBarCount");
  const editorReal = el("editorReal");
  const resolvedView = el("resolvedView");
  const previewStatus = el("previewStatus");
  const hintRight = el("hintRight");
  const tokenCountEl = el("tokenCount");
  const seedInput = el("seedInput");
  const seedModeSelect = el("seedModeSelect");
  const processingModeSelect = el("processingModeSelect");
  const previewModeSelect = el("previewModeSelect");
  const btnVariations = el("btnVariations");
  const btnResolve = el("btnResolve");
  const libraryManagerBtn = el("libraryManagerBtn");
  const doctorChip = el("doctorChip");
  const doctorLabel = el("doctorLabel");
  const doctorPopup = el("doctorPopup");
  const doctorSummary = el("doctorSummary");
  const doctorList = el("doctorList");
  const variationPopup = el("variationPopup");
  const variationCount = el("variationCount");
  const variationStatus = el("variationStatus");
  const variationList = el("variationList");
  const libraryManagerPopup = el("libraryManagerPopup");
  const libraryHealthSummary = el("libraryHealthSummary");
  const libraryHealthList = el("libraryHealthList");
  const libraryManagerSearch = el("libraryManagerSearch");
  const libraryManagerEntries = el("libraryManagerEntries");
  const libraryManagerSelectedCount = el("libraryManagerSelectedCount");
  const recipeBuilderPopup = el("recipeBuilderPopup");
  const recipeBuilderName = el("recipeBuilderName");
  const recipeBuilderOperator = el("recipeBuilderOperator");
  const recipeBuilderSeparator = el("recipeBuilderSeparator");
  const recipeBuilderPrefix = el("recipeBuilderPrefix");
  const recipeBuilderSuffix = el("recipeBuilderSuffix");
  const recipeBuilderList = el("recipeBuilderList");
  const recipeBuilderPreview = el("recipeBuilderPreview");
  const recipeBuilderStatus = el("recipeBuilderStatus");
  const performanceDiagnosticsToggle = el("togglePerformanceDiagnostics");
  const performanceDiagnosticsPanel = el("performanceDiagnosticsPanel");
  const performanceDiagnosticsReadout = el("performanceDiagnosticsReadout");
  let lastTokenStats = null;
  let lastTokenStatsSource = "";
  let resolvedRequestId = 0;
  let powerToolsController = null;
  let themeController = null;
  let utilityController = null;
  let workspaceController = null;
  let libraryController = null;
  const powerPopupEntries = [doctorPopup, variationPopup, libraryManagerPopup, recipeBuilderPopup];

  function closeAllPowerPopups(...args) { return powerToolsController?.closeAllPowerPopups(...args); }
  function updateDoctorStatus(...args) { return powerToolsController?.updateDoctorStatus(...args); }
  function openDoctor(...args) { return powerToolsController?.openDoctor(...args); }
  function openVariations(...args) { return powerToolsController?.openVariations(...args); }
  function openLibraryManager(...args) { return powerToolsController?.openLibraryManager(...args); }
  function applyPowerToolSettings(...args) { return powerToolsController?.applyPowerToolSettings(...args); }
  function syncPowerToolSettingsUI(...args) { return powerToolsController?.syncPowerToolSettingsUI(...args); }
  async function promptSaveRecipe(...args) { return await powerToolsController?.promptSaveRecipe(...args); }
  function renderCatPins(...args) { return themeController?.renderCatPins(...args); }
  function updateThemeJson(...args) { return themeController?.updateThemeJson(...args); }
  function openSettings(...args) { return utilityController?.openSettings(...args); }
  function closeSettings(...args) { return utilityController?.closeSettings(...args); }
  function openStash(...args) { return utilityController?.openStash(...args); }
  function closeStash(...args) { return utilityController?.closeStash(...args); }
  function renderHistoryList(...args) { return utilityController?.renderHistoryList(...args); }
  function openLibraryWorkspace(...args) { return workspaceController?.openLibraryWorkspace(...args); }
  function refreshLibrary(...args) { return libraryController?.refreshLibrary(...args); }
  function renderPickerList(...args) { return libraryController?.renderPickerList(...args); }
  function hideTip(...args) { return libraryController?.hideTip(...args); }
  function promptExtractSelectionToWildcard(...args) { return libraryController?.promptExtractSelectionToWildcard(...args); }
  function openEditForItem(...args) { return libraryController?.openEditForItem(...args); }
  function closeEditDrawer(...args) { return libraryController?.closeEditDrawer(...args); }
  function openPickerDrawer(...args) { return libraryController?.openPickerDrawer(...args); }
  function closePickerDrawer(...args) { return libraryController?.closePickerDrawer(...args); }
  function activateLibraryTab(...args) { return libraryController?.activateLibraryTab(...args); }
  function prepareStarterPacks(...args) { return libraryController?.prepareStarterPacks(...args); }

  workspaceController = createWorkspaceController({
    node, pickerDrawer, editDrawer, settingsPopup, stashPopup, doctorPopup, variationPopup, libraryManagerPopup, recipeBuilderPopup,
    libraryDensityButtons, libraryResizeHandle,
  });

  const seedWidget = node.widgets.find(w => w.name === "seed");
  const controlWidget =
    (seedWidget && seedWidget.linkedWidgets && seedWidget.linkedWidgets[0]) ||
    node.widgets.find(w => w !== seedWidget && /control.*generate/i.test(w.name || ""));
  const modeWidget = node.widgets.find(w => w.name === "processing_mode");
  [seedWidget, controlWidget, modeWidget].forEach(hideNativeWidget);

  function reassertHiddenWidgets() {
    hideNativeWidget(hiddenWidget);
    [seedWidget, controlWidget, modeWidget].forEach(hideNativeWidget);
  }
  if (modeWidget) {
    processingModeSelect.addEventListener("change", () => {
      modeWidget.value = processingModeSelect.value;
      if (typeof modeWidget.callback === "function") modeWidget.callback(modeWidget.value, node.graph?.canvas, node);
      node.graph?.setDirtyCanvas(true, true);
      if (resolvedView.classList.contains("on")) reactiveRuntime.invalidate("preview", { reason: "processing-mode" });
    });
  } else {
    processingModeSelect.disabled = true;
  }

  const SEED_MODE_LABELS = {
    fixed: "Fixed \u2014 lock this prompt's seed",
    increment: "Increment \u2014 +1 each run",
    decrement: "Decrement \u2014 \u22121 each run",
    randomize: "Randomize \u2014 new seed each run",
  };
  function syncSeedControlsFromWidgets() {
    if (seedWidget) seedInput.value = seedWidget.value;
    if (controlWidget) {
      const values = (controlWidget.options && controlWidget.options.values) || ["fixed", "increment", "decrement", "randomize"];
      if (seedModeSelect.dataset.built !== "1") {
        seedModeSelect.innerHTML = values.map(v => `<option value="${escapeHtml(v)}">${escapeHtml(SEED_MODE_LABELS[v] || v)}</option>`).join("");
        seedModeSelect.dataset.built = "1";
      }
      seedModeSelect.value = controlWidget.value;
    } else {
      seedModeSelect.style.display = "none";
    }
    if (modeWidget) processingModeSelect.value = modeWidget.value;
  }
  if (seedWidget) {
    seedInput.addEventListener("input", () => {
      if (seedInput.value === "") return;
      seedWidget.value = Number(seedInput.value);
      if (typeof seedWidget.callback === "function") seedWidget.callback(seedWidget.value, node.graph?.canvas, node);
      node.graph?.setDirtyCanvas(true, true);
      reactiveRuntime.invalidate("seed", { value: seedWidget.value });
    });
  } else {
    el("seedbar").querySelectorAll("input,button,select").forEach(x => x.disabled = true);
  }
  if (controlWidget) {
    seedModeSelect.addEventListener("change", () => {
      controlWidget.value = seedModeSelect.value;
      if (typeof controlWidget.callback === "function") controlWidget.callback(controlWidget.value, node.graph?.canvas, node);
      node.graph?.setDirtyCanvas(true, true);
    });
  }
  root.querySelector('[data-act="seedRandomizeNow"]').addEventListener("click", () => {
    if (!seedWidget) return;
    const maxSeed = Number.MAX_SAFE_INTEGER;
    const randomSeed = Math.floor(Math.random() * maxSeed);
    seedWidget.value = randomSeed;
    seedInput.value = randomSeed;
    if (typeof seedWidget.callback === "function") seedWidget.callback(randomSeed, node.graph?.canvas, node);
    node.graph?.setDirtyCanvas(true, true);
    reactiveRuntime.invalidate("seed", { value: randomSeed });
  });
  syncSeedControlsFromWidgets();

  const IO_INPUT_DEFS = [
    { key: "clip", type: "CLIP", label: "CLIP", desc: "Connect to turn this node into a live encoder \u2014 the resolved prompt and negative prompt get encoded into CONDITIONING via this CLIP instead of only being returned as text." },
    { key: "model", type: "MODEL", label: "Model", desc: "Connect alongside CLIP to enable <lora:name:weight> tags, typed directly or hidden inside a wildcard file's entry. Any found are loaded, applied to the model/clip, and stripped out of the text before it's encoded. Without a MODEL connected, LoRA tags are left as literal text." },
    { key: "prompt_prefix", type: "STRING", label: "Prompt prefix", desc: "Prepend externally-supplied text (resolved for wildcards too) before this node's own prompt \u2014 e.g. a shared style-preset text node." },
    { key: "prompt_suffix", type: "STRING", label: "Prompt suffix", desc: "Append externally-supplied text (resolved for wildcards too) after this node's own prompt." },
    { key: "enhancer_override", type: "STRING", label: "LLM / enhancer override", desc: "If connected and non-empty, this completely replaces the resolved prompt output \u2014 wire in an LLM prompt-enhancer node here." },
    { key: "external_seed", type: "INT", label: "External seed", desc: "Drive wildcard resolution from another node's seed instead of this node's own Seed control above." },
    { key: "negative_text", type: "STRING", label: "Negative prompt (text)", desc: "A second wildcard-aware text block, resolved independently and returned as its own negative_prompt output." },
    { key: "negative_prefix", type: "STRING", label: "Negative prefix", desc: "Prepend externally-supplied text (resolved for wildcards too) before the negative prompt \u2014 mirrors Prompt prefix but for the negative side." },
    { key: "negative_suffix", type: "STRING", label: "Negative suffix", desc: "Append externally-supplied text (resolved for wildcards too) after the negative prompt \u2014 mirrors Prompt suffix but for the negative side." },
  ];
  const IO_OUTPUT_DEFS = [
    { key: "model", slotIndex: 0, type: "MODEL", label: "Model (passthrough)", desc: "The connected Model, passed through — patched with any LoRAs pulled from <lora:...> tags this run if CLIP was also connected, otherwise unchanged. None if no Model is connected." },
    { key: "clip", slotIndex: 1, type: "CLIP", label: "CLIP (passthrough)", desc: "The connected CLIP, passed through — patched alongside Model above if LoRAs were applied, otherwise unchanged. None if no CLIP is connected." },
    { key: "conditioning", slotIndex: 2, type: "CONDITIONING", label: "Conditioning", desc: "The resolved prompt encoded via the connected CLIP. None unless a CLIP input is connected." },
    { key: "negative_conditioning", slotIndex: 3, type: "CONDITIONING", label: "Negative conditioning", desc: "The resolved negative prompt encoded via the connected CLIP. None unless a CLIP input is connected." },

    { key: "prompt", slotIndex: 4, type: "STRING", label: "Prompt", default: true, desc: "The final resolved prompt text (or the enhancer override, if that was used)." },
    { key: "negative_prompt", slotIndex: 5, type: "STRING", label: "Negative prompt", desc: "Resolved text from the Negative prompt input above." },
    { key: "seed_out", slotIndex: 6, type: "INT", label: "Seed used", desc: "The seed actually used to resolve this run — feed straight into a sampler's seed input." },
    { key: "wildcards_used", slotIndex: 7, type: "STRING", label: "Wildcards used (JSON)", desc: "A JSON list of every wildcard file name that got picked this run, for logging/debugging." },
    { key: "raw_text", slotIndex: 8, type: "STRING", label: "Raw text (unresolved)", desc: "Exactly what is typed into this node before wildcard resolution." },
    { key: "wildcards_used_count", slotIndex: 9, type: "INT", label: "Wildcards used (count)", desc: "How many distinct wildcard files were picked this run." },
    { key: "used_enhancer", slotIndex: 10, type: "BOOLEAN", label: "Used enhancer override", desc: "True if the enhancer override replaced the wildcard-resolved prompt." },
    { key: "clip_token_count", slotIndex: 11, type: "INT", label: "CLIP token count", default: true, desc: "Real CLIP-L token count of the prompt output. -1 if the tokenizer is unavailable." },
    { key: "prompt_metadata_json", slotIndex: 12, type: "STRING", label: "Prompt metadata (JSON)", default: false, desc: "Final and source prompts plus seed, wildcard, LoRA, and execution metadata for asset tools." },
  ];

  node.properties = node.properties || {};
  node.properties.wg_io = node.properties.wg_io || { inputs: {}, outputs: {} };

  const ioRail = setupIoRail(node, root, IO_INPUT_DEFS, IO_OUTPUT_DEFS);

  scheduleNodeTimer(node, () => {

    canonicalizeOutputs(node, IO_OUTPUT_DEFS);
    migrateIoState(node, "input", IO_INPUT_DEFS);
    migrateIoState(node, "output", IO_OUTPUT_DEFS);
    IO_INPUT_DEFS.forEach(def => syncIoSocket(node, "input", def, ioEnabled(node, "input", def)));
    IO_OUTPUT_DEFS.forEach(def => syncIoSocket(node, "output", def, ioEnabled(node, "output", def)));
    ioRail.render();
  }, 0);

  node._wgRefreshIoToggles = function () {
    canonicalizeOutputs(node, IO_OUTPUT_DEFS);
    migrateIoState(node, "input", IO_INPUT_DEFS);
    migrateIoState(node, "output", IO_OUTPUT_DEFS);
    IO_INPUT_DEFS.forEach(def => syncIoSocket(node, "input", def, ioEnabled(node, "input", def)));
    IO_OUTPUT_DEFS.forEach(def => syncIoSocket(node, "output", def, ioEnabled(node, "output", def)));
    ioRail.render();
  };

  let hoverTip = document.querySelector('.wg-tip[data-prompt-palette-global="true"]');
  if (!hoverTip) {
    hoverTip = document.createElement("div");
    hoverTip.className = "wg-tip";
    hoverTip.dataset.promptPaletteGlobal = "true";
    document.body.appendChild(hoverTip);
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
    return categoryColorFromHue(hue, theme.saturation, currentUiSurface(), shadeShift);
  }
  function rebuildKnownLeafSet() {
    knownLeafSet = new Set(Array.from(knownSet, (name) => String(name).split("/").pop()));
    syntaxCache.clear();
    profiler.gauge("libraryEntries", knownSet.size);
  }
  function isKnown(name) {
    const value = String(name || "");
    return knownSet.has(value) || knownLeafSet.has(value.split("/").pop());
  }
  function highlightText(text, parsedOverride = null) {
    const parsed = parsedOverride || profiler.measure("editor.parse", () => syntaxCache.parse(text));
    lastParsedPrompt = parsed;
    const result = profiler.measure("editor.highlight", () => renderPromptSyntax(parsed, {
      isKnown,
      categoryOf,
      buildCategoryColorMap,
      colorForToken,
    }));
    tokenRanges = result.ranges;
    profiler.gauge("parserCacheLines", syntaxCache.stats().cachedLines);
    return result;
  }

  function syncHiddenWidget() {
    if (promptState.current() !== textarea.value || promptState.isEstablished()) {
      promptState.commit(textarea.value);
    }
  }

  const undoManager = new EditorUndoManager({
    initialValue: textarea.value,
    limit: 100,
    coalesceMs: 600,
    schedule: (fn, ms) => scheduleNodeTimer(node, fn, ms),
    cancel: (handle) => cancelNodeTimer(node, handle),
    onState: () => updateUndoRedoButtons(),
  });

  function refreshFromHidden() {
    const restored = promptState.restore();
    if (restored !== textarea.value) {
      textarea.value = restored;
      undoManager.reset(restored);
      render();
    }
    syncSeedControlsFromWidgets();
  }

  function flushUndoBurst() { return undoManager.flush(); }

  function noteValueChange() {
    const changed = undoManager.note(textarea.value);
    if (!changed) return;
    lastTokenStats = null;
    lastTokenStatsSource = "";
  }

  function updateUndoRedoButtons() {
    if (undoBtn) undoBtn.disabled = !undoManager.canUndo();
    if (redoBtn) redoBtn.disabled = !undoManager.canRedo();
  }

  function performUndo() {
    const prev = undoManager.undo(textarea.value);
    if (prev === null) return;
    textarea.value = prev;
    textarea.selectionStart = textarea.selectionEnd = prev.length;
    textarea.focus();
    render();
    scheduleHistorySnapshot("Undo");
  }

  function performRedo() {
    const next = undoManager.redo(textarea.value);
    if (next === null) return;
    textarea.value = next;
    textarea.selectionStart = textarea.selectionEnd = next.length;
    textarea.focus();
    render();
    scheduleHistorySnapshot("Redo");
  }

  let historySnapshotTimer = null;
  let lastHistorySource = "";
  const HISTORY_IDLE_MS = 900;

  function addHistorySnapshot({ source = textarea.value, resolved = "", seed = null, reason = "Edited prompt", pinned = false, force = false } = {}) {
    cancelNodeTimer(node, historySnapshotTimer);
    historySnapshotTimer = null;
    const sourceText = String(source ?? "");
    const resolvedText = String(resolved ?? "");
    if (!sourceText.trim() && !resolvedText.trim()) return null;
    if (!force && sourceText === lastHistorySource && !resolvedText) return null;
    const entry = historyStore.add({ source: sourceText, resolved: resolvedText, seed, reason, pinned });
    if (entry) lastHistorySource = sourceText;
    if (stashPopup.classList.contains("open") && stashPopup.querySelector('[data-stash-panel="history"]')?.classList.contains("active")) {
      renderHistoryList();
    }
    return entry;
  }

  function scheduleHistorySnapshot(reason = "Edited prompt") {
    if (theme.promptHistoryEnabled === false) return;
    cancelNodeTimer(node, historySnapshotTimer);
    historySnapshotTimer = scheduleNodeTimer(node, () => {
      historySnapshotTimer = null;
      addHistorySnapshot({ reason });
    }, HISTORY_IDLE_MS);
  }

  function syncHighlightDom(lineHtml, sourceText) {
    const lines = Array.isArray(lineHtml) && lineHtml.length ? lineHtml : [""];
    let spans = highlight._ppLineSpans;
    if (!Array.isArray(spans) || spans.length !== lines.length || spans.some((span) => !span?.isConnected)) {
      const fragment = document.createDocumentFragment();
      spans = lines.map((html, index) => {
        const span = document.createElement("span");
        span.className = "wg-highlight-line";
        span.innerHTML = html;
        fragment.appendChild(span);
        if (index < lines.length - 1) fragment.appendChild(document.createTextNode("\n"));
        return span;
      });
      if (sourceText.endsWith("\n")) fragment.appendChild(document.createTextNode("\n"));
      highlight.replaceChildren(fragment);
      highlight._ppLineSpans = spans;
      highlight._ppTrailingNewline = sourceText.endsWith("\n");
      return;
    }
    for (let index = 0; index < lines.length; index++) {
      if (spans[index].innerHTML !== lines[index]) spans[index].innerHTML = lines[index];
    }
    const wantsTrailing = sourceText.endsWith("\n");
    if (highlight._ppTrailingNewline !== wantsTrailing) {
      if (wantsTrailing) highlight.appendChild(document.createTextNode("\n"));
      else if (highlight.lastChild?.nodeType === 3 && highlight.lastChild.textContent === "\n") highlight.lastChild.remove();
      highlight._ppTrailingNewline = wantsTrailing;
    }
  }

  function renderVisualsFromParsed(parsedOverride = null, sourceText = textarea.value) {
    let names = [], categoriesInUse = [], categoryHueMap = {};
    try {
      const result = highlightText(sourceText, parsedOverride);
      names = result.names;
      categoriesInUse = result.categoriesInUse;
      categoryHueMap = result.categoryHueMap;
      profiler.measure("editor.dom", () => {
        if (!syntaxHighlighter.render(result.decorations, sourceText)) syncHighlightDom(result.lineHtml, sourceText);
      });
    } catch (e) {
      console.error("Prompt Palette: highlighting failed", e);
      syntaxHighlighter.reset();
      highlight._ppLineSpans = null;
      highlight.style.display = "";
      highlight.replaceChildren(document.createTextNode(sourceText + (sourceText.endsWith("\n") ? "\n" : "")));
    }

    profiler.measure("editor.legend", () => {
      const legendItems = categoriesInUse.map((cat) => [cat, theme.categoryPins[cat] || categoryColorFromHue(categoryHueMap[cat], theme.saturation)]);
      const signature = legendItems.map(([cat, color]) => `${cat}:${color}`).join("|");
      if (signature === lastLegendSignature) return;
      lastLegendSignature = signature;
      const fragment = document.createDocumentFragment();
      legendItems.forEach(([cat, color]) => {
        const chip = document.createElement("div");
        chip.className = "wg-chip";
        chip.innerHTML = `<span class="wg-sw" style="background:${color}; border-radius:50%;"></span>${escapeHtml(cat)}`;
        fragment.appendChild(chip);
      });
      legend.replaceChildren(fragment);
    });

    const knownCount = names.reduce((count, name) => count + (isKnown(name) ? 1 : 0), 0);
    const missingCount = names.length - knownCount;
    const hintText = `${knownCount} resolved-ready · ${missingCount} missing`;
    if (hintRight.textContent !== hintText) hintRight.textContent = hintText;
    const hintClickable = missingCount > 0;
    if (hintRight.classList.contains("wg-hint-clickable") !== hintClickable) hintRight.classList.toggle("wg-hint-clickable", hintClickable);
    const hintTitle = hintClickable ? "Click to repair the next missing wildcard" : "";
    if (hintRight.title !== hintTitle) hintRight.title = hintTitle;
    const len = sourceText.length;
    const charText = `${len.toLocaleString()} char${len === 1 ? "" : "s"}`;
    const charCount = el("charCount");
    if (charCount.textContent !== charText) charCount.textContent = charText;
    updateUndoRedoButtons();
    profiler.count("editorRenders");
    if (profiler.enabled) profiler.gauge("domNodes", root.querySelectorAll("*").length);
  }


  let workerParseVersion = 0;
  function renderVisuals() {
    const source = textarea.value;
    if (!workerClient.shouldUseForPrompt(source)) {
      workerParseVersion += 1;
      performanceRuntime.cancelTimer("worker-editor-parse");
      return renderVisualsFromParsed(null, source);
    }
    const requestVersion = ++workerParseVersion;
    const charCount = el("charCount");
    const charText = `${source.length.toLocaleString()} char${source.length === 1 ? "" : "s"}`;
    if (charCount?.textContent !== charText) charCount.textContent = charText;
    updateUndoRedoButtons();
    performanceRuntime.debounce("worker-editor-parse", 24, () => {
      workerClient.parse(source).then((parsed) => {
        if (requestVersion !== workerParseVersion || textarea.value !== source || !performanceRuntime.visualActive()) return;
        profiler.count("workerParses");
        renderVisualsFromParsed(parsed, source);
      }).catch(() => {
        if (requestVersion !== workerParseVersion || textarea.value !== source || !performanceRuntime.visualActive()) return;
        renderVisualsFromParsed(null, source);
      });
    }, { visual: true });
  }

  function scheduleDoctorCheck() {
    if (!powerTools.promptDoctor) return performanceRuntime.cancelTimer("doctor");
    performanceRuntime.debounce("doctor", 320, () => updateDoctorStatus(), { visual: true });
  }

  function scheduleResolvedPreview({ force = false } = {}) {
    if (!resolvedView.classList.contains("on")) {
      performanceRuntime.cancelTimer("preview");
      performanceRuntime.abortRequest("preview");
      return;
    }
    const mode = workspacePrefs.previewMode || "afterPause";
    if (!force && mode === "manual") {
      performanceRuntime.cancelTimer("preview");
      performanceRuntime.abortRequest("preview");
      return;
    }
    performanceRuntime.abortRequest("preview");
    const delay = force ? 0 : mode === "live" ? 70 : 260;
    performanceRuntime.debounce("preview", delay, () => refreshResolvedView(), { visual: true });
  }

  reactiveRuntime.subscribe("prompt", () => renderVisuals(), { key: "prompt-overlay", schedule: "frame", visual: true });
  reactiveRuntime.subscribe("theme", () => renderVisualsFromParsed(lastParsedPrompt, textarea.value), { key: "theme-projection", schedule: "frame", visual: true });
  reactiveRuntime.subscribe("library", () => {
    libraryController?.renderPickerList?.(libraryController.searchInput?.value || "");
    renderCatPins();
    renderVisualsFromParsed(lastParsedPrompt, textarea.value);
  }, { key: "library-projection", schedule: "frame", visual: true });
  reactiveRuntime.subscribe("doctor", () => scheduleDoctorCheck(), { key: "doctor-schedule", schedule: "microtask", visual: true });
  reactiveRuntime.subscribe(["preview", "seed"], () => scheduleResolvedPreview(), { key: "preview-schedule", schedule: "microtask", visual: true });
  reactiveRuntime.subscribe(["socket", "layout"], () => node._ppRendererAdapter?.requestLayout?.(), { key: "renderer-layout", schedule: "frame", visual: true });
  node._ppInvalidateRuntime = (channel, payload = null) => reactiveRuntime.invalidate(channel, payload);

  function render({ asyncVisual = true, refreshPreview = true, refreshDoctor = true } = {}) {
    noteValueChange();
    syncHiddenWidget();
    reactiveRuntime.invalidate("prompt", { source: textarea.value, asyncVisual });
    if (refreshDoctor) reactiveRuntime.invalidate("doctor", { source: textarea.value });
    if (refreshPreview && resolvedView.classList.contains("on")) reactiveRuntime.invalidate("preview", { source: textarea.value });
  }

  function renderThemeOnly() { reactiveRuntime.invalidate("theme", { reason: "theme" }); }
  function renderLibraryOnly() { reactiveRuntime.invalidate("library", { reason: "library" }); }

  performanceRuntime.setOnWake(() => {
    reactiveRuntime.batch(() => {
      reactiveRuntime.invalidate("prompt", { reason: "wake" });
      reactiveRuntime.invalidate("layout", { reason: "wake" });
      if (pickerDrawer.classList.contains("open")) reactiveRuntime.invalidate("library", { reason: "wake" });
      if (powerTools.promptDoctor) reactiveRuntime.invalidate("doctor", { reason: "wake" });
      if (resolvedView.classList.contains("on")) reactiveRuntime.invalidate("preview", { reason: "wake" });
    });
  });

  function updateTokenBadge(stats) {
    lastTokenStats = stats || null;
    lastTokenStatsSource = stats ? textarea.value : "";
    tokenCountEl.classList.remove("wg-token-warn", "wg-token-danger");
    if (!stats) {
      tokenCountEl.textContent = "";
      tokenCountEl.title = "CLIP-L token count of the resolved prompt (visible while Preview result is open)";
      return;
    }
    const { tokens, chunks, per_chunk, limit_per_chunk } = stats;
    if (tokens === 0) {
      tokenCountEl.textContent = "0 tokens";
      tokenCountEl.title = "";
      return;
    }
    const chunkWord = chunks === 1 ? "chunk" : "chunks";
    tokenCountEl.textContent = `${tokens} token${tokens === 1 ? "" : "s"} \u00b7 ${chunks} ${chunkWord}`;
    if (chunks >= 3) tokenCountEl.classList.add("wg-token-danger");
    else if (chunks === 2) tokenCountEl.classList.add("wg-token-warn");
    const breakdown = per_chunk.map((n, i) => `chunk ${i + 1}: ${n}/${limit_per_chunk}`).join(" \u00b7 ");
    tokenCountEl.title = chunks > 1
      ? `CLIP-L splits prompts into ${limit_per_chunk}-token chunks. ${breakdown}`
      : `${breakdown} CLIP-L tokens`;
  }

  function matchingExecutionMetadata() {
    const metadata = lastExecutionMetadata;
    if (!metadata || metadata.batch || typeof metadata !== "object") return null;
    if (typeof metadata.source_text !== "string" || metadata.source_text !== textarea.value) return null;
    const mode = modeWidget ? modeWidget.value : "entire text as one";
    if (metadata.processing_mode && metadata.processing_mode !== mode) return null;
    return typeof metadata.positive_prompt === "string" ? metadata : null;
  }

  function showSavedTokenCount(metadata) {
    const count = Number(metadata?.clip_token_count);
    if (!Number.isFinite(count) || count < 0) { updateTokenBadge(null); return; }
    lastTokenStats = { tokens: count, chunks: Math.max(1, Math.ceil(count / 77)), per_chunk: [], limit_per_chunk: 77 };
    lastTokenStatsSource = textarea.value;
    tokenCountEl.classList.remove("wg-token-warn", "wg-token-danger");
    tokenCountEl.textContent = `${count} token${count === 1 ? "" : "s"} · saved result`;
    tokenCountEl.title = "Token count recorded when this resolved prompt was executed.";
  }

  function renderResolvedText(resolved) {
    const output = String(resolved ?? "");
    if (!powerTools.resolvedDiff) {
      resolvedView.textContent = output;
      resolvedView.removeAttribute("data-diff");
      return;
    }
    const segments = buildResolvedDiff(textarea.value, output, lastParsedPrompt);
    resolvedView.innerHTML = segments.map((segment) => segment.type === "changed"
      ? `<span class="wg-resolved-changed">${escapeHtml(segment.text)}</span>`
      : escapeHtml(segment.text)).join("");
    resolvedView.dataset.diff = "on";
  }

  function setPreviewStatus(message = "", kind = "") {
    if (!previewStatus) return;
    previewStatus.textContent = message;
    previewStatus.hidden = !message;
    previewStatus.dataset.kind = kind;
    resolvedView.toggleAttribute("aria-busy", !!message && kind !== "error");
  }

  async function refreshResolvedView() {
    const requestId = ++resolvedRequestId;
    const source = textarea.value;
    const seed = seedWidget ? seedWidget.value : 0;
    const mode = modeWidget ? modeWidget.value : "entire text as one";
    const requestController = performanceRuntime.beginRequest("preview");
    const stillCurrent = () => requestId === resolvedRequestId
      && nodeIsActive(node)
      && !requestController.signal.aborted
      && textarea.value === source
      && (seedWidget ? seedWidget.value : 0) === seed
      && (modeWidget ? modeWidget.value : "entire text as one") === mode;

    const saved = matchingExecutionMetadata();
    if (saved) {
      performanceRuntime.endRequest("preview", requestController);
      if (!stillCurrent()) return;
      renderResolvedText(saved.positive_prompt);
      setPreviewStatus();
      showSavedTokenCount(saved);
      if (powerTools.promptDoctor) scheduleDoctorCheck();
      return;
    }
    setPreviewStatus("Resolving…", "loading");
    try {
      const result = await profiler.measureAsync("preview.resolve", () => API.resolve(source, seed, mode, { signal: requestController.signal }));
      performanceRuntime.endRequest("preview", requestController);
      if (!stillCurrent()) return;
      renderResolvedText(result.resolved);
      setPreviewStatus();
      updateTokenBadge(result.tokenStats);
      if (powerTools.promptDoctor) scheduleDoctorCheck();
    } catch (e) {
      performanceRuntime.endRequest("preview", requestController);
      if (e?.name === "AbortError" || requestController.signal.aborted || !stillCurrent()) return;
      setPreviewStatus("Preview failed — server route unavailable", "error");
      updateTokenBadge(null);
    }
  }

  node._wgAcceptPromptMetadata = (metadata) => {
    if (!metadata || typeof metadata !== "object") return;
    lastExecutionMetadata = metadata;
    if (!metadata.batch && theme.promptHistoryEnabled !== false) {
      addHistorySnapshot({
        source: typeof metadata.source_text === "string" ? metadata.source_text : textarea.value,
        resolved: typeof metadata.positive_prompt === "string" ? metadata.positive_prompt : "",
        seed: metadata.seed,
        reason: "Queued prompt",
        force: true,
      });
    }
    if (resolvedView.classList.contains("on")) scheduleResolvedPreview();
  };

  textarea.addEventListener("input", () => {
    profiler.count("editorInputs");
    render({ asyncVisual: true, refreshPreview: true, refreshDoctor: true });
    scheduleHistorySnapshot();
  });
  textarea.addEventListener("scroll", () => { highlight.scrollTop = textarea.scrollTop; highlight.scrollLeft = textarea.scrollLeft; });

  textarea.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const key = e.key.toLowerCase();
    if (key === "z" && e.shiftKey) { e.preventDefault(); performRedo(); }
    else if (key === "z") { e.preventDefault(); performUndo(); }
    else if (key === "y") { e.preventDefault(); performRedo(); }
  });

  const libraryState = {};
  Object.defineProperties(libraryState, {
    recipeSelectMode: { get: () => recipeSelectMode, set: (value) => { recipeSelectMode = Boolean(value); } },
    catOrder: { get: () => catOrder, set: (value) => { catOrder = value; } },
    pickerViewMode: { get: () => pickerViewMode, set: (value) => { pickerViewMode = value; } },
    thumbMap: { get: () => thumbMap, set: (value) => { thumbMap = value || {}; } },
    knownSet: { get: () => knownSet, set: (value) => { knownSet = value instanceof Set ? value : new Set(value || []); rebuildKnownLeafSet(); } },
    recentList: { get: () => recentList, set: (value) => { recentList = Array.isArray(value) ? value : []; } },
    starterAutocompleteRows: { get: () => starterAutocompleteRows, set: (value) => { starterAutocompleteRows = Array.isArray(value) ? value : []; } },
    starterSaveSuggestion: { get: () => starterSaveSuggestion, set: (value) => { starterSaveSuggestion = String(value || ""); } },
    libraryCache: { get: () => libraryCache, set: (value) => { installLibraryRevision(value); } },
    thumbBust: { get: () => thumbBust, set: (value) => { thumbBust = value || {}; } },
    tokenRanges: { get: () => tokenRanges },
    libraryDensity: { get: () => workspaceController?.getLibraryDensity?.() || "medium" },
    workspacePrefs: { get: () => workspacePrefs },
    workerClient: { get: () => workerClient },
  });
  libraryController = createLibraryController({
    node, root, theme, state: libraryState, ioRail, textarea, hoverTip, previewCache, pinned, expandedCats, usageStore, recipeSelection,
    recipeSelectToggle, recipeBar, recipeBarCount, pickerDrawer, libraryTabs, libraryPanels, editDrawer, el, render,
    closeSettings, closeStash, openLibraryWorkspace, promptSaveRecipe,
    performanceRuntime, profiler, libraryModel, renderLibrary: renderLibraryOnly,
  });
  const { starterPackController, libraryButton, searchInput } = libraryController;
  workspaceController?.setLibraryDensityChangeHandler?.(() => renderPickerList(searchInput.value));

  const utilityState = {};
  Object.defineProperties(utilityState, {
    stash: { get: () => stash, set: (value) => { stash = value; } },
    lastHistorySource: { get: () => lastHistorySource, set: (value) => { lastHistorySource = value; } },
  });
  utilityController = createUtilityController({
    node, root, theme, state: utilityState, ioRail, settingsPopup, stashPopup, stashList, historyList, stashTabs, stashPanels,
    doctorPopup, variationPopup, libraryManagerPopup, recipeBuilderPopup, pickerDrawer, libraryTabs, libraryPanels,
    doctorChip, btnVariations, libraryManagerBtn, libraryButton, historyStore, textarea,
    closeAllPowerPopups, closePickerDrawer, closeEditDrawer,
    syncPowerToolSettingsUI, renderCatPins, updateThemeJson, getThemeController: () => themeController, addHistorySnapshot,
  });

  const powerState = {};
  Object.defineProperties(powerState, {
    powerTools: { get: () => powerTools, set: (value) => { powerTools = value; } },
    libraryCache: { get: () => libraryCache },
    knownSet: { get: () => knownSet },
    lastTokenStatsSource: { get: () => lastTokenStatsSource },
    lastTokenStats: { get: () => lastTokenStats },
    parsedPrompt: { get: () => lastParsedPrompt },
    workerClient: { get: () => workerClient },
    libraryModel: { get: () => libraryModel },
  });
  powerToolsController = createPowerToolsController({
    node, root, settingsPopup, state: powerState, ioRail,
    doctorPopup, variationPopup, libraryManagerPopup, recipeBuilderPopup,
    doctorChip, doctorLabel, doctorSummary, doctorList, btnVariations, libraryManagerBtn,
    editorReal, resolvedView, btnResolve, textarea, variationStatus, variationList, variationCount,
    seedInput, seedWidget, modeWidget, libraryManagerSearch, libraryManagerEntries, libraryManagerSelectedCount,
    libraryHealthSummary, libraryHealthList, recipeBuilderOperator, recipeBuilderSeparator, recipeBuilderPrefix,
    recipeBuilderSuffix, recipeBuilderPreview, recipeBuilderList, recipeBuilderName, recipeBuilderStatus,
    previewCache, expandedCats, searchInput, closeSettings, closeStash,
    closePickerDrawer, closeEditDrawer, syncSeedControlsFromWidgets, refreshResolvedView,
    refreshLibrary, openEditForItem, renderPickerList, updateThemeJson, el, performanceRuntime, profiler,
  });

  function syncWorkspaceSettingsUI() {
    syncWorkspaceSettingsSurface(root, settingsPopup, workspacePrefs, previewModeSelect);
  }

  function applyWorkspacePreferences({ preview = false } = {}) {
    syncWorkspaceSettingsUI();
    reactiveRuntime.invalidate("accessibility", { ...workspacePrefs });
    if (workspacePrefs.previewMode === "manual") { performanceRuntime.cancelTimer("preview"); performanceRuntime.abortRequest("preview"); }
    else if (preview && resolvedView.classList.contains("on")) reactiveRuntime.invalidate("preview", { reason: "preview-mode" });
  }

  function setWorkspaceLevel(level) {
    const next = ["core", "creator", "power"].includes(level) ? level : "creator";
    setWorkspacePreference("level", next);
    workspacePrefs = getWorkspacePreferences();
    const layout = next === "core" ? "minimal" : next === "power" ? "studio" : "balanced";
    settingsPopup.querySelector(`[data-layout-preset="${layout}"]`)?.click();
    if (next === "core" || next === "creator") {
      powerTools = replacePowerToolPreferences({});
    } else {
      powerTools = replacePowerToolPreferences({ promptDoctor: true, variationLab: true, resolvedDiff: true, libraryManager: true, recipeBuilder2: true, nativeCommands: powerTools.nativeCommands });
    }
    powerToolsController?.applyPowerToolSettings({ refreshPreview: true });
    syncWorkspaceSettingsUI();
  }

  settingsPopup.querySelectorAll("[data-workspace-level]").forEach((button) => button.addEventListener("click", () => setWorkspaceLevel(button.dataset.workspaceLevel)));
  settingsPopup.querySelectorAll("[data-workspace-pref]").forEach((input) => input.addEventListener("change", () => {
    setWorkspacePreference(input.dataset.workspacePref, !!input.checked);
    workspacePrefs = getWorkspacePreferences();
    applyWorkspacePreferences();
  }));
  previewModeSelect?.addEventListener("change", () => {
    setWorkspacePreference("previewMode", previewModeSelect.value);
    workspacePrefs = getWorkspacePreferences();
    applyWorkspacePreferences({ preview: true });
  });
  applyWorkspacePreferences();


  const performanceDiagnosticsController = createPerformanceDiagnosticsController({
    node, root, settingsPopup,
    toggle: performanceDiagnosticsToggle,
    panel: performanceDiagnosticsPanel,
    readout: performanceDiagnosticsReadout,
    performanceRuntime, profiler,
    getLibraryController: () => libraryController,
    getLibrarySize: () => libraryCache.length,
    syntaxCache, previewCache, reactiveRuntime, workerClient,
    getToolRegistry: () => powerToolsController?.toolRegistry,
  });

  root.querySelector('[data-act="resolve"]').addEventListener("click", async (e) => {
    const on = resolvedView.classList.toggle("on");
    editorReal.classList.toggle("hidden", on);
    e.currentTarget.classList.toggle("on", on);
    e.currentTarget.textContent = on ? "Edit prompt" : "Preview result";
    e.currentTarget.setAttribute("aria-pressed", String(on));
    e.currentTarget.setAttribute("aria-label", on ? "Return to prompt editor" : "Preview resolved prompt");
    e.currentTarget.title = on ? "Return to your editable prompt" : "Preview the wildcard-resolved result without changing your draft";
    if (on) await refreshResolvedView();
    else {
      resolvedRequestId += 1;
      performanceRuntime.cancelTimer("preview");
      performanceRuntime.abortRequest("preview");
      setPreviewStatus();
      updateTokenBadge(null);
    }
  });

  const copyBtn = root.querySelector('[data-act="copy"]');
  copyBtn.addEventListener("click", async () => {
    try {
      const copyText = resolvedView.classList.contains("on") ? resolvedView.textContent : textarea.value;
      await navigator.clipboard.writeText(copyText);
      const prevHtml = copyBtn.innerHTML;
      copyBtn.innerHTML = "&#10003;";
      copyBtn.classList.add("active");
      scheduleNodeTimer(node, () => { copyBtn.innerHTML = prevHtml; copyBtn.classList.remove("active"); }, 1100);
    } catch (e) {
      copyBtn.title = "Copy failed \u2014 clipboard permission denied";
    }
  });

  root.querySelector('[data-act="clear"]').addEventListener("click", async () => {
    if (!textarea.value) return;
    const ok = await dialogConfirm({
      title: "Clear Prompt",
      message: "Clear the entire prompt? (You can Ctrl+Z to undo this.)",
    });
    if (!ok) return;
    textarea.value = "";

    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.focus();
  });

  const refreshBtn = root.querySelector('[data-act="refresh"]');
  refreshBtn.addEventListener("click", async () => {
    refreshBtn.classList.add("active");
    refreshBtn.disabled = true;
    try {
      const data = await API.refreshWildcards();
      node.updateWildcardSidePanels(data);
    } catch (e) {
      console.error("Prompt Palette: wildcard refresh failed", e);
      refreshBtn.title = "Refresh failed \u2014 see console";
    } finally {
      refreshBtn.classList.remove("active");
      refreshBtn.disabled = false;
    }
  });

  const undoBtn = root.querySelector('[data-act="undo"]');
  const redoBtn = root.querySelector('[data-act="redo"]');
  undoBtn.addEventListener("click", performUndo);
  redoBtn.addEventListener("click", performRedo);

  node.updateWildcardSidePanels = function (data) {
    const items = (data && data.items) || [];
    installLibraryRevision(items);
    knownSet = new Set(items.map(i => i.path));
    rebuildKnownLeafSet();
    renderLibraryOnly();
  };

  textarea.addEventListener("dblclick", (e) => {
    const nativeStart = textarea.selectionStart;
    const nativeEnd = textarea.selectionEnd;
    const tok = tokenRanges.find(t => t.start <= nativeEnd && t.end >= nativeStart);
    if (tok) {

      textarea.selectionStart = tok.start;
      textarea.selectionEnd = tok.end;
      openEditForItem(tok.name);
    }
  });

  textarea.addEventListener("contextmenu", (e) => {

    const selStart = textarea.selectionStart, selEnd = textarea.selectionEnd;
    if (selEnd > selStart) {
      const selectedText = textarea.value.slice(selStart, selEnd);
      if (selectedText.trim()) {
        e.preventDefault();
        hideTip();
        closeInjectMenu();
        const actions = [
          { label: "Cut", onSelect: () => runTextareaEditCommand(textarea, render, "cut") },
          { label: "Copy", onSelect: () => runTextareaEditCommand(textarea, render, "copy") },
          { label: "Paste", onSelect: () => runTextareaEditCommand(textarea, render, "paste") },
          { label: "Select All", onSelect: () => runTextareaEditCommand(textarea, render, "selectAll") },
          { label: "Save selection to My Library\u2026", onSelect: () => promptExtractSelectionToWildcard(selStart, selEnd) },
        ];
        const selectedTokens = tokenRanges.filter(t => t.known && t.start >= selStart && t.end <= selEnd);
        if (selectedTokens.length >= 2) {
          const names = selectedTokens.map(t => t.name);
          actions.push({ label: `Save ${names.length} library entries as Palette Recipe`, onSelect: () => promptSaveRecipe(names) });
        }
        openCtxMenu(e.clientX, e.clientY, actions);
        return;
      }
    }
    const idx = textarea.selectionStart;
    const tok = tokenRanges.find(t => t.start <= idx && t.end >= idx);
    if (!tok) return;
    if (!tok.known) {
      e.preventDefault();
      hideTip();
      closeInjectMenu();
      openMissingRepairAt(e.clientX, e.clientY, tok);
      return;
    }
    if (theme.syntaxInjectorEnabled === false) return;
    e.preventDefault();
    hideTip();
    closeCtxMenu();
    textarea.selectionStart = tok.start;
    textarea.selectionEnd = tok.end;
    openInjectMenuAtPoint(e.clientX, e.clientY, tok.name, textarea, render, { start: tok.start, end: tok.end });
  });

  function replaceMissingToken(target, path) {
    const current = textarea.value.slice(target.start, target.end);
    const modifier = current.match(/^__([+\-*%~@]?)/)?.[1] || "";
    const replacement = `__${modifier}${path}__`;
    textarea.setRangeText(replacement, target.start, target.end, "end");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.focus();
    notify("success", "Wildcard repaired", `${target.name} → ${path}`);
  }

  function openMissingRepairAt(x, y, target) {
    const suggestions = closestPromptEntries(target.name, knownSet, 4);
    const actions = suggestions.map((path) => ({
      label: `Replace with ${path}`,
      onSelect: () => replaceMissingToken(target, path),
    }));
    actions.push({
      label: "Search My Library…",
      onSelect: () => {
        openPickerDrawer();
        activateLibraryTab("personal");
        searchInput.value = target.name.split("/").pop() || target.name;
        renderPickerList(searchInput.value);
        searchInput.focus({ preventScroll: true });
      },
    });
    openCtxMenu(x, y, actions);
  }

  function jumpToNextMissing() {
    const missing = tokenRanges.filter(t => !t.known);
    if (!missing.length) return;
    const caret = textarea.selectionEnd;
    const target = missing.find(t => t.start > caret) || missing[0];
    textarea.focus();
    textarea.selectionStart = target.start;
    textarea.selectionEnd = target.end;

    highlight.scrollTop = textarea.scrollTop;
    highlight.scrollLeft = textarea.scrollLeft;
    const coords = getCaretCoords(textarea, target.end);
    openMissingRepairAt(coords.left, coords.top + coords.lineHeight + 4, target);
  }
  hintRight.addEventListener("click", jumpToNextMissing);

  const handleOutsideClick = (e) => {
    if (isDialogOpen() || root.contains(e.target) || settingsPopup.contains(e.target)) return;
    if (stashPopup.classList.contains("open")) closeStash();
    closeAllPowerPopups();
  };
  const handleEscapeKey = (e) => {
    if (e.key !== "Escape") return;

    if (ctxMenuOpen) closeCtxMenu();
    else if (injectState && injectState.textarea === textarea) closeInjectMenu();
    else if (node._wgIoRailOpen) ioRail.close();
    else if (powerPopupEntries.some((popup) => popup.classList.contains("open"))) closeAllPowerPopups();
    else if (stashPopup.classList.contains("open")) closeStash();
    else if (editDrawer.classList.contains("open")) closeEditDrawer();
    else if (pickerDrawer.classList.contains("open")) closePickerDrawer();
  };

  document.addEventListener("click", handleOutsideClick);
  root.addEventListener("keydown", handleEscapeKey);
  document.addEventListener("keydown", handleEscapeKey);
  stashPopup.addEventListener("click", (e) => e.stopPropagation());
  powerPopupEntries.forEach((popup) => popup.addEventListener("click", (e) => e.stopPropagation()));

  const themeState = {};
  Object.defineProperties(themeState, {
    powerTools: { get: () => powerTools, set: (value) => { powerTools = value; } },
    libraryCache: { get: () => libraryCache },
    starterAutocompleteRows: { get: () => starterAutocompleteRows, set: (value) => { starterAutocompleteRows = value; } },
    historySnapshotTimer: { get: () => historySnapshotTimer, set: (value) => { historySnapshotTimer = value; } },
    activeLibraryTab: { get: () => libraryController?.activeLibraryTab || "personal" },
  });
  themeController = createThemeController({
    node, root, settingsPopup, theme, state: themeState, el, textarea, highlight, resolvedView, editorReal, btnResolve,
    starterPackController, libraryButton, searchInput, render: renderThemeOnly, applyPowerToolSettings, closeAllPowerPopups,
    closeStash, closePickerDrawer, closeEditDrawer, activateLibraryTab, prepareStarterPacks, renderPickerList,
  });

  textarea.value = promptState.restore();
  refreshLibrary().then(() => renderCatPins()).catch((error) => {
    console.error("Prompt Palette: initial wildcard refresh failed", error);
  });
  render();

  const commandTarget = registerPromptPaletteCommandTarget(node, {
    openLibrary: () => openPickerDrawer("personal"),
    focusEditor: () => {
      closeAllPowerPopups(); closeSettings(); closeStash(); closePickerDrawer(); closeEditDrawer();
      editorReal.classList.remove("hidden"); resolvedView.classList.remove("on"); btnResolve.classList.remove("on");
      btnResolve.textContent = "Preview result"; textarea.focus({ preventScroll: true });
    },
    togglePreview: () => btnResolve.click(),
    toggleIo: () => root.querySelector('[data-act="ioRailToggle"]')?.click(),
    openStash,
    toggleDayNight: () => themeController?.toggleDayNight?.(),
    openDoctor,
    openVariations,
    openLibraryManager,
  });
  root.addEventListener("pointerdown", commandTarget.activate, true);
  root.addEventListener("focusin", commandTarget.activate, true);

  // The settings coordinator owns the viewport portal mount. Every other Prompt Palette drawer stays node-local.
  const cleanupSettingsKeyboardBoundary = installPromptPaletteKeyboardBoundary(settingsPopup);

  const frame = document.createElement("div");
  frame.className = "wg-node-frame";
  frame.style.boxSizing = "border-box";
  frame.style.pointerEvents = "none";
  root.style.pointerEvents = "auto";
  frame.appendChild(root);
  node._wgInstallSocketRailWhenReady = () => {
    if (!node._wgInstallSocketRailWhenReady) return;
    delete node._wgInstallSocketRailWhenReady;
    installSocketRailLayout(node, IO_INPUT_DEFS, IO_OUTPUT_DEFS, frame);
  };

  return {
    root: frame,
    refreshFromHidden,
    refreshVisuals: () => {
      if (!frame.isConnected) return false;
      renderVisuals();
      return true;
    },
    reassertHiddenWidgets,
    reapplyTheme: () => themeController?.applyUiTheme?.(),
    cleanup: () => {
      workspaceController?.cleanup();
      delete node._wgBeforeIoRailOpen;
      delete node._wgAcceptPromptMetadata;
      ioRail.cleanup();
      libraryController?.cleanup();
      utilityController?.cleanup?.();
      document.removeEventListener("click", handleOutsideClick);
      root.removeEventListener("keydown", handleEscapeKey);
      document.removeEventListener("keydown", handleEscapeKey);
      if (acState && acState.textarea === textarea) closeAcMenu();
      if (injectState && injectState.textarea === textarea) closeInjectMenu();
      if (ctxMenuOpen) closeCtxMenu();
      powerToolsController?.cleanup();
      themeController?.cleanup?.();
      commandTarget.cleanup();
      cleanupKeyboardBoundary();
      undoManager.cleanup();
      syntaxHighlighter.clear();
      editorSurface.cleanup();
      performanceDiagnosticsController.cleanup();
      cleanupSettingsKeyboardBoundary();
      settingsPopup.remove();
      delete node._wgInstallSocketRailWhenReady;
      delete node._ppInvalidateRuntime;
      reactiveRuntime.cleanup();
      workerClient.cleanup();
      performanceRuntime.cleanup();
      clearNodeTimers(node);
    }
  };
}

const livePromptPaletteNodes = new Set();

function cleanupSharedPromptPaletteDom() {
  cleanupDialogOverlays();
  cleanupAutocomplete();
  cleanupInjector();
  cleanupContextMenu();
  cleanupThumbnailPicker();
  document.querySelectorAll('.wg-tip[data-prompt-palette-global="true"]').forEach((element) => element.remove());
}

export { buildWildcardWidget, livePromptPaletteNodes, cleanupSharedPromptPaletteDom };
