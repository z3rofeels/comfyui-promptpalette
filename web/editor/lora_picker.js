import { openCtxMenu } from "./context_menu.js";
import { colorForLora, textColorForLora, loraIdentity } from "./lora_colors.js";
import { sanitizeHexColor } from "./text_utils.js";
import { onPromptPaletteAppearanceChanged, svgIcon } from "../prompt_palette_shared.js";
import { loadTheme, saveTheme } from "./preferences.js";
import { API } from "../prompt_palette_api.js";
import { createLoraPreviews } from "./lora_preview.js";
import { readEditorPreference, writeEditorPreference } from "../prompt_palette_state.js";
import { buildLoraExpression, formatLoraTag, loraAt, loraTags, standaloneLoraTags } from "../engine/lora_tags.js";

const mutedByEditor = new WeakMap();

const make = (tag, cls = "", text = "") => { const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; };
const button = (text, fn, cls = "wg-button", icon = "") => {
  const b = make("button", cls);
  b.type = "button";
  if (icon) b.innerHTML = `${svgIcon(icon, 12)}<span>${text}</span>`;
  else b.textContent = text;
  if (fn) b.addEventListener("click", fn);
  return b;
};
function field(label, input, cls = "pp-tool-field pp-lora-field") { const e = make("label", cls); e.append(make("span", "pp-lora-field-label", label), input); return e; }
function select(options, value, cls = "pp-lora-select") {
  const e = make("select", cls);
  for (const [key, label] of options) {
    const o = make("option", "", label);
    o.value = key;
    e.append(o);
  }
  e.value = value;
  return e;
}

