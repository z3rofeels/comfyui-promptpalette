import { app } from "/scripts/app.js";

const CSS_HREF = "extensions/comfyui-promptpalette/css/wildcard_editor.css";
if (!document.querySelector(`link[href="${CSS_HREF}"]`)) {
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = CSS_HREF;
  document.head.appendChild(link);
}

const API = {
  async list() {
    const r = await fetch("/prompt_palette/list");
    return (await r.json()).items || [];
  },
  async search(q) {
    const r = await fetch(`/prompt_palette/search?q=${encodeURIComponent(q)}`);
    return (await r.json()).items || [];
  },
  async preview(name) {
    const r = await fetch(`/prompt_palette/preview?name=${encodeURIComponent(name)}`);
    return await r.json();
  },
  async content(name) {
    const r = await fetch(`/prompt_palette/content?name=${encodeURIComponent(name)}`);
    if (!r.ok) return null;
    return await r.json();
  },
  async save(name, content) {
    const r = await fetch("/prompt_palette/save", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, content }),
    });
    return await r.json();
  },
  async del(name) {
    const r = await fetch("/prompt_palette/delete", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    return await r.json();
  },
  async resolve(text, seed, mode) {
    const r = await fetch("/prompt_palette/resolve", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, seed, mode }),
    });
    return (await r.json()).resolved || "";
  },
  async refreshWildcards() {
    const r = await fetch("/prompt_palette/refresh", { method: "POST" });
    if (!r.ok) throw new Error(`refresh failed: ${r.status}`);
    return await r.json();
  },
};

function loadTheme() {
  try {
    const raw = localStorage.getItem("pp_theme");
    if (raw) return { ...defaultTheme(), ...JSON.parse(raw) };
  } catch (e) {}
  return defaultTheme();
}
function defaultTheme() {
  return {
    hueRotate: 0, saturation: 65, categoryPins: {},
    // Accessibility: kept separate from the interface (light/dark) theme
    // above and the wildcard-token hue/saturation system, since these three
    // control genuinely different things (chrome color vs. token color vs.
    // legibility) and users with vision needs often want to tune only one.
    fontFamily: "",              // "" = use built-in default stack for each area
    editorFontSize: 12.5,        // px, main prompt textarea + resolved-preview
    uiFontScale: 1,              // multiplier, sidebar/folder/legend text
    promptTextColor: "#e8e2d4",  // plain (non-token) prompt text + caret
  };
}
function saveTheme(theme) {
  try { localStorage.setItem("pp_theme", JSON.stringify(theme)); } catch (e) {}
}
function loadPinned() {
  try { return new Set(JSON.parse(localStorage.getItem("pp_pinned") || "[]")); } catch (e) { return new Set(); }
}
function savePinned(set) {
  try { localStorage.setItem("pp_pinned", JSON.stringify(Array.from(set))); } catch (e) {}
}
// Categories default to COLLAPSED (i.e. absent from this set) so the list
// doesn't flood the drawer the moment a bunch of wildcards are added.
function loadExpandedCats() {
  try { return new Set(JSON.parse(localStorage.getItem("pp_expanded_cats") || "[]")); } catch (e) { return new Set(); }
}
function saveExpandedCats(set) {
  try { localStorage.setItem("pp_expanded_cats", JSON.stringify(Array.from(set))); } catch (e) {}
}
// User-defined ordering for sidebar category folders (drag-to-reorder).
// Stores just the ordered list of category names seen so far; any category
// not yet in this list (new wildcard folder) is appended alphabetically at
// render time and the list is persisted so its position "sticks" from then on.
function loadCatOrder() {
  try { return JSON.parse(localStorage.getItem("pp_cat_order") || "[]"); } catch (e) { return []; }
}
function saveCatOrder(arr) {
  try { localStorage.setItem("pp_cat_order", JSON.stringify(arr)); } catch (e) {}
}

// --- Interface theme system -------------------------------------------
// This themes the UI chrome (backgrounds, panels, buttons, borders, labels)
// via CSS custom properties. It is intentionally separate from the
// hue/saturation/category-pin system above, which colors the wildcard
// tokens inside the prompt text and is left untouched. 
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
  "Amber": {
    "bg": "#1d1c1a", "panel-bg": "#171511", "surface": "#131211",
    "border": "#2c2820", "border-strong": "#38352f",
    "text": "#e8e2d4", "text-dim": "#b3ab99", "text-faint": "#6f6a5c",
    "accent": "#d9a441", "accent-text": "#1d1c1a",
    "success": "#7fae7a", "danger": "#e0605f",
  },
  "Slate": {
    "bg": "#191c20", "panel-bg": "#14171a", "surface": "#101215",
    "border": "#252a30", "border-strong": "#333a42",
    "text": "#e1e7ec", "text-dim": "#96a3ad", "text-faint": "#5c6770",
    "accent": "#5aa9e6", "accent-text": "#0d1216",
    "success": "#6fbf8b", "danger": "#e0605f",
  },
  "Forest": {
    "bg": "#161d17", "panel-bg": "#121712", "surface": "#0f130f",
    "border": "#243024", "border-strong": "#33452f",
    "text": "#e2ecdf", "text-dim": "#9db497", "text-faint": "#5c6c58",
    "accent": "#7fae7a", "accent-text": "#0f1a10",
    "success": "#8fca8a", "danger": "#e0605f",
  },
  "Mono": {
    "bg": "#1a1a1a", "panel-bg": "#151515", "surface": "#101010",
    "border": "#2a2a2a", "border-strong": "#3a3a3a",
    "text": "#e8e8e8", "text-dim": "#a8a8a8", "text-faint": "#707070",
    "accent": "#d0d0d0", "accent-text": "#141414",
    "success": "#8ec98e", "danger": "#e0605f",
  },
  "Daylight": {
    "bg": "#f6f4ef", "panel-bg": "#ffffff", "surface": "#ffffff",
    "border": "#d9d4c8", "border-strong": "#b9b2a0",
    "text": "#1f1d18", "text-dim": "#4c473c", "text-faint": "#79725f",
    "accent": "#a9660a", "accent-text": "#ffffff",
    "success": "#2e7d32", "danger": "#c62828",
  },
  "High Contrast": {
    "bg": "#000000", "panel-bg": "#000000", "surface": "#0a0a0a",
    "border": "#ffffff", "border-strong": "#ffffff",
    "text": "#ffffff", "text-dim": "#f2f2f2", "text-faint": "#d0d0d0",
    "accent": "#ffd400", "accent-text": "#000000",
    "success": "#5cff5c", "danger": "#ff5c5c",
  },
};
function loadUiThemes() {
  try {
    const raw = localStorage.getItem("pp_ui_themes");
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return {};
}
function saveUiThemes(themes) {
  try { localStorage.setItem("pp_ui_themes", JSON.stringify(themes)); } catch (e) {}
}
function loadActiveUiThemeName() {
  try { return localStorage.getItem("pp_ui_active_theme") || "Amber"; } catch (e) { return "Amber"; }
}
function saveActiveUiThemeName(name) {
  try { localStorage.setItem("pp_ui_active_theme", name); } catch (e) {}
}

function hashStr(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h;
}
function categoryOf(p) {
  const parts = p.split("/");
  return parts.length > 1 ? parts.slice(0, -1).join("/") : "misc";
}
function escapeHtml(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
// Used for any color value that might originate from imported/pasted theme
// JSON rather than a native <input type="color"> (which the browser already
// guarantees is a clean hex string). Anything that isn't a real #rrggbb
// falls back to a safe default instead of being trusted as-is.
function sanitizeHexColor(v, fallback = "#000000") {
  return (typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v)) ? v : fallback;
}
function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = n => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const toHex = x => Math.round(255 * x).toString(16).padStart(2, "0");
  return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
}

