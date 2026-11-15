import { readEditorPreference, writeEditorPreference } from "../prompt_palette_state.js";
import { downloadJsonFile } from "../prompt_palette_shared.js";
import { comparisonSources, matchingComparisonSource, diffPromptText, comparisonMetadata, recordedPaletteSeed } from "./history_comparison_model.js";

const DISPLAY_KEY = "generationHistoryComparisonV1";
const KEEPER_KEY = "prompt_palette_history_keeper_v1";
const LETTERS = "ABCD";
function el(tag, className = "", text = "") { const node = document.createElement(tag); node.className = className; node.textContent = text; return node; }
function button(text, action, key) {
  const node = el("button", "pp-history-btn pp-btn-sm", text); node.type = "button";
  if (key) node.dataset.compareControl = key;
  const kind = key?.split(":")[0];
  const tips = { refine: "Review recorded prompt data, then refine with Commit / Cancel", promote: "Review prompt data to copy into the editor or an A–D draft", keep: "Pin as this node’s comparison reference; the editor stays unchanged", "keep-candidate": "Use this candidate as the new Keeper reference", unpin: "Release the reference; its image and history stay saved", remove: "Remove from this comparison; its image and history stay saved" };
  if (tips[kind]) { node.title = text === "Unpin Keeper" ? tips.unpin : tips[kind]; node.setAttribute("aria-description", node.title); }
  node.addEventListener("click", action); return node;
}
function picker(name, values, value, action, key) {
  const wrap = el("label", "pp-compare-control"), node = el("select");
  wrap.append(el("span", "", name), node); node.setAttribute("aria-label", name); node.dataset.compareControl = key;
  for (const [id, text] of values) { const option = el("option", "", text); option.value = id; node.append(option); }
  node.value = value; node.addEventListener("change", () => action(node.value)); return wrap;
}

