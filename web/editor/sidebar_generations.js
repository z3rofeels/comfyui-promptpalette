import { api } from "../../../scripts/api.js";
import { API } from "../prompt_palette_api.js";
import { readEditorPreference, writeEditorPreference } from "../prompt_palette_state.js";
import {
  copyPromptPaletteThemeScope,
  installPromptPaletteKeyboardBoundary,
  svgIcon,
} from "../prompt_palette_shared.js";
import { openCtxMenu } from "./context_menu.js";
import { historyRefinementSources, reviewHistoryRefinement } from "./history_restore.js";
import { loadSidebarDisplay, loadTheme, saveSidebarDisplay } from "./preferences.js";
import { colorForLora, loraIdentity } from "./lora_colors.js";
import { sidebarLayoutMetrics } from "./sidebar_layout.js";
import { PresentationScope, captureSidebarFocus, restoreSidebarFocus } from "./sidebar_presentation.js";
import { VirtualCollectionManager } from "../library/virtual_collection.js";
import {
  requestGenerationHistory,
  subscribeGenerationHistory,
  generationImageUrl,
  mergeUniqueGenerationRows,
} from "./generation_history.js";
import {
  extractGenerationMetadata,
  parsePngTextChunks,
  formatSamplerScheduler,
  formatParametersSummary,
  formatCompletePromptInfo,
  serializeWorkflowComponent,
  buildWorkflowSubset,
} from "./generation_metadata.js";

const PREF_SIDEBAR_GEN_STATE = "sidebarRecentGenerationsStateV1";
const VALID_LAYOUTS = new Set(["gallery", "list", "masonry", "filmstrip"]);
const WIDE_PARAM_KEYS = new Set(["model", "clip", "vae"]);
const runMetadataCache = new Map();
const imageDimensionsCache = new Map();
const loraInfoCache = new Map();

function normalizeGenLayout(value) {
  if (value === "grid") return "gallery";
  return VALID_LAYOUTS.has(value) ? value : "gallery";
}

function make(tag, className = "", text = "") {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text) el.textContent = text;
  return el;
}

function btn(text, onClick, className = "") {
  const el = make("button", className, text);
  el.type = "button";
  el.addEventListener("click", onClick);
  return el;
}

function pill(text, tone = "", title = "") {
  const el = make("span", "pp-sidebar-gen-pill", text);
  if (tone) el.dataset.tone = tone;
  if (title) el.title = title;
  return el;
}

function shortModelName(value) {
  return String(value ?? "").split(/[\\/]/).pop().replace(/\.(safetensors|ckpt|pt|pth|gguf|bin)$/i, "");
}

function formatLoraStatusLabel(status) {
  switch (status) {
    case "loaded": return "Applied";
    case "external": return "External";
    case "graph": return "Graph";
    case "disabled": return "Disabled (0)";
    case "missing": return "Missing";
    case "ambiguous": return "Ambiguous";
    case "stripped": return "Stripped";
    case "text_only": return "Text only";
    default: return "Applied";
  }
}

function formatLoraStrengthLabel(lora) {
  const sm = Number.isFinite(lora.modelStrength) ? lora.modelStrength : 1;
  const sc = Number.isFinite(lora.clipStrength) ? lora.clipStrength : sm;
  return sm === sc ? `Strength ${sm}` : `Model ${sm} · CLIP ${sc}`;
}

function loraTagSyntax(lora) {
  const sm = Number.isFinite(lora.modelStrength) ? lora.modelStrength : 1;
  const sc = Number.isFinite(lora.clipStrength) ? lora.clipStrength : sm;
  return `<lora:${lora.name}:${sm}${sc !== sm ? `:${sc}` : ""}>`;
}

