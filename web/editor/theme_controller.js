import { downloadJsonFile, pickJsonFile, normalizeThemeFilename, svgIcon, applyPromptPaletteThemeScope, promptPaletteEffectSettings, clearLegacyPromptPaletteGlobalTheme, applyPromptPaletteNodeChrome, onPromptPaletteAppearanceChanged } from "../prompt_palette_shared.js";
import { replacePowerToolPreferences } from "../prompt_palette_state.js";
import { searchPromptPaletteHelp } from "../prompt_quickness.js";
import { scheduleNodeTimer, cancelNodeTimer } from "../prompt_palette_compat.js";
import {
  loadTheme, defaultTheme, saveTheme, loadCategoryPalettes, saveCategoryPalettes, categoryPaletteSnapshot,
  UI_THEME_KEYS, BUILTIN_UI_THEMES, THEME_PACKS, normalizeUiThemeName, loadUiThemes, saveUiThemes,
  loadActiveUiThemeName, saveActiveUiThemeName,
} from "./preferences.js";
import {
  hashStr, categoryOf, escapeHtml, sanitizeHexColor, contrastRatio, currentUiSurface, categoryColorFromHue,
} from "./text_utils.js";
import { dialogPrompt, dialogConfirm, dialogChoice } from "./dialogs.js";
import { closeInjectMenu, injectState } from "./injector.js";
import { notify } from "./notifications.js";