export function createHistoryComparison(host, { imageUrl, getNode = () => null, onKeeperChange = () => {}, onChange = () => {}, onDetails = () => {}, onKeep = () => {}, onRefine = () => {}, onPromote = () => {} } = {}) {
  const records = new Map(), sourceIds = new Map();
  const saved = readEditorPreference(DISPLAY_KEY, {}) || {};
  // Global preferences contain presentation only. A node retains only its Keeper
  // history ID in existing workflow properties; all evidence stays in history.
  const display = { view: saved.view === "wipe" ? "wipe" : "gallery", text: saved.text !== false, highlight: saved.highlight !== false };
  let referenceId = null, candidateId = null, keeperId = null, owner = null, wipe = 50, disposed = false;
  const feedback = el("p", "pp-history-note pp-compare-feedback"); feedback.setAttribute("role", "status");
  host.classList.add("pp-history-compare"); host.setAttribute("aria-label", "Generation comparison"); host.hidden = true;
  const remember = () => writeEditorPreference(DISPLAY_KEY, { ...display });
  function syncTarget() {
    const node = getNode(), saved = node?.properties?.[KEEPER_KEY];
    const id = typeof saved === "string" && saved.length <= 256 ? saved : null;
    if (node === owner && id === keeperId) return false;
    owner = node; keeperId = id; referenceId = id; candidateId = null;
    records.clear(); sourceIds.clear(); feedback.textContent = "";
    return true;
  }
  function persistKeeper(id) {
    keeperId = id;
    if (owner) {
      owner.properties ||= {};
      if (id) owner.properties[KEEPER_KEY] = id; else delete owner.properties[KEEPER_KEY];
      owner.setDirtyCanvas?.(true, true);
      onKeeperChange(id, owner);
    }
  }
  function setKeeper(record) {
    if (disposed || syncTarget()) { render(); onChange(); return; }
    if (!record?.id) {
      persistKeeper(null); feedback.textContent = "Keeper unpinned. The image and history stay saved."; normalizePair(); render(); onChange(); return;
    }
    if (!records.has(record.id) && records.size === 4) {
      // Replace the previous reference, retaining the candidate being inspected.
      const evict = records.has(referenceId) ? referenceId : [...records.keys()].find(id => id !== candidateId);
      records.delete(evict); sourceIds.delete(evict);
    }
    const old = referenceId;
    records.set(record.id, record); referenceId = record.id;
    if (candidateId === record.id) candidateId = old;
    persistKeeper(record.id); feedback.textContent = "Keeper pinned for this node. Compare another generation against it; the editor stays unchanged.";
    render(); onChange();
  }
  function normalizePair() {
    const ids = [...records.keys()];
    if (keeperId) referenceId = keeperId;
    else if (!records.has(referenceId)) referenceId = ids[0] || null;
    if (!records.has(candidateId) || candidateId === referenceId) candidateId = ids.find(id => id !== referenceId) || null;
  }
  function source(record, match = null) {
    const sources = comparisonSources(record);
    const chosen = sources.find(item => item.id === sourceIds.get(record?.id)) || matchingComparisonSource(sources, match);
    return { sources, chosen };
  }
  const filename = record => record?.image?.filename || "Unknown image";
  const letter = id => LETTERS[[...records.keys()].indexOf(id)] || "";
  const recordLabel = record => `${letter(record.id)} · ${filename(record)}`;
  function media(record, className = "") {
    const wrap = el("div", `pp-compare-media ${className}`);
    if (record.missing || !record.image?.filename) { wrap.append(el("span", "pp-history-note", "Original file missing")); return wrap; }
    const img = el("img"); img.src = imageUrl(record.image); img.alt = filename(record); img.decoding = "async";
    img.addEventListener("error", () => { img.remove(); wrap.append(el("span", "pp-history-note", "Preview unavailable")); }, { once: true });
    wrap.append(img); return wrap;
  }
  function remove(id) {
    if (syncTarget()) { render(); onChange(); return; }
    if (!records.delete(id)) return;
    if (id === keeperId) persistKeeper(null);
    sourceIds.delete(id); feedback.textContent = ""; normalizePair(); render(); onChange();
  }
  function imageGallery() {
    const gallery = el("div", "pp-compare-gallery");
    for (const record of records.values()) {
      const figure = el("figure", "pp-compare-figure"); figure.dataset.reference = String(record.id === referenceId); figure.dataset.candidate = String(record.id === candidateId);
      figure.append(media(record));
      const caption = el("figcaption"), title = el("strong", "", recordLabel(record)); title.title = filename(record);
      const actions = el("div", "pp-history-btn-group");
      actions.append(button("Details", () => onDetails(record), `details:${record.id}`), button(record.id === keeperId ? "Unpin Keeper" : "Keep", () => record.id === keeperId ? setKeeper(null) : onKeep(record), `keep:${record.id}`), button("Refine…", () => onRefine(record), `refine:${record.id}`), button("Promote…", () => onPromote(record), `promote:${record.id}`));
      if (record.id !== keeperId) actions.append(button("Remove", () => remove(record.id), `remove:${record.id}`));
      const role = record.id === keeperId ? "Keeper" : record.id === referenceId ? "Reference" : record.id === candidateId ? "Comparing" : "Selected";
      caption.append(title, el("small", "pp-history-note", `${role} · ${record.provenance === "verified" ? "Verified Palette output" : "Run context"}`), actions);
      figure.append(caption); gallery.append(figure);
    }
    host.append(gallery);
  }
  function imageWipe(reference, candidate) {
    const section = el("div", "pp-compare-wipe-section"), stage = el("div", "pp-compare-wipe");
    stage.style.setProperty("--pp-wipe", `${wipe}%`);
    stage.append(media(reference, "pp-compare-wipe-reference"), media(candidate, "pp-compare-wipe-candidate"), el("span", "pp-compare-divider"));
    const captions = el("div", "pp-compare-wipe-captions"); captions.append(el("span", "", `${letter(reference.id)} · ${keeperId ? "Keeper" : "Reference"}`), el("span", "", `${letter(candidate.id)} · Candidate`)); stage.append(captions);
    const controls = el("label", "pp-compare-wipe-controls"), range = el("input"), output = el("output", "", `${wipe}%`);
    range.type = "range"; range.min = "0"; range.max = "100"; range.value = wipe; range.dataset.compareControl = "wipe";
    range.setAttribute("aria-label", "Image comparison divider");
    range.addEventListener("input", () => { wipe = Number(range.value); stage.style.setProperty("--pp-wipe", `${wipe}%`); output.value = `${wipe}%`; });
    controls.append(el("span", "", "A/B divider"), range, output, button("Center", event => { event.preventDefault(); wipe = 50; range.value = "50"; range.dispatchEvent(new Event("input")); }, "center"));
    section.append(stage, controls, el("p", "pp-history-note", "Images fit the same frame without cropping. Use the divider's arrow keys for fine adjustments.")); host.append(section);
    const actions = el("div", "pp-history-btn-group");
    for (const [role, record] of [[keeperId ? "Keeper" : "Reference", reference], ["Candidate", candidate]]) {
      actions.append(button(`Refine ${role}…`, () => onRefine(record), `refine:${record.id}`), button(`Promote ${role}…`, () => onPromote(record), `promote:${record.id}`));
    }
    actions.append(button("Keep candidate", () => onKeep(candidate), "keep-candidate")); host.append(actions);
  }
  function renderText(reference, candidate) {
    const details = el("details", "pp-compare-text"), summary = el("summary", "", "Prompt differences"); details.open = display.text; details.append(summary);
    details.addEventListener("toggle", () => { if (details.isConnected && display.text !== details.open) { display.text = details.open; remember(); } });
    const a = source(reference), b = source(candidate, a.chosen);
    const panes = el("div", "pp-compare-text-panes");
    const diff = a.chosen && b.chosen ? diffPromptText(a.chosen.text, b.chosen.text) : null;
    const toolbar = el("div", "pp-compare-text-toolbar");
    const state = el("span", "pp-history-note", !diff ? "Stored prompt text is unavailable for one or both selections." : diff.identical ? "Identical stored text" : `${diff.additions} addition${diff.additions === 1 ? "" : "s"} · ${diff.removals} removal${diff.removals === 1 ? "" : "s"}`);
    state.setAttribute("role", "status");
    const highlight = el("input"); highlight.type = "checkbox"; highlight.checked = display.highlight; highlight.dataset.compareControl = "highlight";
    highlight.addEventListener("change", () => { display.highlight = highlight.checked; remember(); render(); });
    const label = el("label"); label.append(highlight, document.createTextNode(" Highlight changes")); toolbar.append(state, label); details.append(toolbar);
    for (const [side, record, selection] of [["reference", reference, a], ["candidate", candidate, b]]) {
      const pane = el("section", "pp-compare-text-pane");
      pane.append(el("strong", "", `${side === "reference" ? "Reference" : "Candidate"} ${letter(record.id)}`));
      const sources = selection.sources.map(item => [item.id, item.label]);
      const select = picker(`${side === "reference" ? "Reference" : "Candidate"} text source`, sources.length ? sources : [["", "No stored prompt text"]], selection.chosen?.id || "", value => { sourceIds.set(record.id, value); render(); }, `source:${record.id}`);
      select.querySelector("select").disabled = !sources.length; pane.append(select);
      const text = el("pre", "pp-history-prompt-text pp-compare-prompt");
      if (!selection.chosen) text.textContent = "No text was stored for this generation. Original image details may still be available in ComfyUI.";
      else if (!selection.chosen.text) text.textContent = "(Empty prompt)";
      else if (!display.highlight || !diff) text.textContent = selection.chosen.text;
      else for (const part of diff.parts) {
        if (side === "reference" && part.type === "add" || side === "candidate" && part.type === "remove") continue;
        const span = el(part.type === "remove" ? "del" : part.type === "add" ? "ins" : "span", "", part.text);
        if (part.type !== "equal") span.title = part.type === "add" ? "Added in candidate" : "Removed from reference";
        text.append(span);
      }
      pane.append(text);
      if (selection.chosen) {
        const scope = selection.chosen.scope === "verified" ? "Verified Palette output" : "Node context · image mapping unproven";
        pane.append(el("small", "pp-history-note", scope));
        pane.append(button("Copy text", async () => {
          try { await navigator.clipboard.writeText(selection.chosen.text); if (!disposed) feedback.textContent = `Copied ${side} text.`; }
          catch { if (!disposed) feedback.textContent = "Clipboard unavailable. Select and copy the text directly."; }
        }, `copy:${record.id}`));
      }
      panes.append(pane);
    }
    details.append(panes);
    if (a.chosen && b.chosen && (a.chosen.kind !== b.chosen.kind || a.chosen.channel !== b.chosen.channel || a.chosen.scope !== b.chosen.scope)) details.append(el("p", "pp-compare-notice", "These sources describe different channels, kinds of text or evidence. Choose matching sources for a like-for-like comparison."));
    details.append(el("p", "pp-history-note", "Differences describe the selected recorded text. Node context does not prove an image's exact inputs; downstream transformations and sampler noise are not inferred."));
    if (diff?.coarse) details.append(el("p", "pp-history-note", "Large changes are grouped into blocks to keep comparison responsive."));
    host.append(details);
  }
  function exportComparison() {
    if (syncTarget()) { render(); onChange(); return; }
    const reference = records.get(referenceId), referenceSource = source(reference).chosen;
    downloadJsonFile("PromptPalette_Comparison.json", {
      schema: "prompt-palette.history-comparison.v1", reference_id: referenceId, candidate_id: candidateId, keeper_id: keeperId,
      note: "File references and stored text only. Sampler noise seeds and downstream prompt changes are not inferred; original images are not included.",
      items: [...records.values()].map(record => ({ id: record.id, image: record.image, provenance: record.provenance,
        prompt_id: record.prompt_id, palette_seed: recordedPaletteSeed(record),
        text_source: source(record, referenceSource).chosen, notes: record.notes || "", tags: record.tags || [] })),
    });
    feedback.textContent = "Comparison exported with file references, selected text, notes and tags.";
  }
  function render() {
    if (disposed) return;
    syncTarget();
    const focused = host.contains(document.activeElement) ? document.activeElement?.dataset.compareControl : null;
    normalizePair(); host.hidden = !records.size && !keeperId; host.replaceChildren();
    if (host.hidden) return;
    const head = el("div", "pp-compare-header"); head.append(el("strong", "", `Compare · ${records.size}/4${keeperId ? " · Keeper pinned" : ""}`));
    const clear = button(keeperId ? "Clear candidates" : "Clear", () => {
      if (syncTarget()) { render(); onChange(); return; }
      for (const id of [...records.keys()]) if (id !== keeperId) { records.delete(id); sourceIds.delete(id); }
      feedback.textContent = ""; render(); onChange();
    }, "clear");
    const exportButton = button("Export JSON", exportComparison, "export"); exportButton.title = "Downloads file references, selected prompt text, notes and tags. Original images are not included.";
    exportButton.disabled = !records.size;
    head.append(exportButton, clear); host.append(head);
    if (keeperId) head.append(button("Unpin Keeper", () => setKeeper(null), "unpin"));
    const reference = records.get(referenceId), candidate = records.get(candidateId);
    if (keeperId && !reference) {
      host.append(el("p", "pp-compare-notice", "The pinned Keeper is not available yet. Refresh to reload its history record, or unpin it to choose another reference."));
      imageGallery(); host.append(feedback); return;
    }
    if (records.size > 1) {
      const controls = el("div", "pp-compare-controls"), options = [...records.values()].map(record => [record.id, recordLabel(record)]);
      const referencePicker = picker(keeperId ? "Keeper reference" : "Reference", options, referenceId, id => { const old = referenceId; referenceId = id; if (candidateId === id) candidateId = old; render(); }, "reference");
      referencePicker.querySelector("select").disabled = !!keeperId; controls.append(referencePicker);
      controls.append(picker("Candidate", options.filter(([id]) => id !== referenceId), candidateId, id => { candidateId = id; render(); }, "candidate"));
      controls.append(picker("Image view", [["gallery", "Gallery"], ["wipe", "A/B wipe"]], display.view, view => { display.view = view; remember(); render(); }, "view")); host.append(controls);
    }
    if (display.view === "wipe" && candidate) imageWipe(reference, candidate); else imageGallery();
    if (candidate) {
      renderText(reference, candidate);
      const info = el("details", "pp-compare-metadata"); info.append(el("summary", "", "Run details"));
      const table = el("table"), head = el("thead"), header = el("tr");
      for (const title of ["Recorded detail", `Reference ${letter(reference.id)}`, `Candidate ${letter(candidate.id)}`]) header.append(el("th", "", title)); head.append(header); table.append(head);
      const body = el("tbody");
      for (const row of comparisonMetadata(reference, candidate)) {
        const line = el("tr"); line.dataset.same = String(row.same);
        line.append(el("th", "", row.label), el("td", "", row.reference), el("td", "", row.candidate)); body.append(line);
      }
      table.append(body); info.append(table, el("p", "pp-history-note", "Palette seeds control prompt choices. Sampler noise seeds and downstream changes are not inferred.")); host.append(info);
    } else host.append(el("p", "pp-history-note", keeperId ? "Choose Compare on another generation to compare it against this Keeper. The reference stays pinned while browsing and filtering." : "Choose Compare on another generation to see differences. Keep pins a reference for this node."));
    host.append(feedback);
    if (focused) ([...host.querySelectorAll("[data-compare-control]")].find(node => node.dataset.compareControl === focused) || clear).focus({ preventScroll: true });
  }
  syncTarget(); render();
  return {
    has: id => records.has(id), keeper: () => keeperId, ids: () => [...new Set([keeperId, ...records.keys()].filter(Boolean))],
    syncTarget() { const changed = syncTarget(); if (changed) { render(); onChange(); } return changed; },
    setKeeper,
    toggle(record) {
      if (disposed || !record?.id) return false;
      if (syncTarget()) { render(); onChange(); return false; }
      if (record.id === keeperId) { feedback.textContent = "This is the pinned Keeper. Unpin it to remove the reference."; return false; }
      if (records.has(record.id)) { remove(record.id); return true; }
      if (records.size + (keeperId && !records.has(keeperId) ? 1 : 0) >= 4) {
        if (!keeperId) { feedback.textContent = "Four generations selected. Remove one to compare another."; return false; }
        const evict = [...records.keys()].find(id => id !== keeperId && id !== candidateId);
        records.delete(evict); sourceIds.delete(evict);
      }
      records.set(record.id, record); candidateId = record.id; feedback.textContent = ""; render(); onChange(); return true;
    },
    remove,
    forget(id) {
      if (syncTarget()) { render(); onChange(); return; }
      if (id === keeperId) persistKeeper(null);
      records.delete(id); sourceIds.delete(id); normalizePair(); render(); onChange();
    },
    update(updated) {
      if (disposed || syncTarget()) { render(); onChange(); return; }
      let changed = false;
      for (const record of updated) if (records.has(record.id) || record.id === keeperId) {
        const previous = records.get(record.id);
        if (Number.isInteger(previous?.revision) && Number.isInteger(record.revision) && record.revision < previous.revision) continue;
        records.set(record.id, record); changed = true;
      }
      if (changed) render();
    },
    cleanup() { disposed = true; records.clear(); sourceIds.clear(); host.replaceChildren(); host.hidden = true; },
  };
}