export function createLoraPicker({ host, editor, context, snapshot, guard, close, message, keepOpen = false, applied = () => {}, variation = null, draft = null }) {
  let current = loraAt(snapshot.source, snapshot.start);
  let target = current && snapshot.end <= current.end ? current : snapshot;
  let names = [], folders = [];
  let selected = new Set(current ? [current.name] : draft?.names || []);
  let dead = false, pending = null, revision = 0;
  let detailName = "", detailRevision = 0, previewRevision = 0;
  let searchRevision = 0, searchTimer = 0;
  const metadataPending = new Set();
  if (!mutedByEditor.has(editor)) mutedByEditor.set(editor, new Map());
  const mutedStrengths = mutedByEditor.get(editor);
  const identity = name => { try { return decodeURIComponent(name).replace(/\\/g, "/"); } catch { return name.replace(/\\/g, "/"); } };
  const catalogName = name => {
    const normalized = identity(name);
    const exact = names.find(n => identity(n) === normalized);
    if (exact) return exact;
    const matches = names.filter(n => identity(n).replace(/\.[^./]+$/, "") === normalized);
    return matches.length === 1 ? matches[0] : name;
  };
  const previewUrl = (name, options) => `${API.loraPreviewUrl(catalogName(name), options)}&v=${previewRevision}`;
  const previews = createLoraPreviews(previewUrl, {
    probe: (name, options) => API.loraPreviewProbe(catalogName(name), options),
    customBlob: (name, options) => API.loraPreviewBlob(catalogName(name), options),
    onError: (name, error) => { if (!dead) message(`${identity(name).split("/").pop()}: ${error}`, true); },
  });
  function ensureEditable() {
    guard();
    if (editor.readOnly || editor.disabled || editor.getAttribute("aria-readonly") === "true") throw new Error("This editor is read-only.");
  }


  host.classList.add("pp-lora-picker");

  // Read preferences
  const stored = readEditorPreference("lora-picker", {});
  const prefs = {
    // Recover the old buried "off" flag once. Future choices use the visible switch.
    images: stored?.previewControlVersion === 1 ? stored.images !== false : true,
    favorites: Array.isArray(stored?.favorites) ? stored.favorites.filter(v => typeof v === "string").slice(0, 512) : [],
    viewMode: readEditorPreference("loraViewMode", "gallery") === "list" ? "list" : "gallery",
    cardSize: Math.max(80, Math.min(240, Number(readEditorPreference("loraCardSize", 125)) || 125)),
    fit: stored?.fit === "contain" ? "contain" : "cover",
  };
  const favorites = new Set(prefs.favorites);
  const metadataCache = new Map();

  const persist = () => {
    writeEditorPreference("lora-picker", { previewControlVersion: 1, images: prefs.images, fit: prefs.fit, favorites: [...favorites].slice(0, 512) });
    writeEditorPreference("loraViewMode", prefs.viewMode);
    writeEditorPreference("loraCardSize", prefs.cardSize);
  };

  let activeFilter = "all"; // "all" | "favorites" | "active"
  let selectedFolder = "all";
  let activeSort = "name-asc";

  // Strength & variation controls
  const numeric = value => {
    const input = make("input", "pp-lora-input");
    input.type = "number"; input.min = "-100"; input.max = "100"; input.step = "0.05"; input.value = String(value);
    return input;
  };
  const model = numeric(current?.model ?? draft?.model ?? 1);
  const clip = numeric(current?.clip ?? draft?.clip ?? 1);
  const linked = make("input");
  linked.type = "checkbox";
  linked.checked = current ? current.model === current.clip : draft?.linked !== false;
  const linkLabel = make("label", "pp-tool-check pp-lora-check");
  linkLabel.append(linked, make("span", "", "Link Model & CLIP strengths"));

  const mode = select([
    ["stack", "Stack selected LoRAs (Standard)"],
    ["cycle", "Cycle (+) · Next strength each run"],
    ["seeded", "Seeded trial · One deterministic pick"],
    ["previous", "Previous alternative (-) each run"],
    ["cartesian", "Cartesian strength cycle (%)"],
    ["random", "Fresh random choice (*) each run"],
    ["batch", "Batch alternatives · Combinatorial"],
  ], draft?.mode || "stack");

  const sweep = make("input", "pp-lora-input");
  sweep.placeholder = "e.g. 0.4, 0.7, 1.0 or custom values";
  sweep.value = draft?.sweep || "";

  const off = make("input");
  off.type = "checkbox";
  off.checked = draft?.off === true;
  const offLabel = make("label", "pp-tool-check pp-lora-check");
  offLabel.append(off, make("span", "", "Include an Off (0.0) alternative for baseline A/B comparison"));

  const triggersInput = make("input", "pp-lora-input");
  triggersInput.placeholder = "Trigger words, added once as plain text";
  triggersInput.value = draft?.triggers || "";

  // 1. Dedicated Active LoRA Deck
  const activeDeck = make("section", "pp-lora-section pp-lora-active-deck");
  const deckHead = make("div", "pp-lora-section-head pp-lora-deck-head");
  const deckTitle = make("strong", "pp-lora-section-title");
  const deckBadge = make("span", "pp-lora-deck-badge", "0");
  deckTitle.innerHTML = `${svgIcon("bolt", 13)}<span>Active in Prompt</span>`;
  deckTitle.appendChild(deckBadge);

  const deckActions = make("div", "pp-lora-deck-actions");
  const dockAtEndBtn = button("Dock at end", formatLoRAsAtEnd, "wg-button pp-lora-chip-btn", "download");
  dockAtEndBtn.title = "Format all LoRA tags into a clean block at the end of the prompt to keep text tidy";
  const clearDeckBtn = button("Clear all", clearAllActiveLoRAs, "wg-button pp-lora-chip-btn danger-quiet", "trash");
  clearDeckBtn.title = "Remove all LoRA tags from prompt text";
  deckActions.append(dockAtEndBtn, clearDeckBtn);
  deckHead.append(deckTitle, deckActions);

  const deckItems = make("div", "pp-lora-deck-items");
  activeDeck.append(deckHead, deckItems);

  function renderActiveDeck() {
    deckItems.replaceChildren();
    const authored = loraTags(snapshot.source);
    deckBadge.textContent = String(authored.length);
    dockAtEndBtn.hidden = authored.length === 0;
    clearDeckBtn.hidden = authored.length === 0;

    if (!authored.length) {
      mutedStrengths.clear();
      deckItems.append(make("p", "pp-tool-empty", "No active LoRAs in this prompt. Click any LoRA below to add it."));
      return;
    }

    const occurrences = new Map();
    for (const tag of authored) {
      const ordinal = occurrences.get(tag.name) || 0;
      occurrences.set(tag.name, ordinal + 1);
      const muteKey = `${tag.name}\0${ordinal}`;
      const item = make("div", "pp-lora-deck-item");
      item.style.setProperty("--pp-lora-color", colorForLora(tag.name, loadTheme()));

      const nameEl = make("button", "pp-deck-name", identity(tag.name).split("/").pop());
      nameEl.type = "button";
      nameEl.title = `${tag.name} (Model: ${tag.model}, CLIP: ${tag.clip})`;
      nameEl.addEventListener("click", () => {
        target = tag; current = tag; selected = new Set([catalogName(tag.name)]);
        model.value = String(tag.model); clip.value = String(tag.clip);
        linked.checked = tag.model === tag.clip;
        updateTriggersBox(catalogName(tag.name));
        update(); renderList();
      });

      const controls = make("div", "pp-deck-controls");
      const modelIn = make("input");
      modelIn.type = "number"; modelIn.min = "-100"; modelIn.max = "100"; modelIn.step = "0.05";
      modelIn.value = String(tag.model); modelIn.title = "Model strength";
      modelIn.setAttribute("aria-label", `Model strength for ${tag.name}`);

      const clipIn = make("input");
      clipIn.type = "number"; clipIn.min = "-100"; clipIn.max = "100"; clipIn.step = "0.05";
      clipIn.value = String(tag.clip); clipIn.title = "CLIP strength";
      clipIn.setAttribute("aria-label", `CLIP strength for ${tag.name}`);

      const syncTag = (newModel, newClip) => {
        try {
          ensureEditable();
          if (![newModel, newClip].every(Number.isFinite)) throw new Error("Enter finite LoRA strengths.");
          const newTagText = formatLoraTag(tag, newModel, newClip);
          const next = snapshot.source.slice(0, tag.start) + newTagText + snapshot.source.slice(tag.end);
          applyToEditor(next, tag.start, tag.start + newTagText.length);
        } catch (err) { message(err.message, true); }
      };

      const changeStrength = () => {
        if (!modelIn.value.trim() || !clipIn.value.trim()) { message("Enter both Model and CLIP strengths.", true); return; }
        syncTag(Number(modelIn.value), Number(clipIn.value));
      };
      modelIn.addEventListener("change", changeStrength);
      clipIn.addEventListener("change", changeStrength);

      const isMuted = tag.model === 0 && tag.clip === 0;
      const muteBtn = make("button", `pp-deck-mute${isMuted ? " is-muted" : ""}`, isMuted ? "Muted" : "Mute");
      muteBtn.type = "button";
      muteBtn.title = isMuted ? "Restore LoRA strength" : "Temporarily mute LoRA (weight 0)";
      muteBtn.setAttribute("aria-pressed", String(isMuted));
      muteBtn.addEventListener("click", () => {
        if (isMuted) {
          const previous = mutedStrengths.get(muteKey) || { model: 1, clip: 1 };
          syncTag(previous.model, previous.clip);
        } else {
          mutedStrengths.set(muteKey, { model: tag.model, clip: tag.clip });
          syncTag(0, 0);
        }
      });

      const triggersBtn = button("Info", () => {
        updateTriggersBox(catalogName(tag.name));
        triggersBox.scrollIntoView?.({ block: "nearest", behavior: "auto" });
      }, "wg-button pp-deck-btn");
      triggersBtn.title = "Local artwork, metadata and trigger words";
      const swapBtn = button("Swap", () => {
        target = tag; current = tag; selected.clear();
        model.value = String(tag.model); clip.value = String(tag.clip);
        linked.checked = tag.model === tag.clip;
        mode.value = "stack"; sweep.value = ""; triggersInput.value = "";
        update(); renderList();
        message("Choose a replacement below, then Replace LoRA. Other LoRAs stay in place.");
      }, "wg-button pp-deck-btn");
      swapBtn.title = `Replace only ${tag.name}`;

      const delBtn = make("button", "pp-deck-del", "×");
      delBtn.type = "button";
      delBtn.title = `Remove ${tag.name} from prompt`;
      delBtn.addEventListener("click", () => {
        try {
          ensureEditable();
          if (!standaloneLoraTags(snapshot.source).some(t => t.start === tag.start)) {
            message("This LoRA belongs to a choice or rule. Remove its alternative in the prompt to preserve the syntax.");
            return;
          }
          mutedStrengths.delete(muteKey);
          let left = snapshot.source.slice(0, tag.start);
          let right = snapshot.source.slice(tag.end);
          if (/\s$/.test(left) && /^\s/.test(right)) right = right.slice(1);
          const next = left + right;
          applyToEditor(next, left.length, left.length);
        } catch (err) { message(err.message, true); }
      });

      controls.append(modelIn, clipIn, muteBtn, swapBtn, triggersBtn, delBtn);
      item.append(nameEl, controls);
      deckItems.append(item);
    }
  }

  function formatLoRAsAtEnd() {
    try {
      ensureEditable();
      const authored = standaloneLoraTags(snapshot.source);
      if (!authored.length) {
        message("LoRA choices, variables and conditional rules stay in place. Only standalone tags can be docked.");
        return;
      }
      let clean = snapshot.source;
      for (let i = authored.length - 1; i >= 0; i--) {
        const tag = authored[i];
        clean = clean.slice(0, tag.start) + clean.slice(tag.end);
      }
      clean = clean.replace(/\n\s*#\s*---\s*LoRAs\s*---\s*\n?/gi, "");
      clean = clean.trim();
      const tagsBlock = authored.map(t => formatLoraTag(t, t.model, t.clip)).join(" ");
      const next = clean ? `${clean}\n\n# --- LoRAs ---\n${tagsBlock}` : tagsBlock;
      applyToEditor(next, next.length, next.length);
      message("LoRAs formatted in dedicated block at prompt end.");
    } catch (err) { message(err.message, true); }
  }

  function clearAllActiveLoRAs() {
    try {
      ensureEditable();
      const authored = loraTags(snapshot.source);
      if (!authored.length) return;
      if (standaloneLoraTags(snapshot.source).length !== authored.length) {
        message("Edit LoRA choices, variables and conditional rules in the prompt before clearing all tags.");
        return;
      }
      let clean = snapshot.source;
      for (let i = authored.length - 1; i >= 0; i--) {
        const tag = authored[i];
        clean = clean.slice(0, tag.start) + clean.slice(tag.end);
      }
      clean = clean.replace(/\n\s*#\s*---\s*LoRAs\s*---\s*\n?/gi, "");
      clean = clean.trim();
      mutedStrengths.clear();
      applyToEditor(clean, 0, 0);
      message("Cleared all LoRAs from prompt.");
    } catch (err) { message(err.message, true); }
  }

  // 2. Local Catalog Section
  const catalogSection = make("section", "pp-lora-section pp-lora-catalog-section");
  const catalogHead = make("div", "pp-lora-section-head");
  const catalogTitle = make("strong", "pp-lora-section-title");
  catalogTitle.innerHTML = `${svgIcon("folder", 13)}<span>LoRA Library</span>`;
  const count = make("span", "pp-lora-count-meta");
  catalogHead.append(catalogTitle, count);

  const searchWrap = make("div", "pp-lora-search-wrap");
  const search = make("input", "pp-lora-input pp-lora-search");
  search.type = "search";
  search.placeholder = "Search LoRAs, folders, triggers, base models…";
  search.setAttribute("aria-label", "Search local LoRAs");
  searchWrap.append(search);

  // Filter Row
  const filterRow = make("div", "pp-lora-filter-row");
  const filterPills = make("div", "pp-lora-filter-pills");
  const allPill = button("All", () => { activeFilter = "all"; updateFilterPills(); renderList(); }, "pp-lora-pill");
  const favPill = button("★ Favorites", () => { activeFilter = "favorites"; updateFilterPills(); renderList(); }, "pp-lora-pill");
  const activePill = button("⚡ Active", () => { activeFilter = "active"; updateFilterPills(); renderList(); }, "pp-lora-pill");
  filterPills.append(allPill, favPill, activePill);

  function updateFilterPills() {
    allPill.classList.toggle("is-active", activeFilter === "all");
    favPill.classList.toggle("is-active", activeFilter === "favorites");
    activePill.classList.toggle("is-active", activeFilter === "active");
  }
  updateFilterPills();

  const selectGroup = make("div", "pp-lora-select-group");
  const folderSelect = make("select", "pp-lora-select pp-lora-folder-select");
  folderSelect.setAttribute("aria-label", "Filter by folder");
  folderSelect.addEventListener("change", () => {
    selectedFolder = folderSelect.value;
    renderList();
  });

  const sortSelect = select([
    ["name-asc", "Sort: Name (A → Z)"],
    ["name-desc", "Sort: Name (Z → A)"],
    ["folder", "Sort: Folder / Path"],
    ["favs", "Sort: Favorites first"],
  ], activeSort, "pp-lora-select pp-lora-sort-select");
  sortSelect.setAttribute("aria-label", "Sort LoRAs");
  sortSelect.addEventListener("change", () => {
    activeSort = sortSelect.value;
    renderList();
  });

  selectGroup.append(folderSelect, sortSelect);
  filterRow.append(filterPills, selectGroup);

  // Main List Container (declared BEFORE size/view controls)
  const list = make("div", "pp-lora-list");
  list.setAttribute("aria-label", "Local LoRA files");

  // View Mode & Size Bar
  const viewBar = make("div", "pp-lora-view-bar");
  const viewModes = make("div", "pp-lora-view-modes");
  const galleryBtn = button("Grid", () => { prefs.viewMode = "gallery"; persist(); syncViewMode(); renderList(); }, "pp-lora-view-btn", "grid");
  const listBtn = button("List", () => { prefs.viewMode = "list"; persist(); syncViewMode(); renderList(); }, "pp-lora-view-btn", "list");
  viewModes.append(galleryBtn, listBtn);

  function syncViewMode() {
    galleryBtn.classList.toggle("is-active", prefs.viewMode === "gallery");
    listBtn.classList.toggle("is-active", prefs.viewMode === "list");
    list.classList.toggle("is-grid", prefs.viewMode === "gallery");
    list.classList.toggle("is-list", prefs.viewMode === "list");
  }

  // Size Slider
  const sizeLabel = make("label", "pp-lora-size-slider");
  const sizeInput = make("input");
  sizeInput.type = "range"; sizeInput.min = "80"; sizeInput.max = "240"; sizeInput.step = "1";
  sizeInput.setAttribute("aria-label", "LoRA preview size");
  sizeInput.value = String(prefs.cardSize);
  sizeInput.title = "Card size · Double-click to reset";
  const sizeOutput = make("output", "", `${prefs.cardSize}px`);
  sizeLabel.append(make("span", "", "Size"), sizeInput, sizeOutput);

  const applyCardSize = (value) => {
    const val = Math.max(80, Math.min(240, Math.round(Number(value) || 125)));
    prefs.cardSize = val;
    sizeInput.value = String(val);
    sizeOutput.textContent = `${val}px`;
    const progress = ((val - 80) / (240 - 80)) * 100;
    sizeInput.style.setProperty("--pp-size-progress", `${progress}%`);
    list.style.setProperty("--pp-lora-card-size", `${val}px`);
    host.style.setProperty("--pp-lora-preview-size", `${val}px`);
    persist();
  };

  sizeInput.addEventListener("input", () => applyCardSize(Number(sizeInput.value)));
  sizeInput.addEventListener("dblclick", () => applyCardSize(125));
  applyCardSize(prefs.cardSize);
  syncViewMode();

  const refreshBtn = button("Refresh", () => load(), "wg-button pp-lora-chip-btn", "refresh");
  refreshBtn.title = "Rescan local LoRA catalog";
  const imagesToggle = make("input");
  imagesToggle.type = "checkbox";
  imagesToggle.setAttribute("aria-label", "Show LoRA previews");
  imagesToggle.title = "Show local image and video previews";
  imagesToggle.checked = prefs.images;
  imagesToggle.addEventListener("change", () => {
    prefs.images = imagesToggle.checked;
    persist();
    renderList();
    if (detailName) updateTriggersBox(detailName);
  });
  const imagesLabel = make("label", "pp-tool-check pp-lora-check pp-lora-preview-toggle");
  imagesLabel.append(imagesToggle, make("span", "", "Previews"));

  viewBar.append(viewModes, imagesLabel, sizeLabel, refreshBtn);

  const catalogToolbar = make("div", "pp-lora-catalog-toolbar");
  catalogToolbar.append(searchWrap, filterRow, viewBar);
  catalogSection.append(catalogHead, catalogToolbar, list);

  // 3. LoRA Audition Lab
  const auditionLab = make("section", "pp-lora-section pp-lora-audition-lab");
  const auditionTitle = make("div", "pp-lora-section-head pp-lora-audition-title");
  const auditionHeading = make("strong", "pp-lora-section-title");
  auditionHeading.innerHTML = `${svgIcon("sparkles", 13)}<span>LoRA Audition Lab</span>`;
  const auditionSelectedName = make("span", "pp-lora-audition-target", "Select a LoRA to test");
  auditionTitle.append(auditionHeading, auditionSelectedName);

  const auditionBody = make("div", "pp-lora-section-body");

  // Quick Audition Presets
  const presetsRow = make("div", "pp-lora-presets");
  const auditionPresets = [
    { label: "Subtle 0.35", m: 0.35, c: 0.35, sweep: "" },
    { label: "Balanced 0.70", m: 0.70, c: 0.70, sweep: "" },
    { label: "Full 1.00", m: 1.00, c: 1.00, sweep: "" },
    { label: "Punchy 1.25", m: 1.25, c: 1.25, sweep: "" },
    { label: "A/B Trial (0 / 0.8)", m: 0.80, c: 0.80, sweep: "0, 0.8", off: true },
    { label: "3-Step (0.4/0.7/1)", m: 1.00, c: 1.00, sweep: "0.4, 0.7, 1.0", mode: "cycle" },
    { label: "5-Step Sweep", m: 1.00, c: 1.00, sweep: "0.2, 0.4, 0.6, 0.8, 1.0", mode: "cycle" },
  ];

  const presetChips = [];
  for (const preset of auditionPresets) {
    const chip = button(preset.label, () => {
      for (const c of presetChips) c.classList.remove("is-active");
      chip.classList.add("is-active");
      model.value = String(preset.m);
      clip.value = String(preset.c);
      linked.checked = preset.m === preset.c;
      if (preset.sweep !== undefined) sweep.value = preset.sweep;
      mode.value = preset.mode || (preset.sweep ? "cycle" : "stack");
      off.checked = preset.off === true;
      if (preset.sweep) advanced.open = true;
      update();
    }, "pp-lora-preset-chip");
    presetChips.push(chip);
    presetsRow.append(chip);
  }

  // Weights & Controls
  const weights = make("div", "pp-tool-grid pp-lora-weights-grid");
  weights.append(field("Model strength", model), field("CLIP strength", clip));

  // Triggers Box
  const triggersBox = make("div", "pp-lora-triggers-box");
  triggersBox.hidden = true;
  const triggersHead = make("div", "pp-lora-triggers-header");
  triggersHead.append(make("strong", "", "Trigger words"), make("span", "", "Click to stage for insertion"));
  const detailInfo = make("div", "pp-lora-detail-info");
  const triggersList = make("div", "pp-lora-triggers-list");
  triggersBox.append(detailInfo, triggersHead, triggersList);

  const advanced = make("details", "pp-tool-details pp-lora-disclosure");
  const advSummary = make("summary", "pp-lora-disclosure-summary");
  advSummary.innerHTML = `<span class="pp-lora-summary-title">${svgIcon("branch", 12)}<span>Trial variation modes & sweeps</span></span><span class="pp-lora-caret">${svgIcon("chevronDown", 12)}</span>`;
  const advBody = make("div", "pp-lora-disclosure-body");
  advBody.append(
    field("Audition / variation mode", mode),
    field("Strength sweep values", sweep),
    offLabel,
    field("Trigger words (authored text)", triggersInput)
  );
  advanced.append(advSummary, advBody);
  advanced.open = draft?.advanced === true || variation != null;

  // Actions Bar inside Audition Lab
  const note = make("p", "pp-tool-note pp-lora-mode-note");
  const preview = make("code", "pp-tool-code pp-lora-code-preview");
  const apply = button("Insert LoRA", commit, "wg-button primary pp-tool-primary pp-lora-apply-btn");
  const clear = button("Clear selection", () => {
    selected.clear();
    for (const c of presetChips) c.classList.remove("is-active");
    auditionSelectedName.textContent = "Select a LoRA to test";
    updateTriggersBox("");
    renderList();
    update();
  }, "wg-button pp-lora-clear-btn");

  const syntax = make("details", "pp-tool-details pp-lora-disclosure pp-lora-syntax-details");
  const synSummary = make("summary", "pp-lora-disclosure-summary");
  synSummary.innerHTML = `<span class="pp-lora-summary-title"><span>Syntax preview</span></span><span class="pp-lora-caret">${svgIcon("chevronDown", 12)}</span>`;
  const synBody = make("div", "pp-lora-disclosure-body");
  synBody.append(preview, note);
  syntax.append(synSummary, synBody);

  const actions = make("div", "pp-tool-actions pp-lora-actions-bar");
  actions.append(clear, apply);

  auditionBody.append(presetsRow, weights, linkLabel, triggersBox, advanced, syntax, actions);
  auditionLab.append(auditionTitle, auditionBody);

  // 4. Browser Options & Execution Mode
  const preferences = make("details", "pp-tool-details pp-lora-disclosure pp-lora-options");
  const prefSummary = make("summary", "pp-lora-disclosure-summary");
  prefSummary.innerHTML = `<span class="pp-lora-summary-title">${svgIcon("settings", 12)}<span>LoRA settings</span></span><span class="pp-lora-caret">${svgIcon("chevronDown", 12)}</span>`;
  const prefBody = make("div", "pp-lora-disclosure-body");

  const execution = select([
    ["auto", "Auto · patch connected inputs"],
    ["external", "External loader · keep tags"],
    ["strip", "Text only · remove tags"],
    ["bypass", "Native bypass · patch connected inputs"],
  ], context.node?._ppLoraModeState?.current() ?? "auto");
  execution.disabled = !context.node?._ppLoraModeState;
  execution.addEventListener("change", () => {
    context.node._ppLoraModeState.commit(execution.value);
    context.node.widgets?.find(w => w.name === "lora_mode")?.callback?.(execution.value);
  });

  const options = make("div", "pp-lora-tools");
  for (const [key, label] of [["loraAutocomplete", "Complete <lora: while typing"], ["highlightLoras", "Highlight LoRA tags"]]) {
    const input = make("input");
    input.type = "checkbox";
    input.checked = loadTheme()[key] === true;
    input.dataset.preference = key;
    const row = make("label", "pp-tool-check pp-lora-check");
    row.append(input, make("span", "", label));
    input.addEventListener("change", () => {
      const theme = loadTheme();
      saveTheme({ ...theme, [key]: input.checked });
    });
    options.append(row);
  }

  const defaultColor = make("input", "pp-lora-color-input");
  defaultColor.type = "color";
  defaultColor.value = sanitizeHexColor(loadTheme().loraColor, "#b8a0f0");
  defaultColor.setAttribute("aria-label", "Default LoRA color");
  defaultColor.addEventListener("change", () => saveTheme({ ...loadTheme(), loraColor: defaultColor.value }));


  const colorRow = make("div", "pp-lora-color-row");
  colorRow.append(field("Default LoRA color", defaultColor, "pp-lora-inline-field"), button("Reset to theme accent", () => saveTheme({ ...loadTheme(), loraColor: "" }), "wg-button pp-lora-chip-btn"));

  const has = name => context.node?.inputs?.some(input => input.name === name && input.link != null);
  const connNote = make("p", "pp-tool-note", context.node
    ? `${has("model") ? "MODEL connected" : "MODEL not connected"} · ${has("clip") ? "CLIP connected" : "CLIP not connected"}. Route Palette’s patched MODEL/CLIP outputs downstream. LoRAs in either prompt patch both channels.`
    : "Insertion only in this editor. Choose execution mode on the destination Palette node.");

  const fitSelect = select([["cover", "Fill thumbnail"], ["contain", "Show whole image"]], prefs.fit);
  const setFit = () => host.style.setProperty("--pp-lora-image-fit", prefs.fit);
  fitSelect.addEventListener("change", () => { prefs.fit = fitSelect.value; persist(); setFit(); });
  setFit();
  prefBody.append(field("This node’s LoRA execution", execution), options, field("Thumbnail framing", fitSelect), colorRow, connNote);
  preferences.append(prefSummary, prefBody);

  host.append(activeDeck, catalogSection, auditionLab, preferences);

  if (variation) {
    advanced.open = true;
    mode.value = variation;
    sweep.value = "0.4, 0.7, 1.0";
  }

  let code = "";

  function update() {
    if (linked.checked) clip.value = model.value;
    clip.title = linked.checked ? "Linked to Model. Editing CLIP unlinks the strengths." : "Independent CLIP strength";
    off.disabled = mode.value === "stack";
    if (off.disabled) off.checked = false;

    note.textContent = mode.value === "batch"
      ? "Unmarked choices enumerate in Combinatorial. Connect each row’s MODEL and CLIP downstream."
      : mode.value === "cycle"
      ? "Cycle mode advances through strength alternatives on each generation."
      : "Zero disables a LoRA without reading its file.";

    try {
      ensureEditable();
      if (editor.readOnly || editor.disabled || editor.getAttribute("aria-readonly") === "true") {
        throw new Error("This editor is read-only.");
      }
      if (!model.value.trim() || !clip.value.trim()) throw new Error("Enter both Model and CLIP strengths.");
      const strengths = sweep.value.trim()
        ? sweep.value.split(",").map(v => {
            const num = Number(v.trim());
            if (!Number.isFinite(num)) throw new Error("Separate sweep values with commas.");
            return num;
          })
        : [];

      code = buildLoraExpression({
        names: [...selected],
        model: Number(model.value),
        clip: Number(clip.value),
        linked: linked.checked,
        strengths,
        mode: mode.value,
        off: off.checked,
      });

      if (triggersInput.value.trim()) code += ` ${triggersInput.value.trim()}`;
      preview.textContent = code;
      apply.disabled = false;
      apply.textContent = target.end > target.start ? (current ? "Replace LoRA" : "Replace selection") : (mode.value === "stack" ? "Insert LoRA" : "Audition LoRA");
    } catch (error) {
      code = "";
      preview.textContent = error.message;
      apply.disabled = true;
    }
  }

  async function getMetadata(name) {
    name = catalogName(name);
    if (metadataCache.has(name)) return metadataCache.get(name);
    const id = revision;
    try {
      const info = await API.loraInfo(name);
      if (dead || id !== revision) return null;
      if (info && !info.error) {
        metadataCache.set(name, info);
        return info;
      }
    } catch {}
    return null;
  }

  async function chooseThumbnail(name) {
    const input = make("input");
    input.type = "file"; input.accept = "image/png,image/jpeg,image/webp";
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file || dead) return;
      if (file.size > 8 * 1024 * 1024) { message("Choose an image up to 8 MB.", true); return; }
      try {
        const result = await API.setLoraThumbnail(catalogName(name), file);
        if (result?.error || result?.ok === false) throw new Error(result.error || "Could not save thumbnail");
        if (dead) return;
        previewRevision++; revision++; metadataPending.clear(); metadataCache.delete(catalogName(name));
        renderList(); updateTriggersBox(name);
        message("Thumbnail saved. Your original model preview is preserved.");
      } catch (error) { if (!dead) message(error.message, true); }
    }, { once: true });
    input.click();
  }

  async function removeThumbnail(name) {
    try {
      const result = await API.removeLoraThumbnail(catalogName(name));
      if (result?.error || result?.ok === false) throw new Error(result.error || "Could not remove thumbnail");
      if (dead) return;
      previewRevision++; revision++; metadataPending.clear(); metadataCache.delete(catalogName(name));
      renderList(); updateTriggersBox(name);
      message("Custom thumbnail removed; local model artwork is used when available.");
    } catch (error) { if (!dead) message(error.message, true); }
  }

  async function updateTriggersBox(name) {
    detailName = catalogName(name || "");
    const id = ++detailRevision;
    previews.clear(detailInfo);
    detailInfo.replaceChildren(); triggersList.replaceChildren();
    triggersBox.hidden = !name;
    if (!name) return;
    triggersList.append(make("span", "pp-tool-note", "Reading local metadata…"));
    const meta = await getMetadata(name);
    if (dead || id !== detailRevision) return;
    triggersList.replaceChildren();
    const artwork = make("div", "pp-lora-detail-art");
    if (prefs.images) {
      previews.append(artwork, name, meta);
    }
    const info = make("div", "pp-lora-detail-copy");
    info.append(make("strong", "", meta?.title || identity(name).split("/").pop()));
    const facts = [meta?.base_model, meta?.version, meta?.author && `by ${meta.author}`].filter(Boolean);
    if (facts.length) info.append(make("small", "", facts.join(" · ")));
    if (meta?.description) info.append(make("p", "pp-tool-note", meta.description));
    if (meta?.tags?.length) info.append(make("small", "", meta.tags.join(" · ")));
    if (meta?.metadata_sources?.length) info.append(make("small", "pp-lora-metadata-source", `Local metadata: ${meta.metadata_sources.join(", ")}`));
    if (meta?.preview_name && !meta.custom_preview) info.append(make("small", "pp-lora-metadata-source", `Preview: ${meta.preview_name}`));
    if (meta?.metadata_error) info.append(make("small", "pp-tool-note", meta.metadata_error));
    const tools = make("div", "pp-lora-detail-tools");
    tools.append(button(meta?.custom_preview ? "Change image" : "Set image", () => chooseThumbnail(name), "wg-button pp-lora-chip-btn"));
    if (meta?.custom_preview) tools.append(button("Use folder preview", () => removeThumbnail(name), "wg-button pp-lora-chip-btn"));
    if (meta?.recommended_strength != null) tools.append(button(`Use suggested ${meta.recommended_strength}`, () => {
      model.value = String(meta.recommended_strength);
      if (meta.recommended_clip_strength != null) { clip.value = String(meta.recommended_clip_strength); linked.checked = model.value === clip.value; }
      else if (linked.checked) clip.value = model.value;
      update();
    }, "wg-button pp-lora-chip-btn"));
    info.append(tools); detailInfo.append(artwork, info);
    if (!meta?.triggers?.length) {
      triggersList.append(make("span", "pp-tool-note", "No trigger words recorded locally."));
      return;
    }
    for (const trig of meta.triggers) {
      const chip = button(trig, () => {
        const parts = triggersInput.value.split(",").map(s => s.trim()).filter(Boolean);
        if (!parts.includes(trig)) parts.push(trig);
        triggersInput.value = parts.join(", "); update();
        message("Trigger staged. Use Insert / Replace to add it to the prompt.");
      }, "pp-lora-trigger-chip");
      chip.title = `Stage "${trig}" for insertion`; triggersList.append(chip);
    }
  }

  function addOne(name) {
    // Add is always additive, even after editing, swapping or a previous insert.
    target = { start: snapshot.source.length, end: snapshot.source.length };
    current = null; selected = new Set([name]);
    mode.value = "stack"; sweep.value = ""; off.checked = false;
    triggersInput.value = "";
    commit(); updateTriggersBox(name);
  }

  function renderList() {
    const scrollTop = list.scrollTop;
    previews.clear(list);
    list.replaceChildren();
    const query = search.value.trim().toLocaleLowerCase();
    const authoredNames = new Set(loraTags(snapshot.source).map(t => catalogName(t.name)));

    let hits = names.filter(name => {
      const lower = name.toLocaleLowerCase();
      const meta = metadataCache.get(name);
      const matchesQuery = !query || lower.includes(query) || ([meta?.base_model, meta?.title, ...(meta?.triggers || [])].some(t => t?.toLocaleLowerCase().includes(query)));
      if (!matchesQuery) return false;

      if (activeFilter === "favorites" && !favorites.has(name)) return false;
      if (activeFilter === "active" && !authoredNames.has(name)) return false;

      if (selectedFolder !== "all") {
        const parts = name.replace(/\\/g, "/").split("/");
        const folder = parts.length > 1 ? parts.slice(0, -1).join("/") : "";
        if (folder !== selectedFolder && !folder.startsWith(`${selectedFolder}/`)) return false;
      }
      return true;
    });

    hits.sort((a, b) => {
      if (activeSort === "favs") {
        const diff = Number(favorites.has(b)) - Number(favorites.has(a));
        if (diff !== 0) return diff;
      } else if (activeSort === "name-desc") {
        return b.localeCompare(a);
      } else if (activeSort === "folder") {
        const fA = a.replace(/\\/g, "/"), fB = b.replace(/\\/g, "/");
        const diff = fA.localeCompare(fB);
        if (diff !== 0) return diff;
      }
      return Number(selected.has(b)) - Number(selected.has(a)) || a.localeCompare(b);
    });

    count.textContent = `${selected.size} selected · ${hits.length} matches${!prefs.images ? " · previews off · use the Previews switch" : ""}${hits.length > 160 ? " · showing first 160; refine your search" : ""}`;

    const displayed = hits.slice(0, 160);

    const uncached = displayed.filter(n => !metadataCache.has(n) && !metadataPending.has(n));
    const catalogRevision = revision;
    for (let offset = 0; offset < uncached.length; offset += 80) {
      const batch = uncached.slice(offset, offset + 80);
      batch.forEach(n => metadataPending.add(n));
      API.loraBatchInfo(batch).then(res => {
        if (dead || catalogRevision !== revision) return;
        if (res?.info) {
          for (const [k, v] of Object.entries(res.info)) metadataCache.set(k, v);
          // Render trigger counts, badges and tooltips when metadata arrives.
          renderList();
        }
      }).catch(error => {
        if (!dead && catalogRevision === revision) message(`Local metadata could not be loaded: ${error.message}. Preview loading continues separately; use Refresh to retry.`, true);
      }).finally(() => { if (catalogRevision === revision) batch.forEach(n => metadataPending.delete(n)); });
    }

    for (const name of displayed) {
      const isSelected = selected.has(name);
      const isFav = favorites.has(name);
      const meta = metadataCache.get(name);
      const cleanName = name.replace(/\\/g, "/").split("/").pop().replace(/\.[^./]+$/, "");
      const folderName = name.replace(/\\/g, "/").includes("/") ? name.replace(/\\/g, "/").split("/").slice(0, -1).join("/") : "";

      if (prefs.viewMode === "gallery") {
        const card = make("div", `pp-lora-card${isSelected ? " is-selected" : ""}`);
        card.dataset.loraName = name;
        card.style.setProperty("--pp-lora-color", colorForLora(name, loadTheme()));
        card.style.setProperty("--pp-lora-text", textColorForLora(name, loadTheme()));

        const media = make("div", "pp-lora-card-media");
        const badgeRow = make("div", "pp-lora-badge-row");
        const modelBadge = make("span", "pp-lora-model-badge", meta?.base_model || "");
        modelBadge.hidden = !meta?.base_model;

        const star = button(isFav ? "★" : "☆", (e) => {
          e.stopPropagation();
          if (favorites.has(name)) favorites.delete(name);
          else if (favorites.size < 512) favorites.add(name);
          persist();
          renderList();
        }, "pp-lora-card-star");
        star.setAttribute("aria-label", `Favorite ${name}`);
        star.setAttribute("aria-pressed", String(isFav));

        badgeRow.append(modelBadge, colorSwatch(name), star);
        media.append(badgeRow);

        if (prefs.images) {
          previews.append(media, name, meta, { owner: card, fallback: cleanName.slice(0, 8) });
        } else {
          const placeholder = make("div", "pp-lora-card-placeholder");
          placeholder.append(make("i", "", "◆"), make("span", "", cleanName.slice(0, 8)));
          media.appendChild(placeholder);
        }

        const body = make("div", "pp-lora-card-body");
        const titleEl = make("strong", "", meta?.title || cleanName);
        titleEl.title = name;

        const metaEl = make("div", "pp-lora-card-meta");
        const folderEl = make("span", "pp-lora-card-folder", folderName || "root");
        metaEl.append(folderEl);

        if (meta?.triggers?.length) {
          const trigPill = make("span", "pp-lora-card-triggers", `${meta.triggers.length} triggers`);
          metaEl.append(trigPill);
        }

        const add = button("+ Add", e => { e.stopPropagation(); addOne(name); }, "wg-button pp-lora-chip-btn pp-lora-card-add");
        add.setAttribute("aria-label", `Add ${name}`);
        body.append(titleEl, metaEl, add);
        card.append(media, body);

        card.addEventListener("click", () => {
          if (selected.has(name)) selected.delete(name);
          else selected.add(name);
          auditionSelectedName.textContent = name;
          updateTriggersBox(name);
          renderList();
          update();
        });



        attachCatalogBehavior(card, name, meta);
        attachContextMenu(card, name);
        list.append(card);
      } else {
        const row = make("div", `pp-lora-row${isSelected ? " is-selected" : ""}`);
        row.dataset.loraName = name;
        row.style.setProperty("--pp-lora-color", colorForLora(name, loadTheme()));

        if (prefs.images) {
          previews.append(row, name, meta, { className: "pp-lora-row-thumb", owner: row });
        }

        const info = make("div", "pp-lora-row-info");
        info.append(make("strong", "", meta?.title || cleanName), make("small", "", folderName ? `${folderName} / ${cleanName}` : cleanName));
        row.append(info);

        const tools = make("div", "pp-lora-row-tools");
        if (meta?.base_model) {
          tools.append(make("span", "pp-lora-model-badge", meta.base_model));
        }

        const star = button(isFav ? "★" : "☆", (e) => {
          e.stopPropagation();
          if (favorites.has(name)) favorites.delete(name);
          else if (favorites.size < 512) favorites.add(name);
          persist();
          renderList();
        }, "pp-lora-card-star");
        star.setAttribute("aria-pressed", String(isFav));

        const addBtn = button("+", (e) => {
          e.stopPropagation();
          addOne(name);
        });
        addBtn.setAttribute("aria-label", `Add ${name}`);
        addBtn.title = "Insert LoRA directly";

        tools.append(colorSwatch(name), star, addBtn);
        row.append(tools);

        row.addEventListener("click", () => {
          if (selected.has(name)) selected.delete(name);
          else selected.add(name);
          auditionSelectedName.textContent = name;
          updateTriggersBox(name);
          renderList();
          update();
        });

        attachCatalogBehavior(row, name, meta);
        attachContextMenu(row, name);
        list.append(row);
      }
    }

    if (!hits.length) {
      list.append(make("p", "pp-tool-empty", "No matching LoRA files. Check your search query or folder filter."));
    }
    list.scrollTop = scrollTop;
  }

  function colorSwatch(name) {
    const input = make("input", "pp-lora-entry-color");
    input.type = "color"; input.value = sanitizeHexColor(colorForLora(name, loadTheme()), "#b8a0f0");
    input.title = `Color for ${name}`; input.setAttribute("aria-label", input.title);
    input.addEventListener("click", event => event.stopPropagation());
    input.addEventListener("change", event => {
      event.stopPropagation();
      const theme = loadTheme();
      saveTheme({ ...theme, loraColors: { ...theme.loraColors, [loraIdentity(name)]: input.value } });
      renderList(); renderActiveDeck();
    });
    return input;
  }

  function attachCatalogBehavior(element, name, meta) {
    element.tabIndex = 0;
    element.setAttribute("role", "group");
    element.setAttribute("aria-label", name);
    element.title = [name, meta?.base_model, meta?.triggers?.length && `Triggers: ${meta.triggers.join(", ")}`, meta?.description].filter(Boolean).join("\n");
    element.addEventListener("keydown", event => {
      if (event.target !== element || !["Enter", " "].includes(event.key)) return;
      event.preventDefault(); element.click();
    });
  }

  function attachContextMenu(element, name) {
    element.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const insert = (varMode, sweepVal = "") => {
        selected = new Set([name]);
        mode.value = varMode;
        sweep.value = sweepVal;
        advanced.open = varMode !== "stack";
        off.checked = false;
        update();
        commit();
      };

      openCtxMenu(event.clientX, event.clientY, [
        { label: "Add to prompt (keep other LoRAs)", onSelect: () => addOne(name), group: "lora" },
        { label: "Local info & trigger words", onSelect: () => updateTriggersBox(name), group: "details" },
        { label: "Set / change thumbnail…", onSelect: () => chooseThumbnail(name), group: "appearance" },
        { label: "Remove custom thumbnail", disabled: !metadataCache.get(name)?.custom_preview, onSelect: () => removeThumbnail(name), group: "appearance" },
        { label: target.start === target.end ? "Insert this LoRA" : "Replace selected LoRA / text", onSelect: () => insert("stack"), group: "lora" },
        { label: "Audition: 3-step sweep (0.4 / 0.7 / 1)", onSelect: () => insert("cycle", "0.4, 0.7, 1.0"), group: "audition" },
        { label: "Audition: A/B Trial (0.0 vs 0.8)", onSelect: () => { selected = new Set([name]); mode.value = "cycle"; sweep.value = "0, 0.8"; off.checked = true; advanced.open = true; update(); commit(); }, group: "audition" },
        { label: "Audition: Random strength each run", onSelect: () => insert("random", "0.4, 0.7, 1.0"), group: "audition" },
        { label: "Audition: Combinatorial batch test", onSelect: () => insert("batch", "0.4, 0.7, 1.0"), group: "audition" },
        { label: "Copy trigger words", onSelect: async () => {
            const meta = await getMetadata(name);
            if (meta?.triggers?.length) {
              try { await navigator.clipboard.writeText(meta.triggers.join(", ")); message("Trigger words copied."); }
              catch { message("Clipboard unavailable. Use the trigger chips to select and copy words."); }
            }
            else message(`No trigger words found for ${name}.`);
          }, group: "clipboard" },
        { label: "Change LoRA color…", onSelect: () => element.querySelector("input[type=color]")?.click(), group: "appearance" },
        { label: "Reset LoRA color", disabled: !loadTheme().loraColors?.[loraIdentity(name)], onSelect: () => {
            const theme = loadTheme();
            const colors = { ...theme.loraColors };
            delete colors[loraIdentity(name)];
            saveTheme({ ...theme, loraColors: colors });
          }, group: "appearance" },
      ]);
    });
  }

  function resolveSelection() {
    const next = new Set();
    for (const value of selected) {
      if (names.includes(value)) { next.add(value); continue; }
      let decoded = value;
      try { decoded = decodeURIComponent(value); } catch {}
      if (names.includes(decoded)) { next.add(decoded); continue; }
      const matches = names.filter(n => n.replace(/\\/g, "/").replace(/\.[^./]+$/, "") === decoded.replace(/\\/g, "/"));
      next.add(matches.length === 1 ? matches[0] : value);
    }
    selected = next;
  }

  async function load() {
    pending?.abort();
    const controller = (pending = new AbortController());
    const id = ++revision;
    try {
      count.textContent = "Reading local LoRA catalog…";
      const response = await API.loras({ signal: controller.signal });
      if (dead || id !== revision) return;
      metadataCache.clear(); metadataPending.clear(); previewRevision = Date.now();
      names = Array.isArray(response.names) ? response.names.filter(v => typeof v === "string") : [];
      folders = Array.isArray(response.folders) ? response.folders.filter(v => typeof v === "string") : [];

      folderSelect.replaceChildren();
      const allOpt = make("option", "", `📁 All Folders (${names.length})`);
      allOpt.value = "all";
      folderSelect.append(allOpt);

      for (const f of folders) {
        const countInFolder = names.filter(n => n.replace(/\\/g, "/").startsWith(`${f}/`)).length;
        const opt = make("option", "", `📁 ${f} (${countInFolder})`);
        opt.value = f;
        folderSelect.append(opt);
      }
      folderSelect.value = selectedFolder;

      resolveSelection();
      renderActiveDeck();
      renderList();
      if (current) updateTriggersBox(catalogName(current.name));
      update();
    } catch (error) {
      if (!dead && id === revision && error.name !== "AbortError") {
        count.textContent = error.message;
        message(error.message, true);
      }
    }
  }

  function applyToEditor(next, start, end) {
    if (context.apply) {
      context.apply(next, start, end);
    } else {
      editor.value = next;
      editor.setSelectionRange(start, end);
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    }
    Object.assign(snapshot, { source: next, start, end });
    target = { start: end, end }; current = null;
    applied({ source: next, start, end });
    renderActiveDeck();
    renderList();
    update();
  }

  function commit() {
    try {
      ensureEditable();
      update();
      if (!code || apply.disabled) return;
      const left = snapshot.source.slice(0, target.start);
      const right = snapshot.source.slice(target.end);
      const inserting = target.start === target.end;
      const insertion = `${inserting && left && !/\s$/.test(left) ? " " : ""}${code}${inserting && right && !/^\s/.test(right) ? " " : ""}`;
      const next = left + insertion + right;
      const end = left.length + insertion.length;

      if (!keepOpen) close();
      editor.focus({ preventScroll: true });

      applyToEditor(next, left.length, end);

      if (keepOpen) {
        // A completed insert is no longer a replacement target.
        target = { start: end, end }; current = null;
        selected.clear(); triggersInput.value = "";
        renderActiveDeck(); renderList(); update();
      }
    } catch (error) {
      message(error.message, true);
    }
  }

  search.addEventListener("input", () => {
    renderList(); clearTimeout(searchTimer);
    const id = ++searchRevision, catalogRevision = revision;
    if (!search.value.trim()) return;
    searchTimer = setTimeout(async () => {
      // Only search the remaining metadata when asked; scan in bounded local
      // batches instead of opening every model on normal panel startup.
      const remaining = names.filter(n => !metadataCache.has(n));
      for (let offset = 0; offset < remaining.length; offset += 80) {
        if (dead || id !== searchRevision || catalogRevision !== revision) return;
        try {
          const response = await API.loraBatchInfo(remaining.slice(offset, offset + 80));
          if (dead || id !== searchRevision || catalogRevision !== revision) return;
          for (const [name, info] of Object.entries(response?.info || {})) metadataCache.set(name, info);
          renderList();
        } catch { return; }
      }
    }, 250);
  });
  clip.addEventListener("input", () => { linked.checked = false; });
  for (const input of [model, clip, linked, mode, sweep, off, triggersInput]) {
    input.addEventListener("input", update);
  }
  mode.addEventListener("change", update);

  const unsubscribe = onPromptPaletteAppearanceChanged(() => {
    const theme = loadTheme();
    defaultColor.value = sanitizeHexColor(theme.loraColor, "#b8a0f0");
    for (const input of options.querySelectorAll("input")) input.checked = theme[input.dataset.preference] === true;
    renderList();
  });

  const onEditorInput = () => {
    snapshot.source = editor.value;
    applied({ source: editor.value, start: editor.selectionStart, end: editor.selectionEnd });
    target = { start: editor.selectionStart, end: editor.selectionEnd }; current = null;
    renderActiveDeck(); renderList(); update();
  };
  editor.addEventListener("input", onEditorInput);

  renderActiveDeck();
  update();
  load();

  return {
    focus: () => search.focus(),
    draft: () => ({
      names: [...selected],
      model: Number(model.value),
      clip: Number(clip.value),
      linked: linked.checked,
      mode: mode.value,
      sweep: sweep.value,
      off: off.checked,
      triggers: triggersInput.value,
      advanced: advanced.open,
    }),
    cleanup() {
      unsubscribe();
      previews.destroy();
      dead = true;
      revision++; searchRevision++; clearTimeout(searchTimer);
      pending?.abort();
      editor.removeEventListener("input", onEditorInput);
    },
  };
}