function rememberBounded(map, key, value, max = 160) {
  if (!key) return;
  if (map.size >= max && !map.has(key)) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

async function fetchRunEnrichment(record, signal) {
  const cacheKey = record?.prompt_id ? `run:${record.prompt_id}` : record?.id ? `id:${record.id}` : "";
  if (cacheKey && runMetadataCache.has(cacheKey)) {
    return runMetadataCache.get(cacheKey);
  }
  const result = { historyEntry: null, embedded: null };
  if (record?.prompt_id) {
    try {
      const res = await api.fetchApi(`/history/${encodeURIComponent(record.prompt_id)}`, signal ? { signal } : undefined);
      if (res?.ok) {
        const data = await res.json();
        if (data && typeof data === "object") {
          result.historyEntry = data[record.prompt_id] || (Array.isArray(data.prompt) ? data : null);
        }
      }
    } catch {
      /* ComfyUI history endpoint is optional enrichment; fallback to record or image chunks. */
    }
  }
  const hasGraph = Array.isArray(result.historyEntry?.prompt) && result.historyEntry.prompt[2];
  const histExtra = Array.isArray(result.historyEntry?.prompt) ? result.historyEntry.prompt[3]?.extra_pnginfo : null;
  const histOutputs = result.historyEntry?.outputs;
  const hasHistoryPalette = Boolean(
    histExtra?.prompt_palette || histExtra?.prompt_palette_metadata
    || (histOutputs && typeof histOutputs === "object" && Object.values(histOutputs).some(o => o && typeof o === "object" && o.prompt_palette))
  );
  if ((!hasGraph || (!record?.resolved_positive && !hasHistoryPalette)) && !record?.missing && record?.image?.filename && /\.png$/i.test(record.image.filename)) {
    try {
      const res = await api.fetchApi(`/view?${new URLSearchParams(record.image)}`, {
        ...(signal ? { signal } : {}),
        headers: { Range: "bytes=0-524287" },
      });
      if (res?.ok) {
        const buf = await res.arrayBuffer();
        const chunks = parsePngTextChunks(buf);
        if (Object.keys(chunks).length) result.embedded = chunks;
      }
    } catch {
      /* Embedded PNG chunk enrichment is best-effort. */
    }
  }
  if (cacheKey && (result.historyEntry || result.embedded)) {
    rememberBounded(runMetadataCache, cacheKey, result, 128);
  }
  return result;
}

function resolveRecordDimensions(record, meta) {
  const cached = record?.id ? imageDimensionsCache.get(record.id) : null;
  if (cached?.width > 0 && cached?.height > 0) return cached;
  const mw = Number(meta?.width || record?.width);
  const mh = Number(meta?.height || record?.height);
  if (Number.isFinite(mw) && mw > 0 && Number.isFinite(mh) && mh > 0) {
    return { width: mw, height: mh };
  }
  return null;
}

export function createSidebarGenerations(host, {
  mode = "split",
  presentation = null,
  hoverPreview = null,
  uiScale = () => 1,
  getNode,
  insertPrompt,
  restore,
  onOpenTab = null,
  announce = () => {},
} = {}) {
  const isTabMode = mode === "tab";
  const savedState = readEditorPreference(PREF_SIDEBAR_GEN_STATE, {}) || {};
  let isOpen = isTabMode ? true : savedState.open !== false;
  let sortOrder = savedState.sort === "oldest" ? "oldest" : "newest";
  let visible = true;
  let active = !isTabMode;
  let disposed = false;

  // Migrate any legacy layout preference into loadSidebarDisplay().layouts.generations
  if (savedState.layout && !readEditorPreference("sidebarDisplayV1", null)?.layouts?.generations) {
    saveSidebarDisplay({ layouts: { generations: normalizeGenLayout(savedState.layout) } });
  }

  let prefs = null;
  let rows = [];
  let cursor = null;
  let selectedId = null;
  let selectedRecord = null;
  let selectedExtra = {};
  let selectedNodeIds = new Set();
  let workflowSectionOpen = false;
  let lastGeometry = "";

  let listSequence = 0;
  let inspectSequence = 0;
  let loraEnrichSequence = 0;
  let refineSequence = 0;
  let listController = null;
  let inspectController = null;
  let loraEnrichController = null;
  let refineReview = null;
  let searchDebounce = 0;
  let unsubscribeCapture = null;
  let collection = null;
  let lastRenderedImages = null;
  let lastRenderedItems = null;
  let pendingItemsSync = false;
  const copyTimers = new WeakMap();
  const cardRecords = new WeakMap();

  // One layout control lives in the sidebar toolbar. The Generations tab has its own saved layout;
  // the Recent Generations section on the Library tab follows the Library layout.
  const layoutKey = isTabMode ? "generations" : "library";

  function currentLayoutMode() {
    return normalizeGenLayout(loadSidebarDisplay().layouts?.[layoutKey]);
  }

  function persistState() {
    const prev = readEditorPreference(PREF_SIDEBAR_GEN_STATE, {}) || {};
    writeEditorPreference(PREF_SIDEBAR_GEN_STATE, {
      ...prev,
      ...(isTabMode ? {} : { open: isOpen }),
      sort: sortOrder,
    });
  }

  function flashButtonFeedback(buttonEl, feedbackLabel = "✓ Copied") {
    if (!buttonEl || !buttonEl.isConnected) return;
    const prevTimer = copyTimers.get(buttonEl);
    if (prevTimer) clearTimeout(prevTimer);
    const originalText = buttonEl.dataset.originalLabel ?? buttonEl.textContent;
    buttonEl.dataset.originalLabel = originalText;
    buttonEl.dataset.copied = "true";
    if (!buttonEl.childElementCount) {
      buttonEl.textContent = feedbackLabel;
    }
    const timer = setTimeout(() => {
      copyTimers.delete(buttonEl);
      if (!buttonEl.isConnected) return;
      delete buttonEl.dataset.copied;
      if (!buttonEl.childElementCount && buttonEl.dataset.originalLabel != null) {
        buttonEl.textContent = buttonEl.dataset.originalLabel;
      }
    }, 1200);
    copyTimers.set(buttonEl, timer);
  }

  async function copyValue(text, label, buttonEl = null) {
    const str = String(text ?? "");
    if (!str) {
      announce(`No ${label} available to copy.`, true);
      return false;
    }
    let copied = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(str);
        copied = true;
      }
    } catch {
      copied = false;
    }
    if (!copied) {
      try {
        const temp = document.createElement("textarea");
        temp.value = str;
        temp.setAttribute("readonly", "true");
        temp.className = "pp-sr-only";
        document.body.append(temp);
        temp.select();
        copied = document.execCommand("copy");
        temp.remove();
      } catch {
        copied = false;
      }
    }
    if (!copied) {
      announce(`Clipboard unavailable while copying ${label}.`, true);
      return false;
    }
    announce(`Copied ${label}.`);
    flashButtonFeedback(buttonEl, "✓ Copied");
    return true;
  }

  // Root container: <details> in split Library view, <section> in dedicated Generations tab
  const section = make(
    isTabMode ? "section" : "details",
    `pp-sidebar-generations${isTabMode ? " pp-sidebar-generations--tab" : ""}`
  );
  section.dataset.genView = mode;
  if (!isTabMode) section.open = isOpen;

  const summary = make(isTabMode ? "header" : "summary", "pp-sidebar-gen-summary");
  const summaryIcon = make("span", "pp-sidebar-gen-summary-icon");
  summaryIcon.innerHTML = svgIcon("history", 15);
  const summaryTitle = make("strong", "pp-sidebar-gen-summary-title", "Recent Generations");
  const countBadge = make("span", "pp-sidebar-gen-badge", "0");
  summary.append(summaryIcon, summaryTitle, countBadge);

  if (!isTabMode && onOpenTab) {
    const openTabBtn = btn("Tab ↗", event => {
      event.preventDefault();
      event.stopPropagation();
      onOpenTab();
    }, "pp-sidebar-gen-tab-jump");
    openTabBtn.title = "Open Recent Generations in its own dedicated tab";
    openTabBtn.setAttribute("aria-label", "Open Recent Generations tab");
    summary.append(openTabBtn);
  }

  section.append(summary);

  const body = make("div", "pp-sidebar-gen-body");
  section.append(body);

  // Search + compact controls
  const controls = make("div", "pp-sidebar-gen-controls");
  const searchInput = make("input", "pp-sidebar-gen-search");
  searchInput.type = "search";
  searchInput.placeholder = "Filter prompts, models, seeds…";
  searchInput.setAttribute("aria-label", "Search recent generations");

  const toolbar = make("div", "pp-sidebar-gen-toolbar");
  const favFilterBtn = btn("★", () => {
    const next = favFilterBtn.getAttribute("aria-pressed") !== "true";
    favFilterBtn.setAttribute("aria-pressed", String(next));
    favFilterBtn.classList.toggle("active", next);
    refresh(false, { resetScroll: true });
  }, "pp-sidebar-icon pp-sidebar-gen-fav-filter");
  favFilterBtn.title = "Filter favorite generations";
  favFilterBtn.setAttribute("aria-label", "Filter favorite generations");
  favFilterBtn.setAttribute("aria-pressed", "false");

  const dateSelect = make("select", "pp-sidebar-gen-date");
  dateSelect.setAttribute("aria-label", "Recent generations date filter");
  for (const [val, text] of [["0", "All time"], ["1", "24h"], ["7", "7d"], ["30", "30d"]]) {
    dateSelect.append(new Option(text, val));
  }

  const sortBtn = btn("", () => {
    sortOrder = sortOrder === "newest" ? "oldest" : "newest";
    syncSortButton();
    persistState();
    refresh(false, { resetScroll: true });
  }, "pp-sidebar-gen-sort");
  function syncSortButton() {
    const isOldest = sortOrder === "oldest";
    sortBtn.textContent = isOldest ? "Oldest ↑" : "Newest ↓";
    sortBtn.dataset.sort = sortOrder;
    sortBtn.setAttribute("aria-pressed", String(isOldest));
    sortBtn.title = isOldest ? "Sorted oldest first — click to show newest first" : "Sorted newest first — click to show oldest first";
    sortBtn.setAttribute("aria-label", isOldest ? "Sort oldest first; click for newest first" : "Sort newest first; click for oldest first");
  }
  syncSortButton();

  const refreshBtn = btn("", async () => {
    refreshBtn.disabled = true;
    try {
      if (prefs?.enabled) await requestGenerationHistory("/sync", "POST", {});
      await refresh();
      if (selectedId) await inspectGeneration(selectedId, { quiet: true });
    } catch (error) {
      announce(error.message || String(error), true);
    } finally {
      if (!disposed) refreshBtn.disabled = false;
    }
  }, "pp-sidebar-icon pp-sidebar-gen-refresh");
  refreshBtn.innerHTML = svgIcon("refresh", 14);
  refreshBtn.title = "Refresh recent generations";
  refreshBtn.setAttribute("aria-label", "Refresh recent generations");

  const settingsDetails = make("details", "pp-sidebar-gen-settings");
  const settingsSummary = make("summary", "pp-sidebar-icon");
  settingsSummary.innerHTML = svgIcon("settings", 14);
  settingsSummary.title = "Generation tracking settings";
  settingsSummary.setAttribute("aria-label", "Generation tracking settings");
  settingsDetails.append(settingsSummary);

  toolbar.append(favFilterBtn, dateSelect, sortBtn, refreshBtn, settingsDetails);
  controls.append(searchInput, toolbar);

  const settingsPanel = make("div", "pp-sidebar-gen-settings-body");
  const enableToggle = make("input");
  enableToggle.type = "checkbox";
  enableToggle.setAttribute("aria-label", "Record Prompt Palette generations");
  const enableLabel = make("label", "pp-sidebar-toggle");
  enableLabel.append(enableToggle, make("span", "", "Record Prompt Palette generations"));

  const captureToggle = make("input");
  captureToggle.type = "checkbox";
  captureToggle.setAttribute("aria-label", "Store authored prompt text and Fields state");
  const captureLabel = make("label", "pp-sidebar-toggle");
  captureLabel.append(captureToggle, make("span", "", "Store authored prompts & Fields"));

  let importing = false;
  let importCancelled = false;
  const importBtn = btn("Import ComfyUI history", async () => {
    if (importing) {
      importCancelled = true;
      return;
    }
    importing = true;
    importCancelled = false;
    importBtn.textContent = "Cancel import";
    try {
      let offset = 0;
      let total = 0;
      do {
        const page = await requestGenerationHistory("/sync", "POST", { import_existing: true, offset });
        total += Number(page?.added) || 0;
        announce(`Indexed ${total} generation(s)…`);
        offset = page?.next_offset ?? null;
      } while (offset !== null && !importCancelled && !disposed);
      await refresh();
    } catch (error) {
      announce(error.message || String(error), true);
    } finally {
      importing = false;
      if (!disposed) importBtn.textContent = "Import ComfyUI history";
    }
  }, "pp-sidebar-gen-import-btn");

  const settingsNote = make("small", "pp-sidebar-note", "Hiding Recent Generations in Sidebar settings only hides this view; generation tracking stays active.");
  settingsPanel.append(enableLabel, captureLabel, importBtn, settingsNote);
  body.append(controls, settingsPanel);
  settingsPanel.hidden = true;
  settingsDetails.addEventListener("toggle", () => {
    settingsPanel.hidden = !settingsDetails.open;
  });

  // Thumbnail list / gallery / masonry / filmstrip container (virtualized)
  const listEl = make("div", "pp-sidebar-gen-list");
  listEl.setAttribute("role", "list");
  listEl.setAttribute("aria-label", "Recent generations list");
  const virtual = new VirtualCollectionManager(listEl);

  const loadMoreBtn = btn("Load more", () => refresh(true), "pp-sidebar-gen-more");
  loadMoreBtn.hidden = true;

  body.append(listEl, loadMoreBtn);
  if (isTabMode) host.append(section);
  else host.prepend(section);

  const ownedPresentation = presentation ? null : new PresentationScope(section);
  const scope = presentation || ownedPresentation;

  // Generation details popout: a Civitai-style right-hand flyout mounted on <body>
  // beside the sidebar so the gallery remains visible and usable while browsing.
  const flyoutEl = make("aside", "wg-root pp-gen-flyout");
  flyoutEl.hidden = true;
  flyoutEl.setAttribute("role", "dialog");
  flyoutEl.setAttribute("aria-modal", "false");
  flyoutEl.setAttribute("aria-label", "Generation details");

  const flyHead = make("header", "pp-gen-flyout-head");
  const flyTitle = make("span", "pp-gen-flyout-title");
  flyTitle.innerHTML = `${svgIcon("history", 13)}<span>Generation info</span>`;
  const flyNameBadge = make("span", "pp-gen-flyout-name-badge");
  const flyHeadTools = make("div", "pp-gen-flyout-tools");
  const flyCloseBtn = make("button", "wg-close-btn");
  flyCloseBtn.type = "button";
  flyCloseBtn.innerHTML = svgIcon("close", 14);
  flyCloseBtn.setAttribute("aria-label", "Close generation details");
  flyCloseBtn.title = "Close (Esc)";
  flyHead.append(flyTitle, flyNameBadge, flyHeadTools, flyCloseBtn);

  const flyBody = make("div", "pp-gen-flyout-body");
  const flyFoot = make("footer", "pp-gen-flyout-foot");
  flyoutEl.append(flyHead, flyBody, flyFoot);

  for (const type of ["pointerdown", "mousedown", "click", "dblclick", "contextmenu"]) {
    flyoutEl.addEventListener(type, event => event.stopPropagation());
  }
  flyoutEl.addEventListener("wheel", event => event.stopPropagation(), { passive: true });
  const releaseFlyoutKeyboard = installPromptPaletteKeyboardBoundary(flyoutEl);
  flyoutEl.addEventListener("keydown", event => {
    if (event.key === "Escape" && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      closeInspector();
    }
  });
  flyCloseBtn.addEventListener("click", () => closeInspector());

  let flyoutTimer = 0;
  let flyoutRectKey = "";
  const flyoutAnchor = () => section.closest(".pp-main-sidebar") || section;

  function syncFlyoutTheme() {
    const themeRoot = section.closest(".pp-main-sidebar, .wg-root") || section;
    if (presentation?.syncPortalTheme) {
      presentation.syncPortalTheme(flyoutEl);
      return;
    }
    copyPromptPaletteThemeScope(themeRoot, flyoutEl, scope.declaration(flyoutEl, { portal: true }));
    for (const cls of ["wg-high-contrast", "wg-reduce-motion", "wg-no-animations", "wg-disable-animations", "wg-large-text"]) {
      flyoutEl.classList.toggle(cls, themeRoot.classList?.contains(cls) === true);
    }
  }

  function placeFlyout(force = false) {
    if (disposed || flyoutEl.hidden || !flyoutEl.isConnected) return;
    const anchor = flyoutAnchor();
    const rect = anchor.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) {
      hideFlyout();
      return;
    }
    const vw = globalThis.innerWidth || 1024;
    const vh = globalThis.innerHeight || 768;
    const key = [rect.left, rect.top, rect.right, rect.bottom, vw, vh].map(Math.round).join();
    if (!force && key === flyoutRectKey) return;
    flyoutRectKey = key;
    const margin = 8;
    const gap = 8;
    const width = Math.max(320, Math.min(520, vw - margin * 2));
    const roomRight = vw - margin - rect.right - gap;
    const roomLeft = rect.left - margin - gap;
    let left;
    if (roomRight >= width) left = rect.right + gap;
    else if (roomLeft >= width) left = rect.left - gap - width;
    else left = Math.max(margin, vw - margin - width);
    const top = Math.max(margin, Math.min(rect.top || margin, vh - margin - 280));
    const maxHeight = Math.max(260, vh - margin - top);
    scope.set(flyoutEl, {
      "--pp-fly-left": `${Math.round(left)}px`,
      "--pp-fly-top": `${Math.round(top)}px`,
      "--pp-fly-width": `${Math.round(width)}px`,
      "--pp-fly-max-height": `${Math.round(maxHeight)}px`,
    });
  }

  function showFlyout() {
    if (disposed) return;
    if (!flyoutEl.isConnected) document.body.append(flyoutEl);
    syncFlyoutTheme();
    flyoutEl.hidden = false;
    placeFlyout(true);
    if (!flyoutTimer) flyoutTimer = setInterval(placeFlyout, 150);
  }

  function hideFlyout() {
    flyoutEl.hidden = true;
    clearInterval(flyoutTimer);
    flyoutTimer = 0;
  }

  const onFlyoutResize = () => placeFlyout(true);
  globalThis.addEventListener?.("resize", onFlyoutResize);

  function computeMetrics() {
    const rawWidth = listEl.clientWidth || body.clientWidth || host.clientWidth || 0;
    const availWidth = rawWidth > 0 ? Math.max(120, rawWidth) : 0;
    const metrics = sidebarLayoutMetrics(layoutKey, uiScale(), availWidth || 320);
    const layoutMode = normalizeGenLayout(metrics.mode);
    const display = loadSidebarDisplay();
    const images = display.chrome?.images !== false;
    const fit = display.chrome?.fit === "contain" ? "contain" : "cover";
    const fillRows = display.chrome?.fillRows !== false;
    const imageHeight = images ? Math.max(28, Math.round(metrics.cardWidth / metrics.ratio)) : 0;
    const listDensity = layoutMode === "list"
      ? (metrics.rowHeight < 42 ? "tiny" : metrics.rowHeight < 54 ? "micro" : "normal")
      : metrics.density;
    return {
      ...metrics,
      mode: layoutMode,
      images,
      fit,
      fillRows,
      imageHeight,
      listDensity,
      rawWidth,
      availWidth,
    };
  }

  function applyMetricsToDOM(m) {
    section.dataset.layout = m.mode;
    listEl.dataset.layout = m.mode;
    listEl.dataset.density = m.listDensity;
    listEl.dataset.aspect = m.aspect;
    scope.set(listEl, {
      "--pp-gen-columns": m.columns,
      "--pp-gen-card-width": `${m.cardWidth}px`,
      "--pp-gen-image-height": `${m.imageHeight}px`,
      "--pp-gen-row-height": `${Math.round(m.rowHeight)}px`,
      "--pp-gen-scale": m.scale,
      "--pp-gen-ratio": m.ratio,
    });
  }

  function syncCapture() {
    unsubscribeCapture?.();
    unsubscribeCapture = null;
    // Keep tracking active even when the sidebar section is collapsed or hidden.
    if (prefs?.enabled && !disposed) {
      unsubscribeCapture = subscribeGenerationHistory(() => {
        if (visible && active && isOpen) refresh();
      });
    }
  }

  async function saveTrackingSettings() {
    if (!prefs) return;
    try {
      prefs = await requestGenerationHistory("/settings", "PUT", {
        enabled: enableToggle.checked,
        capture_prompts: captureToggle.checked,
        max_entries: Number(prefs.max_entries) || 10000,
        revision: prefs.revision || 0,
      });
      syncCapture();
      API.publishMetadataChange?.({ namespace: "settings", action: "generation-history", prefs });
      if (prefs.enabled) {
        await requestGenerationHistory("/sync", "POST", {});
        await refresh();
      } else {
        renderList();
      }
    } catch (error) {
      enableToggle.checked = !!prefs.enabled;
      captureToggle.checked = !!prefs.capture_prompts;
      announce(error.message || String(error), true);
    }
  }

  enableToggle.addEventListener("change", saveTrackingSettings);
  captureToggle.addEventListener("change", saveTrackingSettings);

  async function toggleFavorite(record, event) {
    event?.stopPropagation();
    try {
      const saved = await requestGenerationHistory(`/${encodeURIComponent(record.id)}`, "PATCH", {
        favorite: !record.favorite,
        revision: record.revision,
      });
      Object.assign(record, saved);
      if (selectedRecord?.id === record.id) Object.assign(selectedRecord, saved);
      API.publishMetadataChange?.({ namespace: "generations", action: "annotate", id: record.id });
      renderList({ itemsChanged: true });
      if (selectedRecord?.id === record.id) renderInspector();
    } catch (error) {
      announce(error.message || String(error), true);
    }
  }

  async function usePromptInTarget(text, channel = "positive", record = selectedRecord, buttonEl = null) {
    if (!text) return;
    try {
      if (restore && channel === "negative") {
        await restore({ text, channel, record, requiresConfirmation: true });
        flashButtonFeedback(buttonEl, "✓ Sent");
        announce("Sent negative prompt to target node.");
        return;
      }
      if (insertPrompt && channel === "positive") {
        const ok = await insertPrompt(text);
        if (ok) {
          flashButtonFeedback(buttonEl, "✓ Inserted");
          return;
        }
      }
      if (restore) {
        await restore({ text, channel, record, requiresConfirmation: true });
        flashButtonFeedback(buttonEl, "✓ Sent");
        announce(`Sent ${channel} prompt to target node.`);
      }
    } catch (error) {
      announce(error.message || String(error), true);
    }
  }

  async function openRefinement(record) {
    const version = ++refineSequence;
    refineReview?.close();
    refineReview = null;
    try {
      const target = getNode?.();
      const adapter = target?._ppHistoryRefinement;
      if (!adapter?.alive()) {
        throw new Error("Choose an open Prompt Palette or Combinatorial node in 'Insert into' first.");
      }
      const baseline = adapter.state();
      const fresh = await requestGenerationHistory(`/${encodeURIComponent(record.id)}`);
      if (disposed || version !== refineSequence) return;
      if (getNode?.() !== target || adapter !== target?._ppHistoryRefinement || adapter.state() !== baseline) {
        throw new Error("The target editor changed. Choose Refine again.");
      }
      const review = reviewHistoryRefinement(target, fresh, {
        promote: false,
        getTarget: getNode,
        validateRecord: async () => {
          const current = await requestGenerationHistory(`/${encodeURIComponent(fresh.id)}`);
          if (disposed || version !== refineSequence || current.revision !== fresh.revision) {
            throw new Error("The generation changed. Review Refine again.");
          }
        },
      });
      refineReview = review;
      const applied = await review.done;
      if (refineReview === review) refineReview = null;
      if (applied && !disposed) {
        announce("Refinement opened in the selected node. Use Commit or Cancel there.");
      }
    } catch (error) {
      announce(error.message || String(error), true);
    }
  }

  function buildSubParts(record, meta, dims, activeMode, primaryLabel) {
    const subParts = [];
    if (activeMode === "list" && record.image?.filename && primaryLabel !== record.image.filename) {
      subParts.push(record.image.filename);
    }
    if (meta.seed != null) subParts.push(`#${meta.seed}`);
    if (meta.sampler) subParts.push(meta.sampler);
    if (dims) subParts.push(`${dims.width}×${dims.height}`);
    else if (record.completed_at) subParts.push(new Date(record.completed_at).toLocaleDateString());
    return subParts;
  }

  function syncCardBadges(media, record, dims, activeMode) {
    let badges = media.querySelector(".pp-sidebar-gen-badges");
    const wantRes = (activeMode === "masonry" || activeMode === "filmstrip") && dims;
    const wantAny = record.provenance === "verified" || Boolean(record.favorite) || Boolean(wantRes);
    if (!wantAny) {
      badges?.remove();
      return;
    }
    if (!badges) {
      badges = make("span", "pp-sidebar-gen-badges");
      media.append(badges);
    }
    let vBadge = badges.querySelector(".pp-sidebar-gen-verified");
    if (record.provenance === "verified") {
      if (!vBadge) {
        vBadge = make("span", "pp-sidebar-gen-verified", "✓");
        vBadge.title = "Verified Prompt Palette output";
        badges.prepend(vBadge);
      }
    } else {
      vBadge?.remove();
    }
    let fBadge = badges.querySelector(".pp-sidebar-gen-fav");
    if (record.favorite) {
      if (!fBadge) {
        fBadge = make("span", "pp-sidebar-gen-fav", "★");
        fBadge.title = "Favorite";
        if (vBadge) vBadge.after(fBadge);
        else badges.prepend(fBadge);
      }
    } else {
      fBadge?.remove();
    }
    let resTag = badges.querySelector(".pp-sidebar-gen-res");
    if (wantRes) {
      if (!resTag) {
        resTag = make("span", "pp-sidebar-gen-res");
        badges.append(resTag);
      }
      resTag.textContent = `${dims.width}×${dims.height}`;
    } else {
      resTag?.remove();
    }
  }

  function patchCard(card, record) {
    cardRecords.set(card, record);
    const isSelected = Boolean(selectedId && record.id === selectedId);
    card.classList.toggle("is-selected", isSelected);
    card.querySelector(".pp-sidebar-gen-card-select")?.setAttribute("aria-pressed", String(isSelected));
    const extra = selectedRecord?.id === record.id
      ? { ...selectedExtra, dimensions: imageDimensionsCache.get(record.id) }
      : { dimensions: imageDimensionsCache.get(record.id) };
    const meta = extractGenerationMetadata(record, extra);
    const dims = resolveRecordDimensions(record, meta);
    const activeMode = currentLayoutMode();
    const media = card.querySelector(".pp-sidebar-gen-media");
    if (media) syncCardBadges(media, record, dims, activeMode);
    const primaryLabel = activeMode === "list" && meta.positivePrompt
      ? meta.positivePrompt.replace(/\s+/g, " ").trim()
      : (record.image?.filename || "Generation");
    const titleEl = card.querySelector(".pp-sidebar-gen-filename");
    if (titleEl) titleEl.textContent = primaryLabel;
    const subParts = buildSubParts(record, meta, dims, activeMode, primaryLabel);
    const subEl = card.querySelector(".pp-sidebar-gen-sub");
    if (subEl) subEl.textContent = subParts.join(" · ") || (record.provenance === "verified" ? "Verified" : "Run context");
    const favQuick = card.querySelector(".pp-sidebar-gen-quick-fav");
    if (favQuick) {
      favQuick.textContent = record.favorite ? "★" : "☆";
      favQuick.title = record.favorite ? "Unfavorite" : "Favorite";
      favQuick.setAttribute("aria-label", `${favQuick.title} ${record.image?.filename || "generation"}`);
      favQuick.setAttribute("aria-pressed", String(Boolean(record.favorite)));
    }
    if (hoverPreview && !record.missing && record.image?.filename) {
      hoverPreview.bind(card, {
        title: record.image.filename,
        subtitle: subParts.join(" · "),
        prompt: meta.positivePrompt || "",
        image: generationImageUrl(record.image),
      });
    }
  }

  function renderCard(record, metrics) {
    const extra = selectedRecord?.id === record.id
      ? { ...selectedExtra, dimensions: imageDimensionsCache.get(record.id) }
      : { dimensions: imageDimensionsCache.get(record.id) };
    const meta = extractGenerationMetadata(record, extra);
    const card = make("article", "pp-sidebar-gen-card");
    card.setAttribute("role", "listitem");
    card.dataset.generationId = record.id;
    cardRecords.set(card, record);
    const isSelected = selectedId === record.id;
    card.classList.toggle("is-selected", isSelected);

    const media = make("div", "pp-sidebar-gen-media");

    if (!record.missing && record.image?.filename && metrics.images) {
      const img = make("img", "pp-sidebar-gen-thumb");
      img.alt = record.image.filename;
      img.loading = "lazy";
      img.decoding = "async";
      img.addEventListener("load", () => {
        if (disposed || !img.naturalWidth || !img.naturalHeight) return;
        const cur = cardRecords.get(card) || record;
        const nextDims = { width: img.naturalWidth, height: img.naturalHeight };
        rememberBounded(imageDimensionsCache, cur.id, nextDims, 2048);
        const activeMode = currentLayoutMode();
        if (activeMode === "masonry" || activeMode === "filmstrip") {
          syncCardBadges(media, cur, nextDims, activeMode);
        }
        collection?.notifyMediaDimensions(card, img.naturalWidth, img.naturalHeight);
        if (selectedRecord?.id === cur.id && !meta.resolution) {
          renderInspector();
        }
      }, { once: true });
      img.addEventListener("error", () => {
        collection?.notifyMediaError(card);
        img.replaceWith(make("span", "pp-sidebar-gen-fallback", "No preview"));
      }, { once: true });
      img.src = generationImageUrl(record.image);
      media.append(img);
    } else if (record.missing) {
      media.append(make("span", "pp-sidebar-gen-fallback", "Missing"));
    } else if (!metrics.images) {
      media.hidden = true;
    } else {
      media.append(make("span", "pp-sidebar-gen-fallback", "No preview"));
    }

    const dims = resolveRecordDimensions(record, meta);
    syncCardBadges(media, record, dims, metrics.mode);

    const selectBtn = btn("", () => {
      const cur = cardRecords.get(card) || record;
      inspectGeneration(cur.id);
    }, "pp-sidebar-gen-card-select");
    selectBtn.setAttribute("aria-label", `Inspect ${record.image?.filename || "generation"}`);
    selectBtn.setAttribute("aria-pressed", String(isSelected));

    const caption = make("div", "pp-sidebar-gen-caption");
    const primaryLabel = metrics.mode === "list" && meta.positivePrompt
      ? meta.positivePrompt.replace(/\s+/g, " ").trim()
      : (record.image?.filename || "Generation");
    const title = make("strong", "pp-sidebar-gen-filename", primaryLabel);
    const subParts = buildSubParts(record, meta, dims, metrics.mode, primaryLabel);

    const subtitle = make(
      "small",
      "pp-sidebar-gen-sub",
      subParts.join(" · ") || (record.provenance === "verified" ? "Verified" : "Run context")
    );
    caption.append(title, subtitle);

    if (metrics.mode === "filmstrip" && meta.positivePrompt) {
      caption.append(make("p", "pp-sidebar-gen-excerpt", meta.positivePrompt.replace(/\s+/g, " ").trim()));
    }

    selectBtn.append(caption);
    card.append(media, selectBtn);

    if (metrics.mode === "list") {
      const rowActions = make("div", "pp-sidebar-gen-row-actions");
      if (meta.positivePrompt) {
        const copyQuick = btn("", event => {
          event.stopPropagation();
          const cur = cardRecords.get(card) || record;
          const curMeta = extractGenerationMetadata(cur, { dimensions: imageDimensionsCache.get(cur.id) });
          copyValue(curMeta.positivePrompt || meta.positivePrompt, "positive prompt", copyQuick);
        }, "pp-sidebar-icon pp-sidebar-gen-quick-copy");
        copyQuick.innerHTML = svgIcon("copy", 13);
        copyQuick.title = "Copy positive prompt";
        copyQuick.setAttribute("aria-label", `Copy positive prompt for ${record.image?.filename || "generation"}`);
        rowActions.append(copyQuick);
      }
      const favQuick = btn(record.favorite ? "★" : "☆", event => {
        const cur = cardRecords.get(card) || record;
        toggleFavorite(cur, event);
      }, "pp-sidebar-icon pp-sidebar-gen-quick-fav");
      favQuick.title = record.favorite ? "Unfavorite" : "Favorite";
      favQuick.setAttribute("aria-label", `${favQuick.title} ${record.image?.filename || "generation"}`);
      favQuick.setAttribute("aria-pressed", String(Boolean(record.favorite)));
      rowActions.append(favQuick);
      card.append(rowActions);
    }

    if (hoverPreview && !record.missing && record.image?.filename) {
      hoverPreview.bind(card, {
        title: record.image.filename,
        subtitle: subParts.join(" · "),
        prompt: meta.positivePrompt || "",
        image: generationImageUrl(record.image),
      });
    }

    card.addEventListener("contextmenu", event => {
      event.preventDefault();
      event.stopPropagation();
      const cur = cardRecords.get(card) || record;
      const currentMeta = extractGenerationMetadata(
        selectedRecord?.id === cur.id ? selectedRecord : cur,
        selectedRecord?.id === cur.id
          ? { ...selectedExtra, dimensions: imageDimensionsCache.get(cur.id) }
          : { dimensions: imageDimensionsCache.get(cur.id) }
      );
      const items = [
        { label: "Inspect generation metadata", icon: "eye", group: "inspect", onSelect: () => inspectGeneration(cur.id) },
      ];
      if (currentMeta.positivePrompt) {
        items.push({ label: "Copy positive prompt", icon: "copy", group: "copy", onSelect: () => copyValue(currentMeta.positivePrompt, "positive prompt") });
        items.push({ label: "Use positive prompt in target", icon: "plus", group: "use", onSelect: () => usePromptInTarget(currentMeta.positivePrompt, "positive", cur) });
      }
      if (currentMeta.negativePrompt) {
        items.push({ label: "Copy negative prompt", icon: "copy", group: "copy", onSelect: () => copyValue(currentMeta.negativePrompt, "negative prompt") });
      }
      if (currentMeta.seed != null) {
        items.push({ label: `Copy seed (${currentMeta.seed})`, icon: "dice", group: "copy", onSelect: () => copyValue(currentMeta.seed, "seed") });
      }
      const completeInfo = formatCompletePromptInfo(currentMeta);
      if (completeInfo) {
        items.push({ label: "Copy complete prompt info", icon: "copy", group: "copy", onSelect: () => copyValue(completeInfo, "complete prompt information") });
      }
      if (currentMeta.hasWorkflow) {
        items.push({
          label: "Copy complete workflow",
          icon: "copy",
          group: "copy",
          onSelect: () => copyValue(JSON.stringify(currentMeta.workflow || currentMeta.promptGraph, null, 2), "complete workflow"),
        });
      }
      items.push({
        label: cur.favorite ? "Remove from favorites" : "Add to favorites",
        icon: "star",
        group: "item",
        onSelect: () => toggleFavorite(cur),
      });
      openCtxMenu(event.clientX, event.clientY, items);
    });

    return card;
  }

  function syncCardSelection() {
    if (disposed) return;
    section.dataset.inspecting = String(Boolean(selectedRecord));
    for (const card of listEl.querySelectorAll(".pp-sidebar-gen-card")) {
      const isSelected = Boolean(selectedId && card.dataset.generationId === selectedId);
      card.classList.toggle("is-selected", isSelected);
      card.querySelector(".pp-sidebar-gen-card-select")?.setAttribute("aria-pressed", String(isSelected));
    }
  }

  // Closes the inspector; when focus was inside it, hands focus back to the card that opened it
  // so keyboard users land where they started instead of at the top of the page.
  function closeInspector() {
    if (disposed || !selectedId) return;
    const returnId = selectedId;
    const hadFocus = flyoutEl.contains(document.activeElement);
    inspectController?.abort();
    loraEnrichController?.abort();
    selectedId = null;
    selectedRecord = null;
    selectedExtra = {};
    syncCardSelection();
    renderInspector();
    if (hadFocus) {
      const cards = listEl.querySelectorAll(".pp-sidebar-gen-card");
      const card = [...cards].find(el => el.dataset.generationId === returnId);
      card?.querySelector(".pp-sidebar-gen-card-select")?.focus();
    }
  }

  // Keyboard support is scoped to this panel's own element (no global listeners).
  const CARD_NAV_STEP = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 };
  section.addEventListener("keydown", event => {
    if (disposed || event.defaultPrevented || event.isComposing) return;
    const target = event.target instanceof Element ? event.target : null;
    if (!target || target.closest("dialog, [role='dialog'], [role='menu']")) return;

    if (event.key === "Escape") {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (target === searchInput && searchInput.value) {
        // First Esc clears the search; the next one closes the inspector.
        event.preventDefault();
        event.stopPropagation();
        searchInput.value = "";
        clearTimeout(searchDebounce);
        refresh(false, { resetScroll: true });
        return;
      }
      if (target instanceof HTMLSelectElement || !selectedId) return;
      event.preventDefault();
      event.stopPropagation();
      closeInspector();
      return;
    }

    // Arrow keys / Home / End move focus between cards in display order (selection stays explicit).
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const cardButton = target.closest(".pp-sidebar-gen-card-select");
    if (!cardButton || !(event.key in CARD_NAV_STEP || event.key === "Home" || event.key === "End")) return;
    const buttons = [...listEl.querySelectorAll(".pp-sidebar-gen-card-select")];
    const index = buttons.indexOf(cardButton);
    if (index < 0) return;
    let nextIndex = index;
    if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = buttons.length - 1;
    else nextIndex = Math.max(0, Math.min(buttons.length - 1, index + CARD_NAV_STEP[event.key]));
    event.preventDefault();
    event.stopPropagation();
    if (nextIndex !== index) buttons[nextIndex].focus();
  });

  function renderList({ itemsChanged = true, resetScroll = false } = {}) {
    if (disposed) return;
    const metrics = computeMetrics();
    countBadge.textContent = rows.length
      ? `${rows.length}${cursor ? "+" : ""}`
      : prefs?.enabled === false ? "Off" : "0";
    section.dataset.inspecting = String(Boolean(selectedRecord));

    if (!rows.length) {
      virtual.clear();
      collection = null;
      lastRenderedImages = null;
      lastRenderedItems = null;
      pendingItemsSync = false;
      applyMetricsToDOM(metrics);
      const hasFilters = Boolean(searchInput.value.trim() || favFilterBtn.getAttribute("aria-pressed") === "true" || dateSelect.value !== "0");
      const emptyMsg = hasFilters
        ? "No matching generations. Clear search or filters."
        : prefs?.enabled === false
          ? "Generation recording is off. Turn on 'Record Prompt Palette generations' in settings (⚙) or import ComfyUI history."
          : "No recent generations indexed yet. Queue a run or import existing ComfyUI history.";
      listEl.replaceChildren(make("p", "pp-sidebar-note pp-sidebar-gen-empty", emptyMsg));
      return;
    }

    if (metrics.rawWidth <= 0) {
      if (itemsChanged) pendingItemsSync = true;
      lastGeometry = "";
      return;
    }

    const needItemsUpdate = itemsChanged || pendingItemsSync || lastRenderedItems !== rows;
    pendingItemsSync = false;
    const oldScroll = listEl.scrollTop;
    applyMetricsToDOM(metrics);

    const virtualMode = metrics.mode === "gallery" ? "grid" : metrics.mode;
    const chromeHeight = metrics.listDensity === "tiny" ? 0 : metrics.listDensity === "micro" ? 30 : 44;
    const cardHeightForWidth = width => {
      if (!metrics.images) return (metrics.listDensity === "tiny" ? 28 : 44) + 8;
      const effectiveRatio = metrics.isNaturalRatio ? 1 : metrics.ratio;
      const mediaHeight = Math.max(28, Math.round(width / effectiveRatio));
      return mediaHeight + chromeHeight + 8;
    };
    const layoutOptions = {
      mode: virtualMode,
      minCardWidth: metrics.cardWidth,
      columnCount: virtualMode === "masonry" ? (metrics.fillRows ? metrics.columns : null) : (virtualMode === "grid" ? metrics.columns : 1),
      fixedCardWidth: virtualMode === "masonry" ? !metrics.fillRows : virtualMode === "grid",
      imageAspectRatio: metrics.images ? (metrics.isNaturalRatio ? 1 : metrics.ratio) : 0,
      estimateRowHeight: Math.max(32, Math.round(metrics.rowHeight)),
      estimateCardHeight: cardHeightForWidth(metrics.cardWidth),
      estimateChromeHeight: chromeHeight,
      cardHeightForWidth,
      gap: 8,
      itemKey: record => record.id,
      getItemRatio: record => {
        const d = resolveRecordDimensions(record, null);
        return d ? { width: d.width, height: d.height } : null;
      },
      thumbnailUrl: record => (!record.missing && record.image?.filename) ? generationImageUrl(record.image) : "",
    };

    if (!collection) {
      listEl.replaceChildren();
      collection = virtual.mount(listEl, {
        ...layoutOptions,
        items: rows,
        renderItem: record => renderCard(record, metrics),
        preserveViewport: true,
        styleDeclaration: scope.declaration,
        releaseStyle: el => scope.release(el),
        captureFocus: () => captureSidebarFocus(listEl, ".pp-sidebar-gen-card", "generationId"),
        restoreFocus: snapshot => restoreSidebarFocus(listEl, ".pp-sidebar-gen-card", "generationId", snapshot),
      });
    } else {
      const modeChanged = virtualMode !== collection.mode;
      const imagesChanged = lastRenderedImages !== null && lastRenderedImages !== metrics.images;
      const anchor = !needItemsUpdate && !modeChanged ? virtual.captureViewportAnchor() : null;
      collection.renderItem = record => renderCard(record, metrics);
      collection.updateLayout(layoutOptions);
      if (imagesChanged) {
        collection.setItems(rows);
      } else if (modeChanged) {
        if (needItemsUpdate) collection.setItems(rows);
      } else if (needItemsUpdate) {
        collection.updateItems(rows, { patchNode: patchCard });
      }
      collection.render();
      if (resetScroll) listEl.scrollTop = 0;
      else if (anchor) virtual.restoreViewportAnchor(anchor);
      else if (!modeChanged) listEl.scrollTop = oldScroll;
      virtual.refresh();
    }

    lastRenderedImages = metrics.images;
    lastRenderedItems = rows;
  }

  function refreshAppearance({ force = false } = {}) {
    if (disposed) return;
    if (!flyoutEl.hidden) {
      syncFlyoutTheme();
      placeFlyout(true);
    }
    const m = computeMetrics();
    if (m.rawWidth <= 0) {
      lastGeometry = "";
      if (!rows.length) renderList({ itemsChanged: false });
      return;
    }
    const geometry = `${m.mode}|${m.scale}|${m.columns}|${Math.round(m.cardWidth)}|${Math.round(m.rowHeight)}|${Math.round(m.availWidth)}|${m.aspect}|${m.ratio}|${m.fillRows}|${m.images}|${m.fit}|${m.listDensity}`;
    if (!force && geometry === lastGeometry && collection) {
      applyMetricsToDOM(m);
      return;
    }
    lastGeometry = geometry;
    renderList({ itemsChanged: false });
  }

  const listResize = new ResizeObserver(() => {
    if (!disposed && visible && (isTabMode || isOpen)) {
      refreshAppearance();
      if (selectedRecord && flyoutEl.hidden && flyoutAnchor().getBoundingClientRect().width >= 8) {
        showFlyout();
      }
    }
  });
  listResize.observe(listEl);

  function lookupCachedLoraInfo(lora) {
    if (!lora) return undefined;
    if (lora.filename && loraInfoCache.has(lora.filename)) return loraInfoCache.get(lora.filename);
    if (lora.name && loraInfoCache.has(lora.name)) return loraInfoCache.get(lora.name);
    return undefined;
  }

  async function enrichLorasForMeta(meta, recordId) {
    if (disposed || !meta?.loras?.length || typeof API.loraBatchInfo !== "function") return;
    const missing = [];
    const seenReq = new Set();
    for (const lora of meta.loras) {
      const lookup = lora.filename || lora.name;
      if (!lookup || seenReq.has(lookup) || lookupCachedLoraInfo(lora) !== undefined) continue;
      seenReq.add(lookup);
      missing.push(lookup);
    }
    if (!missing.length) return;
    const seq = ++loraEnrichSequence;
    loraEnrichController?.abort();
    const controller = (loraEnrichController = new AbortController());
    try {
      const data = await API.loraBatchInfo(missing, { signal: controller.signal });
      if (disposed || controller.signal.aborted || seq !== loraEnrichSequence) return;
      const infoMap = data?.info && typeof data.info === "object" ? data.info : {};
      for (const reqName of missing) {
        const entry = infoMap[reqName] || null;
        rememberBounded(loraInfoCache, reqName, entry, 256);
        if (entry?.filename && entry.filename !== reqName) {
          rememberBounded(loraInfoCache, entry.filename, entry, 256);
        }
      }
      if (selectedRecord?.id === recordId) {
        renderInspector();
      }
    } catch {
      /* Local LoRA metadata enrichment is optional; keep base display. */
    } finally {
      if (loraEnrichController === controller) loraEnrichController = null;
    }
  }

  function renderPromptVariantBlock({ channel, kind, label, badgeText, text, record }) {
    const block = make("div", "pp-sidebar-gen-prompt-block");
    block.dataset.promptChannel = channel;
    block.dataset.promptKind = kind;

    const headRow = make("div", "pp-sidebar-gen-prompt-head");
    const labelGroup = make("div", "pp-gen-prompt-label-group");
    labelGroup.append(make("span", "pp-sidebar-gen-label", label));
    if (badgeText) {
      labelGroup.append(make("span", "pp-gen-prompt-kind-pill", badgeText));
    }

    const actions = make("div", "pp-sidebar-gen-btn-row");
    const rolePrefix = kind === "raw" ? "raw-" : "";
    const copyBtn = btn("Copy", e => copyValue(text, `${label.toLowerCase()}`, e.currentTarget), "pp-sidebar-gen-copy-btn");
    copyBtn.dataset.copyRole = `${rolePrefix}${channel}`;
    copyBtn.setAttribute("aria-label", `Copy ${label.toLowerCase()}`);
    actions.append(copyBtn);

    if (insertPrompt || restore) {
      const useBtn = btn("Use", e => usePromptInTarget(text, channel, record, e.currentTarget), "pp-sidebar-gen-copy-btn pp-sidebar-gen-use-btn");
      useBtn.setAttribute("aria-label", `Use ${label.toLowerCase()} in target node`);
      useBtn.title = kind === "raw"
        ? "Send original raw input prompt (with wildcards and syntax) to target node"
        : "Send final resolved prompt to target node";
      actions.append(useBtn);
    }

    headRow.append(labelGroup, actions);
    const pre = make("pre", "pp-sidebar-gen-prompt-text", text);
    pre.dataset.promptText = `${rolePrefix}${channel}`;
    block.append(headRow, pre);
    return block;
  }

  function renderInspector() {
    if (disposed) return;
    if (!selectedRecord) {
      hideFlyout();
      delete flyoutEl.dataset.recordId;
      flyBody.replaceChildren();
      flyHeadTools.replaceChildren();
      flyFoot.replaceChildren();
      flyNameBadge.textContent = "";
      section.dataset.inspecting = "false";
      return;
    }

    const record = selectedRecord;
    const meta = extractGenerationMetadata(record, {
      ...selectedExtra,
      dimensions: imageDimensionsCache.get(record.id),
    });

    section.dataset.inspecting = "true";
    flyNameBadge.textContent = record.image?.filename || "Generation";
    flyNameBadge.title = record.image?.filename || "Generation";

    flyHeadTools.replaceChildren();
    const favBtn = btn(record.favorite ? "★" : "☆", e => toggleFavorite(record, e), "pp-sidebar-icon pp-sidebar-gen-fav-btn");
    favBtn.title = record.favorite ? "Remove from favorites" : "Add to favorites";
    favBtn.setAttribute("aria-label", "Favorite generation");
    favBtn.setAttribute("aria-pressed", String(Boolean(record.favorite)));
    flyHeadTools.append(favBtn);

    // Ensure selectedNodeIds has valid defaults
    const validIds = new Set(meta.workflowComponents.map(c => String(c.id)));
    for (const id of [...selectedNodeIds]) {
      if (!validIds.has(id)) selectedNodeIds.delete(id);
    }
    if (!selectedNodeIds.size && validIds.size) {
      for (const id of validIds) selectedNodeIds.add(id);
    }

    const sameRecord = flyoutEl.dataset.recordId === String(record.id);
    const prevScroll = sameRecord ? flyBody.scrollTop : 0;
    flyoutEl.dataset.recordId = String(record.id);

    flyBody.replaceChildren();

    // 1. Civitai-style Hero: artwork, identity badges, quick stat tiles, primary actions
    const hero = make("header", "pp-gen-hero");
    const hasArtwork = !record.missing && Boolean(record.image?.filename);
    hero.dataset.media = hasArtwork ? "image" : "none";
    if (hasArtwork) {
      const thumbLink = make("a", "pp-gen-hero-art");
      thumbLink.href = generationImageUrl(record.image);
      thumbLink.target = "_blank";
      thumbLink.rel = "noopener";
      thumbLink.title = "Open full-resolution image in new tab";
      thumbLink.setAttribute("aria-label", "Open full-resolution image in new tab");
      const miniThumb = make("img", "pp-gen-hero-img");
      miniThumb.src = generationImageUrl(record.image);
      miniThumb.alt = record.image.filename || "";
      miniThumb.decoding = "async";
      const artWidth = Number(meta.width), artHeight = Number(meta.height);
      if (artWidth > 0 && artHeight > 0) {
        miniThumb.width = artWidth;
        miniThumb.height = artHeight;
      }
      miniThumb.addEventListener("error", () => {
        thumbLink.remove();
        hero.dataset.media = "none";
      }, { once: true });
      thumbLink.append(miniThumb);
      hero.append(thumbLink);
    }

    const heroInfo = make("div", "pp-gen-hero-info");
    const heroTitle = make("strong", "pp-gen-hero-title", record.image?.filename || "Generation");
    heroTitle.title = record.image?.filename || "Generation";
    heroInfo.append(heroTitle);

    const badgeList = make("div", "pp-gen-badge-list");
    badgeList.append(record.provenance === "verified"
      ? pill("✓ Verified", "verified", "One Prompt Palette node fed this image, so its recorded prompt and seed are attributed to it.")
      : pill("Run context", "context", "Prompts and parameters come from the run that produced this image, not from a single Prompt Palette node."));
    if (meta.model) badgeList.append(pill(shortModelName(meta.model), "model", `Model: ${meta.model}`));
    if (meta.resolution) badgeList.append(pill(meta.resolution, "dims", "Image dimensions"));
    heroInfo.append(badgeList);

    if (record.completed_at) {
      heroInfo.append(make("small", "pp-gen-hero-sub", new Date(record.completed_at).toLocaleString([], {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })));
    }

    // Civitai-style quick stat strip (up to 4 most useful scannable facts)
    const quickStats = [];
    if (meta.seed != null) quickStats.push({ label: "Seed", value: String(meta.seed), copy: String(meta.seed) });
    if (meta.sampler) quickStats.push({ label: "Sampler", value: meta.sampler, copy: formatSamplerScheduler(meta) || meta.sampler });
    if (meta.steps != null) quickStats.push({ label: "Steps", value: String(meta.steps), copy: String(meta.steps) });
    if (meta.cfg != null) quickStats.push({ label: "CFG", value: String(meta.cfg), copy: String(meta.cfg) });
    else if (meta.guidance != null) quickStats.push({ label: "Guidance", value: String(meta.guidance), copy: String(meta.guidance) });
    if (quickStats.length < 4 && meta.loras.length) {
      quickStats.push({
        label: "LoRAs",
        value: String(meta.loras.length),
        copy: meta.loras.map(loraTagSyntax).join(" "),
      });
    }
    if (quickStats.length) {
      const statRow = make("div", "pp-gen-stat-row");
      for (const st of quickStats) {
        const statBtn = btn("", e => copyValue(st.copy, st.label.toLowerCase(), e.currentTarget), "pp-gen-stat");
        statBtn.title = `Click to copy ${st.label}: ${st.copy}`;
        statBtn.setAttribute("aria-label", `Copy ${st.label}: ${st.copy}`);
        statBtn.append(make("b", "", st.value), make("small", "", st.label));
        statRow.append(statBtn);
      }
      heroInfo.append(statRow);
    }

    // Hero reusable action toolbar
    const quickBar = make("div", "pp-gen-hero-toolbar");
    const completePromptText = formatCompletePromptInfo(meta);
    if (completePromptText) {
      const copyAllPromptBtn = btn("Copy prompt info", e => copyValue(completePromptText, "complete prompt information", e.currentTarget), "pp-sidebar-gen-action");
      copyAllPromptBtn.dataset.copyRole = "complete-prompt";
      copyAllPromptBtn.setAttribute("aria-label", "Copy complete prompt information");
      quickBar.append(copyAllPromptBtn);
    }
    if (meta.hasWorkflow) {
      const wfJson = JSON.stringify(meta.workflow || meta.promptGraph, null, 2);
      const copyWfQuickBtn = btn("Copy workflow", e => copyValue(wfJson, "complete workflow", e.currentTarget), "pp-sidebar-gen-action");
      copyWfQuickBtn.dataset.copyRole = "complete-workflow-quick";
      copyWfQuickBtn.setAttribute("aria-label", "Copy complete workflow");
      quickBar.append(copyWfQuickBtn);
    }
    const canRefine = historyRefinementSources(record, { includeFields: false }).length > 0 || historyRefinementSources(record).length > 0;
    const refineAdapter = getNode?.()?._ppHistoryRefinement;
    const refineReason = !getNode
      ? ""
      : !refineAdapter?.alive?.()
        ? "Choose an open Prompt Palette or Combinatorial node in 'Insert into' first."
        : refineAdapter.isRefining?.()
          ? "Commit or Cancel the active refinement in the target node first."
          : "";
    if (canRefine && getNode) {
      const refineBtn = btn("Refine in node…", () => openRefinement(record), "pp-sidebar-gen-action pp-sidebar-gen-action--primary");
      refineBtn.disabled = Boolean(refineReason);
      refineBtn.title = refineReason || "Open recorded prompt data in the target node with Commit / Cancel";
      refineBtn.setAttribute("aria-label", "Refine generation in target node");
      if (refineReason) refineBtn.setAttribute("aria-description", refineReason);
      quickBar.append(refineBtn);
    }
    if (quickBar.childNodes.length) heroInfo.append(quickBar);

    hero.append(heroInfo);
    flyBody.append(hero);

    // 2. Prompts & Wildcard Selections Section (always preserves Raw Input vs Final Resolved)
    if (meta.hasPrompts) {
      const promptsGroup = make("section", "pp-gen-section");
      promptsGroup.dataset.section = "prompts";
      const promptsHead = make("div", "pp-gen-section-head");
      promptsHead.append(make("span", "pp-sidebar-gen-group-title", "Prompts"));
      promptsGroup.append(promptsHead);

      const promptsBody = make("div", "pp-sidebar-gen-group-body");

      // Positive prompts: show both Raw Input Prompt and Final Resolved Prompt without overwriting either
      if (meta.authoredPositive) {
        const posSame = Boolean(meta.resolvedPositive && meta.authoredPositive === meta.resolvedPositive);
        promptsBody.append(renderPromptVariantBlock({
          channel: "positive",
          kind: "raw",
          label: "Raw Input Prompt",
          badgeText: posSame ? "Matches resolved" : "Original input",
          text: meta.authoredPositive,
          record,
        }));
      }
      if (meta.resolvedPositive) {
        promptsBody.append(renderPromptVariantBlock({
          channel: "positive",
          kind: "resolved",
          label: "Final Resolved Prompt",
          badgeText: meta.clipTokenCount != null && meta.clipTokenCount >= 0
            ? `${meta.clipTokenCount} CLIP tokens`
            : "Expanded output",
          text: meta.resolvedPositive,
          record,
        }));
      }

      // Negative prompts: show both Raw Negative Input and Final Resolved Negative when available
      if (meta.authoredNegative) {
        const negSame = Boolean(meta.resolvedNegative && meta.authoredNegative === meta.resolvedNegative);
        promptsBody.append(renderPromptVariantBlock({
          channel: "negative",
          kind: "raw",
          label: "Raw Negative Input",
          badgeText: negSame ? "Matches resolved" : "Original input",
          text: meta.authoredNegative,
          record,
        }));
      }
      if (meta.resolvedNegative) {
        promptsBody.append(renderPromptVariantBlock({
          channel: "negative",
          kind: "resolved",
          label: "Final Resolved Negative",
          badgeText: "Expanded output",
          text: meta.resolvedNegative,
          record,
        }));
      }

      // Wildcard picks, brace choices, and resolved variables
      if (meta.selections.length || meta.wildcardsUsed.length || meta.variableEntries.length) {
        const wcBlock = make("div", "pp-sidebar-gen-tags-block");
        wcBlock.dataset.resource = "wildcard";
        const wcHead = make("div", "pp-sidebar-gen-prompt-head");
        const selCount = meta.selections.length || meta.wildcardsUsed.length;
        wcHead.append(make("span", "pp-sidebar-gen-label", `Wildcards & Selections (${selCount})`));
        const wcHeadActions = make("div", "pp-sidebar-gen-btn-row");
        if (meta.selections.length) {
          const allSelText = meta.selections.map(sel => {
            if (sel.kind === "wildcard") return `__${sel.mode || ""}${sel.name}__ -> ${sel.chosen || ""}`;
            if (sel.kind === "brace") return `${sel.raw || "{choice}"} -> ${sel.chosen || ""}`;
            return `${sel.open_expr || sel.block || "conditional"} -> ${sel.chosen_expr || sel.chosen_tag || ""}`;
          }).join("\n");
          const copySelBtn = btn("Copy selections", e => copyValue(allSelText, "wildcard and choice selections", e.currentTarget), "pp-sidebar-gen-copy-btn");
          copySelBtn.setAttribute("aria-label", "Copy wildcard and choice selections");
          wcHeadActions.append(copySelBtn);
        }
        if (meta.wildcardsUsed.length) {
          const allWcText = meta.wildcardsUsed.map(w => `__${w.replace(/^__|__$/g, "")}__`).join(", ");
          const copyWcBtn = btn("Copy wildcards", e => copyValue(allWcText, "wildcards", e.currentTarget), "pp-sidebar-gen-copy-btn");
          copyWcBtn.dataset.copyRole = "wildcards";
          copyWcBtn.setAttribute("aria-label", "Copy wildcards");
          wcHeadActions.append(copyWcBtn);
        }
        if (wcHeadActions.childNodes.length) wcHead.append(wcHeadActions);
        wcBlock.append(wcHead);

        if (meta.selections.length) {
          const selList = make("div", "pp-gen-selection-list");
          for (const sel of meta.selections) {
            if (sel.kind === "wildcard") {
              const token = `__${sel.mode || ""}${sel.name}__`;
              const row = btn("", e => copyValue(sel.chosen || token, `wildcard ${sel.name}`, e.currentTarget), "pp-gen-selection-row");
              row.dataset.selectionKind = "wildcard";
              row.title = sel.chosen ? `Click to copy picked text: ${sel.chosen}` : `Click to copy ${token}`;
              row.append(
                make("span", "pp-gen-selection-source", token),
                make("span", "pp-gen-selection-arrow", "→"),
                make("span", "pp-gen-selection-value", sel.chosen || "(resolved)")
              );
              selList.append(row);
            } else if (sel.kind === "brace") {
              const srcLabel = sel.raw || (Array.isArray(sel.options) ? `{${sel.options.join("|")}}` : "{choice}");
              const chosenText = sel.chosen || (Array.isArray(sel.chosen_options) ? sel.chosen_options.join(", ") : "");
              const row = btn("", e => copyValue(chosenText || srcLabel, "selected choice", e.currentTarget), "pp-gen-selection-row");
              row.dataset.selectionKind = "brace";
              row.title = `${srcLabel} → ${chosenText}`;
              row.append(
                make("span", "pp-gen-selection-source", srcLabel),
                make("span", "pp-gen-selection-arrow", "→"),
                make("span", "pp-gen-selection-value", chosenText)
              );
              selList.append(row);
            } else if (sel.kind === "conditional") {
              const srcLabel = sel.open_expr ? `[${sel.block} ${sel.open_expr}]` : `[${sel.block || "if"}]`;
              const chosenText = sel.chosen_expr ? `${sel.chosen_tag}: ${sel.chosen_expr}` : (sel.chosen_tag || "taken");
              const row = btn("", e => copyValue(chosenText, "conditional branch", e.currentTarget), "pp-gen-selection-row");
              row.dataset.selectionKind = "conditional";
              row.append(
                make("span", "pp-gen-selection-source", srcLabel),
                make("span", "pp-gen-selection-arrow", "→"),
                make("span", "pp-gen-selection-value", chosenText)
              );
              selList.append(row);
            }
          }
          wcBlock.append(selList);
        }

        if (meta.variableEntries.length) {
          const varRow = make("div", "pp-sidebar-gen-chips");
          for (const entry of meta.variableEntries) {
            const chip = btn(`$${entry.name} = ${entry.value}`, e => copyValue(entry.value, `variable $${entry.name}`, e.currentTarget), "pp-sidebar-gen-chip pp-gen-chip--var");
            chip.title = `Click to copy value for $${entry.name}`;
            varRow.append(chip);
          }
          wcBlock.append(varRow);
        }

        if (meta.wildcardsUsed.length) {
          const chips = make("div", "pp-sidebar-gen-chips");
          for (const w of meta.wildcardsUsed) {
            const cleanW = w.replace(/^__|__$/g, "");
            const token = `__${cleanW}__`;
            const chip = btn(cleanW, e => copyValue(token, `wildcard ${cleanW}`, e.currentTarget), "pp-sidebar-gen-chip pp-sidebar-gen-chip--wildcard");
            chip.title = `Click to copy ${token}`;
            chips.append(chip);
          }
          wcBlock.append(chips);
        }

        promptsBody.append(wcBlock);
      }

      promptsGroup.append(promptsBody);
      flyBody.append(promptsGroup);
    }

    // 3. Models & LoRAs Section (with exact applied strengths, model compatibility & trigger words)
    if (meta.hasModelsOrLoras) {
      const resourcesGroup = make("section", "pp-gen-section");
      resourcesGroup.dataset.section = "loras";
      const resourcesHead = make("div", "pp-gen-section-head");
      resourcesHead.append(make("span", "pp-sidebar-gen-group-title", "Models & LoRAs"));
      if (meta.loras.length) {
        resourcesHead.append(make("span", "pp-sidebar-gen-badge", `${meta.loras.length} LoRA${meta.loras.length === 1 ? "" : "s"}`));
      }
      resourcesGroup.append(resourcesHead);

      const resourcesBody = make("div", "pp-sidebar-gen-group-body");

      const modelRows = [
        meta.model ? { key: "model", label: "Checkpoint / Model", value: meta.model } : null,
        meta.clip ? { key: "clip", label: "CLIP", value: meta.clip } : null,
        meta.vae ? { key: "vae", label: "VAE", value: meta.vae } : null,
      ].filter(Boolean);

      if (modelRows.length) {
        const modelLedger = make("div", "pp-gen-model-list");
        for (const item of modelRows) {
          const row = btn("", e => copyValue(item.value, item.label, e.currentTarget), "pp-gen-model-row");
          row.title = `Click to copy ${item.label}: ${item.value}`;
          row.append(
            make("span", "pp-gen-model-label", item.label),
            make("strong", "pp-gen-model-value", item.value)
          );
          modelLedger.append(row);
        }
        resourcesBody.append(modelLedger);
      }

      if (meta.loras.length) {
        const loraBlock = make("div", "pp-sidebar-gen-tags-block");
        loraBlock.dataset.resource = "lora";
        const loraHead = make("div", "pp-sidebar-gen-prompt-head");
        loraHead.append(make("span", "pp-sidebar-gen-label", `LoRAs (${meta.loras.length})`));

        const allLoraSyntax = meta.loras.map(loraTagSyntax).join(" ");
        const loraHeadActions = make("div", "pp-sidebar-gen-btn-row");
        const copyLorasBtn = btn("Copy LoRAs", e => copyValue(allLoraSyntax, "LoRA tags", e.currentTarget), "pp-sidebar-gen-copy-btn");
        copyLorasBtn.dataset.copyRole = "loras";
        copyLorasBtn.setAttribute("aria-label", "Copy all LoRAs");
        loraHeadActions.append(copyLorasBtn);

        if (insertPrompt) {
          const insertLorasBtn = btn("Insert LoRAs", e => usePromptInTarget(allLoraSyntax, "positive", record, e.currentTarget), "pp-sidebar-gen-copy-btn pp-sidebar-gen-use-btn");
          insertLorasBtn.setAttribute("aria-label", "Insert LoRA tags into target prompt");
          insertLorasBtn.title = "Insert exact LoRA tags into the active target prompt";
          loraHeadActions.append(insertLorasBtn);
        }
        loraHead.append(loraHeadActions);

        const loraList = make("div", "pp-gen-lora-list");
        const loraTheme = loadTheme();
        for (const lora of meta.loras) {
          const tag = loraTagSyntax(lora);
          const displayTarget = lora.filename || lora.name;
          const shortName = String(displayTarget).split(/[\\/]/).pop().replace(/\.[^.]+$/, "");
          const localInfo = lookupCachedLoraInfo(lora);

          const card = make("article", "pp-gen-lora-card");
          card.dataset.loraName = String(lora.name);
          scope.category(card, `lora:${loraIdentity(displayTarget)}`, colorForLora(displayTarget, loraTheme));

          const topRow = make("div", "pp-gen-lora-top");
          const titleWrap = make("div", "pp-gen-lora-name-wrap");
          const nameEl = make("strong", "pp-gen-lora-name", shortName);
          nameEl.title = displayTarget;
          titleWrap.append(nameEl);

          const badgeRow = make("div", "pp-gen-lora-badges");
          badgeRow.append(make("span", "pp-gen-lora-strength", formatLoraStrengthLabel(lora)));
          badgeRow.append(make("span", "pp-gen-lora-status", formatLoraStatusLabel(lora.status)));
          if (lora.source === "negative") {
            badgeRow.append(make("span", "pp-gen-lora-source", "Negative"));
          }
          if (localInfo?.base_model) {
            badgeRow.append(make("span", "pp-gen-lora-base", localInfo.base_model));
          }

          const copyTagBtn = btn("Copy tag", e => copyValue(tag, `LoRA ${shortName}`, e.currentTarget), "pp-sidebar-gen-copy-btn");
          copyTagBtn.title = `Copy ${tag}`;
          copyTagBtn.setAttribute("aria-label", `Copy ${tag}`);

          topRow.append(titleWrap, copyTagBtn);
          card.append(topRow, badgeRow);

          if (lora.authoredModelStrength != null || lora.authoredClipStrength != null) {
            const authoredStr = lora.authoredClipStrength != null && lora.authoredClipStrength !== (lora.authoredModelStrength ?? lora.modelStrength)
              ? `${lora.authoredModelStrength ?? lora.modelStrength} / ${lora.authoredClipStrength}`
              : String(lora.authoredModelStrength ?? lora.modelStrength);
            card.append(make("small", "pp-gen-lora-note", `Authored tag strength: ${authoredStr} · Applied: ${formatLoraStrengthLabel(lora)}`));
          }

          if (localInfo?.triggers?.length) {
            const trigWrap = make("div", "pp-gen-lora-triggers");
            const trigHead = make("div", "pp-gen-lora-triggers-head");
            trigHead.append(make("span", "pp-gen-lora-triggers-label", `Triggers (${localInfo.triggers.length})`));
            const copyTrigBtn = btn(
              "Copy triggers",
              e => copyValue(localInfo.triggers.join(", "), `triggers for ${shortName}`, e.currentTarget),
              "pp-sidebar-gen-copy-btn"
            );
            trigHead.append(copyTrigBtn);
            const trigChips = make("div", "pp-sidebar-gen-chips");
            for (const trig of localInfo.triggers) {
              const tChip = btn(trig, e => copyValue(trig, `trigger ${trig}`, e.currentTarget), "pp-sidebar-gen-chip pp-gen-chip--trigger");
              tChip.title = `Click to copy trigger word "${trig}"`;
              trigChips.append(tChip);
            }
            trigWrap.append(trigHead, trigChips);
            card.append(trigWrap);
          }

          loraList.append(card);
        }

        loraBlock.append(loraHead, loraList);
        resourcesBody.append(loraBlock);
      }

      resourcesGroup.append(resourcesBody);
      flyBody.append(resourcesGroup);
      enrichLorasForMeta(meta, record.id);
    }

    // 4. Generation Settings Section (Precision Tabular Spec Ledger)
    if (meta.hasParameters) {
      const paramsGroup = make("section", "pp-gen-section");
      paramsGroup.dataset.section = "parameters";
      const paramsHead = make("div", "pp-gen-section-head");
      paramsHead.append(
        make("span", "pp-sidebar-gen-group-title", "Generation Settings"),
        make("span", "pp-sidebar-gen-badge", String(meta.parameterEntries.length))
      );
      paramsGroup.append(paramsHead);

      const paramsBody = make("div", "pp-sidebar-gen-group-body");
      const paramActions = make("div", "pp-sidebar-gen-btn-row");

      const samplerSchedText = formatSamplerScheduler(meta);
      if (samplerSchedText) {
        const copySamplerSchedBtn = btn(
          "Copy sampler & scheduler",
          e => copyValue(samplerSchedText, "sampler and scheduler", e.currentTarget),
          "pp-sidebar-gen-copy-btn"
        );
        copySamplerSchedBtn.dataset.copyRole = "sampler-scheduler";
        copySamplerSchedBtn.setAttribute("aria-label", "Copy sampler and scheduler");
        paramActions.append(copySamplerSchedBtn);
      }

      const allParamsText = formatParametersSummary(meta);
      if (allParamsText) {
        const copyAllParamsBtn = btn(
          "Copy all parameters",
          e => copyValue(allParamsText, "all generation parameters", e.currentTarget),
          "pp-sidebar-gen-copy-btn"
        );
        copyAllParamsBtn.dataset.copyRole = "all-parameters";
        copyAllParamsBtn.setAttribute("aria-label", "Copy all generation parameters");
        paramActions.append(copyAllParamsBtn);
      }
      if (paramActions.childNodes.length) paramsBody.append(paramActions);

      const paramGrid = make("div", "pp-sidebar-gen-params");
      meta.parameterEntries.forEach(entry => {
        const itemBtn = btn("", e => copyValue(entry.copyValue, entry.label, e.currentTarget), "pp-sidebar-gen-param");
        itemBtn.dataset.paramKey = entry.key;
        if (WIDE_PARAM_KEYS.has(entry.key) || String(entry.value).length > 12) {
          itemBtn.classList.add("is-wide");
        }
        itemBtn.title = `Copy ${entry.label}: ${entry.copyValue}`;
        itemBtn.setAttribute("aria-label", `Copy ${entry.label}`);
        itemBtn.append(
          make("span", "pp-sidebar-gen-param-label", entry.label),
          make("strong", "pp-sidebar-gen-param-value", entry.value)
        );
        paramGrid.append(itemBtn);
      });
      paramsBody.append(paramGrid);
      paramsGroup.append(paramsBody);
      flyBody.append(paramsGroup);
    }

    // 5. Notes & Tags (if recorded)
    const cleanNotes = typeof record.notes === "string" ? record.notes.trim() : "";
    const recordTags = Array.isArray(record.tags) ? record.tags.filter(t => typeof t === "string" && t.trim()) : [];
    if (cleanNotes || recordTags.length) {
      const notesGroup = make("section", "pp-gen-section");
      notesGroup.dataset.section = "notes";
      const notesHead = make("div", "pp-gen-section-head");
      notesHead.append(make("span", "pp-sidebar-gen-group-title", "Notes & Tags"));
      if (cleanNotes) {
        notesHead.append(btn("Copy notes", e => copyValue(cleanNotes, "generation notes", e.currentTarget), "pp-sidebar-gen-copy-btn"));
      }
      notesGroup.append(notesHead);
      const notesBody = make("div", "pp-sidebar-gen-group-body");
      if (cleanNotes) notesBody.append(make("p", "pp-gen-notes-text", cleanNotes));
      if (recordTags.length) {
        const tagChips = make("div", "pp-sidebar-gen-chips");
        for (const tag of recordTags) {
          const tChip = btn(tag, e => copyValue(tag, `tag ${tag}`, e.currentTarget), "pp-sidebar-gen-chip");
          tChip.title = `Click to copy "${tag}"`;
          tagChips.append(tChip);
        }
        notesBody.append(tagChips);
      }
      notesGroup.append(notesBody);
      flyBody.append(notesGroup);
    }

    // 6. Workflow & Node Components Section (Collapsible so prompts/LoRAs/settings stay primary)
    if (meta.hasWorkflow || meta.workflowComponents.length > 0) {
      const wfGroup = make("details", "pp-gen-section pp-sidebar-gen-group");
      wfGroup.dataset.section = "workflow";
      wfGroup.open = workflowSectionOpen;
      wfGroup.addEventListener("toggle", () => {
        workflowSectionOpen = wfGroup.open;
      });
      const wfSummary = make("summary", "pp-sidebar-gen-group-summary");
      wfSummary.append(
        make("span", "pp-sidebar-gen-group-title", "Workflow & Nodes"),
        make("span", "pp-sidebar-gen-badge", String(meta.workflowComponents.length))
      );
      wfGroup.append(wfSummary);

      const wfBody = make("div", "pp-sidebar-gen-group-body");
      const wfActions = make("div", "pp-sidebar-gen-btn-row");

      if (meta.workflow || meta.promptGraph) {
        const fullWfText = JSON.stringify(meta.workflow || meta.promptGraph, null, 2);
        const copyFullWfBtn = btn(
          "Copy complete workflow",
          e => copyValue(fullWfText, "complete workflow", e.currentTarget),
          "pp-sidebar-gen-copy-btn"
        );
        copyFullWfBtn.dataset.copyRole = "workflow";
        copyFullWfBtn.setAttribute("aria-label", "Copy complete workflow");
        wfActions.append(copyFullWfBtn);
      }

      if (meta.promptGraph && meta.workflow) {
        const apiGraphText = JSON.stringify(meta.promptGraph, null, 2);
        const copyApiBtn = btn(
          "Copy API prompt",
          e => copyValue(apiGraphText, "executable API prompt", e.currentTarget),
          "pp-sidebar-gen-copy-btn"
        );
        copyApiBtn.dataset.copyRole = "prompt-graph";
        copyApiBtn.setAttribute("aria-label", "Copy executable prompt graph");
        wfActions.append(copyApiBtn);
      }

      let copySubsetBtn = null;
      const syncSubsetBtn = () => {
        if (!copySubsetBtn) return;
        const count = selectedNodeIds.size;
        copySubsetBtn.disabled = count === 0;
        copySubsetBtn.textContent = `Copy selected portion (${count})`;
        delete copySubsetBtn.dataset.originalLabel;
      };

      if (meta.workflowComponents.length > 0) {
        copySubsetBtn = btn(
          `Copy selected portion (${selectedNodeIds.size})`,
          e => {
            const subsetText = buildWorkflowSubset(meta, selectedNodeIds);
            copyValue(subsetText, `selected workflow portion (${selectedNodeIds.size} node${selectedNodeIds.size === 1 ? "" : "s"})`, e.currentTarget);
          },
          "pp-sidebar-gen-copy-btn"
        );
        copySubsetBtn.dataset.copyRole = "workflow-subset";
        copySubsetBtn.setAttribute("aria-label", "Copy selected workflow portion");
        wfActions.append(copySubsetBtn);
      }

      if (wfActions.childNodes.length) wfBody.append(wfActions);

      if (meta.workflowComponents.length > 1) {
        const filterRow = make("div", "pp-sidebar-gen-btn-row pp-sidebar-gen-node-filters");
        const selectCategory = cat => {
          selectedNodeIds.clear();
          for (const comp of meta.workflowComponents) {
            if (cat === "all" || comp.category === cat) selectedNodeIds.add(String(comp.id));
          }
          for (const cb of wfBody.querySelectorAll("[data-node-select]")) {
            cb.checked = selectedNodeIds.has(cb.dataset.nodeSelect);
          }
          syncSubsetBtn();
        };
        for (const [cat, label] of [["all", "All"], ["prompt", "Prompting"], ["sampler", "Sampling"], ["model", "Models"]]) {
          if (cat !== "all" && !meta.workflowComponents.some(c => c.category === cat)) continue;
          const filterBtn = btn(label, () => selectCategory(cat), "pp-sidebar-gen-pill-btn");
          filterBtn.setAttribute("aria-label", `Select ${label.toLowerCase()} workflow nodes`);
          filterRow.append(filterBtn);
        }
        wfBody.append(filterRow);
      }

      if (meta.workflowComponents.length > 0) {
        const nodeList = make("div", "pp-sidebar-gen-nodes");
        for (const comp of meta.workflowComponents) {
          const row = make("div", "pp-sidebar-gen-node");
          row.dataset.nodeId = String(comp.id);
          row.dataset.nodeCategory = comp.category;

          const checkLabel = make("label", "pp-sidebar-gen-node-check");
          const check = make("input");
          check.type = "checkbox";
          check.checked = selectedNodeIds.has(String(comp.id));
          check.dataset.nodeSelect = String(comp.id);
          check.setAttribute("aria-label", `Select ${comp.title} for workflow copy`);
          check.addEventListener("change", () => {
            if (check.checked) selectedNodeIds.add(String(comp.id));
            else selectedNodeIds.delete(String(comp.id));
            syncSubsetBtn();
          });

          const info = make("div", "pp-sidebar-gen-node-info");
          const headLine = make("div", "pp-sidebar-gen-node-title");
          headLine.append(
            make("strong", "", comp.title),
            make("small", "pp-sidebar-gen-node-type", `#${comp.id}`)
          );
          info.append(headLine);
          if (comp.summary) {
            info.append(make("small", "pp-sidebar-gen-node-summary", comp.summary));
          }

          checkLabel.append(check, info);

          const copyNodeBtn = btn(
            "Copy node",
            e => copyValue(serializeWorkflowComponent(comp), `node ${comp.title}`, e.currentTarget),
            "pp-sidebar-gen-copy-btn"
          );
          copyNodeBtn.dataset.copyRole = "node-component";
          copyNodeBtn.setAttribute("aria-label", `Copy node ${comp.title}`);

          row.append(checkLabel, copyNodeBtn);
          nodeList.append(row);
        }
        wfBody.append(nodeList);
      }

      wfGroup.append(wfBody);
      flyBody.append(wfGroup);
    }

    // Footer matching LoRA Info popout footer
    flyFoot.replaceChildren();
    flyFoot.append(make("span", "pp-gen-flyout-hint", "Click values to copy · Gallery stays active · Esc closes"));
    if (canRefine && getNode) {
      const footRefineBtn = btn("Refine in node…", () => openRefinement(record), "pp-sidebar-gen-action pp-sidebar-gen-action--primary pp-gen-flyout-cta");
      footRefineBtn.disabled = Boolean(refineReason);
      footRefineBtn.title = refineReason || "Open recorded prompt data in the target node with Commit / Cancel";
      if (refineReason) footRefineBtn.setAttribute("aria-description", refineReason);
      flyFoot.append(footRefineBtn);
    } else if (meta.authoredPositive && (insertPrompt || restore)) {
      const footUseBtn = btn("Use raw prompt", e => usePromptInTarget(meta.authoredPositive, "positive", record, e.currentTarget), "pp-sidebar-gen-action pp-sidebar-gen-action--primary pp-gen-flyout-cta");
      flyFoot.append(footUseBtn);
    } else if (meta.positivePrompt && (insertPrompt || restore)) {
      const footUseBtn = btn("Use prompt", e => usePromptInTarget(meta.positivePrompt, "positive", record, e.currentTarget), "pp-sidebar-gen-action pp-sidebar-gen-action--primary pp-gen-flyout-cta");
      flyFoot.append(footUseBtn);
    }

    if (visible && active && isOpen) {
      showFlyout();
      if (sameRecord && prevScroll > 0) flyBody.scrollTop = prevScroll;
    } else {
      hideFlyout();
    }
  }

  async function inspectGeneration(id, { quiet = false } = {}) {
    if (disposed || !id) return;
    const version = ++inspectSequence;
    inspectController?.abort();
    const controller = (inspectController = new AbortController());

    const existing = rows.find(r => r.id === id) || (selectedRecord?.id === id ? selectedRecord : null);
    selectedId = id;
    if (existing && (selectedRecord?.id !== id || flyoutEl.hidden)) {
      if (selectedRecord?.id !== id) {
        selectedRecord = existing;
        selectedExtra = {};
        selectedNodeIds.clear();
      }
      syncCardSelection();
      renderInspector();
    }

    try {
      const fresh = await requestGenerationHistory(`/${encodeURIComponent(id)}`, "GET", undefined, controller.signal);
      if (disposed || controller.signal.aborted || version !== inspectSequence) return;
      const changedRecord = JSON.stringify(selectedRecord) !== JSON.stringify(fresh);
      selectedRecord = fresh;
      const idx = rows.findIndex(r => r.id === id);
      if (idx >= 0) rows[idx] = fresh;
      syncCardSelection();
      if (changedRecord || flyoutEl.hidden) renderInspector();

      const extra = await fetchRunEnrichment(fresh, controller.signal);
      if (disposed || controller.signal.aborted || version !== inspectSequence) return;
      if (extra.historyEntry || extra.embedded) {
        selectedExtra = extra;
        if (extra.embedded?.width && extra.embedded?.height) {
          rememberBounded(imageDimensionsCache, fresh.id, { width: extra.embedded.width, height: extra.embedded.height }, 2048);
        }
        renderInspector();
      }
    } catch (error) {
      if (!disposed && error?.name !== "AbortError" && !quiet) {
        announce(error.message || String(error), true);
      }
    } finally {
      if (inspectController === controller) inspectController = null;
    }
  }

  async function refresh(append = false, { resetScroll = false } = {}) {
    if (disposed) return;
    const version = ++listSequence;
    listController?.abort();
    const controller = (listController = new AbortController());
    if (append) {
      loadMoreBtn.disabled = true;
      loadMoreBtn.textContent = "Loading…";
    }
    try {
      const favOnly = favFilterBtn.getAttribute("aria-pressed") === "true";
      const days = Number(dateSelect.value) || 0;
      const params = new URLSearchParams({
        q: searchInput.value.trim(),
        favorite: String(favOnly),
        missing: "false",
        since: days > 0 ? String(Date.now() - days * 86400000) : "0",
        sort: sortOrder,
      });
      if (append && cursor) params.set("cursor", cursor);
      const page = await requestGenerationHistory(`?${params}`, "GET", undefined, controller.signal);
      if (disposed || controller.signal.aborted || version !== listSequence) return;
      const items = Array.isArray(page?.items) ? page.items : [];
      rows = mergeUniqueGenerationRows(rows, items, append);
      cursor = page?.next_cursor || null;
      loadMoreBtn.hidden = !cursor;

      if (selectedId) {
        const updated = rows.find(r => r.id === selectedId);
        if (updated) selectedRecord = { ...selectedRecord, ...updated };
      }
      renderList({ itemsChanged: true, resetScroll });
      if (selectedRecord) renderInspector();
    } catch (error) {
      if (!disposed && error?.name !== "AbortError" && visible && active) {
        announce(error.message || String(error), true);
      }
    } finally {
      if (listController === controller) listController = null;
      if (!disposed && listController === null) {
        loadMoreBtn.disabled = false;
        loadMoreBtn.textContent = "Load more";
      }
    }
  }

  if (!isTabMode) {
    section.addEventListener("toggle", () => {
      isOpen = section.open;
      persistState();
      if (!isOpen) {
        hideFlyout();
      } else if (visible && active) {
        refreshAppearance({ force: true });
        refresh();
        if (selectedRecord) showFlyout();
      }
    });
  }

  searchInput.addEventListener("input", () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => refresh(false, { resetScroll: true }), 120);
  });
  dateSelect.addEventListener("change", () => refresh(false, { resetScroll: true }));

  const unsubMetadata = API.onMetadataChange?.(detail => {
    if (disposed) return;
    if (detail.namespace === "settings" && detail.prefs && typeof detail.prefs === "object") {
      prefs = detail.prefs;
      enableToggle.checked = !!prefs.enabled;
      captureToggle.checked = !!prefs.capture_prompts;
      syncCapture();
      renderList();
      return;
    }
    if (["generations", "settings", "all"].includes(detail.namespace)) {
      if (detail.namespace === "generations" && detail.action === "delete" && detail.id === selectedId) {
        selectedId = null;
        selectedRecord = null;
        selectedExtra = {};
        renderInspector();
      }
      if (visible && active && isOpen) refresh();
    }
  });

  // Initial settings & list load
  (async () => {
    try {
      prefs = await requestGenerationHistory("/settings");
      if (disposed) return;
      enableToggle.checked = !!prefs?.enabled;
      captureToggle.checked = !!prefs?.capture_prompts;
      enableToggle.disabled = prefs?.capture_available === false;
      syncCapture();
      if (prefs?.enabled && visible && active) {
        await requestGenerationHistory("/sync", "POST", {});
      }
      if (visible && active) {
        await refresh();
      }
    } catch {
      if (!disposed && visible && active) {
        await refresh();
      }
    }
  })();

  return {
    element: section,
    refresh,
    refreshAppearance,
    inspectGeneration,
    setVisible(nextVisible) {
      if (disposed) return;
      const next = nextVisible !== false;
      if (visible === next) return;
      visible = next;
      section.hidden = !visible;
      // Hiding the section never disables generation tracking (syncCapture stays alive).
      if (!visible) {
        hideFlyout();
      } else if (active && isOpen) {
        refreshAppearance({ force: true });
        refresh();
        if (selectedRecord) showFlyout();
      }
    },
    setActive(nextActive) {
      if (disposed) return;
      const next = Boolean(nextActive);
      if (active === next) return;
      active = next;
      if (!active) {
        hideFlyout();
      } else if (visible && isOpen) {
        const latestState = readEditorPreference(PREF_SIDEBAR_GEN_STATE, {}) || {};
        const latestSort = latestState.sort === "oldest" ? "oldest" : "newest";
        if (latestSort !== sortOrder) {
          sortOrder = latestSort;
          syncSortButton();
        }
        refreshAppearance({ force: true });
        if (prefs?.enabled) {
          requestGenerationHistory("/sync", "POST", {}).then(() => refresh()).catch(() => refresh());
        } else {
          refresh();
        }
        if (selectedRecord) showFlyout();
      }
    },
    refreshTarget() {
      if (disposed || !selectedRecord) return;
      renderInspector();
    },
    cleanup() {
      if (disposed) return;
      disposed = true;
      importCancelled = true;
      hideFlyout();
      releaseFlyoutKeyboard();
      globalThis.removeEventListener?.("resize", onFlyoutResize);
      clearTimeout(searchDebounce);
      listResize.disconnect();
      listController?.abort();
      inspectController?.abort();
      loraEnrichController?.abort();
      refineReview?.close();
      refineReview = null;
      unsubscribeCapture?.();
      unsubMetadata?.();
      virtual.cleanup();
      collection = null;
      if (ownedPresentation) {
        ownedPresentation.cleanup();
      } else if (presentation) {
        presentation.release(listEl);
        presentation.release(flyoutEl);
      }
      flyoutEl.remove();
      section.remove();
    },
  };
}
