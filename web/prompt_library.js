import { readStarterPreference, writeStarterPreference } from "./prompt_palette_state.js";

const CATALOG_URL = new URL("./prompt_library_catalog.json", import.meta.url).href;
let catalogPromise = null;

const STARTER_PREF_KEYS = {
  pp_starter_model: "model",
  pp_starter_auto_model: "autoModel",
  pp_starter_filter: "filter",
};

function readLocalPreference(key, fallback) {
  return readStarterPreference(STARTER_PREF_KEYS[key] || key, fallback);
}

function writeLocalPreference(key, value) {
  writeStarterPreference(STARTER_PREF_KEYS[key] || key, String(value));
}

export function loadStarterPackCatalog() {
  if (!catalogPromise) {
    catalogPromise = fetch(CATALOG_URL, { cache: "no-cache" })
      .then((response) => {
        if (!response.ok) throw new Error(`Starter Pack catalog failed to load (${response.status})`);
        return response.json();
      })
      .catch((error) => {
        catalogPromise = null;
        throw error;
      });
  }
  return catalogPromise;
}

export function flattenStarterPackCatalog(catalog) {
  const rows = [];
  for (const model of catalog?.models || []) {
    for (const category of model.categories || []) {
      for (const prompt of category.prompts || []) {
        rows.push({
          id: prompt.id,
          modelId: model.id,
          modelName: model.name,
          modelKind: model.kind,
          categoryId: category.id,
          categoryName: category.name,
          subcategory: prompt.subcategory || "Essentials",
          title: prompt.title,
          prompt: prompt.prompt,
          note: prompt.note || "",
          visual: prompt.visual || category.visual || "concept",
          accent: model.accent || "#d49a52",
        });
      }
    }
  }
  return rows;
}

