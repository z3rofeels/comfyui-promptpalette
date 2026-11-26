import { loadTheme, saveTheme } from "./preferences.js";
import { createPromptUsageStore } from "../prompt_quickness.js";
import {
  loadStyleCatalog,
  getStyleCatalogSync,
  getStyleEntryById,
  resolveStyleModelTarget,
  scoreAndFilterStyles,
} from "./style_catalog.js";
import {
  composeStyleMix,
  formatStyleEntry,
  scanPromptForStyles,
  removeStyleSpan,
  cleanPromptForKrea2,
  detectStyleConflicts,
  estimateTokensQuick,
  buildStyleSpecimenSvg,
} from "./style_prompt_engine.js";
import { STYLE_FACET_COLORS, STYLE_FACET_SHORT } from "./style_autocomplete.js";
import { resolveLoraTarget } from "./lora_sidecar.js";
import { readEditorPreference, writeEditorPreference } from "../prompt_palette_state.js";
import {
  copyPromptPaletteThemeScope,
  installPromptPaletteKeyboardBoundary,
  onPromptPaletteAppearanceChanged,
  svgIcon,
} from "../prompt_palette_shared.js";
import { scheduleDomWidgetRemeasure } from "../prompt_palette_compat.js";
import { observePanelAnchor } from "./performance_runtime.js";

const SIDECAR_GAP = 8;
const SIDECAR_MARGIN = 8;
const MIN_WIDTH = 280;
const MIN_HEIGHT = 280;
const MAX_WIDTH = 960;
const MAX_HEIGHT = 960;
const DEFAULT_WIDTH = 560;
const DEFAULT_HEIGHT = 680;
const SAFE_MOSS_NEGATIVE = "worst quality, bad anatomy, watermark, jpeg artifact";

let sequence = 0;

function make(tag, cls = "", text = "") {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text) el.textContent = text;
  return el;
}

function getViewportBounds() {
  return {
    vw: globalThis.innerWidth || document.documentElement?.clientWidth || 1024,
    vh: globalThis.innerHeight || document.documentElement?.clientHeight || 768,
  };
}

function getNodeScreenBounds(node, root) {
  if (root?.isConnected) {
    const r = root.getBoundingClientRect();
    if (r.width >= 40 && r.height >= 40 && r.bottom > 0 && r.right > 0) return r;
  }
  if (node?.pos && node?.size) {
    const canvas = node.graph?.canvas || globalThis.app?.canvas || globalThis.LGraphCanvas?.active_canvas;
    if (canvas?.ds) {
      const p1 = canvas.ds.toScreen(node.pos[0], node.pos[1]);
      const p2 = canvas.ds.toScreen(node.pos[0] + node.size[0], node.pos[1] + node.size[1]);
      const w = Math.abs(p2[0] - p1[0]);
      const h = Math.abs(p2[1] - p1[1]);
      if (w >= 40 && h >= 40) {
        return {
          left: Math.min(p1[0], p2[0]),
          top: Math.min(p1[1], p2[1]),
          right: Math.max(p1[0], p2[0]),
          bottom: Math.max(p1[1], p2[1]),
          width: w,
          height: h,
        };
      }
    }
  }
  const { vw, vh } = getViewportBounds();
  return {
    left: Math.round(vw * 0.15),
    top: Math.round(vh * 0.1),
    right: Math.round(vw * 0.55),
    bottom: Math.round(vh * 0.7),
    width: Math.round(vw * 0.4),
    height: Math.round(vh * 0.6),
  };
}

function smartAppendPrompt(existing, addition, { isJson = false } = {}) {
  const add = String(addition || "").trim();
  if (!add) return existing;
  if (isJson && add.startsWith("{")) return add;
  const cur = String(existing || "");
  const trimmed = cur.replace(/\s+$/, "");
  if (!trimmed) return add;
  if (/[,;\n]$/.test(trimmed)) return `${trimmed} ${add}`;
  return `${trimmed}, ${add}`;
}

function applyTextReplacement(target, nextText, selStart, selEnd) {
  if (!target || target.readOnly || target.disabled || target.getAttribute("aria-readonly") === "true") return false;
  target.value = nextText;
  const start = Math.max(0, Math.min(nextText.length, selStart));
  const end = Math.max(start, Math.min(nextText.length, selEnd));
  try { target.setSelectionRange(start, end); } catch { /* noop */ }
  target.focus?.({ preventScroll: true });
  target.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
}

