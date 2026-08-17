import { readEditorPreference, writeEditorPreference } from "../prompt_palette_state.js";
import { loadLibraryDensity, saveLibraryDensity } from "./preferences.js";

export function syncWorkspaceSettingsSurface(root, settingsPopup, prefs, previewModeSelect) {
  if (previewModeSelect) previewModeSelect.value = prefs.previewMode || "afterPause";
  root.dataset.previewMode = prefs.previewMode || "afterPause";
  settingsPopup.querySelectorAll("[data-workspace-pref]").forEach((input) => { input.checked = !!prefs[input.dataset.workspacePref]; });
  settingsPopup.querySelectorAll("[data-workspace-level]").forEach((button) => button.classList.toggle("active", button.dataset.workspaceLevel === prefs.level));
  for (const scope of [root, settingsPopup]) {
    scope.classList.toggle("wg-reduce-motion", !!prefs.reduceMotion);
    scope.classList.toggle("wg-no-animations", !!prefs.disableAnimations);
    scope.classList.toggle("wg-high-contrast", !!prefs.highContrast);
    scope.classList.toggle("wg-large-text", !!prefs.largeText);
  }
}

const LIBRARY_DEFAULT_WIDTH = 360;
const LIBRARY_MIN_WIDTH = 200;
const LIBRARY_MAX_WIDTH = 720;
const EDITOR_MIN_WIDTH = 240;

function clampLibraryWidth(value) {
  return Math.max(LIBRARY_MIN_WIDTH, Math.min(LIBRARY_MAX_WIDTH, Math.round(Number(value) || LIBRARY_DEFAULT_WIDTH)));
}