function buildWildcardWidget(node, hiddenWidget) {
  const theme = loadTheme();
  const pinned = loadPinned();
  const expandedCats = loadExpandedCats();
  let catOrder = loadCatOrder(); // ordered category names; reassigned as new folders are seen/reordered
  let recentList = [];
  let knownSet = new Set();       // full paths known to backend, refreshed periodically
  let libraryCache = [];          // last fetched flat list
  let tokenRanges = [];
  const previewCache = new Map(); // name -> {found, lines}

  const root = document.createElement("div");
  root.className = "wg-node";
  root.innerHTML = `
    <div class="wg-toolbar">
      <div class="wg-toolbar-group left">
        <button class="wg-icon-btn" data-act="picker" title="Browse wildcards">&#128193;</button>
        <button class="wg-icon-btn" data-act="edit" title="Edit / create wildcard">&#9998;</button>
        <button class="wg-icon-btn" data-act="refresh" title="Re-scan wildcards directory">&#8635;</button>
      </div>
      <button class="wg-pill wg-pill-resolve" data-act="resolve">Show resolved</button>
      <div class="wg-toolbar-group right">
        <button class="wg-icon-btn" data-act="copy" title="Copy prompt to clipboard">&#128203;</button>
        <button class="wg-icon-btn" data-act="clear" title="Clear prompt">&#128465;</button>
        <button class="wg-icon-btn" data-act="settings" title="Settings">&#9881;</button>
      </div>
    </div>
    <div class="wg-seedbar" data-el="seedbar">
      <span class="wg-seed-label">Seed</span>
      <input type="number" class="wg-seed-input" data-el="seedInput" min="0" step="1" title="Prompt seed">
      <button class="wg-icon-btn" data-act="seedRandomizeNow" title="Roll a new random seed now">&#127922;</button>
      <select class="wg-seed-mode" data-el="seedModeSelect" title="What happens to the seed after each run"></select>
      <select class="wg-seed-mode" data-el="processingModeSelect" title="How multi-line prompts are resolved" style="flex: 0 0 148px;">
        <option value="entire text as one">Entire text as one</option>
        <option value="line by line">Line by line</option>
      </select>
    </div>
    <div class="wg-main">
      <div class="wg-drawer left" data-drawer="picker">
        <div class="wg-drawer-inner">
          <h4>Browse wildcards</h4>
          <div class="wg-search"><input type="text" placeholder="Search wildcards..." data-el="search"></div>
          <div class="wg-list" data-el="pickerList"></div>
        </div>
      </div>
      <div class="wg-body">
        <div class="wg-editor-wrap">
          <div class="wg-editor-real" data-el="editorReal">
            <div class="wg-editor-layer wg-highlight" data-el="highlight"></div>
            <textarea class="wg-editor-layer wg-textarea" data-el="textarea" spellcheck="true"></textarea>
          </div>
          <div class="wg-resolved" data-el="resolvedView"></div>
        </div>
        <div class="wg-legend" data-el="legend"></div>
        <div class="wg-footer">
          <span class="wg-hint" data-el="hintLeft">colored by folder</span>
          <span class="wg-hint" data-el="hintRight"></span>
        </div>
      </div>
      <div class="wg-drawer right" data-drawer="edit">
        <div class="wg-drawer-inner">
          <div class="wg-drawer-head">
            <h4>Edit wildcard</h4>
            <button class="wg-close-btn" data-act="closeEditDrawer" title="Close">&#10005;</button>
          </div>
          <label>File (txt only, path/name)</label>
          <input type="text" data-el="editName" placeholder="folder/subfolder/name">
          <label>Content (one line per option)</label>
          <textarea data-el="editContent"></textarea>
          <div class="wg-status" data-el="editStatus"></div>
          <div class="wg-drawer-btns">
            <button data-act="delete">Delete</button>
            <button class="primary" data-act="save">Save</button>
          </div>
        </div>
      </div>
    </div>
    <div class="wg-settings-popup" data-el="settingsPopup">
      <div class="wg-settings-head">
        <span>Editor settings</span>
        <button class="wg-close-btn" data-act="closeSettings">&#10005;</button>
      </div>
      <div class="wg-settings-body">
        <h5>Accessibility</h5>
        <div class="wg-srow">
          <label>Font family</label>
          <input type="text" class="wg-theme-select" data-el="fontFamilyInput" list="wg-font-suggestions"
                 placeholder="Leave blank for default (monospace editor / system UI font)">
          <datalist id="wg-font-suggestions">
            <option value="Atkinson Hyperlegible">
            <option value="OpenDyslexic">
            <option value="Arial">
            <option value="Verdana">
            <option value="Tahoma">
            <option value="Segoe UI">
            <option value="Georgia">
            <option value="Consolas">
            <option value="Cascadia Code">
            <option value="Courier New">
          </datalist>
          <div class="wg-drawer-btns" style="margin-top:6px;">
            <button data-act="fontBrowseLocal" title="Pick from fonts actually installed on your system (Chrome/Edge only)">Browse installed fonts&#8230;</button>
            <button data-act="fontClear" title="Clear override, use built-in default fonts">Use default</button>
          </div>
          <div class="wg-status" data-el="fontStatus"></div>
        </div>
        <div class="wg-srow">
          <div class="wg-rowline"><label style="margin:0;">Prompt text size</label><span data-el="editorFontOut">12.5px</span></div>
          <input type="range" class="wg-range" data-el="editorFontRange" min="10" max="28" step="0.5" value="12.5">
        </div>
        <div class="wg-srow">
          <div class="wg-rowline"><label style="margin:0;">Folder / sidebar text size</label><span data-el="uiFontOut">100%</span></div>
          <input type="range" class="wg-range" data-el="uiFontRange" min="80" max="200" step="5" value="100">
        </div>
        <div class="wg-srow">
          <label>Prompt text color <span style="opacity:.6;">(plain text, not wildcard tokens)</span></label>
          <input type="color" data-el="promptTextColor" value="#e8e2d4">
        </div>

        <h5>Interface theme</h5>
        <div class="wg-srow">
          <select class="wg-theme-select" data-el="uiThemeSelect"></select>
        </div>
        <div class="wg-swatch-grid" data-el="uiThemeSwatches"></div>
        <div class="wg-drawer-btns" style="margin-top:6px;">
          <button data-act="uiThemeNew" title="Duplicate the current theme as an editable copy">New</button>
          <button data-act="uiThemeRename" title="Rename the current custom theme">Rename</button>
          <button data-act="uiThemeDelete" title="Delete the current custom theme">Delete</button>
        </div>
        <div class="wg-drawer-btns" style="margin-top:4px;">
          <button data-act="uiThemeImport">Import JSON</button>
          <button data-act="uiThemeExport">Export JSON</button>
        </div>
        <div class="wg-status" data-el="uiThemeStatus"></div>

        <h5>Wildcard token colors</h5>
        <div class="wg-srow">
          <div class="wg-rowline"><label style="margin:0;">Hue rotation</label><span data-el="hueOut">0°</span></div>
          <input type="range" class="wg-range" data-el="hueRange" min="0" max="359" value="0">
        </div>
        <div class="wg-srow">
          <div class="wg-rowline"><label style="margin:0;">Color intensity</label><span data-el="satOut">65%</span></div>
          <input type="range" class="wg-range" data-el="satRange" min="30" max="90" step="5" value="65">
        </div>
        <h5>Category colors</h5>
        <div data-el="catPins"></div>
        <h5>Import / export token theme</h5>
        <div class="wg-theme-export"><textarea data-el="themeJson" readonly></textarea></div>
        <button class="wg-pill" data-act="copyTheme">Copy JSON</button>
        <button class="wg-pill" data-act="pasteTheme">Paste + apply</button>
        <button class="wg-pill" data-act="resetTheme">Reset</button>

        <h5>Inputs &amp; outputs</h5>
        <div style="font-size:9px; color:var(--wg-text-faint,#8a836f); line-height:1.5; margin-bottom:6px;">Turn on any socket you want to wire up \u2014 e.g. pipe in an LLM prompt-enhancer, a shared seed, or a separate negative prompt. Nothing here is required; the node works the same with everything off.</div>
        <div class="wg-rowline" style="margin:2px 0 4px;"><label style="margin:0; color:var(--wg-text-dim,#c9c2b1); font-size:9px; text-transform:uppercase; letter-spacing:.05em;">Optional inputs</label></div>
        <div data-el="ioInputToggles"></div>
        <div class="wg-rowline" style="margin:10px 0 4px;"><label style="margin:0; color:var(--wg-text-dim,#c9c2b1); font-size:9px; text-transform:uppercase; letter-spacing:.05em;">Optional outputs</label></div>
        <div data-el="ioOutputToggles"></div>

      </div>
    </div>
  `;

  const el = sel => root.querySelector(`[data-el="${sel}"]`);
  const textarea = el("textarea");
  const highlight = el("highlight");
  const legend = el("legend");
  const pickerDrawer = root.querySelector('[data-drawer="picker"]');
  const editDrawer = root.querySelector('[data-drawer="edit"]');
  const settingsPopup = el("settingsPopup");
  const editorReal = el("editorReal");
  const resolvedView = el("resolvedView");
  const seedInput = el("seedInput");
  const seedModeSelect = el("seedModeSelect");
  const processingModeSelect = el("processingModeSelect");

  // ---- pull seed / control-after-generate / processing_mode off the node body into this UI ----
  // All three are still real LiteGraph widgets underneath (so queueing/serialization
  // work exactly as before) — we just hide their canvas-drawn rows and mirror
  // their values into these DOM controls instead.
  const seedWidget = node.widgets.find(w => w.name === "seed");
  const controlWidget =
    (seedWidget && seedWidget.linkedWidgets && seedWidget.linkedWidgets[0]) ||
    node.widgets.find(w => w !== seedWidget && /control.*generate/i.test(w.name || ""));
  const modeWidget = node.widgets.find(w => w.name === "processing_mode");
  [seedWidget, controlWidget, modeWidget].forEach(w => {
    if (!w) return;
    w.type = "hidden";
    w.computeSize = () => [0, -4];
    // Belt-and-suspenders: on some LiteGraph/ComfyUI frontend builds, type
    // "hidden" isn't a recognized skip-case for canvas-drawn (non-DOM)
    // widgets like these — it just falls through to default rendering,
    // which is what caused the leftover "processing_mode" row bleeding
    // through behind the DOM UI. A no-op draw() is honored ahead of any
    // type switch in every LiteGraph version, so this guarantees nothing
    // paints for these three regardless of frontend version.
    w.draw = () => {};
    if (w.inputEl) w.inputEl.style.display = "none";
  });
  if (modeWidget) {
    processingModeSelect.addEventListener("change", () => {
      modeWidget.value = processingModeSelect.value;
      if (typeof modeWidget.callback === "function") modeWidget.callback(modeWidget.value, node.graph?.canvas, node);
      node.graph?.setDirtyCanvas(true, true);
      if (resolvedView.classList.contains("on")) refreshResolvedView();
    });
  } else {
    processingModeSelect.disabled = true;
  }

  const SEED_MODE_LABELS = {
    fixed: "Fixed \u2014 lock this prompt's seed",
    increment: "Increment \u2014 +1 each run",
    decrement: "Decrement \u2014 \u22121 each run",
    randomize: "Randomize \u2014 new seed each run",
  };
  function syncSeedControlsFromWidgets() {
    if (seedWidget) seedInput.value = seedWidget.value;
    if (controlWidget) {
      const values = (controlWidget.options && controlWidget.options.values) || ["fixed", "increment", "decrement", "randomize"];
      if (seedModeSelect.dataset.built !== "1") {
        seedModeSelect.innerHTML = values.map(v => `<option value="${escapeHtml(v)}">${escapeHtml(SEED_MODE_LABELS[v] || v)}</option>`).join("");
        seedModeSelect.dataset.built = "1";
      }
      seedModeSelect.value = controlWidget.value;
    } else {
      seedModeSelect.style.display = "none"; // no control widget found on this node/ComfyUI version — degrade gracefully
    }
    if (modeWidget) processingModeSelect.value = modeWidget.value;
  }
  if (seedWidget) {
    seedInput.addEventListener("input", () => {
      if (seedInput.value === "") return;
      seedWidget.value = Number(seedInput.value);
      if (typeof seedWidget.callback === "function") seedWidget.callback(seedWidget.value, node.graph?.canvas, node);
      node.graph?.setDirtyCanvas(true, true);
    });
  } else {
    el("seedbar").querySelectorAll("input,button,select").forEach(x => x.disabled = true);
  }
  if (controlWidget) {
    seedModeSelect.addEventListener("change", () => {
      controlWidget.value = seedModeSelect.value;
      if (typeof controlWidget.callback === "function") controlWidget.callback(controlWidget.value, node.graph?.canvas, node);
      node.graph?.setDirtyCanvas(true, true);
    });
  }
  root.querySelector('[data-act="seedRandomizeNow"]').addEventListener("click", () => {
    if (!seedWidget) return;
    const maxSeed = Number.MAX_SAFE_INTEGER; // native widget's real ceiling is 2^64-1, but JS numbers only carry 2^53-1 safely
    const randomSeed = Math.floor(Math.random() * maxSeed);
    seedWidget.value = randomSeed;
    seedInput.value = randomSeed;
    if (typeof seedWidget.callback === "function") seedWidget.callback(randomSeed, node.graph?.canvas, node);
    node.graph?.setDirtyCanvas(true, true);
  });
  syncSeedControlsFromWidgets();

  // ---- optional inputs/outputs: toggleable sockets for piping in other nodes ----
  // Every socket here is already declared (as optional) in the Python node's
  // INPUT_TYPES/RETURN_TYPES, so the backend always accepts them — what these
  // toggles control is purely whether the socket is *visible* on this node
  // instance, via LiteGraph's own addInput/removeInput/addOutput/removeOutput.
  // State is per-node (node.properties), not a global editor preference like
  // the theme/font settings, since which sockets you want wired up is a
  // per-node-instance choice.
  const IO_INPUT_DEFS = [
    { key: "prompt_prefix", type: "STRING", label: "Prompt prefix", desc: "Prepend externally-supplied text (resolved for wildcards too) before this node's own prompt \u2014 e.g. a shared style-preset text node." },
    { key: "prompt_suffix", type: "STRING", label: "Prompt suffix", desc: "Append externally-supplied text (resolved for wildcards too) after this node's own prompt." },
    { key: "enhancer_override", type: "STRING", label: "LLM / enhancer override", desc: "If connected and non-empty, this completely replaces the resolved prompt output \u2014 wire in an LLM prompt-enhancer node here." },
    { key: "external_seed", type: "INT", label: "External seed", desc: "Drive wildcard resolution from another node's seed instead of this node's own Seed control above." },
    { key: "negative_text", type: "STRING", label: "Negative prompt (text)", desc: "A second wildcard-aware text block, resolved independently and returned as its own negative_prompt output." },
  ];
  const IO_OUTPUT_DEFS = [
    { key: "negative_prompt", type: "STRING", label: "Negative prompt", desc: "Resolved text from the Negative prompt input above." },
    { key: "seed_out", type: "INT", label: "Seed used", desc: "The seed actually used to resolve this run \u2014 feed straight into a sampler's seed input." },
    { key: "wildcards_used", type: "STRING", label: "Wildcards used (JSON)", desc: "A JSON list of every wildcard file name that got picked this run, for logging/debugging." },
  ];

  node.properties = node.properties || {};
  node.properties.wg_io = node.properties.wg_io || { inputs: {}, outputs: {} };
  // Read via a live getter rather than caching the object: ComfyUI's node.configure()
  // (fired when a saved workflow loads) replaces node.properties wholesale *after*
  // onNodeCreated has already built this UI, so a cached reference would silently
  // go stale on reload. Always going through node.properties.wg_io picks up
  // whatever object is current, and self-heals if configure() ever hands back
  // something missing the inputs/outputs sub-keys.
  function ioState() {
    const s = node.properties.wg_io || (node.properties.wg_io = { inputs: {}, outputs: {} });
    s.inputs = s.inputs || {};
    s.outputs = s.outputs || {};
    return s;
  }

  function socketIndex(list, name) {
    return (list || []).findIndex(s => s.name === name);
  }
  function syncIoSocket(kind, def, enabled) {
    const list = kind === "input" ? node.inputs : node.outputs;
    const idx = socketIndex(list, def.key);
    if (enabled && idx === -1) {
      if (kind === "input") node.addInput(def.key, def.type);
      else node.addOutput(def.key, def.type);
    } else if (!enabled && idx !== -1) {
      if (kind === "input") node.removeInput(idx);
      else node.removeOutput(idx);
    }
    node.graph?.setDirtyCanvas(true, true);
  }
  function renderIoToggles() {
    const inWrap = el("ioInputToggles");
    const outWrap = el("ioOutputToggles");
    inWrap.innerHTML = "";
    IO_INPUT_DEFS.forEach(def => {
      const row = document.createElement("div");
      row.className = "wg-toggle-row";
      row.title = def.desc;
      row.innerHTML = `<label style="margin:0;">${escapeHtml(def.label)}</label><input type="checkbox" data-io-in="${def.key}">`;
      const cb = row.querySelector("input");
      cb.checked = !!ioState().inputs[def.key];
      cb.addEventListener("change", () => {
        ioState().inputs[def.key] = cb.checked;
        syncIoSocket("input", def, cb.checked);
      });
      inWrap.appendChild(row);
    });
    outWrap.innerHTML = "";
    IO_OUTPUT_DEFS.forEach(def => {
      const row = document.createElement("div");
      row.className = "wg-toggle-row";
      row.title = def.desc;
      row.innerHTML = `<label style="margin:0;">${escapeHtml(def.label)}</label><input type="checkbox" data-io-out="${def.key}">`;
      const cb = row.querySelector("input");
      cb.checked = !!ioState().outputs[def.key];
      cb.addEventListener("change", () => {
        ioState().outputs[def.key] = cb.checked;
        syncIoSocket("output", def, cb.checked);
      });
      outWrap.appendChild(row);
    });
  }
  renderIoToggles();
  // Backend declares all optional sockets, so LiteGraph auto-creates slots for
  // every one of them the moment the node is built. Strip anything the saved
  // toggle state says should be off (all of them, on a brand-new node) so the
  // node starts clean with just the always-on "prompt" output.
  IO_INPUT_DEFS.forEach(def => syncIoSocket("input", def, !!ioState().inputs[def.key]));
  IO_OUTPUT_DEFS.forEach(def => syncIoSocket("output", def, !!ioState().outputs[def.key]));

  // Re-render the toggle checkboxes and re-sync sockets against whatever
  // node.properties.wg_io turns out to be after ComfyUI restores a saved
  // workflow (see the ioState() comment above) — otherwise the checkboxes
  // would show everything unchecked even though the sockets themselves
  // (serialized separately as node.inputs/outputs) came back correctly.
  node._wgRefreshIoToggles = function () {
    renderIoToggles();
    IO_INPUT_DEFS.forEach(def => syncIoSocket("input", def, !!ioState().inputs[def.key]));
    IO_OUTPUT_DEFS.forEach(def => syncIoSocket("output", def, !!ioState().outputs[def.key]));
  };

  let hoverTip = document.querySelector(".wg-tip");
  if (!hoverTip) {
    hoverTip = document.createElement("div");
    hoverTip.className = "wg-tip";
    document.body.appendChild(hoverTip);
  }

  function buildCategoryColorMap(categoriesInUse) {
    const hues = {};
    categoriesInUse.forEach(cat => { hues[cat] = theme.categoryPins[cat] ? null : (hashStr(cat) % 360 + theme.hueRotate) % 360; });
    const entries = Object.entries(hues).filter(([, v]) => v !== null);
    entries.sort((a, b) => a[1] - b[1]);
    for (let i = 1; i < entries.length; i++) {
      if (entries[i][1] - entries[i - 1][1] < 20) entries[i][1] = entries[i - 1][1] + 20;
    }
    entries.forEach(([cat, hue]) => { hues[cat] = hue % 360; });
    return hues;
  }
  function colorForToken(name, categoryHueMap) {
    const cat = categoryOf(name);
    if (theme.categoryPins[cat]) return theme.categoryPins[cat];
    const hue = categoryHueMap[cat] !== undefined ? categoryHueMap[cat] : (hashStr(cat) % 360 + theme.hueRotate) % 360;
    const leaf = name.split("/").pop();
    const shadeShift = (hashStr(leaf) % 20) - 10;
    return `hsl(${hue}, ${theme.saturation}%, ${Math.min(78, Math.max(52, 66 + shadeShift))}%)`;
  }
  function isKnown(name) {
    return knownSet.has(name) || Array.from(knownSet).some(n => n.split("/").pop() === name.split("/").pop());
  }
  function extractWildcardNames(text) {
    const names = new Set(); const re = /__[+*]?([A-Za-z0-9_\-\/]+)__/g; let m;
    while ((m = re.exec(text))) names.add(m[1]);
    return Array.from(names);
  }
  function highlightText(text) {
    const names = extractWildcardNames(text);
    const categoriesInUse = Array.from(new Set(names.map(categoryOf)));
    const categoryHueMap = buildCategoryColorMap(categoriesInUse);
    let out = ""; let i = 0; const ranges = [];
    while (i < text.length) {
      const rest = text.slice(i);
      const wildcardMatch = rest.match(/^__[+*]?[A-Za-z0-9_\-\/]+__/);
      if (wildcardMatch) {
        const token = wildcardMatch[0];
        const innerName = token.replace(/^__[+*]?/, "").replace(/__$/, "");
        const start = i, end = i + token.length;
        if (isKnown(innerName)) {
          const color = colorForToken(innerName, categoryHueMap);
          out += `<span class="wg-token" style="color:${color}; font-weight:600;">${escapeHtml(token)}</span>`;
          ranges.push({ start, end, name: innerName, known: true });
        } else {
          out += `<span class="wg-tok-error">${escapeHtml(token)}</span>`;
          ranges.push({ start, end, name: innerName, known: false });
        }
        i = end; continue;
      }
      const weightMatch = rest.match(/^\d+::/);
      if (weightMatch) { out += `<span class="wg-tok-weight">${escapeHtml(weightMatch[0])}</span>`; i += weightMatch[0].length; continue; }
      const quantMatch = rest.match(/^(\d+(-\d+)?\$\$[^$]*\$\$|\d+#)/);
      if (quantMatch) { out += `<span class="wg-tok-mod">${escapeHtml(quantMatch[0])}</span>`; i += quantMatch[0].length; continue; }
      const ch = text[i];
      if (ch === "{" || ch === "}") { out += `<span class="wg-tok-bracket">${ch}</span>`; i++; continue; }
      if (ch === "|") { out += `<span class="wg-tok-pipe">|</span>`; i++; continue; }
      if (ch === "#" && (i === 0 || text[i - 1] === "\n")) {
        const lineEnd = text.indexOf("\n", i);
        const line = lineEnd === -1 ? text.slice(i) : text.slice(i, lineEnd);
        out += `<span class="wg-tok-comment">${escapeHtml(line)}</span>`; i += line.length; continue;
      }
      out += escapeHtml(ch); i++;
    }
    tokenRanges = ranges;
    return { html: out, names, categoriesInUse, categoryHueMap };
  }

  function syncHiddenWidget() {
    hiddenWidget.value = textarea.value;
    if (typeof hiddenWidget.callback === "function") hiddenWidget.callback(hiddenWidget.value);
    // Belt-and-suspenders: some ComfyUI frontend versions mis-align widgets_values
    // (a positional array) when a DOM widget sits alongside a hidden text widget,
    // which silently wipes hiddenWidget.value on tab switch / workflow reload.
    // node.properties is serialized as a plain keyed object and isn't subject to
    // that indexing issue, so mirror the text there as a reliable fallback.
    node.properties = node.properties || {};
    node.properties.wg_text = textarea.value;
    node.graph?.setDirtyCanvas(true, true);
  }

  function refreshFromHidden() {
    // Re-hydrate the visible textarea after ComfyUI reconfigures this node
    // (workflow tab switch, undo/redo, page reload). Prefer node.properties
    // since it's the more reliable store; fall back to the widget value.
    const restored =
      (node.properties && typeof node.properties.wg_text === "string" && node.properties.wg_text) ||
      hiddenWidget.value ||
      "";
    if (restored !== textarea.value) {
      textarea.value = restored;
      render();
    }
    syncSeedControlsFromWidgets();
  }

  function render() {
    const { html, names, categoriesInUse, categoryHueMap } = highlightText(textarea.value);
    highlight.innerHTML = html + "\n";
    legend.innerHTML = "";
    categoriesInUse.forEach(cat => {
      const color = theme.categoryPins[cat] || `hsl(${categoryHueMap[cat]}, ${theme.saturation}%, 66%)`;
      const shape = "border-radius:50%;";
      const chip = document.createElement("div");
      chip.className = "wg-chip";
      chip.innerHTML = `<span class="wg-sw" style="background:${color}; ${shape}"></span>${escapeHtml(cat)}`;
      legend.appendChild(chip);
    });
    const knownCount = names.filter(isKnown).length;
    el("hintRight").textContent = `${knownCount} resolved-ready \u00b7 ${names.length - knownCount} missing`;
    syncHiddenWidget();
    if (resolvedView.classList.contains("on")) refreshResolvedView();
    updateThemeJson();
  }

  async function refreshResolvedView() {
    const seed = seedWidget ? seedWidget.value : 0;
    const mode = modeWidget ? modeWidget.value : "entire text as one";
    resolvedView.textContent = "resolving...";
    try {
      const resolved = await API.resolve(textarea.value, seed, mode);
      resolvedView.textContent = resolved;
    } catch (e) {
      resolvedView.textContent = "(failed to resolve — is ComfyUI running with this node's server routes loaded?)";
    }
  }

  textarea.addEventListener("input", render);
  textarea.addEventListener("scroll", () => { highlight.scrollTop = textarea.scrollTop; highlight.scrollLeft = textarea.scrollLeft; });

  // ---- hover preview (approximate monospace hit-test) ----
  function charIndexFromEvent(e) {
    const cs = getComputedStyle(textarea);
    const lineH = parseFloat(cs.lineHeight) || 20;
    const padT = parseFloat(cs.paddingTop) || 8;
    const padL = parseFloat(cs.paddingLeft) || 10;
    const charW = 7.4;
    const rect = textarea.getBoundingClientRect();
    const x = e.clientX - rect.left + textarea.scrollLeft - padL;
    const y = e.clientY - rect.top + textarea.scrollTop - padT;
    const row = Math.max(0, Math.floor(y / lineH));
    const col = Math.max(0, Math.round(x / charW));
    const lines = textarea.value.split("\n");
    if (row >= lines.length) return -1;
    let idx = 0;
    for (let i = 0; i < row; i++) idx += lines[i].length + 1;
    return idx + Math.min(col, lines[row].length);
  }
  async function showTipForName(x, y, name, known) {
    let entry = previewCache.get(name);
    if (!entry) {
      entry = await API.preview(name);
      previewCache.set(name, entry);
    }
    const lines = (entry.lines || []).slice(0, 4);
    hoverTip.innerHTML = `<div class="wg-tip-title">${escapeHtml(known ? name : name + " (not found)")}</div>` +
      (lines.length ? lines.map(l => `<div class="wg-tip-line">${escapeHtml(l)}</div>`).join("") :
        `<div class="wg-tip-line">${known ? "no preview available" : "file missing"}</div>`);
    hoverTip.style.left = (x + 14) + "px";
    hoverTip.style.top = (y + 14) + "px";
    hoverTip.style.display = "block";
  }
  function hideTip() { hoverTip.style.display = "none"; }
  let hoverDebounce = null;
  textarea.addEventListener("mousemove", (e) => {
    const idx = charIndexFromEvent(e);
    const tok = tokenRanges.find(t => idx >= t.start && idx < t.end);
    clearTimeout(hoverDebounce);
    if (tok) {
      hoverDebounce = setTimeout(() => showTipForName(e.clientX, e.clientY, tok.name, tok.known), 120);
    } else hideTip();
  });
  textarea.addEventListener("mouseleave", hideTip);

  // ---- picker drawer ----
  const searchInput = el("search");
  const pickerList = el("pickerList");

  function insertWildcard(path) {
    const tag = `__${path}__`;
    const pos = textarea.selectionStart ?? textarea.value.length;
    textarea.value = textarea.value.slice(0, pos) + tag + textarea.value.slice(pos);
    textarea.focus();
    textarea.selectionStart = textarea.selectionEnd = pos + tag.length;
    recentList = [path, ...recentList.filter(p => p !== path)].slice(0, 8);
    render();
    renderPickerList(searchInput.value);
  }

  function pickerRow(item) {
    const cat = categoryOf(item.path);
    const color = theme.categoryPins[cat] || `hsl(${(hashStr(cat) % 360 + theme.hueRotate) % 360}, ${theme.saturation}%, 66%)`;
    const shape = "border-radius:50%;";
    const isPinned = pinned.has(item.path);
    const row = document.createElement("div");
    row.className = "wg-item";
    row.innerHTML = `<span class="wg-sw" style="background:${color}; ${shape}"></span><span class="wg-name">${escapeHtml(item.path.split("/").pop())}</span><span class="wg-badge">${item.type}</span><span class="wg-pin ${isPinned ? "pinned" : ""}">${isPinned ? "\u2605" : "\u2606"}</span>`;
    row.querySelector(".wg-name").addEventListener("click", () => insertWildcard(item.path));
    row.querySelector(".wg-sw").addEventListener("click", () => insertWildcard(item.path));
    row.querySelector(".wg-pin").addEventListener("click", (e) => {
      e.stopPropagation();
      if (pinned.has(item.path)) pinned.delete(item.path); else pinned.add(item.path);
      savePinned(pinned);
      renderPickerList(searchInput.value);
    });
    row.addEventListener("mouseenter", (e) => showTipForName(e.clientX, e.clientY, item.path, true));
    row.addEventListener("mousemove", (e) => { hoverTip.style.left = (e.clientX + 14) + "px"; hoverTip.style.top = (e.clientY + 14) + "px"; });
    row.addEventListener("mouseleave", hideTip);
    return row;
  }

  async function renderPickerList(filter = "") {
    pickerList.innerHTML = `<div class="wg-hint" style="padding:6px;">loading...</div>`;
    const items = filter ? await API.search(filter) : libraryCache;
    pickerList.innerHTML = "";
    if (!filter) {
      const pinnedItems = libraryCache.filter(l => pinned.has(l.path));
      if (pinnedItems.length) {
        const lbl = document.createElement("div"); lbl.className = "wg-section-label"; lbl.textContent = "Pinned";
        pickerList.appendChild(lbl);
        pinnedItems.forEach(item => pickerList.appendChild(pickerRow(item)));
      }
      const recentItems = recentList.filter(p => !pinned.has(p)).map(p => libraryCache.find(l => l.path === p)).filter(Boolean);
      if (recentItems.length) {
        const lbl = document.createElement("div"); lbl.className = "wg-section-label"; lbl.textContent = "Recent";
        pickerList.appendChild(lbl);
        recentItems.forEach(item => pickerList.appendChild(pickerRow(item)));
      }
    }
    const grouped = {};
    items.forEach(l => { const cat = categoryOf(l.path); (grouped[cat] = grouped[cat] || []).push(l); });

    // Reordering is only meaningful in the idle browse view — while filtering,
    // categories come and go with the search term, so we just sort matches
    // alphabetically and leave the persisted order untouched.
    const canReorder = !filter;
    let catNames;
    if (canReorder) {
      const present = Object.keys(grouped);
      const known = catOrder.filter(c => present.includes(c));
      const unseen = present.filter(c => !catOrder.includes(c)).sort();
      catNames = [...known, ...unseen];
      if (unseen.length) {
        catOrder = catNames.slice();
        saveCatOrder(catOrder);
      }
    } else {
      catNames = Object.keys(grouped).sort();
    }

    let dragCat = null;
    catNames.forEach(cat => {
      // While actively filtering/searching, always show matches regardless
      // of collapsed state — collapsing only applies to the idle browse view.
      const isExpanded = !!filter || expandedCats.has(cat);
      const header = document.createElement("div");
      header.className = "wg-folder" + (isExpanded ? " expanded" : "");
      header.innerHTML = `<span class="wg-folder-caret">${isExpanded ? "\u25BE" : "\u25B8"}</span><span class="wg-folder-name">${escapeHtml(cat)}</span><span class="wg-folder-count">${grouped[cat].length}</span>`;
      header.title = isExpanded ? "Click to collapse" : "Click to expand";
      header.addEventListener("click", () => {
        if (expandedCats.has(cat)) expandedCats.delete(cat); else expandedCats.add(cat);
        saveExpandedCats(expandedCats);
        renderPickerList(searchInput.value);
      });

      // ---- drag-to-reorder (idle browse view only) ----
      if (canReorder) {
        header.classList.add("wg-draggable");
        header.draggable = true;
        header.addEventListener("dragstart", (e) => {
          dragCat = cat;
          header.classList.add("dragging");
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", cat);
        });
        header.addEventListener("dragend", () => {
          dragCat = null;
          header.classList.remove("dragging");
        });
        header.addEventListener("dragover", (e) => {
          if (!dragCat || dragCat === cat) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          header.classList.add("drag-over");
        });
        header.addEventListener("dragleave", () => header.classList.remove("drag-over"));
        header.addEventListener("drop", (e) => {
          e.preventDefault();
          header.classList.remove("drag-over");
          const dragged = dragCat || e.dataTransfer.getData("text/plain");
          if (!dragged || dragged === cat) return;
          const from = catOrder.indexOf(dragged);
          const to = catOrder.indexOf(cat);
          if (from === -1 || to === -1) return;
          catOrder.splice(from, 1);
          catOrder.splice(to, 0, dragged);
          saveCatOrder(catOrder);
          renderPickerList(searchInput.value);
        });
      }

      pickerList.appendChild(header);
      if (isExpanded) grouped[cat].forEach(item => pickerList.appendChild(pickerRow(item)));
    });
    if (!items.length) pickerList.innerHTML = `<div class="wg-hint" style="padding:6px;">no matches</div>`;
  }

  let searchDebounce = null;
  searchInput.addEventListener("input", () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => renderPickerList(searchInput.value), 150);
  });

  async function refreshLibrary() {
    libraryCache = await API.list();
    knownSet = new Set(libraryCache.map(l => l.path));
    render();
  }

  // ---- edit drawer ----
  const editName = el("editName");
  const editContent = el("editContent");
  const editStatus = el("editStatus");

  async function loadIntoEditDrawer(name) {
    editName.value = name;
    const data = await API.content(name);
    if (data && data.found) {
      editContent.value = data.content;
      editContent.disabled = !data.editable;
      editStatus.textContent = data.editable ? "" : "yaml-backed wildcards are edited in their source file.";
      editStatus.className = "wg-status";
    } else {
      editContent.value = "";
      editContent.disabled = false;
      editStatus.textContent = "new wildcard \u2014 write one option per line, then save.";
      editStatus.className = "wg-status";
    }
  }

  root.querySelector('[data-act="save"]').addEventListener("click", async () => {
    const name = editName.value.trim();
    if (!name) { editStatus.textContent = "enter a name/path first"; editStatus.className = "wg-status err"; return; }
    const res = await API.save(name, editContent.value);
    if (res.ok) {
      editStatus.textContent = "saved.";
      editStatus.className = "wg-status";
      previewCache.delete(name);
      await refreshLibrary();
      renderPickerList(searchInput.value);
    } else {
      editStatus.textContent = res.error || "save failed";
      editStatus.className = "wg-status err";
    }
  });
  root.querySelector('[data-act="delete"]').addEventListener("click", async () => {
    const name = editName.value.trim();
    if (!name) return;
    const res = await API.del(name);
    if (res.ok) {
      editStatus.textContent = "deleted.";
      editStatus.className = "wg-status";
      previewCache.delete(name);
      editContent.value = "";
      await refreshLibrary();
      renderPickerList(searchInput.value);
    } else {
      editStatus.textContent = res.error || "delete failed";
      editStatus.className = "wg-status err";
    }
  });

  // ---- toolbar actions ----
  root.querySelector('[data-act="picker"]').addEventListener("click", (e) => {
    pickerDrawer.classList.toggle("open");
    e.currentTarget.classList.toggle("active");
    if (pickerDrawer.classList.contains("open")) renderPickerList(searchInput.value);
  });
  root.querySelector('[data-act="edit"]').addEventListener("click", (e) => {
    editDrawer.classList.toggle("open");
    e.currentTarget.classList.toggle("active");
  });
  // Explicit close button inside the edit drawer itself — same effect as
  // clicking the pencil icon in the toolbar, just discoverable from inside
  // the panel so users aren't left hunting for how to dismiss it.
  root.querySelector('[data-act="closeEditDrawer"]').addEventListener("click", () => {
    editDrawer.classList.remove("open");
    root.querySelector('[data-act="edit"]').classList.remove("active");
  });
  root.querySelector('[data-act="resolve"]').addEventListener("click", async (e) => {
    const on = resolvedView.classList.toggle("on");
    editorReal.classList.toggle("hidden", on);
    e.currentTarget.classList.toggle("on", on);
    e.currentTarget.textContent = on ? "Back to editing" : "Show resolved";
    if (on) await refreshResolvedView();
  });

  // ---- copy / clear / hot-refresh ----
  const copyBtn = root.querySelector('[data-act="copy"]');
  copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(textarea.value);
      const prevHtml = copyBtn.innerHTML;
      copyBtn.innerHTML = "&#10003;"; // checkmark
      copyBtn.classList.add("active");
      setTimeout(() => { copyBtn.innerHTML = prevHtml; copyBtn.classList.remove("active"); }, 1100);
    } catch (e) {
      copyBtn.title = "Copy failed \u2014 clipboard permission denied";
    }
  });

  root.querySelector('[data-act="clear"]').addEventListener("click", () => {
    if (!textarea.value) return;
    if (!confirm("Clear the entire prompt? This can't be undone.")) return;
    textarea.value = "";
    // Manually dispatch 'input' so the existing textarea listener (which drives
    // render()/syncHiddenWidget()) fires and the canvas serialization loop
    // picks up the change, exactly as if the user had deleted the text by hand.
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.focus();
  });

  const refreshBtn = root.querySelector('[data-act="refresh"]');
  refreshBtn.addEventListener("click", async () => {
    refreshBtn.classList.add("active");
    refreshBtn.disabled = true;
    try {
      const data = await API.refreshWildcards();
      node.updateWildcardSidePanels(data);
    } catch (e) {
      console.error("[prompt-palette] wildcard refresh failed:", e);
      refreshBtn.title = "Refresh failed \u2014 see console";
    } finally {
      refreshBtn.classList.remove("active");
      refreshBtn.disabled = false;
    }
  });

  // Hot-reloads the picker drawer / legend / known-wildcard set from a fresh
  // backend directory scan without requiring a full browser refresh. Exposed
  // on the node instance (not just closed over here) so other call sites —
  // e.g. a future "watch filesystem" feature — can trigger the same repaint.
  node.updateWildcardSidePanels = function (data) {
    const items = (data && data.items) || [];
    libraryCache = items;
    knownSet = new Set(items.map(i => i.path));
    renderPickerList(searchInput.value);
    renderCatPins();
    render(); // re-highlight the editor text against the refreshed known-wildcard set
  };

  // double-click a token in the editor to jump straight to editing it
  textarea.addEventListener("dblclick", (e) => {
    const idx = charIndexFromEvent(e);
    const tok = tokenRanges.find(t => idx >= t.start && idx < t.end);
    if (tok) {
      editDrawer.classList.add("open");
      root.querySelector('[data-act="edit"]').classList.add("active");
      loadIntoEditDrawer(tok.name);
    }
  });

  // ---- settings popup (with a real close button + outside click + escape) ----
  const settingsBtn = root.querySelector('[data-act="settings"]');
  function openSettings() { settingsPopup.classList.add("open"); }
  function closeSettings() { settingsPopup.classList.remove("open"); }
  settingsBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    settingsPopup.classList.toggle("open");
  });
  root.querySelector('[data-act="closeSettings"]').addEventListener("click", closeSettings);
  
  // Named functions for memory cleanup
  const handleOutsideClick = (e) => {
    if (settingsPopup.classList.contains("open") && !settingsPopup.contains(e.target) && e.target !== settingsBtn) {
      closeSettings();
    }
  };
  const handleEscapeKey = (e) => {
    if (e.key === "Escape") closeSettings();
  };
  
  document.addEventListener("click", handleOutsideClick);
  document.addEventListener("keydown", handleEscapeKey);
  settingsPopup.addEventListener("click", (e) => e.stopPropagation());

  // ---- accessibility: font family / sizes / prompt text color ----
  // Applied to document.documentElement (same pattern as the interface theme
  // below) so it's a single global legibility preference shared by every
  // Prompt Palette node on the canvas, rather than something you'd have to
  // re-tune per node.
  const fontFamilyInput = el("fontFamilyInput");
  const fontStatus = el("fontStatus");
  const editorFontRange = el("editorFontRange"), editorFontOut = el("editorFontOut");
  const uiFontRange = el("uiFontRange"), uiFontOut = el("uiFontOut");
  const promptTextColorInput = el("promptTextColor");

  function setFontStatus(msg, isErr) {
    fontStatus.textContent = msg || "";
    fontStatus.className = "wg-status" + (isErr ? " err" : "");
  }

  function applyFontSettings() {
    const r = document.documentElement.style;
    if (theme.fontFamily && theme.fontFamily.trim()) {
      r.setProperty("--wg-font-family", `"${theme.fontFamily.trim()}"`);
    } else {
      r.removeProperty("--wg-font-family");
    }
    r.setProperty("--wg-editor-font-size", `${theme.editorFontSize}px`);
    r.setProperty("--wg-ui-font-scale", theme.uiFontScale);
    r.setProperty("--wg-prompt-text", theme.promptTextColor);
  }

  function refreshFontControlsUI() {
    fontFamilyInput.value = theme.fontFamily || "";
    editorFontRange.value = theme.editorFontSize;
    editorFontOut.textContent = `${theme.editorFontSize}px`;
    uiFontRange.value = Math.round(theme.uiFontScale * 100);
    uiFontOut.textContent = `${Math.round(theme.uiFontScale * 100)}%`;
    promptTextColorInput.value = theme.promptTextColor;
  }
  refreshFontControlsUI();

  fontFamilyInput.addEventListener("input", () => {
    theme.fontFamily = fontFamilyInput.value;
    saveTheme(theme); applyFontSettings(); updateThemeJson();
  });
  editorFontRange.addEventListener("input", () => {
    theme.editorFontSize = parseFloat(editorFontRange.value);
    editorFontOut.textContent = `${theme.editorFontSize}px`;
    saveTheme(theme); applyFontSettings(); updateThemeJson();
  });
  uiFontRange.addEventListener("input", () => {
    theme.uiFontScale = parseInt(uiFontRange.value, 10) / 100;
    uiFontOut.textContent = `${uiFontRange.value}%`;
    saveTheme(theme); applyFontSettings(); updateThemeJson();
  });
  promptTextColorInput.addEventListener("input", () => {
    theme.promptTextColor = promptTextColorInput.value;
    saveTheme(theme); applyFontSettings(); updateThemeJson();
  });
  root.querySelector('[data-act="fontClear"]').addEventListener("click", () => {
    theme.fontFamily = "";
    fontFamilyInput.value = "";
    saveTheme(theme); applyFontSettings(); updateThemeJson();
    setFontStatus("using default fonts");
  });
  root.querySelector('[data-act="fontBrowseLocal"]').addEventListener("click", async () => {
    // Local Font Access API: Chrome/Edge 103+ only, requires a user gesture and a
    // one-time permission grant. Lets the page read the *names* of fonts actually
    // installed on the user's system (not the font files) so the family typed
    // into the input above is guaranteed to exist, instead of guessing.
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
        saveTheme(theme); applyFontSettings(); updateThemeJson();
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

  hueRange.addEventListener("input", () => { theme.hueRotate = parseInt(hueRange.value, 10); hueOut.textContent = theme.hueRotate + "\u00b0"; saveTheme(theme); render(); });
  satRange.addEventListener("input", () => { theme.saturation = parseInt(satRange.value, 10); satOut.textContent = theme.saturation + "%"; saveTheme(theme); render(); });

  function renderCatPins() {
    const wrap = el("catPins");
    const categories = Array.from(new Set(libraryCache.map(l => categoryOf(l.path)))).sort();
    wrap.innerHTML = "";
    categories.forEach(cat => {
      const row = document.createElement("div"); row.className = "wg-catpin-row";
      const current = theme.categoryPins[cat] || hslToHex((hashStr(cat) % 360 + theme.hueRotate) % 360, theme.saturation, 66);
      row.innerHTML = `<span>${escapeHtml(cat)}</span><input type="color" value="${current}">`;
      row.querySelector("input").addEventListener("input", (e) => { theme.categoryPins[cat] = e.target.value; saveTheme(theme); render(); });
      wrap.appendChild(row);
    });
  }
  function updateThemeJson() {
    el("themeJson").value = JSON.stringify(theme, null, 2);
  }
  root.querySelector('[data-act="copyTheme"]').addEventListener("click", async (e) => {
    await navigator.clipboard.writeText(el("themeJson").value).catch(() => {});
    e.target.textContent = "Copied"; setTimeout(() => e.target.textContent = "Copy JSON", 1200);
  });
  root.querySelector('[data-act="pasteTheme"]').addEventListener("click", async () => {
    try {
      const text = await navigator.clipboard.readText();
      const parsed = JSON.parse(text);
      Object.assign(theme, { ...defaultTheme(), ...parsed });
      hueRange.value = theme.hueRotate || 0; hueOut.textContent = (theme.hueRotate || 0) + "\u00b0";
      satRange.value = theme.saturation || 65; satOut.textContent = (theme.saturation || 65) + "%";
      refreshFontControlsUI();
      saveTheme(theme); applyFontSettings(); render();
    } catch (e) { alert("clipboard doesn't contain valid theme JSON"); }
  });
  root.querySelector('[data-act="resetTheme"]').addEventListener("click", () => {
    Object.assign(theme, defaultTheme());
    hueRange.value = 0; hueOut.textContent = "0\u00b0";
    satRange.value = 65; satOut.textContent = "65%";
    refreshFontControlsUI();
    saveTheme(theme); applyFontSettings(); render();
  });

  // ---- interface theme (UI chrome, not the token/text colors above) ----
  const uiThemeSelect = el("uiThemeSelect");
  const uiThemeSwatches = el("uiThemeSwatches");
  const uiThemeStatus = el("uiThemeStatus");

  let customUiThemes = loadUiThemes();
  let activeUiThemeName = loadActiveUiThemeName();

  function allUiThemes() { return { ...BUILTIN_UI_THEMES, ...customUiThemes }; }
  function isBuiltinUiTheme(name) { return !!BUILTIN_UI_THEMES[name] && !customUiThemes[name]; }
  if (!allUiThemes()[activeUiThemeName]) activeUiThemeName = "Amber";

  // Themes apply as CSS custom properties on the document root (not just
  // this node) so the shared hover-tip element — which lives outside
  // .wg-node in the DOM — picks them up too, and so every wildcard editor
  // node on the canvas stays in sync, matching how the token theme already
  // behaves as a single global setting.
  function applyUiTheme() {
    const t = allUiThemes()[activeUiThemeName] || BUILTIN_UI_THEMES.Amber;
    UI_THEME_KEYS.forEach(([key]) => {
      document.documentElement.style.setProperty(`--wg-${key}`, t[key]);
    });
    // Also recolor the underlying LiteGraph node itself (title bar + body),
    // not just the DOM widget's own CSS — otherwise a strip of the default
    // grey node canvas shows around/behind the UI, especially on light
    // themes like Daylight/High Contrast. Every node instance re-applies
    // this on its own theme-change listener, so all of them stay in sync
    // with the single shared theme, same as everything else here.
    node.bgcolor = t.bg;
    node.color = t.accent;
    node.graph?.setDirtyCanvas(true, true);
  }
  function setUiThemeStatus(msg, isErr) {
    uiThemeStatus.textContent = msg || "";
    uiThemeStatus.className = "wg-status" + (isErr ? " err" : "");
  }
  function renderUiThemeSelect() {
    const themes = allUiThemes();
    uiThemeSelect.innerHTML = Object.keys(themes).sort().map(name =>
      `<option value="${escapeHtml(name)}" ${name === activeUiThemeName ? "selected" : ""}>${escapeHtml(name)}${isBuiltinUiTheme(name) ? "" : " (custom)"}</option>`
    ).join("");
  }
  function renderUiThemeSwatches() {
    const t = allUiThemes()[activeUiThemeName] || BUILTIN_UI_THEMES.Amber;
    const locked = isBuiltinUiTheme(activeUiThemeName);
    uiThemeSwatches.innerHTML = "";
    UI_THEME_KEYS.forEach(([key, label]) => {
      const item = document.createElement("div");
      item.className = "wg-swatch-item";
      // Built via DOM APIs rather than innerHTML string interpolation, since
      // t[key] can originate from an imported theme JSON (clipboard-pasted,
      // untrusted). Assigning .value as a property (not concatenating into
      // an HTML attribute string) means it's always treated as plain text,
      // never parsed as markup, no matter what it contains.
      const swatchLabel = document.createElement("span");
      swatchLabel.textContent = label;
      const input = document.createElement("input");
      input.type = "color";
      input.value = sanitizeHexColor(t[key]);
      input.disabled = locked;
      item.appendChild(swatchLabel);
      item.appendChild(input);
      input.addEventListener("input", (e) => {
        if (locked) return;
        customUiThemes[activeUiThemeName][key] = e.target.value;
        saveUiThemes(customUiThemes);
        applyUiTheme();
      });
      uiThemeSwatches.appendChild(item);
    });
    setUiThemeStatus(locked ? "built-in theme \u2014 hit \u201cNew\u201d to make an editable copy" : "");
  }
  function refreshUiThemeUI() { renderUiThemeSelect(); renderUiThemeSwatches(); }

  uiThemeSelect.addEventListener("change", () => {
    activeUiThemeName = uiThemeSelect.value;
    saveActiveUiThemeName(activeUiThemeName);
    applyUiTheme();
    renderUiThemeSwatches();
  });

  root.querySelector('[data-act="uiThemeNew"]').addEventListener("click", () => {
    const base = allUiThemes()[activeUiThemeName] || BUILTIN_UI_THEMES.Amber;
    let name = prompt("Name for the new theme:", `${activeUiThemeName} copy`);
    if (!name) return;
    name = name.trim();
    if (!name) return;
    customUiThemes[name] = { ...base };
    saveUiThemes(customUiThemes);
    activeUiThemeName = name;
    saveActiveUiThemeName(name);
    applyUiTheme();
    refreshUiThemeUI();
  });
  root.querySelector('[data-act="uiThemeRename"]').addEventListener("click", () => {
    if (isBuiltinUiTheme(activeUiThemeName)) return setUiThemeStatus("built-in themes can't be renamed", true);
    let name = prompt("Rename theme:", activeUiThemeName);
    if (!name) return;
    name = name.trim();
    if (!name || name === activeUiThemeName) return;
    if (allUiThemes()[name]) return setUiThemeStatus("a theme with that name already exists", true);
    customUiThemes[name] = customUiThemes[activeUiThemeName];
    delete customUiThemes[activeUiThemeName];
    saveUiThemes(customUiThemes);
    activeUiThemeName = name;
    saveActiveUiThemeName(name);
    refreshUiThemeUI();
  });
  root.querySelector('[data-act="uiThemeDelete"]').addEventListener("click", () => {
    if (isBuiltinUiTheme(activeUiThemeName)) return setUiThemeStatus("built-in themes can't be deleted", true);
    delete customUiThemes[activeUiThemeName];
    saveUiThemes(customUiThemes);
    activeUiThemeName = "Amber";
    saveActiveUiThemeName(activeUiThemeName);
    applyUiTheme();
    refreshUiThemeUI();
  });
  root.querySelector('[data-act="uiThemeImport"]').addEventListener("click", async () => {
    try {
      const text = await navigator.clipboard.readText();
      const parsed = JSON.parse(text);
      const source = parsed.colors || parsed;
      const name = (parsed.name && String(parsed.name).trim()) || `Imported ${Object.keys(customUiThemes).length + 1}`;
      const colors = {};
      UI_THEME_KEYS.forEach(([key]) => {
        colors[key] = sanitizeHexColor(source[key], BUILTIN_UI_THEMES.Amber[key]);
      });
      customUiThemes[name] = colors;
      saveUiThemes(customUiThemes);
      activeUiThemeName = name;
      saveActiveUiThemeName(name);
      applyUiTheme();
      refreshUiThemeUI();
      setUiThemeStatus(`imported "${name}"`);
    } catch (e) {
      setUiThemeStatus("clipboard doesn't contain a valid theme JSON", true);
    }
  });
  root.querySelector('[data-act="uiThemeExport"]').addEventListener("click", async () => {
    const t = allUiThemes()[activeUiThemeName] || BUILTIN_UI_THEMES.Amber;
    const payload = { name: activeUiThemeName, ...t };
    await navigator.clipboard.writeText(JSON.stringify(payload, null, 2)).catch(() => {});
    setUiThemeStatus("copied theme JSON to clipboard \u2014 share the file to let others import it");
  });

  applyUiTheme();
  refreshUiThemeUI();
  applyFontSettings();

  // initial load
  textarea.value = (node.properties && node.properties.wg_text) || hiddenWidget.value || "";
  refreshLibrary().then(() => renderCatPins());
  render();

  // Wrap the actual UI in a padded, click-through frame before handing it to
  // addDOMWidget. The frame (not `root`) is what gets sized to the node, so
  // its padding ring is genuine gap around the whole widget — not covered
  // by any element — leaving the node's resize corner and ComfyUI's own
  // right-click context menu reachable at the edges instead of getting
  // swallowed by this DOM widget.
  const frame = document.createElement("div");
  frame.className = "wg-node-frame";
  frame.appendChild(root);

  return { 
    root: frame, 
    refreshFromHidden,
    cleanup: () => {
      document.removeEventListener("click", handleOutsideClick);
      document.removeEventListener("keydown", handleEscapeKey);
    }
  };
}

app.registerExtension({
  name: "comfyui.promptpalette.editor",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "PromptPaletteEditor") return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;

      const hiddenWidget = this.widgets.find(w => w.name === "text");
      if (!hiddenWidget) return r;

      hiddenWidget.type = "hidden";
      hiddenWidget.computeSize = () => [0, -4];
      if (hiddenWidget.inputEl) hiddenWidget.inputEl.style.display = "none";

      const node = this;
      node.resizable = true;

      const MIN_WIDTH = 480;
      const MIN_HEIGHT = 370;

      const { root: container, refreshFromHidden, cleanup } = buildWildcardWidget(node, hiddenWidget);
      const domWidget = node.addDOMWidget("prompt_palette_ui", "div", container, {
        getValue: () => hiddenWidget.value,
        setValue: (v) => {
          hiddenWidget.value = v;
          node.properties = node.properties || {};
          node.properties.wg_text = v;
        },
        // The hidden "text" widget already serializes this value. Keeping this
        // DOM widget out of widgets_values avoids positional index drift between
        // it and the hidden widget across ComfyUI frontend versions/tab switches.
        serialize: false,
        // getMinHeight/getMaxHeight/getHeight are ComfyUI's own dedicated hooks
        // for "how big/where is this specific DOM element drawn" — used for
        // sizing, positioning, and the "Enable DOM element clipping" setting
        // (docs.comfy.org/interface/settings/lite-graph). Crucially, they are
        // NOT the same function LiteGraph's node-level auto-grow pass consults
        // to decide whether the *node* needs to get bigger — that's a
        // completely separate code path keyed off the node's own resize
        // handling, untouched here. So answering these honestly (no ceiling,
        // real current height) fixes the DOM-clipping ghosting bug without
        // reopening the runaway-growth bug: there's no shared function left
        // for the two concerns to fight over, unlike every previous attempt
        // that tried to make widget.computeSize serve both jobs at once.
        getMinHeight: () => MIN_HEIGHT,
        getMaxHeight: () => Infinity,
        getHeight: () => node.size[1],
      });
      node._wgRefreshFromHidden = refreshFromHidden;
      
      node.onRemoved = function () {
        if (cleanup) cleanup();
      };

      // --- Free resize, without the old runaway-growth bug OR the DOM-clip
      // --- ghosting bug --------------------------------------------------
      // Both bugs came from the same mistake: making ONE function (widget
      // computeSize) answer TWO different questions — "how much room does
      // this widget need" (which feeds LiteGraph's node auto-grow) and "how
      // big/where is the DOM element actually drawn" (which feeds ComfyUI's
      // DOM-widget clipping/positioning, see the "Enable DOM element
      // clipping" setting at docs.comfy.org/interface/settings/lite-graph).
      // Lying to it fixed auto-grow but broke clipping (ghosting). Telling
      // it the truth fixed clipping but reopened auto-grow, even after
      // trying to shield that through a node.computeSize override — because
      // node auto-grow isn't actually gated by node.computeSize here, it's
      // driven directly by whatever the DOM widget reports.
      //
      // addDOMWidget has dedicated options for the second question —
      // getMinHeight/getMaxHeight/getHeight, passed above — that are a
      // separate code path from the node's own resize/auto-grow handling.
      // Answering those honestly (no ceiling, real current height) no
      // longer has anything to feed back into node growth, because nothing
      // here reports widget size through node.computeSize (or LiteGraph's
      // own default widget-summing version of it) at all anymore. The node
      // itself only ever changes size from an actual user drag, and its
      // only job left is enforcing a floor on that.
      function clampSize() {
        if (node.size[0] < MIN_WIDTH) node.size[0] = MIN_WIDTH;
        if (node.size[1] < MIN_HEIGHT) node.size[1] = MIN_HEIGHT;
      }

      const onResize = node.onResize;
      node.onResize = function (size) {
        if (onResize) onResize.apply(this, arguments);
        clampSize();
      };

      node.setSize([Math.max(node.size[0], MIN_WIDTH), Math.max(node.size[1], MIN_HEIGHT)]);
      return r;
    };
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const r = onConfigure ? onConfigure.apply(this, arguments) : undefined;
      // Re-sync the visible textarea (and seed/mode/IO-toggle controls) after
      // ComfyUI reconfigures this node, e.g. when switching back to a workflow
      // tab. Deferred a tick so this runs after ComfyUI finishes restoring
      // widgets_values/properties.
      if (this._wgRefreshFromHidden) setTimeout(() => this._wgRefreshFromHidden(), 0);
      if (this._wgRefreshIoToggles) setTimeout(() => this._wgRefreshIoToggles(), 0);
      return r;
    };
  },
});