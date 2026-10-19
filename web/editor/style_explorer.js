import { API } from "../prompt_palette_api.js";
import { downloadJsonFile, svgIcon } from "../prompt_palette_shared.js";
import { loadCustomWords, resetCustomWords } from "./custom_words.js";
import { loadTheme, loadSidebarDisplay, sidebarDisplayMetrics } from "./preferences.js";
import { recordInsertedTags } from "./booru_tag_colors.js";
import { readEditorPreference, writeEditorPreference } from "../prompt_palette_state.js";
import { VirtualCollectionManager } from "../library/virtual_collection.js";
import { FACET_GROUPS, PREVIEW_LABELS, BENCHMARKS, normalizeStyleText, decorateStyle, filterStyles, styleOutput, comparisonPrompt, stylePreviewUrl } from "./style_library_model.js";
export { filterStyles, styleOutput } from "./style_library_model.js";

const KEY = "prompt_palette_style_explorer_v1", PAGE = 36;
const make = (tag, cls = "", text = "") => { const el = document.createElement(tag); el.className = cls; el.textContent = text; return el; };
const button = (text, action, cls = "") => { const el = make("button", cls, text); el.type = "button"; el.addEventListener("click", action); return el; };
const select = options => { const el = make("select"); options.forEach(([value, text]) => el.append(new Option(text, value))); return el; };
const label = (title, control, host) => { const el = make("label", "pp-style-label", title); control.setAttribute("aria-label", title); el.append(control); host.append(el); return control; };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

// Files remain in the existing style annotation store. Decode and re-encode only
// raster inputs; SVG/HTML/URLs never enter a user preview or image element.
export async function prepareStyleThumbnail(file) {
  const extensions = { "image/png": /\.png$/i, "image/jpeg": /\.jpe?g$/i, "image/webp": /\.webp$/i };
  if (!extensions[file.type]?.test(file.name) || file.size > 16 * 1024 * 1024 || !file.size) throw new Error("Choose a PNG, JPEG or WebP under 16 MB with matching file type and extension.");
  const bytes = new Uint8Array(await file.slice(0, 131072).arrayBuffer()), view = new DataView(bytes.buffer);
  let width = 0, height = 0;
  if (file.type === "image/png") {
    if (bytes.length < 24 || [137,80,78,71,13,10,26,10].some((b, i) => bytes[i] !== b)) throw new Error("Invalid PNG signature.");
    width = view.getUint32(16); height = view.getUint32(20);
  } else if (file.type === "image/jpeg") {
    if (bytes[0] !== 255 || bytes[1] !== 216 || bytes[2] !== 255) throw new Error("Invalid JPEG signature.");
    for (let i = 2; i + 8 < bytes.length;) {
      if (bytes[i] !== 255) break;
      while (bytes[i] === 255) i++;
      const marker = bytes[i++];
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || marker >= 208 && marker <= 215) continue;
      if (i + 2 > bytes.length) break;
      const length = view.getUint16(i); if (length < 2) break;
      if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)) { height = view.getUint16(i + 3); width = view.getUint16(i + 5); break; }
      i += length;
    }
  } else {
    const word = offset => String.fromCharCode(...bytes.slice(offset, offset + 4));
    if (word(0) !== "RIFF" || word(8) !== "WEBP") throw new Error("Invalid WebP signature.");
    const little24 = offset => bytes[offset] | bytes[offset + 1] << 8 | bytes[offset + 2] << 16;
    if (word(12) === "VP8X" && bytes.length >= 30) { width = little24(24) + 1; height = little24(27) + 1; }
    else if (word(12) === "VP8L" && bytes.length >= 25 && bytes[20] === 47) { width = 1 + (bytes[21] | (bytes[22] & 63) << 8); height = 1 + ((bytes[22] >> 6) | bytes[23] << 2 | (bytes[24] & 15) << 10); }
    else if (word(12) === "VP8 " && bytes.length >= 30) { width = view.getUint16(26, true) & 16383; height = view.getUint16(28, true) & 16383; }
  }
  if (!width || !height || width * height > 16_000_000) throw new Error("Image dimensions could not be read safely, or exceed 16 megapixels.");
  const bitmap = await createImageBitmap(file);
  try {
    if (bitmap.width * bitmap.height > 16_000_000) throw new Error("Choose an image under 16 megapixels.");
    const scale = Math.min(1, 512 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas"); canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const result = canvas.toDataURL("image/webp", .82);
    if (result.length > 350000 || !/^data:image\/(webp|png);base64,/.test(result)) throw new Error("Preview is too large. Choose a smaller or simpler image.");
    return result;
  } finally { bitmap.close(); }
}

