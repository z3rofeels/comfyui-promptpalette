const STORAGE_KEY = "prompt_palette.state.v4";
const LEGACY_STORAGE_KEYS = ["prompt_palette.state.v3"];
const SCHEMA_VERSION = 4;

const WORKSPACE_DEFAULTS = Object.freeze({
  level: "creator",
  previewMode: "afterPause",
  reduceMotion: false,
  disableHoverPreviews: false,
  disableAnimations: false,
  highContrast: false,
  largeText: false,
  keyboardNavigation: true,
});

const POWER_TOOL_DEFAULTS = Object.freeze({
  promptDoctor: false,
  variationLab: false,
  resolvedDiff: false,
  libraryManager: false,
  recipeBuilder2: false,
  nativeCommands: false,
});

const LEGACY_MAP = Object.freeze({
  theme: ["pp_theme", "json"],
  categoryPalettes: ["pp_category_palettes", "json"],
  pinned: ["pp_pinned", "json"],
  expandedCategories: ["pp_expanded_cats", "json"],
  categoryOrder: ["pp_cat_order", "json"],
  pickerView: ["pp_picker_view", "string"],
  libraryDensity: ["pp_library_density", "string"],
  uiThemes: ["pp_ui_themes", "json"],
  activeUiTheme: ["pp_ui_active_theme", "string"],
  stash: ["pp_stash", "json"],
  libraryWidth: ["pp_library_panel_width_v1", "number"],
  libraryTab: ["pp_prompt_library_tab", "string"],
  stashTab: ["pp_prompt_stash_tab", "string"],
});

function clone(value) {
  if (value == null || typeof value !== "object") return value;
  try { return structuredClone(value); } catch {}
  try { return JSON.parse(JSON.stringify(value)); } catch { return value; }
}

function emptyState() {
  return {
    schema: "comfyui.prompt-palette.state",
    version: SCHEMA_VERSION,
    migratedLegacy: false,
    editor: {},
    quickness: {},
    starter: {},
    combinatorial: {},
    powerTools: { ...POWER_TOOL_DEFAULTS },
    workspace: { ...WORKSPACE_DEFAULTS },
  };
}

function normalizeWorkspace(value) {
  const source = value && typeof value === "object" ? value : {};
  const level = ["core", "creator", "power"].includes(source.level) ? source.level : WORKSPACE_DEFAULTS.level;
  const previewMode = ["manual", "afterPause", "live"].includes(source.previewMode) ? source.previewMode : WORKSPACE_DEFAULTS.previewMode;
  return {
    level, previewMode,
    reduceMotion: source.reduceMotion === true,
    disableHoverPreviews: source.disableHoverPreviews === true,
    disableAnimations: source.disableAnimations === true,
    highContrast: source.highContrast === true,
    largeText: source.largeText === true,
    keyboardNavigation: source.keyboardNavigation !== false,
  };
}

function parseLegacy(raw, kind) {
  if (raw == null) return undefined;
  if (kind === "string") return String(raw);
  if (kind === "number") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  }
  if (kind === "json") {
    try { return JSON.parse(raw); } catch { return undefined; }
  }
  return raw;
}

function readRawState() {
  try {
    let raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      for (const legacyKey of LEGACY_STORAGE_KEYS) { raw = localStorage.getItem(legacyKey); if (raw) break; }
    }
    const parsed = JSON.parse(raw || "null");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return emptyState();
    return {
      ...emptyState(),
      ...parsed,
      schema: "comfyui.prompt-palette.state",
      version: SCHEMA_VERSION,
      editor: parsed.editor && typeof parsed.editor === "object" ? parsed.editor : {},
      quickness: parsed.quickness && typeof parsed.quickness === "object" ? parsed.quickness : {},
      starter: parsed.starter && typeof parsed.starter === "object" ? parsed.starter : {},
      combinatorial: parsed.combinatorial && typeof parsed.combinatorial === "object" ? parsed.combinatorial : {},
      powerTools: { ...POWER_TOOL_DEFAULTS, ...(parsed.powerTools && typeof parsed.powerTools === "object" ? parsed.powerTools : {}) },
      workspace: normalizeWorkspace(parsed.workspace),
    };
  } catch {
    return emptyState();
  }
}

