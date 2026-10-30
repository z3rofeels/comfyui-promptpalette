import { bindLibraryResize } from "./library_resize.js";
import { readEditorPreference, writeEditorPreference } from "../prompt_palette_state.js";
import { bindLibraryDisplay } from "./library_display.js";

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

export function createWorkspaceController(ctx) {
  const {
    node, pickerDrawer,
    libraryDensityButtons, libraryResizeHandle,
  } = ctx;

  let onLibraryDensityChange = null;
  const libraryDisplay = bindLibraryDisplay(pickerDrawer, () => onLibraryDensityChange?.());

  const libraryResize = bindLibraryResize({
    drawer: pickerDrawer, handle: libraryResizeHandle,
    load: () => readEditorPreference("libraryWidth", null),
    save: value => writeEditorPreference("libraryWidth", value),
  });
  const applyLibraryPanelWidth = libraryResize.apply;
  const finishLibraryResize = libraryResize.finish;
  function openLibraryWorkspace() { libraryResize.apply(); }

  function cleanup() {
    libraryResize.cleanup();
    libraryDisplay.cleanup();
  }

  return {
    openLibraryWorkspace,
    applyLibraryPanelWidth,
    finishLibraryResize,
    getLibraryDensity: () => "medium",
    setLibraryDensityChangeHandler(handler) { onLibraryDensityChange = typeof handler === "function" ? handler : null; },
    cleanup,
  };
}