export function createWorkspaceController(ctx) {
  const {
    node, pickerDrawer, editDrawer, settingsPopup, stashPopup,
    doctorPopup, variationPopup, libraryManagerPopup, recipeBuilderPopup,
    libraryDensityButtons, libraryResizeHandle,
  } = ctx;

  let libraryDensity = loadLibraryDensity();
  let onLibraryDensityChange = null;
  function applyLibraryDensity(value, { persist = true } = {}) {
    libraryDensity = value === "small" || value === "large" ? value : "medium";
    pickerDrawer.dataset.density = libraryDensity;
    libraryDensityButtons.forEach((button) => {
      const active = button.dataset.libraryDensity === libraryDensity;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    if (persist) saveLibraryDensity(libraryDensity);
  }
  applyLibraryDensity(libraryDensity, { persist: false });
  libraryDensityButtons.forEach((button) => {
    // Keep thumbnail-density controls completely inside the Library UI. In both
    // Nodes 1 and Nodes 2 these must never fall through to graph/node gestures
    // or trigger DOM-widget measurement that can change the node width.
    button.addEventListener("pointerdown", (event) => event.stopPropagation());
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const next = button.dataset.libraryDensity;
      if (next === libraryDensity) return;
      applyLibraryDensity(next);
      onLibraryDensityChange?.(libraryDensity);
    });
  });

  function loadLibraryWidth() {
    const saved = Number(readEditorPreference("libraryWidth", LIBRARY_DEFAULT_WIDTH));
    return Number.isFinite(saved) && saved > 0 ? clampLibraryWidth(saved) : LIBRARY_DEFAULT_WIDTH;
  }
  function saveLibraryWidth(value) {
    writeEditorPreference("libraryWidth", clampLibraryWidth(value));
  }

  let libraryPanelWidth = loadLibraryWidth();
  pickerDrawer.style.setProperty("--wg-library-width", `${libraryPanelWidth}px`);
  pickerDrawer.dataset.width = String(libraryPanelWidth);

  // Prompt Library is a true split-pane inside the existing node. Changing
  // its width must only redistribute space between the left library rail and
  // the prompt editor; it must never change the outer node or trigger DOM-widget
  // remeasurement. This is critical for both classic LiteGraph (Nodes 1) and
  // the Vue renderer (Nodes 2), where measurement feedback can otherwise grow
  // the node repeatedly while the divider is dragged.
  function maxLibraryWidthInsideNode() {
    const mainWidth = Number(pickerDrawer.parentElement?.clientWidth) || Number(node.size?.[0]) || 480;
    return Math.max(LIBRARY_MIN_WIDTH, Math.min(LIBRARY_MAX_WIDTH, Math.floor(mainWidth - EDITOR_MIN_WIDTH)));
  }

  function applyLibraryPanelWidth(value, { persist = false } = {}) {
    const preferredWidth = clampLibraryWidth(value);
    libraryPanelWidth = preferredWidth;
    const visibleWidth = Math.min(preferredWidth, maxLibraryWidthInsideNode());
    pickerDrawer.style.setProperty("--wg-library-width", `${visibleWidth}px`);
    pickerDrawer.dataset.width = String(visibleWidth);
    libraryResizeHandle?.setAttribute("aria-valuemin", String(LIBRARY_MIN_WIDTH));
    libraryResizeHandle?.setAttribute("aria-valuemax", String(maxLibraryWidthInsideNode()));
    libraryResizeHandle?.setAttribute("aria-valuenow", String(visibleWidth));
    libraryResizeHandle?.setAttribute("aria-valuetext", `${visibleWidth} pixels`);
    if (persist) saveLibraryWidth(preferredWidth);
  }
  applyLibraryPanelWidth(libraryPanelWidth);

  let resizingLibrary = false;
  let libraryResizePointerId = null;
  let libraryResizeStartX = 0;
  let libraryResizeStartWidth = libraryPanelWidth;

  function finishLibraryResize({ persist = true } = {}) {
    if (!resizingLibrary) return;
    resizingLibrary = false;
    pickerDrawer.classList.remove("resizing");
    if (libraryResizePointerId != null && libraryResizeHandle?.hasPointerCapture?.(libraryResizePointerId)) {
      try { libraryResizeHandle.releasePointerCapture(libraryResizePointerId); } catch {}
    }
    libraryResizePointerId = null;
    if (persist) saveLibraryWidth(libraryPanelWidth);
  }

  libraryResizeHandle?.addEventListener("pointerdown", (event) => {
    if (!pickerDrawer.classList.contains("open") || event.button !== 0) return;
    resizingLibrary = true;
    libraryResizePointerId = event.pointerId;
    libraryResizeStartX = event.clientX;
    libraryResizeStartWidth = pickerDrawer.getBoundingClientRect().width || libraryPanelWidth;
    pickerDrawer.classList.add("resizing");
    try { libraryResizeHandle.setPointerCapture(event.pointerId); } catch {}
    event.preventDefault();
    event.stopPropagation();
  });
  libraryResizeHandle?.addEventListener("pointermove", (event) => {
    if (!resizingLibrary || event.pointerId !== libraryResizePointerId) return;
    applyLibraryPanelWidth(libraryResizeStartWidth + (event.clientX - libraryResizeStartX));
    event.preventDefault();
    event.stopPropagation();
  });
  libraryResizeHandle?.addEventListener("pointerup", (event) => {
    if (event.pointerId !== libraryResizePointerId) return;
    finishLibraryResize();
    event.preventDefault();
    event.stopPropagation();
  });
  libraryResizeHandle?.addEventListener("pointercancel", (event) => {
    finishLibraryResize();
    event.stopPropagation();
  });
  libraryResizeHandle?.addEventListener("dblclick", (event) => {
    applyLibraryPanelWidth(LIBRARY_DEFAULT_WIDTH, { persist: true });
    event.preventDefault();
    event.stopPropagation();
  });
  libraryResizeHandle?.addEventListener("keydown", (event) => {
    let next = null;
    if (event.key === "ArrowLeft") next = libraryPanelWidth - (event.shiftKey ? 40 : 20);
    else if (event.key === "ArrowRight") next = libraryPanelWidth + (event.shiftKey ? 40 : 20);
    else if (event.key === "Home") next = LIBRARY_DEFAULT_WIDTH;
    if (next == null) return;
    applyLibraryPanelWidth(next, { persist: true });
    event.preventDefault();
    event.stopPropagation();
  });

  function openLibraryWorkspace() {
    // Opening the library is presentation-only. Keep the outer node geometry
    // exactly as the user left it and split the existing .wg-main width.
    applyLibraryPanelWidth(libraryPanelWidth, { persist: false });
  }

  function cleanup() {
    finishLibraryResize({ persist: false });
  }

  return {
    openLibraryWorkspace,
    applyLibraryPanelWidth,
    finishLibraryResize,
    getLibraryDensity: () => libraryDensity,
    setLibraryDensityChangeHandler(handler) { onLibraryDensityChange = typeof handler === "function" ? handler : null; },
    cleanup,
  };
}
