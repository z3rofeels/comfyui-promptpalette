import { VirtualCollectionManager } from "../library/virtual_collection.js";
import { selectVisualIndex, visualItemRect, visualNeighborIndex } from "../library/visual_collection.js";
import { SIDEBAR_ASPECT_RATIOS, resolveSidebarGrid, sidebarLayoutMetrics } from "./sidebar_layout.js";
import { PresentationScope, captureSidebarFocus, restoreSidebarFocus } from "./sidebar_presentation.js";
import { loadSidebarDisplay } from "./preferences.js";
import { openCtxMenu } from "./context_menu.js";
import { colorForLora, customColorForLora, textColorForLora, loraIdentity } from "./lora_colors.js";
import { sanitizeHexColor } from "./text_utils.js";
import { onPromptPaletteAppearanceChanged, svgIcon, copyPromptPaletteThemeScope, installPromptPaletteKeyboardBoundary } from "../prompt_palette_shared.js";
import { loadTheme, saveTheme } from "./preferences.js";
import { API } from "../prompt_palette_api.js";
import { createLoraPreviews, loraPreviewOptions } from "./lora_preview.js";
import { readEditorPreference, writeEditorPreference } from "../prompt_palette_state.js";
import { buildLoraExpression, parseLoraStrengths, missingLoraTriggers, formatLoraTag, loraAt, loraTags, standaloneLoraTags, LORA_DOCK_HEADER_RE, dockLoraText, splitLoraDock } from "../engine/lora_tags.js";

const viewOptions = [["gallery", "Gallery"], ["masonry", "Masonry"], ["filmstrip", "Filmstrip"], ["list", "List"]];
const aspectOptions = [["natural", "Natural"], ["square", "1:1"], ["portrait", "3:4"], ["tall", "2:3"], ["landscape", "4:3"], ["wide", "16:9"]];
const mutedByEditor = new WeakMap();
const catalogPreferencesChanged = new EventTarget();
const openFlyoutStack = [];

const make = (tag, cls = "", text = "") => { const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; };
const button = (text, fn, cls = "wg-button", icon = "") => {
  const b = make("button", cls);
  b.type = "button";
  if (icon) b.innerHTML = `${svgIcon(icon, 12)}<span>${text}</span>`;
  else b.textContent = text;
  if (fn) b.addEventListener("click", fn);
  return b;
};
function field(label, input, cls = "pp-tool-field pp-lora-field") { if (!input.hasAttribute("aria-label")) input.setAttribute("aria-label", label); const e = make("label", cls); e.append(make("span", "pp-lora-field-label", label), input); return e; }
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

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
function compactCount(value) {
  if (!Number.isFinite(value) || value <= 0) return "";
  return value >= 1e6 ? `${(value / 1e6).toFixed(1)}M` : value >= 1e3 ? `${(value / 1e3).toFixed(1)}k` : String(Math.round(value));
}
// One broken section must never blank the whole info panel again.
function safely(label, fn) {
  try { fn(); } catch (error) { console.warn(`[Prompt Palette] LoRA info: "${label}" could not render`, error); }
}

