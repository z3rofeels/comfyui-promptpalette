import { readEditorPreference, writeEditorPreference } from "../prompt_palette_state.js";
import { notifyPromptPaletteAppearanceChanged } from "../prompt_palette_shared.js";

function loadTheme() {
  const saved = readEditorPreference("theme", null);
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return defaultTheme();
  // v2 briefly exposed experimental finish/glow controls. Drop those legacy fields
  // on load so an old local preference cannot keep repainting the suite differently.
  const { surfaceFinish: _legacySurfaceFinish, accentGlow: _legacyAccentGlow, ...clean } = saved;
  return { ...defaultTheme(), ...clean };
}
function defaultTheme() {
  return {
    hueRotate: 0, saturation: 58, categoryPins: {},

    fontFamily: "",
    editorFontSize: 12.5,
    uiFontScale: 1,
    promptTextColor: "#f1eee8",
    promptTextColorMode: "theme",

    cornerRadius: 10,

    showGalleryBtn: true,
    showEditBtn: true,
    showRecipesBtn: true,
    showStashBtn: true,
    showRefreshBtn: true,
    showUndoBtn: true,
    showRedoBtn: true,
    showResolveBtn: true,
    showCopyBtn: true,
    showClearBtn: true,

    showSeedControls: false,
    showDayNightBtn: true,
    dayTheme: "Porcelain",
    nightTheme: "Cinder",

    syntaxInjectorEnabled: true,
    promptHistoryEnabled: true,
    starterPacksEnabled: true,
    zenMode: false,
    layoutPreset: "balanced",
    compactOutputLabels: true,
  };
}
function saveTheme(theme) {
  writeEditorPreference("theme", theme);
  notifyPromptPaletteAppearanceChanged();
}
function loadCategoryPalettes() {
  const value = readEditorPreference("categoryPalettes", {});
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function saveCategoryPalettes(value) {
  writeEditorPreference("categoryPalettes", value);
}
function categoryPaletteSnapshot(theme) {
  return {
    hueRotate: Number(theme.hueRotate) || 0,
    saturation: Number(theme.saturation) || 58,
    categoryPins: { ...(theme.categoryPins || {}) },
  };
}
function loadPinned() {
  const value = readEditorPreference("pinned", []);
  return new Set(Array.isArray(value) ? value : []);
}
function savePinned(set) {
  writeEditorPreference("pinned", Array.from(set));
}

function loadExpandedCats() {
  const value = readEditorPreference("expandedCategories", []);
  return new Set(Array.isArray(value) ? value : []);
}
function saveExpandedCats(set) {
  writeEditorPreference("expandedCategories", Array.from(set));
}

function loadCatOrder() {
  const value = readEditorPreference("categoryOrder", []);
  return Array.isArray(value) ? value : [];
}
function saveCatOrder(arr) {
  writeEditorPreference("categoryOrder", Array.isArray(arr) ? arr : []);
}

function loadPickerView() {
  return readEditorPreference("pickerView", "list") === "grid" ? "grid" : "list";
}
function savePickerView(mode) {
  writeEditorPreference("pickerView", mode === "grid" ? "grid" : "list");
}
function loadLibraryDensity() {
  const value = readEditorPreference("libraryDensity", "medium");
  return value === "small" || value === "large" ? value : "medium";
}
function saveLibraryDensity(value) {
  writeEditorPreference("libraryDensity", value);
}

const UI_THEME_KEYS = [
  ["bg", "Background"],
  ["panel-bg", "Panels / drawers"],
  ["surface", "Inputs & editor"],
  ["border", "Border"],
  ["border-strong", "Border (strong)"],
  ["text", "Text"],
  ["text-dim", "Text (dim)"],
  ["text-faint", "Text (faint)"],
  ["accent", "Accent"],
  ["accent-text", "Accent text"],
  ["success", "Success"],
  ["danger", "Danger"],
];
const BUILTIN_UI_THEMES = {
  "Cherry Cola": {
    bg: "#231216", "panel-bg": "#34171d", surface: "#12090c",
    border: "#593e42", "border-strong": "#755c60",
    text: "#fff0ed", "text-dim": "#c1b2b1", "text-faint": "#958586",
    accent: "#ef665f", "accent-text": "#101214",
    success: "#79b98b", danger: "#d97076",
  },
  "Cream Soda": {
    bg: "#f6e4be", "panel-bg": "#fff5dc", surface: "#fffdf7",
    border: "#e1d6bf", "border-strong": "#c8bda8",
    text: "#34271c", "text-dim": "#6a5c49", "text-faint": "#91826a",
    accent: "#a45b20", "accent-text": "#ffffff",
    success: "#3f7b59", danger: "#ad4d59",
  },
  "Orange Fizz": {
    bg: "#282031", "panel-bg": "#3a2330", surface: "#151018",
    border: "#5d4851", "border-strong": "#79656b",
    text: "#fff2e9", "text-dim": "#c3b7b5", "text-faint": "#988d91",
    accent: "#ff9138", "accent-text": "#101214",
    success: "#79b98b", danger: "#d97076",
  },
  "Grape Pop": {
    bg: "#d9b7ef", "panel-bg": "#eddbfb", surface: "#fff6ff",
    border: "#d2bfe0", "border-strong": "#bda8cb",
    text: "#3a1f49", "text-dim": "#674a77", "text-faint": "#866899",
    accent: "#7b2cab", "accent-text": "#ffffff",
    success: "#3f7b59", danger: "#ad4d59",
  },
  "Lime Fizz": {
    bg: "#17220f", "panel-bg": "#263314", surface: "#0c1208",
    border: "#4b583a", "border-strong": "#687458",
    text: "#f4ffe8", "text-dim": "#b6c1ab", "text-faint": "#8a9580",
    accent: "#b9e85a", "accent-text": "#101214",
    success: "#79b98b", danger: "#d97076",
  },
  "Root Beer": {
    bg: "#301606", "panel-bg": "#54270b", surface: "#170a03",
    border: "#734b30", "border-strong": "#8b674d",
    text: "#fff0d9", "text-dim": "#c5b39e", "text-faint": "#9c8774",
    accent: "#e1a15a", "accent-text": "#101214",
    success: "#79b98b", danger: "#d97076",
  },
  "Cosmic Dust": {
    bg: "#151820", "panel-bg": "#292d36", surface: "#0a0c10",
    border: "#4e5059", "border-strong": "#6a6c73",
    text: "#f5f2f6", "text-dim": "#b6b5ba", "text-faint": "#89898f",
    accent: "#d18fb8", "accent-text": "#101214",
    success: "#79b98b", danger: "#d97076",
  },
  Saturn: {
    bg: "#efe1b9", "panel-bg": "#fbf3d8", surface: "#fffaf0",
    border: "#ddd5bb", "border-strong": "#c5bca4",
    text: "#332819", "text-dim": "#685c46", "text-faint": "#8d8166",
    accent: "#8067b7", "accent-text": "#ffffff",
    success: "#3f7b59", danger: "#ad4d59",
  },
  Mars: {
    bg: "#351712", "panel-bg": "#57231a", surface: "#1a0d09",
    border: "#75473e", "border-strong": "#8d635a",
    text: "#ffece1", "text-dim": "#c6b0a7", "text-faint": "#9e867e",
    accent: "#e96c43", "accent-text": "#101214",
    success: "#79b98b", danger: "#d97076",
  },
  Neptune: {
    bg: "#071b3a", "panel-bg": "#0d2a58", surface: "#041022",
    border: "#354f76", "border-strong": "#556b8d",
    text: "#edf6ff", "text-dim": "#adb9c8", "text-faint": "#7f8da0",
    accent: "#3ca8ff", "accent-text": "#101214",
    success: "#79b98b", danger: "#d97076",
  },
  Europa: {
    bg: "#d8e3ed", "panel-bg": "#e9f1f8", surface: "#fbfdff",
    border: "#c9d4de", "border-strong": "#b0bdc9",
    text: "#17324b", "text-dim": "#4d6478", "text-faint": "#748799",
    accent: "#285f9d", "accent-text": "#ffffff",
    success: "#3f7b59", danger: "#ad4d59",
  },
  Lunar: {
    bg: "#1c1e22", "panel-bg": "#2c3036", surface: "#0e1013",
    border: "#505359", "border-strong": "#6c6f73",
    text: "#f3f4f6", "text-dim": "#b7b8bb", "text-faint": "#8c8d90",
    accent: "#aeb9c4", "accent-text": "#101214",
    success: "#79b98b", danger: "#d97076",
  },
  Venus: {
    bg: "#f5d8c4", "panel-bg": "#fff0e4", surface: "#fffaf5",
    border: "#e2d1c7", "border-strong": "#cbb9af",
    text: "#3e2421", "text-dim": "#71564f", "text-faint": "#967a6f",
    accent: "#b34d67", "accent-text": "#ffffff",
    success: "#3f7b59", danger: "#ad4d59",
  },
  "Solar Flare": {
    bg: "#270704", "panel-bg": "#4a0d06", surface: "#0d0201",
    border: "#6b362d", "border-strong": "#84564a",
    text: "#fff0dc", "text-dim": "#c3afa0", "text-faint": "#978074",
    accent: "#ff9800", "accent-text": "#101214",
    success: "#79b98b", danger: "#d97076",
  },
  "Deep Space": {
    bg: "#080810", "panel-bg": "#11101d", surface: "#030306",
    border: "#3a3846", "border-strong": "#5a5865",
    text: "#f4f0ff", "text-dim": "#b2afbc", "text-faint": "#83818c",
    accent: "#47e6d6", "accent-text": "#101214",
    success: "#79b98b", danger: "#d97076",
  },
  "Sea Glass": {
    bg: "#c5e9e8", "panel-bg": "#e4f7f6", surface: "#fbffff",
    border: "#c4dbdb", "border-strong": "#abc4c5",
    text: "#123b3f", "text-dim": "#446c6e", "text-faint": "#688f90",
    accent: "#176f76", "accent-text": "#ffffff",
    success: "#3f7b59", danger: "#ad4d59",
  },
  "Tropical Reef": {
    bg: "#e7fbf8", "panel-bg": "#fff6e8", surface: "#ffffff",
    border: "#dcdacf", "border-strong": "#c0c4bb",
    text: "#153c42", "text-dim": "#507175", "text-faint": "#7a9899",
    accent: "#ef6b55", "accent-text": "#101214",
    success: "#3f7b59", danger: "#ad4d59",
  },
  Abyss: {
    bg: "#061723", "panel-bg": "#0b2938", surface: "#030c12",
    border: "#334e5c", "border-strong": "#526b78",
    text: "#e9f8ff", "text-dim": "#a9b9c1", "text-faint": "#7c8c95",
    accent: "#29b5d3", "accent-text": "#101214",
    success: "#79b98b", danger: "#d97076",
  },
  "Storm Coast": {
    bg: "#222a30", "panel-bg": "#303a42", surface: "#151a1e",
    border: "#535b62", "border-strong": "#6d767c",
    text: "#f0f4f6", "text-dim": "#b6bbbf", "text-faint": "#8d9397",
    accent: "#8cc7bf", "accent-text": "#101214",
    success: "#79b98b", danger: "#d97076",
  },
  Lagoon: {
    bg: "#f5ead2", "panel-bg": "#dff5ed", surface: "#fffdf7",
    border: "#c1d9d2", "border-strong": "#aac2bc",
    text: "#193936", "text-dim": "#576b62", "text-faint": "#838e81",
    accent: "#158f86", "accent-text": "#101214",
    success: "#3f7b59", danger: "#ad4d59",
  },
  Bioluminescence: {
    bg: "#071b20", "panel-bg": "#10323a", surface: "#030d10",
    border: "#37575d", "border-strong": "#557479",
    text: "#e9ffff", "text-dim": "#aabfc1", "text-faint": "#7d9294",
    accent: "#88f0ff", "accent-text": "#101214",
    success: "#79b98b", danger: "#d97076",
  },
  Meadow: {
    bg: "#d9efb8", "panel-bg": "#eef8d3", surface: "#fbfff2",
    border: "#d1dcb7", "border-strong": "#bac5a1",
    text: "#2d3b19", "text-dim": "#5d6d46", "text-faint": "#809165",
    accent: "#5e7f23", "accent-text": "#ffffff",
    success: "#3f7b59", danger: "#ad4d59",
  },
  Hydrangea: {
    bg: "#dbe6f7", "panel-bg": "#eee4f7", surface: "#fffaff",
    border: "#d2c8dd", "border-strong": "#bcb2c8",
    text: "#332a48", "text-dim": "#625f79", "text-faint": "#84849c",
    accent: "#a24f8e", "accent-text": "#ffffff",
    success: "#3f7b59", danger: "#ad4d59",
  },
  Sunflower: {
    bg: "#e5efac", "panel-bg": "#f6f1b8", surface: "#fffbe6",
    border: "#d9d69f", "border-strong": "#c2c18c",
    text: "#344014", "text-dim": "#66713f", "text-faint": "#89945d",
    accent: "#c37800", "accent-text": "#101214",
    success: "#3f7b59", danger: "#ad4d59",
  },
  Terracotta: {
    bg: "#d7a184", "panel-bg": "#edbea4", surface: "#fff0e6",
    border: "#d5a78f", "border-strong": "#c1947e",
    text: "#4b2418", "text-dim": "#724736", "text-faint": "#8e604c",
    accent: "#8f3423", "accent-text": "#ffffff",
    success: "#3f7b59", danger: "#ad4d59",
  },
  Greenhouse: {
    bg: "#b8dfc5", "panel-bg": "#d6efdf", surface: "#f6fff8",
    border: "#bad3c3", "border-strong": "#a3bdad",
    text: "#183426", "text-dim": "#456453", "text-faint": "#658672",
    accent: "#00724a", "accent-text": "#ffffff",
    success: "#3f7b59", danger: "#ad4d59",
  },
  Bluebell: {
    bg: "#222749", "panel-bg": "#343b6d", surface: "#12152b",
    border: "#575c87", "border-strong": "#71779c",
    text: "#f4f5ff", "text-dim": "#b9bbcc", "text-faint": "#8f92a8",
    accent: "#91a4ff", "accent-text": "#101214",
    success: "#79b98b", danger: "#d97076",
  },
  "Strawberry Cream": {
    bg: "#f9e0e6", "panel-bg": "#fff1f4", surface: "#fffafb",
    border: "#e4d3d7", "border-strong": "#cebabf",
    text: "#4a2730", "text-dim": "#7b5b63", "text-faint": "#9e8087",
    accent: "#d95372", "accent-text": "#101214",
    success: "#3f7b59", danger: "#ad4d59",
  },
  "Lemon Drop": {
    bg: "#fff2a8", "panel-bg": "#fff9d7", surface: "#fffef2",
    border: "#e1dbba", "border-strong": "#c8c2a3",
    text: "#342f15", "text-dim": "#6d663e", "text-faint": "#958d5c",
    accent: "#796300", "accent-text": "#ffffff",
    success: "#3f7b59", danger: "#ad4d59",
  },
  "Blue Raspberry": {
    bg: "#dff5ff", "panel-bg": "#ecfbff", surface: "#ffffff",
    border: "#ccdde3", "border-strong": "#b2c5cd",
    text: "#173246", "text-dim": "#4f697a", "text-faint": "#77909f",
    accent: "#008dcc", "accent-text": "#101214",
    success: "#3f7b59", danger: "#ad4d59",
  },
  "Cotton Candy": {
    bg: "#f6e8fa", "panel-bg": "#e5f4ff", surface: "#fffafe",
    border: "#cbd6e3", "border-strong": "#b6bdcd",
    text: "#382a47", "text-dim": "#6d5f79", "text-faint": "#93859d",
    accent: "#ef76a8", "accent-text": "#101214",
    success: "#3f7b59", danger: "#ad4d59",
  },
  "Mint Chip": {
    bg: "#32170f", "panel-bg": "#55271b", surface: "#180b07",
    border: "#744c40", "border-strong": "#8b695d",
    text: "#fff4e8", "text-dim": "#c6b6ab", "text-faint": "#9d8a80",
    accent: "#78d0a6", "accent-text": "#101214",
    success: "#79b98b", danger: "#d97076",
  },
  "Chocolate Truffle": {
    bg: "#271714", "panel-bg": "#3b211c", surface: "#120a08",
    border: "#5e4641", "border-strong": "#7a635d",
    text: "#fff0e8", "text-dim": "#c3b3ad", "text-faint": "#978882",
    accent: "#d29a7b", "accent-text": "#101214",
    success: "#79b98b", danger: "#d97076",
  },
  "Pixel Blue": {
    bg: "#1238a0", "panel-bg": "#1c55c5", surface: "#08194b",
    border: "#4372cf", "border-strong": "#6089d8",
    text: "#f2f7ff", "text-dim": "#b3c2e4", "text-faint": "#869bd1",
    accent: "#ffcf43", "accent-text": "#101214",
    success: "#79b98b", danger: "#d97076",
  },
  "8-Bit Cherry": {
    bg: "#c9cdd2", "panel-bg": "#e3e6e9", surface: "#f8f9fa",
    border: "#c6c9cc", "border-strong": "#aeb2b6",
    text: "#20252b", "text-dim": "#4f545a", "text-faint": "#71767b",
    accent: "#c5163a", "accent-text": "#ffffff",
    success: "#3f7b59", danger: "#ad4d59",
  },
  "Coin Slot": {
    bg: "#17130b", "panel-bg": "#2c2410", surface: "#080603",
    border: "#524a35", "border-strong": "#706851",
    text: "#fff9dc", "text-dim": "#beb9a1", "text-faint": "#908b78",
    accent: "#ffd447", "accent-text": "#101214",
    success: "#79b98b", danger: "#d97076",
  },
  "Power Up": {
    bg: "#160b25", "panel-bg": "#30134c", surface: "#090411",
    border: "#543b6c", "border-strong": "#705985",
    text: "#f8efff", "text-dim": "#b9afc2", "text-faint": "#8c8296",
    accent: "#32e6d1", "accent-text": "#101214",
    success: "#79b98b", danger: "#d97076",
  },
  "Green Screen": {
    bg: "#d5d8ca", "panel-bg": "#ecefe5", surface: "#f8faf3",
    border: "#cdd2c8", "border-strong": "#b4bbb0",
    text: "#1d3021", "text-dim": "#515f50", "text-faint": "#758172",
    accent: "#1b873a", "accent-text": "#ffffff",
    success: "#3f7b59", danger: "#ad4d59",
  },
  "CRT Glow": {
    bg: "#082026", "panel-bg": "#0b3741", surface: "#031012",
    border: "#335b63", "border-strong": "#52777e",
    text: "#eaffff", "text-dim": "#abc1c2", "text-faint": "#7e9497",
    accent: "#55d8ff", "accent-text": "#101214",
    success: "#79b98b", danger: "#d97076",
  },
  "Pine Ridge": {
    bg: "#102018", "panel-bg": "#1a3827", surface: "#08100c",
    border: "#415c4c", "border-strong": "#5e7869",
    text: "#f0fff6", "text-dim": "#b1c1b8", "text-faint": "#84948b",
    accent: "#70b778", "accent-text": "#101214",
    success: "#79b98b", danger: "#d97076",
  },
  "Canyon Clay": {
    bg: "#e1ad84", "panel-bg": "#f0c9aa", surface: "#fff1e5",
    border: "#d7b195", "border-strong": "#c39e84",
    text: "#48291c", "text-dim": "#734e39", "text-faint": "#91684e",
    accent: "#2e7079", "accent-text": "#ffffff",
    success: "#3f7b59", danger: "#ad4d59",
  },
  "Lake Cabin": {
    bg: "#0d2029", "panel-bg": "#173846", surface: "#081219",
    border: "#3e5b67", "border-strong": "#5b7681",
    text: "#edfaff", "text-dim": "#aebdc3", "text-faint": "#819198",
    accent: "#c58c52", "accent-text": "#101214",
    success: "#79b98b", danger: "#d97076",
  },
  "Desert Sage": {
    bg: "#e7ead8", "panel-bg": "#f5f5e8", surface: "#fffdf7",
    border: "#d7d8cc", "border-strong": "#c0c2b5",
    text: "#30372b", "text-dim": "#63695b", "text-faint": "#888d7e",
    accent: "#75885e", "accent-text": "#101214",
    success: "#3f7b59", danger: "#ad4d59",
  },
  Campfire: {
    bg: "#121315", "panel-bg": "#25272a", surface: "#08090a",
    border: "#4c4b4b", "border-strong": "#6b6864",
    text: "#fff1df", "text-dim": "#bdb3a6", "text-faint": "#8d867e",
    accent: "#ff7a32", "accent-text": "#101214",
    success: "#79b98b", danger: "#d97076",
  },
  "Alpine Sky": {
    bg: "#173147", "panel-bg": "#24506a", surface: "#0c1b28",
    border: "#486e85", "border-strong": "#65869a",
    text: "#eef8ff", "text-dim": "#b2c0cb", "text-faint": "#8798a7",
    accent: "#9bd2f0", "accent-text": "#101214",
    success: "#79b98b", danger: "#d97076",
  },
  Cinder: {
    bg: "#17191c", "panel-bg": "#24272b", surface: "#0d0f11",
    border: "#494b4d", "border-strong": "#676767",
    text: "#f4efe8", "text-dim": "#b6b3af", "text-faint": "#8a8886",
    accent: "#d79a4f", "accent-text": "#101214",
    success: "#79b98b", danger: "#d97076",
  },
  "Midnight Plum": {
    bg: "#171020", "panel-bg": "#2b1839", surface: "#0b0710",
    border: "#503f5d", "border-strong": "#6c5d78",
    text: "#f7efff", "text-dim": "#b8b1c1", "text-faint": "#8b8494",
    accent: "#b98cff", "accent-text": "#101214",
    success: "#79b98b", danger: "#d97076",
  },
  "Blue Hour": {
    bg: "#0b1625", "panel-bg": "#152947", surface: "#050b13",
    border: "#3c4e68", "border-strong": "#5a6b82",
    text: "#eef6ff", "text-dim": "#aeb7c2", "text-faint": "#818a96",
    accent: "#ff8e61", "accent-text": "#101214",
    success: "#79b98b", danger: "#d97076",
  },
  Terminal: {
    bg: "#071009", "panel-bg": "#102215", surface: "#030604",
    border: "#374a3c", "border-strong": "#56695a",
    text: "#eaffec", "text-dim": "#aabcac", "text-faint": "#7d8c7f",
    accent: "#62dc7b", "accent-text": "#101214",
    success: "#79b98b", danger: "#d97076",
  },
  Rosewood: {
    bg: "#271319", "panel-bg": "#401c27", surface: "#12090c",
    border: "#62424c", "border-strong": "#7d6069",
    text: "#fff0f4", "text-dim": "#c3b2b7", "text-faint": "#97868b",
    accent: "#e88aa8", "accent-text": "#101214",
    success: "#79b98b", danger: "#d97076",
  },
  "Noir Gold": {
    bg: "#090909", "panel-bg": "#181818", surface: "#020202",
    border: "#403f3c", "border-strong": "#5f5d58",
    text: "#f6f0df", "text-dim": "#b4afa3", "text-faint": "#848178",
    accent: "#d8b45f", "accent-text": "#101214",
    success: "#79b98b", danger: "#d97076",
  },
  Porcelain: {
    bg: "#eef2f5", "panel-bg": "#ffffff", surface: "#f9fbfc",
    border: "#dddfe0", "border-strong": "#c1c5c7",
    text: "#1b2731", "text-dim": "#566068", "text-faint": "#80888f",
    accent: "#4b6f9e", "accent-text": "#ffffff",
    success: "#3f7b59", danger: "#ad4d59",
  },
  Newsprint: {
    bg: "#e5d7b9", "panel-bg": "#f4ead4", surface: "#fff7e8",
    border: "#d6cdb9", "border-strong": "#beb6a4",
    text: "#2b2922", "text-dim": "#5f5a4c", "text-faint": "#847d6a",
    accent: "#a43d2b", "accent-text": "#ffffff",
    success: "#3f7b59", danger: "#ad4d59",
  },
  "Ivory Ink": {
    bg: "#f4f0e5", "panel-bg": "#fffdf7", surface: "#ffffff",
    border: "#dddedb", "border-strong": "#c2c5c4",
    text: "#1e2c3a", "text-dim": "#5a636a", "text-faint": "#858a8c",
    accent: "#2f5379", "accent-text": "#ffffff",
    success: "#3f7b59", danger: "#ad4d59",
  },
  "Peach Paper": {
    bg: "#f9e4d8", "panel-bg": "#fff3eb", surface: "#fffaf7",
    border: "#e2d5cd", "border-strong": "#cbbdb6",
    text: "#402a25", "text-dim": "#745e57", "text-faint": "#99837b",
    accent: "#c95b49", "accent-text": "#101214",
    success: "#3f7b59", danger: "#ad4d59",
  },
  "Lavender Fog": {
    bg: "#eeeaf5", "panel-bg": "#faf8fd", surface: "#ffffff",
    border: "#dcd9e1", "border-strong": "#c4c1ca",
    text: "#332c40", "text-dim": "#676173", "text-faint": "#8d8797",
    accent: "#775fa8", "accent-text": "#ffffff",
    success: "#3f7b59", danger: "#ad4d59",
  },
  "Mint Paper": {
    bg: "#e5f2e8", "panel-bg": "#f5fbf7", surface: "#ffffff",
    border: "#d6ded9", "border-strong": "#bcc7c2",
    text: "#233b31", "text-dim": "#596e64", "text-faint": "#809389",
    accent: "#3f8166", "accent-text": "#ffffff",
    success: "#3f7b59", danger: "#ad4d59",
  },
  Bauhaus: {
    bg: "#f2ead8", "panel-bg": "#fff8e8", surface: "#ffffff",
    border: "#ddd7c9", "border-strong": "#c2bdb1",
    text: "#1d1d1b", "text-dim": "#595650", "text-faint": "#837f76",
    accent: "#d63c32", "accent-text": "#ffffff",
    success: "#3f7b59", danger: "#ad4d59",
  },
  "Art Deco": {
    bg: "#061d14", "panel-bg": "#0e3b29", surface: "#020b07",
    border: "#395c48", "border-strong": "#5b7660",
    text: "#fff2d5", "text-dim": "#b9b69f", "text-faint": "#878c78",
    accent: "#ddb755", "accent-text": "#101214",
    success: "#79b98b", danger: "#d97076",
  },
  Memphis: {
    bg: "#f5f3e9", "panel-bg": "#ffffff", surface: "#fffdf7",
    border: "#dedee1", "border-strong": "#c4c4c8",
    text: "#242534", "text-dim": "#5f5f67", "text-faint": "#88888b",
    accent: "#1aa9b8", "accent-text": "#101214",
    success: "#3f7b59", danger: "#ad4d59",
  },
  "Ink Wash": {
    bg: "#cfd3d6", "panel-bg": "#e5e8ea", surface: "#fafbfb",
    border: "#c6c9cb", "border-strong": "#adb0b3",
    text: "#16191d", "text-dim": "#4a4d51", "text-faint": "#6f7276",
    accent: "#30363c", "accent-text": "#ffffff",
    success: "#3f7b59", danger: "#ad4d59",
  },
  Ceramic: {
    bg: "#ead8c7", "panel-bg": "#f7eadf", surface: "#fffaf5",
    border: "#d9cfc7", "border-strong": "#c1bab4",
    text: "#2f3940", "text-dim": "#636666", "text-faint": "#898581",
    accent: "#3b7796", "accent-text": "#ffffff",
    success: "#3f7b59", danger: "#ad4d59",
  },
  "Paper Cut": {
    bg: "#143037", "panel-bg": "#1f4650", surface: "#0a191d",
    border: "#446770", "border-strong": "#628188",
    text: "#efffff", "text-dim": "#b2c5c7", "text-faint": "#869c9f",
    accent: "#ff7b62", "accent-text": "#101214",
    success: "#79b98b", danger: "#d97076",
  },
  Slate: {
    bg: "#151c26", "panel-bg": "#202b38", surface: "#0c1118",
    border: "#454f5a", "border-strong": "#626b75",
    text: "#edf3f7", "text-dim": "#b1b7bc", "text-faint": "#858c93",
    accent: "#6fa4d1", "accent-text": "#101214",
    success: "#79b98b", danger: "#d97076",
  },
  "Graphite Mint": {
    bg: "#1b1d1d", "panel-bg": "#292e2d", surface: "#101212",
    border: "#4d5251", "border-strong": "#696d6c",
    text: "#f1f4f3", "text-dim": "#b5b8b7", "text-faint": "#8a8d8c",
    accent: "#6fc1a2", "accent-text": "#101214",
    success: "#79b98b", danger: "#d97076",
  },
  Oxford: {
    bg: "#eee8db", "panel-bg": "#faf5e9", surface: "#fffdf7",
    border: "#d9d7cf", "border-strong": "#bebebb",
    text: "#1c2a3d", "text-dim": "#575f69", "text-faint": "#818589",
    accent: "#8b3f43", "accent-text": "#ffffff",
    success: "#3f7b59", danger: "#ad4d59",
  },
  "Executive Sand": {
    bg: "#e5dccd", "panel-bg": "#f4eee4", surface: "#fffaf2",
    border: "#d6d1c8", "border-strong": "#bfbab2",
    text: "#2e2c2a", "text-dim": "#615d58", "text-faint": "#868078",
    accent: "#6c5e4a", "accent-text": "#ffffff",
    success: "#3f7b59", danger: "#ad4d59",
  },
  Blueprint: {
    bg: "#0d2e4d", "panel-bg": "#164b75", surface: "#071a2d",
    border: "#3d6a8e", "border-strong": "#5b82a1",
    text: "#eef7ff", "text-dim": "#afbfcd", "text-faint": "#8297aa",
    accent: "#f2c45f", "accent-text": "#101214",
    success: "#79b98b", danger: "#d97076",
  },
  "High Contrast": {
    bg: "#000000", "panel-bg": "#111111", surface: "#000000",
    border: "#3c3c3c", "border-strong": "#5d5d5d",
    text: "#ffffff", "text-dim": "#b8b8b8", "text-faint": "#858585",
    accent: "#ffd400", "accent-text": "#101214",
    success: "#79b98b", danger: "#d97076",
  },
  Copperstone: {
    bg: "#351b15", "panel-bg": "#613223", surface: "#180c09",
    border: "#7d5447", "border-strong": "#946f62",
    text: "#fff1e9", "text-dim": "#c6b5ae", "text-faint": "#9e8a83",
    accent: "#4ca39b", "accent-text": "#101214",
    success: "#79b98b", danger: "#d97076",
  },
  "Frosted Glass": {
    bg: "#d3eaee", "panel-bg": "#eaf7f9", surface: "#ffffff",
    border: "#ccdbde", "border-strong": "#b3c4c8",
    text: "#203a43", "text-dim": "#526b73", "text-faint": "#768e95",
    accent: "#4b8996", "accent-text": "#101214",
    success: "#3f7b59", danger: "#ad4d59",
  },
  "Walnut Brass": {
    bg: "#ddc3a6", "panel-bg": "#efdbc4", surface: "#fff6ea",
    border: "#d4c1ab", "border-strong": "#beab98",
    text: "#3b2b20", "text-dim": "#685646", "text-faint": "#897460",
    accent: "#8a682b", "accent-text": "#ffffff",
    success: "#3f7b59", danger: "#ad4d59",
  },
};


// Curated presentation-only groups for the main Prompt Palette appearance studio.
// A theme belongs to one primary pack so browsing stays predictable; adding a new
// pack later is data-only and does not change the suite-wide appearance state.
const THEME_PACKS = Object.freeze([
  {
    id: "fountain", name: "Soda Shop", tone: "Playful",
    description: "Classic fountain-counter color with six clearly different flavors.",
    themes: ["Cherry Cola", "Cream Soda", "Orange Fizz", "Grape Pop", "Lime Fizz", "Root Beer"],
  },
  {
    id: "planetarium", name: "Planetarium", tone: "Cosmic",
    description: "Planets, moons, starlight, and genuinely different space palettes.",
    themes: ["Cosmic Dust", "Saturn", "Mars", "Neptune", "Europa", "Lunar", "Venus", "Solar Flare", "Deep Space"],
  },
  {
    id: "deep-current", name: "Ocean", tone: "Cool",
    description: "From pale sea glass to storm water and bioluminescent depths.",
    themes: ["Sea Glass", "Tropical Reef", "Abyss", "Storm Coast", "Lagoon", "Bioluminescence"],
  },
  {
    id: "garden", name: "Garden", tone: "Fresh",
    description: "Botanical palettes with flowers, soil, sunlight, and greenhouse glass.",
    themes: ["Meadow", "Hydrangea", "Sunflower", "Terracotta", "Greenhouse", "Bluebell"],
  },
  {
    id: "sweet-shop", name: "Sweet Shop", tone: "Cheerful",
    description: "Pastel counters, candy color, mint, citrus, and chocolate.",
    themes: ["Strawberry Cream", "Lemon Drop", "Blue Raspberry", "Cotton Candy", "Mint Chip", "Chocolate Truffle"],
  },
  {
    id: "pixel-arcade", name: "Pixel Arcade", tone: "Retro",
    description: "Bold arcade display colors instead of near-identical dark swatches.",
    themes: ["Pixel Blue", "8-Bit Cherry", "Coin Slot", "Power Up", "Green Screen", "CRT Glow"],
  },
  {
    id: "trailhead", name: "Trailhead", tone: "Outdoors",
    description: "Wood, stone, sky, fire, sage, and mountain-water color.",
    themes: ["Pine Ridge", "Canyon Clay", "Lake Cabin", "Desert Sage", "Campfire", "Alpine Sky"],
  },
  {
    id: "after-hours", name: "Night", tone: "Dark",
    description: "Six different dark moods: charcoal, plum, navy, terminal, wine, and noir.",
    themes: ["Cinder", "Midnight Plum", "Blue Hour", "Terminal", "Rosewood", "Noir Gold"],
  },
  {
    id: "sunroom", name: "Daylight", tone: "Light",
    description: "Bright surfaces with cool, warm, editorial, peach, lavender, and mint personalities.",
    themes: ["Porcelain", "Newsprint", "Ivory Ink", "Peach Paper", "Lavender Fog", "Mint Paper"],
  },
  {
    id: "atelier", name: "Creative", tone: "Expressive",
    description: "Distinct graphic-design inspired palettes, not one generic creative look.",
    themes: ["Bauhaus", "Art Deco", "Memphis", "Ink Wash", "Ceramic", "Paper Cut"],
  },
  {
    id: "tailored", name: "Professional", tone: "Focused",
    description: "Professional options that differ in temperature and contrast, not just blue-grey increments.",
    themes: ["Slate", "Graphite Mint", "Oxford", "Executive Sand", "Blueprint", "High Contrast"],
  },
  {
    id: "materials", name: "Materials", tone: "Tactile",
    description: "Three material-inspired palettes with unmistakably different surfaces.",
    themes: ["Copperstone", "Frosted Glass", "Walnut Brass"],
  },
]);

const LEGACY_UI_THEME_ALIASES = { Amber: "Cinder", Daylight: "Porcelain", Mono: "Slate", "Forest": "Greenhouse", "Harbor": "Storm Coast", "Saffron": "Sunflower", "Aurora": "Bioluminescence", "Arctic": "Europa", "Ocean Glass": "Abyss", "Sakura": "Strawberry Cream", "Ember": "Campfire", "Gumball": "Cotton Candy", "Caramel Swirl": "Root Beer", "Purple Cartridge": "Midnight Plum", "High Score": "High Contrast", "Red Rock": "Mars", "Riverstone": "Frosted Glass", "Golden Hour": "Saturn", "Lavender Field": "Lavender Fog", "Mint Leaf": "Mint Paper" };
function normalizeUiThemeName(name) { return LEGACY_UI_THEME_ALIASES[name] || name; }

function loadUiThemes() {
  const value = readEditorPreference("uiThemes", {});
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function saveUiThemes(themes) {
  writeEditorPreference("uiThemes", themes);
  notifyPromptPaletteAppearanceChanged();
}
function loadActiveUiThemeName() {
  return normalizeUiThemeName(readEditorPreference("activeUiTheme", "Cinder") || "Cinder");
}
function saveActiveUiThemeName(name) {
  writeEditorPreference("activeUiTheme", normalizeUiThemeName(name));
  notifyPromptPaletteAppearanceChanged({ immediate: true });
}


export {
  loadTheme, defaultTheme, saveTheme,
  loadCategoryPalettes, saveCategoryPalettes, categoryPaletteSnapshot,
  loadPinned, savePinned, loadExpandedCats, saveExpandedCats, loadCatOrder, saveCatOrder,
  loadPickerView, savePickerView, loadLibraryDensity, saveLibraryDensity,
  UI_THEME_KEYS, BUILTIN_UI_THEMES, THEME_PACKS, normalizeUiThemeName,
  loadUiThemes, saveUiThemes, loadActiveUiThemeName, saveActiveUiThemeName,
};
