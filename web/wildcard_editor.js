import "./prompt_palette_commands.js";
import { clearLegacyPromptPaletteGlobalTheme } from "./prompt_palette_shared.js";
import { buildWildcardWidget, livePromptPaletteNodes, cleanupSharedPromptPaletteDom } from "./editor/editor_core.js";
import { registerPromptPaletteEditor } from "./editor/register_editor.js";

clearLegacyPromptPaletteGlobalTheme();
registerPromptPaletteEditor({ buildWildcardWidget, livePromptPaletteNodes, cleanupSharedPromptPaletteDom });

export { API } from "./prompt_palette_api.js";
export { editorStylesReady } from "./editor/styles.js";
export {
  loadTheme, saveTheme, defaultTheme,
  UI_THEME_KEYS, BUILTIN_UI_THEMES, loadUiThemes, saveUiThemes, loadActiveUiThemeName, saveActiveUiThemeName,
  loadPinned, savePinned, loadExpandedCats, saveExpandedCats, loadCatOrder, saveCatOrder,
  loadCategoryPalettes, saveCategoryPalettes, categoryPaletteSnapshot,
  loadPickerView, savePickerView,
} from "./editor/preferences.js";
export {
  escapeHtml, highlightMatch, categoryOf, hashStr,
  sanitizeHexColor, hslToHex, categoryColorFromHue, currentUiSurface,
} from "./editor/text_utils.js";
export { findWildcardFragment, getCaretCoords, openOrUpdateAcMenu, closeAcMenu, acState } from "./editor/autocomplete.js";
export { openCtxMenu, closeCtxMenu, ctxMenuOpen } from "./editor/context_menu.js";
export { pickThumbnailFile, thumbnailFileError } from "./editor/thumbnails.js";
export { openInjectMenu, openInjectMenuAtPoint, closeInjectMenu, scheduleCloseInjectMenu, injectState } from "./editor/injector.js";
export { dialogPrompt, dialogConfirm, dialogChoice, isDialogOpen } from "./editor/dialogs.js";
export { notify } from "./editor/notifications.js";
export { livePromptPaletteNodes, cleanupSharedPromptPaletteDom } from "./editor/editor_core.js";
export {
  hideNativeWidget, installResponsiveDomWidgetWidth, getDomWidgetAvailableHeight, scheduleDomWidgetRemeasure,
  ensureNodeLifecycle, nodeIsActive, scheduleNodeTimer, cancelNodeTimer, clearNodeTimers, scheduleNodeFrame,
  installPromptStateGuard, installPromptMetadataCapture,
  ioState, ioEnabled, syncIoSocket, migrateIoState, canonicalizeOutputs, setupIoRail,
  installSocketRailLayout, cleanupSocketRailLayout, queueSocketRailLayout,
} from "./prompt_palette_compat.js";