export function createLoraPicker({ host, editor, context, snapshot, guard, close, message, keepOpen = false, applied = () => {}, variation = null, draft = null, sidebar = null }) {
  let current = loraAt(snapshot.source, snapshot.start);
  let target = current && snapshot.end <= current.end ? current : { start: snapshot.source.length, end: snapshot.source.length };
  let names = [], folders = [];
  let selected = new Set(current ? [current.name] : draft?.names || []);
  let dead = false, active = true, pending = null, revision = 0;
  let detailName = "", detailRevision = 0;
  let loaded = false, loadError = "", lastMatchCount = 0;
  let lastRenderedMode = null, lastRenderedImages = null;
  let searchRevision = 0, searchTimer = 0;
  const metadataPending = new Set();
  const metadataCache = new Map();
  const metadataInflight = new Map();
  const metadataResolvers = new Map();
  if (!mutedByEditor.has(editor)) mutedByEditor.set(editor, new Map());
  const mutedStrengths = mutedByEditor.get(editor);

  host.classList.add("pp-lora-picker");
  const ownScope = sidebar?.presentation ? null : new PresentationScope(host);
  const presentation = sidebar?.presentation || ownScope;

  const list = make("div", "pp-lora-list");
  list.tabIndex = -1;
  list.setAttribute("aria-label", "Local LoRA files");
  let collection = null;
  const virtual = new VirtualCollectionManager(list, { onVisibleCount: () => previews.pruneDetached() });

  const identity = name => { try { return decodeURIComponent(name).replace(/\\/g, "/"); } catch { return name.replace(/\\/g, "/"); } };
  const catalogName = name => {
    const normalized = identity(name);
    const exact = names.find(n => identity(n) === normalized);
    if (exact) return exact;
    const matches = names.filter(n => identity(n).replace(/\.[^./]+$/, "") === normalized);
    return matches.length === 1 ? matches[0] : name;
  };
  const previewUrl = (name, options) => API.loraPreviewUrl(catalogName(name), options);
  const probePreview = async (name, options) => {
    const key = catalogName(name);
    const cached = metadataCache.get(key);
    if (cached?.has_preview != null) return cached;
    const inflight = metadataInflight.get(key);
    if (inflight) {
      await new Promise((resolve, reject) => {
        if (options?.signal?.aborted) { reject(new DOMException("Aborted", "AbortError")); return; }
        const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
        options?.signal?.addEventListener("abort", onAbort, { once: true });
        inflight.then(() => {
          options?.signal?.removeEventListener("abort", onAbort);
          resolve();
        });
      });
      const populated = metadataCache.get(key);
      if (populated?.has_preview != null) return populated;
    }
    const result = await API.loraPreviewProbe(key, options);
    const meta = (result && !result.error) ? result : { has_preview: false };
    const existing = metadataCache.get(key) || {};
    metadataCache.set(key, { ...existing, ...meta, has_preview: meta.has_preview ?? false });
    return result;
  };
  const previews = createLoraPreviews(previewUrl, {
    root: list,
    rootMargin: "120px",
    canPlay: () => active && prefs.motion !== false,
    onReady: () => { if (!dead && prefs.viewMode === "masonry") virtual.refresh(); },
    onDimensions: (owner, width, height) => {
      if (dead || !collection) return;
      if (owner?.dataset?.loraName != null || list.contains(owner)) {
        collection.notifyMediaDimensions(owner, width, height);
      }
    },
    onMediaError: (owner) => {
      if (dead || !collection) return;
      if (owner?.dataset?.loraName != null || list.contains(owner)) {
        collection.notifyMediaError(owner);
      }
    },
    probe: probePreview,
    customBlob: (name, options) => API.loraPreviewBlob(catalogName(name), options),
    onError: (name, error) => { if (!dead) message(`${identity(name).split("/").pop()}: ${error}`, true); },
  });
  const detailPreviews = createLoraPreviews(previewUrl, {
    root: null,
    rootMargin: "120px",
    canPlay: () => active && prefs.motion !== false,
    probe: probePreview,
    customBlob: (name, options) => API.loraPreviewBlob(catalogName(name), options),
    onError: (name, error) => { if (!dead) message(`${identity(name).split("/").pop()}: ${error}`, true); },
  });
  function ensureEditable() {
    guard();
    if (editor.readOnly || editor.disabled || editor.getAttribute("aria-readonly") === "true") throw new Error("This editor is read-only.");
  }

  // Read preferences
  const stored = readEditorPreference("lora-picker", {});
  const prefs = {
    // Recover the old buried "off" flag once. Future choices use the visible switch.
    images: stored?.previewControlVersion === 1 ? stored.images !== false : true,
    favorites: Array.isArray(stored?.favorites) ? stored.favorites.filter(v => typeof v === "string").slice(0, 512) : [],
    viewMode: viewOptions.some(([key]) => key === readEditorPreference("loraViewMode")) ? readEditorPreference("loraViewMode") : "gallery",
    cardSize: Math.max(80, Math.min(240, Number(readEditorPreference("loraCardSize", 125)) || 125)),
    aspect: aspectOptions.some(([key]) => key === stored?.aspect) ? stored.aspect : "square",
    motion: stored?.motion !== false,
    fit: stored?.fit === "contain" ? "contain" : "cover",
  };
  const favorites = new Set(prefs.favorites);

  const persist = () => {
    if (sidebar) {
      // Never overwrite Sidecar's viewMode, cardSize, images, fit, or aspect from Sidebar.
      const prev = readEditorPreference("lora-picker", {});
      writeEditorPreference("lora-picker", {
        ...(prev && typeof prev === "object" ? prev : {}),
        previewControlVersion: 1,
        motion: prefs.motion,
        sort: activeSort,
        favorites: [...favorites].slice(0, 512),
      });
    } else {
      writeEditorPreference("lora-picker", {
        previewControlVersion: 1,
        images: prefs.images,
        motion: prefs.motion,
        fit: prefs.fit,
        aspect: prefs.aspect,
        sort: activeSort,
        favorites: [...favorites].slice(0, 512),
      });
      writeEditorPreference("loraViewMode", prefs.viewMode);
      writeEditorPreference("loraCardSize", prefs.cardSize);
    }
    catalogPreferencesChanged.dispatchEvent(new CustomEvent("change", { detail: host }));
  };

  let activeFilter = "all"; // "all" | "favorites" | "active"
  let selectedFolder = "all";
  let activeSort = stored?.sort || "name-asc";

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

  function createCollapsibleSection(cls, iconName, titleText, { open = true, badge = null, onToggle = null } = {}) {
    const section = make("section", `pp-lora-section ${cls}`);
    let openState = Boolean(open);
    section.dataset.open = String(openState);

    const head = make("div", "pp-lora-section-head");
    const toggleBtn = make("button", "pp-lora-section-toggle");
    toggleBtn.type = "button";
    toggleBtn.setAttribute("aria-expanded", String(openState));
    const titleEl = make("strong", "pp-lora-section-title");
    titleEl.innerHTML = `${svgIcon(iconName, 13)}<span></span>`;
    titleEl.querySelector("span").textContent = titleText;
    toggleBtn.append(titleEl);
    if (badge) toggleBtn.append(badge);

    const actions = make("div", "pp-lora-head-actions");
    const caretBtn = make("button", "pp-lora-caret pp-lora-caret-btn");
    caretBtn.type = "button";
    caretBtn.tabIndex = -1;
    caretBtn.setAttribute("aria-hidden", "true");
    caretBtn.innerHTML = svgIcon("chevronDown", 12);
    actions.append(caretBtn);

    head.append(toggleBtn, actions);
    const body = make("div", "pp-lora-section-body");
    body.hidden = !openState;
    section.append(head, body);

    const setOpen = (next) => {
      const targetOpen = Boolean(next);
      if (targetOpen === openState) return;
      openState = targetOpen;
      section.dataset.open = String(openState);
      toggleBtn.setAttribute("aria-expanded", String(openState));
      body.hidden = !openState;
      onToggle?.(openState);
    };
    toggleBtn.addEventListener("click", () => setOpen(!openState));
    caretBtn.addEventListener("click", () => setOpen(!openState));

    return { section, head, body, actions, caretBtn, toggleBtn, isOpen: () => openState, setOpen };
  }

  // 1. Dedicated Active LoRA Deck
  const deckBadge = make("span", "pp-lora-deck-badge", "0");
  const deckCtl = createCollapsibleSection("pp-lora-active-deck", "bolt", "Active in Prompt", { open: true, badge: deckBadge });
  const activeDeck = deckCtl.section;
  deckCtl.actions.classList.add("pp-lora-deck-actions");

  const clearDeckBtn = button("Clear all", () => clearAllActiveLoRAs(), "wg-button pp-lora-chip-btn danger-quiet", "trash");
  clearDeckBtn.title = "Remove all LoRA tags from prompt text";
  deckCtl.actions.insertBefore(clearDeckBtn, deckCtl.caretBtn);

  const deckBody = deckCtl.body;
  deckBody.classList.add("pp-lora-deck-body");
  const deckNote = make("p", "pp-tool-note pp-lora-deck-note", "Model changes the image; CLIP changes how text is interpreted. 1 = full strength, 0 = off. Effects vary by LoRA.");
  const deckItems = make("div", "pp-lora-deck-items");
  deckBody.append(deckNote, deckItems);

  function renderActiveDeck() {
    for (const el of deckItems.children) presentation.release(el);
    deckItems.replaceChildren();
    const authored = loraTags(snapshot.source);
    deckBadge.textContent = String(authored.length);
    clearDeckBtn.hidden = authored.length === 0;
    deckNote.hidden = authored.length > 0;

    if (!authored.length) {
      mutedStrengths.clear();
      deckItems.append(make("p", "pp-tool-empty", "No active LoRAs in this prompt. Click any LoRA below to add it."));
      return;
    }

    const occurrences = new Map();
    const deckTheme = loadTheme();
    for (const tag of authored) {
      const ordinal = occurrences.get(tag.name) || 0;
      occurrences.set(tag.name, ordinal + 1);
      const muteKey = `${tag.name}\0${ordinal}`;
      const item = make("div", "pp-lora-deck-item");
      presentation.set(item, { "--pp-lora-color": colorForLora(tag.name, deckTheme) });

      const nameEl = make("button", "pp-deck-name", identity(tag.name).split("/").pop().replace(/\.[^./]+$/, ""));
      nameEl.type = "button";
      nameEl.title = `${tag.name} (Model: ${tag.model}, CLIP: ${tag.clip})`;
      nameEl.addEventListener("click", () => {
        target = tag; current = tag; selected = new Set([catalogName(tag.name)]);
        model.value = String(tag.model); clip.value = String(tag.clip);
        linked.checked = tag.model === tag.clip;
        syncAuditionSummary();
        updateTriggersBox(catalogName(tag.name), { trigger: nameEl });
        update(); syncSelectionInDom();
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
          if (![newModel, newClip].every(value => Number.isFinite(value) && Math.abs(value) <= 100)) throw new Error("Enter strengths between −100 and 100.");
          const newTagText = formatLoraTag(tag, newModel, newClip);
          const rawNext = snapshot.source.slice(0, tag.start) + newTagText + snapshot.source.slice(tag.end);
          if (standaloneLoraTags(rawNext).length > 0 || LORA_DOCK_HEADER_RE.test(rawNext)) {
            const next = dockLoraText(rawNext);
            applyToEditor(next, next.length, next.length);
          } else {
            applyToEditor(rawNext, tag.start, tag.start + newTagText.length);
          }
        } catch (err) { message(err.message, true); }
      };

      const changeStrength = () => {
        if (!modelIn.value.trim() || !clipIn.value.trim()) { message("Enter both Model and CLIP strengths.", true); return; }
        syncTag(Number(modelIn.value), Number(clipIn.value));
      };
      modelIn.addEventListener("change", changeStrength);
      clipIn.addEventListener("change", changeStrength);

      const resetStrengthBtn = make("button", "pp-deck-btn pp-deck-reset", "1.0");
      resetStrengthBtn.type = "button";
      resetStrengthBtn.title = `Reset ${identity(tag.name).split("/").pop()} Model and CLIP strength to 1.0`;
      resetStrengthBtn.setAttribute("aria-label", `Reset ${tag.name} strength to 1.0`);
      resetStrengthBtn.addEventListener("click", () => {
        modelIn.value = "1";
        clipIn.value = "1";
        syncTag(1, 1);
      });

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

      const triggersBtn = button("Info", (e) => {
        const key = catalogName(tag.name);
        if (!triggersBox.hidden && detailName === key) {
          closeFlyout({ restoreFocus: true });
          return;
        }
        updateTriggersBox(key, { openLab: false, trigger: triggersBtn, focusFlyout: e.detail === 0 });
      }, "wg-button pp-deck-btn");
      triggersBtn.title = "Local artwork, metadata and trigger words";
      const swapBtn = button("Swap", () => {
        target = tag; current = tag; selected.clear();
        model.value = "1"; clip.value = "1";
        linked.checked = true;
        mode.value = "stack"; sweep.value = ""; triggersInput.value = "";
        syncAuditionSummary();
        update(); syncSelectionInDom();
        message("Choose a replacement below, then Replace LoRA. Other LoRAs stay in place.");
      }, "wg-button pp-deck-btn");
      swapBtn.title = `Replace only ${tag.name}`;

      const delBtn = make("button", "pp-deck-del", "×");
      delBtn.type = "button";
      delBtn.title = `Remove ${tag.name} from prompt`;
      delBtn.setAttribute("aria-label", `Remove ${tag.name} from prompt`);
      delBtn.addEventListener("click", () => {
        try {
          ensureEditable();
          if (!standaloneLoraTags(snapshot.source).some(t => t.start === tag.start)) {
            message("This LoRA belongs to a choice or rule. Remove its alternative in the prompt to preserve the syntax.");
            return;
          }
          mutedStrengths.delete(muteKey);
          const rawNext = `${snapshot.source.slice(0, tag.start)} ${snapshot.source.slice(tag.end)}`;
          const next = dockLoraText(rawNext);
          applyToEditor(next, next.length, next.length);
        } catch (err) { message(err.message, true); }
      });

      controls.append(field("Model", modelIn, "pp-deck-strength"), field("CLIP", clipIn, "pp-deck-strength"), resetStrengthBtn, muteBtn, swapBtn, triggersBtn, delBtn);
      item.append(nameEl, controls);
      deckItems.append(item);
    }
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
      const { body } = splitLoraDock(snapshot.source);
      const clean = body.trim();
      mutedStrengths.clear();
      applyToEditor(clean, 0, 0);
      message("Cleared all LoRAs from prompt.");
    } catch (err) { message(err.message, true); }
  }

  const setsPanel = make("details", "pp-tool-details pp-lora-disclosure pp-lora-sets");
  const setsSummary = make("summary", "pp-lora-disclosure-summary");
  setsSummary.innerHTML = `<span class="pp-lora-summary-title">${svgIcon("layers", 12)}<span>Saved LoRA sets</span></span><span class="pp-lora-caret">${svgIcon("chevronDown", 12)}</span>`;
  setsPanel.append(setsSummary);
  const setsBody = make("div", "pp-lora-disclosure-body");
  const setName = make("input", "pp-lora-input");
  setName.placeholder = "e.g. Soft cinematic portraits"; setName.maxLength = 80;
  const setsList = make("div", "pp-lora-sets-list");
  const readSets = () => {
    const saved = readEditorPreference("loraSetsV1", []);
    return Array.isArray(saved) ? saved.filter(set => typeof set?.name === "string" && Array.isArray(set.entries)
      && set.entries.length && set.entries.every(entry => typeof entry?.name === "string" && [entry.model, entry.clip].every(n => Number.isFinite(n) && Math.abs(n) <= 100))) : [];
  };
  function saveSets(sets) {
    writeEditorPreference("loraSetsV1", sets);
    catalogPreferencesChanged.dispatchEvent(new CustomEvent("change", { detail: host }));
    renderSets();
  }
  function captureSet() {
    const entries = standaloneLoraTags(snapshot.source);
    if (!entries.length || entries.length !== loraTags(snapshot.source).length) throw new Error("Save a deck of standalone LoRAs. Choices and rules must be edited in the prompt first.");
    return entries.map(({ name, model, clip }) => ({ name, model, clip }));
  }
  function recallSet(set, replace) {
    try {
      ensureEditable();
      const missing = set.entries.filter(entry => !names.includes(catalogName(entry.name)));
      if (missing.length) throw new Error(`Set needs unavailable LoRAs: ${missing.map(entry => entry.name).join(", ")}. Refresh the library or restore those files.`);
      let source = snapshot.source;
      if (replace) {
        const tags = standaloneLoraTags(source);
        if (tags.length !== loraTags(source).length) throw new Error("Replace deck preserves prompt rules. Edit LoRA choices and rules first, or use Add set.");
        source = splitLoraDock(source).body;
      }
      const text = set.entries.map(entry => formatLoraTag(entry, entry.model, entry.clip)).join(" ");
      const next = dockLoraText(source, { appendLora: text });
      applyToEditor(next, next.length, next.length);
      message(`${replace ? "Recalled" : "Added"} ${set.name} with saved strengths.`);
    } catch (error) { message(error.message, true); }
  }
  function renderSets() {
    setsList.replaceChildren();
    const sets = readSets();
    if (!sets.length) setsList.append(make("p", "pp-tool-note", "Save a combination you love, including each Model and CLIP strength. Sets are shared by LoraPal panels in this browser."));
    for (const set of sets) {
      const row = make("div", "pp-lora-set");
      row.append(make("strong", "", set.name), make("small", "pp-lora-set-description", set.entries.map(entry => `${identity(entry.name).split("/").pop()} · Model ${entry.model} / CLIP ${entry.clip}`).join(" • ")));
      const actions = make("div", "pp-lora-set-actions");
      actions.append(button("Add set", () => recallSet(set, false), "wg-button pp-lora-chip-btn"), button("Replace deck", () => recallSet(set, true), "wg-button pp-lora-chip-btn"),
        button("Update from deck", () => { try { const entries = captureSet(); saveSets(readSets().map(item => item.name === set.name ? { ...item, entries } : item)); } catch (error) { message(error.message, true); } }),
        button("Delete", () => { const previous = readSets(); saveSets(previous.filter(item => item.name !== set.name));
          const undo = button("Undo delete", () => { const latest = readSets(); if (!latest.some(item => item.name === set.name)) saveSets([...latest, set]); }); setsList.append(undo); }));
      row.append(actions); setsList.append(row);
    }
  }
  setsBody.append(field("Set name", setName), button("Save active deck", () => {
    try {
      const name = setName.value.trim();
      if (!name) throw new Error("Give this set a name first.");
      const sets = readSets();
      if (sets.some(set => set.name.toLocaleLowerCase() === name.toLocaleLowerCase())) throw new Error("That set already exists. Use Update from deck or choose a different name.");
      saveSets([...sets, { name, entries: captureSet() }]); setName.value = "";
      message(`Saved ${name}.`);
    } catch (error) { message(error.message, true); }
  }), setsList);
  setsPanel.append(setsBody); renderSets();

  // 2. Local Catalog Section
  const catalogCtl = createCollapsibleSection("pp-lora-catalog-section", "folder", "LoRA Library", {
    open: true,
    onToggle: (isOpen) => {
      if (isOpen && loaded) {
        renderList(true);
        virtual.refresh();
      }
    },
  });
  const catalogSection = catalogCtl.section;
  catalogCtl.head.classList.add("pp-lora-catalog-head");
  const count = make("span", "pp-lora-count-meta");

  const searchWrap = make("div", "pp-lora-search-wrap");
  const search = make("input", "pp-lora-input pp-lora-search");
  search.type = "search";
  search.placeholder = "Search LoRAs, folders, triggers, base models…";
  search.setAttribute("aria-label", "Search local LoRAs");
  const searchClear = make("button", "pp-lora-search-clear", "×");
  searchClear.type = "button";
  searchClear.hidden = true;
  searchClear.setAttribute("aria-label", "Clear search");
  searchClear.title = "Clear search (Esc)";
  const syncSearchClear = () => { searchClear.hidden = !search.value.length; };
  const clearSearchQuery = ({ focusSearch = true } = {}) => {
    search.value = "";
    clearTimeout(searchTimer);
    searchRevision++;
    syncSearchClear();
    renderList(false, false, { resetScroll: true });
    if (focusSearch) search.focus({ preventScroll: true });
  };
  searchClear.addEventListener("click", () => clearSearchQuery({ focusSearch: true }));
  search.addEventListener("keydown", event => {
    if (event.isComposing) return;
    if (event.key === "Escape" && search.value.length > 0) {
      event.preventDefault();
      event.stopPropagation();
      clearSearchQuery({ focusSearch: true });
      return;
    }
    if ((event.key === "ArrowDown" || event.key === "Enter") && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      if (collection?.items?.length) {
        event.preventDefault();
        event.stopPropagation();
        focusCatalogIndex(0);
      }
    }
  });
  searchWrap.append(search, searchClear);

  // Filter Row
  const filterRow = make("div", "pp-lora-filter-row");
  const filterPills = make("div", "pp-lora-filter-pills");
  const allPill = button("All", () => { activeFilter = "all"; updateFilterPills(); renderList(false, false, { resetScroll: true }); }, "pp-lora-pill");
  const favPill = button("Favorites", () => { activeFilter = "favorites"; updateFilterPills(); renderList(false, false, { resetScroll: true }); }, "pp-lora-pill", "star");
  const activePill = button("Active", () => { activeFilter = "active"; updateFilterPills(); renderList(false, false, { resetScroll: true }); }, "pp-lora-pill", "bolt");
  filterPills.append(allPill, favPill, activePill);

  function updateFilterPills() {
    allPill.classList.toggle("is-active", activeFilter === "all");
    allPill.setAttribute("aria-pressed", String(activeFilter === "all"));
    favPill.classList.toggle("is-active", activeFilter === "favorites");
    favPill.setAttribute("aria-pressed", String(activeFilter === "favorites"));
    activePill.classList.toggle("is-active", activeFilter === "active");
    activePill.setAttribute("aria-pressed", String(activeFilter === "active"));
  }
  updateFilterPills();

  const selectGroup = make("div", "pp-lora-select-group");
  const folderSelect = make("select", "pp-lora-select pp-lora-folder-select");
  folderSelect.setAttribute("aria-label", "Filter by folder");
  folderSelect.addEventListener("change", () => {
    selectedFolder = folderSelect.value;
    renderList(false, false, { resetScroll: true });
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
    persist(); renderList(false, false, { resetScroll: true });
  });

  selectGroup.append(folderSelect, sortSelect);
  filterRow.append(filterPills, selectGroup);

  let focusedLoraName = "";

  function syncRovingTabIndex() {
    const mounted = [...list.querySelectorAll("[data-lora-name]")];
    if (!mounted.length) return;
    let activeEl = focusedLoraName ? mounted.find(el => el.dataset.loraName === focusedLoraName) : null;
    if (!activeEl) {
      activeEl = mounted[0];
      if (activeEl?.dataset.loraName && (!focusedLoraName || !collection?.items?.some(it => it.name === focusedLoraName))) {
        focusedLoraName = activeEl.dataset.loraName;
      }
    }
    for (const el of mounted) {
      el.tabIndex = el === activeEl ? 0 : -1;
    }
  }

  function focusCatalogIndex(targetIndex) {
    const items = collection?.items;
    if (!items?.length) return;
    const index = Math.max(0, Math.min(items.length - 1, targetIndex));
    const item = items[index];
    if (!item) return;
    focusedLoraName = item.name;

    if (prefs.viewMode === "filmstrip") {
      selectVisualIndex(collection, index);
      syncRovingTabIndex();
      const el = list.querySelector(".pp-film-detail [data-lora-name]");
      el?.focus?.({ preventScroll: true });
      return;
    }

    const cs = typeof getComputedStyle === "function" ? getComputedStyle(list) : null;
    const padTop = parseFloat(cs?.paddingTop) || 0;
    const padBottom = parseFloat(cs?.paddingBottom) || 0;
    const viewHeight = list.clientHeight || 240;

    if (prefs.viewMode === "masonry") {
      const rect = visualItemRect(collection, index);
      if (index === 0) {
        if (list.scrollTop !== 0) list.scrollTop = 0;
      } else if (rect) {
        const itemTop = padTop + rect.y;
        const itemBottom = itemTop + rect.height + padBottom;
        if (itemTop < list.scrollTop + padTop) list.scrollTop = Math.max(0, itemTop - padTop);
        else if (itemBottom > list.scrollTop + viewHeight) list.scrollTop = Math.max(0, itemBottom - viewHeight);
      }
      collection.render();
      syncRovingTabIndex();
      const el = [...list.querySelectorAll("[data-lora-name]")].find(node => node.dataset.loraName === item.name);
      el?.focus?.({ preventScroll: true });
      el?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
      return;
    }

    const cols = prefs.viewMode === "gallery" ? Math.max(1, collection.columns()) : 1;
    const stride = prefs.viewMode === "gallery" ? collection.effectiveCardHeight(cols) : collection.estimateRowHeight;
    const row = Math.floor(index / cols);
    if (index === 0) {
      if (list.scrollTop !== 0) list.scrollTop = 0;
    } else {
      const itemTop = padTop + row * stride;
      const itemBottom = itemTop + stride + padBottom;
      if (itemTop < list.scrollTop + padTop) list.scrollTop = Math.max(0, itemTop - padTop);
      else if (itemBottom > list.scrollTop + viewHeight) list.scrollTop = Math.max(0, itemBottom - viewHeight);
    }

    collection.render();
    syncRovingTabIndex();
    const el = [...list.querySelectorAll("[data-lora-name]")].find(node => node.dataset.loraName === item.name);
    el?.focus?.({ preventScroll: true });
    el?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }

  list.addEventListener("focusin", event => {
    const itemEl = event.target instanceof Element ? event.target.closest("[data-lora-name]") : null;
    if (itemEl?.dataset.loraName) {
      focusedLoraName = itemEl.dataset.loraName;
      syncRovingTabIndex();
    }
  });

  // Full-catalog keyboard navigation across virtualized cards/rows, Masonry lanes, and Filmstrip.
  list.addEventListener("keydown", event => {
    if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const targetEl = event.target instanceof Element ? event.target : null;
    if (!targetEl || targetEl.closest(".pp-film-strip, input, select, textarea")) return;
    const itemEl = targetEl.closest("[data-lora-name]");
    if (!itemEl || itemEl !== targetEl) return;
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key)) return;
    const items = collection?.items;
    if (!items?.length) return;
    const index = items.findIndex(item => item.name === itemEl.dataset.loraName);
    if (index < 0) return;
    let nextIndex = index;
    if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = items.length - 1;
    } else if (prefs.viewMode === "filmstrip") {
      if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = Math.max(0, index - 1);
      else if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = Math.min(items.length - 1, index + 1);
      else if (event.key === "PageUp") nextIndex = Math.max(0, index - 5);
      else if (event.key === "PageDown") nextIndex = Math.min(items.length - 1, index + 5);
    } else if (prefs.viewMode === "masonry") {
      if (event.key === "ArrowUp") nextIndex = visualNeighborIndex(collection, index, "up");
      else if (event.key === "ArrowDown") nextIndex = visualNeighborIndex(collection, index, "down");
      else if (event.key === "ArrowLeft") nextIndex = visualNeighborIndex(collection, index, "left");
      else if (event.key === "ArrowRight") nextIndex = visualNeighborIndex(collection, index, "right");
      else {
        const dir = event.key === "PageUp" ? "up" : "down";
        for (let step = 0; step < 3; step++) nextIndex = visualNeighborIndex(collection, nextIndex, dir);
      }
    } else if (prefs.viewMode === "gallery") {
      const cols = Math.max(1, collection?.columns?.() || 1);
      const cardH = Math.max(1, collection?.effectiveCardHeight?.(cols) || 150);
      const pageRows = Math.max(1, Math.floor((list.clientHeight || 240) / cardH));
      if (event.key === "ArrowLeft") nextIndex = Math.max(0, index - 1);
      else if (event.key === "ArrowRight") nextIndex = Math.min(items.length - 1, index + 1);
      else if (event.key === "ArrowUp") nextIndex = Math.max(0, index - cols);
      else if (event.key === "ArrowDown") nextIndex = Math.min(items.length - 1, index + cols);
      else if (event.key === "PageUp") nextIndex = Math.max(0, index - pageRows * cols);
      else if (event.key === "PageDown") nextIndex = Math.min(items.length - 1, index + pageRows * cols);
    } else {
      const rowH = Math.max(1, collection?.estimateRowHeight || 44);
      const pageRows = Math.max(1, Math.floor((list.clientHeight || 240) / rowH));
      if (event.key === "ArrowUp" || event.key === "ArrowLeft") nextIndex = Math.max(0, index - 1);
      else if (event.key === "ArrowDown" || event.key === "ArrowRight") nextIndex = Math.min(items.length - 1, index + 1);
      else if (event.key === "PageUp") nextIndex = Math.max(0, index - pageRows);
      else if (event.key === "PageDown") nextIndex = Math.min(items.length - 1, index + pageRows);
    }
    event.preventDefault();
    event.stopPropagation();
    if (nextIndex !== index) {
      focusCatalogIndex(nextIndex);
    }
  });

  // View Mode & Size Bar (Sidecar only; Sidebar owns its own display toolbar)
  const viewBar = make("div", "pp-lora-view-bar");
  const viewModes = make("div", "pp-lora-view-modes");
  const viewButtons = viewOptions.map(([key, label]) => {
    const control = button(label, () => { prefs.viewMode = key; persist(); syncViewMode(); renderList(false, false, { resetScroll: true }); }, "pp-lora-view-btn");
    viewModes.append(control);
    return [key, control];
  });
  const aspectSelect = select(aspectOptions, prefs.aspect, "pp-lora-select pp-lora-aspect-select");
  aspectSelect.setAttribute("aria-label", "Preview aspect ratio");
  aspectSelect.title = "Gallery card aspect ratio";
  aspectSelect.addEventListener("change", () => {
    prefs.aspect = aspectSelect.value;
    persist();
    renderList(true);
  });
  function syncViewMode() {
    for (const [key, control] of viewButtons) {
      control.classList.toggle("is-active", prefs.viewMode === key);
      control.setAttribute("aria-pressed", String(prefs.viewMode === key));
    }
    list.classList.toggle("is-grid", prefs.viewMode === "gallery");
    list.classList.toggle("is-list", prefs.viewMode === "list");
    list.dataset.layout = prefs.viewMode;
    if (!sidebar) {
      aspectSelect.value = prefs.aspect;
      aspectSelect.hidden = prefs.viewMode !== "gallery" || !prefs.images;
    }
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

  const applyCardSize = (value, { save = true } = {}) => {
    const val = Math.max(80, Math.min(240, Math.round(Number(value) || 125)));
    prefs.cardSize = val;
    sizeInput.value = String(val);
    sizeOutput.textContent = `${val}px`;
    sizeInput.setAttribute("aria-valuetext", `${val} pixel cards`);
    const progress = ((val - 80) / (240 - 80)) * 100;
    presentation.set(sizeInput, { "--pp-size-progress": `${progress}%` });
    if (!sidebar) {
      presentation.set(host, { "--pp-lora-preview-size": `${val}px` });
    }
    if (save) persist();
  };

  sizeInput.addEventListener("input", () => { applyCardSize(Number(sizeInput.value), { save: false }); renderList(true); });
  sizeInput.addEventListener("change", () => { applyCardSize(Number(sizeInput.value), { save: true }); });
  sizeInput.addEventListener("dblclick", () => { applyCardSize(125, { save: true }); renderList(true); });
  applyCardSize(prefs.cardSize, { save: false });
  syncViewMode();

  const refreshBtn = button("Refresh", () => load(true), "wg-button pp-lora-chip-btn", "refresh");
  refreshBtn.title = "Rescan local LoRA catalog";
  const imagesToggle = make("input");
  imagesToggle.type = "checkbox";
  imagesToggle.setAttribute("aria-label", "Show LoRA previews");
  imagesToggle.title = "Show local image and video previews";
  imagesToggle.checked = prefs.images;
  imagesToggle.addEventListener("change", () => {
    prefs.images = imagesToggle.checked;
    persist();
    syncViewMode();
    renderList();
    if (detailName) updateTriggersBox(detailName, { reveal: false });
  });
  const imagesLabel = make("label", "pp-tool-check pp-lora-check pp-lora-preview-toggle");
  imagesLabel.append(imagesToggle, make("span", "", "Previews"));

  // Refresh belongs to the catalog it rescans: keep it in the section header, not on its own row.
  catalogCtl.actions.insertBefore(count, catalogCtl.caretBtn);
  catalogCtl.actions.insertBefore(refreshBtn, catalogCtl.caretBtn);
  if (!sidebar) viewBar.append(viewModes, aspectSelect, imagesLabel, sizeLabel);

  const catalogToolbar = make("div", "pp-lora-catalog-toolbar");
  catalogToolbar.append(searchWrap, filterRow, ...(sidebar ? [] : [viewBar]));
  const catalogBody = catalogCtl.body;
  catalogBody.classList.add("pp-lora-catalog-body");
  catalogBody.append(catalogToolbar, list);

  // 3. LoRA Audition Lab
  const auditionLab = make("details", "pp-lora-section pp-lora-audition-lab");
  auditionLab.open = !!current || !!draft?.names?.length || variation != null;
  const auditionTitle = make("summary", "pp-lora-section-head pp-lora-audition-title");
  const auditionHeading = make("strong", "pp-lora-section-title");
  auditionHeading.innerHTML = `${svgIcon("sparkles", 13)}<span>LoRA Audition Lab</span>`;
  const auditionSelectedName = make("span", "pp-lora-audition-target", "Select a LoRA to test");
  const auditionHeadActions = make("div", "pp-lora-head-actions");
  const auditionCaret = make("span", "pp-lora-caret");
  auditionCaret.innerHTML = svgIcon("chevronDown", 12);
  auditionHeadActions.append(auditionSelectedName, auditionCaret);
  auditionTitle.append(auditionHeading, auditionHeadActions);

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

  const resetWeightBtn = button("1.0", () => {
    model.value = "1";
    clip.value = "1";
    linked.checked = true;
    for (const c of presetChips) c.classList.remove("is-active");
    update();
  }, "wg-button pp-lora-chip-btn pp-lora-weight-reset");
  resetWeightBtn.title = "Reset Model & CLIP to base strength 1.0";
  resetWeightBtn.setAttribute("aria-label", "Reset strengths to 1.0");

  const linkRow = make("div", "pp-lora-link-row");
  linkRow.append(linkLabel, resetWeightBtn);

  // Model info flyout: a Civitai-style pop-out mounted on <body> beside the picker.
  // It is deliberately not nested in the Audition Lab (collapsed by default, clipped
  // by the window/sidebar scroller, and far too narrow for a model page).
  const triggersBox = make("aside", "wg-root pp-lora-flyout");
  triggersBox.hidden = true;
  triggersBox.setAttribute("role", "dialog");
  triggersBox.setAttribute("aria-modal", "false");
  triggersBox.setAttribute("aria-label", "LoRA model info");
  const flyHead = make("header", "pp-lora-flyout-head");
  const flyTitle = make("span", "pp-lora-flyout-title");
  flyTitle.innerHTML = `${svgIcon("info", 13)}<span>Model info</span>`;
  const triggersNameBadge = make("span", "pp-lora-triggers-name-badge");
  const flyClose = make("button", "wg-close-btn");
  flyClose.type = "button";
  flyClose.innerHTML = svgIcon("close", 14);
  flyClose.setAttribute("aria-label", "Close model info");
  flyClose.title = "Close (Esc)";
  flyHead.append(flyTitle, triggersNameBadge, flyClose);

  const triggersBody = make("div", "pp-lora-flyout-body");
  const detailInfo = make("div", "pp-lora-detail-info");
  const triggersSection = make("section", "pp-lora-triggers-section");
  const triggersHead = make("div", "pp-lora-triggers-header");
  const triggersHeadLeft = make("div", "pp-lora-triggers-head-left");
  const triggerCountBadge = make("span", "pp-lora-trigger-count-badge");
  triggersHeadLeft.append(make("strong", "", "Trigger words"), triggerCountBadge, make("span", "pp-lora-triggers-hint", "Click to stage"));
  const copyTriggersBtn = button("Copy triggers", (e) => {
    e.stopPropagation();
    copyTriggersForDetail();
  }, "wg-button pp-lora-chip-btn pp-lora-copy-triggers-btn", "copy");
  copyTriggersBtn.title = "Copy all trigger words as plain text";
  triggersHead.append(triggersHeadLeft, copyTriggersBtn);
  const triggersList = make("div", "pp-lora-triggers-list");
  triggersSection.append(triggersHead, triggersList);
  triggersBody.append(detailInfo, triggersSection);

  const flyFoot = make("footer", "pp-lora-flyout-foot");
  const flyHint = make("span", "pp-lora-flyout-hint", "Trigger chips are staged for the next Insert / Replace.");
  const flyAdd = button("Add to prompt", () => { if (detailName) addOne(detailName); }, "wg-button primary pp-tool-primary pp-lora-apply-btn");
  flyAdd.title = "Insert this LoRA at the end of the prompt with the staged triggers";
  flyFoot.append(flyHint, flyAdd);
  triggersBox.append(flyHead, triggersBody, flyFoot);

  const isReadOnlyEditor = () => Boolean(editor.readOnly || editor.disabled || editor.getAttribute("aria-readonly") === "true");
  const shortName = name => identity(name).split("/").pop().replace(/\.[^./]+$/, "");
  function syncAuditionSummary() {
    if (!selected.size) {
      auditionSelectedName.textContent = "Select a LoRA to test";
      auditionSelectedName.title = "";
    } else if (selected.size === 1) {
      const [only] = selected;
      auditionSelectedName.textContent = shortName(only);
      auditionSelectedName.title = only;
    } else {
      auditionSelectedName.textContent = `${selected.size} LoRAs selected`;
      auditionSelectedName.title = [...selected].map(shortName).join(", ");
    }
  }

  // The flyout lives outside the node, so it must not leak pointer/keyboard events to the canvas.
  const promoteFlyout = () => {
    const idx = openFlyoutStack.indexOf(triggersBox);
    if (idx >= 0) openFlyoutStack.splice(idx, 1);
    openFlyoutStack.push(triggersBox);
  };
  const demoteFlyout = () => {
    const idx = openFlyoutStack.indexOf(triggersBox);
    if (idx >= 0) openFlyoutStack.splice(idx, 1);
  };
  for (const type of ["pointerdown", "mousedown", "click", "dblclick", "contextmenu"]) {
    triggersBox.addEventListener(type, e => {
      if (type === "pointerdown") promoteFlyout();
      e.stopPropagation();
    });
  }
  triggersBox.addEventListener("focusin", promoteFlyout);
  triggersBox.addEventListener("wheel", e => e.stopPropagation(), { passive: true });
  const releaseKeyboardBoundary = installPromptPaletteKeyboardBoundary(triggersBox);
  triggersBox.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeFlyout({ restoreFocus: true });
    }
  });
  flyClose.addEventListener("click", () => closeFlyout({ restoreFocus: true }));
  host.addEventListener("keydown", event => {
    if (event.defaultPrevented || event.isComposing) return;
    if (event.key === "Escape" && !triggersBox.hidden) {
      event.preventDefault();
      event.stopPropagation();
      closeFlyout({ restoreFocus: true });
      return;
    }
    const targetEl = event.target instanceof Element ? event.target : null;
    const isTextControl = Boolean(targetEl?.closest("input, textarea, select, [contenteditable]"));
    const isSlash = event.key === "/" && !isTextControl && !event.altKey && !event.ctrlKey && !event.metaKey;
    const isFind = (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "f";
    if (isSlash || isFind) {
      event.preventDefault();
      event.stopPropagation();
      if (!catalogCtl.isOpen()) catalogCtl.setOpen(true);
      search.focus();
      search.select();
    }
  });

  let flyoutTimer = 0, flyoutRectKey = "", flyoutTrigger = null, flyoutListenersBound = false;
  let lastDetailName = "", copyTimer = 0;
  const flyoutAnchor = () => host.closest(".pp-lora-sidecar-window, .pp-main-sidebar") || host;
  const BLOCKING_ESCAPE_SELECTOR = "dialog[open], .wg-choice-backdrop, .wg-global-settings-popup.open, .wg-ac-menu, .pp-style-sidecar-window.open, .pp-sidebar-appearance[open], .pp-gen-flyout";
  const isCtxMenuVisible = () => {
    const ctx = document.querySelector(".wg-ctx-menu");
    if (!ctx) return false;
    const display = typeof getComputedStyle === "function" ? getComputedStyle(ctx)?.display : "";
    return Boolean(display && display !== "none");
  };
  const isBlockingOverlayVisible = () => {
    if (isCtxMenuVisible()) return true;
    for (const el of document.querySelectorAll(BLOCKING_ESCAPE_SELECTOR)) {
      if (el.hidden) continue;
      const disp = typeof getComputedStyle === "function" ? getComputedStyle(el)?.display : "";
      if (disp !== "none") return true;
    }
    return false;
  };
  const onFlyoutOutsidePointerDown = (event) => {
    if (triggersBox.hidden) return;
    const t = event.target;
    if (!(t instanceof Node)) return;
    const el = t instanceof Element ? t : t.parentElement;
    if (triggersBox.contains(t) || flyoutAnchor().contains(t) || el?.closest?.(".wg-ctx-menu") || isCtxMenuVisible()) return;
    closeFlyout({ restoreFocus: false });
  };
  const onFlyoutDocKeyDown = (event) => {
    if (event.key !== "Escape" || triggersBox.hidden || event.defaultPrevented) return;
    if (openFlyoutStack[openFlyoutStack.length - 1] !== triggersBox) return;
    if (isBlockingOverlayVisible()) return;
    const targetEl = event.target instanceof Element ? event.target : null;
    if (host.contains(event.target) || triggersBox.contains(event.target) || targetEl?.closest?.(".pp-lora-sidecar-window")) return;
    const otherFlyout = targetEl?.closest?.(".pp-lora-flyout");
    if (otherFlyout && otherFlyout !== triggersBox) return;
    event.preventDefault();
    event.stopPropagation();
    closeFlyout({ restoreFocus: true });
  };
  function attachFlyoutListeners() {
    if (flyoutListenersBound) return;
    document.addEventListener("pointerdown", onFlyoutOutsidePointerDown, true);
    document.addEventListener("keydown", onFlyoutDocKeyDown, true);
    flyoutListenersBound = true;
  }
  function detachFlyoutListeners() {
    if (!flyoutListenersBound) return;
    document.removeEventListener("pointerdown", onFlyoutOutsidePointerDown, true);
    document.removeEventListener("keydown", onFlyoutDocKeyDown, true);
    flyoutListenersBound = false;
  }
  function syncFlyoutTheme() {
    presentation.syncPortalTheme(triggersBox);
    const scope = host.closest(".pp-lora-sidecar-window, .pp-main-sidebar, .wg-node, .pp-node, .ppwc-surface, .wg-root") || host;
    if (scope !== presentation.root) {
      copyPromptPaletteThemeScope(scope, triggersBox, presentation.declaration(triggersBox, { portal: true }));
      for (const cls of ["wg-high-contrast", "wg-reduce-motion", "wg-no-animations", "wg-disable-animations", "wg-large-text"]) {
        triggersBox.classList.toggle(cls, scope.classList?.contains(cls) === true);
      }
    }
  }
  function placeFlyout(force = false) {
    if (triggersBox.hidden || !triggersBox.isConnected) return;
    const rect = flyoutAnchor().getBoundingClientRect();
    if (rect.width <= 0 && rect.height <= 0) {
      closeFlyout({ restoreFocus: false });
      return;
    }
    const vw = globalThis.innerWidth || 1024, vh = globalThis.innerHeight || 768;
    const key = [rect.left, rect.top, rect.right, rect.bottom, vw, vh].map(Math.round).join();
    if (!force && key === flyoutRectKey) return;
    flyoutRectKey = key;
    const margin = 8, gap = 8;
    const roomRight = vw - margin - rect.right - gap;
    const roomLeft = rect.left - margin - gap;
    const bestRoom = Math.max(roomRight, roomLeft);
    let width, left;
    if (bestRoom >= 300) {
      const placeRight = roomRight >= 300 && (roomRight >= roomLeft || roomRight >= 420);
      const chosenRoom = placeRight ? roomRight : roomLeft;
      width = Math.max(300, Math.min(500, chosenRoom));
      left = placeRight ? rect.right + gap : rect.left - gap - width;
    } else {
      width = Math.max(280, Math.min(460, vw - margin * 2));
      left = Math.max(margin, vw - margin - width);
    }
    const maxAllowedH = Math.max(180, vh - margin * 2);
    const desiredTopSpace = Math.min(480, maxAllowedH);
    const idealTop = rect.top || margin;
    const top = Math.max(margin, Math.min(idealTop, Math.max(margin, vh - margin - desiredTopSpace)));
    const maxHeight = Math.max(180, Math.min(maxAllowedH, vh - margin - top));
    presentation.set(triggersBox, {
      "--pp-fly-left": `${Math.round(left)}px`,
      "--pp-fly-top": `${Math.round(top)}px`,
      "--pp-fly-width": `${Math.round(width)}px`,
      "--pp-fly-max-height": `${Math.round(maxHeight)}px`,
    });
  }
  function showFlyout({ focusFlyout = false } = {}) {
    if (dead) return;
    if (!triggersBox.isConnected) document.body.append(triggersBox);
    syncFlyoutTheme();
    triggersBox.hidden = false;
    promoteFlyout();
    placeFlyout(true);
    attachFlyoutListeners();
    if (!flyoutTimer) flyoutTimer = setInterval(placeFlyout, 150);
    // Artwork was created while hidden; ask the previews to re-evaluate visibility.
    detailPreviews.refreshPlayback();
    if (focusFlyout) flyClose.focus({ preventScroll: true });
  }
  function closeFlyout({ restoreFocus = false } = {}) {
    demoteFlyout();
    detachFlyoutListeners();
    if (triggersBox.hidden) return false;
    const hadFocus = triggersBox.contains(document.activeElement);
    triggersBox.hidden = true;
    clearInterval(flyoutTimer); flyoutTimer = 0;
    if (restoreFocus || hadFocus) {
      const returnTarget = flyoutTrigger?.isConnected
        ? flyoutTrigger
        : (detailName ? [...list.querySelectorAll("[data-lora-name]")].find(el => el.dataset.loraName === detailName) : null);
      returnTarget?.focus?.({ preventScroll: true });
    }
    flyoutTrigger = null;
    return true;
  }
  const onFlyoutResize = () => placeFlyout(true);
  globalThis.addEventListener?.("resize", onFlyoutResize);

  let activeDetailMeta = null;

  async function copyTriggersForDetail() {
    const meta = activeDetailMeta || metadataCache.get(detailName) || metadataCache.get(catalogName(detailName));
    const triggers = meta?.triggers || [];
    if (!triggers.length) {
      message(`No trigger words found for ${detailName ? identity(detailName).split("/").pop() : "this LoRA"}.`, true);
      return;
    }
    const cleanText = triggers.join(", ");
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(cleanText);
      } else {
        const ta = make("textarea", "pp-lora-clipboard-proxy");
        ta.value = cleanText;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
      }
      clearTimeout(copyTimer);
      copyTriggersBtn.innerHTML = `${svgIcon("check", 11)}<span>Copied!</span>`;
      copyTriggersBtn.classList.add("is-copied");
      copyTimer = setTimeout(() => {
        copyTimer = 0;
        if (dead) return;
        copyTriggersBtn.innerHTML = `${svgIcon("copy", 11)}<span>Copy triggers</span>`;
        copyTriggersBtn.classList.remove("is-copied");
      }, 1500);
      message(`Copied ${triggers.length} trigger word${triggers.length === 1 ? "" : "s"} to clipboard.`);
    } catch {
      message("Clipboard write failed.", true);
    }
  }

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
    syncAuditionSummary();
    model.value = "1"; clip.value = "1"; linked.checked = true;
    updateTriggersBox("");
    syncSelectionInDom();
    update();
  }, "wg-button pp-lora-clear-btn");

  const syntax = make("details", "pp-tool-details pp-lora-disclosure pp-lora-syntax-details");
  const synSummary = make("summary", "pp-lora-disclosure-summary");
  synSummary.innerHTML = `<span class="pp-lora-summary-title">${svgIcon("eye", 12)}<span>Syntax preview</span></span><span class="pp-lora-caret">${svgIcon("chevronDown", 12)}</span>`;
  const synBody = make("div", "pp-lora-disclosure-body");
  synBody.append(preview, note);
  syntax.append(synSummary, synBody);

  const actions = make("div", "pp-tool-actions pp-lora-actions-bar");
  actions.append(clear, apply);

  auditionBody.append(presetsRow, weights, linkRow, advanced, syntax, actions);
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
    catalogPreferencesChanged.dispatchEvent(new CustomEvent("change", { detail: host }));
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
  defaultColor.value = sanitizeHexColor(loadTheme().loraColor, accentHex());
  defaultColor.setAttribute("aria-label", "Default LoRA color");
  defaultColor.addEventListener("change", () => saveTheme({ ...loadTheme(), loraColor: defaultColor.value }));


  const colorRow = make("div", "pp-lora-color-row");
  colorRow.append(field("Default LoRA color", defaultColor, "pp-lora-inline-field"), button("Reset to theme accent", () => saveTheme({ ...loadTheme(), loraColor: "" }), "wg-button pp-lora-chip-btn"));

  const has = name => context.node?.inputs?.some((input, index) => input.name === name && (typeof context.node.isInputConnected === "function" ? context.node.isInputConnected(index) : input.link != null));
  const connNote = make("p", "pp-tool-note", context.node
    ? `${has("model") ? "MODEL connected" : "MODEL not connected"} · ${has("clip") ? "CLIP connected" : "CLIP not connected"}. Route Palette’s patched MODEL/CLIP outputs downstream. LoRAs in either prompt patch both channels.`
    : "Insertion only in this editor. Choose execution mode on the destination Palette node.");

  const fitSelect = select([["cover", "Fill frame (crop edges)"], ["contain", "Fit whole preview (no crop)"]], prefs.fit);
  const setFit = () => {
    presentation.set(host, { "--pp-lora-image-fit": prefs.fit });
    presentation.set(list, { "--pp-lora-image-fit": prefs.fit });
    presentation.set(triggersBox, { "--pp-lora-image-fit": prefs.fit });
  };
  fitSelect.addEventListener("change", () => { prefs.fit = fitSelect.value; persist(); setFit(); });
  setFit();
  const motionSelect = select([["hover", "Play on hover / keyboard focus"], ["still", "Still frames only"]], prefs.motion ? "hover" : "still");
  motionSelect.addEventListener("change", () => {
    prefs.motion = motionSelect.value === "hover"; persist();
    previews.refreshPlayback();
    detailPreviews.refreshPlayback();
  });
  prefBody.append(field("Video previews", motionSelect), make("p", "pp-tool-note", "Local JPEG, PNG and MP4 previews are discovered automatically. Videos are silent; reduced-motion settings keep them still. Refresh after changing local files."));
  prefBody.append(field("This node’s LoRA execution", execution), options, ...(sidebar ? [] : [field("Thumbnail framing", fitSelect)]), colorRow, connNote);
  preferences.append(prefSummary, prefBody);

  if (sidebar) host.append(catalogSection, activeDeck, setsPanel, auditionLab, preferences);
  else host.append(activeDeck, setsPanel, catalogSection, auditionLab, preferences);

  if (variation) {
    advanced.open = true;
    mode.value = variation;
    sweep.value = "0.4, 0.7, 1.0";
  }

  let code = "", stagedLoraCode = "", stagedTriggers = "";

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
      const strengths = parseLoraStrengths(sweep.value);

      const loraCode = buildLoraExpression({
        names: [...selected],
        model: Number(model.value),
        clip: Number(clip.value),
        linked: linked.checked,
        strengths,
        mode: mode.value,
        off: off.checked,
      });

      const baseSource = current
        ? `${snapshot.source.slice(0, current.start)} ${snapshot.source.slice(current.end)}`
        : snapshot.source;
      const triggers = missingLoraTriggers(baseSource, triggersInput.value);
      stagedLoraCode = loraCode;
      stagedTriggers = triggers;
      code = triggers ? `${loraCode} ${triggers}` : loraCode;
      preview.textContent = code;
      apply.disabled = false;
      apply.textContent = current ? "Replace LoRA" : (mode.value === "stack" ? "Insert LoRA" : "Audition LoRA");
    } catch (error) {
      code = "";
      stagedLoraCode = "";
      stagedTriggers = "";
      preview.textContent = error.message;
      apply.disabled = true;
    }
  }

  async function getMetadata(name) {
    const key = catalogName(name);
    const cached = metadataCache.get(key) || metadataCache.get(name);
    if (cached && (cached._full || cached.triggers !== undefined || cached.metadata_sources !== undefined)) {
      return cached;
    }
    const id = revision;
    try {
      const info = await API.loraInfo(key);
      if (dead || id !== revision) return cached || null;
      if (info && !info.error) {
        const enriched = { ...cached, ...info, _full: true };
        metadataCache.set(key, enriched);
        metadataCache.set(name, enriched);
        return enriched;
      }
    } catch {}
    return cached || null;
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
        revision++; metadataPending.clear(); metadataCache.delete(catalogName(name));
        renderList(false, true); updateTriggersBox(name);
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
      revision++; metadataPending.clear(); metadataCache.delete(catalogName(name));
      renderList(false, true); updateTriggersBox(name);
      message("Custom thumbnail removed; local model artwork is used when available.");
    } catch (error) { if (!dead) message(error.message, true); }
  }

  function resetLoraCustomColor(name) {
    const theme = loadTheme();
    const colors = { ...theme.loraColors };
    const cleanTarget = loraIdentity(name).replace(/\.[^./]+$/, "").toLowerCase();
    for (const key of Object.keys(colors)) {
      if (loraIdentity(key) === loraIdentity(name) || loraIdentity(key).replace(/\.[^./]+$/, "").toLowerCase() === cleanTarget) {
        delete colors[key];
      }
    }
    saveTheme({ ...theme, loraColors: colors });
    patchMountedNodes();
    renderActiveDeck();
  }

  function renderDetail(name, meta, isLoading = false) {
    activeDetailMeta = meta;
    detailPreviews.clear(detailInfo);
    detailInfo.replaceChildren();
    const detailTheme = loadTheme();
    presentation.set(triggersBox, {
      "--pp-lora-color": colorForLora(name, detailTheme),
      "--pp-lora-text": textColorForLora(name, detailTheme),
    });

    const displayName = identity(name);
    const cleanTitle = meta?.title || displayName.split("/").pop().replace(/\.[^./]+$/, "");
    const folderPath = displayName.includes("/") ? displayName.split("/").slice(0, -1).join("/") : "";
    const previewChoices = prefs.images && meta ? loraPreviewOptions(meta) : [];
    let showPreview = () => {};

    // 1. Hero: artwork + Civitai-style header
    safely("hero", () => {
      const hero = make("div", "pp-lora-detail-hero");
      const artwork = make("div", "pp-lora-detail-art");
      if (prefs.images) detailPreviews.append(artwork, name, meta);
      const header = make("div", "pp-lora-detail-header");
      const titleEl = make("strong", "pp-lora-detail-title", cleanTitle);
      titleEl.title = displayName;

      const badgeList = make("div", "pp-lora-badge-list");
      badgeList.append(make("span", "pp-lora-pill pp-lora-pill-type", "LoRA"));
      if (meta?.base_model) badgeList.append(make("span", "pp-lora-pill pp-lora-pill-model", meta.base_model));
      if (meta?.version) badgeList.append(make("span", "pp-lora-pill pp-lora-pill-version", meta.version));

      header.append(titleEl, badgeList);
      if (meta?.author) header.append(make("span", "pp-lora-detail-byline", `by ${meta.author}`));
      if (folderPath) {
        const folderSpan = make("span", "pp-lora-detail-folder");
        folderSpan.innerHTML = svgIcon("folder", 11);
        folderSpan.append(make("span", "", folderPath));
        folderSpan.title = `Folder: ${folderPath}`;
        header.append(folderSpan);
      }

      // Civitai-like stat row: only facts that are really on disk / in the sidecar.
      const stats = [];
      const size = formatBytes(meta?.size_bytes);
      if (size) stats.push(["File", size]);
      if (meta?.triggers?.length) stats.push(["Triggers", String(meta.triggers.length)]);
      const downloads = compactCount(meta?.download_count);
      if (downloads) stats.push(["Downloads", downloads]);
      const likes = compactCount(meta?.thumbs_up);
      if (likes) stats.push(["Likes", likes]);
      if (stats.length) {
        const row = make("div", "pp-lora-detail-stats");
        for (const [label, value] of stats) {
          const stat = make("span", "pp-lora-stat");
          stat.append(make("b", "", value), make("small", "", label));
          row.append(stat);
        }
        header.append(row);
      }
      if (meta?.civitai_url) {
        const link = make("a", "pp-lora-detail-link", "View on Civitai ↗");
        link.href = meta.civitai_url; link.target = "_blank"; link.rel = "noopener noreferrer";
        link.title = "Open the model page on civitai.com in your browser (the only online action here)";
        header.append(link);
      }
      hero.append(artwork, header);
      detailInfo.append(hero);

      // Preview switching (gallery strip + dropdown share one code path).
      if (previewChoices.length > 1) {
        const strip = make("div", "pp-lora-detail-strip");
        const thumbs = [];
        const choices = previewChoices.map(option => option.custom
          ? ["custom", "Custom thumbnail"]
          : [String(option.index), `${option.type === "video" ? "Video" : "Image"}: ${option.name}`]);
        const previewSelect = select(choices, choices[0][0]);
        showPreview = value => {
          detailPreviews.clear(artwork); artwork.replaceChildren();
          detailPreviews.append(artwork, name, meta, { preferredIndex: value === "custom" ? null : Number(value) });
          previewSelect.value = value;
          thumbs.forEach(([key, el]) => el.classList.toggle("is-active", key === value));
        };
        previewChoices.slice(0, 8).forEach((option, i) => {
          const key = choices[i][0];
          const thumb = make("button", "pp-lora-detail-thumb");
          thumb.type = "button"; thumb.title = choices[i][1]; thumb.setAttribute("aria-label", `Show ${choices[i][1]}`);
          detailPreviews.append(thumb, name, meta, { owner: thumb, preferredIndex: option.custom ? null : option.index, fallback: "" });
          thumb.addEventListener("click", () => showPreview(key));
          thumbs.push([key, thumb]); strip.append(thumb);
        });
        thumbs[0]?.[1].classList.add("is-active");
        previewSelect.addEventListener("change", () => showPreview(previewSelect.value));
        previewSelect.dataset.role = "preview-select";
        detailInfo.append(strip);
        detailInfo.__previewSelect = previewSelect;
      } else detailInfo.__previewSelect = null;
    });

    // 2. Toolbar: LoRA color + image actions + suggested strength
    safely("toolbar", () => {
      const toolbar = make("div", "pp-lora-detail-toolbar");
      let resetColorBtn = null;
      let swatchInput = null;
      const syncDetailColors = () => {
        const themeNow = loadTheme();
        presentation.set(triggersBox, {
          "--pp-lora-color": colorForLora(name, themeNow),
          "--pp-lora-text": textColorForLora(name, themeNow),
        });
        if (swatchInput) swatchInput.value = swatchHex(name, { theme: themeNow });
        if (resetColorBtn) resetColorBtn.hidden = !customColorForLora(name, themeNow);
      };
      swatchInput = colorSwatch(name, syncDetailColors);
      const colorLabel = make("label", "pp-lora-detail-color", "Color");
      colorLabel.append(swatchInput);
      toolbar.append(colorLabel);

      resetColorBtn = button("Reset color", () => {
        resetLoraCustomColor(name);
        syncDetailColors();
      }, "wg-button pp-lora-chip-btn");
      resetColorBtn.title = "Reset color to default accent";
      resetColorBtn.hidden = !customColorForLora(name, loadTheme());
      toolbar.append(resetColorBtn);

      toolbar.append(button(meta?.custom_preview ? "Change image" : "Set image", () => chooseThumbnail(name), "wg-button pp-lora-chip-btn"));
      if (meta?.custom_preview) {
        toolbar.append(button("Use folder preview", () => removeThumbnail(name), "wg-button pp-lora-chip-btn"));
      }

      if (Number.isFinite(meta?.recommended_strength)) {
        const recBtn = button(`Suggested: ${meta.recommended_strength}`, () => {
          model.value = String(meta.recommended_strength);
          if (Number.isFinite(meta.recommended_clip_strength)) {
            clip.value = String(meta.recommended_clip_strength);
            linked.checked = model.value === clip.value;
          } else if (linked.checked) {
            clip.value = model.value;
          }
          update();
          message(`Set strengths to suggested ${meta.recommended_strength}.`);
        }, "wg-button pp-lora-chip-btn pp-lora-rec-btn");
        recBtn.title = `Apply author's suggested base strength: ${meta.recommended_strength}`;
        toolbar.append(recBtn);
      }

      if (detailInfo.__previewSelect) toolbar.append(field("Preview", detailInfo.__previewSelect, "pp-lora-mini-field"));
      (detailInfo.querySelector(".pp-lora-detail-header") || detailInfo).append(toolbar);
    });

    // 3. Description card
    safely("description", () => {
      detailInfo.append(make("div", "pp-lora-detail-label", "About this model"));
      const descCard = make("div", "pp-lora-detail-desc");
      if (meta?.description) descCard.textContent = meta.description;
      else descCard.append(make("span", "pp-tool-note", isLoading ? "Reading model details…" : "No description in the local metadata."));
      detailInfo.append(descCard);
    });

    // 4. Tags
    safely("tags", () => {
      if (!meta?.tags?.length) return;
      const tagsWrap = make("div", "pp-lora-detail-tags");
      for (const t of meta.tags.slice(0, 16)) tagsWrap.append(make("span", "pp-lora-tag-chip", t));
      detailInfo.append(tagsWrap);
    });

    // 5. Source provenance
    safely("sources", () => {
      if (meta?.metadata_sources?.length || (meta?.preview_name && !meta?.custom_preview)) {
        const provNotes = [];
        if (meta.metadata_sources?.length) provNotes.push(`Sources: ${meta.metadata_sources.join(", ")}`);
        if (meta.preview_name && !meta.custom_preview) provNotes.push(`Artwork: ${meta.preview_name}`);
        detailInfo.append(make("small", "pp-lora-metadata-source", provNotes.join(" · ")));
      }
      if (meta?.metadata_error) detailInfo.append(make("small", "pp-tool-note", meta.metadata_error));
    });

    // 6. Trigger words
    safely("triggers", () => {
      triggersList.replaceChildren();
      if (isLoading) {
        triggerCountBadge.textContent = "";
        copyTriggersBtn.disabled = true;
        copyTriggersBtn.title = "Reading trigger words…";
        triggersList.append(make("span", "pp-tool-note", "Reading local metadata…"));
      } else if (!meta?.triggers?.length) {
        triggerCountBadge.textContent = "";
        copyTriggersBtn.disabled = true;
        copyTriggersBtn.title = "No trigger words recorded locally";
        triggersList.append(make("span", "pp-tool-note", "No trigger words recorded locally."));
      } else {
        triggerCountBadge.textContent = `(${meta.triggers.length})`;
        copyTriggersBtn.disabled = false;
        copyTriggersBtn.title = `Copy all ${meta.triggers.length} trigger words as plain text`;
        for (const trig of meta.triggers) {
          const chip = button(trig, () => {
            const parts = triggersInput.value.split(",").map(x => x.trim()).filter(Boolean);
            if (!parts.some(part => part.toLocaleLowerCase() === trig.toLocaleLowerCase())) parts.push(trig);
            triggersInput.value = parts.join(", "); update();
            message("Trigger staged. Use Add to prompt, or Insert / Replace, to add it to the prompt.");
          }, "pp-lora-trigger-chip");
          chip.title = `Stage "${trig}" for insertion`; triggersList.append(chip);
        }
      }
    });
    const readOnlyNow = isReadOnlyEditor();
    flyAdd.disabled = readOnlyNow;
    flyAdd.title = readOnlyNow
      ? "Choose an editable target editor first"
      : "Insert this LoRA at the end of the prompt with the staged triggers";
  }

  async function updateTriggersBox(name, { reveal = true, openLab = true, trigger = null, focusFlyout = false } = {}) {
    if (!name) {
      detailName = "";
      lastDetailName = "";
      closeFlyout();
      detailPreviews.clear(detailInfo);
      detailInfo.replaceChildren();
      triggersList.replaceChildren();
      triggerCountBadge.textContent = "";
      activeDetailMeta = null;
      return;
    }
    if (openLab) auditionLab.open = true;
    if (reveal) {
      flyoutTrigger = trigger || (document.activeElement && host.contains(document.activeElement) ? document.activeElement : flyoutTrigger);
    }
    const nextDetailName = catalogName(name);
    if (nextDetailName !== lastDetailName) {
      triggersBody.scrollTop = 0;
      lastDetailName = nextDetailName;
    }
    detailName = nextDetailName;
    const id = ++detailRevision;

    triggersNameBadge.textContent = identity(name).split("/").pop();
    presentation.set(triggersBox, { "--pp-lora-color": colorForLora(name, loadTheme()) });

    const cached = metadataCache.get(catalogName(name)) || metadataCache.get(name);
    const hasFull = cached && (cached._full || cached.triggers !== undefined || cached.metadata_sources !== undefined);

    renderDetail(name, cached || null, !hasFull);
    // Background refreshes only repaint a flyout that is already open; the user's own
    // actions (card click, Info button) are what pop it out.
    if (reveal && active) showFlyout({ focusFlyout });
    else if (!triggersBox.hidden) placeFlyout(true);

    if (!hasFull) {
      const meta = await getMetadata(name);
      if (dead || id !== detailRevision) return;
      renderDetail(name, meta, false);
      if (!triggersBox.hidden) placeFlyout(true);
    }
  }

  function addOne(name) {
    // Add is always additive, even after editing, swapping or a previous insert.
    target = { start: snapshot.source.length, end: snapshot.source.length };
    current = null; selected = new Set([name]);
    model.value = "1"; clip.value = "1"; linked.checked = true;
    mode.value = "stack"; sweep.value = ""; off.checked = false;
    triggersInput.value = "";
    commit(); updateTriggersBox(name, { reveal: false });
  }

  const metadataQueue = new Set();
  let metadataFrame = 0;

  const getAuthoredNames = () => new Set(loraTags(snapshot.source).map(t => catalogName(t.name)));
  const updateCountText = (matchCount = lastMatchCount) => {
    if (!loaded) {
      count.textContent = loadError || "Reading local LoRA catalog…";
      count.title = count.textContent;
      return;
    }
    count.textContent = `${selected.size} selected · ${matchCount} matches${!prefs.images ? (sidebar ? " · previews off · Sidebar settings → Preview images" : " · previews off · use the Previews switch") : ""}`;
    count.title = count.textContent;
  };

  function resolveMetadataInflight(batch) {
    for (const name of batch) {
      metadataPending.delete(name);
      metadataInflight.delete(name);
      const resolve = metadataResolvers.get(name);
      metadataResolvers.delete(name);
      resolve?.();
    }
  }

  function clearAllMetadataPending() {
    metadataQueue.clear();
    metadataPending.clear();
    for (const resolve of metadataResolvers.values()) resolve?.();
    metadataResolvers.clear();
    metadataInflight.clear();
  }

  function sharedRenderTheme() {
    const renderTheme = loadTheme();
    let renderAccent = "";
    return { theme: renderTheme, accent: () => renderAccent || (renderAccent = accentHex()) };
  }

  function patchItemNode(el, name, shared = sharedRenderTheme(), authoredNames = getAuthoredNames()) {
    if (!el) return;
    const meta = metadataCache.get(name);
    const isSelected = selected.has(name);
    const isInPrompt = authoredNames.has(name);
    const isFav = favorites.has(name);
    const cleanName = name.replace(/\\/g, "/").split("/").pop().replace(/\.[^./]+$/, "");
    const isCard = el.classList.contains("pp-lora-card");

    el.classList.toggle("is-selected", isSelected);
    el.classList.toggle("is-in-prompt", isInPrompt);
    const activeBadge = el.querySelector(".pp-lora-in-prompt-badge");
    if (activeBadge) activeBadge.hidden = !isInPrompt;

    presentation.set(el, {
      "--pp-lora-color": colorForLora(name, shared.theme),
      "--pp-lora-text": textColorForLora(name, shared.theme),
    });

    const swatch = el.querySelector(".pp-lora-entry-color");
    if (swatch) swatch.value = swatchHex(name, shared);

    const star = el.querySelector(".pp-lora-card-star:not(.pp-lora-card-info)");
    if (star) {
      star.textContent = isFav ? "★" : "☆";
      star.setAttribute("aria-pressed", String(isFav));
      star.setAttribute("aria-label", `Favorite ${name}`);
      star.title = isFav ? "Remove from favorites" : "Add to favorites";
    }

    const titleEl = el.querySelector(isCard ? ".pp-lora-card-body > strong" : ".pp-lora-row-info > strong");
    if (titleEl) {
      titleEl.textContent = meta?.title || cleanName;
      if (isCard) titleEl.title = name;
    }

    const modelBadge = el.querySelector(".pp-lora-model-badge");
    if (modelBadge) {
      modelBadge.textContent = meta?.base_model || "";
      if (isCard) {
        modelBadge.hidden = !meta?.base_model;
      } else {
        modelBadge.classList.toggle("is-empty", !meta?.base_model);
        modelBadge.setAttribute("aria-hidden", String(!meta?.base_model));
      }
    }

    if (isCard) {
      const metaEl = el.querySelector(".pp-lora-card-meta");
      if (metaEl) {
        let trigPill = metaEl.querySelector(".pp-lora-card-triggers");
        if (meta?.triggers?.length) {
          const text = `${meta.triggers.length} trigger${meta.triggers.length === 1 ? "" : "s"}`;
          if (!trigPill) {
            trigPill = make("span", "pp-lora-card-triggers", text);
            metaEl.append(trigPill);
          } else {
            trigPill.textContent = text;
          }
        } else if (trigPill) {
          trigPill.remove();
        }
      }
    }

    el.title = [name, meta?.base_model, meta?.triggers?.length && `Triggers: ${meta.triggers.join(", ")}`, meta?.description].filter(Boolean).join("\n");
  }

  function patchMountedNodes() {
    const shared = sharedRenderTheme();
    const authoredNames = getAuthoredNames();
    for (const el of list.querySelectorAll("[data-lora-name]")) {
      patchItemNode(el, el.dataset.loraName, shared, authoredNames);
    }
  }

  function syncSelectionInDom() {
    for (const el of list.querySelectorAll("[data-lora-name]")) {
      el.classList.toggle("is-selected", selected.has(el.dataset.loraName));
    }
    updateCountText(lastMatchCount);
  }

  function patchBatchMetadata(batch) {
    const batchSet = new Set(batch);
    const shared = sharedRenderTheme();
    const authoredNames = getAuthoredNames();
    for (const el of list.querySelectorAll("[data-lora-name]")) {
      const name = el.dataset.loraName;
      if (!batchSet.has(name)) continue;
      patchItemNode(el, name, shared, authoredNames);
      const meta = metadataCache.get(name);
      if (meta?.preview_width && meta?.preview_height && !el.classList.contains("pp-media-loaded")) {
        collection?.notifyMediaDimensions(el, meta.preview_width, meta.preview_height);
      }
    }
  }

  const matchesSearchQuery = (name, query) => {
    if (!query) return true;
    const lower = name.toLocaleLowerCase();
    if (lower.includes(query)) return true;
    const meta = metadataCache.get(name);
    return [meta?.base_model, meta?.title, ...(meta?.triggers || [])].some(t => t?.toLocaleLowerCase().includes(query));
  };

  function batchAffectsCurrentSearch(batch) {
    const query = search.value.trim().toLocaleLowerCase();
    if (!query) return false;
    const authoredNames = activeFilter === "active" ? getAuthoredNames() : null;
    const currentSet = new Set((collection?.items || []).map(item => item.name));
    return batch.some(name => {
      if (currentSet.has(name)) return false;
      if (activeFilter === "favorites" && !favorites.has(name)) return false;
      if (authoredNames && !authoredNames.has(name)) return false;
      if (selectedFolder !== "all") {
        const parts = name.replace(/\\/g, "/").split("/");
        const folder = parts.length > 1 ? parts.slice(0, -1).join("/") : "";
        if (folder !== selectedFolder && !folder.startsWith(`${selectedFolder}/`)) return false;
      }
      return matchesSearchQuery(name, query);
    });
  }

  async function flushMetadata() {
    metadataFrame = 0;
    const batch = [...metadataQueue].slice(0, 80), id = revision;
    batch.forEach(name => metadataQueue.delete(name));
    try {
      const res = await API.loraBatchInfo(batch);
      if (dead || id !== revision) return;
      for (const name of batch) metadataCache.set(name, res?.info?.[name] || {});
      resolveMetadataInflight(batch);
      patchBatchMetadata(batch);
      if (batchAffectsCurrentSearch(batch)) renderList(false, false, { resetScroll: false });
    } catch (error) {
      if (id === revision) resolveMetadataInflight(batch);
      if (!dead && id === revision) {
        batch.forEach(name => metadataCache.set(name, {}));
        message(`Local metadata could not be loaded: ${error.message}. Use Refresh to retry.`, true);
      }
    } finally {
      if (id === revision) resolveMetadataInflight(batch);
      if (!dead && metadataQueue.size) metadataFrame = setTimeout(flushMetadata, 0);
    }
  }

  function toggleSelected(name, triggerEl = null) {
    const wasSelected = selected.has(name);
    if (wasSelected) {
      selected.delete(name);
      syncAuditionSummary();
      syncSelectionInDom();
      update();
      return;
    }
    selected.add(name);
    if (!current) {
      model.value = "1"; clip.value = "1"; linked.checked = true;
    }
    syncAuditionSummary();
    updateTriggersBox(name, { trigger: triggerEl, openLab: false });
    syncSelectionInDom();
    update();
  }

  function toggleFavorite(name) {
    if (favorites.has(name)) favorites.delete(name);
    else if (favorites.size < 512) favorites.add(name);
    persist();
    if (activeFilter === "favorites" || activeSort === "favs") {
      renderList();
      return;
    }
    const isFav = favorites.has(name);
    for (const el of list.querySelectorAll("[data-lora-name]")) {
      if (el.dataset.loraName !== name) continue;
      const star = el.querySelector(".pp-lora-card-star:not(.pp-lora-card-info)");
      if (star) {
        star.textContent = isFav ? "★" : "☆";
        star.setAttribute("aria-pressed", String(isFav));
        star.title = isFav ? "Remove from favorites" : "Add to favorites";
      }
    }
  }

  const requestMetadata = name => {
    if (metadataCache.has(name) || metadataPending.has(name)) return;
    metadataPending.add(name);
    metadataQueue.add(name);
    if (!metadataInflight.has(name)) {
      let resolve;
      metadataInflight.set(name, new Promise(r => { resolve = r; }));
      metadataResolvers.set(name, resolve);
    }
    if (!metadataFrame) metadataFrame = setTimeout(flushMetadata, 0);
  };

  let catalogWidth = 0, catalogHeight = 0;

  function renderList(geometryOnly = false, forceClearPreviews = false, { resetScroll = false } = {}) {
    if (dead) return;
    if (sidebar && list.clientWidth <= 0) {
      const state = loadSidebarDisplay();
      prefs.viewMode = state.layouts.loras || "gallery";
      prefs.images = state.chrome.images;
      prefs.fit = state.chrome.fit;
      prefs.aspect = state.aspect;
      setFit();
      syncViewMode();
      list.dataset.images = String(prefs.images);
      list.dataset.fillRows = String(state.chrome.fillRows !== false);
      updateCountText(lastMatchCount);
      return;
    }

    const uiScale = Math.max(0.75, Math.min(2, Number(sidebar ? sidebar.uiScale?.() : loadTheme().uiFontScale) || 1));
    let metrics;
    let fillRows = true;
    let rowEstimate = 48;
    let rowHeightPx = 44;

    if (sidebar) {
      const state = loadSidebarDisplay();
      prefs.viewMode = state.layouts.loras || "gallery";
      prefs.images = state.chrome.images;
      prefs.fit = state.chrome.fit;
      prefs.aspect = state.aspect;
      setFit();
      syncViewMode();
      const cs = typeof getComputedStyle === "function" ? getComputedStyle(list) : null;
      const padX = (parseFloat(cs?.paddingLeft) || 0) + (parseFloat(cs?.paddingRight) || 0);
      const innerWidth = Math.max(120, (list.clientWidth || 320) - padX);
      metrics = sidebarLayoutMetrics("loras", uiScale, innerWidth);
      fillRows = state.chrome.fillRows !== false;
      rowHeightPx = Math.ceil(metrics.rowHeight);
      rowEstimate = rowHeightPx + 4;
    } else {
      syncViewMode();
      const cs = typeof getComputedStyle === "function" ? getComputedStyle(list) : null;
      const padX = (parseFloat(cs?.paddingLeft) || 0) + (parseFloat(cs?.paddingRight) || 0);
      const rawWidth = list.clientWidth || Math.max(240, host.clientWidth - 16) || prefs.cardSize * 2;
      const availWidth = Math.max(120, rawWidth - padX);
      const grid = resolveSidebarGrid(availWidth, prefs.cardSize, true, 8);
      const isNaturalRatio = prefs.aspect === "natural";
      const ratio = isNaturalRatio ? 1 : (SIDEBAR_ASPECT_RATIOS[prefs.aspect] ?? 1);
      const baseRowH = prefs.images ? Math.max(44, Math.min(108, Math.round(prefs.cardSize * 0.4) + 12)) : 42;
      rowHeightPx = Math.ceil(baseRowH * Math.max(1, uiScale));
      rowEstimate = rowHeightPx + 4;
      metrics = {
        ...grid,
        mode: prefs.viewMode,
        aspect: prefs.aspect,
        isNaturalRatio,
        ratio,
        density: grid.cardWidth < 96 ? "tiny" : grid.cardWidth < 160 ? "micro" : "normal",
        rowHeight: rowHeightPx,
      };
    }

    list.dataset.layout = metrics.mode;
    list.dataset.density = metrics.density;
    list.dataset.aspect = metrics.aspect;
    list.dataset.images = String(prefs.images);
    list.dataset.fillRows = String(fillRows);

    const listCss = {
      "--pp-lora-card-size": `${metrics.cardWidth}px`,
      "--pp-lora-row-height": `${rowHeightPx}px`,
      "--pp-lora-ratio": (!prefs.images && !sidebar && metrics.mode === "gallery")
        ? String(Math.max(2.5, metrics.cardWidth / 32))
        : String(metrics.ratio),
      "--pp-lora-image-fit": prefs.fit,
    };
    if (!sidebar) listCss["--pp-lora-preview-size"] = `${prefs.cardSize}px`;
    const listDecl = presentation.declaration(list);
    if (!prefs.images && !sidebar && ["masonry", "filmstrip"].includes(metrics.mode)) {
      listCss["--pp-natural-ratio"] = String(Math.max(2.5, metrics.cardWidth / 32));
    } else {
      listDecl?.removeProperty("--pp-natural-ratio");
    }
    presentation.set(list, listCss);

    if (!loaded) {
      updateCountText(0);
      return;
    }

    const modeChanged = lastRenderedMode !== null && metrics.mode !== lastRenderedMode;
    const shouldResetScroll = Boolean(resetScroll || modeChanged);
    const isListMode = metrics.mode === "list";
    const structuralModeChanged = lastRenderedMode !== null && (
      (lastRenderedMode === "list") !== isListMode
      || (metrics.mode !== lastRenderedMode && (["masonry", "filmstrip"].includes(metrics.mode) || ["masonry", "filmstrip"].includes(lastRenderedMode)))
    );
    const imagesToggled = lastRenderedImages !== null && lastRenderedImages !== prefs.images;
    const needsFullRebuild = forceClearPreviews || structuralModeChanged || imagesToggled;
    if (needsFullRebuild) geometryOnly = false;

    // Resizing changes presentation, not catalog membership or ordering.
    // Reuse the current collection's result instead of filtering/sorting again.
    let hits;
    const authoredNames = getAuthoredNames();
    if (geometryOnly && collection) {
      hits = collection.items.map(item => item.name);
    } else {
      const query = search.value.trim().toLocaleLowerCase();
      hits = names.filter(name => {
        if (!matchesSearchQuery(name, query)) return false;

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
        return a.localeCompare(b);
      });
      lastMatchCount = hits.length;
    }

    updateCountText(hits.length);

    if (!hits.length) {
      if (collection) {
        previews.clear(list);
        virtual.clear();
        collection = null;
      }
      const emptyWrap = make("div", "pp-lora-empty-state");
      const hasSearch = Boolean(search.value.trim());
      const hasFolder = selectedFolder !== "all";
      const hasFilter = activeFilter !== "all";
      let emptyText = "No local LoRA files found in ComfyUI’s loras folder.";
      if (names.length) {
        if (activeFilter === "favorites" && !hasSearch && !hasFolder) emptyText = "No favorite LoRAs yet. Click ☆ on any card or row to pin it.";
        else if (activeFilter === "active" && !hasSearch && !hasFolder) emptyText = "No active LoRAs in this prompt yet.";
        else emptyText = "No matching LoRAs for the current search or filters.";
      }
      emptyWrap.append(make("p", "pp-tool-empty", emptyText));
      if (names.length && (hasSearch || hasFolder || hasFilter)) {
        emptyWrap.append(button("Reset filters", () => {
          search.value = "";
          clearTimeout(searchTimer);
          searchRevision++;
          syncSearchClear();
          activeFilter = "all";
          selectedFolder = "all";
          folderSelect.value = "all";
          updateFilterPills();
          renderList(false, false, { resetScroll: true });
        }, "wg-button pp-lora-chip-btn"));
      }
      list.replaceChildren(emptyWrap);
      lastRenderedMode = metrics.mode;
      lastRenderedImages = prefs.images;
      list.scrollTop = 0;
      catalogWidth = list.clientWidth;
      catalogHeight = list.clientHeight;
      return;
    }

    const renderShared = sharedRenderTheme();
    const renderItem = name => {
      requestMetadata(name);
      const isSelected = selected.has(name);
      const isInPrompt = authoredNames.has(name);
      const isFav = favorites.has(name);
      const meta = metadataCache.get(name);
      const cleanName = name.replace(/\\/g, "/").split("/").pop().replace(/\.[^./]+$/, "");
      const folderName = name.replace(/\\/g, "/").includes("/") ? name.replace(/\\/g, "/").split("/").slice(0, -1).join("/") : "";

      if (metrics.mode !== "list") {
        const card = make("div", `pp-lora-card${isSelected ? " is-selected" : ""}${isInPrompt ? " is-in-prompt" : ""}`);
        card.dataset.loraName = name;
        presentation.set(card, {
          "--pp-lora-color": colorForLora(name, renderShared.theme),
          "--pp-lora-text": textColorForLora(name, renderShared.theme),
        });

        const media = make("div", "pp-lora-card-media");
        const badgeRow = make("div", "pp-lora-badge-row");
        const inPromptBadge = make("span", "pp-lora-in-prompt-badge", "In prompt");
        inPromptBadge.hidden = !isInPrompt;
        const modelBadge = make("span", "pp-lora-model-badge", meta?.base_model || "");
        modelBadge.hidden = !meta?.base_model;

        const star = button(isFav ? "★" : "☆", (e) => {
          e.stopPropagation();
          toggleFavorite(name);
        }, "pp-lora-card-star");
        star.setAttribute("aria-label", `Favorite ${name}`);
        star.setAttribute("aria-pressed", String(isFav));
        star.title = isFav ? "Remove from favorites" : "Add to favorites";

        const infoBtn = button("ⓘ", e => {
          e.stopPropagation();
          const key = catalogName(name);
          if (!triggersBox.hidden && detailName === key) {
            closeFlyout({ restoreFocus: true });
            return;
          }
          updateTriggersBox(key, { openLab: false, trigger: infoBtn, focusFlyout: e.detail === 0 });
        }, "pp-lora-card-star pp-lora-card-info");
        infoBtn.title = "Show model info, description and trigger words";
        infoBtn.setAttribute("aria-label", `Model info for ${name}`);
        badgeRow.append(inPromptBadge, colorSwatch(name, null, renderShared), infoBtn, star);
        media.append(badgeRow, modelBadge);

        if (prefs.images) {
          previews.append(media, name, meta, { owner: card, fallback: cleanName.slice(0, 8) });
        } else if (sidebar) {
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
          const trigPill = make("span", "pp-lora-card-triggers", `${meta.triggers.length} trigger${meta.triggers.length === 1 ? "" : "s"}`);
          metaEl.append(trigPill);
        }

        const add = button("+ Add", e => { e.stopPropagation(); addOne(name); }, "wg-button pp-lora-chip-btn pp-lora-card-add");
        add.setAttribute("aria-label", `Add ${name}`);
        body.append(titleEl, metaEl, add);
        card.append(media, body);

        card.addEventListener("click", event => {
          if (event.target.closest("button, input, select, textarea, a") || globalThis.getSelection?.()?.toString()) return;
          toggleSelected(name, card);
        });

        attachCatalogBehavior(card, name, meta);
        attachContextMenu(card, name);
        return card;
      } else {
        const row = make("div", `pp-lora-row${isSelected ? " is-selected" : ""}${isInPrompt ? " is-in-prompt" : ""}`);
        row.dataset.loraName = name;
        presentation.set(row, {
          "--pp-lora-color": colorForLora(name, renderShared.theme),
          "--pp-lora-text": textColorForLora(name, renderShared.theme),
        });

        if (prefs.images) {
          previews.append(row, name, meta, { className: "pp-lora-row-thumb", owner: row });
        }

        const info = make("div", "pp-lora-row-info");
        info.append(make("strong", "", meta?.title || cleanName), make("small", "", folderName ? `${folderName} / ${cleanName}` : cleanName));
        row.append(info);

        const tools = make("div", "pp-lora-row-tools");
        const inPromptBadge = make("span", "pp-lora-in-prompt-badge", "In prompt");
        inPromptBadge.hidden = !isInPrompt;
        const rowBadge = make("span", "pp-lora-model-badge", meta?.base_model || "");
        rowBadge.classList.toggle("is-empty", !meta?.base_model);
        rowBadge.setAttribute("aria-hidden", String(!meta?.base_model));
        tools.append(inPromptBadge, rowBadge);

        const star = button(isFav ? "★" : "☆", (e) => {
          e.stopPropagation();
          toggleFavorite(name);
        }, "pp-lora-card-star");
        star.setAttribute("aria-label", `Favorite ${name}`);
        star.setAttribute("aria-pressed", String(isFav));
        star.title = isFav ? "Remove from favorites" : "Add to favorites";

        const addBtn = button("+", (e) => {
          e.stopPropagation();
          addOne(name);
        }, "wg-button pp-lora-row-add");
        addBtn.setAttribute("aria-label", `Add ${name}`);
        addBtn.title = "Insert LoRA directly";

        const rowInfo = button("ⓘ", e => {
          e.stopPropagation();
          const key = catalogName(name);
          if (!triggersBox.hidden && detailName === key) {
            closeFlyout({ restoreFocus: true });
            return;
          }
          updateTriggersBox(key, { openLab: false, trigger: rowInfo, focusFlyout: e.detail === 0 });
        }, "pp-lora-card-star pp-lora-card-info");
        rowInfo.title = "Show model info, description and trigger words";
        rowInfo.setAttribute("aria-label", `Model info for ${name}`);
        tools.append(colorSwatch(name, null, renderShared), rowInfo, star, addBtn);
        row.append(tools);

        row.addEventListener("click", event => {
          if (event.target.closest("button, input, select, textarea, a") || globalThis.getSelection?.()?.toString()) return;
          toggleSelected(name, row);
        });

        attachCatalogBehavior(row, name, meta);
        attachContextMenu(row, name);
        return row;
      }
    };
    const renderThumbnail = (item, button) => {
      requestMetadata(item.name);
      if (prefs.images) previews.append(button, item.name, metadataCache.get(item.name), { owner: button, fallback: "◆" });
    };

    const sidebarTiny = Boolean(sidebar && metrics.density === "tiny");
    const bodyAllowance = prefs.images
      ? (sidebarTiny ? 4 : Math.ceil(86 * uiScale))
      : (sidebarTiny ? Math.ceil(58 * uiScale) : Math.ceil(32 + 86 * uiScale));
    const cardHeightForWidth = prefs.images
      ? (width => width / (metrics.isNaturalRatio ? 1 : metrics.ratio) + bodyAllowance + 8)
      : (() => bodyAllowance + 8);

    const layout = {
      mode: metrics.mode === "gallery" ? "grid" : metrics.mode,
      minCardWidth: metrics.cardWidth,
      columnCount: metrics.mode === "masonry" && !fillRows ? null : metrics.columns,
      fixedCardWidth: metrics.mode === "masonry" ? !fillRows : true,
      estimateRowHeight: rowEstimate,
      estimateCardHeight: cardHeightForWidth(metrics.cardWidth),
      estimateChromeHeight: bodyAllowance,
      cardHeightForWidth,
      imageAspectRatio: metrics.ratio,
      itemKey: item => item.name,
      getItemRatio: item => {
        const m = metadataCache.get(item.name);
        return m?.preview_width && m?.preview_height ? { width: m.preview_width, height: m.preview_height } : null;
      },
    };

    const items = hits.map(name => ({ name }));
    if (!collection) {
      if (needsFullRebuild) previews.clear(list);
      list.replaceChildren();
      if (shouldResetScroll && list.scrollTop !== 0) list.scrollTop = 0;
      collection = virtual.mount(list, {
        ...layout,
        items,
        renderItem: item => renderItem(item.name),
        renderThumbnail,
        gap: 8,
        styleDeclaration: presentation.declaration,
        releaseStyle: el => presentation.release(el),
        captureFocus: () => captureSidebarFocus(list, "[data-lora-name]", "loraName"),
        restoreFocus: snap => restoreSidebarFocus(list, "[data-lora-name]", "loraName", snap),
      });
      syncRovingTabIndex();
    } else if (geometryOnly) {
      const anchor = !shouldResetScroll ? virtual.captureViewportAnchor() : null;
      if (shouldResetScroll && list.scrollTop !== 0) list.scrollTop = 0;
      collection.updateLayout(layout);
      if (anchor) virtual.restoreViewportAnchor(anchor);
      collection.render();
      syncRovingTabIndex();
    } else {
      const focusSnap = captureSidebarFocus(list, "[data-lora-name]", "loraName");
      if (shouldResetScroll && list.scrollTop !== 0) list.scrollTop = 0;
      if (needsFullRebuild) previews.clear(list);
      collection.renderItem = item => renderItem(item.name);
      collection.updateLayout(layout);
      if (needsFullRebuild) {
        collection.setItems(items);
      } else {
        collection.updateItems(items, {
          patchNode: (el, item) => patchItemNode(el, item.name, renderShared, authoredNames),
        });
      }
      collection.render();
      restoreSidebarFocus(list, "[data-lora-name]", "loraName", focusSnap);
      syncRovingTabIndex();
    }

    lastRenderedMode = metrics.mode;
    lastRenderedImages = prefs.images;
    catalogWidth = list.clientWidth;
    catalogHeight = list.clientHeight;
  }

  // The effective LoRA colour is often the theme accent (a CSS variable); resolve it to a real
  // #rrggbb so swatches match the card edge. Canvas normalises any CSS colour syntax.
  function accentHex() {
    try {
      const ctx = document.createElement("canvas").getContext("2d");
      ctx.fillStyle = "#b8a0f0";
      ctx.fillStyle = getComputedStyle(host).getPropertyValue("--wg-accent").trim() || "#b8a0f0";
      return sanitizeHexColor(ctx.fillStyle, "#b8a0f0");
    } catch { return "#b8a0f0"; }
  }
  function swatchHex(name, shared = null) { return customColorForLora(name, shared?.theme ?? loadTheme()) || (shared?.accent ?? accentHex)(); }

  function colorSwatch(name, onChange = null, shared = null) {
    const input = make("input", "pp-lora-entry-color");
    input.type = "color"; input.value = swatchHex(name, shared);
    input.title = `Color for ${name}`; input.setAttribute("aria-label", input.title);
    input.addEventListener("click", event => event.stopPropagation());
    input.addEventListener("change", event => {
      event.stopPropagation();
      const theme = loadTheme();
      saveTheme({ ...theme, loraColors: { ...theme.loraColors, [loraIdentity(name)]: input.value } });
      patchMountedNodes();
      renderActiveDeck();
      if (detailName) presentation.set(triggersBox, { "--pp-lora-color": colorForLora(detailName, loadTheme()) });
      onChange?.();
    });
    return input;
  }

  function attachCatalogBehavior(element, name, meta) {
    element.tabIndex = focusedLoraName === name ? 0 : -1;
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
        if (!current) {
          model.value = "1"; clip.value = "1"; linked.checked = true;
        }
        mode.value = varMode;
        sweep.value = sweepVal;
        advanced.open = varMode !== "stack";
        off.checked = false;
        update();
        commit();
      };

      openCtxMenu(event.clientX, event.clientY, [
        { label: "Add to prompt (keep other LoRAs)", onSelect: () => addOne(name), group: "lora" },
        { label: "Local info & trigger words", onSelect: () => updateTriggersBox(name, { trigger: element }), group: "details" },
        { label: "Set / change thumbnail…", onSelect: () => chooseThumbnail(name), group: "appearance" },
        { label: "Remove custom thumbnail", disabled: !metadataCache.get(name)?.custom_preview, onSelect: () => removeThumbnail(name), group: "appearance" },
        { label: current ? "Replace selected LoRA" : "Insert this LoRA", onSelect: () => insert("stack"), group: "lora" },
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
        { label: "Reset LoRA color", disabled: !customColorForLora(name, loadTheme()), onSelect: () => {
            resetLoraCustomColor(name);
            if (!triggersBox.hidden && detailName === catalogName(name)) {
              const t = loadTheme();
              presentation.set(triggersBox, { "--pp-lora-color": colorForLora(name, t), "--pp-lora-text": textColorForLora(name, t) });
            }
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
    syncAuditionSummary();
  }

  async function load(forceRefresh = false) {
    pending?.abort();
    const controller = (pending = new AbortController());
    const id = ++revision;
    const hadPrevious = loaded && names.length > 0;
    if (!hadPrevious) loaded = false;
    loadError = "";
    refreshBtn.disabled = true;
    try {
      count.textContent = forceRefresh ? "Refreshing local LoRA catalog…" : "Reading local LoRA catalog…";
      const response = await API.loras({ signal: controller.signal, refresh: forceRefresh });
      if (dead || id !== revision) return;
      metadataCache.clear();
      clearAllMetadataPending();
      if (forceRefresh) API.bumpPreviewRevision?.();
      names = Array.isArray(response.names) ? [...new Set(response.names.filter(v => typeof v === "string"))] : [];
      folders = Array.isArray(response.folders) ? response.folders.filter(v => typeof v === "string") : [];
      loaded = true;

      folderSelect.replaceChildren();
      const allOpt = make("option", "", `All folders (${names.length})`);
      allOpt.value = "all";
      folderSelect.append(allOpt);

      const folderCounts = new Map();
      for (const name of names) {
        const path = name.replace(/\\/g, "/");
        for (let slash = path.indexOf("/"); slash >= 0; slash = path.indexOf("/", slash + 1)) {
          const folder = path.slice(0, slash);
          folderCounts.set(folder, (folderCounts.get(folder) || 0) + 1);
        }
      }
      for (const f of folders) {
        const countInFolder = folderCounts.get(f) || 0;
        const opt = make("option", "", `${f} (${countInFolder})`);
        opt.value = f;
        folderSelect.append(opt);
      }
      if (selectedFolder !== "all" && !folders.includes(selectedFolder)) selectedFolder = "all";
      folderSelect.value = selectedFolder;

      resolveSelection();
      if (catalogPrefsDirty) {
        catalogPrefsDirty = false;
        applyCatalogPreferencesFromStore({ render: false });
      }
      renderActiveDeck();
      renderList(false, forceRefresh);
      if (detailName || current) updateTriggersBox(detailName || catalogName(current.name), { reveal: false });
      update();
    } catch (error) {
      if (!dead && id === revision && error.name !== "AbortError") {
        loadError = error.message;
        if (hadPrevious) {
          loaded = true;
          updateCountText(lastMatchCount);
        } else {
          count.textContent = error.message;
        }
        message(error.message, true);
      }
    } finally {
      if (!dead && id === revision) refreshBtn.disabled = false;
    }
  }

  let applying = false;
  function applyToEditor(next, start, end) {
    applying = true;
    try {
      if (context.apply) {
        context.apply(next, start, end);
      } else {
        editor.value = next;
        editor.setSelectionRange(start, end);
        editor.dispatchEvent(new Event("input", { bubbles: true }));
      }
    } finally {
      applying = false;
    }
    const actual = typeof editor.value === "string" ? editor.value : next;
    Object.assign(snapshot, { source: actual, start, end });
    target = { start: end, end }; current = null;
    applied({ source: actual, start, end });
    renderActiveDeck();
    if (activeFilter === "active") renderList();
    else { patchMountedNodes(); syncSelectionInDom(); }
    update();
  }

  function commit() {
    try {
      ensureEditable();
      update();
      if (!code || apply.disabled) return;
      let next;
      if (current) {
        const replaced = `${snapshot.source.slice(0, current.start)}${stagedLoraCode}${snapshot.source.slice(current.end)}`;
        if (standaloneLoraTags(replaced).length > 0 || LORA_DOCK_HEADER_RE.test(replaced)) {
          next = dockLoraText(replaced, { appendTriggers: stagedTriggers });
        } else {
          next = stagedTriggers ? `${replaced.trimEnd()} ${stagedTriggers}` : replaced;
        }
      } else {
        next = dockLoraText(snapshot.source, { appendLora: stagedLoraCode, appendTriggers: stagedTriggers });
      }
      const end = next.length;
      const start = Math.max(0, end - stagedLoraCode.length);

      if (!keepOpen) close();
      editor.focus({ preventScroll: true });

      applyToEditor(next, start, end);

      if (keepOpen) {
        // A completed insert is no longer a replacement target.
        target = { start: end, end }; current = null;
        selected.clear(); triggersInput.value = "";
        model.value = "1"; clip.value = "1"; linked.checked = true;
        for (const c of presetChips) c.classList.remove("is-active");
        syncAuditionSummary();
        renderActiveDeck();
        if (activeFilter === "active") renderList();
        else { patchMountedNodes(); syncSelectionInDom(); }
        update();
      }
    } catch (error) {
      message(error.message, true);
    }
  }

  search.addEventListener("input", () => {
    syncSearchClear();
    renderList(false, false, { resetScroll: true }); clearTimeout(searchTimer);
    const id = ++searchRevision, catalogRevision = revision;
    if (!search.value.trim()) return;
    searchTimer = setTimeout(async () => {
      // Only search the remaining metadata when asked; scan in bounded local
      // batches instead of opening every model on normal panel startup.
      const remaining = names.filter(n => !metadataCache.has(n));
      for (let offset = 0; offset < remaining.length; offset += 80) {
        if (dead || id !== searchRevision || catalogRevision !== revision) return;
        try {
          const batchSlice = remaining.slice(offset, offset + 80);
          const response = await API.loraBatchInfo(batchSlice);
          if (dead || id !== searchRevision || catalogRevision !== revision) return;
          for (const [name, info] of Object.entries(response?.info || {})) metadataCache.set(name, info);
          resolveMetadataInflight(batchSlice);
          patchBatchMetadata(batchSlice);
          if (batchAffectsCurrentSearch(batchSlice)) renderList(false, false, { resetScroll: false });
        } catch { return; }
      }
    }, 250);
  });
  clip.addEventListener("input", () => { linked.checked = false; });
  for (const input of [model, clip, linked, mode, sweep, off, triggersInput]) {
    input.addEventListener("input", update);
  }
  mode.addEventListener("change", update);

  let appearanceDirty = false;
  function loraAppearanceSignature(theme) {
    const prefValues = Array.from(options.querySelectorAll("input"), input => `${input.dataset.preference}:${theme[input.dataset.preference] === true}`);
    return `${theme.loraColor || ""}|${JSON.stringify(theme.loraColors || {})}|${theme.uiFontScale}|${prefValues.join(",")}|${readEditorPreference("activeUiTheme", "")}`;
  }
  let lastAppearanceSig = loraAppearanceSignature(loadTheme());
  function syncAppearanceNow(theme = loadTheme()) {
    appearanceDirty = false;
    defaultColor.value = sanitizeHexColor(theme.loraColor, accentHex());
    for (const input of options.querySelectorAll("input")) input.checked = theme[input.dataset.preference] === true;
    patchMountedNodes();
    renderList(true);
    renderActiveDeck();
    if (detailName) {
      presentation.set(triggersBox, { "--pp-lora-color": colorForLora(detailName, theme) });
      const infoColor = detailInfo.querySelector("input.pp-lora-entry-color");
      if (infoColor) infoColor.value = sanitizeHexColor(colorForLora(detailName, theme), accentHex());
    }
    if (!triggersBox.hidden) syncFlyoutTheme();
  }
  const unsubscribe = onPromptPaletteAppearanceChanged(() => {
    if (dead) return;
    const theme = loadTheme();
    const sig = loraAppearanceSignature(theme);
    if (sig === lastAppearanceSig) return;
    lastAppearanceSig = sig;
    if (!active) { appearanceDirty = true; return; }
    syncAppearanceNow(theme);
  });

  let catalogPrefsDirty = false;
  function applyCatalogPreferencesFromStore({ render = true } = {}) {
    catalogPrefsDirty = false;
    renderSets();
    const saved = readEditorPreference("lora-picker", {});
    favorites.clear(); for (const name of saved.favorites || []) favorites.add(name);
    prefs.motion = saved.motion !== false;
    motionSelect.value = prefs.motion ? "hover" : "still";
    if (saved.sort && ["name-asc", "name-desc", "folder", "favs"].includes(saved.sort)) {
      activeSort = saved.sort;
      sortSelect.value = activeSort;
    }
    if (context.node?._ppLoraModeState) execution.value = context.node._ppLoraModeState.current() ?? "auto";
    if (!sidebar) {
      const savedView = readEditorPreference("loraViewMode");
      if (viewOptions.some(([key]) => key === savedView)) prefs.viewMode = savedView;
      const savedSize = Number(readEditorPreference("loraCardSize", prefs.cardSize));
      if (Number.isFinite(savedSize)) applyCardSize(savedSize, { save: false });
      if (aspectOptions.some(([key]) => key === saved.aspect)) {
        prefs.aspect = saved.aspect;
        aspectSelect.value = prefs.aspect;
      }
      prefs.images = saved.images !== false;
      prefs.fit = saved.fit === "contain" ? "contain" : "cover";
      imagesToggle.checked = prefs.images;
      fitSelect.value = prefs.fit;
      setFit();
      syncViewMode();
    }
    previews.refreshPlayback();
    detailPreviews.refreshPlayback();
    if (render) renderList();
  }
  const syncCatalogPreferences = event => {
    if (event.detail === host || dead) return;
    if (!active || !loaded) { catalogPrefsDirty = true; return; }
    applyCatalogPreferencesFromStore();
  };
  catalogPreferencesChanged.addEventListener("change", syncCatalogPreferences);

  let inputSyncDirty = false;
  let lastSyncedSource = snapshot.source;
  let lastSyncedStart = snapshot.start;
  let lastSyncedEnd = snapshot.end;
  const hasLoraTagText = (text) => typeof text === "string" && text.toLowerCase().includes("<lora:");
  const syncFromEditor = (force = false) => {
    if (applying) return;
    if (!active) { inputSyncDirty = true; return; }
    inputSyncDirty = false;
    const nextSource = editor.value;
    const nextStart = editor.selectionStart;
    const nextEnd = editor.selectionEnd;
    if (!force && nextSource === lastSyncedSource && nextStart === lastSyncedStart && nextEnd === lastSyncedEnd) return;
    lastSyncedSource = nextSource;
    lastSyncedStart = nextStart;
    lastSyncedEnd = nextEnd;
    const hadLoras = hasLoraTagText(snapshot.source);
    const hasLoras = hasLoraTagText(nextSource);
    const previousTags = hadLoras ? loraTags(snapshot.source) : null;
    snapshot.source = nextSource;
    const nextTags = hasLoras ? loraTags(nextSource) : null;
    applied({ source: nextSource, start: nextStart, end: nextEnd });
    target = { start: nextSource.length, end: nextSource.length }; current = null;
    if (context.node?._ppLoraModeState) execution.value = context.node._ppLoraModeState.current() ?? "auto";
    // Deck handlers capture tag offsets, so moving a tag also refreshes the deck.
    // Catalog media has no dependency on prose, tag offsets or strengths.
    const tagsChanged = (hadLoras || hasLoras) && JSON.stringify(previousTags || []) !== JSON.stringify(nextTags || []);
    if (tagsChanged) {
      renderActiveDeck();
      const membership = tags => JSON.stringify([...new Set((tags || []).map(tag => catalogName(tag.name)))].sort());
      if (membership(previousTags) !== membership(nextTags)) {
        if (activeFilter === "active") renderList();
        else patchMountedNodes();
      }
    }
    if (detailName) {
      const readOnlyNow = isReadOnlyEditor();
      flyAdd.disabled = readOnlyNow;
      flyAdd.title = readOnlyNow
        ? "Choose an editable target editor first"
        : "Insert this LoRA at the end of the prompt with the staged triggers";
    }
    if (selected.size > 0 || triggersInput.value.trim() || tagsChanged || !apply.disabled) update();
  };
  const onEditorInput = () => syncFromEditor(false);
  editor.addEventListener("input", onEditorInput);
  editor.addEventListener("pp-workspace-sync", onEditorInput);

  syncAuditionSummary();
  renderActiveDeck();
  update();
  load(false);

  const resize = new ResizeObserver(() => {
    if (dead) return;
    if (list.clientWidth && list.clientWidth !== catalogWidth) {
      catalogWidth = list.clientWidth;
      catalogHeight = list.clientHeight;
      renderList(true);
    } else if (list.clientHeight && list.clientHeight !== catalogHeight) {
      catalogHeight = list.clientHeight;
      virtual.refresh();
    }
  });
  resize?.observe(list);
  return {
    isLoaded: () => loaded,
    closeFlyout,
    syncTheme: () => { if (!dead && !triggersBox.hidden) syncFlyoutTheme(); },
    setActive(value) {
      active = !!value;
      if (!active) {
        closeFlyout();
      } else {
        if (appearanceDirty) syncAppearanceNow();
        if (catalogPrefsDirty && loaded) applyCatalogPreferencesFromStore();
        if (inputSyncDirty) syncFromEditor(true);
        if (loaded && list.clientWidth && list.clientWidth !== catalogWidth) {
          catalogWidth = list.clientWidth;
          catalogHeight = list.clientHeight;
          renderList(true);
        } else if (loaded && list.clientHeight && list.clientHeight !== catalogHeight) {
          catalogHeight = list.clientHeight;
          virtual.refresh();
        }
      }
      previews.refreshPlayback();
      detailPreviews.refreshPlayback();
    },
    refreshAppearance(geometryOnly = false) {
      if (dead) return;
      if (!loaded) {
        if (sidebar) {
          const state = loadSidebarDisplay();
          prefs.viewMode = state.layouts.loras || "gallery";
          prefs.images = state.chrome.images;
          prefs.fit = state.chrome.fit;
          prefs.aspect = state.aspect;
          setFit();
          syncViewMode();
        }
        return;
      }
      renderList(Boolean(geometryOnly));
    },
    syncTarget(range = null, sourceOverride = null) {
      if (sourceOverride && typeof sourceOverride.source === "string") {
        snapshot.source = sourceOverride.source;
        snapshot.start = sourceOverride.start ?? 0;
        snapshot.end = sourceOverride.end ?? snapshot.start;
      } else {
        snapshot.source = editor.value;
        snapshot.start = range?.start ?? editor.selectionStart ?? snapshot.source.length;
        snapshot.end = range?.end ?? editor.selectionEnd ?? snapshot.start;
      }
      lastSyncedSource = snapshot.source;
      lastSyncedStart = snapshot.start;
      lastSyncedEnd = snapshot.end;
      current = loraAt(snapshot.source, snapshot.start);
      target = current && snapshot.end <= current.end ? current : { start: snapshot.source.length, end: snapshot.source.length };
      if (current) {
        selected = new Set([catalogName(current.name)]);
        model.value = String(current.model); clip.value = String(current.clip);
        linked.checked = current.model === current.clip;
        updateTriggersBox(catalogName(current.name), { reveal: false, openLab: false });
      }
      syncAuditionSummary();
      if (detailName) {
        const readOnlyNow = isReadOnlyEditor();
        flyAdd.disabled = readOnlyNow;
        flyAdd.title = readOnlyNow
          ? "Choose an editable target editor first"
          : "Insert this LoRA at the end of the prompt with the staged triggers";
      }
      renderActiveDeck();
      if (activeFilter === "active") renderList();
      else { patchMountedNodes(); syncSelectionInDom(); }
      update();
    },
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
      dead = true;
      closeFlyout(); releaseKeyboardBoundary();
      clearTimeout(copyTimer); copyTimer = 0;
      globalThis.removeEventListener?.("resize", onFlyoutResize);
      detailPreviews.clear(detailInfo);
      detailPreviews.destroy();
      for (const el of deckItems.children) presentation.release(el);
      presentation.release(triggersBox);
      presentation.release(list);
      presentation.release(sizeInput);
      presentation.release(host);
      triggersBox.remove();
      unsubscribe();
      catalogPreferencesChanged.removeEventListener("change", syncCatalogPreferences);
      resize?.disconnect(); virtual.cleanup(); clearAllMetadataPending(); clearTimeout(metadataFrame);
      previews.destroy();
      ownScope?.cleanup();
      revision++; searchRevision++; clearTimeout(searchTimer);
      pending?.abort();
      editor.removeEventListener("input", onEditorInput);
      editor.removeEventListener("pp-workspace-sync", onEditorInput);
    },
  };
}