export function createStyleExplorer(host, { insert, announce, onViewChanged = () => {} }) {
  const saved = readEditorPreference(KEY, {}) || {};
  let indexId = typeof saved.index === "string" ? saved.schema !== 2 && saved.index === "builtin:techniques" ? "builtin:visual" : saved.index : "builtin:visual";
  const artistIds = ["builtin:anima", "booru", "builtin:classic"];
  let artistSource = artistIds.includes(saved.artistSource) ? saved.artistSource : artistIds.includes(indexId) ? indexId : "builtin:anima";
  let catalog = null, rows = [], edits = Object.create(null), matches = [], page = 0, version = 0, disposed = false, loaded = false, loading = false, timer, editSerial = 0;
  let byKey = new Map(), facetOptions = new Map(), compare = Array.isArray(saved.compare) ? saved.compare.slice(0, 4).filter(r => r?.tag && r.originIndex) : [];
  let view = ["styles", "classic", "artists", "anima", "tags", "favorites", "previews"].includes(saved.view) ? saved.view : "styles", returnFocus = null;
  const identity = row => `${row.originIndex || indexId}\0${row.tag}`;
  const origin = row => row.originIndex || indexId;
  const intro = make("div", "pp-sidebar-intro pp-style-intro");
  intro.append(make("span", "pp-sidebar-eyebrow", "THE INSPIRATION LIBRARY"), make("h3", "", "Find your next look"), make("p", "pp-sidebar-note", "A world of styles. One click into your prompt.")); host.append(intro);
  const browse = make("div", "pp-style-browse"); host.append(browse);
  const collectionNav = make("nav", "pp-style-collections"); collectionNav.setAttribute("aria-label", "Visual collections"); browse.append(collectionNav);
  const collectionButtons = new Map();
  for (const [id, title, icon] of [["builtin:visual", "Styles", "image"], ["artists", "Artists", "edit"], ["tags", "Booru tags", "select"], ["favorites", "Favorites", "pin"], ["previews", "My previews", "gallery"], ["custom", "My words", "recipe"]]) {
    const control = button("", () => { const target = id === "artists" ? artistSource : id; indexes.value = target; load(target); }); control.innerHTML = `${svgIcon(icon, 14)}<span>${title}</span>`; control.setAttribute("aria-pressed", "false"); collectionButtons.set(id, control); collectionNav.append(control);
  }
  const artistBar = make("div", "pp-style-artist-source");
  const artistPicker = label("Artist catalog", select([["builtin:anima", "Anima · @artist names"], ["booru", "Booru · artist tags"], ["builtin:classic", "Classic · art references"]]), artistBar);
  const artistHint = make("p", "pp-sidebar-note"); artistBar.append(artistHint); browse.append(artistBar);
  artistPicker.addEventListener("change", () => load(artistPicker.value));
  function refreshVisibility() {
    const chrome = loadSidebarDisplay().chrome;
    for (const [key, control] of collectionButtons) control.hidden = chrome[key] === false;
    for (const option of indexes.options) { const key = artistIds.includes(option.value) ? "artists" : option.value; option.hidden = option.disabled = chrome[key] === false; }
    const active = artistIds.includes(indexId) ? "artists" : indexId;
    if (chrome[active] === false) { if (loaded) load("builtin:visual"); else indexId = "builtin:visual"; }
  }
  const search = make("input", "pp-style-search"); search.type = "search"; search.placeholder = "Search styles, artists or tags…"; search.setAttribute("aria-label", "Search visual styles"); browse.append(search);
  const controls = make("div", "pp-style-controls"); browse.append(controls);
  const indexes = label("Local collection", select([]), controls);
  const format = label("Prompt language", select([["auto", "Follow editor"], ["raw", "Booru · literal tags"], ["anima", "Anima · @artist"], ["natural", "Natural language"], ["pony", "Pony · literal tags"], ["illustrious", "Illustrious · literal tags"]]), controls);
  format.value = ["auto", "raw", "anima", "natural", "pony", "illustrious"].includes(saved.format) ? saved.format : "auto";
  function outputMode(row) { return format.value === "auto" ? origin(row) === "builtin:anima" || loadTheme().animaArtistFormatting === true ? "anima" : row.kind === "curated_style" ? "natural" : "raw" : format.value; }
  const syntaxHelp = make("details", "pp-style-manage"); syntaxHelp.append(make("summary", "", "How prompt language works"), make("p", "pp-sidebar-note", "Checkpoint support is unknown. Follow editor uses @ for the Anima collection or the existing Anima artist setting; technique presets otherwise use readable text. Artist names retain @ only for Anima, and ordinary Booru tags stay literal. No quality or negative tags are added automatically."));
  const discoveries = make("div", "pp-style-discovery"); discoveries.setAttribute("aria-label", "Explore creative disciplines");
  const explore = make("details", "pp-style-manage pp-style-explore"); explore.append(make("summary", "", "Explore disciplines"), discoveries); browse.append(explore);
  const filters = make("details", "pp-style-manage pp-style-filters"); filters.append(make("summary", "", "Refine collection")); browse.append(filters); filters.append(explore, format.parentElement, syntaxHelp);
  const filterGrid = make("div", "pp-style-facet-grid"); filters.append(filterGrid);
  const facetSelects = new Map();
  for (const [key, title, help] of FACET_GROUPS) { const field = label(title, select([["", `All ${title.toLowerCase()}`]]), filterGrid); field.title = help; facetSelects.set(key, field); field.addEventListener("change", () => { page = 0; render(); }); }
  const support = label("Model evidence", select([["", "Any evidence status"], ["vocabulary", "Technique vocabulary · unverified"], ["unknown", "Artist / tag support · unknown"]]), filterGrid);
  const facetInput = label("Require all labels (comma separated)", make("input"), filters); facetInput.placeholder = "e.g. linework, limited palette";
  const min = label("Minimum posts (0 includes unknown)", make("input"), filterGrid); min.type = "number"; min.min = "0"; min.step = "1"; min.value = "0";
  const sort = label("Order", select([["source", "Collection order"], ["count", "Most posts"], ["name", "Name A–Z"]]), filterGrid);
  const prefix = label("Optional quality prefix · manual choice", make("input"), filters); prefix.placeholder = "None · e.g. score_9, score_8_up"; prefix.maxLength = 500; prefix.value = typeof saved.prefix === "string" ? saved.prefix : "";
  filters.append(make("p", "pp-sidebar-note", "Facets combine with AND and only describe available catalog evidence. Artists with no documented labels remain searchable when facets are cleared. Quality prefixes are checkpoint-specific literal text."));
  const actions = make("div", "pp-sidebar-actions"); browse.append(actions);
  const surpriseButton = button("Surprise me", () => { if (matches.length) details(matches[Math.floor(Math.random() * matches.length)]); });
  const labButton = button("Style Lab 0/4", () => openLab());
  actions.append(button("Reset", clearFilters), surpriseButton, labButton);
  const source = make("p", "pp-sidebar-note pp-style-source");
  const count = make("p", "pp-sidebar-note pp-style-count"); count.setAttribute("role", "status"); count.setAttribute("aria-live", "polite"); browse.append(count);
  const resultBar = make("div", "pp-style-result-bar"); browse.append(resultBar); resultBar.append(count);
  const imageScope = make("label", "pp-style-image-scope"), includeUnillustrated = make("input"); includeUnillustrated.type = "checkbox"; includeUnillustrated.title = "Include entries without preview images"; includeUnillustrated.checked = saved.includeUnillustrated === true;
  imageScope.append(includeUnillustrated, make("span", "", "Show all entries")); resultBar.append(imageScope);
  includeUnillustrated.addEventListener("change", () => { writeEditorPreference(KEY, { ...readEditorPreference(KEY, {}), includeUnillustrated: includeUnillustrated.checked }); page = 0; render(); });
  const cards = make("div", "pp-style-cards"); browse.append(cards);
  const virtual = new VirtualCollectionManager(host);
  let columns = 1;
  const pages = make("div", "pp-sidebar-actions pp-style-pages"), pageLabel = make("span", "pp-sidebar-note");
  const previous = button("Previous", () => { page--; paintPage(); cards.scrollIntoView({ block: "start" }); });
  const next = button("Next", () => { page++; paintPage(); cards.scrollIntoView({ block: "start" }); }); pages.append(previous, pageLabel, next); browse.append(pages);
  const manage = make("details", "pp-style-manage"); manage.append(make("summary", "", "Local indexes, backups & credits")); browse.append(manage);
  const importInput = make("input"); importInput.type = "file"; importInput.accept = ".json,application/json"; importInput.hidden = true;
  const fileActions = make("div", "pp-sidebar-actions"); manage.append(controls, source, fileActions, importInput);
  fileActions.append(button("Import JSON index", () => importInput.click()), button("Export collection", () => exportIndex(false)), button("Export favorites here", () => exportIndex(true)), button("Reload local data", async () => { resetCustomWords(); await refreshIndexes(indexId); }));
  manage.append(make("p", "pp-sidebar-note", "CSV and custom-word imports use the existing Custom Words manager and appear in My CSV / custom words. JSON indexes accept names or entries with exact tags, notes and optional raster previews. Imports create a separate local index and never replace shipped defaults. Export includes user previews and metadata."));
  manage.append(make("p", "pp-sidebar-note", "Bundled previews include public-domain / CC0 references and credited MIT-licensed Anima explorer samples. Open Info for the work, creator, source and rights. Credits and the complete image inventory are included in STYLE_IMAGE_CREDITS.md and the local asset manifest. Reference images illustrate visual vocabulary; they are not checkpoint results. Entries without a verified matching image remain available for prompting and personal previews. The separate Anima artist-name snapshot retains its attribution in assets/styles/ThetaCursed-LICENSE.txt."));
  const inspector = make("section", "pp-style-inspector"); inspector.hidden = true; host.append(inspector);
  const lab = make("section", "pp-style-lab"); lab.hidden = true; host.append(lab);
  const benchmark = select(Object.keys(BENCHMARKS).map(k => [k, k[0].toUpperCase() + k.slice(1)])); benchmark.value = Object.hasOwn(BENCHMARKS, saved.benchmark) ? saved.benchmark : "object";
  const common = saved.common && typeof saved.common === "object" ? saved.common : {};
  const sharedFields = new Map();
  let measuredWidth = 0;
  const resizeObserver = new ResizeObserver(() => {
    const width = cards.clientWidth;
    // A width change matters even when the number of columns stays the same.
    if (!width || Math.abs(width - measuredWidth) < 1) return;
    measuredWidth = width;
    if (loaded && !loading && !browse.hidden) paintPage();
  }); resizeObserver.observe(cards);

  function persist() {
    // Keep preview bytes in the existing backend store, not in localStorage.
    const slim = compare.map(r => { const { thumbnail, search, facetTags, ...rest } = r; return rest; });
    writeEditorPreference(KEY, { schema: 2, index: indexId, artistSource, view, includeUnillustrated: includeUnillustrated.checked, format: format.value, prefix: prefix.value, compare: slim, benchmark: benchmark.value, common: sharedFields.size ? Object.fromEntries([...sharedFields].map(([k, f]) => [k, f.value])) : common });
  }
  function clearFilters() { search.value = ""; min.value = "0"; facetInput.value = ""; support.value = ""; for (const field of facetSelects.values()) field.value = ""; page = 0; render(); }
  function updateFacetOptions() {
    facetOptions = new Map(FACET_GROUPS.map(([key]) => [key, new Set()]));
    for (const row of rows) for (const [key, values] of Object.entries(row.facets || {})) for (const value of values) facetOptions.get(key)?.add(value);
    for (const [key, field] of facetSelects) { const previous = field.value; field.replaceChildren(new Option(`All ${FACET_GROUPS.find(r => r[0] === key)[1].toLowerCase()}`, "")); for (const value of [...facetOptions.get(key)].sort()) field.append(new Option(value, value)); field.value = [...field.options].some(o => o.value === previous) ? previous : ""; field.disabled = !facetOptions.get(key).size; }
    discoveries.replaceChildren();
    if (indexId === "builtin:visual") for (const [discipline, slug] of [["watercolor", "transparent-washes"], ["ink & print", "cross-hatching"], ["graphic design", "art-deco-geometry"], ["botanical & scientific", "herbarium-plate"], ["architecture & worlds", "mediterranean-courtyard"], ["3d & product", "low-poly-scene"]]) {
      const row = catalog?.entries?.find(r => r.id === slug); if (!row) continue;
      const b = button("", () => { facetSelects.get("discipline").value = discipline; filters.open = true; page = 0; render(); cards.scrollIntoView({ block: "nearest" }); }, "pp-style-discovery-card");
      b.append(preview(row), make("span", "", discipline)); discoveries.append(b);
    }
  }
  function render() {
    if (disposed || loading || !loaded) return;
    const facets = Object.fromEntries([...facetSelects].map(([key, field]) => [key, field.value])); facets.compatibility = support.value;
    const referenceCollection = rows.some(row => row.asset || row.thumbnail); imageScope.hidden = !referenceCollection;
    matches = filterStyles(rows, { query: search.value, tags: facetInput.value.split(",").map(normalizeStyleText).filter(Boolean), facets, previews: referenceCollection && !includeUnillustrated.checked, minCount: Math.max(0, Number(min.value) || 0), sort: sort.value });
    page = Math.min(page, Math.max(0, Math.ceil(matches.length / PAGE) - 1));
    count.textContent = `${matches.length.toLocaleString()} ${referenceCollection && !includeUnillustrated.checked ? "visual references" : "entries"} · ${rows.length.toLocaleString()} in collection${Object.values(facets).some(Boolean) || search.value || facetInput.value || Number(min.value) ? " · filtered" : ""}`;
    discoveries.hidden = !!(search.value || Object.values(facets).some(Boolean) || facetInput.value);
    explore.hidden = discoveries.hidden || !discoveries.childElementCount;
    surpriseButton.disabled = !matches.length || loading;
    paintPage(); updateLabButton();
  }
  function updateLabButton() { labButton.textContent = `Style Lab ${compare.length}/4`; }
  function displayKey() { return indexId === "custom" ? "custom" : view; }
  let displayGeometry = "";
  function paintPage() {
    if (disposed || loading || !loaded) return;
    measuredWidth = cards.clientWidth;
    const oldScroll = host.scrollTop;
    const oldAnchor = virtual.captureViewportAnchor(cards.classList.contains("is-list") ? 1 : columns);
    const ui = parseFloat(getComputedStyle(host).getPropertyValue("--wg-ui-font-scale")) || 1;
    const metrics = sidebarDisplayMetrics(displayKey(), ui), isList = metrics.mode === "list";
    const nextGeometry = `${metrics.mode}|${metrics.scale}|${ui}|${cards.clientWidth}`;
    const anchor = nextGeometry !== displayGeometry ? oldAnchor : null;
    displayGeometry = nextGeometry;
    virtual.clear(); cards.replaceChildren();
    cards.dataset.density = metrics.scale < .45 ? "micro" : "normal";
    cards.classList.remove("is-compact"); cards.classList.toggle("is-list", isList); cards.classList.toggle("is-small", metrics.scale < .85);
    cards.style.setProperty("--pp-library-scale", metrics.scale); cards.style.setProperty("--pp-library-font-scale", metrics.font);
    columns = isList ? 1 : Math.max(1, Math.floor((cards.clientWidth + 10) / metrics.cardWidth));
    const chrome = loadSidebarDisplay().chrome;
    const width = Math.max(70, (cards.clientWidth - (columns - 1) * 10) / columns);
    const imageHeight = chrome.images ? Math.round(width * (metrics.scale < .45 ? .7 : 1.02)) : 0;
    const cardHeight = Math.ceil(imageHeight + (metrics.scale < .45 ? 72 : 110) * metrics.font * ui + (metrics.scale >= .45 && chrome.prompt ? 49 * ui : 0) + (metrics.scale >= .45 && chrome.descriptions ? 42 * ui : 0));
    cards.style.setProperty("--pp-style-columns", columns); cards.style.setProperty("--pp-style-row-height", `${isList ? metrics.rowHeight : cardHeight}px`);
    cards.style.setProperty("--pp-style-image-height", `${imageHeight}px`);
    const slice = isList ? matches : matches.slice(page * PAGE, (page + 1) * PAGE), groups = [];
    if (!isList) for (let i = 0; i < slice.length; i += columns) groups.push(slice.slice(i, i + columns));
    if (!matches.length) cards.append(make("p", "pp-sidebar-empty", indexId === "favorites" ? "No favorites yet. Star a style, artist or tag to collect it here." : indexId === "previews" ? "Your previews will appear here. Use a card’s pencil to attach a local image." : "No matches. Clear filters to include artists with unknown labels and counts."));
    else virtual.mount(cards, { items: isList ? slice : groups, mode: "list", estimateRowHeight: isList ? metrics.rowHeight : cardHeight, overscan: 1,
      captureFocus: () => { const el = document.activeElement, article = el?.closest?.(".pp-style-card"); return cards.contains(el) && article ? { element: el, tag: article.dataset.styleTag, label: el.getAttribute("aria-label"), text: el.textContent } : null; },
      restoreFocus: snap => { if (!snap || snap.element.isConnected) return; const article = [...cards.querySelectorAll(".pp-style-card")].find(el => el.dataset.styleTag === snap.tag); const next = [...article?.querySelectorAll("button") || []].find(el => snap.label ? el.getAttribute("aria-label") === snap.label : el.textContent === snap.text); (next || host).focus({ preventScroll: true }); },
      renderItem: isList ? row => card(row, true) : group => { const el = make("div", "pp-style-card-row"); for (const row of group) el.append(card(row)); return el; } });
    previous.disabled = page <= 0; next.disabled = (page + 1) * PAGE >= matches.length;
    pages.hidden = isList; pageLabel.textContent = `Page ${page + 1} / ${Math.max(1, Math.ceil(matches.length / PAGE))}`;
    host.scrollTop = oldScroll; virtual.restoreViewportAnchor(anchor, isList ? 1 : columns); virtual.refresh();
  }
  function preview(row, large = false) {
    const name = String(row.name || row.tag || "Style"), url = stylePreviewUrl(row), fallback = () => { const el = make("div", "pp-style-no-preview"); el.append(make("span", "pp-style-monogram", name.slice(0, 2).toUpperCase()), make("small", "", row.kind === "curated_style" ? "Technique recipe" : `${row.category || "tag"} · no preview`)); return el; };
    if (!url) return fallback();
    const img = make("img", `pp-style-preview${large ? " is-large" : ""}${row.asset && row.previewKind === "reference" ? " is-reference" : ""}`); img.src = url; img.alt = row.provenance?.title ? `${row.provenance.title} — ${row.provenance.author || "reference image"}` : `${PREVIEW_LABELS[row.previewKind] || "User preview"} for ${row.name}`; img.title = [row.provenance?.title, row.provenance?.author, row.provenance?.license].filter(Boolean).join(" · "); img.loading = "lazy"; img.decoding = "async"; img.width = 512; img.height = 336;
    img.addEventListener("error", () => { const el = fallback(); el.append(make("small", "", "Preview unavailable")); img.replaceWith(el); }, { once: true }); return img;
  }
  async function add(row, replace = false) { const text = styleOutput(row, outputMode(row), prefix.value); if (await insert(text, { replace })) recordInsertedTags(styleOutput(row, outputMode(row)), row.category); }
  async function copyText(text) { try { await navigator.clipboard.writeText(text); announce("Prompt copied."); } catch { announce("Clipboard unavailable. Select the displayed prompt and copy it.", true); } }
  function card(row, list = false) {
    const el = make("article", `pp-style-card${list ? " pp-style-row" : ""}`); el.dataset.styleTag = row.tag;
    const primary = button("", () => add(row), "pp-style-card-add"); primary.setAttribute("aria-label", `Add ${row.name} to prompt`); primary.title = `Will insert: ${styleOutput(row, outputMode(row), prefix.value)}`;
    if (loadSidebarDisplay().chrome.images) primary.append(preview(row));
    primary.append(make("strong", "pp-style-title", row.name)); primary.querySelector(".pp-style-title").title = row.name; el.append(primary);
    if (!list) {
      const credit = make("small", "pp-style-kind", row.asset && row.previewKind === "reference" ? `${row.provenance?.model ? "Anima · published reference" : row.category === "artist" ? "Artist reference" : "Visual reference"}` : PREVIEW_LABELS[row.previewKind] || "No preview"); credit.title = [row.provenance?.title, row.provenance?.author, row.provenance?.institution].filter(Boolean).join(" · "); el.append(credit);
      el.append(make("p", "pp-style-description", row.description || (row.count == null ? "Exact catalog tag · model recognition unknown" : `${row.count.toLocaleString()} posts · model recognition unknown`)));
      el.append(make("small", "pp-style-will-insert", "Will insert:"));
    }
    const code = make("code", "pp-style-output", styleOutput(row, outputMode(row), prefix.value)); code.title = `Will insert: ${code.textContent}`;
    if (list) { primary.append(code); const kind = make("small", "pp-style-kind pp-sr-only", PREVIEW_LABELS[row.previewKind] || "No preview"); el.append(kind); } else el.append(code);
    const bar = make("div", "pp-sidebar-actions pp-style-card-actions");
    const pin = button(row.favorite ? "★" : "☆", async () => { pin.disabled = true; try { await save(row, { favorite: !row.favorite }); } finally { pin.disabled = false; } }); pin.title = `Favorite ${row.name}`; pin.setAttribute("aria-label", `Favorite ${row.name}`); pin.setAttribute("aria-pressed", String(!!row.favorite));
    const info = button(list ? "i" : "Info", () => details(row, info)); info.setAttribute("aria-label", `Details for ${row.name}`); info.dataset.styleDetails = "true";
    const pencil = button("✎", () => edit(row, pencil)); pencil.title = `Edit preview and labels for ${row.name}`; pencil.setAttribute("aria-label", `Edit preview and labels for ${row.name}`);
    const compareButton = button(compare.some(r => identity(r) === identity(row)) ? "✓ Lab" : "+ Lab", () => toggleCompare(row)); compareButton.title = `Compare ${row.name} in Style Lab`; compareButton.dataset.styleCompare = "true"; compareButton.setAttribute("aria-label", `Compare ${row.name}`); compareButton.setAttribute("aria-pressed", String(compare.some(r => identity(r) === identity(row))));
    pin.innerHTML = svgIcon("pin", 14); info.innerHTML = svgIcon("eye", 14); pencil.innerHTML = svgIcon("edit", 14); compareButton.innerHTML = svgIcon("select", 14);
    bar.append(pin, info, pencil, compareButton); el.append(bar); return el;
  }
  function showPanel(panel, trigger) { returnFocus = trigger || document.activeElement; browse.hidden = true; inspector.hidden = panel !== inspector; lab.hidden = panel !== lab; panel.replaceChildren(); host.scrollTop = 0; }
  function back() { editSerial++; inspector.hidden = true; lab.hidden = true; browse.hidden = false; paintPage(); returnFocus?.isConnected ? returnFocus.focus({ preventScroll: true }) : search.focus({ preventScroll: true }); }
  function provenanceView(row, panel) {
    panel.append(make("p", "pp-sidebar-note", row.previewKind === "illustration" ? "Original technique illustration. This is a graphic study, not a render from Anima or any checkpoint." : row.previewKind === "model_sample" ? "Recorded model sample: an actual image associated with metadata and explicit local-generation confirmation by its importer. Prompt Palette cannot independently prove the render origin." : row.previewKind === "reference" ? row.asset ? "Bundled visual reference. Open the credits below for its creator, license and context. Published Anima references show the source explorer’s model interpretation; they are not original artwork by the named artist or a guarantee for your checkpoint." : "Reference artwork with user-supplied rights metadata. It does not predict what this tag produces in a model." : row.previewKind === "user" ? "Personally assigned user preview. No model-validation claim." : "No verified matching preview is bundled. You can attach your own image using Edit / Replace Preview."));
    const data = row.provenance || {}, dl = make("dl", "pp-style-provenance");
    for (const [key, title] of [["title", "Work / image"], ["author", "Creator"], ["date", "Date"], ["institution", "Collection"], ["source", "Source"], ["license", "License"], ["rightsURL", "Rights record"], ["referenceNote", "Reference use"], ["model", "Model"], ["checkpoint", "Checkpoint / hash"], ["tag", "Exact catalog tag"], ["styleText", "Inserted style"], ["subjectPrompt", "Benchmark subject"], ["prompt", "Actual render prompt"], ["seed", "Seed"], ["settings", "Settings"], ["imageSha256", "Preview SHA-256"], ["recordedAt", "Recorded"]]) if (data[key]) {
      const dd = make("dd", "", data[key]);
      if (["source", "rightsURL"].includes(key) && /^https:\/\/[^\s]+$/.test(data[key])) { const a = make("a", "", key === "source" ? "View original source ↗" : "View rights statement ↗"); a.href = data[key]; a.target = "_blank"; a.rel = "noopener noreferrer"; dd.replaceChildren(a); }
      dl.append(make("dt", "", title), dd);
    }
    if (dl.children.length) { const disclosure = make("details", "pp-style-manage"); disclosure.append(make("summary", "", "Preview provenance & credits"), dl); panel.append(disclosure); }
  }
  function details(row, trigger) {
    showPanel(inspector, trigger); inspector.append(button("← Back to collection", back, "pp-sidebar-back"), make("h3", "", row.name), preview(row, true), make("strong", "pp-style-kind", PREVIEW_LABELS[row.previewKind]), make("p", "pp-style-description", row.description || "Exact catalog vocabulary. This directory does not infer an artist’s style, biography or checkpoint compatibility."));
    const facets = make("dl", "pp-style-provenance"); for (const [key, title] of FACET_GROUPS) if (row.facets?.[key]?.length) facets.append(make("dt", "", title), make("dd", "", row.facets[key].join(" · "))); inspector.append(facets, make("p", "pp-sidebar-note", row.compatibility || "Checkpoint support unknown"), make("small", "", "Will insert:"), make("code", "pp-style-output", styleOutput(row, outputMode(row), prefix.value)));
    const actions = make("div", "pp-sidebar-actions"); actions.append(button("Add to Prompt", () => add(row), "primary"), button("Copy Prompt", () => copyText(styleOutput(row, outputMode(row), prefix.value))), button(row.favorite ? "★ Favorited" : "☆ Favorite", async () => { const item = await save(row, { favorite: !row.favorite }); if (item) details(item, trigger); }), button("Edit / Replace Preview", () => edit(row, trigger)), button("Reset Preview", async () => { const item = await save(row, { resetPreview: true }); if (item) details(item, trigger); }), button("Compare in Style Lab", () => { if (!compare.some(r => identity(r) === identity(row)) && !toggleCompare(row)) return; openLab(); })); inspector.append(actions); provenanceView(row, inspector); inspector.querySelector("button").focus({ preventScroll: true });
  }
  async function save(row, changes) {
    const id = origin(row), key = identity(row), request = version;
    try {
      const value = await API.saveStyleAnnotation({ index: id, tag: row.tag, ...changes });
      if (disposed) return null;
      let base = catalog?.entries?.find(r => r.tag === row.tag && (r.originIndex || indexId) === id) || row;
      if (changes.resetPreview || indexId === "favorites" || indexId === "previews") {
        if (id !== "custom") { const defaults = await API.styleIndexes(id); base = defaults.entries.find(r => r.tag === row.tag) || { ...row, asset: "", thumbnail: "", previewKind: "none", provenance: {} }; }
        else base = { ...row, asset: "", thumbnail: "", previewKind: "none", provenance: {} };
      }
      const updated = decorateStyle(base, value); updated.originIndex = id;
      compare = compare.map(r => identity(r) === key ? updated : r); persist(); updateLabButton();
      if (request === version) {
        if (indexId === "favorites" || indexId === "previews") await load(indexId, true);
        else { edits[row.tag] = value; const at = byKey.get(key); if (at != null) rows[at] = updated; render(); }
      }
      announce("Saved locally."); return updated;
    } catch (error) { if (!disposed) announce(error.message, true); return null; }
  }
  function edit(row, trigger, sample = null) {
    showPanel(inspector, trigger); const session = ++editSerial;
    inspector.append(button("← Back to collection", back, "pp-sidebar-back"), make("h3", "", `Your preview · ${row.name}`));
    const imageHost = make("div", "pp-style-edit-image"); imageHost.append(preview(row, true)); inspector.append(imageHost);
    const tags = label("Your descriptive labels", make("input"), inspector); tags.value = (row.tags || []).join(", "); tags.maxLength = 6000;
    const notes = label("Notes / description", make("textarea"), inspector); notes.value = row.description || ""; notes.maxLength = 2000; notes.rows = 3;
    const photo = label("Choose a local preview", make("input"), inspector); photo.type = "file"; photo.accept = "image/png,image/jpeg,image/webp";
    const kind = label("Preview type", select([["user", "User preview · no validation claim"], ["reference", "Reference artwork · documented rights"], ["model_sample", "Model sample · recorded local render"]]), inspector); kind.value = sample ? "model_sample" : ["reference", "model_sample"].includes(row.previewKind) ? row.previewKind : "user";
    let thumbnail = row.thumbnail || "", imageChanged = false, reading = false, photoVersion = 0;
    kind.disabled = !!row.asset && !thumbnail;
    const photoStatus = make("small", "pp-sidebar-note", sample ? "Attach the actual generated image and confirm its metadata. A prompt plan alone is not a model sample." : row.asset ? "Edit labels and notes directly. Bundled artwork keeps its source credits; attach a replacement image to change preview type or credits." : "An uploaded raster is saved as a small local preview. Bundled defaults stay separate."); inspector.append(photoStatus);
    const metadata = make("div", "pp-style-metadata"); inspector.append(metadata);
    const fields = new Map(), original = sample || row.provenance || {};
    for (const [key, title, limit] of [["source", "Source / local render filename", 1000], ["author", "Creator", 300], ["license", "Redistribution license / rights", 300], ["model", "Model family / name", 300], ["checkpoint", "Checkpoint filename / hash (if known)", 300], ["prompt", "Actual render prompt (exact)", 8000], ["styleText", "Style text used (exact)", 2000], ["subjectPrompt", "Benchmark subject", 2000], ["seed", "Seed (exact)", 100], ["settings", "Sampler, scheduler, steps, CFG, resolution and other settings", 4000]]) { const input = label(title, make(["prompt", "settings"].includes(key) ? "textarea" : "input"), metadata); input.value = original[key] || (key === "styleText" ? styleOutput(row, outputMode(row), prefix.value) : ""); input.maxLength = limit; fields.set(key, input); }
    const confirmed = make("input"); confirmed.type = "checkbox"; const confirmation = label("I generated this image locally with the exact style/tag, prompt, seed and settings recorded above.", confirmed, inspector); const confirmLabel = confirmation.parentElement;
    function showMetadata() { for (const [key, input] of fields) { input.parentElement.hidden = kind.value === "user" || kind.value === "reference" && !["source", "author", "license"].includes(key); input.disabled = !!row.asset && !imageChanged && !thumbnail; } confirmLabel.hidden = kind.value !== "model_sample"; }
    kind.addEventListener("change", showMetadata); showMetadata();
    const saveButton = button("Save labels & preview", async () => {
      if (reading) return;
      if (sample && !imageChanged) { announce("Attach the actual generated image first.", true); return; }
      if (kind.value === "model_sample" && !confirmed.checked) { announce("Confirm that this is your actual local render with the recorded settings.", true); return; }
      const bundledUnchanged = !!row.asset && !imageChanged && !thumbnail;
      if (kind.value !== "user" && !thumbnail && !(bundledUnchanged && kind.value === "reference")) { announce("Attach an image before assigning provenance.", true); return; }
      saveButton.disabled = true;
      const changes = { tags: tags.value.split(",").map(t => t.trim()).filter(Boolean), description: notes.value };
      // Editing labels alone does not turn a bundled reference into a removed
      // or user preview. Explicit removal/replacement is a separate action.
      if (!bundledUnchanged && (imageChanged || thumbnail || kind.value !== "user")) { changes.thumbnail = thumbnail; changes.previewKind = thumbnail ? kind.value : "none"; changes.provenance = { ...Object.fromEntries([...fields].map(([k, f]) => [k, f.value])), tag: row.tag, confirmed: confirmed.checked }; }
      const updated = await save(row, changes); saveButton.disabled = false; if (updated && session === editSerial && !disposed) details(updated, trigger);
    }, "primary");
    photo.addEventListener("change", async () => {
      const file = photo.files?.[0]; if (!file) return;
      const request = ++photoVersion; reading = true; saveButton.disabled = true; photoStatus.textContent = "Preparing a local raster preview…"; confirmed.checked = false;
      try { const data = await prepareStyleThumbnail(file); if (session !== editSerial || request !== photoVersion || disposed) return; thumbnail = data; imageChanged = true; kind.disabled = false; if (row.asset) { if (fields.get("source").value === original.source) fields.get("source").value = file.name; for (const key of ["author", "license"]) if (fields.get(key).value === original[key]) fields.get(key).value = ""; } showMetadata(); if (!fields.get("source").value || fields.get("source").value === "User-associated local render") fields.get("source").value = file.name; imageHost.replaceChildren(preview({ ...row, asset: "", thumbnail, previewKind: kind.value }, true)); photoStatus.textContent = "Preview ready. Save to retain this image and metadata."; }
      catch (error) { if (session === editSerial && !disposed) { photoStatus.textContent = error.message; announce(error.message, true); } }
      finally { if (request === photoVersion) { reading = false; saveButton.disabled = false; } }
    });
    const bar = make("div", "pp-sidebar-actions"); bar.append(saveButton, button("Remove preview", () => { photoVersion++; reading = false; saveButton.disabled = false; thumbnail = ""; imageChanged = true; photo.value = ""; kind.disabled = false; kind.value = "user"; confirmed.checked = false; showMetadata(); imageHost.replaceChildren(preview({ ...row, asset: "", thumbnail: "", previewKind: "none" }, true)); photoStatus.textContent = "Preview removed from draft. Save to apply."; }), button("Reset to Default", async () => { const updated = await save(row, { resetPreview: true }); if (updated && session === editSerial) details(updated, trigger); }), button("Cancel", back)); inspector.append(bar); tags.focus({ preventScroll: true });
  }
  function toggleCompare(row) {
    const key = identity(row), at = compare.findIndex(r => identity(r) === key);
    if (at >= 0) compare.splice(at, 1);
    else { if (compare.length >= 4) { announce("Style Lab holds up to four candidates. Remove one to add another.", true); return false; } compare.push({ ...row, originIndex: origin(row) }); }
    persist(); updateLabButton(); paintPage(); return true;
  }
  function openLab() {
    editSerial++; showPanel(lab); lab.append(button("← Back to collection", back, "pp-sidebar-back"), make("h3", "", "Style Lab"), make("p", "pp-sidebar-note", "Choose 2–4 candidates. Every prompt uses the same subject. Send one to your existing workflow, apply identical generation settings there, then attach the actual result. Sending replaces the selected target field and remains undoable."));
    label("Shared benchmark subject", benchmark, lab);
    const subject = make("p", "pp-style-output"); lab.append(subject);
    const settings = make("details", "pp-style-manage"); settings.append(make("summary", "", "Shared generation settings & comparison checklist")); lab.append(settings);
    for (const [key, title] of [["model", "Model / checkpoint family"], ["checkpoint", "Checkpoint / hash"], ["seed", "Fixed seed"], ["settings", "Sampler · scheduler · steps · CFG · resolution · LoRAs"], ["negative", "Shared negative prompt (checklist only)"]]) {
      let field = sharedFields.get(key); if (!field) { field = make(key === "settings" || key === "negative" ? "textarea" : "input"); field.value = common[key] || ""; field.maxLength = 4000; sharedFields.set(key, field); field.addEventListener("input", persist); } label(title, field, settings);
    }
    settings.append(make("p", "pp-sidebar-note", "Apply these settings in ComfyUI yourself. No queue or scheduler is called. Use a plain positive editor or isolate the workspace field so other fields do not change the benchmark. Disable random seed changes and keep negative prompt, resolution, LoRAs and sampler settings equal."));
    const language = make("p", "pp-sidebar-note", `Language: ${format.options[format.selectedIndex].text}. Quality prefix: ${prefix.value || "none"}. Change these in the collection before comparing.`); lab.append(language);
    const candidateHost = make("div", "pp-style-lab-candidates"); lab.append(candidateHost);
    function paintCandidates() {
      subject.textContent = BENCHMARKS[benchmark.value]; candidateHost.replaceChildren();
      if (compare.length < 2) candidateHost.append(make("p", "pp-sidebar-empty", `Select ${2 - compare.length} more candidate${compare.length ? "" : "s"} with + Lab on the collection cards. Your tray remains saved while you browse.`));
      for (const row of compare) {
        const item = make("article", "pp-style-lab-item"), text = comparisonPrompt(row, benchmark.value, outputMode(row), prefix.value);
        const previewLabel = stylePreviewUrl(row) ? PREVIEW_LABELS[row.previewKind] || "User preview" : "Saved prompt plan · no preview loaded";
        item.append(make("strong", "", row.name), preview(row, true), make("small", "pp-style-kind", previewLabel));
        if (row.thumbnail) item.append(make("small", "pp-sidebar-note", "Recorded preview: it may use a different prompt or settings. Inspect its provenance in the collection before comparing model behavior."));
        const code = label("Exact comparison prompt", make("textarea", "pp-style-output"), item); code.value = text; code.readOnly = true; code.rows = 4;
        const bar = make("div", "pp-sidebar-actions"); bar.append(button("Send to target", async () => { if (await insert(text, { replace: true })) announce("Candidate sent to the selected target field. Apply the shared settings in your workflow before rendering."); }), button("Copy Prompt", () => copyText(text)), button("Attach Generated Image", () => edit(row, labButton, { prompt: text, styleText: styleOutput(row, outputMode(row), prefix.value), subjectPrompt: BENCHMARKS[benchmark.value], source: "User-associated local render", ...Object.fromEntries([...sharedFields].map(([k, f]) => [k, f.value])) })), button("Remove", () => { compare = compare.filter(r => identity(r) !== identity(row)); persist(); updateLabButton(); paintCandidates(); })); item.append(bar); candidateHost.append(item);
      }
    }
    benchmark.onchange = () => { persist(); paintCandidates(); }; paintCandidates();
    lab.append(button("Export Comparison Plan", () => downloadJsonFile("prompt-palette-style-comparison.json", { version: 1, previewKind: "prompt_plan", subject: BENCHMARKS[benchmark.value], format: format.value, prefix: prefix.value, sharedSettings: Object.fromEntries([...sharedFields].map(([k, f]) => [k, f.value])), candidates: compare.map(row => ({ index: origin(row), tag: row.tag, name: row.name, styleText: styleOutput(row, outputMode(row), prefix.value), prompt: comparisonPrompt(row, benchmark.value, outputMode(row), prefix.value) })) })));
    lab.querySelector("button").focus({ preventScroll: true });
  }
  async function load(id, preserve = false) {
    const group = artistIds.includes(id) ? "artists" : id;
    if (loadSidebarDisplay().chrome[group] === false) id = "builtin:visual";
    if (disposed) return;
    clearTimeout(timer);
    const request = ++version; indexId = id; loaded = false; loading = true;
    host.setAttribute("aria-busy", "true");
    view = id === "builtin:classic" ? "classic" : id === "builtin:anima" ? "anima" : id === "booru" ? "artists" : id === "tags" ? "tags" : id === "favorites" ? "favorites" : id === "previews" ? "previews" : "styles";
    if (artistIds.includes(id)) { artistSource = id; artistPicker.value = id; }
    artistBar.hidden = !artistIds.includes(id);
    artistPicker.disabled = false;
    artistHint.textContent = id === "builtin:anima" ? "Anima artist vocabulary. Follow editor inserts @artist; recognition depends on your checkpoint." : id === "booru" ? "Artist tags from the local Booru index. Follow editor respects your existing artist-format setting." : "Historical artists and reference works. Choose Natural language for descriptive prompts.";
    intro.querySelector("p").textContent = id === "tags" ? "Subjects, settings and details as literal tags. Search first, then add only what your image needs." : artistIds.includes(id) ? "One artist workspace. Choose the catalog that fits your workflow." : "Browse a look, inspect the exact text, then add it to your prompt.";
    search.placeholder = artistIds.includes(id) ? "Search this artist catalog…" : id === "tags" ? "Search Booru tags…" : "Search this collection…";
    indexes.value = id;
    indexes.title = indexes.selectedOptions[0]?.textContent || "Local collection";
    for (const [key, control] of collectionButtons) { const selected = key === id || key === "artists" && artistIds.includes(id); control.classList.toggle("is-selected", selected); control.setAttribute("aria-pressed", String(selected)); }
    intro.querySelector("h3").textContent = ({ "builtin:anima": "The Anima collection", "booru": "Discover artists", "tags": "A visual vocabulary", "builtin:classic": "The masters, up close", "favorites": "Your favorite finds", "previews": "Your own inspiration" })[id] || "Find your next look";
    onViewChanged(displayKey());
    if (!preserve) { editSerial++; inspector.hidden = lab.hidden = true; browse.hidden = false; search.value = ""; min.value = "0"; facetInput.value = ""; support.value = ""; for (const field of facetSelects.values()) field.value = ""; }
    rows = []; matches = []; catalog = null; virtual.clear(); cards.replaceChildren(); count.textContent = "Reading local collection…"; indexes.disabled = true; artistPicker.disabled = true; previous.disabled = next.disabled = surpriseButton.disabled = true; pageLabel.textContent = ""; pages.hidden = true;
    try {
      let data;
      if (id === "custom") { const words = await loadCustomWords(), grouped = new Map(); for (const word of words) { const entry = grouped.get(word.value) || { tag: word.value, name: word.value, kind: word.category === "artist" ? "artist" : "tag", category: word.category === "artist" ? "artist" : "general", insertKind: "custom", count: word.count || null, tags: [], aliases: [], description: "Imported custom word · literal value", thumbnail: "" }; if (word.text !== word.value) entry.aliases.push(word.text); grouped.set(word.value, entry); } data = { name: "My CSV / custom words", description: "Your existing local custom-word imports. Exact stored values remain literal.", source: "Existing Custom Words sources", entries: [...grouped.values()] }; }
      else data = await API.styleIndexes(id);
      if (disposed || request !== version) return;
      const annotations = ["favorites", "previews"].includes(id) ? {} : await API.styleAnnotations(id);
      if (disposed || request !== version) return;
      catalog = data; edits = Object.assign(Object.create(null), annotations); rows = []; byKey.clear();
      // Yield between batches once per load, rather than freeze typing while
      // building search strings for a large local catalog. Favorites update one row.
      for (let offset = 0; offset < data.entries.length; offset += 2000) { for (const base of data.entries.slice(offset, offset + 2000)) { const row = decorateStyle(base, Object.hasOwn(edits, base.tag) ? edits[base.tag] : {}); row.originIndex ||= id; byKey.set(identity(row), rows.length); rows.push(row); } if (data.entries.length > 2000) await tick(); if (disposed || request !== version) return; }
      source.textContent = `${data.description || ""} Source: ${data.source || "Local collection"}`;
      view = id === "builtin:classic" ? "classic" : id === "builtin:anima" ? "anima" : id === "booru" ? "artists" : id === "tags" ? "tags" : id === "favorites" ? "favorites" : id === "previews" ? "previews" : "styles";
      loaded = true; loading = false;
      if (!preserve) page = 0; updateFacetOptions(); persist(); render(); onViewChanged(displayKey());
    } catch (error) { if (!disposed && request === version) { loaded = false; catalog = null; rows = []; matches = []; virtual.clear(); cards.replaceChildren(); count.textContent = "Could not read this collection. Reload local data to retry."; announce(error.message, true); } }
    finally { if (!disposed && request === version) { loading = false; host.setAttribute("aria-busy", "false"); indexes.disabled = false; artistPicker.disabled = false; } }
  }
  async function refreshIndexes(preferred) {
    loading = true; host.setAttribute("aria-busy", "true");
    const started = version;
    try { const data = await API.styleIndexes(); if (disposed || started !== version) return; indexes.replaceChildren(); const special = ["builtin:visual", "builtin:classic", "builtin:anima", "booru", "tags"]; const items = data.items || []; for (const key of special) { const r = items.find(r => r.id === key); if (r) indexes.append(new Option(r.name, r.id)); } for (const r of items.filter(r => !special.includes(r.id))) indexes.append(new Option(r.name, r.id)); for (const [value, title] of [["custom", "My CSV / custom words"], ["favorites", "Favorites · all collections"], ["previews", "My Previews · all collections"]]) indexes.append(new Option(title, value)); const requested = started === version ? preferred : indexId; const group = artistIds.includes(requested) ? "artists" : requested; const wanted = loadSidebarDisplay().chrome[group] === false ? "builtin:visual" : requested; indexes.value = [...indexes.options].some(o => o.value === wanted) ? wanted : "builtin:visual"; if (started !== version) return; await load(indexes.value); refreshVisibility(); }
    catch (error) { if (!disposed && started === version) { loaded = false; loading = false; host.setAttribute("aria-busy", "false"); count.textContent = "Local collection unavailable. Use Reload local data to retry."; announce(error.message, true); } }
  }
  function exportIndex(onlyFavorites) {
    if (!catalog) return;
    const entries = rows.filter(r => !onlyFavorites || r.favorite).map(({ search, facetTags, favorite, originIndex, version, ...row }) => row);
    if (!entries.length) { announce("No entries to export.", true); return; }
    downloadJsonFile("prompt-palette-styles.json", { version: 2, name: catalog.name + (onlyFavorites ? " · favorites" : ""), description: catalog.description, source: catalog.source, entries }); announce("Collection exported. User previews and provenance are included; bundled SVG defaults remain in the extension.");
  }
  importInput.addEventListener("change", async () => { const file = importInput.files?.[0]; importInput.value = ""; if (!file) return; try { if (file.size > 32 * 1024 * 1024) throw new Error("Choose a JSON index under 32 MB."); const data = JSON.parse(await file.text()); const result = await API.importStyleIndex(Array.isArray(data) ? { name: file.name.replace(/\.json$/i, ""), entries: data } : data); if (!disposed) { await refreshIndexes(result.id); announce("Index imported locally. Existing defaults and user data were kept."); } } catch (error) { if (!disposed) announce(error.message, true); } });
  indexes.addEventListener("change", () => load(indexes.value));
  for (const input of [search, facetInput, min]) input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => { page = 0; render(); }, 120); });
  for (const field of [sort, support]) field.addEventListener("change", () => { page = 0; render(); });
  for (const field of [format, prefix]) field.addEventListener(field === prefix ? "input" : "change", () => { persist(); paintPage(); });
  host.addEventListener("keydown", onKey);
  function onKey(event) {
    if (event.key === "Escape" && (!inspector.hidden || !lab.hidden)) { event.preventDefault(); event.stopPropagation(); back(); return; }
    if (!event.target.classList?.contains("pp-style-card-add") || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    const buttons = [...cards.querySelectorAll(".pp-style-card-add")], at = buttons.indexOf(event.target), delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns }[event.key]; const next = buttons[at + delta]; if (next) { event.preventDefault(); event.stopPropagation(); next.focus(); }
  }
  refreshVisibility();
  updateLabButton();
  return { async activate() { if (disposed || loading) return; if (!loaded) await refreshIndexes(indexId); else paintPage(); }, displayKey, refreshVisibility, refreshAppearance() { if (loaded && !browse.hidden) paintPage(); }, cleanup() { disposed = true; version++; editSerial++; clearTimeout(timer); resizeObserver.disconnect(); virtual.cleanup(); host.removeEventListener("keydown", onKey); } };
}
