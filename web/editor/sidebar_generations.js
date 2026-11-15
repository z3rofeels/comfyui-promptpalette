import { api } from "../../../scripts/api.js";
import { API } from "../prompt_palette_api.js";
import { readEditorPreference, writeEditorPreference } from "../prompt_palette_state.js";
import { svgIcon } from "../prompt_palette_shared.js";
import { openCtxMenu } from "./context_menu.js";
import { historyRefinementSources, reviewHistoryRefinement } from "./history_restore.js";
import { loadSidebarDisplay, loadTheme, saveSidebarDisplay } from "./preferences.js";
import { colorForLora, loraIdentity } from "./lora_colors.js";
import { sidebarLayoutMetrics } from "./sidebar_layout.js";
import {
  requestGenerationHistory,
  subscribeGenerationHistory,
  generationImageUrl,
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

// One toggle button that shows both versions and highlights the active one,
// so the label never has to describe the current state and the next state at once.
function promptModeSwitch(mode, ariaLabel, title, onToggle) {
  const el = btn("", onToggle, "pp-sidebar-gen-seg");
  const resolved = make("span", "", "Resolved");
  const authored = make("span", "", "Authored");
  resolved.classList.toggle("is-on", mode !== "authored");
  authored.classList.toggle("is-on", mode === "authored");
  el.append(resolved, authored);
  el.dataset.mode = mode === "authored" ? "authored" : "resolved";
  el.title = title;
  el.setAttribute("aria-label", ariaLabel);
  return el;
}

function shortModelName(value) {
  return String(value ?? "").split(/[\\/]/).pop().replace(/\.(safetensors|ckpt|pt|pth|gguf|bin)$/i, "");
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
  if (!hasGraph && !record?.missing && record?.image?.filename && /\.png$/i.test(record.image.filename)) {
    try {
      const res = await api.fetchApi(`/view?${new URLSearchParams(record.image)}`, {
        ...(signal ? { signal } : {}),
        headers: { Range: "bytes=0-262143" },
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

function resolveRecordAspectRatio(record, meta, fallbackRatio = 1) {
  const dims = resolveRecordDimensions(record, meta);
  if (dims && dims.width > 0 && dims.height > 0) {
    return Math.max(0.35, Math.min(2.8, dims.width / dims.height));
  }
  return Math.max(0.35, Math.min(2.8, Number(fallbackRatio) || 1));
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
  let promptViewMode = { positive: "resolved", negative: "resolved" };
  let lastGeometry = "";

  let listSequence = 0;
  let inspectSequence = 0;
  let refineSequence = 0;
  let listController = null;
  let inspectController = null;
  let refineReview = null;
  let searchDebounce = 0;
  let rebalanceFrame = 0;
  let unsubscribeCapture = null;
  const copyTimers = new WeakMap();
  const cardMediaElements = new Set();

  // One layout control lives in the sidebar toolbar. The Generations tab has its own saved layout;
  // the Recent Generations section on the Library tab follows the Library layout.
  const layoutKey = isTabMode ? "generations" : "library";

  function currentLayoutMode() {
    return normalizeGenLayout(loadSidebarDisplay().layouts?.[layoutKey]);
  }

  function persistState() {
    writeEditorPreference(PREF_SIDEBAR_GEN_STATE, { open: isOpen });
  }

  function releaseCardMediaRules() {
    if (!presentation) return;
    for (const el of cardMediaElements) {
      presentation.release(el);
    }
    cardMediaElements.clear();
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
    if (buttonEl && buttonEl.isConnected) {
      const prevTimer = copyTimers.get(buttonEl);
      if (prevTimer) clearTimeout(prevTimer);
      const originalText = buttonEl.dataset.originalLabel ?? buttonEl.textContent;
      buttonEl.dataset.originalLabel = originalText;
      buttonEl.dataset.copied = "true";
      if (!buttonEl.childElementCount) {
        buttonEl.textContent = "✓ Copied";
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
    refresh();
  }, "pp-sidebar-icon pp-sidebar-gen-fav-filter");
  favFilterBtn.title = "Filter favorite generations";
  favFilterBtn.setAttribute("aria-label", "Filter favorite generations");
  favFilterBtn.setAttribute("aria-pressed", "false");

  const dateSelect = make("select", "pp-sidebar-gen-date");
  dateSelect.setAttribute("aria-label", "Recent generations date filter");
  for (const [val, text] of [["0", "All time"], ["1", "24h"], ["7", "7d"], ["30", "30d"]]) {
    dateSelect.append(new Option(text, val));
  }

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

  toolbar.append(favFilterBtn, dateSelect, refreshBtn, settingsDetails);
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

  // Thumbnail list / gallery / masonry / filmstrip container
  const listEl = make("div", "pp-sidebar-gen-list");
  listEl.setAttribute("role", "list");
  listEl.setAttribute("aria-label", "Recent generations list");

  const loadMoreBtn = btn("Load more", () => refresh(true), "pp-sidebar-gen-more");
  loadMoreBtn.hidden = true;

  // Inline Metadata Inspector
  const inspectorEl = make("section", "pp-sidebar-gen-inspector");
  inspectorEl.hidden = true;
  inspectorEl.setAttribute("aria-label", "Generation metadata inspector");

  body.append(listEl, loadMoreBtn, inspectorEl);
  if (isTabMode) host.append(section);
  else host.prepend(section);

  function computeMetrics() {
    const rawWidth = listEl.clientWidth || body.clientWidth || host.clientWidth || 320;
    const availWidth = Math.max(120, rawWidth);
    const metrics = sidebarLayoutMetrics(layoutKey, uiScale(), availWidth);
    const layoutMode = normalizeGenLayout(metrics.mode);
    const display = loadSidebarDisplay();
    const images = display.chrome?.images !== false;
    const fit = display.chrome?.fit === "contain" ? "contain" : "cover";
    const imageHeight = images ? Math.max(28, Math.round(metrics.cardWidth / metrics.ratio)) : 0;
    const listDensity = layoutMode === "list"
      ? (metrics.rowHeight < 42 ? "tiny" : metrics.rowHeight < 54 ? "micro" : "normal")
      : metrics.density;
    return {
      ...metrics,
      mode: layoutMode,
      images,
      fit,
      imageHeight,
      listDensity,
      availWidth,
    };
  }

  function applyMetricsToDOM(m) {
    section.dataset.layout = m.mode;
    listEl.dataset.layout = m.mode;
    listEl.dataset.density = m.listDensity;
    if (presentation) {
      presentation.set(listEl, {
        "--pp-gen-columns": m.columns,
        "--pp-gen-card-width": `${m.cardWidth}px`,
        "--pp-gen-image-height": `${m.imageHeight}px`,
        "--pp-gen-row-height": `${Math.round(m.rowHeight)}px`,
        "--pp-gen-scale": m.scale,
        "--pp-gen-ratio": m.ratio,
      });
    }
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
      renderList();
      if (selectedRecord?.id === record.id) renderInspector();
    } catch (error) {
      announce(error.message || String(error), true);
    }
  }

  async function usePromptInTarget(text, channel = "positive", record = selectedRecord) {
    if (!text) return;
    try {
      if (restore && channel === "negative") {
        await restore({ text, channel, record, requiresConfirmation: true });
        announce("Sent negative prompt to target node.");
        return;
      }
      if (insertPrompt && channel === "positive") {
        const ok = await insertPrompt(text);
        if (ok) return;
      }
      if (restore) {
        await restore({ text, channel, record, requiresConfirmation: true });
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

  function scheduleMasonryRebalance() {
    if (rebalanceFrame || disposed) return;
    rebalanceFrame = requestAnimationFrame(() => {
      rebalanceFrame = 0;
      if (!disposed && currentLayoutMode() === "masonry" && rows.length > 1) {
        renderList();
      }
    });
  }

  function renderCard(record, metrics) {
    const extra = selectedRecord?.id === record.id
      ? { ...selectedExtra, dimensions: imageDimensionsCache.get(record.id) }
      : { dimensions: imageDimensionsCache.get(record.id) };
    const meta = extractGenerationMetadata(record, extra);
    const card = make("article", "pp-sidebar-gen-card");
    card.setAttribute("role", "listitem");
    card.dataset.generationId = record.id;
    const isSelected = selectedId === record.id;
    card.classList.toggle("is-selected", isSelected);

    const media = make("div", "pp-sidebar-gen-media");
    const naturalRatio = resolveRecordAspectRatio(record, meta, metrics.ratio);
    if ((metrics.mode === "masonry" || metrics.mode === "filmstrip") && presentation) {
      const targetWidth = metrics.mode === "filmstrip" ? metrics.availWidth : metrics.cardWidth;
      const mediaHeight = metrics.images ? Math.max(36, Math.round(targetWidth / naturalRatio)) : 0;
      presentation.set(media, { "--pp-gen-media-height": `${mediaHeight}px` });
      cardMediaElements.add(media);
    }

    if (!record.missing && record.image?.filename && metrics.images) {
      const img = make("img", "pp-sidebar-gen-thumb");
      img.src = generationImageUrl(record.image);
      img.alt = record.image.filename;
      img.loading = "lazy";
      img.decoding = "async";
      img.addEventListener("load", () => {
        if (disposed || !img.naturalWidth || !img.naturalHeight) return;
        const prev = imageDimensionsCache.get(record.id);
        const nextDims = { width: img.naturalWidth, height: img.naturalHeight };
        rememberBounded(imageDimensionsCache, record.id, nextDims, 256);
        const loadedRatio = Math.max(0.35, Math.min(2.8, nextDims.width / nextDims.height));
        const resBadge = media.querySelector(".pp-sidebar-gen-res");
        if (resBadge) resBadge.textContent = `${nextDims.width}×${nextDims.height}`;
        if ((metrics.mode === "masonry" || metrics.mode === "filmstrip") && presentation && media.isConnected) {
          const mNow = computeMetrics();
          const targetW = mNow.mode === "filmstrip" ? mNow.availWidth : mNow.cardWidth;
          const nextHeight = mNow.images ? Math.max(36, Math.round(targetW / loadedRatio)) : 0;
          presentation.set(media, { "--pp-gen-media-height": `${nextHeight}px` });
          if (mNow.mode === "masonry" && (!prev || Math.abs(prev.width / prev.height - nextDims.width / nextDims.height) > 0.04)) {
            scheduleMasonryRebalance();
          }
        }
        if (selectedRecord?.id === record.id && !meta.resolution) {
          renderInspector();
        }
      }, { once: true });
      img.addEventListener("error", () => {
        img.replaceWith(make("span", "pp-sidebar-gen-fallback", "No preview"));
      }, { once: true });
      media.append(img);
    } else if (record.missing) {
      media.append(make("span", "pp-sidebar-gen-fallback", "Missing"));
    } else if (!metrics.images) {
      media.hidden = true;
    } else {
      media.append(make("span", "pp-sidebar-gen-fallback", "No preview"));
    }

    const badges = make("span", "pp-sidebar-gen-badges");
    if (record.provenance === "verified") {
      const vBadge = make("span", "pp-sidebar-gen-verified", "✓");
      vBadge.title = "Verified Prompt Palette output";
      badges.append(vBadge);
    }
    if (record.favorite) {
      const fBadge = make("span", "pp-sidebar-gen-fav", "★");
      fBadge.title = "Favorite";
      badges.append(fBadge);
    }
    const dims = resolveRecordDimensions(record, meta);
    if ((metrics.mode === "masonry" || metrics.mode === "filmstrip") && dims) {
      const resTag = make("span", "pp-sidebar-gen-res", `${dims.width}×${dims.height}`);
      badges.append(resTag);
    }
    if (badges.childNodes.length) media.append(badges);

    const selectBtn = btn("", () => inspectGeneration(record.id), "pp-sidebar-gen-card-select");
    selectBtn.setAttribute("aria-label", `Inspect ${record.image?.filename || "generation"}`);
    selectBtn.setAttribute("aria-pressed", String(isSelected));

    const caption = make("div", "pp-sidebar-gen-caption");
    const primaryLabel = metrics.mode === "list" && meta.positivePrompt
      ? meta.positivePrompt.replace(/\s+/g, " ").trim()
      : (record.image?.filename || "Generation");
    const title = make("strong", "pp-sidebar-gen-filename", primaryLabel);

    const subParts = [];
    if (metrics.mode === "list" && record.image?.filename && primaryLabel !== record.image.filename) {
      subParts.push(record.image.filename);
    }
    if (meta.seed != null) subParts.push(`#${meta.seed}`);
    if (meta.sampler) subParts.push(meta.sampler);
    if (dims) subParts.push(`${dims.width}×${dims.height}`);
    else if (record.completed_at) subParts.push(new Date(record.completed_at).toLocaleDateString());

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
          copyValue(meta.positivePrompt, "positive prompt", copyQuick);
        }, "pp-sidebar-icon pp-sidebar-gen-quick-copy");
        copyQuick.innerHTML = svgIcon("copy", 13);
        copyQuick.title = "Copy positive prompt";
        copyQuick.setAttribute("aria-label", `Copy positive prompt for ${record.image?.filename || "generation"}`);
        rowActions.append(copyQuick);
      }
      const favQuick = btn(record.favorite ? "★" : "☆", event => toggleFavorite(record, event), "pp-sidebar-icon pp-sidebar-gen-quick-fav");
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
      const currentMeta = extractGenerationMetadata(
        selectedRecord?.id === record.id ? selectedRecord : record,
        selectedRecord?.id === record.id
          ? { ...selectedExtra, dimensions: imageDimensionsCache.get(record.id) }
          : { dimensions: imageDimensionsCache.get(record.id) }
      );
      const items = [
        { label: "Inspect generation metadata", icon: "eye", group: "inspect", onSelect: () => inspectGeneration(record.id) },
      ];
      if (currentMeta.positivePrompt) {
        items.push({ label: "Copy positive prompt", icon: "copy", group: "copy", onSelect: () => copyValue(currentMeta.positivePrompt, "positive prompt") });
        items.push({ label: "Use positive prompt in target", icon: "plus", group: "use", onSelect: () => usePromptInTarget(currentMeta.positivePrompt, "positive", record) });
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
        label: record.favorite ? "Remove from favorites" : "Add to favorites",
        icon: "star",
        group: "item",
        onSelect: () => toggleFavorite(record),
      });
      openCtxMenu(event.clientX, event.clientY, items);
    });

    return card;
  }

  // Closes the inspector; when focus was inside it, hands focus back to the card that opened it
  // so keyboard users land where they started instead of at the top of the page.
  function closeInspector() {
    if (disposed || !selectedId) return;
    const returnId = selectedId;
    const hadFocus = inspectorEl.contains(document.activeElement);
    inspectController?.abort();
    selectedId = null;
    selectedRecord = null;
    selectedExtra = {};
    renderList();
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
        refresh();
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

  function renderList() {
    if (disposed) return;
    releaseCardMediaRules();
    const metrics = computeMetrics();
    applyMetricsToDOM(metrics);

    countBadge.textContent = rows.length ? String(rows.length) : prefs?.enabled === false ? "Off" : "0";
    inspectorEl.hidden = !selectedRecord;
    section.dataset.inspecting = String(Boolean(selectedRecord));

    if (!rows.length) {
      const hasFilters = Boolean(searchInput.value.trim() || favFilterBtn.getAttribute("aria-pressed") === "true" || dateSelect.value !== "0");
      const emptyMsg = hasFilters
        ? "No matching generations. Clear search or filters."
        : prefs?.enabled === false
          ? "Generation recording is off. Turn on 'Record Prompt Palette generations' in settings (⚙) or import ComfyUI history."
          : "No recent generations indexed yet. Queue a run or import existing ComfyUI history.";
      listEl.replaceChildren(make("p", "pp-sidebar-note pp-sidebar-gen-empty", emptyMsg));
      return;
    }

    if (metrics.mode === "masonry") {
      const colCount = Math.max(1, metrics.columns);
      const cols = Array.from({ length: colCount }, () => make("div", "pp-sidebar-gen-masonry-col"));
      const heights = new Array(colCount).fill(0);
      const captionEstimate = metrics.listDensity === "tiny" ? 0 : metrics.listDensity === "micro" ? 24 : 38;
      for (const record of rows) {
        const card = renderCard(record, metrics);
        const meta = extractGenerationMetadata(record, { dimensions: imageDimensionsCache.get(record.id) });
        const ratio = resolveRecordAspectRatio(record, meta, metrics.ratio);
        const estMediaHeight = metrics.images ? Math.max(36, Math.round(metrics.cardWidth / ratio)) : 0;
        let minIdx = 0;
        for (let i = 1; i < colCount; i++) {
          if (heights[i] < heights[minIdx]) minIdx = i;
        }
        cols[minIdx].append(card);
        heights[minIdx] += estMediaHeight + captionEstimate + 8;
      }
      listEl.replaceChildren(...cols);
      return;
    }

    listEl.replaceChildren(...rows.map(record => renderCard(record, metrics)));
  }

  function refreshAppearance({ force = false } = {}) {
    if (disposed) return;
    const m = computeMetrics();
    const geometry = `${m.mode}|${m.scale}|${m.columns}|${Math.round(m.cardWidth)}|${Math.round(m.rowHeight)}|${m.ratio}|${m.images}|${m.fit}`;
    if (!force && geometry === lastGeometry) {
      applyMetricsToDOM(m);
      return;
    }
    lastGeometry = geometry;
    renderList();
  }

  const listResize = new ResizeObserver(() => {
    if (!disposed && visible && (isTabMode || isOpen)) {
      refreshAppearance();
    }
  });
  listResize.observe(listEl);

  function renderInspector() {
    if (disposed) return;
    if (!selectedRecord) {
      inspectorEl.hidden = true;
      inspectorEl.replaceChildren();
      section.dataset.inspecting = "false";
      return;
    }
    inspectorEl.hidden = false;
    section.dataset.inspecting = "true";
    inspectorEl.replaceChildren();

    const record = selectedRecord;
    const meta = extractGenerationMetadata(record, {
      ...selectedExtra,
      dimensions: imageDimensionsCache.get(record.id),
    });

    // Ensure selectedNodeIds has valid defaults
    const validIds = new Set(meta.workflowComponents.map(c => String(c.id)));
    for (const id of [...selectedNodeIds]) {
      if (!validIds.has(id)) selectedNodeIds.delete(id);
    }
    if (!selectedNodeIds.size && validIds.size) {
      for (const id of validIds) selectedNodeIds.add(id);
    }

    // 1. Inspector hero: artwork, identity pills and the primary actions (Civitai-style info panel)
    const head = make("header", "pp-sidebar-gen-inspector-head pp-sidebar-gen-hero");
    const hasArtwork = !record.missing && Boolean(record.image?.filename);
    head.dataset.media = hasArtwork ? "image" : "none";
    if (hasArtwork) {
      const thumbLink = make("a", "pp-sidebar-gen-inspector-thumb-link");
      thumbLink.href = generationImageUrl(record.image);
      thumbLink.target = "_blank";
      thumbLink.rel = "noopener";
      thumbLink.title = "Open full-resolution image in new tab";
      thumbLink.setAttribute("aria-label", "Open full-resolution image in new tab");
      const miniThumb = make("img", "pp-sidebar-gen-inspector-thumb");
      miniThumb.src = generationImageUrl(record.image);
      miniThumb.alt = "";
      miniThumb.decoding = "async";
      const artWidth = Number(meta.width), artHeight = Number(meta.height);
      if (artWidth > 0 && artHeight > 0) {
        // Intrinsic size attributes let the browser reserve the right aspect ratio before the image loads.
        miniThumb.width = artWidth;
        miniThumb.height = artHeight;
      }
      miniThumb.addEventListener("error", () => {
        thumbLink.remove();
        head.dataset.media = "none";
      }, { once: true });
      thumbLink.append(miniThumb);
      head.append(thumbLink);
    }

    const info = make("div", "pp-sidebar-gen-hero-info");
    const titleRow = make("div", "pp-sidebar-gen-inspector-title");
    const titleMeta = make("div", "pp-sidebar-gen-inspector-meta");
    const filenameEl = make("strong", "", record.image?.filename || "Generation");
    filenameEl.title = record.image?.filename || "Generation";
    titleMeta.append(filenameEl);
    if (record.completed_at) {
      titleMeta.append(make("small", "pp-sidebar-gen-inspector-sub", new Date(record.completed_at).toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })));
    }

    const headTools = make("div", "pp-sidebar-gen-inspector-tools");
    const favBtn = btn(record.favorite ? "★" : "☆", e => toggleFavorite(record, e), "pp-sidebar-icon pp-sidebar-gen-fav-btn");
    favBtn.title = record.favorite ? "Remove from favorites" : "Add to favorites";
    favBtn.setAttribute("aria-label", "Favorite generation");
    favBtn.setAttribute("aria-pressed", String(Boolean(record.favorite)));

    const closeBtn = btn("×", () => closeInspector(), "pp-sidebar-icon pp-sidebar-gen-close");
    closeBtn.title = "Close generation inspector (Esc)";
    closeBtn.setAttribute("aria-label", "Close generation inspector");

    headTools.append(favBtn, closeBtn);
    titleRow.append(titleMeta, headTools);

    const pills = make("div", "pp-sidebar-gen-pills");
    pills.append(record.provenance === "verified"
      ? pill("✓ Verified", "verified", "One Prompt Palette node fed this image, so its recorded prompt and seed are attributed to it.")
      : pill("Run context", "context", "Prompts and parameters come from the run that produced this image, not from a single Prompt Palette node."));
    if (meta.model) pills.append(pill(shortModelName(meta.model), "model", `Checkpoint: ${meta.model}`));
    if (meta.resolution) pills.append(pill(meta.resolution, "dims", "Image dimensions"));
    info.append(titleRow, pills);
    head.append(info);

    // Primary reusable actions bar
    const quickBar = make("div", "pp-sidebar-gen-quickbar");
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
    if (canRefine && getNode) {
      const refineBtn = btn("Refine in node…", () => openRefinement(record), "pp-sidebar-gen-action pp-sidebar-gen-action--primary");
      refineBtn.setAttribute("aria-label", "Refine generation in target node");
      quickBar.append(refineBtn);
    }

    if (quickBar.childNodes.length) info.append(quickBar);
    inspectorEl.append(head);

    // 2. Prompts Section (only if prompt metadata exists)
    if (meta.hasPrompts) {
      const promptsGroup = make("details", "pp-sidebar-gen-group");
      promptsGroup.dataset.section = "prompts";
      promptsGroup.open = true;
      const promptsSummary = make("summary", "pp-sidebar-gen-group-summary");
      promptsSummary.append(make("span", "pp-sidebar-gen-group-title", "Prompts"));
      promptsGroup.append(promptsSummary);

      const promptsBody = make("div", "pp-sidebar-gen-group-body");

      // Positive prompt block
      if (meta.positivePrompt) {
        const posBlock = make("div", "pp-sidebar-gen-prompt-block");
        posBlock.dataset.promptChannel = "positive";
        const posHead = make("div", "pp-sidebar-gen-prompt-head");
        const posLabel = make("span", "pp-sidebar-gen-label", "Positive prompt");
        posHead.append(posLabel);

        const hasBothPos = Boolean(meta.resolvedPositive && meta.authoredPositive && meta.resolvedPositive !== meta.authoredPositive);
        const activePosText = hasBothPos && promptViewMode.positive === "authored" ? meta.authoredPositive : (meta.resolvedPositive ?? meta.authoredPositive);

        const posActions = make("div", "pp-sidebar-gen-btn-row");
        if (hasBothPos) {
          posActions.append(promptModeSwitch(
            promptViewMode.positive,
            "Switch positive prompt version",
            "Switch between resolved output and authored template",
            () => {
              promptViewMode.positive = promptViewMode.positive === "authored" ? "resolved" : "authored";
              renderInspector();
            }
          ));
        }

        const copyPosBtn = btn("Copy", e => copyValue(activePosText, "positive prompt", e.currentTarget), "pp-sidebar-gen-copy-btn");
        copyPosBtn.dataset.copyRole = "positive";
        copyPosBtn.setAttribute("aria-label", "Copy positive prompt");
        posActions.append(copyPosBtn);

        const usePosBtn = btn("Use", () => usePromptInTarget(activePosText, "positive", record), "pp-sidebar-gen-copy-btn pp-sidebar-gen-use-btn");
        usePosBtn.setAttribute("aria-label", "Use positive prompt in target node");
        posActions.append(usePosBtn);

        posHead.append(posActions);
        const posPre = make("pre", "pp-sidebar-gen-prompt-text", activePosText);
        posPre.dataset.promptText = "positive";
        posBlock.append(posHead, posPre);
        promptsBody.append(posBlock);
      }

      // Negative prompt block (only if negative prompt actually exists)
      if (meta.negativePrompt) {
        const negBlock = make("div", "pp-sidebar-gen-prompt-block");
        negBlock.dataset.promptChannel = "negative";
        const negHead = make("div", "pp-sidebar-gen-prompt-head");
        negHead.append(make("span", "pp-sidebar-gen-label", "Negative prompt"));

        const hasBothNeg = Boolean(meta.resolvedNegative && meta.authoredNegative && meta.resolvedNegative !== meta.authoredNegative);
        const activeNegText = hasBothNeg && promptViewMode.negative === "authored" ? meta.authoredNegative : (meta.resolvedNegative ?? meta.authoredNegative);

        const negActions = make("div", "pp-sidebar-gen-btn-row");
        if (hasBothNeg) {
          negActions.append(promptModeSwitch(
            promptViewMode.negative,
            "Switch negative prompt version",
            "Switch between resolved negative and authored template",
            () => {
              promptViewMode.negative = promptViewMode.negative === "authored" ? "resolved" : "authored";
              renderInspector();
            }
          ));
        }

        const copyNegBtn = btn("Copy", e => copyValue(activeNegText, "negative prompt", e.currentTarget), "pp-sidebar-gen-copy-btn");
        copyNegBtn.dataset.copyRole = "negative";
        copyNegBtn.setAttribute("aria-label", "Copy negative prompt");
        negActions.append(copyNegBtn);

        const useNegBtn = btn("Use", () => usePromptInTarget(activeNegText, "negative", record), "pp-sidebar-gen-copy-btn pp-sidebar-gen-use-btn");
        useNegBtn.setAttribute("aria-label", "Use negative prompt in target node");
        negActions.append(useNegBtn);

        negHead.append(negActions);
        const negPre = make("pre", "pp-sidebar-gen-prompt-text", activeNegText);
        negPre.dataset.promptText = "negative";
        negBlock.append(negHead, negPre);
        promptsBody.append(negBlock);
      }

      // Active LoRAs in generation
      if (meta.loras.length) {
        const loraBlock = make("div", "pp-sidebar-gen-tags-block");
        loraBlock.dataset.resource = "lora";
        const loraHead = make("div", "pp-sidebar-gen-prompt-head");
        loraHead.append(make("span", "pp-sidebar-gen-label", `LoRAs (${meta.loras.length})`));
        const allLoraSyntax = meta.loras.map(l => `<lora:${l.name}:${l.modelStrength}${l.clipStrength !== l.modelStrength ? `:${l.clipStrength}` : ""}>`).join(" ");
        const copyLorasBtn = btn("Copy LoRAs", e => copyValue(allLoraSyntax, "LoRA tags", e.currentTarget), "pp-sidebar-gen-copy-btn");
        copyLorasBtn.dataset.copyRole = "loras";
        copyLorasBtn.setAttribute("aria-label", "Copy LoRAs");
        loraHead.append(copyLorasBtn);

        const chips = make("div", "pp-sidebar-gen-chips pp-sidebar-gen-chips--stack");
        const loraTheme = loadTheme();
        for (const lora of meta.loras) {
          const hasClip = lora.clipStrength !== lora.modelStrength;
          const tag = `<lora:${lora.name}:${lora.modelStrength}${hasClip ? `:${lora.clipStrength}` : ""}>`;
          const shortName = String(lora.name).split(/[\\/]/).pop().replace(/\.[^.]+$/, "");
          const chip = btn("", e => copyValue(tag, `LoRA ${shortName}`, e.currentTarget), "pp-sidebar-gen-chip pp-sidebar-gen-chip--lora");
          chip.dataset.loraName = String(lora.name);
          chip.title = `Click to copy ${tag}`;
          chip.setAttribute("aria-label", `Copy LoRA ${shortName}`);
          const strength = hasClip ? `${lora.modelStrength} / ${lora.clipStrength}` : String(lora.modelStrength);
          chip.append(
            make("span", "pp-sidebar-gen-chip-name", shortName),
            make("span", "pp-sidebar-gen-chip-strength", strength)
          );
          // Same color the LoRA carries in LoraPal and in the editor's syntax highlighting.
          presentation?.category(chip, `lora:${loraIdentity(lora.name)}`, colorForLora(lora.name, loraTheme));
          chips.append(chip);
        }
        loraBlock.append(loraHead, chips);
        promptsBody.append(loraBlock);
      }

      // Wildcards used
      if (meta.wildcardsUsed.length) {
        const wcBlock = make("div", "pp-sidebar-gen-tags-block");
        wcBlock.dataset.resource = "wildcard";
        const wcHead = make("div", "pp-sidebar-gen-prompt-head");
        wcHead.append(make("span", "pp-sidebar-gen-label", `Wildcards (${meta.wildcardsUsed.length})`));
        const allWcText = meta.wildcardsUsed.map(w => `__${w.replace(/^__|__$/g, "")}__`).join(", ");
        const copyWcBtn = btn("Copy wildcards", e => copyValue(allWcText, "wildcards", e.currentTarget), "pp-sidebar-gen-copy-btn");
        copyWcBtn.dataset.copyRole = "wildcards";
        copyWcBtn.setAttribute("aria-label", "Copy wildcards");
        wcHead.append(copyWcBtn);

        const chips = make("div", "pp-sidebar-gen-chips");
        for (const w of meta.wildcardsUsed) {
          const cleanW = w.replace(/^__|__$/g, "");
          const token = `__${cleanW}__`;
          const chip = btn(cleanW, e => copyValue(token, `wildcard ${cleanW}`, e.currentTarget), "pp-sidebar-gen-chip pp-sidebar-gen-chip--wildcard");
          chip.title = `Click to copy ${token}`;
          chips.append(chip);
        }
        wcBlock.append(wcHead, chips);
        promptsBody.append(wcBlock);
      }

      promptsGroup.append(promptsBody);
      inspectorEl.append(promptsGroup);
    }

    // 3. Generation Parameters Section (Precision Tabular Spec Ledger)
    if (meta.hasParameters) {
      const paramsGroup = make("details", "pp-sidebar-gen-group");
      paramsGroup.dataset.section = "parameters";
      paramsGroup.open = true;
      const paramsSummary = make("summary", "pp-sidebar-gen-group-summary");
      paramsSummary.append(
        make("span", "pp-sidebar-gen-group-title", "Generation Parameters"),
        make("span", "pp-sidebar-gen-badge", String(meta.parameterEntries.length))
      );
      paramsGroup.append(paramsSummary);

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
      inspectorEl.append(paramsGroup);
    }

    // 4. Workflow & Node Components Section (Clean hairline table)
    if (meta.hasWorkflow || meta.workflowComponents.length > 0) {
      const wfGroup = make("details", "pp-sidebar-gen-group");
      wfGroup.dataset.section = "workflow";
      wfGroup.open = true;
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
      inspectorEl.append(wfGroup);
    }
  }

  async function inspectGeneration(id, { quiet = false } = {}) {
    if (disposed || !id) return;
    const version = ++inspectSequence;
    inspectController?.abort();
    const controller = (inspectController = new AbortController());

    const existing = rows.find(r => r.id === id) || (selectedRecord?.id === id ? selectedRecord : null);
    selectedId = id;
    if (existing && selectedRecord?.id !== id) {
      selectedRecord = existing;
      selectedExtra = {};
      selectedNodeIds.clear();
      renderList();
      renderInspector();
    }

    try {
      const fresh = await requestGenerationHistory(`/${encodeURIComponent(id)}`, "GET", undefined, controller.signal);
      if (disposed || controller.signal.aborted || version !== inspectSequence) return;
      selectedRecord = fresh;
      const idx = rows.findIndex(r => r.id === id);
      if (idx >= 0) rows[idx] = fresh;
      renderList();
      renderInspector();

      const extra = await fetchRunEnrichment(fresh, controller.signal);
      if (disposed || controller.signal.aborted || version !== inspectSequence) return;
      if (extra.historyEntry || extra.embedded) {
        selectedExtra = extra;
        if (extra.embedded?.width && extra.embedded?.height) {
          rememberBounded(imageDimensionsCache, fresh.id, { width: extra.embedded.width, height: extra.embedded.height }, 256);
        }
        renderList();
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

  async function refresh(append = false) {
    if (disposed) return;
    const version = ++listSequence;
    listController?.abort();
    const controller = (listController = new AbortController());
    try {
      const favOnly = favFilterBtn.getAttribute("aria-pressed") === "true";
      const days = Number(dateSelect.value) || 0;
      const params = new URLSearchParams({
        q: searchInput.value.trim(),
        favorite: String(favOnly),
        missing: "false",
        since: days > 0 ? String(Date.now() - days * 86400000) : "0",
      });
      if (append && cursor) params.set("cursor", cursor);
      const page = await requestGenerationHistory(`?${params}`, "GET", undefined, controller.signal);
      if (disposed || controller.signal.aborted || version !== listSequence) return;
      const items = Array.isArray(page?.items) ? page.items : [];
      rows = append ? [...rows, ...items] : items;
      cursor = page?.next_cursor || null;
      loadMoreBtn.hidden = !cursor;

      if (selectedId) {
        const updated = rows.find(r => r.id === selectedId);
        if (updated) selectedRecord = { ...selectedRecord, ...updated };
      }
      renderList();
      if (selectedRecord) renderInspector();
    } catch (error) {
      if (!disposed && error?.name !== "AbortError" && visible && active) {
        announce(error.message || String(error), true);
      }
    } finally {
      if (listController === controller) listController = null;
    }
  }

  if (!isTabMode) {
    section.addEventListener("toggle", () => {
      isOpen = section.open;
      persistState();
      if (isOpen && visible && active) {
        refreshAppearance({ force: true });
        refresh();
      }
    });
  }

  searchInput.addEventListener("input", () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => refresh(), 120);
  });
  dateSelect.addEventListener("change", () => refresh());

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
      if (visible && active && isOpen) {
        refreshAppearance({ force: true });
        refresh();
      }
    },
    setActive(nextActive) {
      if (disposed) return;
      const next = Boolean(nextActive);
      if (active === next) return;
      active = next;
      if (active && visible && isOpen) {
        refreshAppearance({ force: true });
        if (prefs?.enabled) {
          requestGenerationHistory("/sync", "POST", {}).then(() => refresh()).catch(() => refresh());
        } else {
          refresh();
        }
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
      clearTimeout(searchDebounce);
      if (rebalanceFrame) cancelAnimationFrame(rebalanceFrame);
      listResize.disconnect();
      listController?.abort();
      inspectController?.abort();
      refineReview?.close();
      refineReview = null;
      unsubscribeCapture?.();
      unsubMetadata?.();
      releaseCardMediaRules();
      if (presentation) presentation.release(listEl);
      section.remove();
    },
  };
}
