import {
  applyPromptPaletteThemeScope,
  promptPaletteEffectSettings,
  clearLegacyPromptPaletteGlobalTheme,
  applyPromptPaletteNodeChrome,
  onPromptPaletteAppearanceChanged,
} from "../prompt_palette_shared.js";
import {
  loadTheme,
  BUILTIN_UI_THEMES,
  loadUiThemes,
  loadActiveUiThemeName,
} from "./preferences.js";
import { sanitizeHexColor } from "./text_utils.js";

/**
 * Read one authoritative, persisted Prompt Palette suite appearance snapshot.
 * Combinatorial and Weight Controller are consumers only; all appearance writes
 * live in Prompt Palette's main Settings > Appearance surface.
 */
export function readSuiteAppearanceSnapshot() {
  const theme = loadTheme();
  const customThemes = loadUiThemes();
  const themes = { ...BUILTIN_UI_THEMES, ...customThemes };
  const requestedName = loadActiveUiThemeName();
  const activeName = themes[requestedName] ? requestedName : "Cinder";
  const colors = themes[activeName] || BUILTIN_UI_THEMES.Cinder;
  const typography = {
    "font-family": theme.fontFamily?.trim() ? `"${theme.fontFamily.trim()}"` : "",
    "editor-font-size": `${Number(theme.editorFontSize) || 12.5}px`,
    "ui-font-scale": Number(theme.uiFontScale) || 1,
    "prompt-text": theme.promptTextColorMode === "custom"
      ? sanitizeHexColor(theme.promptTextColor, colors.text)
      : colors.text,
  };
  return {
    activeName,
    colors,
    typography,
    effects: promptPaletteEffectSettings(theme),
    theme,
  };
}

/** Apply the current suite appearance to PP-owned DOM surfaces and native node chrome. */
export function applySuiteAppearance(node, ...targets) {
  const snapshot = readSuiteAppearanceSnapshot();
  clearLegacyPromptPaletteGlobalTheme();
  for (const target of targets.flat().filter(Boolean)) {
    applyPromptPaletteThemeScope(target, snapshot.colors, snapshot.typography, snapshot.effects);
  }
  applyPromptPaletteNodeChrome(node, snapshot.colors);
  return snapshot;
}

/**
 * Subscribe a node to suite appearance changes. The callback always re-reads the
 * same persisted snapshot rather than trusting per-module cached theme objects.
 */
export function bindSuiteAppearance({ node, targets = [], onApplied = null }) {
  let firstApply = true;
  const apply = () => {
    const snapshot = applySuiteAppearance(node, targets);
    if (typeof onApplied === "function") onApplied(snapshot, { initial: firstApply });
    firstApply = false;
    return snapshot;
  };
  const cleanup = onPromptPaletteAppearanceChanged(apply);
  apply();
  return { apply, cleanup };
}