function persist(state) {
  try {
    const payload = {
      ...state,
      schema: "comfyui.prompt-palette.state",
      version: SCHEMA_VERSION,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

function migrateLegacy(state) {
  if (state.migratedLegacy) return state;
  const next = { ...state, editor: { ...(state.editor || {}) } };
  for (const [key, [legacyKey, kind]] of Object.entries(LEGACY_MAP)) {
    if (Object.prototype.hasOwnProperty.call(next.editor, key)) continue;
    let raw = null;
    try { raw = localStorage.getItem(legacyKey); } catch {}
    const value = parseLegacy(raw, kind);
    if (value !== undefined) next.editor[key] = value;
  }

  // Quickness and starter preferences used their own localStorage namespaces before v3.8.
  const quickKeys = ["library-recent", "starter-recent", "usage", "starter-favorites", "history", "history-migrated-stash"];
  next.quickness = { ...(state.quickness || {}) };
  for (const key of quickKeys) {
    if (Object.prototype.hasOwnProperty.call(next.quickness, key)) continue;
    let raw = null;
    try { raw = localStorage.getItem(`pp_quickness:${key}`); } catch {}
    const value = parseLegacy(raw, "json");
    if (value !== undefined) next.quickness[key] = value;
  }

  const starterKeys = {
    model: ["pp_starter_model", "string"],
    autoModel: ["pp_starter_auto_model", "string"],
    filter: ["pp_starter_filter", "string"],
    openCategories: ["pp_starter_open_categories_v2", "json"],
  };
  next.starter = { ...(state.starter || {}) };
  for (const [key, [legacyKey, kind]] of Object.entries(starterKeys)) {
    if (Object.prototype.hasOwnProperty.call(next.starter, key)) continue;
    let raw = null;
    try { raw = localStorage.getItem(legacyKey); } catch {}
    const value = parseLegacy(raw, kind);
    if (value !== undefined) next.starter[key] = value;
  }

  let pickerWidth = null;
  try { pickerWidth = localStorage.getItem("pp_picker_width"); } catch {}
  if (pickerWidth != null && !Object.prototype.hasOwnProperty.call(next.combinatorial || {}, "pickerWidth")) {
    const n = Number(pickerWidth);
    if (Number.isFinite(n)) next.combinatorial = { ...(next.combinatorial || {}), pickerWidth: n };
  }

  next.migratedLegacy = true;
  persist(next);
  return next;
}

const PROMPT_PALETTE_STATE_RUNTIME_KEY = Symbol.for("comfyui.prompt-palette.state-runtime.v4");
const promptPaletteStateRuntime = globalThis[PROMPT_PALETTE_STATE_RUNTIME_KEY]
  || (globalThis[PROMPT_PALETTE_STATE_RUNTIME_KEY] = { cachedState: null });

function state() {
  if (!promptPaletteStateRuntime.cachedState) {
    let cachedState = migrateLegacy(readRawState());
    let hasCurrent = false;
    try { hasCurrent = !!localStorage.getItem(STORAGE_KEY); } catch {}
    if (!hasCurrent || cachedState.version !== SCHEMA_VERSION) {
      cachedState = { ...cachedState, schema: "comfyui.prompt-palette.state", version: SCHEMA_VERSION, workspace: normalizeWorkspace(cachedState.workspace) };
      persist(cachedState);
    }
    promptPaletteStateRuntime.cachedState = cachedState;
  }
  return promptPaletteStateRuntime.cachedState;
}

function updateSection(section, key, value) {
  const current = state();
  const next = {
    ...current,
    [section]: { ...(current[section] || {}), [key]: clone(value) },
  };
  promptPaletteStateRuntime.cachedState = next;
  persist(next);
  return value;
}

export function readPromptPaletteState(section, key, fallback = null) {
  const current = state();
  const bucket = current[section];
  if (!bucket || !Object.prototype.hasOwnProperty.call(bucket, key)) return clone(fallback);
  return clone(bucket[key]);
}

export function writePromptPaletteState(section, key, value) {
  return updateSection(section, key, value);
}

export function readEditorPreference(key, fallback = null) {
  return readPromptPaletteState("editor", key, fallback);
}

export function writeEditorPreference(key, value) {
  return writePromptPaletteState("editor", key, value);
}

export function readQuicknessPreference(key, fallback = null) {
  return readPromptPaletteState("quickness", key, fallback);
}

export function writeQuicknessPreference(key, value) {
  return writePromptPaletteState("quickness", key, value);
}

export function readStarterPreference(key, fallback = null) {
  return readPromptPaletteState("starter", key, fallback);
}

export function writeStarterPreference(key, value) {
  return writePromptPaletteState("starter", key, value);
}

export function readCombinatorialPreference(key, fallback = null) {
  return readPromptPaletteState("combinatorial", key, fallback);
}

export function writeCombinatorialPreference(key, value) {
  return writePromptPaletteState("combinatorial", key, value);
}

export function getPowerToolPreferences() {
  const current = state();
  return { ...POWER_TOOL_DEFAULTS, ...(current.powerTools || {}) };
}

export function setPowerToolPreference(key, enabled) {
  if (!Object.prototype.hasOwnProperty.call(POWER_TOOL_DEFAULTS, key)) return false;
  updateSection("powerTools", key, !!enabled);
  return !!enabled;
}

export function replacePowerToolPreferences(value) {
  const current = state();
  const normalized = { ...POWER_TOOL_DEFAULTS };
  for (const key of Object.keys(POWER_TOOL_DEFAULTS)) {
    if (value && Object.prototype.hasOwnProperty.call(value, key)) normalized[key] = !!value[key];
  }
  promptPaletteStateRuntime.cachedState = { ...current, powerTools: normalized };
  persist(promptPaletteStateRuntime.cachedState);
  return { ...normalized };
}

export function getWorkspacePreferences() {
  const current = state();
  return normalizeWorkspace(current.workspace);
}

export function setWorkspacePreference(key, value) {
  if (!Object.prototype.hasOwnProperty.call(WORKSPACE_DEFAULTS, key)) return value;
  return updateSection("workspace", key, value);
}

export function replaceWorkspacePreferences(value) {
  const current = state();
  const normalized = normalizeWorkspace(value);
  promptPaletteStateRuntime.cachedState = { ...current, workspace: normalized };
  persist(promptPaletteStateRuntime.cachedState);
  return { ...normalized };
}

export function exportPromptPaletteState() {
  return clone(state());
}

export function resetPromptPaletteStateCacheForTests() {
  promptPaletteStateRuntime.cachedState = null;
}

export { POWER_TOOL_DEFAULTS, WORKSPACE_DEFAULTS, STORAGE_KEY, SCHEMA_VERSION };