export function createThemeController(ctx) {
  const {
    node, root, settingsPopup, theme, el, textarea, highlight, resolvedView, editorReal, btnResolve,
    starterPackController, libraryButton, searchInput,
    render, applyPowerToolSettings, closeAllPowerPopups, closeStash, closePickerDrawer, closeEditDrawer,
    activateLibraryTab, prepareStarterPacks, renderPickerList,
  } = ctx;
  const settingsRoot = settingsPopup || root;

  const fontFamilyInput = el("fontFamilyInput");
  const fontStatus = el("fontStatus");
  const editorFontRange = el("editorFontRange"), editorFontOut = el("editorFontOut");
  const uiFontRange = el("uiFontRange"), uiFontOut = el("uiFontOut");
  const promptTextColorInput = el("promptTextColor");
  const promptTextColorAuto = el("promptTextColorAuto");

  function setFontStatus(msg, isErr) {
    fontStatus.textContent = msg || "";
    fontStatus.className = "wg-status" + (isErr ? " err" : "");
  }

  function interfaceTextColor() {
    const name = loadActiveUiThemeName();
    const colors = loadUiThemes()[name] || BUILTIN_UI_THEMES[name] || BUILTIN_UI_THEMES.Cinder;
    return sanitizeHexColor(colors.text, BUILTIN_UI_THEMES.Cinder.text);
  }
  function resolvedPromptTextColor() {
    return theme.promptTextColorMode === "custom"
      ? sanitizeHexColor(theme.promptTextColor, interfaceTextColor())
      : interfaceTextColor();
  }
  function applyFontSettings() {
    clearLegacyPromptPaletteGlobalTheme();
    const typography = {
      "font-family": theme.fontFamily?.trim() ? `"${theme.fontFamily.trim()}"` : "",
      "editor-font-size": `${theme.editorFontSize}px`,
      "ui-font-scale": theme.uiFontScale,
      "prompt-text": resolvedPromptTextColor(),
    };
    applyPromptPaletteThemeScope(root, {}, typography);
    if (settingsRoot !== root) applyPromptPaletteThemeScope(settingsRoot, {}, typography);

    highlight.scrollTop = textarea.scrollTop;
    highlight.scrollLeft = textarea.scrollLeft;
  }

  let libraryTypographyTimer = null;
  function refreshLibraryTypographyGeometry() {
    cancelNodeTimer(node, libraryTypographyTimer);
    libraryTypographyTimer = scheduleNodeTimer(node, () => {
      libraryTypographyTimer = null;
      renderPickerList(searchInput.value);
    }, 40);
  }

  function refreshFontControlsUI() {
    fontFamilyInput.value = theme.fontFamily || "";
    editorFontRange.value = theme.editorFontSize;
    editorFontOut.textContent = `${theme.editorFontSize}px`;
    uiFontRange.value = Math.round(theme.uiFontScale * 100);
    uiFontOut.textContent = `${Math.round(theme.uiFontScale * 100)}%`;
    promptTextColorAuto.checked = theme.promptTextColorMode !== "custom";
    promptTextColorInput.disabled = promptTextColorAuto.checked;
    promptTextColorInput.value = resolvedPromptTextColor();
  }
  refreshFontControlsUI();

  fontFamilyInput.addEventListener("input", () => {
    theme.fontFamily = fontFamilyInput.value;
    saveTheme(theme); applyFontSettings(); refreshLibraryTypographyGeometry(); updateThemeJson();
  });
  editorFontRange.addEventListener("input", () => {
    theme.editorFontSize = parseFloat(editorFontRange.value);
    editorFontOut.textContent = `${theme.editorFontSize}px`;
    saveTheme(theme); applyFontSettings(); updateThemeJson();
  });
  uiFontRange.addEventListener("input", () => {
    theme.uiFontScale = parseInt(uiFontRange.value, 10) / 100;
    uiFontOut.textContent = `${uiFontRange.value}%`;
    saveTheme(theme); applyFontSettings(); refreshLibraryTypographyGeometry(); updateThemeJson();
  });
  promptTextColorInput.addEventListener("input", () => {
    theme.promptTextColor = promptTextColorInput.value;
    theme.promptTextColorMode = "custom";
    saveTheme(theme); applyFontSettings(); refreshFontControlsUI(); updateThemeJson();
  });
  promptTextColorAuto.addEventListener("change", () => {
    theme.promptTextColorMode = promptTextColorAuto.checked ? "theme" : "custom";
    if (!promptTextColorAuto.checked) theme.promptTextColor = resolvedPromptTextColor();
    saveTheme(theme); applyFontSettings(); refreshFontControlsUI(); updateThemeJson();
  });
  settingsRoot.querySelector('[data-act="fontClear"]').addEventListener("click", () => {
    theme.fontFamily = "";
    fontFamilyInput.value = "";
    saveTheme(theme); applyFontSettings(); refreshLibraryTypographyGeometry(); updateThemeJson();
    setFontStatus("using default fonts");
  });
  settingsRoot.querySelector('[data-act="fontBrowseLocal"]').addEventListener("click", async () => {

    if (typeof window.queryLocalFonts !== "function") {
      setFontStatus("Your browser doesn't support browsing installed fonts (Chrome/Edge only). Type a font name manually \u2014 it must already be installed on your system for the browser to render it.", true);
      return;
    }
    try {
      const fonts = await window.queryLocalFonts();
      const families = Array.from(new Set(fonts.map(f => f.family))).sort();
      if (!families.length) { setFontStatus("no local fonts found", true); return; }
      fontStatus.innerHTML = "";
      fontStatus.className = "wg-status";
      const sel = document.createElement("select");
      sel.className = "wg-theme-select";
      sel.style.marginTop = "4px";
      sel.innerHTML = `<option value="">${families.length} installed fonts found \u2014 pick one\u2026</option>` +
        families.map(f => `<option value="${escapeHtml(f)}">${escapeHtml(f)}</option>`).join("");
      sel.addEventListener("change", () => {
        if (!sel.value) return;
        theme.fontFamily = sel.value;
        fontFamilyInput.value = sel.value;
        saveTheme(theme); applyFontSettings(); refreshLibraryTypographyGeometry(); updateThemeJson();
        setFontStatus(`using "${sel.value}"`);
      });
      fontStatus.appendChild(sel);
    } catch (e) {
      setFontStatus("font permission denied or unavailable", true);
    }
  });

  const hueRange = el("hueRange"), hueOut = el("hueOut");
  const satRange = el("satRange"), satOut = el("satOut");
  hueRange.value = theme.hueRotate; hueOut.textContent = theme.hueRotate + "\u00b0";
  satRange.value = theme.saturation; satOut.textContent = theme.saturation + "%";

  const categoryColorSearch = el("categoryColorSearch");
  const categoryCount = el("categoryCount");
  const categoryPresetSelect = el("categoryPresetSelect");
  const categoryPresetStatus = el("categoryPresetStatus");
  const themePackStatus = el("themePackStatus");
  let categoryFilter = "";
  let categoryPalettes = loadCategoryPalettes();
  let automaticControlOpen = false;

  function automaticCategoryColor(cat, index = 0, total = 1) {
    const distributed = total > 1 ? (theme.hueRotate + index * (360 / total)) % 360 : (hashStr(cat) % 360 + theme.hueRotate) % 360;
    return categoryColorFromHue(distributed, theme.saturation);
  }

  function setCategoryPresetStatus(message, isError = false) {
    categoryPresetStatus.textContent = message || "";
    categoryPresetStatus.className = `wg-status${isError ? " err" : ""}`;
  }
  function renderCategoryPresetSelect(selected = categoryPresetSelect.value) {
    categoryPalettes = loadCategoryPalettes();
    const names = Object.keys(categoryPalettes).sort((a, b) => a.localeCompare(b));
    categoryPresetSelect.innerHTML = `<option value="">${names.length ? "Choose saved palette…" : "No saved palettes"}</option>` + names.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("");
    if (selected && categoryPalettes[selected]) categoryPresetSelect.value = selected;
  }
  async function saveCategoryPalette(defaultName = "Category palette") {
    categoryPalettes = loadCategoryPalettes();
    let name = await dialogPrompt({ title: "Save category palette", message: "Preset name:", defaultValue: defaultName });
    if (!name) return null;
    name = name.trim();
    if (!name) return null;
    if (categoryPalettes[name]) {
      const overwrite = await dialogConfirm({ title: "Replace palette", message: `Replace “${name}”?` });
      if (!overwrite) return null;
    }
    categoryPalettes[name] = categoryPaletteSnapshot(theme);
    saveCategoryPalettes(categoryPalettes);
    renderCategoryPresetSelect(name);
    setCategoryPresetStatus(`Saved “${name}”.`);
    return name;
  }
  function restoreCategoryPalette(name) {
    categoryPalettes = loadCategoryPalettes();
    const saved = categoryPalettes[name];
    if (!saved) return false;
    theme.hueRotate = Math.max(0, Math.min(359, Number(saved.hueRotate) || 0));
    theme.saturation = Math.max(30, Math.min(90, Number(saved.saturation) || 58));
    theme.categoryPins = Object.fromEntries(Object.entries(saved.categoryPins || {}).map(([key, value]) => [key, sanitizeHexColor(value, automaticCategoryColor(key))]));
    hueRange.value = theme.hueRotate;
    hueOut.textContent = `${theme.hueRotate}°`;
    satRange.value = theme.saturation;
    satOut.textContent = `${theme.saturation}%`;
    saveTheme(theme);
    renderCatPins();
    render();
    updateThemeJson();
    setCategoryPresetStatus(`Restored “${name}”.`);
    return true;
  }
  async function prepareAutomaticControls() {
    categoryPalettes = loadCategoryPalettes();
    if (!Object.keys(theme.categoryPins || {}).length) return true;
    const choice = await dialogChoice({
      title: "Custom colors are locked",
      message: "Save a preset before Auto Shift replaces them?",
      choices: [
        { label: "Save & continue", value: "save", primary: true },
        { label: "Continue", value: "continue" },
        { label: "Cancel", value: "cancel" },
      ],
    });
    if (!choice || choice === "cancel") return false;
    if (choice === "save") {
      const name = await saveCategoryPalette(`Before Auto Shift ${Object.keys(categoryPalettes).length + 1}`);
      if (!name) return false;
    }
    theme.categoryPins = {};
    saveTheme(theme);
    renderCatPins();
    render();
    updateThemeJson();
    setCategoryPresetStatus(choice === "save" ? "Saved. Automatic colors enabled." : "Automatic colors enabled.");
    return true;
  }
  async function applyAutomaticControl(kind, value) {
    if (automaticControlOpen) return;
    automaticControlOpen = true;
    const ok = await prepareAutomaticControls();
    automaticControlOpen = false;
    if (!ok) {
      hueRange.value = theme.hueRotate;
      satRange.value = theme.saturation;
      return;
    }
    if (kind === "hue") {
      theme.hueRotate = value;
      hueRange.value = value;
      hueOut.textContent = `${value}°`;
    } else {
      theme.saturation = value;
      satRange.value = value;
      satOut.textContent = `${value}%`;
    }
    saveTheme(theme);
    renderCatPins();
    render();
    updateThemeJson();
  }

  function renderCatPins() {
    const wrap = el("catPins");
    const categories = Array.from(new Set(ctx.state.libraryCache.map(l => categoryOf(l.path)))).sort();
    const visible = categories.filter(cat => cat.toLowerCase().includes(categoryFilter));
    categoryCount.textContent = `${visible.length}/${categories.length}`;
    wrap.innerHTML = "";
    if (!visible.length) {
      wrap.innerHTML = '<div class="wg-empty-state">No matching categories.</div>';
      return;
    }
    visible.forEach((cat, index) => {
      const row = document.createElement("div");
      row.className = "wg-category-row";
      const isPinned = !!theme.categoryPins[cat];
      const current = isPinned ? sanitizeHexColor(theme.categoryPins[cat]) : automaticCategoryColor(cat, index, visible.length);
      row.innerHTML = `
        <div class="wg-category-copy"><strong>${escapeHtml(cat)}</strong><small>${isPinned ? "Custom override" : "Automatic palette"}</small></div>
        <div class="wg-category-controls">
          <button type="button" class="wg-color-chip" style="--chip:${current}" aria-label="Choose color for ${escapeHtml(cat)}"></button>
          <input type="text" class="wg-hex-input" value="${current}" maxlength="7" aria-label="Hex color for ${escapeHtml(cat)}">
          <input type="color" value="${current}" aria-label="Pick color for ${escapeHtml(cat)}">
          <button class="wg-reset-color" title="Use automatic color" ${isPinned ? "" : "disabled"}>Auto</button>
        </div>`;
      const chip = row.querySelector(".wg-color-chip");
      const hex = row.querySelector(".wg-hex-input");
      const picker = row.querySelector('input[type="color"]');
      const reset = row.querySelector(".wg-reset-color");
      const commit = (value) => {
        const safe = sanitizeHexColor(value, current);
        theme.categoryPins[cat] = safe;
        hex.value = safe;
        picker.value = safe;
        chip.style.setProperty("--chip", safe);
        reset.disabled = false;
        row.querySelector("small").textContent = "Custom override";
        saveTheme(theme);
        render();
        updateThemeJson();
      };
      chip.addEventListener("click", () => picker.click());
      picker.addEventListener("input", e => commit(e.target.value));
      hex.addEventListener("change", e => commit(e.target.value));
      hex.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); hex.blur(); } });
      reset.addEventListener("click", () => {
        delete theme.categoryPins[cat];
        saveTheme(theme);
        renderCatPins();
        render();
        updateThemeJson();
      });
      wrap.appendChild(row);
    });
  }

  hueRange.addEventListener("input", () => {
    const value = parseInt(hueRange.value, 10);
    if (Object.keys(theme.categoryPins || {}).length) {
      hueRange.value = theme.hueRotate;
      applyAutomaticControl("hue", value);
      return;
    }
    theme.hueRotate = value;
    hueOut.textContent = `${value}°`;
    saveTheme(theme); renderCatPins(); render(); updateThemeJson();
  });
  satRange.addEventListener("input", () => {
    const value = parseInt(satRange.value, 10);
    if (Object.keys(theme.categoryPins || {}).length) {
      satRange.value = theme.saturation;
      applyAutomaticControl("saturation", value);
      return;
    }
    theme.saturation = value;
    satOut.textContent = `${value}%`;
    saveTheme(theme); renderCatPins(); render(); updateThemeJson();
  });
  settingsRoot.querySelector('[data-act="categoryPresetSave"]').addEventListener("click", () => saveCategoryPalette());
  settingsRoot.querySelector('[data-act="categoryPresetRestore"]').addEventListener("click", () => {
    if (!categoryPresetSelect.value) return setCategoryPresetStatus("Choose a saved palette.", true);
    restoreCategoryPalette(categoryPresetSelect.value);
  });
  settingsRoot.querySelector('[data-act="categoryPresetDelete"]').addEventListener("click", async () => {
    const name = categoryPresetSelect.value;
    if (!name) return setCategoryPresetStatus("Choose a saved palette.", true);
    const ok = await dialogConfirm({ title: "Delete category palette", message: `Delete “${name}”?` });
    if (!ok) return;
    categoryPalettes = loadCategoryPalettes();
    delete categoryPalettes[name];
    saveCategoryPalettes(categoryPalettes);
    renderCategoryPresetSelect();
    setCategoryPresetStatus(`Deleted “${name}”.`);
  });
  renderCategoryPresetSelect();

  categoryColorSearch.addEventListener("input", () => {
    categoryFilter = categoryColorSearch.value.trim().toLowerCase();
    renderCatPins();
  });
  settingsRoot.querySelector('[data-act="categoryAutoPalette"]').addEventListener("click", () => {
    const categories = Array.from(new Set(ctx.state.libraryCache.map(l => categoryOf(l.path)))).sort();
    categories.forEach((cat, index) => { theme.categoryPins[cat] = automaticCategoryColor(cat, index, categories.length); });
    saveTheme(theme); renderCatPins(); render(); updateThemeJson();
    notify("success", "Fixed palette created", `${categories.length} category colors were distributed evenly.`);
  });
  settingsRoot.querySelector('[data-act="categoryResetAll"]').addEventListener("click", async () => {
    const ok = await prepareAutomaticControls();
    if (!ok) return;
    theme.categoryPins = {};
    saveTheme(theme); renderCatPins(); render(); updateThemeJson();
  });

  function buildThemePack() {
    const colors = (typeof allUiThemes === "function" ? allUiThemes()[activeUiThemeName] : null) || BUILTIN_UI_THEMES.Cinder;
    return {
      schema: "comfyui.prompt-palette.theme",
      version: 4,
      name: activeUiThemeName || "Prompt Palette Theme",
      exportedAt: new Date().toISOString(),
      interface: { name: activeUiThemeName, colors: { ...colors } },
      tokens: {
        hueRotate: Number(theme.hueRotate) || 0,
        saturation: Number(theme.saturation) || 58,
        categoryPins: { ...(theme.categoryPins || {}) },
        promptTextColor: sanitizeHexColor(theme.promptTextColor, "#f1eee8"),
        promptTextColorMode: theme.promptTextColorMode === "custom" ? "custom" : "theme",
      },
      typography: {
        fontFamily: theme.fontFamily || "",
        editorFontSize: Number(theme.editorFontSize) || 12.5,
        uiFontScale: Number(theme.uiFontScale) || 1,
      },
      effects: {
        cornerRadius: Math.max(4, Math.min(18, Number(theme.cornerRadius) || 10)),
      },
      layout: Object.fromEntries(Object.entries(theme).filter(([key]) => key.startsWith("show") || ["syntaxInjectorEnabled", "promptHistoryEnabled", "starterPacksEnabled", "zenMode", "layoutPreset", "dayTheme", "nightTheme"].includes(key))),
    };
  }

  function setThemePackStatus(message, isError = false) {
    themePackStatus.textContent = message || "";
    themePackStatus.className = `wg-status${isError ? " err" : ""}`;
  }

  function parseThemePack(parsed) {
    if (!parsed || typeof parsed !== "object") throw new Error("Theme file is empty or invalid.");
    if (parsed.schema === "comfyui.prompt-palette.theme") {
      if (Number(parsed.version) > 4) throw new Error(`Theme schema v${parsed.version} is newer than this build supports.`);
      return parsed;
    }

    if (parsed.colors || UI_THEME_KEYS.some(([key]) => parsed[key])) {
      return {
        schema: "comfyui.prompt-palette.theme", version: 4,
        name: parsed.name || "Imported theme",
        interface: { name: parsed.name || "Imported theme", colors: parsed.colors || parsed },
      };
    }

    return {
      schema: "comfyui.prompt-palette.theme", version: 4,
      name: parsed.name || "Imported Prompt Palette preferences",
      tokens: parsed,
      typography: parsed,
      effects: parsed,
      layout: parsed,
    };
  }

  function applyThemePack(rawPack) {
    const pack = parseThemePack(rawPack);
    if (pack.interface?.colors) {
      const nameBase = String(pack.interface.name || pack.name || "Imported theme").trim() || "Imported theme";
      let name = nameBase;
      let suffix = 2;
      while (allUiThemes()[name]) name = `${nameBase} ${suffix++}`;
      const colors = {};
      UI_THEME_KEYS.forEach(([key]) => { colors[key] = sanitizeHexColor(pack.interface.colors[key], BUILTIN_UI_THEMES.Cinder[key]); });
      customUiThemes[name] = colors;
      saveUiThemes(customUiThemes);
      activeUiThemeName = name;
      activeThemePackId = "custom";
      saveActiveUiThemeName(name);
    }
    if (pack.tokens) {
      if (Number.isFinite(Number(pack.tokens.hueRotate))) theme.hueRotate = Math.max(0, Math.min(359, Number(pack.tokens.hueRotate)));
      if (Number.isFinite(Number(pack.tokens.saturation))) theme.saturation = Math.max(30, Math.min(90, Number(pack.tokens.saturation)));
      if (pack.tokens.categoryPins && typeof pack.tokens.categoryPins === "object") {
        theme.categoryPins = Object.fromEntries(Object.entries(pack.tokens.categoryPins).map(([key, value]) => [key, sanitizeHexColor(value, automaticCategoryColor(key))]));
      }
      if (pack.tokens.promptTextColor) theme.promptTextColor = sanitizeHexColor(pack.tokens.promptTextColor, theme.promptTextColor);
      if (["theme", "custom"].includes(pack.tokens.promptTextColorMode)) theme.promptTextColorMode = pack.tokens.promptTextColorMode;
    }
    if (pack.typography) {
      if (typeof pack.typography.fontFamily === "string") theme.fontFamily = pack.typography.fontFamily.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 120);
      if (Number.isFinite(Number(pack.typography.editorFontSize))) theme.editorFontSize = Math.max(10, Math.min(64, Number(pack.typography.editorFontSize)));
      if (Number.isFinite(Number(pack.typography.uiFontScale))) theme.uiFontScale = Math.max(.8, Math.min(2, Number(pack.typography.uiFontScale)));
    }
    if (pack.effects && typeof pack.effects === "object") {
      // Older v4 theme exports may contain surfaceStyle/atmosphere fields.
      // They are intentionally ignored; v2 now uses one consistent surface treatment.
      if (Number.isFinite(Number(pack.effects.cornerRadius))) theme.cornerRadius = Math.max(4, Math.min(18, Number(pack.effects.cornerRadius)));
    }
    if (pack.layout && typeof pack.layout === "object") {
      const defaults = defaultTheme();
      for (const [key, value] of Object.entries(pack.layout)) {
        if (!(key in defaults) || !["boolean", "string"].includes(typeof value)) continue;
        if (key === "layoutPreset") {
          theme[key] = ["minimal", "balanced", "studio", "custom"].includes(value) ? value : "custom";
        } else {
          theme[key] = value;
        }
      }
    }
    saveTheme(theme);
    hueRange.value = theme.hueRotate; hueOut.textContent = `${theme.hueRotate}°`;
    satRange.value = theme.saturation; satOut.textContent = `${theme.saturation}%`;
    refreshFontControlsUI();
    applyFontSettings();
    refreshLibraryTypographyGeometry();
    applyUiTheme();
    refreshUiThemeUI();
    applyToolbarSettings();
    refreshToolbarSettingsUI();
    applyStarterPacksSetting();
    applyPowerToolSettings();
    applyZenMode();
    renderCatPins();
    render();
    updateThemeJson();
    return pack;
  }

  function updateThemeJson() {
    el("themeJson").value = JSON.stringify(buildThemePack(), null, 2);
  }
  settingsRoot.querySelector('[data-act="copyTheme"]').addEventListener("click", async (e) => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(buildThemePack(), null, 2));
      setThemePackStatus("Theme pack copied to clipboard.");
    } catch { setThemePackStatus("Clipboard permission was denied.", true); }
  });
  settingsRoot.querySelector('[data-act="pasteTheme"]').addEventListener("click", async () => {
    try {
      const parsed = JSON.parse(await navigator.clipboard.readText());
      const pack = applyThemePack(parsed);
      setThemePackStatus(`Imported “${pack.name || "theme"}” from the clipboard.`);
    } catch (error) { setThemePackStatus(error?.message || "Clipboard does not contain a valid Prompt Palette theme.", true); }
  });
  settingsRoot.querySelector('[data-act="resetTheme"]').addEventListener("click", async () => {
    const ok = await dialogConfirm({ title: "Reset Prompt Palette", message: "Reset appearance, layout, category colors, typography, and optional power tools to defaults?" });
    if (!ok) return;
    Object.assign(theme, defaultTheme());
    ctx.state.powerTools = replacePowerToolPreferences({});
    activeUiThemeName = "Cinder";
    activeThemePackId = primaryPackForTheme(activeUiThemeName)?.id || "all";
    saveActiveUiThemeName(activeUiThemeName);
    saveTheme(theme);
    hueRange.value = 0; hueOut.textContent = "0°";
    satRange.value = 58; satOut.textContent = "58%";
    refreshFontControlsUI(); applyFontSettings(); refreshLibraryTypographyGeometry(); applyUiTheme(); refreshUiThemeUI();
    applyToolbarSettings(); refreshToolbarSettingsUI(); applyStarterPacksSetting(); applyPowerToolSettings({ refreshPreview: true }); applyZenMode(); renderCatPins(); render(); updateThemeJson();
    setThemePackStatus("Preferences reset to Cinder.");
  });

  const uiThemeGallery = el("uiThemeGallery");
  const uiThemeSwatches = el("uiThemeSwatches");
  const uiThemeStatus = el("uiThemeStatus");
  const uiThemeActiveName = el("uiThemeActiveName");
  const uiThemeActivePack = el("uiThemeActivePack");
  const uiThemePackStrip = el("uiThemePackStrip");
  const uiThemeCount = el("uiThemeCount");
  const cornerRadiusRange = el("cornerRadiusRange");
  const cornerRadiusOut = el("cornerRadiusOut");
  const helpSearch = el("helpSearch");
  const helpResults = el("helpResults");

  let customUiThemes = loadUiThemes();
  let activeUiThemeName = loadActiveUiThemeName();

  function allUiThemes() { return { ...BUILTIN_UI_THEMES, ...customUiThemes }; }
  function isBuiltinUiTheme(name) { return !!BUILTIN_UI_THEMES[name] && !customUiThemes[name]; }
  if (!allUiThemes()[activeUiThemeName]) activeUiThemeName = "Cinder";

  function applyUiTheme() {
    const t = allUiThemes()[activeUiThemeName] || BUILTIN_UI_THEMES.Cinder;
    const effects = promptPaletteEffectSettings(theme);
    clearLegacyPromptPaletteGlobalTheme();
    applyPromptPaletteThemeScope(root, t, {}, effects);
    if (settingsRoot !== root) applyPromptPaletteThemeScope(settingsRoot, t, {}, effects);

    applyPromptPaletteNodeChrome(node, t);
    applyFontSettings();
    refreshFontControlsUI();
    node.graph?.setDirtyCanvas(true, true);
    if (typeof updateDayNightIcon === "function") updateDayNightIcon();
    if (typeof renderCatPins === "function") renderCatPins();
    if (typeof render === "function") render();
  }
  function setUiThemeStatus(msg, isErr) {
    uiThemeStatus.textContent = msg || "";
    uiThemeStatus.className = "wg-status" + (isErr ? " err" : "");
  }
  function primaryPackForTheme(name) {
    return THEME_PACKS.find((pack) => pack.themes.includes(name)) || null;
  }
  function themeTone(colors) {
    const raw = sanitizeHexColor(colors?.bg, BUILTIN_UI_THEMES.Cinder.bg).slice(1);
    const rgb = [0, 2, 4].map((offset) => parseInt(raw.slice(offset, offset + 2), 16) / 255);
    const linear = rgb.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    const luminance = 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
    return luminance > 0.42 ? "Light" : "Dark";
  }
  function packAccent(pack, themes) {
    const first = (pack?.themes || []).map((name) => themes[name]).find(Boolean);
    return sanitizeHexColor(first?.accent, BUILTIN_UI_THEMES.Cinder.accent);
  }

  let activeThemePackId = primaryPackForTheme(activeUiThemeName)?.id || (customUiThemes[activeUiThemeName] ? "custom" : "all");

  function renderThemePackStrip() {
    if (!uiThemePackStrip) return;
    const themes = allUiThemes();
    const packs = [{ id: "all", name: "All themes", tone: "Browse", description: "Every built-in palette.", themes: Object.keys(BUILTIN_UI_THEMES) }, ...THEME_PACKS];
    if (Object.keys(customUiThemes).length) packs.push({ id: "custom", name: "My Themes", tone: "Custom", description: "Your editable palette copies.", themes: Object.keys(customUiThemes) });
    uiThemePackStrip.innerHTML = "";
    if (uiThemeCount) uiThemeCount.textContent = `${Object.keys(BUILTIN_UI_THEMES).length} palettes`;
    for (const pack of packs) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `wg-theme-pack-card${pack.id === activeThemePackId ? " active" : ""}`;
      button.dataset.themePack = pack.id;
      button.setAttribute("aria-pressed", String(pack.id === activeThemePackId));
      button.title = pack.description;
      const count = (pack.themes || []).filter((name) => themes[name]).length;
      button.style.setProperty("--pack-accent", pack.id === "all" ? (themes[activeUiThemeName]?.accent || BUILTIN_UI_THEMES.Cinder.accent) : packAccent(pack, themes));
      button.innerHTML = `<span class="wg-theme-pack-dot" aria-hidden="true"></span><span class="wg-theme-pack-copy"><strong>${escapeHtml(pack.name)}</strong><small>${escapeHtml(pack.tone)} · ${count}</small></span>`;
      uiThemePackStrip.appendChild(button);
    }
  }

  function selectUiTheme(name, { preservePack = false } = {}) {
    const normalized = normalizeUiThemeName(String(name || ""));
    if (!allUiThemes()[normalized]) return false;
    if (!preservePack) activeThemePackId = primaryPackForTheme(normalized)?.id || (customUiThemes[normalized] ? "custom" : activeThemePackId);
    if (normalized === activeUiThemeName) {
      refreshUiThemeUI();
      return true;
    }
    activeUiThemeName = normalized;
    saveActiveUiThemeName(normalized);
    applyUiTheme();
    refreshUiThemeUI();
    return true;
  }

  function galleryThemeNames() {
    if (activeThemePackId === "custom") return Object.keys(customUiThemes).sort((a, b) => a.localeCompare(b));
    if (activeThemePackId === "all") return THEME_PACKS.flatMap((pack) => pack.themes).filter((name, index, list) => list.indexOf(name) === index && allUiThemes()[name]);
    const pack = THEME_PACKS.find((entry) => entry.id === activeThemePackId);
    return (pack?.themes || []).filter((name) => allUiThemes()[name]);
  }

  function renderUiThemeGallery() {
    uiThemeGallery.innerHTML = "";
    const themes = allUiThemes();
    const names = galleryThemeNames();
    if (!names.length) {
      uiThemeGallery.innerHTML = '<div class="wg-empty-state">No palettes in this collection yet.</div>';
      return;
    }
    names.forEach((name) => {
      const colors = themes[name];
      const pack = primaryPackForTheme(name);
      const button = document.createElement("button");
      button.type = "button";
      button.className = `wg-theme-gallery-card${name === activeUiThemeName ? " active" : ""}`;
      button.dataset.themeName = name;
      button.setAttribute("aria-pressed", String(name === activeUiThemeName));
      button.setAttribute("aria-label", `Use ${name} interface theme`);
      button.title = `Use ${name}${isBuiltinUiTheme(name) ? "" : " custom theme"}`;
      button.style.setProperty("--theme-bg", sanitizeHexColor(colors.bg, BUILTIN_UI_THEMES.Cinder.bg));
      button.style.setProperty("--theme-panel", sanitizeHexColor(colors["panel-bg"], BUILTIN_UI_THEMES.Cinder["panel-bg"]));
      button.style.setProperty("--theme-surface", sanitizeHexColor(colors.surface, BUILTIN_UI_THEMES.Cinder.surface));
      button.style.setProperty("--theme-border", sanitizeHexColor(colors.border, BUILTIN_UI_THEMES.Cinder.border));
      button.style.setProperty("--theme-accent", sanitizeHexColor(colors.accent, BUILTIN_UI_THEMES.Cinder.accent));
      button.style.setProperty("--theme-text", sanitizeHexColor(colors.text, BUILTIN_UI_THEMES.Cinder.text));
      const collection = pack?.name || (customUiThemes[name] ? "My Themes" : "Theme");
      button.innerHTML = `
        <span class="wg-theme-card-preview" aria-hidden="true">
          <span class="wg-theme-card-top"><i></i><i></i><i></i></span>
          <span class="wg-theme-card-body"><i class="wg-theme-card-side"></i><span><i></i><i></i></span></span>
        </span>
        <span class="wg-theme-gallery-copy"><strong>${escapeHtml(name)}</strong><small>${escapeHtml(collection)} · ${themeTone(colors)}</small></span>`;
      uiThemeGallery.appendChild(button);
    });
  }

  // Delegation survives gallery re-renders and keeps ComfyUI's canvas handlers out of theme clicks.
  uiThemeGallery.addEventListener("pointerdown", (event) => event.stopPropagation());
  uiThemeGallery.addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-theme-name]");
    if (!button || !uiThemeGallery.contains(button)) return;
    event.preventDefault();
    event.stopPropagation();
    selectUiTheme(button.dataset.themeName, { preservePack: true });
  });

  uiThemePackStrip?.addEventListener("pointerdown", (event) => event.stopPropagation());
  uiThemePackStrip?.addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-theme-pack]");
    if (!button || !uiThemePackStrip.contains(button)) return;
    event.preventDefault();
    event.stopPropagation();
    activeThemePackId = button.dataset.themePack || "all";
    renderThemePackStrip();
    renderUiThemeGallery();
  });

  function refreshAppearanceControlsUI() {
    if (cornerRadiusRange) cornerRadiusRange.value = String(Math.round(Number(theme.cornerRadius ?? 10)));
    if (cornerRadiusOut) cornerRadiusOut.textContent = `${Math.round(Number(theme.cornerRadius ?? 10))}px`;
  }
  cornerRadiusRange?.addEventListener("input", () => {
    const value = Math.max(4, Math.min(18, parseInt(cornerRadiusRange.value, 10) || 10));
    if (cornerRadiusOut) cornerRadiusOut.textContent = `${value}px`;
    theme.cornerRadius = value;
    saveTheme(theme);
    applyUiTheme();
    updateThemeJson();
  });
  function updateUiThemePreview() {
    const t = allUiThemes()[activeUiThemeName] || BUILTIN_UI_THEMES.Cinder;
    if (uiThemeActiveName) uiThemeActiveName.textContent = activeUiThemeName;
    if (uiThemeActivePack) {
      const pack = primaryPackForTheme(activeUiThemeName);
      uiThemeActivePack.textContent = pack ? `${pack.name} · ${themeTone(t)}` : `My Themes · ${themeTone(t)}`;
    }
  }
  function renderUiThemeSwatches() {
    const t = allUiThemes()[activeUiThemeName] || BUILTIN_UI_THEMES.Cinder;
    const locked = isBuiltinUiTheme(activeUiThemeName);
    uiThemeSwatches.innerHTML = "";
    UI_THEME_KEYS.forEach(([key, label]) => {
      const item = document.createElement("label");
      item.className = "wg-swatch-item";
      const title = document.createElement("span");
      title.className = "wg-swatch-label";
      title.textContent = label;
      const controls = document.createElement("span");
      controls.className = "wg-swatch-controls";
      const hex = document.createElement("input");
      hex.type = "text";
      hex.className = "wg-swatch-hex";
      hex.maxLength = 7;
      hex.value = sanitizeHexColor(t[key], BUILTIN_UI_THEMES.Cinder[key]);
      hex.disabled = locked;
      const input = document.createElement("input");
      input.type = "color";
      input.value = hex.value;
      input.disabled = locked;
      const commit = (value) => {
        if (locked) return;
        const safe = sanitizeHexColor(value, customUiThemes[activeUiThemeName][key]);
        customUiThemes[activeUiThemeName][key] = safe;
        hex.value = safe;
        input.value = safe;
        saveUiThemes(customUiThemes);
        applyUiTheme();
        updateUiThemePreview();
        updateThemeJson();
      };
      input.addEventListener("input", e => commit(e.target.value));
      hex.addEventListener("change", e => commit(e.target.value));
      controls.append(hex, input);
      item.append(title, controls);
      uiThemeSwatches.appendChild(item);
    });
    updateUiThemePreview();
    const textContrast = contrastRatio(
      sanitizeHexColor(t.text, BUILTIN_UI_THEMES.Cinder.text),
      sanitizeHexColor(t.surface, BUILTIN_UI_THEMES.Cinder.surface),
    );
    const contrastGrade = textContrast >= 7 ? "AAA" : textContrast >= 4.5 ? "AA" : "low contrast";
    const baseStatus = locked ? "Built-in theme — duplicate it to unlock every color." : "Custom theme — changes are saved live.";
    setUiThemeStatus(`${baseStatus} Text contrast ${textContrast.toFixed(1)}:1 (${contrastGrade}).`, textContrast < 4.5);
  }

  function refreshUiThemeUI() { renderThemePackStrip(); renderUiThemeGallery(); renderUiThemeSwatches(); refreshDayNightSelects(); refreshAppearanceControlsUI(); updateThemeJson(); }

  function renderHelpResults() {
    const items = searchPromptPaletteHelp(helpSearch?.value || "");
    helpResults.innerHTML = "";
    if (!items.length) {
      helpResults.innerHTML = '<div class="wg-empty-state">No guide topic matches that search.</div>';
      return;
    }
    items.forEach((item, index) => {
      const details = document.createElement("details");
      details.className = "wg-help-item";
      details.open = !!helpSearch?.value.trim() && index === 0;
      const summary = document.createElement("summary");
      summary.textContent = item.title;
      const body = document.createElement("p");
      body.textContent = item.body;
      details.append(summary, body);
      helpResults.appendChild(details);
    });
  }
  helpSearch.addEventListener("input", renderHelpResults);

  const toolbarSeedExtra = el("seedbar");
  const dayNightBtn = el("dayNightBtn");
  const toggleSeedControlsCb = el("toggleSeedControls");
  const toggleDayNightBtnCb = el("toggleDayNightBtn");
  const toggleSyntaxInjectorCb = el("toggleSyntaxInjector");
  const togglePromptHistoryCb = el("togglePromptHistory");
  const toggleStarterPacksCb = el("toggleStarterPacks");
  const dayThemeSelect = el("dayThemeSelect");
  const nightThemeSelect = el("nightThemeSelect");

  const btnGallery = el("btnGallery");
  const btnEdit = el("btnEdit");
  const btnRecipes = el("btnRecipes");
  const btnStash = el("btnStash");
  const btnRefresh = el("btnRefresh");
  const btnUndo = el("btnUndo");
  const btnRedo = el("btnRedo");
  const btnCopy = el("btnCopy");
  const btnClear = el("btnClear");
  const toggleGalleryBtnCb = el("toggleGalleryBtn");
  const toggleEditBtnCb = el("toggleEditBtn");
  const toggleRecipesBtnCb = el("toggleRecipesBtn");
  const toggleStashBtnCb = el("toggleStashBtn");
  const toggleRefreshBtnCb = el("toggleRefreshBtn");
  const toggleUndoBtnCb = el("toggleUndoBtn");
  const toggleRedoBtnCb = el("toggleRedoBtn");
  const toggleResolveBtnCb = el("toggleResolveBtn");
  const toggleCopyBtnCb = el("toggleCopyBtn");
  const toggleClearBtnCb = el("toggleClearBtn");
  const TOOLBAR_BTN_TOGGLES = [
    [btnGallery, "showGalleryBtn", toggleGalleryBtnCb],
    [btnEdit, "showEditBtn", toggleEditBtnCb],
    [btnRecipes, "showRecipesBtn", toggleRecipesBtnCb],
    [btnStash, "showStashBtn", toggleStashBtnCb],
    [btnRefresh, "showRefreshBtn", toggleRefreshBtnCb],
    [btnUndo, "showUndoBtn", toggleUndoBtnCb],
    [btnRedo, "showRedoBtn", toggleRedoBtnCb],
    [btnResolve, "showResolveBtn", toggleResolveBtnCb],
    [btnCopy, "showCopyBtn", toggleCopyBtnCb],
    [btnClear, "showClearBtn", toggleClearBtnCb],
  ];

  const zenBtn = el("zenBtn");
  const toggleZenModeCb = el("toggleZenMode");
  const TOOLBAR_KEYS = TOOLBAR_BTN_TOGGLES.map(([, key]) => key);
  const LAYOUT_PRESETS = {
    minimal: {
      showGalleryBtn: true, showEditBtn: false, showRecipesBtn: false, showStashBtn: false,
      showRefreshBtn: false, showUndoBtn: false, showRedoBtn: false, showResolveBtn: true,
      showCopyBtn: true, showClearBtn: false, showSeedControls: false, showDayNightBtn: false,
      syntaxInjectorEnabled: false,
    },
    balanced: {
      showGalleryBtn: true, showEditBtn: true, showRecipesBtn: true, showStashBtn: true,
      showRefreshBtn: true, showUndoBtn: true, showRedoBtn: true, showResolveBtn: true,
      showCopyBtn: true, showClearBtn: true, showSeedControls: false, showDayNightBtn: true,
      syntaxInjectorEnabled: true,
    },
    studio: {
      showGalleryBtn: true, showEditBtn: true, showRecipesBtn: true, showStashBtn: true,
      showRefreshBtn: true, showUndoBtn: true, showRedoBtn: true, showResolveBtn: true,
      showCopyBtn: true, showClearBtn: true, showSeedControls: true, showDayNightBtn: true,
      syntaxInjectorEnabled: true,
    },
  };

  function applyZenMode() {
    const on = !!theme.zenMode;
    root.classList.toggle("wg-zen", on);
    zenBtn.classList.toggle("active", on);
    zenBtn.title = on ? "Exit Zen mode" : "Enter Zen mode";
    toggleZenModeCb.checked = on;
    if (on) {
      closeAllPowerPopups();
      closeStash();
      closePickerDrawer();
      closeEditDrawer();
      if (resolvedView.classList.contains("on")) {
        resolvedView.classList.remove("on");
        editorReal.classList.remove("hidden");
        btnResolve.classList.remove("on");
        btnResolve.textContent = "Preview result";
        btnResolve.setAttribute("aria-pressed", "false");
        btnResolve.setAttribute("aria-label", "Preview resolved prompt");
        btnResolve.title = "Preview the wildcard-resolved result without changing your draft";
      }
    }
  }
  function setLayoutPreset(name) {
    const preset = LAYOUT_PRESETS[name];
    if (!preset) return;
    Object.assign(theme, preset, { layoutPreset: name, zenMode: false });
    saveTheme(theme);
    applyToolbarSettings();
    refreshToolbarSettingsUI();
    applyStarterPacksSetting();
    applyZenMode();
    updateThemeJson();
  }
  function markLayoutCustom() {
    if (theme.layoutPreset !== "custom") {
      theme.layoutPreset = "custom";
      settingsRoot.querySelectorAll("[data-layout-preset]").forEach(button => button.classList.remove("active"));
    }
  }
  function applyToolbarSettings() {
    toolbarSeedExtra.classList.toggle("on", !!theme.showSeedControls);
    dayNightBtn.style.display = theme.showDayNightBtn ? "" : "none";
    TOOLBAR_BTN_TOGGLES.forEach(([btn, key]) => {
      btn.style.display = theme[key] === false ? "none" : "";
    });
    settingsRoot.querySelectorAll("[data-layout-preset]").forEach(button => {
      button.classList.toggle("active", button.dataset.layoutPreset === theme.layoutPreset);
    });
  }
  function refreshToolbarSettingsUI() {
    toggleSeedControlsCb.checked = !!theme.showSeedControls;
    toggleDayNightBtnCb.checked = !!theme.showDayNightBtn;
    toggleSyntaxInjectorCb.checked = theme.syntaxInjectorEnabled !== false;
    togglePromptHistoryCb.checked = theme.promptHistoryEnabled !== false;
    toggleStarterPacksCb.checked = theme.starterPacksEnabled !== false;
    toggleZenModeCb.checked = !!theme.zenMode;
    TOOLBAR_BTN_TOGGLES.forEach(([, key, cb]) => {
      cb.checked = theme[key] !== false;
    });
    settingsRoot.querySelectorAll("[data-layout-preset]").forEach(button => {
      button.classList.toggle("active", button.dataset.layoutPreset === theme.layoutPreset);
    });
  }
  function applyStarterPacksSetting() {
    const enabled = theme.starterPacksEnabled !== false;
    const starterTab = root.querySelector('[data-library-tab="starter"]');
    const starterPanel = root.querySelector('[data-library-panel="starter"]');
    const librarySubtitle = el("librarySubtitle");
    if (starterTab) {
      starterTab.hidden = !enabled;
      starterTab.setAttribute("aria-hidden", String(!enabled));
      if (!enabled) starterTab.tabIndex = -1;
    }
    if (librarySubtitle) {
      librarySubtitle.textContent = enabled
        ? "Model-ready starters, syntax examples, and your wildcard-backed library."
        : "Your wildcard-backed library.";
    }
    if (!enabled) {
      ctx.state.starterAutocompleteRows = [];
      starterPackController.setActive(false);
      activateLibraryTab("personal");
    } else {
      prepareStarterPacks();
      if (starterPanel && ctx.state.activeLibraryTab === "starter") starterPackController.activate();
    }
    libraryButton.title = enabled ? "Prompt Library — Starter Packs and My Library" : "Prompt Library — My Library";
    libraryButton.setAttribute("aria-label", libraryButton.title);
  }

  function refreshDayNightSelects() {
    const themes = allUiThemes();
    const names = Object.keys(themes).sort();
    const previousDay = theme.dayTheme;
    const previousNight = theme.nightTheme;
    theme.dayTheme = normalizeUiThemeName(theme.dayTheme);
    theme.nightTheme = normalizeUiThemeName(theme.nightTheme);
    if (!themes[theme.dayTheme]) theme.dayTheme = names.includes("Porcelain") ? "Porcelain" : names[0];
    if (!themes[theme.nightTheme]) theme.nightTheme = names.includes("Cinder") ? "Cinder" : names[0];
    if (theme.dayTheme !== previousDay || theme.nightTheme !== previousNight) saveTheme(theme);
    [[dayThemeSelect, "dayTheme"], [nightThemeSelect, "nightTheme"]].forEach(([sel, key]) => {
      sel.innerHTML = names.map(n =>
        `<option value="${escapeHtml(n)}" ${n === theme[key] ? "selected" : ""}>${escapeHtml(n)}</option>`
      ).join("");
    });
  }
  function updateDayNightIcon() {
    const inNight = theme.nightTheme && activeUiThemeName === theme.nightTheme;
    dayNightBtn.innerHTML = svgIcon(inNight ? "sun" : "moon");
    dayNightBtn.title = inNight ? "Switch to day theme" : "Switch to night theme";
  }

  TOOLBAR_BTN_TOGGLES.forEach(([, key, cb]) => {
    cb.addEventListener("change", () => {
      theme[key] = cb.checked;
      markLayoutCustom();
      saveTheme(theme);
      applyToolbarSettings();
      updateThemeJson();
    });
  });
  toggleSeedControlsCb.addEventListener("change", () => {
    theme.showSeedControls = toggleSeedControlsCb.checked;
    markLayoutCustom();
    saveTheme(theme);
    applyToolbarSettings();
    updateThemeJson();
  });
  toggleDayNightBtnCb.addEventListener("change", () => {
    theme.showDayNightBtn = toggleDayNightBtnCb.checked;
    markLayoutCustom();
    saveTheme(theme);
    applyToolbarSettings();
    updateThemeJson();
  });
  toggleSyntaxInjectorCb.addEventListener("change", () => {
    theme.syntaxInjectorEnabled = toggleSyntaxInjectorCb.checked;
    markLayoutCustom();
    saveTheme(theme);
    updateThemeJson();
    if (!theme.syntaxInjectorEnabled && injectState && injectState.textarea === textarea) closeInjectMenu();

    renderPickerList(searchInput.value);
  });
  togglePromptHistoryCb.addEventListener("change", () => {
    theme.promptHistoryEnabled = togglePromptHistoryCb.checked;
    if (!theme.promptHistoryEnabled) {
      cancelNodeTimer(node, ctx.state.historySnapshotTimer);
      ctx.state.historySnapshotTimer = null;
    }
    saveTheme(theme);
    updateThemeJson();
  });
  toggleStarterPacksCb.addEventListener("change", () => {
    theme.starterPacksEnabled = toggleStarterPacksCb.checked;
    saveTheme(theme);
    applyStarterPacksSetting();
    updateThemeJson();
  });
  settingsRoot.querySelectorAll("[data-layout-preset]").forEach(button => {
    button.addEventListener("click", () => setLayoutPreset(button.dataset.layoutPreset));
  });
  settingsRoot.querySelector('[data-act="toolbarAllOn"]').addEventListener("click", () => {
    TOOLBAR_KEYS.forEach(key => { theme[key] = true; });
    theme.showSeedControls = true;
    theme.showDayNightBtn = true;
    theme.layoutPreset = "custom";
    saveTheme(theme); applyToolbarSettings(); refreshToolbarSettingsUI(); updateThemeJson();
  });
  settingsRoot.querySelector('[data-act="toolbarAllOff"]').addEventListener("click", () => {
    TOOLBAR_KEYS.forEach(key => { theme[key] = false; });
    theme.showSeedControls = false;
    theme.showDayNightBtn = false;
    theme.layoutPreset = "custom";
    saveTheme(theme); applyToolbarSettings(); refreshToolbarSettingsUI(); updateThemeJson();
  });
  function toggleZenMode() {
    theme.zenMode = !theme.zenMode;
    saveTheme(theme);
    applyZenMode();
    updateThemeJson();
  }
  zenBtn.addEventListener("click", toggleZenMode);
  toggleZenModeCb.addEventListener("change", () => {
    theme.zenMode = toggleZenModeCb.checked;
    saveTheme(theme);
    applyZenMode();
    updateThemeJson();
  });

  dayThemeSelect.addEventListener("change", () => {
    theme.dayTheme = dayThemeSelect.value;
    saveTheme(theme);
    updateDayNightIcon();
  });
  nightThemeSelect.addEventListener("change", () => {
    theme.nightTheme = nightThemeSelect.value;
    saveTheme(theme);
    updateDayNightIcon();
  });
  dayNightBtn.addEventListener("click", () => {
    const target = activeUiThemeName === theme.nightTheme ? theme.dayTheme : theme.nightTheme;
    selectUiTheme(target);
  });

  settingsRoot.querySelector('[data-act="uiThemeNew"]').addEventListener("click", async () => {
    const base = allUiThemes()[activeUiThemeName] || BUILTIN_UI_THEMES.Cinder;
    let name = await dialogPrompt({
      title: "New Theme",
      message: "Name for the new theme:",
      defaultValue: `${activeUiThemeName} copy`,
    });
    if (!name) return;
    name = name.trim();
    if (!name) return;
    if (allUiThemes()[name]) return setUiThemeStatus("A theme with that name already exists.", true);
    customUiThemes[name] = { ...base };
    saveUiThemes(customUiThemes);
    activeUiThemeName = name;
    activeThemePackId = "custom";
    saveActiveUiThemeName(name);
    applyUiTheme();
    refreshUiThemeUI();
    updateThemeJson();
  });
  settingsRoot.querySelector('[data-act="uiThemeRename"]').addEventListener("click", async () => {
    if (isBuiltinUiTheme(activeUiThemeName)) return setUiThemeStatus("built-in themes can't be renamed", true);
    let name = await dialogPrompt({
      title: "Rename Theme",
      message: "Rename theme:",
      defaultValue: activeUiThemeName,
    });
    if (!name) return;
    name = name.trim();
    if (!name || name === activeUiThemeName) return;
    if (allUiThemes()[name]) return setUiThemeStatus("a theme with that name already exists", true);
    customUiThemes[name] = customUiThemes[activeUiThemeName];
    delete customUiThemes[activeUiThemeName];
    saveUiThemes(customUiThemes);
    activeUiThemeName = name;
    activeThemePackId = "custom";
    saveActiveUiThemeName(name);
    refreshUiThemeUI();
    updateThemeJson();
  });
  settingsRoot.querySelector('[data-act="uiThemeDelete"]').addEventListener("click", async () => {
    if (isBuiltinUiTheme(activeUiThemeName)) return setUiThemeStatus("Built-in themes can't be deleted.", true);
    const doomed = activeUiThemeName;
    const ok = await dialogConfirm({ title: "Delete theme", message: `Delete “${doomed}”? This cannot be undone.` });
    if (!ok) return;
    delete customUiThemes[doomed];
    saveUiThemes(customUiThemes);
    activeUiThemeName = "Cinder";
    activeThemePackId = primaryPackForTheme(activeUiThemeName)?.id || "all";
    saveActiveUiThemeName(activeUiThemeName);
    applyUiTheme();
    refreshUiThemeUI();
    updateThemeJson();
    setUiThemeStatus(`Deleted “${doomed}”.`);
  });
  async function importThemeText(text, sourceLabel = "file") {
    const parsed = JSON.parse(text);
    const pack = applyThemePack(parsed);
    setThemePackStatus(`Imported “${pack.name || "theme"}” from ${sourceLabel}.`);
    setUiThemeStatus(`Imported as “${activeUiThemeName}”.`);
  }
  settingsRoot.querySelector('[data-act="uiThemeImport"]').addEventListener("click", async () => {
    try {
      const files = await pickJsonFile();
      if (!files.length) return;
      await importThemeText(files[0].text, files[0].file.name);
    } catch (error) {
      setThemePackStatus(error?.message || "That file is not a valid Prompt Palette theme.", true);
    }
  });
  settingsRoot.querySelector('[data-act="uiThemeExport"]').addEventListener("click", () => {
    const pack = buildThemePack();
    downloadJsonFile(normalizeThemeFilename(pack.name), pack);
    setThemePackStatus(`Exported “${pack.name}”.`);
  });
  const themeDropZone = el("themeDropZone");
  ["dragenter", "dragover"].forEach(type => themeDropZone.addEventListener(type, event => {
    event.preventDefault();
    themeDropZone.classList.add("dragging");
  }));
  ["dragleave", "drop"].forEach(type => themeDropZone.addEventListener(type, event => {
    event.preventDefault();
    themeDropZone.classList.remove("dragging");
  }));
  themeDropZone.addEventListener("drop", async event => {
    const file = Array.from(event.dataTransfer?.files || []).find(item => item.type === "application/json" || item.name.toLowerCase().endsWith(".json"));
    if (!file) return setThemePackStatus("Drop a JSON theme file here.", true);
    try { await importThemeText(await file.text(), file.name); }
    catch (error) { setThemePackStatus(error?.message || "That file is not a valid Prompt Palette theme.", true); }
  });
  themeDropZone.addEventListener("click", () => settingsRoot.querySelector('[data-act="uiThemeImport"]').click());
  themeDropZone.tabIndex = 0;
  themeDropZone.addEventListener("keydown", event => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      settingsRoot.querySelector('[data-act="uiThemeImport"]').click();
    }
  });

  const cleanupAppearanceSync = onPromptPaletteAppearanceChanged(() => {
    const previousTypography = `${theme.fontFamily || ""}|${theme.editorFontSize}|${theme.uiFontScale}|${theme.promptTextColorMode}|${theme.promptTextColor}`;
    Object.assign(theme, loadTheme());
    const nextTypography = `${theme.fontFamily || ""}|${theme.editorFontSize}|${theme.uiFontScale}|${theme.promptTextColorMode}|${theme.promptTextColor}`;
    customUiThemes = loadUiThemes();
    const previousActiveTheme = activeUiThemeName;
    activeUiThemeName = loadActiveUiThemeName();
    if (!allUiThemes()[activeUiThemeName]) activeUiThemeName = "Cinder";
    if (activeUiThemeName !== previousActiveTheme) activeThemePackId = primaryPackForTheme(activeUiThemeName)?.id || (customUiThemes[activeUiThemeName] ? "custom" : "all");
    applyUiTheme();
    refreshUiThemeUI();
    refreshFontControlsUI();
    applyFontSettings();
    if (previousTypography !== nextTypography) refreshLibraryTypographyGeometry();
  });

  try {
    applyUiTheme();
    refreshUiThemeUI();
    applyFontSettings();
    applyToolbarSettings();
    refreshToolbarSettingsUI();
    applyStarterPacksSetting();
    applyPowerToolSettings();
    applyZenMode();
    updateThemeJson();
  } catch (e) {
    console.error("Prompt Palette: interface setup failed", e);
  }

  return {
    renderCatPins,
    updateThemeJson,
    applyUiTheme,
    refreshUiThemeUI,
    applyFontSettings,
    applyToolbarSettings,
    refreshToolbarSettingsUI,
    applyStarterPacksSetting,
    applyZenMode,
    renderHelpResults,
    toggleDayNight: () => el("dayNightBtn")?.click(),
    cleanup: cleanupAppearanceSync,
  };
}