export function installStyleSelector({
  root,
  node = null,
  editor,
  getNegative = null,
  setNegative = null,
  beforeOpen = () => {},
} = {}) {
  if (!root) return null;
  if (root.__ppStyleSelector) return root.__ppStyleSelector;

  const usageStore = createPromptUsageStore();
  const savedSize = readEditorPreference("styleSelectorSizeV1", null);
  const panelSize = {
    width: Number.isFinite(savedSize?.width) ? Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, savedSize.width)) : DEFAULT_WIDTH,
    height: Number.isFinite(savedSize?.height) ? Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, savedSize.height)) : DEFAULT_HEIGHT,
  };
  const persistSize = () => writeEditorPreference("styleSelectorSizeV1", { ...panelSize });

  let floatingPosition = null;
  const savedDock = readEditorPreference("styleSelectorDockV1", null);
  if (savedDock && Number.isFinite(savedDock.left) && Number.isFinite(savedDock.top)) {
    floatingPosition = { left: savedDock.left, top: savedDock.top };
  }
  const persistPosition = () => writeEditorPreference("styleSelectorDockV1", floatingPosition ? { ...floatingPosition } : null);

  const sidecar = make("div", "wg-root pp-style-sidecar-window");
  sidecar.id = `pp-styles-${++sequence}`;
  sidecar.hidden = true;
  sidecar.setAttribute("role", "dialog");
  sidecar.setAttribute("aria-label", "Style Studio — Krea 2 & MOSS");
  sidecar.setAttribute("aria-modal", "false");

  sidecar.addEventListener("pointerdown", (e) => { node?._ppCommandTarget?.activate?.(); e.stopPropagation(); });
  sidecar.addEventListener("mousedown", (e) => e.stopPropagation());
  sidecar.addEventListener("click", (e) => e.stopPropagation());
  sidecar.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });

  // ---- Window Header ---------------------------------------------------------
  const header = make("div", "pp-style-window-head");
  const dragHandle = make("button", "pp-style-drag");
  dragHandle.type = "button";
  dragHandle.setAttribute("aria-label", "Move Style Studio; arrow keys move. Double-click to toggle Follow Node.");
  dragHandle.title = "Drag to move · Arrow keys move · Double-click to toggle Follow Node";
  dragHandle.innerHTML = `
    <span class="pp-style-brandmark" aria-hidden="true">${svgIcon("palette", 14)}</span>
    <span class="pp-style-title-wrap">
      <strong>Style Studio</strong>
      <small>Krea 2 &amp; MOSS-Image</small>
    </span>
  `;

  const headerCtrls = make("div", "pp-style-window-ctrls");
  const specsBtn = make("button", "wg-button pp-style-win-btn");
  specsBtn.type = "button";
  specsBtn.innerHTML = `${svgIcon("info", 12)}<span>Specs</span>`;
  specsBtn.title = "Show verified Krea 2 & MOSS sampling parameters and grammar rules";
  specsBtn.setAttribute("aria-expanded", "false");

  const useCursorBtn = make("button", "wg-button pp-style-win-btn");
  useCursorBtn.type = "button";
  useCursorBtn.innerHTML = `${svgIcon("select", 12)}<span>Use cursor</span>`;
  useCursorBtn.title = "Retarget the editor's active cursor or selection";

  const followBtn = make("button", "wg-button pp-style-win-btn");
  followBtn.type = "button";
  followBtn.innerHTML = `${svgIcon("pin", 12)}<span>Follow node</span>`;
  followBtn.title = "Keep Style Studio docked beside node";
  followBtn.setAttribute("aria-pressed", String(!floatingPosition));

  const resetBtn = make("button", "wg-button pp-style-win-btn");
  resetBtn.type = "button";
  resetBtn.innerHTML = `${svgIcon("undo", 12)}<span>Reset</span>`;
  resetBtn.title = "Reset size and dock beside node";

  const closeBtn = make("button", "wg-close-btn");
  closeBtn.type = "button";
  closeBtn.innerHTML = svgIcon("close", 14);
  closeBtn.setAttribute("aria-label", "Close Style Studio");

  headerCtrls.append(specsBtn, useCursorBtn, followBtn, resetBtn);
  header.append(dragHandle, headerCtrls, closeBtn);

  // ---- Main Studio Body ------------------------------------------------------
  const body = make("div", "pp-style-body");

  // 1. Dialect & Target Strip
  const topBar = make("div", "pp-style-topbar");
  const dialectGroup = make("div", "pp-style-dialect-group");
  dialectGroup.setAttribute("role", "tablist");
  dialectGroup.setAttribute("aria-label", "Target model dialect");

  const DIALECT_MODES = [
    { id: "auto", label: "Auto", hint: "Auto-detect Krea 2 or MOSS from connected nodes" },
    { id: "krea2", label: "Krea 2", hint: "Qwen3-VL-4B flowing natural prose" },
    { id: "moss-caption", label: "MOSS Caption", hint: "MOSS detailed prose / \\n caption" },
    { id: "moss-tags", label: "MOSS Tags", hint: "Strict 8-tier ordered SFW Booru tags" },
    { id: "moss-layout", label: "MOSS JSON", hint: "Spatial abs_centralized yxyx JSON layout" },
  ];
  const dialectBtns = new Map();
  for (const mode of DIALECT_MODES) {
    const b = make("button", "pp-style-dialect-btn", mode.label);
    b.type = "button";
    b.title = mode.hint;
    b.dataset.dialect = mode.id;
    dialectBtns.set(mode.id, b);
    dialectGroup.appendChild(b);
  }
  const modelStatusChip = make("span", "pp-style-model-chip", "Auto · Krea 2");
  topBar.append(dialectGroup, modelStatusChip);

  // 2. Collapsible Specs & Workflow Cheat Sheet
  const specsDrawer = make("div", "pp-style-specs");
  specsDrawer.hidden = true;

  // 3. Health / Lint Banner
  const lintBanner = make("div", "pp-style-lint");
  lintBanner.hidden = true;

  // 4. "In This Prompt" Live Scanner Strip
  const inPromptWrap = make("div", "pp-style-in-prompt");
  inPromptWrap.hidden = true;
  const inPromptHead = make("div", "pp-style-in-prompt-head");
  const inPromptLabel = make("span", "pp-style-section-label", "In this prompt");
  const inPromptTargetBadge = make("span", "pp-style-target-badge", "");
  inPromptHead.append(inPromptLabel, inPromptTargetBadge);
  const inPromptChips = make("div", "pp-style-in-prompt-chips");
  inPromptWrap.append(inPromptHead, inPromptChips);

  // 5. Filter & Facets Toolbar
  const filterControls = make("div", "pp-style-controls");
  const searchRow = make("div", "pp-style-search-row");
  const searchWrap = make("label", "pp-style-search-wrap");
  const searchInput = document.createElement("input");
  searchInput.type = "search";
  searchInput.className = "pp-style-search";
  searchInput.placeholder = "Filter styles, cameras, 85mm, angles, poses, lighting…";
  searchInput.setAttribute("aria-label", "Filter Krea 2 and MOSS styles");
  const countBadge = make("span", "pp-style-count-badge", "0");
  searchWrap.append(searchInput, countBadge);

  const viewTabs = make("div", "pp-style-view-tabs");
  const VIEW_MODES = [
    { id: "all", label: "All" },
    { id: "mixes", label: "Mixes" },
    { id: "favorites", label: "★ Fav" },
    { id: "recent", label: "Recent" },
  ];
  const viewTabBtns = new Map();
  for (const vm of VIEW_MODES) {
    const b = make("button", "pp-style-view-btn", vm.label);
    b.type = "button";
    b.dataset.view = vm.id;
    viewTabBtns.set(vm.id, b);
    viewTabs.appendChild(b);
  }
  searchRow.append(searchWrap, viewTabs);

  const facetRail = make("div", "pp-style-facets");
  facetRail.setAttribute("role", "tablist");
  facetRail.setAttribute("aria-label", "Style facets");

  filterControls.append(searchRow, facetRail);

  // 6. Scrollable Cards List
  const scrollList = make("div", "pp-style-list");
  scrollList.setAttribute("tabindex", "-1");

  // 7. Composer / Staging Tray
  const composer = make("div", "pp-style-composer");
  const stageHead = make("div", "pp-style-stage-head");
  const stageTitle = make("span", "pp-style-section-label", "Mix & Composer");
  const stageTools = make("div", "pp-style-stage-tools");

  const focusBtn = make("button", "wg-button pp-style-mini-btn", "Focus: Subject");
  focusBtn.type = "button";
  focusBtn.title = "Toggle Krea 2 / MOSS word-budget focus between Subject-First and Scene-First";

  const combBtn = make("button", "wg-button pp-style-mini-btn", "Mix {%a|b}");
  combBtn.type = "button";
  combBtn.title = "Compile staged options into a Prompt Palette {%option1|option2} variation block";
  combBtn.setAttribute("aria-pressed", "false");

  const clearStageBtn = make("button", "wg-button pp-style-mini-btn", "Clear");
  clearStageBtn.type = "button";
  clearStageBtn.title = "Clear all staged items";

  stageTools.append(focusBtn, combBtn, clearStageBtn);
  stageHead.append(stageTitle, stageTools);

  const stagedPills = make("div", "pp-style-staged-pills");

  const textHelperRow = make("div", "pp-style-quote-row");
  const quoteInput = document.createElement("input");
  quoteInput.type = "text";
  quoteInput.className = "pp-style-quote-input";
  quoteInput.placeholder = 'Optional "Quoted Text" (e.g. CAFE LUMA) — auto-quoted for Krea 2 / MOSS';
  quoteInput.setAttribute("aria-label", "Quoted typography text");
  const quoteClearBtn = make("button", "wg-button pp-style-mini-btn", "×");
  quoteClearBtn.type = "button";
  quoteClearBtn.title = "Clear quoted typography text";
  textHelperRow.append(quoteInput, quoteClearBtn);

  const previewWrap = make("div", "pp-style-preview-wrap");
  const previewMeta = make("div", "pp-style-preview-meta");
  const previewCode = make("pre", "pp-style-preview-code", "");
  previewWrap.append(previewMeta, previewCode);

  const actionBar = make("div", "pp-style-actions");
  const insertBtn = make("button", "wg-button primary pp-style-action-btn", "Insert at Caret");
  insertBtn.type = "button";
  const appendBtn = make("button", "wg-button pp-style-action-btn", "Smart Append");
  appendBtn.type = "button";
  const copyBtn = make("button", "wg-button pp-style-action-btn");
  copyBtn.type = "button";
  copyBtn.innerHTML = `${svgIcon("copy", 12)}<span>Copy</span>`;
  const safeNegBtn = make("button", "wg-button pp-style-action-btn", "+ Safe Negative");
  safeNegBtn.type = "button";
  safeNegBtn.title = "Add neutral MOSS Base/SFT quality guard ('worst quality, bad anatomy, watermark, jpeg artifact') to Negative prompt";
  actionBar.append(insertBtn, appendBtn, copyBtn, safeNegBtn);

  composer.append(stageHead, stagedPills, textHelperRow, previewWrap, actionBar);

  body.append(topBar, specsDrawer, lintBanner, inPromptWrap, filterControls, scrollList, composer);

  // ---- Window Footer & Resizers ----------------------------------------------
  const footer = make("div", "pp-style-window-foot");
  const status = make("div", "pp-tool-status");
  status.setAttribute("role", "status");
  const resizeHandle = make("button", "pp-style-sidecar-resize", "◢");
  resizeHandle.type = "button";
  resizeHandle.setAttribute("aria-label", "Resize Style Studio; arrow keys resize");
  resizeHandle.title = "Drag to resize · Arrow keys resize";
  footer.append(status, resizeHandle);

  sidecar.append(header, body, footer);

  const resizers = [];
  for (const spec of [
    { edge: "e", cls: "pp-style-resizer-e", title: "Drag right border to resize" },
    { edge: "w", cls: "pp-style-resizer-w", title: "Drag left border to resize" },
    { edge: "s", cls: "pp-style-resizer-s", title: "Drag bottom border to resize" },
    { edge: "sw", cls: "pp-style-resizer-sw", title: "Drag bottom-left corner to resize" },
    { edge: "se", cls: "pp-style-resizer-se", title: "Drag bottom-right corner to resize" },
  ]) {
    const resizer = make("div", `pp-style-resizer ${spec.cls}`);
    resizer.title = spec.title;
    sidecar.appendChild(resizer);
    resizers.push({ el: resizer, edge: spec.edge });
  }
  resizers.push({ el: resizeHandle, edge: "se" });
  document.body.appendChild(sidecar);

  // ---- Studio State ----------------------------------------------------------
  let disposed = false;
  let catalog = null;
  let catalogLoading = false;
  let catalogError = "";
  let activeEditor = editor;
  let lastEditor = editor;
  let dialectChoice = "auto";
  let viewMode = "all";
  let activeFacet = "all";
  let searchQuery = "";
  let focusOrder = "subject";
  let combinatorialMix = false;
  let quotedText = "";
  let stagedIds = [];
  let expandedIds = new Set();
  let gesture = null;
  let sidecarPlacement = "";
  let stopPlacement = null;
  let themeObserver = null;
  let specsOpen = false;
  let editorPollListeners = [];

  const setStatus = (msg, error = false) => {
    status.textContent = msg;
    status.classList.toggle("is-error", error);
  };

  function resolveCurrentDialect() {
    const theme = loadTheme();
    const prefFilter = theme.styleModelFilter || "auto";
    const prefDialect = theme.styleMossDialect || "caption";
    if (dialectChoice === "krea2") {
      return { model: "krea2", filterModel: "krea2", mossDialect: "caption", badge: "Manual · Krea 2 Prose" };
    }
    if (dialectChoice === "moss-caption") {
      return { model: "moss", filterModel: "moss", mossDialect: "caption", badge: "Manual · MOSS Caption" };
    }
    if (dialectChoice === "moss-tags") {
      return { model: "moss", filterModel: "moss", mossDialect: "tags", badge: "Manual · MOSS Ordered Tags" };
    }
    if (dialectChoice === "moss-layout") {
      return { model: "moss", filterModel: "moss", mossDialect: "layout", badge: "Manual · MOSS Spatial JSON" };
    }
    const detected = resolveStyleModelTarget(node, prefFilter);
    const model = detected.model === "moss" ? "moss" : "krea2";
    const filterModel = prefFilter === "both" ? "both" : detected.model;
    return {
      model,
      filterModel,
      mossDialect: model === "moss" ? prefDialect : "caption",
      badge: detected.detail,
    };
  }

  function currentTargetSnapshot() {
    const resolved = resolveLoraTarget(node, editor, lastEditor || activeEditor);
    const target = resolved?.surface?.isConnected ? resolved.surface : (activeEditor?.isConnected ? activeEditor : editor);
    const text = String(target?.value ?? "");
    const start = Number.isFinite(target?.selectionStart) ? target.selectionStart : text.length;
    const end = Number.isFinite(target?.selectionEnd) ? target.selectionEnd : start;
    const readOnly = Boolean(!target || target.readOnly || target.disabled || target.getAttribute?.("aria-readonly") === "true" || target.contentEditable === "false");
    let targetLabel = "Prompt";
    const fieldWrap = target?.closest?.("[data-field-id]");
    if (fieldWrap) {
      const labelEl = fieldWrap.querySelector(".pp-field-title");
      const name = labelEl?.value || labelEl?.textContent || "Field";
      targetLabel = `Field: ${String(name).trim()}`;
    } else if (target?.classList?.contains("ppwc-textarea")) {
      targetLabel = "Weight Controller";
    } else if (node?._ppCombinatorialActive || (node?.comfyClass || node?.type) === "PromptPaletteCombinatorial") {
      targetLabel = "Combinatorial Prompt";
    }
    return { target, text, start, end, readOnly, targetLabel };
  }

  function bindTargetInputSync(target) {
    for (const off of editorPollListeners) off();
    editorPollListeners = [];
    if (!target) return;
    let raf = 0;
    const onInput = () => {
      if (raf || sidecar.hidden || disposed) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (!sidecar.hidden && !disposed) renderDiagnosticsAndScan();
      });
    };
    target.addEventListener("input", onInput);
    editorPollListeners.push(() => {
      if (raf) cancelAnimationFrame(raf);
      target.removeEventListener("input", onInput);
    });
  }

  // ---- Placement, Drag & Resize ---------------------------------------------
  function syncTheme() {
    if (!sidecar.isConnected) return;
    const scope = root.closest?.(".wg-node, .pp-node, .ppwc-surface") || root;
    copyPromptPaletteThemeScope(scope, sidecar);
    for (const cls of ["wg-high-contrast", "wg-reduce-motion", "wg-no-animations", "wg-disable-animations", "wg-large-text"]) {
      sidecar.classList.toggle(cls, scope.classList?.contains(cls) === true);
    }
  }

  function finishGesture() {
    if (!gesture) return;
    const { target, id, type } = gesture;
    gesture = null;
    if (target?.hasPointerCapture?.(id)) {
      try { target.releasePointerCapture(id); } catch {}
    }
    sidecar.classList.remove("is-manipulating");
    if (type === "resize") {
      persistSize();
      persistPosition();
    } else {
      persistPosition();
    }
  }

  function placeSidecar() {
    if (sidecar.hidden) return;
    if (gesture) return;
    const { vw, vh } = getViewportBounds();
    const maxW = Math.max(MIN_WIDTH, vw - SIDECAR_MARGIN * 2);
    const maxH = Math.max(MIN_HEIGHT, vh - SIDECAR_MARGIN * 2);
    const width = Math.min(Math.max(MIN_WIDTH, panelSize.width), maxW);
    const height = Math.min(Math.max(MIN_HEIGHT, panelSize.height), maxH);

    let left, top;
    if (floatingPosition) {
      left = floatingPosition.left;
      top = floatingPosition.top;
    } else {
      const bounds = getNodeScreenBounds(node, root);
      let dockLeft = bounds.right + SIDECAR_GAP;
      if (dockLeft + width > vw - SIDECAR_MARGIN) {
        dockLeft = bounds.left - SIDECAR_GAP - width;
      }
      if (dockLeft < SIDECAR_MARGIN && bounds.right + SIDECAR_GAP + width > vw - SIDECAR_MARGIN) {
        const spaceLeft = Math.max(0, bounds.left - SIDECAR_MARGIN);
        const spaceRight = Math.max(0, vw - SIDECAR_MARGIN - bounds.right);
        dockLeft = spaceRight >= spaceLeft ? bounds.right + SIDECAR_GAP : bounds.left - SIDECAR_GAP - width;
      }
      left = dockLeft;
      top = bounds.top;
    }

    left = Math.max(SIDECAR_MARGIN, Math.min(left, vw - width - SIDECAR_MARGIN));
    top = Math.max(SIDECAR_MARGIN, Math.min(top, vh - height - SIDECAR_MARGIN));

    const key = [Math.round(left), Math.round(top), Math.round(width), Math.round(height), floatingPosition ? "f" : "a"].join();
    if (key === sidecarPlacement) return;
    sidecarPlacement = key;

    Object.assign(sidecar.style, {
      left: `${Math.round(left)}px`,
      top: `${Math.round(top)}px`,
      width: `${Math.round(width)}px`,
      height: `${Math.round(height)}px`,
    });
    followBtn.setAttribute("aria-pressed", String(!floatingPosition));
  }

  function onPointerMove(e) {
    if (!gesture || e.pointerId !== gesture.id) return;
    e.preventDefault();
    e.stopPropagation();
    const { vw, vh } = getViewportBounds();
    const maxW = Math.max(MIN_WIDTH, vw - SIDECAR_MARGIN * 2);
    const maxH = Math.max(MIN_HEIGHT, vh - SIDECAR_MARGIN * 2);

    if (gesture.type === "resize") {
      const { edge, startX, startY, startLeft, startTop, startWidth, startHeight } = gesture;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      let newWidth = startWidth;
      let newHeight = startHeight;
      let newLeft = startLeft;

      if (edge.includes("e")) {
        const maxAllowedW = Math.min(MAX_WIDTH, maxW, vw - startLeft - SIDECAR_MARGIN);
        newWidth = Math.max(MIN_WIDTH, Math.min(maxAllowedW, startWidth + dx));
      } else if (edge.includes("w")) {
        const startRight = startLeft + startWidth;
        const maxAllowedW = Math.min(MAX_WIDTH, maxW, startRight - SIDECAR_MARGIN);
        newWidth = Math.max(MIN_WIDTH, Math.min(maxAllowedW, startWidth - dx));
        newLeft = startRight - newWidth;
      }
      if (edge.includes("s")) {
        const maxAllowedH = Math.min(MAX_HEIGHT, maxH, vh - startTop - SIDECAR_MARGIN);
        newHeight = Math.max(MIN_HEIGHT, Math.min(maxAllowedH, startHeight + dy));
      }
      panelSize.width = Math.round(newWidth);
      panelSize.height = Math.round(newHeight);
      if (floatingPosition || edge.includes("w")) {
        floatingPosition = { left: Math.round(newLeft), top: Math.round(startTop) };
      }
      sidecar.style.left = `${Math.round(newLeft)}px`;
      sidecar.style.width = `${panelSize.width}px`;
      sidecar.style.height = `${panelSize.height}px`;
      sidecarPlacement = "";
    } else if (gesture.type === "move") {
      const dx = e.clientX - gesture.startX;
      const dy = e.clientY - gesture.startY;
      const width = sidecar.offsetWidth || panelSize.width;
      const height = sidecar.offsetHeight || panelSize.height;
      const clampedL = Math.round(Math.max(SIDECAR_MARGIN, Math.min(gesture.startLeft + dx, vw - width - SIDECAR_MARGIN)));
      const clampedT = Math.round(Math.max(SIDECAR_MARGIN, Math.min(gesture.startTop + dy, vh - height - SIDECAR_MARGIN)));
      floatingPosition = { left: clampedL, top: clampedT };
      sidecar.style.left = `${clampedL}px`;
      sidecar.style.top = `${clampedT}px`;
      sidecarPlacement = "";
      followBtn.setAttribute("aria-pressed", "false");
    }
  }

  function startGesture(type, e, edge = "") {
    if (e.button !== 0 || disposed) return;
    e.preventDefault();
    e.stopPropagation();
    const r = sidecar.getBoundingClientRect();
    gesture = {
      type,
      edge,
      id: e.pointerId,
      target: e.currentTarget,
      startX: e.clientX,
      startY: e.clientY,
      startLeft: r.left,
      startTop: r.top,
      startWidth: r.width,
      startHeight: r.height,
    };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
    sidecar.classList.add("is-manipulating");
  }

  function onHandleKeyDown(e, isResize, edge = "se") {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    const step = e.shiftKey ? 40 : 12;
    const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
    const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
    const { vw, vh } = getViewportBounds();
    const r = sidecar.getBoundingClientRect();
    if (isResize) {
      const signX = edge.includes("w") ? -1 : 1;
      const newW = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, vw - SIDECAR_MARGIN * 2, r.width + dx * signX));
      const newH = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, vh - SIDECAR_MARGIN * 2, r.height + dy));
      panelSize.width = Math.round(newW);
      panelSize.height = Math.round(newH);
      persistSize();
      sidecarPlacement = "";
      placeSidecar();
    } else {
      const newL = Math.max(SIDECAR_MARGIN, Math.min(vw - r.width - SIDECAR_MARGIN, r.left + dx));
      const newT = Math.max(SIDECAR_MARGIN, Math.min(vh - r.height - SIDECAR_MARGIN, r.top + dy));
      floatingPosition = { left: Math.round(newL), top: Math.round(newT) };
      persistPosition();
      sidecarPlacement = "";
      placeSidecar();
    }
  }

  function toggleFollow() {
    finishGesture();
    if (floatingPosition) {
      floatingPosition = null;
    } else {
      const r = sidecar.getBoundingClientRect();
      floatingPosition = { left: Math.round(r.left), top: Math.round(r.top) };
    }
    persistPosition();
    sidecarPlacement = "";
    placeSidecar();
  }

  function resetWindow() {
    finishGesture();
    const { vw, vh } = getViewportBounds();
    panelSize.width = Math.min(DEFAULT_WIDTH, Math.max(MIN_WIDTH, vw - SIDECAR_MARGIN * 2));
    panelSize.height = Math.min(DEFAULT_HEIGHT, Math.max(MIN_HEIGHT, vh - SIDECAR_MARGIN * 2));
    floatingPosition = null;
    persistSize();
    persistPosition();
    sidecarPlacement = "";
    placeSidecar();
  }

  // ---- Studio Rendering Helpers ---------------------------------------------
  function renderSpecs() {
    specsDrawer.hidden = !specsOpen;
    specsBtn.setAttribute("aria-expanded", String(specsOpen));
    specsBtn.classList.toggle("active", specsOpen);
    if (!specsOpen) {
      specsDrawer.replaceChildren();
      return;
    }
    specsDrawer.replaceChildren();
    const grid = make("div", "pp-style-specs-grid");
    const krea = catalog?.models?.krea2;
    const moss = catalog?.models?.moss;

    const makeCard = (title, lines, antiList) => {
      const card = make("div", "pp-style-spec-card");
      card.appendChild(make("strong", "", title));
      for (const l of lines) card.appendChild(make("div", "pp-style-spec-line", l));
      if (antiList?.length) {
        const ul = make("ul", "pp-style-spec-avoid");
        for (const a of antiList.slice(0, 3)) {
          ul.appendChild(make("li", "", `Avoid: ${a}`));
        }
        card.appendChild(ul);
      }
      return card;
    };

    grid.append(
      makeCard("Krea 2 (Qwen3-VL-4B)", [
        `Turbo: ${krea?.params?.turbo || "8 steps, CFG 1.0, ConditioningZeroOut"}`,
        `Raw: ${krea?.params?.raw || "52 steps, CFG 3.5"}`,
        `Grammar: Flowing prose + \"quoted text\"`,
      ], krea?.antiPatterns),
      makeCard("MOSS-Image (5B DiT + Qwen3.5-9B)", [
        `Base: ${moss?.params?.base || "50+ steps, CFG 3-6, Shift 5, SLG 22"}`,
        `SFT: ${moss?.params?.sft || "30-50 steps, CFG 3.0"}`,
        `Turbo: ${moss?.params?.turbo || "8 steps, CFG 1.0"}`,
        `Ordered Tags: quality → score → meta → year → char → series → @artist → general → rating:general`,
      ], moss?.antiPatterns),
    );
    specsDrawer.appendChild(grid);
  }

  function renderFacetRail() {
    facetRail.replaceChildren();
    const facets = [{ id: "all", short: "All", label: "All facets" }, ...(catalog?.facets || [])];
    for (const f of facets) {
      const chip = make("button", "pp-style-facet-chip" + (activeFacet === f.id ? " active" : ""), f.short || f.label);
      chip.type = "button";
      chip.title = f.label || f.short;
      chip.dataset.facet = f.id;
      chip.setAttribute("aria-pressed", String(activeFacet === f.id));
      if (f.id !== "all" && STYLE_FACET_COLORS[f.id]) {
        chip.style.setProperty("--pp-facet-color", STYLE_FACET_COLORS[f.id]);
      }
      chip.addEventListener("click", () => {
        activeFacet = f.id;
        if (viewMode === "mixes") viewMode = "all";
        renderStudio();
      });
      facetRail.appendChild(chip);
    }
  }

  function renderDiagnosticsAndScan() {
    const info = resolveCurrentDialect();
    const { target, text, targetLabel } = currentTargetSnapshot();
    const allEntries = Array.isArray(catalog?.styles) ? catalog.styles : [];
    const activeHits = allEntries.length ? scanPromptForStyles(text, allEntries) : [];
    const stagedEntries = stagedIds.map((id) => getStyleEntryById(id)).filter(Boolean);

    modelStatusChip.textContent = info.badge;
    for (const [id, btn] of dialectBtns.entries()) {
      const active = dialectChoice === id;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-selected", String(active));
    }

    // 1. In This Prompt scanner strip
    inPromptTargetBadge.textContent = targetLabel;
    inPromptChips.replaceChildren();
    if (activeHits.length) {
      inPromptWrap.hidden = false;
      for (const hit of activeHits) {
        const chip = make("span", "pp-style-present-chip");
        chip.style.setProperty("--pp-facet-color", STYLE_FACET_COLORS[hit.entry.facet] || "var(--wg-accent)");
        const jump = make("button", "pp-style-present-jump", hit.entry.name);
        jump.type = "button";
        jump.title = `Select "${hit.matchedText}" in prompt`;
        jump.addEventListener("click", () => {
          if (!target?.isConnected) return;
          target.focus?.({ preventScroll: true });
          try { target.setSelectionRange(hit.start, hit.end); } catch {}
        });
        const remove = make("button", "pp-style-present-remove", "×");
        remove.type = "button";
        remove.title = `Remove "${hit.entry.name}" from prompt`;
        remove.setAttribute("aria-label", `Remove ${hit.entry.name} from prompt`);
        remove.addEventListener("click", () => {
          const cur = currentTargetSnapshot();
          const refreshed = scanPromptForStyles(cur.text, allEntries).find((h) => h.entry.id === hit.entry.id);
          if (!refreshed) return;
          const cleaned = removeStyleSpan(cur.text, refreshed.start, refreshed.end);
          if (applyTextReplacement(cur.target, cleaned, refreshed.start, refreshed.start)) {
            setStatus(`Removed "${hit.entry.name}" cleanly.`);
            renderDiagnosticsAndScan();
          } else {
            setStatus("Target prompt is read-only.", true);
          }
        });
        chip.append(jump, remove);
        inPromptChips.appendChild(chip);
      }
    } else {
      inPromptWrap.hidden = true;
    }

    // 2. Grammar & Conflict Diagnostics
    const warnings = detectStyleConflicts({
      stagedEntries,
      activeHits,
      promptText: text,
      model: info.model,
      mossDialect: info.mossDialect,
    });
    lintBanner.replaceChildren();
    if (warnings.length) {
      lintBanner.hidden = false;
      const primary = warnings[0];
      const textWrap = make("div", "pp-style-lint-copy");
      textWrap.appendChild(make("strong", "", primary.title));
      textWrap.appendChild(make("small", "", primary.detail));
      lintBanner.appendChild(textWrap);
      if (primary.fixable && info.model === "krea2") {
        const fixBtn = make("button", "wg-button pp-style-lint-fix", "Clean for Krea 2");
        fixBtn.type = "button";
        fixBtn.title = "Strip (weight:1.x) brackets and CLIP buzzwords while keeping prose";
        fixBtn.addEventListener("click", () => {
          const cur = currentTargetSnapshot();
          const cleaned = cleanPromptForKrea2(cur.text);
          if (applyTextReplacement(cur.target, cleaned, cleaned.length, cleaned.length)) {
            setStatus("Cleaned bracket weights & buzzwords for Krea 2.");
            renderDiagnosticsAndScan();
          } else {
            setStatus("Target editor is read-only.", true);
          }
        });
        lintBanner.appendChild(fixBtn);
      }
    } else {
      lintBanner.hidden = true;
    }

    return { info, activeHits, stagedEntries, targetInfo: currentTargetSnapshot() };
  }

  function renderComposer(context) {
    const { info, stagedEntries, targetInfo } = context;
    const isJson = info.model === "moss" && info.mossDialect === "layout";
    focusBtn.textContent = focusOrder === "scene" ? "Focus: Scene" : "Focus: Subject";
    focusBtn.hidden = isJson || (info.model === "moss" && info.mossDialect === "tags");
    combBtn.setAttribute("aria-pressed", String(combinatorialMix));
    combBtn.classList.toggle("active", combinatorialMix);

    stagedPills.replaceChildren();
    if (!stagedIds.length) {
      const hint = make("span", "pp-style-stage-empty", "Click + Stage on cards to stack traits, or pick a Curated Mix.");
      stagedPills.appendChild(hint);
    } else {
      stagedIds.forEach((id, idx) => {
        const entry = getStyleEntryById(id);
        if (!entry) return;
        const pill = make("span", "pp-style-staged-pill");
        pill.style.setProperty("--pp-facet-color", STYLE_FACET_COLORS[entry.facet] || "var(--wg-accent)");
        pill.appendChild(make("span", "pp-style-staged-name", entry.name));
        if (idx > 0) {
          const left = make("button", "pp-style-staged-move", "‹");
          left.type = "button";
          left.title = "Move earlier";
          left.addEventListener("click", () => {
            [stagedIds[idx - 1], stagedIds[idx]] = [stagedIds[idx], stagedIds[idx - 1]];
            renderStudio();
          });
          pill.appendChild(left);
        }
        const del = make("button", "pp-style-staged-del", "×");
        del.type = "button";
        del.title = `Unstage ${entry.name}`;
        del.addEventListener("click", () => {
          stagedIds = stagedIds.filter((item) => item !== id);
          renderStudio();
        });
        pill.appendChild(del);
        stagedPills.appendChild(pill);
      });
    }

    const compiled = composeStyleMix(stagedEntries, {
      model: info.model,
      mossDialect: info.mossDialect,
      focusOrder,
      quotedText,
      combinatorial: combinatorialMix,
      includeSafeAnchor: true,
    });
    const compiledText = compiled.text || "";
    const hasOutput = compiledText.length > 0;
    const tokCount = hasOutput ? estimateTokensQuick(compiledText) : 0;

    previewMeta.textContent = hasOutput
      ? `${compiled.dialect.toUpperCase()} preview · ~${tokCount} tok`
      : "Stage 1+ styles (or enter quoted text) to compile model-native output";
    previewCode.textContent = hasOutput ? compiledText : "No traits staged yet — click '+ Insert' on any card or '+ Stage' to blend multiple traits.";
    previewCode.classList.toggle("is-empty", !hasOutput);

    const canWrite = hasOutput && !targetInfo.readOnly;
    insertBtn.disabled = !canWrite;
    appendBtn.disabled = !canWrite;
    copyBtn.disabled = !hasOutput;
    clearStageBtn.disabled = stagedIds.length === 0 && !quotedText;

    const canNeg = typeof setNegative === "function";
    safeNegBtn.hidden = !canNeg;
    if (canNeg) {
      const showMossHint = info.model === "moss";
      safeNegBtn.disabled = !showMossHint;
      safeNegBtn.title = showMossHint
        ? "Append neutral SFW MOSS Base/SFT quality guard into Negative prompt"
        : "Switch dialect to MOSS to inject MOSS quality negatives (Krea 2 Turbo ignores negatives)";
    }

    return { compiled, isJson };
  }

  function renderCards(context) {
    scrollList.replaceChildren();
    if (catalogLoading) {
      scrollList.appendChild(make("div", "pp-style-empty", "Loading Krea 2 & MOSS style catalog…"));
      return;
    }
    if (catalogError) {
      scrollList.appendChild(make("div", "pp-style-empty is-error", catalogError));
      return;
    }
    if (!catalog) return;

    const { info, activeHits } = context;
    const activeConflictMap = new Map();
    for (const hit of activeHits) {
      if (hit.entry?.conflictGroup) activeConflictMap.set(hit.entry.conflictGroup, hit.entry);
    }
    for (const id of stagedIds) {
      const e = getStyleEntryById(id);
      if (e?.conflictGroup) activeConflictMap.set(e.conflictGroup, e);
    }

    if (viewMode === "mixes") {
      const mixes = Array.isArray(catalog.curated_mixes) ? catalog.curated_mixes : [];
      const q = searchQuery.trim().toLowerCase();
      const filteredMixes = mixes.filter((m) => {
        if (q && !`${m.name} ${m.description} ${m.model}`.toLowerCase().includes(q)) return false;
        if (dialectChoice === "krea2" && m.model === "moss") return false;
        if (dialectChoice.startsWith("moss") && m.model === "krea2") return false;
        return true;
      });
      countBadge.textContent = String(filteredMixes.length);
      if (!filteredMixes.length) {
        scrollList.appendChild(make("div", "pp-style-empty", "No curated mixes match this filter."));
        return;
      }
      for (const mix of filteredMixes) {
        const card = make("article", "pp-style-mix-card");
        const head = make("div", "pp-style-mix-head");
        const title = make("strong", "", mix.name);
        const badge = make("span", "pp-style-model-pill", mix.model === "moss" ? "MOSS" : "KREA2");
        head.append(title, badge);
        card.appendChild(head);
        card.appendChild(make("p", "pp-style-mix-desc", mix.description || ""));

        const tagRow = make("div", "pp-style-mix-parts");
        for (const sid of mix.styleIds || []) {
          const item = getStyleEntryById(sid);
          if (item) tagRow.appendChild(make("span", "pp-style-mini-tag", item.name));
        }
        card.appendChild(tagRow);

        if (mix.quotedSample) {
          card.appendChild(make("div", "pp-style-mix-sample", mix.quotedSample));
        }

        const btns = make("div", "pp-style-mix-actions");
        const loadBtn = make("button", "wg-button primary pp-style-card-btn", "Load Mix");
        loadBtn.type = "button";
        loadBtn.addEventListener("click", () => {
          stagedIds = (mix.styleIds || []).filter((sid) => !!getStyleEntryById(sid));
          if (mix.model === "moss") {
            dialectChoice = mix.dialect === "tags" ? "moss-tags" : mix.dialect === "layout" ? "moss-layout" : "moss-caption";
          } else {
            dialectChoice = "krea2";
          }
          setStatus(`Loaded mix "${mix.name}" into composer.`);
          renderStudio();
        });
        btns.appendChild(loadBtn);

        if (mix.quotedSample) {
          const applySample = make("button", "wg-button pp-style-card-btn", "Insert Full Sample");
          applySample.type = "button";
          applySample.addEventListener("click", () => {
            const cur = currentTargetSnapshot();
            const sample = typeof mix.quotedSample === "string" ? mix.quotedSample : JSON.stringify(mix.quotedSample, null, 2);
            const next = smartAppendPrompt(cur.text, sample, { isJson: mix.dialect === "layout" });
            if (applyTextReplacement(cur.target, next, next.length, next.length)) {
              setStatus(`Inserted curated sample "${mix.name}".`);
              renderDiagnosticsAndScan();
            } else {
              setStatus("Target editor is read-only.", true);
            }
          });
          btns.appendChild(applySample);
        }
        card.appendChild(btns);
        scrollList.appendChild(card);
      }
      return;
    }

    const favIds = new Set(usageStore.styleFavoriteIds?.() || []);
    const recIds = usageStore.styleRecentIds?.(24) || [];
    const entries = scoreAndFilterStyles({
      query: searchQuery,
      facet: activeFacet,
      model: info.filterModel,
      favoriteIds: favIds,
      recentIds: recIds,
      filterMode: viewMode === "favorites" ? "favorites" : viewMode === "recent" ? "recent" : "all",
      limit: 120,
    });
    countBadge.textContent = String(entries.length);

    if (!entries.length) {
      scrollList.appendChild(make("div", "pp-style-empty",
        viewMode === "favorites" ? "No starred styles yet — click ★ on any card."
          : viewMode === "recent" ? "No recently inserted styles yet."
          : "No styles match your filter — try clearing the search or switching facet."));
      return;
    }

    const grid = make("div", "pp-style-grid");
    for (const entry of entries) {
      const staged = stagedIds.includes(entry.id);
      const fav = favIds.has(entry.id);
      const conflictWith = entry.conflictGroup ? activeConflictMap.get(entry.conflictGroup) : null;
      const hasConflict = !!conflictWith && conflictWith.id !== entry.id;
      const isExpanded = expandedIds.has(entry.id);
      const formatted = formatStyleEntry(entry, { model: info.model, mossDialect: info.mossDialect });
      const facetColor = STYLE_FACET_COLORS[entry.facet] || "#d49a52";

      const card = make("article", "pp-style-card" + (staged ? " is-staged" : "") + (hasConflict ? " has-conflict" : ""));
      card.style.setProperty("--pp-facet-color", facetColor);

      const main = make("div", "pp-style-card-main");
      const thumb = make("div", "pp-style-card-thumb");
      thumb.innerHTML = buildStyleSpecimenSvg(entry);

      const copyCol = make("div", "pp-style-card-copy");
      const titleRow = make("div", "pp-style-card-title-row");
      const title = make("strong", "pp-style-card-name", entry.name);
      titleRow.appendChild(title);

      const badges = make("div", "pp-style-card-badges");
      badges.appendChild(make("span", "pp-style-facet-pill", STYLE_FACET_SHORT[entry.facet] || entry.facet));
      badges.appendChild(make("span", "pp-style-model-pill", entry.model === "both" ? "KREA2+MOSS" : entry.model === "moss" ? "MOSS" : "KREA2"));
      if (hasConflict) {
        const cBadge = make("span", "pp-style-conflict-pill", `⚠ vs ${conflictWith.name}`);
        cBadge.title = entry.conflictReason || `Conflicts with ${conflictWith.name}`;
        badges.appendChild(cBadge);
      }
      titleRow.appendChild(badges);

      const phrasePreview = make("div", "pp-style-card-phrase", formatted);
      copyCol.append(titleRow, phrasePreview);

      const starBtn = make("button", "pp-style-star-btn" + (fav ? " active" : ""), fav ? "★" : "☆");
      starBtn.type = "button";
      starBtn.setAttribute("aria-pressed", String(fav));
      starBtn.title = fav ? "Remove from favorite styles" : "Star favorite style";
      starBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        usageStore.toggleStyleFavorite?.(entry.id);
        renderStudio();
      });

      main.append(thumb, copyCol, starBtn);

      const footerRow = make("div", "pp-style-card-actions");
      const stageBtn = make("button", "wg-button pp-style-card-btn" + (staged ? " active" : ""), staged ? "✓ Staged" : "+ Stage");
      stageBtn.type = "button";
      stageBtn.setAttribute("aria-pressed", String(staged));
      stageBtn.addEventListener("click", () => {
        if (staged) stagedIds = stagedIds.filter((x) => x !== entry.id);
        else stagedIds = [...stagedIds, entry.id];
        renderStudio();
      });

      const quickInsertBtn = make("button", "wg-button pp-style-card-btn", "+ Insert");
      quickInsertBtn.type = "button";
      quickInsertBtn.title = "Insert this style immediately at editor cursor";
      quickInsertBtn.addEventListener("click", () => insertSingleEntry(entry));

      const detailBtn = make("button", "wg-button pp-style-card-btn pp-style-detail-btn", isExpanded ? "Details ▴" : "Details ▾");
      detailBtn.type = "button";
      detailBtn.setAttribute("aria-expanded", String(isExpanded));
      detailBtn.addEventListener("click", () => {
        if (expandedIds.has(entry.id)) expandedIds.delete(entry.id);
        else expandedIds.add(entry.id);
        renderStudio();
      });

      footerRow.append(stageBtn, quickInsertBtn, detailBtn);
      card.append(main, footerRow);

      if (isExpanded) {
        const drawer = make("div", "pp-style-card-details");
        if (entry.description) drawer.appendChild(make("p", "pp-style-detail-desc", entry.description));
        if (entry.whenToUse) drawer.appendChild(make("p", "pp-style-detail-when", `When to use: ${entry.whenToUse}`));
        if (Array.isArray(entry.variants) && entry.variants.length) {
          drawer.appendChild(make("p", "pp-style-detail-meta", `Trained variants: ${entry.variants.join(" · ")}`));
        }
        if (entry.provenance) drawer.appendChild(make("p", "pp-style-detail-meta", `Provenance: ${entry.provenance}`));
        if (Array.isArray(entry.pairsWith) && entry.pairsWith.length) {
          const pairsWrap = make("div", "pp-style-pairs-row");
          pairsWrap.appendChild(make("span", "pp-style-pairs-label", "Pairs with:"));
          for (const pid of entry.pairsWith) {
            const partner = getStyleEntryById(pid);
            if (!partner) continue;
            const pBtn = make("button", "pp-style-pair-chip", `+ ${partner.name}`);
            pBtn.type = "button";
            pBtn.title = `Stage companion style "${partner.name}"`;
            pBtn.addEventListener("click", () => {
              if (!stagedIds.includes(partner.id)) stagedIds = [...stagedIds, partner.id];
              renderStudio();
            });
            pairsWrap.appendChild(pBtn);
          }
          drawer.appendChild(pairsWrap);
        }
        card.appendChild(drawer);
      }

      grid.appendChild(card);
    }
    scrollList.appendChild(grid);
  }

  function insertSingleEntry(entry) {
    const info = resolveCurrentDialect();
    const textToInsert = formatStyleEntry(entry, { model: info.model, mossDialect: info.mossDialect });
    const cur = currentTargetSnapshot();
    const isJson = info.model === "moss" && info.mossDialect === "layout" && textToInsert.trim().startsWith("{");
    let nextText;
    let nextCaret;
    if (isJson) {
      nextText = textToInsert;
      nextCaret = nextText.length;
    } else {
      const before = cur.text.slice(0, cur.start);
      const after = cur.text.slice(cur.end);
      const prefix = before && !/[\s,(]$/.test(before) ? ", " : "";
      const suffix = after && !/^[\s,).!?]/.test(after) ? ", " : "";
      nextText = before + prefix + textToInsert + suffix + after;
      nextCaret = before.length + prefix.length + textToInsert.length;
    }
    if (applyTextReplacement(cur.target, nextText, nextCaret, nextCaret)) {
      usageStore.recordStyleUsage?.(entry.id);
      setStatus(`Inserted "${entry.name}".`);
      renderStudio();
    } else {
      setStatus("Target prompt is read-only.", true);
    }
  }

  function renderStudio() {
    if (disposed || sidecar.hidden) return;
    for (const [id, btn] of viewTabBtns.entries()) {
      const active = viewMode === id;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-pressed", String(active));
    }
    renderFacetRail();
    renderSpecs();
    const context = renderDiagnosticsAndScan();
    renderComposer(context);
    renderCards(context);
  }

  async function ensureCatalogLoaded() {
    catalog = getStyleCatalogSync();
    if (catalog) return catalog;
    catalogLoading = true;
    catalogError = "";
    renderStudio();
    try {
      catalog = await loadStyleCatalog();
    } catch (err) {
      catalogError = `Failed to load local style catalog: ${err?.message || err}`;
    } finally {
      catalogLoading = false;
      if (!sidecar.hidden && !disposed) renderStudio();
    }
    return catalog;
  }

  // ---- Window Open / Close ---------------------------------------------------
  function close({ restoreFocus = false } = {}) {
    finishGesture();
    stopPlacement?.();
    stopPlacement = null;
    observer.disconnect();
    themeObserver?.disconnect();
    for (const off of editorPollListeners) off();
    editorPollListeners = [];

    sidecar.classList.remove("open");
    sidecar.hidden = true;
    sidecar.setAttribute("inert", "");
    sidecar.setAttribute("aria-hidden", "true");
    const trigger = root.querySelector('[data-act="styles"]');
    trigger?.classList.remove("active");
    trigger?.setAttribute("aria-expanded", "false");

    if (restoreFocus) {
      const focusTarget = (node?._ppRecipeWorkspace?.isActive?.() && node._ppRecipeWorkspace.editingSurface?.()) || activeEditor;
      if (focusTarget?.isConnected) focusTarget.focus({ preventScroll: true });
    }
    if (node) scheduleDomWidgetRemeasure(node);
  }

  function open(target = lastEditor || editor, { focus = true, facet = "" } = {}) {
    if (disposed) return false;
    if (loadTheme().styleSelectorEnabled !== true) return false;
    if (facet) activeFacet = facet;
    const resolved = resolveLoraTarget(node, editor, target);
    const effective = resolved?.surface?.isConnected ? resolved.surface : editor;
    if (effective) {
      lastEditor = effective;
      activeEditor = effective;
    }

    beforeOpen();
    node?._ppCommandTarget?.activate?.();
    observeDisconnectTargets();

    sidecar.hidden = false;
    sidecar.removeAttribute("inert");
    sidecar.setAttribute("aria-hidden", "false");
    sidecar.classList.add("open");

    const trigger = root.querySelector('[data-act="styles"]');
    trigger?.classList.add("active");
    trigger?.setAttribute("aria-expanded", "true");

    syncTheme();
    themeObserver?.disconnect();
    themeObserver = new MutationObserver(syncTheme);
    for (let el = root; el; el = el.parentElement) {
      themeObserver.observe(el, { attributes: true, attributeFilter: ["style", "class", "data-wg-tone", "data-wg-finish"] });
    }

    sidecarPlacement = "";
    placeSidecar();
    stopPlacement?.();
    stopPlacement = observePanelAnchor(root, placeSidecar);

    bindTargetInputSync(effective);
    setStatus("Style Studio ready — browse 94 curated Krea 2 & MOSS styles or stage a Mix.");
    renderStudio();
    ensureCatalogLoaded();

    if (focus) searchInput.focus({ preventScroll: true });
    if (node) scheduleDomWidgetRemeasure(node);
    return true;
  }

  // ---- Event Wiring ----------------------------------------------------------
  for (const [id, btn] of dialectBtns.entries()) {
    btn.addEventListener("click", () => {
      dialectChoice = id;
      const theme = loadTheme();
      if (id === "krea2") theme.styleModelFilter = "krea2";
      else if (id === "auto") theme.styleModelFilter = "auto";
      else if (id === "moss-caption") { theme.styleModelFilter = "moss"; theme.styleMossDialect = "caption"; }
      else if (id === "moss-tags") { theme.styleModelFilter = "moss"; theme.styleMossDialect = "tags"; }
      else if (id === "moss-layout") { theme.styleModelFilter = "moss"; theme.styleMossDialect = "layout"; }
      saveTheme(theme);
      renderStudio();
    });
  }

  for (const [id, btn] of viewTabBtns.entries()) {
    btn.addEventListener("click", () => {
      viewMode = id;
      renderStudio();
    });
  }

  specsBtn.addEventListener("click", () => {
    specsOpen = !specsOpen;
    renderSpecs();
  });

  useCursorBtn.addEventListener("mousedown", (e) => e.preventDefault());
  useCursorBtn.addEventListener("click", () => {
    const resolved = resolveLoraTarget(node, editor, lastEditor || activeEditor);
    if (resolved?.surface) {
      lastEditor = resolved.surface;
      activeEditor = resolved.surface;
      bindTargetInputSync(resolved.surface);
      setStatus("Retargeted to active editor cursor / selection.");
      renderStudio();
    }
  });

  followBtn.addEventListener("click", toggleFollow);
  resetBtn.addEventListener("click", resetWindow);
  closeBtn.addEventListener("click", () => close({ restoreFocus: true }));

  searchInput.addEventListener("input", () => {
    searchQuery = searchInput.value;
    renderStudio();
  });
  quoteInput.addEventListener("input", () => {
    quotedText = quoteInput.value;
    renderComposer({ ...renderDiagnosticsAndScan() });
  });
  quoteClearBtn.addEventListener("click", () => {
    quoteInput.value = "";
    quotedText = "";
    renderComposer({ ...renderDiagnosticsAndScan() });
  });

  focusBtn.addEventListener("click", () => {
    focusOrder = focusOrder === "subject" ? "scene" : "subject";
    renderStudio();
  });
  combBtn.addEventListener("click", () => {
    combinatorialMix = !combinatorialMix;
    renderStudio();
  });
  clearStageBtn.addEventListener("click", () => {
    stagedIds = [];
    quotedText = "";
    quoteInput.value = "";
    renderStudio();
  });

  insertBtn.addEventListener("click", () => {
    const info = resolveCurrentDialect();
    const stagedEntries = stagedIds.map((id) => getStyleEntryById(id)).filter(Boolean);
    const compiled = composeStyleMix(stagedEntries, {
      model: info.model,
      mossDialect: info.mossDialect,
      focusOrder,
      quotedText,
      combinatorial: combinatorialMix,
    });
    if (!compiled.text) return;
    const cur = currentTargetSnapshot();
    const isJson = info.model === "moss" && info.mossDialect === "layout" && compiled.text.trim().startsWith("{");
    let next, caret;
    if (isJson) {
      next = compiled.text;
      caret = next.length;
    } else {
      const before = cur.text.slice(0, cur.start);
      const after = cur.text.slice(cur.end);
      const prefix = before && !/[\s,(]$/.test(before) ? ", " : "";
      const suffix = after && !/^[\s,).!?]/.test(after) ? ", " : "";
      next = before + prefix + compiled.text + suffix + after;
      caret = before.length + prefix.length + compiled.text.length;
    }
    if (applyTextReplacement(cur.target, next, caret, caret)) {
      stagedIds.forEach((id) => usageStore.recordStyleUsage?.(id));
      setStatus(`Inserted compiled ${compiled.dialect} output at caret.`);
      renderStudio();
    } else {
      setStatus("Target editor is read-only.", true);
    }
  });

  appendBtn.addEventListener("click", () => {
    const info = resolveCurrentDialect();
    const stagedEntries = stagedIds.map((id) => getStyleEntryById(id)).filter(Boolean);
    const compiled = composeStyleMix(stagedEntries, {
      model: info.model,
      mossDialect: info.mossDialect,
      focusOrder,
      quotedText,
      combinatorial: combinatorialMix,
    });
    if (!compiled.text) return;
    const cur = currentTargetSnapshot();
    const isJson = info.model === "moss" && info.mossDialect === "layout";
    const next = smartAppendPrompt(cur.text, compiled.text, { isJson });
    if (applyTextReplacement(cur.target, next, next.length, next.length)) {
      stagedIds.forEach((id) => usageStore.recordStyleUsage?.(id));
      setStatus(`Appended ${compiled.dialect} mix cleanly.`);
      renderStudio();
    } else {
      setStatus("Target editor is read-only.", true);
    }
  });

  copyBtn.addEventListener("click", async () => {
    const info = resolveCurrentDialect();
    const stagedEntries = stagedIds.map((id) => getStyleEntryById(id)).filter(Boolean);
    const compiled = composeStyleMix(stagedEntries, {
      model: info.model,
      mossDialect: info.mossDialect,
      focusOrder,
      quotedText,
      combinatorial: combinatorialMix,
    });
    if (!compiled.text) return;
    try {
      await navigator.clipboard?.writeText(compiled.text);
      setStatus("Copied compiled style mix to clipboard.");
    } catch {
      setStatus("Clipboard copy unavailable in this context.", true);
    }
  });

  safeNegBtn.addEventListener("click", () => {
    if (typeof setNegative !== "function") return;
    const existing = String(getNegative?.() || "").trim();
    const updated = existing
      ? (existing.toLowerCase().includes("worst quality") ? existing : `${existing}, ${SAFE_MOSS_NEGATIVE}`)
      : SAFE_MOSS_NEGATIVE;
    setNegative(updated);
    setStatus("Added neutral MOSS Base/SFT quality guard to Negative prompt.");
  });

  header.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button:not(.pp-style-drag), select, input, textarea, a")) return;
    startGesture("move", e);
  });
  dragHandle.addEventListener("pointerdown", (e) => startGesture("move", e));
  dragHandle.addEventListener("dblclick", (e) => {
    e.preventDefault();
    toggleFollow();
  });
  dragHandle.addEventListener("keydown", (e) => onHandleKeyDown(e, false));

  for (const { el, edge } of resizers) {
    el.addEventListener("pointerdown", (e) => startGesture("resize", e, edge));
    el.addEventListener("keydown", (e) => onHandleKeyDown(e, true, edge));
  }

  const onViewportResize = () => {
    if (!sidecar.hidden) {
      sidecarPlacement = "";
      placeSidecar();
    }
  };
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", finishGesture);
  window.addEventListener("pointercancel", finishGesture);
  window.addEventListener("resize", onViewportResize, { passive: true });

  const keyboardCleanup = installPromptPaletteKeyboardBoundary(sidecar);

  const onEscape = (e) => {
    if (e.key !== "Escape" || e.defaultPrevented || sidecar.hidden) return;
    if (document.activeElement === searchInput && searchInput.value) {
      e.preventDefault();
      e.stopPropagation();
      searchInput.value = "";
      searchQuery = "";
      renderStudio();
      return;
    }
    if (specsOpen) {
      e.preventDefault();
      e.stopPropagation();
      specsOpen = false;
      renderSpecs();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    close({ restoreFocus: true });
  };
  sidecar.addEventListener("keydown", onEscape);

  const rememberTarget = (e) => {
    if (e.target?.__ppPromptTools && (!node || e.target.__ppPromptTools.node === node) && !e.target.readOnly && !e.target.disabled) {
      lastEditor = e.target;
    }
  };
  const closeForOtherTool = (e) => {
    const action = e.target.closest?.("[data-act]")?.dataset.act;
    if (!sidecar.hidden && ["picker", "loras", "edit", "importImage", "settings", "stash", "recipesShortcut", "variations", "ioRailToggle", "zenToggle"].includes(action)) {
      close();
    }
  };

  root.addEventListener("focusin", rememberTarget);
  root.addEventListener("click", closeForOtherTool, true);

  const onToggleClick = () => (sidecar.hidden ? open() : close({ restoreFocus: true }));
  const triggerBtn = root.querySelector('[data-act="styles"]');
  triggerBtn?.addEventListener("click", onToggleClick);

  const unsubAppearance = onPromptPaletteAppearanceChanged(() => {
    if (disposed) return;
    const enabled = loadTheme().styleSelectorEnabled === true;
    if (!enabled && !sidecar.hidden) {
      close();
    } else if (!sidecar.hidden) {
      syncTheme();
      renderStudio();
    }
  });

  const observer = new MutationObserver(() => {
    if (!root.isConnected) manager.cleanup();
  });

  function observeDisconnectTargets() {
    observer.disconnect();
    const seen = new Set();
    for (let el = root?.parentElement; el; el = el.parentElement) {
      if (!seen.has(el)) {
        seen.add(el);
        observer.observe(el, { childList: true, subtree: false });
      }
    }
    if (!seen.size && document.body) {
      observer.observe(document.body, { childList: true, subtree: false });
    }
  }

  const manager = {
    open,
    close,
    toggle: () => (sidecar.hidden ? open() : close({ restoreFocus: true })),
    isOpen: () => !sidecar.hidden && sidecar.classList.contains("open"),
    cleanup() {
      if (disposed) return;
      close();
      disposed = true;
      unsubAppearance?.();
      keyboardCleanup?.();
      stopPlacement?.();
      stopPlacement = null;
      observer.disconnect();
      themeObserver?.disconnect();
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", finishGesture);
      window.removeEventListener("pointercancel", finishGesture);
      window.removeEventListener("resize", onViewportResize);
      root.removeEventListener("focusin", rememberTarget);
      root.removeEventListener("click", closeForOtherTool, true);
      triggerBtn?.removeEventListener("click", onToggleClick);
      sidecar.remove();
      if (root.__ppStyleSelector === manager) delete root.__ppStyleSelector;
      if (node?._ppStyleSelector === manager) delete node._ppStyleSelector;
    },
  };

  root.__ppStyleSelector = manager;
  if (node) node._ppStyleSelector = manager;
  return manager;
}

export function openStyleSelector(editor, options = {}) {
  const node = editor?.__ppPromptTools?.node;
  if (node?._ppStyleSelector) return node._ppStyleSelector.open(editor, options);
  const root = editor?.closest?.(".wg-root, .pp-node, .wg-node") || editor?.parentElement;
  if (root?.__ppStyleSelector) return root.__ppStyleSelector.open(editor, options);
  return installStyleSelector({ root: root || document.body, node, editor })?.open(editor, options) || false;
}