function hashString(value) {
  let hash = 2166136261;
  for (let index = 0; index < String(value).length; index += 1) {
    hash ^= String(value).charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function motifMarkup(kind, accent) {
  const stroke = "currentColor";
  const fill = accent;
  const motifs = {
    pose: `<circle cx="42" cy="19" r="7"/><path d="M42 26v25m0-17-17 12m17-12 19 8M42 51 27 70m15-19 18 19"/>`,
    portrait: `<path d="M28 70c2-17 10-25 24-25s22 8 24 25"/><circle cx="52" cy="27" r="15"/><path d="M39 26c4-9 20-12 28-2"/>`,
    sheet: `<rect x="15" y="14" width="74" height="58" rx="7"/><path d="M33 25v36M52 25v36M71 25v36"/><circle cx="24" cy="33" r="5"/><circle cx="43" cy="33" r="5"/><circle cx="62" cy="33" r="5"/><circle cx="81" cy="33" r="5"/>`,
    camera: `<rect x="18" y="24" width="68" height="42" rx="8"/><circle cx="52" cy="45" r="15"/><path d="M29 24l7-10h31l7 10M76 34h1"/>`,
    macro: `<circle cx="43" cy="39" r="22"/><path d="m59 55 18 18"/><circle cx="43" cy="39" r="8"/><path d="M17 18h16M17 24h10"/>`,
    overhead: `<rect x="18" y="16" width="68" height="58" rx="8"/><circle cx="52" cy="45" r="15"/><path d="M52 17v12M52 61v13M19 45h18M67 45h19"/>`,
    product: `<path d="M37 22h30l7 12v33H30V34z"/><path d="M37 22v12h30V22M40 46h24M40 55h18"/>`,
    packaging: `<path d="M24 24h25v48H24zM57 16h22v56H57z"/><path d="M29 37h15M62 30h12M62 39h12"/>`,
    architecture: `<path d="M17 70h70M25 70V30l27-15 27 15v40M36 70V46h32v24"/><path d="M43 28h18M43 36h18"/>`,
    interior: `<path d="M18 20v52h68V20M18 50h68"/><path d="M28 44V29h18v15M59 70V54h18v16"/>`,
    city: `<path d="M15 72h74M22 72V38h17v34M44 72V21h20v51M69 72V46h14v26"/><path d="M27 47h7M27 56h7M50 31h8M50 41h8M50 51h8"/>`,
    cinematic: `<rect x="14" y="18" width="76" height="54" rx="7"/><path d="M14 32h76M27 18l7 14m11-14 7 14m11-14 7 14"/><path d="m44 45 20 10-20 10z"/>`,
    motion: `<circle cx="58" cy="20" r="7"/><path d="M54 28 41 44l17 8 11 20M42 43 25 36M58 52 40 70"/><path d="M15 28h22M10 39h20M18 51h16"/>`,
    action: `<circle cx="55" cy="19" r="6"/><path d="m51 26-12 18 18 7 14 19M39 44 20 53M57 51 38 70"/><path d="M16 25h17M10 35h20"/>`,
    dialogue: `<path d="M15 18h74v42H48L30 72l5-12H15z"/><path d="M28 32h48M28 42h37"/>`,
    audio: `<path d="M18 48h12l15 14V22L30 36H18z"/><path d="M57 34c7 6 7 16 0 22M68 25c13 11 13 29 0 40"/>`,
    transition: `<path d="M17 28h47M54 18l10 10-10 10M87 60H40M50 50 40 60l10 10"/>`,
    physics: `<path d="M22 20h35v25H22z"/><path d="m57 45 20 10-17 17-20-12z"/><path d="M24 64c8-6 15-6 22 0 7 6 14 6 22 0"/>`,
    fluid: `<path d="M52 15c12 15 23 27 23 40a23 23 0 1 1-46 0c0-13 11-25 23-40Z"/><path d="M36 58c8 5 24 5 32-2"/>`,
    poster: `<rect x="21" y="12" width="62" height="66" rx="5"/><path d="M31 27h42M31 38h28M31 61h42"/><circle cx="66" cy="49" r="9"/>`,
    text: `<rect x="17" y="18" width="70" height="54" rx="7"/><path d="M30 31h44M30 43h44M30 55h29"/>`,
    infographic: `<rect x="15" y="15" width="74" height="60" rx="7"/><path d="M27 62V44M40 62V34M53 62V49M66 62V27M25 25h24"/>`,
    edit: `<rect x="17" y="17" width="70" height="56" rx="7"/><path d="m58 29 15 15-25 25-18 3 3-18z"/><path d="m58 29 6-6 15 15-6 6"/>`,
    rotation: `<path d="M72 31a27 27 0 1 0 4 28"/><path d="M67 18h16v16"/><rect x="39" y="35" width="26" height="26" rx="5"/>`,
    diagram: `<circle cx="26" cy="28" r="10"/><circle cx="77" cy="28" r="10"/><circle cx="52" cy="65" r="10"/><path d="M36 28h31M32 36l14 21M72 36 58 57"/>`,
    map: `<path d="m16 24 22-10 28 10 22-10v54L66 78 38 68 16 78z"/><path d="M38 14v54M66 24v54M25 53c12-12 21 4 34-9 8-8 14-5 21 1"/>`,
    anime: `<circle cx="52" cy="35" r="21"/><path d="M32 34c2-20 38-24 41 0M36 55c8 11 24 11 32 0"/><path d="M42 36h2M60 36h2"/>`,
    expression: `<rect x="15" y="15" width="74" height="60" rx="7"/><circle cx="34" cy="34" r="11"/><circle cx="69" cy="34" r="11"/><circle cx="34" cy="59" r="11"/><circle cx="69" cy="59" r="11"/>`,
    lighting: `<circle cx="38" cy="29" r="14"/><path d="M38 8v8M38 42v8M17 29h8M51 29h8M23 14l6 6M47 38l6 6M23 44l6-6M47 20l6-6"/><path d="M68 18v52M60 70h16"/>`,
    painting: `<path d="M18 58c8-21 22-35 39-35 16 0 28 9 28 22 0 9-7 14-16 14h-8c-5 0-7 3-6 7 2 7-3 12-11 12-16 0-31-8-26-20Z"/><circle cx="39" cy="38" r="4"/><circle cx="52" cy="32" r="4"/><circle cx="64" cy="39" r="4"/>`,
    ink: `<path d="M21 70c18-8 16-28 29-41 10-10 22-10 35-13-8 12-9 22-3 31-18 0-27 8-36 21-8 11-17 10-25 2Z"/><path d="M16 76h72"/>`,
    forest: `<path d="M20 72 34 38h-9l17-27 17 27h-9l14 34M52 72V42"/><path d="M63 72 74 47h-7l13-20 12 20h-7l8 25"/>`,
    landscape: `<path d="M13 69 36 38l13 15 14-24 28 40z"/><circle cx="25" cy="24" r="9"/><path d="M13 69h78"/>`,
    duo: `<circle cx="37" cy="27" r="9"/><circle cx="67" cy="27" r="9"/><path d="M22 70c2-20 9-30 15-30s13 10 15 30M52 70c2-20 9-30 15-30s13 10 15 30"/>`,
    concept: `<path d="M52 14 61 35l23 2-18 15 6 22-20-12-20 12 6-22-18-15 23-2z"/>`,
    materials: `<circle cx="34" cy="46" r="20"/><rect x="51" y="23" width="30" height="46" rx="7"/><path d="M18 46h32M66 23v46"/>`,
    catalog: `<rect x="14" y="15" width="76" height="60" rx="6"/><path d="M26 27h18v15H26zM58 27h18v15H58zM26 51h18v15H26zM58 51h18v15H58z"/>`,
    toy: `<circle cx="52" cy="31" r="16"/><path d="M35 71c0-18 6-27 17-27s17 9 17 27"/><circle cx="46" cy="29" r="2"/><circle cx="58" cy="29" r="2"/>`,
    surreal: `<path d="M19 67h67M25 67V20h31v47M63 67V45h17v22"/><circle cx="72" cy="34" r="7"/><path d="M72 41v16m0-10-8 7m8-7 8 7"/>`,
    stilllife: `<path d="M18 70h70M27 70V36h20v34M56 70V25h23v45"/><circle cx="37" cy="24" r="8"/>`,
    food: `<ellipse cx="52" cy="52" rx="32" ry="20"/><path d="M35 44c5-14 29-14 34 0M42 36c4-10 16-10 20 0"/>`,
    fashion: `<circle cx="52" cy="17" r="7"/><path d="M41 27h22l8 43H33zM41 31 25 47M63 31l16 16"/>`,
    silhouette: `<path d="M30 70c0-20 5-34 14-41l-4-15h24l-4 15c9 7 14 21 14 41z"/>`,
    paper: `<path d="M18 64 38 28l14 25 13-16 22 27z"/><path d="M18 70h69"/>`,
  };
  const motifAliases = {
    archive: "catalog",
    cockpit: "camera",
    collage: "paper",
    commercial: "product",
    corridor: "interior",
    diorama: "toy",
    documentary: "camera",
    environment: "landscape",
    fisheye: "camera",
    greenhouse: "forest",
    harbor: "landscape",
    market: "city",
    motel: "architecture",
    performance: "cinematic",
    rooftop: "city",
    snow: "landscape",
    static: "cinematic",
    story: "dialogue",
    surveillance: "camera",
    telephoto: "camera",
    transit: "city",
    workshop: "interior",
  };
  const body = motifs[kind] || motifs[motifAliases[kind]] || motifs.concept;
  return `<g fill="none" stroke="${stroke}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">${body}</g><circle cx="84" cy="16" r="5" fill="${fill}" opacity=".95"/>`;
}

export function promptThumbnailSvg({ id, title, visual, accent, compact = false }) {
  const hash = hashString(`${id}:${title}:${visual}`);
  const hue = hash % 360;
  const hue2 = (hue + 42 + (hash % 63)) % 360;
  const width = compact ? 96 : 320;
  const height = compact ? 72 : 138;
  const safeAccent = /^#[0-9a-f]{6}$/i.test(accent || "") ? accent : "#d49a52";
  const label = escapeHtml(String(title || "").slice(0, compact ? 18 : 34));
  return `<svg viewBox="0 0 104 86" preserveAspectRatio="xMidYMid slice" width="${width}" height="${height}" role="img" aria-label="${label}">
    <defs>
      <linearGradient id="g${hash}" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="hsl(${hue} 42% 21%)"/>
        <stop offset="1" stop-color="hsl(${hue2} 46% 12%)"/>
      </linearGradient>
      <radialGradient id="r${hash}" cx="78%" cy="18%" r="70%">
        <stop offset="0" stop-color="${safeAccent}" stop-opacity=".32"/>
        <stop offset="1" stop-color="${safeAccent}" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect width="104" height="86" rx="10" fill="url(#g${hash})"/>
    <rect width="104" height="86" rx="10" fill="url(#r${hash})"/>
    <g color="rgba(255,255,255,.82)" transform="translate(0 2)">${motifMarkup(visual, safeAccent)}</g>
    <rect x="0" y="68" width="104" height="18" fill="rgba(5,8,12,.55)"/>
    <text x="8" y="80" fill="rgba(255,255,255,.9)" font-size="7" font-family="system-ui, sans-serif" font-weight="650">${label}</text>
  </svg>`;
}

function findPrompt(model, promptId) {
  for (const category of model.categories || []) {
    const prompt = (category.prompts || []).find((item) => item.id === promptId);
    if (prompt) return { prompt, category };
  }
  return null;
}

function insertPromptText(textarea, value) {
  const start = Number.isFinite(textarea.selectionStart) ? textarea.selectionStart : textarea.value.length;
  const end = Number.isFinite(textarea.selectionEnd) ? textarea.selectionEnd : start;
  const before = textarea.value.slice(0, start);
  const after = textarea.value.slice(end);
  const leading = before && !/\s$/.test(before) ? "\n\n" : "";
  const trailing = after && !/^\s/.test(after) ? "\n\n" : "";
  const inserted = `${leading}${value}${trailing}`;
  textarea.setRangeText(inserted, start, end, "end");
  const contentStart = start + leading.length;
  textarea.selectionStart = contentStart;
  textarea.selectionEnd = contentStart + value.length;
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  textarea.focus({ preventScroll: true });
  return { start: contentStart, end: contentStart + value.length, text: value };
}

export function createStarterPackController({
  root, textarea, notify, onInsert, isFavorite, onToggleFavorite,
  recentIds, onModelChange,
}) {
  const modelSelect = root.querySelector('[data-el="starterModelSelect"]');
  const modelSummary = root.querySelector('[data-el="starterModelSummary"]');
  const searchInput = root.querySelector('[data-el="starterSearch"]');
  const tree = root.querySelector('[data-el="starterTree"]');
  const resultCount = root.querySelector('[data-el="starterCount"]');
  const status = root.querySelector('[data-el="starterStatus"]');
  const filterButtons = Array.from(root.querySelectorAll("[data-starter-filter]"));
  if (!modelSelect || !modelSummary || !searchInput || !tree || !resultCount || !status) {
    return { activate() {}, setActive() {}, cleanup() {} };
  }

  let catalog = null;
  let currentModelId = readLocalPreference("pp_starter_model", "auto");
  let suggestedModelId = readLocalPreference("pp_starter_auto_model", "krea-2");
  let suggestedModelDetail = "Connected model detection";
  let active = false;
  let disposed = false;
  let filterMode = readLocalPreference("pp_starter_filter", "all");
  if (!new Set(["all", "favorites", "recent"]).has(filterMode)) filterMode = "all";
  let openByModel = readStarterPreference("openCategories", {});
  if (!openByModel || typeof openByModel !== "object" || Array.isArray(openByModel)) openByModel = {};

  function effectiveModelId() {
    return currentModelId === "auto" ? suggestedModelId : currentModelId;
  }
  function currentModel() {
    const models = catalog?.models || [];
    const id = effectiveModelId();
    return models.find((model) => model.id === id) || models.find((model) => model.id === "krea-2") || models[0] || null;
  }
  function saveOpenState() {
    writeStarterPreference("openCategories", openByModel);
  }
  function openSet(modelId) {
    const stored = Array.isArray(openByModel[modelId]) ? openByModel[modelId] : [];
    return new Set(stored);
  }
  function setCategoryOpen(modelId, categoryId, isOpen) {
    const set = openSet(modelId);
    if (isOpen) set.add(categoryId); else set.delete(categoryId);
    openByModel[modelId] = [...set].slice(0, 16);
    saveOpenState();
  }

  function renderModelSelect() {
    const models = catalog?.models || [];
    const detected = models.find((model) => model.id === suggestedModelId) || models.find((model) => model.id === "krea-2") || models[0];
    modelSelect.replaceChildren();
    if (detected) {
      const option = document.createElement("option");
      option.value = "auto";
      option.textContent = `Auto — ${detected.name}`;
      option.title = `${suggestedModelDetail}. Suggestions only — Prompt Palette never rewrites your prompt.`;
      modelSelect.appendChild(option);
    }
    for (const model of models) {
      const option = document.createElement("option");
      option.value = model.id;
      option.textContent = model.name;
      modelSelect.appendChild(option);
    }
    if (currentModelId !== "auto" && !models.some((model) => model.id === currentModelId)) currentModelId = "auto";
    modelSelect.value = currentModelId;
  }

  function renderSummary() {
    const model = currentModel();
    if (!model) return;
    modelSummary.style.setProperty("--starter-accent", model.accent || "#d49a52");
    const auto = currentModelId === "auto" ? `<span class="wg-starter-auto-note" title="${escapeHtml(suggestedModelDetail)}">AUTO</span>` : "";
    modelSummary.innerHTML = `<div>${auto}<span class="wg-starter-summary-badge">${escapeHtml(model.kind || "Model")}</span><strong>${escapeHtml(model.name)}</strong><p>${escapeHtml(model.summary || "")}</p></div>`;
  }

  function matchingCategories() {
    const model = currentModel();
    if (!model) return [];
    const query = searchInput.value.trim().toLowerCase();
    const recent = new Set((recentIds?.() || []).map(String));
    const categories = [];
    for (const category of model.categories || []) {
      const prompts = (category.prompts || []).filter((prompt) => {
        if (filterMode === "favorites" && !isFavorite?.(prompt.id)) return false;
        if (filterMode === "recent" && !recent.has(String(prompt.id))) return false;
        if (!query) return true;
        const haystack = `${prompt.title} ${prompt.note || ""} ${prompt.prompt || ""} ${prompt.subcategory || ""} ${category.name} ${category.description || ""}`.toLowerCase();
        return haystack.includes(query);
      });
      if (prompts.length) categories.push({ category, prompts });
    }
    return categories;
  }

  function renderPromptCard(model, category, prompt) {
    const card = document.createElement("article");
    card.className = "wg-starter-card";
    card.style.setProperty("--starter-accent", model.accent || "#d49a52");
    card.dataset.promptId = prompt.id;
    card.tabIndex = 0;
    const favorite = !!isFavorite?.(prompt.id);
    card.innerHTML = `
      <div class="wg-starter-card-thumb">${promptThumbnailSvg({ id: `${model.id}-${category.id}-${prompt.id}`, title: prompt.title, visual: prompt.visual || category.visual, accent: model.accent, compact: true })}</div>
      <div class="wg-starter-card-body">
        <h5>${escapeHtml(prompt.title)}</h5>
        <p>${escapeHtml(prompt.note || prompt.prompt)}</p>
      </div>
      <div class="wg-starter-card-actions">
        <button type="button" class="wg-starter-insert" data-starter-insert="${escapeHtml(prompt.id)}" title="Insert into prompt" aria-label="Insert ${escapeHtml(prompt.title)} into prompt">+</button>
        <button type="button" class="wg-starter-favorite${favorite ? " active" : ""}" data-starter-favorite="${escapeHtml(prompt.id)}" aria-pressed="${String(favorite)}" title="${favorite ? "Remove from favorites" : "Add to favorites"}" aria-label="${favorite ? "Remove from favorites" : "Add to favorites"}">★</button>
      </div>`;
    card.querySelector("p").title = prompt.prompt;
    return card;
  }

  function renderTree() {
    const model = currentModel();
    tree.replaceChildren();
    if (!model) return;
    const groups = matchingCategories();
    const query = searchInput.value.trim();
    const total = groups.reduce((sum, entry) => sum + entry.prompts.length, 0);
    resultCount.textContent = `${total} card${total === 1 ? "" : "s"} · ${groups.length} categor${groups.length === 1 ? "y" : "ies"}`;
    filterButtons.forEach((button) => {
      const selected = button.dataset.starterFilter === filterMode;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
    if (!groups.length) {
      const empty = document.createElement("div");
      empty.className = "wg-starter-empty";
      empty.textContent = filterMode === "favorites"
        ? "No favorites in this model yet. Star any card to keep it here."
        : filterMode === "recent"
          ? "No recently used cards in this model yet."
          : "No Starter Pack prompts match this search.";
      tree.appendChild(empty);
      return;
    }

    const persistedOpen = openSet(model.id);
    groups.forEach(({ category, prompts }, categoryIndex) => {
      const details = document.createElement("details");
      details.className = "wg-starter-category-group";
      details.dataset.categoryId = category.id;
      details.style.setProperty("--starter-accent", model.accent || "#d49a52");
      details.open = !!query || persistedOpen.has(category.id) || (!persistedOpen.size && categoryIndex === 0);

      const summary = document.createElement("summary");
      summary.innerHTML = `<span class="wg-starter-category-thumb">${promptThumbnailSvg({ id: `${model.id}-${category.id}`, title: category.name, visual: category.visual || "catalog", accent: model.accent, compact: true })}</span><span class="wg-starter-category-copy"><strong>${escapeHtml(category.name)}</strong><small>${escapeHtml(category.description || "")}</small></span><span class="wg-starter-category-count">${prompts.length}</span><span class="wg-starter-chevron" aria-hidden="true">›</span>`;
      details.appendChild(summary);

      const content = document.createElement("div");
      content.className = "wg-starter-category-content";
      const bySubcategory = new Map();
      for (const prompt of prompts) {
        const name = prompt.subcategory || "Essentials";
        if (!bySubcategory.has(name)) bySubcategory.set(name, []);
        bySubcategory.get(name).push(prompt);
      }
      for (const [subcategory, subPrompts] of bySubcategory) {
        const section = document.createElement("section");
        section.className = "wg-starter-subcategory";
        section.innerHTML = `<div class="wg-starter-subcategory-head"><span>${escapeHtml(subcategory)}</span><small>${subPrompts.length}</small></div>`;
        const grid = document.createElement("div");
        grid.className = "wg-starter-grid";
        for (const prompt of subPrompts) grid.appendChild(renderPromptCard(model, category, prompt));
        section.appendChild(grid);
        content.appendChild(section);
      }
      details.appendChild(content);
      tree.appendChild(details);
    });
  }

  function renderAll() {
    renderModelSelect();
    renderSummary();
    renderTree();
  }

  const onModelChangeEvent = () => {
    if (!active) return;
    currentModelId = modelSelect.value || "auto";
    writeLocalPreference("pp_starter_model", currentModelId);
    renderSummary();
    renderTree();
    onModelChange?.({ selected: currentModelId, model: currentModel(), automatic: currentModelId === "auto" });
  };
  const onTreeToggle = (event) => {
    const details = event.target.closest?.("details[data-category-id]");
    if (!details || searchInput.value.trim()) return;
    const model = currentModel();
    if (model) setCategoryOpen(model.id, details.dataset.categoryId, details.open);
  };
  const insertById = (id) => {
    const model = currentModel();
    const found = model && findPrompt(model, id);
    if (!found) return;
    const range = insertPromptText(textarea, found.prompt.prompt);
    onInsert?.({ model, category: found.category, prompt: found.prompt, range });
    notify?.("success", `${found.prompt.title} inserted`, "The inserted text is selected so you can immediately customize it or save your version to My Library.");
  };
  const onTreeClick = (event) => {
    const favoriteButton = event.target.closest("[data-starter-favorite]");
    if (favoriteButton && active) {
      event.preventDefault(); event.stopPropagation();
      const on = !!onToggleFavorite?.(favoriteButton.dataset.starterFavorite);
      favoriteButton.classList.toggle("active", on);
      favoriteButton.setAttribute("aria-pressed", String(on));
      favoriteButton.title = on ? "Remove from favorites" : "Add to favorites";
      favoriteButton.setAttribute("aria-label", favoriteButton.title);
      if (filterMode === "favorites") renderTree();
      return;
    }
    const button = event.target.closest("[data-starter-insert]");
    if (!button || !active) return;
    event.preventDefault(); event.stopPropagation();
    insertById(button.dataset.starterInsert);
  };
  const onTreeKeydown = (event) => {
    if (!active || (event.key !== "Enter" && event.key !== " ")) return;
    const card = event.target.closest?.(".wg-starter-card");
    if (!card || event.target.closest("button,summary")) return;
    event.preventDefault();
    insertById(card.dataset.promptId);
  };
  const onCardDoubleClick = (event) => {
    const card = event.target.closest?.(".wg-starter-card");
    if (!card || event.target.closest("button")) return;
    insertById(card.dataset.promptId);
  };
  const onSearch = () => { if (active) renderTree(); };
  const onFilterClick = (event) => {
    if (!active) return;
    const button = event.currentTarget;
    const next = button.dataset.starterFilter;
    if (!new Set(["all", "favorites", "recent"]).has(next)) return;
    filterMode = next;
    writeLocalPreference("pp_starter_filter", filterMode);
    renderTree();
  };

  modelSelect.addEventListener("change", onModelChangeEvent);
  tree.addEventListener("toggle", onTreeToggle, true);
  tree.addEventListener("click", onTreeClick);
  tree.addEventListener("keydown", onTreeKeydown);
  tree.addEventListener("dblclick", onCardDoubleClick);
  searchInput.addEventListener("input", onSearch);
  filterButtons.forEach((button) => button.addEventListener("click", onFilterClick));

  async function activate() {
    if (disposed) return;
    active = true;
    if (catalog) return renderAll();
    status.textContent = "Loading Starter Packs…";
    status.className = "wg-starter-status";
    try {
      catalog = await loadStarterPackCatalog();
      if (!active || disposed) return;
      if (!catalog?.models?.length) throw new Error("Starter Pack catalog is empty");
      if (!catalog.models.some((model) => model.id === suggestedModelId)) suggestedModelId = catalog.models.find((model) => model.id === "krea-2")?.id || catalog.models[0].id;
      status.textContent = "";
      renderAll();
    } catch (error) {
      if (disposed) return;
      status.textContent = error?.message || "Starter Packs could not be loaded.";
      status.className = "wg-starter-status error";
    }
  }

  return {
    activate,
    setActive(value) { if (!disposed) active = !!value; },
    setSuggestedModel(id, detail = "Connected model detection") {
      if (disposed || !id || id === "universal") return;
      suggestedModelId = id;
      suggestedModelDetail = detail;
      writeLocalPreference("pp_starter_auto_model", id);
      if (catalog && currentModelId === "auto") renderAll();
    },
    selectedModelId() { return currentModelId; },
    effectiveModel() { return currentModel(); },
    catalog() { return catalog; },
    cleanup() {
      disposed = true;
      active = false;
      modelSelect.removeEventListener("change", onModelChangeEvent);
      tree.removeEventListener("toggle", onTreeToggle, true);
      tree.removeEventListener("click", onTreeClick);
      tree.removeEventListener("keydown", onTreeKeydown);
      tree.removeEventListener("dblclick", onCardDoubleClick);
      searchInput.removeEventListener("input", onSearch);
      filterButtons.forEach((button) => button.removeEventListener("click", onFilterClick));
    },
  };
}
