import { api } from "../../../scripts/api.js";
import { readEditorPreference, writeEditorPreference } from "../prompt_palette_state.js";
import { VirtualCollectionManager } from "../library/virtual_collection.js";
import { API } from "../prompt_palette_api.js";
import { createHistoryComparison } from "./history_comparison.js";
import { historyRefinementSources, reviewHistoryRefinement } from "./history_restore.js";
import { PresentationScope } from "./sidebar_presentation.js";

const BASE = "/zf-prompt-palette/api/v1/generations";
const subscribers = new Set();
let captureTimer = 0, listening = false;
export async function requestGenerationHistory(path = "", method = "GET", body, signal) {
  const response = await api.fetchApi(BASE + path, { method, ...(signal ? { signal } : {}), ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
  const text = await response.text(); let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = null; }
  if (!response.ok) {
    const error = new Error(data?.error || data?.message || text || `History request failed (${response.status})`);
    error.status = response.status; throw error;
  }
  return data;
}
const request = requestGenerationHistory;
function completed() {
  clearTimeout(captureTimer);
  captureTimer = setTimeout(async () => {
    captureTimer = 0;
    try { await request("/sync", "POST", {}); for (const fn of subscribers) fn(); } catch { /* Each mounted view reports recovery errors on refresh. */ }
  }, 1200);
}
export function subscribeGenerationHistory(fn) {
  subscribers.add(fn);
  if (!listening) { for (const type of ["executed", "execution_success"]) api.addEventListener(type, completed); listening = true; }
  return () => { subscribers.delete(fn); if (!subscribers.size) { for (const type of ["executed", "execution_success"]) api.removeEventListener(type, completed); clearTimeout(captureTimer); captureTimer = 0; listening = false; } };
}
const subscribe = subscribeGenerationHistory;
function el(tag, cls = "", text = "") { const node = document.createElement(tag); node.className = cls; node.textContent = text; return node; }
export function generationImageUrl(image) {
  const path = `/view?${new URLSearchParams(image)}`;
  return typeof api.apiURL === "function" ? api.apiURL(path) : path;
}
export function mergeUniqueGenerationRows(existing, incoming, append = false) {
  const list = append && Array.isArray(existing) ? [...existing] : [];
  const indexById = new Map();
  for (let i = 0; i < list.length; i++) {
    const id = list[i]?.id;
    if (id != null) indexById.set(id, i);
  }
  for (const item of Array.isArray(incoming) ? incoming : []) {
    const id = item?.id;
    if (id != null && indexById.has(id)) {
      list[indexById.get(id)] = item;
    } else {
      if (id != null) indexById.set(id, list.length);
      list.push(item);
    }
  }
  return list;
}
const imageUrl = generationImageUrl;
function button(text, action) { const node = el("button", "pp-history-btn", text); node.type = "button"; node.addEventListener("click", action); return node; }
function label(text, control) { const node = el("label"); node.append(control, document.createTextNode(` ${text}`)); return node; }
function checkbox() { const node = el("input"); node.type = "checkbox"; return node; }
function select(values, name) { const node = el("select"); node.setAttribute("aria-label", name); for (const [value, text] of values) { const option = el("option", "", text); option.value = value; node.append(option); } return node; }

export function createGenerationHistory(host, { restore, getNode, onBack } = {}) {
  const root = el("section", "pp-generation-history"); host.append(root);
  const scope = new PresentationScope(root);

  if (onBack) {
    const topNav = el("div", "pp-history-top-nav");
    const returnBtn = button("← Back to library", onBack);
    returnBtn.className = "pp-history-btn pp-history-return-btn";
    const histHeading = el("span", "pp-history-heading", "Recent Generations");
    topNav.append(returnBtn, histHeading);
    root.append(topNav);
  }

  const head = el("div", "pp-history-controls");
  const enabled = checkbox(), sensitive = checkbox();
  const maximum = el("input"); maximum.type = "number"; maximum.min = "100"; maximum.max = "10000"; maximum.step = "100"; maximum.setAttribute("aria-label", "Maximum indexed generations");
  const settings = el("details"), summary = el("summary", "", "Generation history settings"); settings.append(summary);
  settings.append(label("Record Prompt Palette generations", enabled), label("Store authored prompt text and Fields state (may contain sensitive information)", sensitive), label("Maximum indexed entries", maximum));
  const note = el("p", "pp-history-note", "Images stay in ComfyUI output/temp. Run-associated entries do not prove a particular resolved prompt or seed. Verified labels identify saved Prompt Palette output with an unambiguous conditioning path. Downstream prompt changes and the sampler noise seed are not inferred."); settings.append(note); root.append(settings);
  const query = el("input"); query.type = "search"; query.placeholder = "Search prompt, filename, tag or run…"; query.setAttribute("aria-label", "Search generation history");
  const favorite = checkbox(), missing = checkbox();
  const date = select([["0", "All dates"], ["1", "Last day"], ["7", "Last week"], ["30", "Last month"]], "History date filter");
  const mode = select([["grid", "Gallery"], ["masonry", "Masonry"], ["list", "Compact rows"], ["filmstrip", "Filmstrip / detail"]], "History view");
  const size = el("input"); size.type = "range"; size.min = "64"; size.max = "320"; size.value = "160"; size.setAttribute("aria-label", "History thumbnail size");
  const savedDisplay = readEditorPreference("generationHistoryDisplayV1", {}) || {};
  if (["grid", "masonry", "list", "filmstrip"].includes(savedDisplay.mode)) mode.value = savedDisplay.mode;
  if (Number.isFinite(savedDisplay.size)) size.value = Math.max(64, Math.min(320, savedDisplay.size));
  let sortOrder = savedDisplay.sort === "oldest" ? "oldest" : "newest";
  const sortButton = button("", () => {
    sortOrder = sortOrder === "newest" ? "oldest" : "newest";
    syncSortButton();
    writeEditorPreference("generationHistoryDisplayV1", { ...readEditorPreference("generationHistoryDisplayV1", {}), sort: sortOrder });
    refresh(false, { resetScroll: true });
  });
  sortButton.className = "pp-history-btn pp-history-sort-btn";
  function syncSortButton() {
    const isOldest = sortOrder === "oldest";
    sortButton.textContent = isOldest ? "Oldest ↑" : "Newest ↓";
    sortButton.dataset.sort = sortOrder;
    sortButton.setAttribute("aria-pressed", String(isOldest));
    sortButton.title = isOldest ? "Sorted oldest first — click to show newest first" : "Sorted newest first — click to show oldest first";
    sortButton.setAttribute("aria-label", isOldest ? "Sort oldest first; click for newest first" : "Sort newest first; click for oldest first");
  }
  syncSortButton();
  const workflowHelp = el("details", "pp-history-workflow-help"); workflowHelp.open = savedDisplay.workflowHelp === true;
  workflowHelp.append(el("summary", "", "Refine, compare & keep"), el("p", "pp-history-note", "Refine reviews recorded prompt data before opening it in your active draft. Commit keeps edits; Cancel restores them. After generating, add results to Compare and Keep a reference for this node. Promote copies reviewed data into the editor or an A–D draft. Keep does not replace a draft or mark a Library favorite."));
  workflowHelp.addEventListener("toggle", () => { if (workflowHelp.isConnected) writeEditorPreference("generationHistoryDisplayV1", { ...readEditorPreference("generationHistoryDisplayV1", {}), workflowHelp: workflowHelp.open }); });
  root.append(workflowHelp);
  const refreshButton = button("Refresh", () => { refreshCompared(); refresh(); });
  let importing = false, importCancelled = false;
  const importButton = button("Import existing ComfyUI history", async () => {
    if (importing) { importCancelled = true; return; }
    if (!confirm("Index images from existing ComfyUI runs containing Prompt Palette? Original files stay in place. Authored text is stored only if enabled above.")) return;
    importing = true; importCancelled = false; importButton.textContent = "Cancel history import";
    try { let offset = 0, total = 0; do { const page = await request("/sync", "POST", { import_existing: true, offset }); total += page.added; status.textContent = `Indexed ${total} images…`; offset = page.next_offset; } while (offset !== null && !importCancelled && !disposed); await refresh(); }
    catch (error) { report(error); } finally { importing = false; importButton.textContent = "Import existing ComfyUI history"; }
  });
  head.append(query, label("Favorites", favorite), label("Missing files", missing), date, sortButton, mode, size, refreshButton, importButton); root.append(head);
  const status = el("p", "pp-history-note"); status.setAttribute("role", "status"); root.append(status);
  const list = el("div", "pp-history-list wg-library-display-scope"); list.tabIndex = 0; list.dataset.cardStretch = "true"; root.append(list);
  const more = button("Load more", () => refresh(true)); more.hidden = true; root.append(more);
  const detail = el("section", "pp-history-detail"); detail.hidden = true; root.append(detail);
  const comparison = el("section", "pp-history-compare"); comparison.hidden = true; list.before(comparison);
  const manager = new VirtualCollectionManager(list);
  let prefs = null, rows = [], cursor = null, sequence = 0, disposed = false, active = true, debounce = 0, unsubscribe = null;
  let collection = null, listPending = null, comparisonPending = null;
  let comparisonSequence = 0, comparisonActionSequence = 0, detailSequence = 0;
  let refineReview = null, refineSequence = 0;
  let historyTarget = getNode?.();
  const comparisonView = createHistoryComparison(comparison, { imageUrl, getNode, onChange: () => { comparisonActionSequence++; syncCompareButtons(); }, onDetails: showDetail,
    onKeeperChange: () => API.publishMetadataChange?.({ namespace: "generations", action: "keeper" }),
    onKeep: record => keepResult(record, false), onRefine: record => reviewResult(record), onPromote: record => reviewResult(record, true) });
  const unsubMetadata = API.onMetadataChange?.(detail => {
    if (disposed) return;
    if (["generations", "settings", "all"].includes(detail.namespace)) {
      if (detail.namespace === "settings" && detail.prefs && typeof detail.prefs === "object") {
        prefs = detail.prefs;
        enabled.checked = !!prefs.enabled;
        sensitive.checked = !!prefs.capture_prompts;
        if (prefs.max_entries != null) maximum.value = prefs.max_entries;
        syncCapture();
      }
      if (detail.namespace === "generations" && detail.action === "keeper") { if (active) refreshCompared(); return; }
      if (detail.namespace === "generations" && detail.action === "delete") comparisonView.forget(detail.id);
      if (!active) return;
      refreshCompared();
      refresh();
    }
  });
  function report(error) { if (!disposed && error?.name !== "AbortError") status.textContent = error.message || String(error); }
  function syncHistoryTarget() {
    const target = getNode?.();
    if (historyTarget !== target) {
      historyTarget = target; refineSequence++; comparisonActionSequence++; detailSequence++;
      refineReview?.close(); refineReview = null; detail.hidden = true;
    }
    return comparisonView.syncTarget();
  }
  async function reviewResult(record, promote = false) {
      const version = ++refineSequence;
      refineReview?.close(); refineReview = null;
      try {
        const target = getNode?.(), adapter = target?._ppHistoryRefinement;
        const baseline = adapter?.state();
        const fresh = await request(`/${encodeURIComponent(record.id)}`);
        if (disposed || !active || version !== refineSequence) return;
        if (getNode?.() !== target || adapter !== target?._ppHistoryRefinement || adapter?.state() !== baseline) throw new Error("The target editor changed. Choose Refine again.");
        const review = reviewHistoryRefinement(target, fresh, { promote, getTarget: getNode, validateRecord: async () => {
          const current = await request(`/${encodeURIComponent(fresh.id)}`);
          if (disposed || !active || version !== refineSequence || current.revision !== fresh.revision) throw new Error("The generation changed or this history view closed. Review Refine again.");
        } });
        refineReview = review;
        const applied = await review.done;
        if (refineReview === review) refineReview = null;
        if (applied && !disposed) status.textContent = promote ? "Selected prompt data promoted to the reviewed destination. Other drafts are preserved." : "Refinement opened in the reviewed editor. Use Commit or Cancel there; other drafts are preserved.";
      } catch (error) { if (error.status === 404) comparisonView.forget(record.id); report(error); }
  }
  function refineButton(record, compact = false, promote = false) {
    const control = button(promote ? "Promote…" : "Refine…", () => reviewResult(record, promote));
    control.className = `pp-history-btn${compact ? " pp-btn-sm" : ""}`;
    const usable = item => !promote || item.workspace || typeof item.positive === "string" || typeof item.negative === "string";
    // Most cards already have recoverable text. Validate and clone recorded
    // Fields only when they are needed to decide availability, or on review.
    const recoverable = historyRefinementSources(record, { includeFields: false }).some(usable) || historyRefinementSources(record).some(usable);
    control.disabled = !getNode || !recoverable;
    control.dataset.historyRefine = promote ? "promote" : "refine";
    control.dataset.recoverable = String(recoverable);
    describeRefineControl(control);
    return control;
  }
  function describeRefineControl(control) {
    const adapter = getNode?.()?._ppHistoryRefinement;
    const reason = !adapter?.alive() ? "Choose an open Prompt Palette or Combinatorial editor first."
      : adapter.isRefining() ? "Commit or Cancel the current refinement before recovering another generation."
      : control.dataset.recoverable !== "true" ? "No recoverable prompt data. Open Details to inspect recorded context; enable authored prompt capture for future runs."
      : "";
    control.disabled = !!reason;
    control.title = reason || (control.dataset.historyRefine === "promote"
      ? "Review prompt data to copy into the editor or a saved A–D draft"
      : "Review prompt data, then edit it with Commit / Cancel in the active draft");
    control.setAttribute("aria-description", control.title);
  }
  function syncCompareButtons() {
    for (const control of root.querySelectorAll("[data-history-refine]")) describeRefineControl(control);
    // Called by the comparison only after it is mounted.
    for (const control of root.querySelectorAll("[data-history-compare]")) {
      const selected = comparisonView.has(control.dataset.historyCompare);
      const keeper = comparisonView.keeper() === control.dataset.historyCompare;
      control.hidden = keeper;
      control.textContent = keeper ? "Keeper" : selected ? control.dataset.compareCompact === "true" ? "✓ Comp" : "✓ Compared" : "Compare";
      control.title = keeper ? "Pinned comparison reference" : selected ? "Remove from comparison" : "Add to comparison";
      control.setAttribute("aria-pressed", String(selected));
      control.setAttribute("aria-label", `${selected ? "Remove from comparison" : "Compare"}: ${control.dataset.historyFilename}`);
      control.closest(".pp-history-card")?.classList.toggle("pp-history-selected", selected);
    }
    for (const control of root.querySelectorAll("[data-history-keeper]")) {
      const keeper = comparisonView.keeper() === control.dataset.historyKeeper;
      control.textContent = keeper ? "✓ Keeper" : "Keep";
      control.title = keeper ? "Unpin this Keeper; its image and history stay saved" : "Pin as this node’s comparison reference; the editor stays unchanged";
      control.setAttribute("aria-label", `${keeper ? "Unpin Keeper" : "Keep as comparison reference"}: ${control.dataset.historyFilename}`);
      control.setAttribute("aria-pressed", String(keeper));
    }
  }
  const refinementChanged = event => { if (!disposed && event.detail?.node === getNode?.()) syncCompareButtons(); };
  window.addEventListener("pp-refinement-changed", refinementChanged);
  function keeperButton(record) {
    const control = button(comparisonView.keeper() === record.id ? "✓ Keeper" : "Keep", () => keepResult(record));
    control.dataset.historyKeeper = record.id;
    control.dataset.historyFilename = record.image.filename;
    control.title = "Pin as this node’s comparison reference; the editor stays unchanged";
    control.setAttribute("aria-label", `Keeper reference: ${record.image.filename}`);
    control.setAttribute("aria-pressed", String(comparisonView.keeper() === record.id));
    return control;
  }
  async function keepResult(record, toggle = true) {
      syncHistoryTarget();
      const target = getNode?.();
      if (!target?._ppHistoryRefinement?.alive()) { report(new Error("Choose an open Prompt Palette or Combinatorial editor first.")); return; }
      const version = ++comparisonActionSequence;
      try {
        const fresh = await request(`/${encodeURIComponent(record.id)}`);
        if (disposed || !active || getNode?.() !== target || version !== comparisonActionSequence) return;
        if (syncHistoryTarget()) return;
        comparisonView.setKeeper(toggle && comparisonView.keeper() === record.id ? null : fresh);
        comparison.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
      } catch (error) { if (error.status === 404) comparisonView.forget(record.id); report(error); }
  }
  function compareButton(record, compact = false) {
    const selected = comparisonView.has(record.id);
    const control = button(selected ? compact ? "✓ Comp" : "✓ Compared" : "Compare", async () => {
      syncHistoryTarget();
      const target = getNode?.(), version = ++comparisonActionSequence;
      try {
        const fresh = await request(`/${encodeURIComponent(record.id)}`);
        if (disposed || !active || getNode?.() !== target || version !== comparisonActionSequence) return;
        if (syncHistoryTarget()) return;
        comparisonView.toggle(fresh);
        comparison.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
      } catch (error) { if (error.status === 404) comparisonView.forget(record.id); report(error); }
    });
    control.dataset.historyCompare = record.id;
    control.dataset.historyFilename = record.image.filename;
    control.hidden = comparisonView.keeper() === record.id;
    control.dataset.compareCompact = String(compact);
    control.title = selected ? "Remove from comparison" : "Add to comparison";
    control.setAttribute("aria-label", `Compare ${record.image.filename}`);
    control.setAttribute("aria-pressed", String(selected));
    return control;
  }
  async function refreshCompared() {
    if (disposed || !active) return;
    syncHistoryTarget();
    const version = ++comparisonSequence;
    const target = getNode?.();
    comparisonPending?.abort();
    const controller = comparisonPending = new AbortController();
    const results = await Promise.all(comparisonView.ids().map(async id => {
      try { return { id, record: await request(`/${encodeURIComponent(id)}`, "GET", undefined, controller.signal) }; }
      catch (error) { return { id, error }; }
    }));
    if (comparisonPending === controller) comparisonPending = null;
    if (disposed || !active || controller.signal.aborted || getNode?.() !== target || version !== comparisonSequence) return;
    const updated = [];
    for (const result of results) {
      if (result.record) updated.push(result.record);
      else if (result.error.status === 404) { comparisonView.forget(result.id); status.textContent = "A comparison selection was removed from history; its reference was cleared."; }
      else report(result.error);
    }
    comparisonView.update(updated);
  }
  async function annotate(record, patch) {
    try { const saved = await request(`/${encodeURIComponent(record.id)}`, "PATCH", { ...patch, revision: record.revision }); Object.assign(record, saved); comparisonView.update([record]); API.publishMetadataChange?.({ namespace: "generations", action: "annotate", id: record.id }); paint(); return true; }
    catch (error) { report(error); return false; }
  }
  async function showDetail(record) {
    const version = ++detailSequence, target = getNode?.();
    try { record = await request(`/${encodeURIComponent(record.id)}`); }
    catch (error) { if (error.status === 404) comparisonView.forget(record.id); report(error); return; }
    if (disposed || !active || getNode?.() !== target || version !== detailSequence) return;
    detail.replaceChildren(); detail.hidden = false;

    // Header bar
    const topBar = el("div", "pp-history-detail-header");
    const backBtn = button("← Back to list", () => { detail.hidden = true; });
    backBtn.className = "pp-history-btn pp-history-back-btn";

    const titleWrap = el("div", "pp-history-detail-title-wrap");
    const title = el("h4", "pp-history-detail-filename", record.image.filename);
    const badge = el("span", `pp-history-badge pp-badge-${record.provenance}`);
    badge.textContent = record.provenance === "verified" ? "✓ Verified Prompt Palette" : "Run-Associated Context";
    titleWrap.append(title, badge);

    const topActions = el("div", "pp-history-detail-actions");
    const favBtn = button(record.favorite ? "★ Favorited" : "☆ Favorite", () => annotate(record, { favorite: !record.favorite }));
    favBtn.className = "pp-history-btn" + (record.favorite ? " pp-btn-fav-active" : "");
    const compBtn = compareButton(record);
    compBtn.className = "pp-history-btn";
    topActions.append(refineButton(record), refineButton(record, false, true), keeperButton(record), favBtn, compBtn);
    if (!record.missing) {
      const openLink = el("a", "pp-history-btn", "Open full image ↗");
      openLink.href = imageUrl(record.image);
      openLink.target = "_blank";
      openLink.rel = "noopener";
      topActions.append(openLink);
    }
    topBar.append(backBtn, titleWrap, topActions);
    detail.append(topBar);

    // Main layout container: preview column + info column
    const layout = el("div", "pp-history-detail-layout");

    // Left column: preview & metadata
    const leftCol = el("div", "pp-history-detail-preview-col");
    if (!record.missing) {
      const imgWrap = el("div", "pp-history-detail-img-wrap");
      const img = el("img", "pp-history-detail-img");
      img.src = imageUrl(record.image);
      img.alt = record.image.filename;
      imgWrap.append(img);
      leftCol.append(imgWrap);
    } else {
      const missingBox = el("div", "pp-history-missing-box", "Original image file is missing from disk.");
      leftCol.append(missingBox);
    }

    const metaCard = el("div", "pp-history-meta-card");
    const addMetaRow = (lbl, val, copyVal = null) => {
      if (val == null || val === "") return;
      const row = el("div", "pp-history-meta-row");
      row.append(el("span", "pp-history-meta-label", lbl));
      const valEl = el("span", "pp-history-meta-value", String(val));
      if (copyVal) {
        valEl.classList.add("pp-copyable");
        valEl.title = "Click to copy";
        valEl.addEventListener("click", async () => {
          try { await navigator.clipboard.writeText(copyVal); status.textContent = `Copied ${lbl}.`; } catch (e) {}
        });
      }
      row.append(valEl);
      metaCard.append(row);
    };

    addMetaRow("Date", record.completed_at ? new Date(record.completed_at).toLocaleString() : null);
    addMetaRow("Run ID", record.prompt_id ? (record.prompt_id.slice(0, 12) + "…") : null, record.prompt_id);
    addMetaRow("Output", `Node #${record.output_node_id} (Image ${record.output_index + 1})`);
    if (record.effective_seed != null) {
      addMetaRow("Palette seed", record.effective_seed_text ?? record.effective_seed, record.effective_seed_text ?? String(record.effective_seed));
    }
    if (record.workflow_hash) {
      addMetaRow("Workflow", record.workflow_hash.slice(0, 12) + "…", record.workflow_hash);
    }
    leftCol.append(metaCard);
    layout.append(leftCol);

    // Right column: prompts, contexts, and annotations
    const rightCol = el("div", "pp-history-detail-info-col");

    // If verified: render verified prompt card
    if (record.provenance === "verified" && record.resolved_positive != null) {
      const verifiedCard = el("div", "pp-history-section-card pp-history-verified-card");
      const vHead = el("div", "pp-history-card-header");
      vHead.append(el("span", "pp-history-card-title", "✓ Verified Palette Output"));
      verifiedCard.append(vHead);

      // Positive prompt block
      const posBlock = el("div", "pp-history-prompt-block");
      const posHead = el("div", "pp-history-prompt-header");
      posHead.append(el("span", "pp-history-prompt-label", "Positive prompt"));
      const posActions = el("div", "pp-history-btn-group");
      const copyPosBtn = button("📋 Copy", async () => {
        try { await navigator.clipboard.writeText(record.resolved_positive); status.textContent = "Copied verified resolved positive prompt."; } catch (e) { report(e); }
      });
      copyPosBtn.className = "pp-history-btn pp-btn-sm";
      posActions.append(copyPosBtn);
      if (restore) {
        const restPosBtn = button("↺ Restore…", async () => {
          try { await restore({ text: record.resolved_positive, channel: "positive", record, requiresConfirmation: true }); } catch (e) { report(e); }
        });
        restPosBtn.className = "pp-history-btn pp-btn-sm";
        posActions.append(restPosBtn);
      }
      posHead.append(posActions);
      posBlock.append(posHead, el("pre", "pp-history-prompt-text", record.resolved_positive));
      verifiedCard.append(posBlock);

      // Negative prompt block if present
      if (typeof record.resolved_negative === "string") {
        const negBlock = el("div", "pp-history-prompt-block");
        const negHead = el("div", "pp-history-prompt-header");
        negHead.append(el("span", "pp-history-prompt-label", "Negative prompt"));
        const negActions = el("div", "pp-history-btn-group");
        const copyNegBtn = button("📋 Copy", async () => {
          try { await navigator.clipboard.writeText(record.resolved_negative); status.textContent = "Copied verified resolved negative prompt."; } catch (e) { report(e); }
        });
        copyNegBtn.className = "pp-history-btn pp-btn-sm";
        negActions.append(copyNegBtn);
        if (restore) {
          const restNegBtn = button("↺ Restore…", async () => {
            try { await restore({ text: record.resolved_negative, channel: "negative", record, requiresConfirmation: true }); } catch (e) { report(e); }
          });
          restNegBtn.className = "pp-history-btn pp-btn-sm";
          negActions.append(restNegBtn);
        }
        negHead.append(negActions);
        negBlock.append(negHead, el("pre", "pp-history-prompt-text", record.resolved_negative));
        verifiedCard.append(negBlock);
      }

      // Wildcards used
      if (record.wildcards_used?.length) {
        const wcWrap = el("div", "pp-history-wildcards-row");
        wcWrap.append(el("span", "pp-history-meta-label", "Wildcards:"));
        const chips = el("div", "pp-history-wildcard-chips");
        for (const w of record.wildcards_used) {
          chips.append(el("span", "pp-history-wildcard-chip", w));
        }
        wcWrap.append(chips);
        verifiedCard.append(wcWrap);
      }
      rightCol.append(verifiedCard);
    } else {
      // Run-associated banner
      const banner = el("div", "pp-history-banner pp-banner-run-associated");
      banner.append(
        el("strong", "", "Run-Associated Context: "),
        document.createTextNode("This result has run-associated context. Participating Prompt Palette nodes are shown below; a specific image-to-prompt mapping was not proven.")
      );
      rightCol.append(banner);
    }

    // Authored Contexts
    const contexts = record.contexts || [];
    if (contexts.length) {
      const authTitle = el("div", "pp-history-section-title", "Participating Node Contexts");
      rightCol.append(authTitle);

      for (const ctx of contexts) {
        const ctxCard = el("div", "pp-history-section-card pp-history-node-card");
        const cHead = el("div", "pp-history-card-header");
        const cTitleGroup = el("div", "pp-history-context-title-group");
        const nodeTitle = ctx.title || `${ctx.node_type || "Prompt Palette"} #${ctx.node_id}`;
        cTitleGroup.append(el("span", "pp-history-card-title", nodeTitle));
        if (ctx.channel_role) {
          const roleBadge = el("span", `pp-history-role-badge pp-role-${ctx.channel_role}`);
          roleBadge.textContent = ctx.channel_role === "positive" ? "Positive conditioning" : ctx.channel_role === "negative" ? "Negative conditioning" : ctx.channel_role;
          cTitleGroup.append(roleBadge);
        }
        cHead.append(cTitleGroup);
        if (ctx.seed != null) {
          cHead.append(el("span", "pp-history-seed-badge", `Palette seed: ${ctx.seed_text ?? ctx.seed}`));
        }
        ctxCard.append(cHead);

        // Wildcards in this node
        if (ctx.wildcards_used?.length) {
          const wcWrap = el("div", "pp-history-wildcards-row");
          wcWrap.append(el("span", "pp-history-meta-label", "Wildcards:"));
          const chips = el("div", "pp-history-wildcard-chips");
          for (const w of ctx.wildcards_used) {
            chips.append(el("span", "pp-history-wildcard-chip", w));
          }
          wcWrap.append(chips);
          ctxCard.append(wcWrap);
        }

        // Resolved prompt for this node if present
        if (typeof ctx.resolved_prompt === "string") {
          const resBlock = el("div", "pp-history-prompt-block");
          const rHead = el("div", "pp-history-prompt-header");
          rHead.append(el("span", "pp-history-prompt-label", "Resolved positive node context"));
          const rActions = el("div", "pp-history-btn-group");
          const copyResBtn = button("📋 Copy resolved", async () => {
            try { await navigator.clipboard.writeText(ctx.resolved_prompt); status.textContent = "Copied resolved prompt."; } catch (e) { report(e); }
          });
          copyResBtn.className = "pp-history-btn pp-btn-sm";
          rActions.append(copyResBtn);
          if (restore) {
            const restResBtn = button("↺ Restore resolved…", async () => {
              try { await restore({ text: ctx.resolved_prompt, channel: "positive", record, context: ctx, requiresConfirmation: true }); } catch (e) { report(e); }
            });
            restResBtn.className = "pp-history-btn pp-btn-sm";
            rActions.append(restResBtn);
          }
          rHead.append(rActions);
          resBlock.append(rHead, el("pre", "pp-history-prompt-text", ctx.resolved_prompt));
          ctxCard.append(resBlock);
        }

        // Authored prompts
        for (const [key, channel] of [["authored_positive", "positive"], ["authored_negative", "negative"]]) {
          if (typeof ctx[key] !== "string") continue;
          const pBlock = el("div", "pp-history-prompt-block");
          const pHead = el("div", "pp-history-prompt-header");
          const labelText = `Authored ${channel} prompt`;
          pHead.append(el("span", "pp-history-prompt-label", labelText));
          const pActions = el("div", "pp-history-btn-group");
          const copyAuthBtn = button(`📋 Copy authored`, async () => {
            try { await navigator.clipboard.writeText(ctx[key]); status.textContent = `Copied authored ${channel} prompt.`; } catch (e) { report(e); }
          });
          copyAuthBtn.className = "pp-history-btn pp-btn-sm";
          pActions.append(copyAuthBtn);
          if (restore) {
            const restAuthBtn = button(`↺ Restore authored…`, async () => {
              try { await restore({ text: ctx[key], channel, record, context: ctx, requiresConfirmation: true }); } catch (e) { report(e); }
            });
            restAuthBtn.className = "pp-history-btn pp-btn-sm";
            pActions.append(restAuthBtn);
          }
          pHead.append(pActions);
          pBlock.append(pHead, el("pre", "pp-history-prompt-text", ctx[key]));
          ctxCard.append(pBlock);
        }
        rightCol.append(ctxCard);
      }
    }

    // Annotations card (Notes & Tags)
    const annotCard = el("div", "pp-history-section-card pp-history-annot-card");
    annotCard.append(el("div", "pp-history-card-header", "Notes & Tags"));

    const notesWrap = el("div", "pp-history-form-row");
    const notes = el("textarea", "pp-history-textarea");
    notes.value = record.notes || "";
    notes.placeholder = "Add personal notes, test results, or prompt observations…";
    notes.maxLength = 10000;
    notesWrap.append(el("span", "pp-history-form-label", "Notes"), notes);

    const tagsWrap = el("div", "pp-history-form-row");
    const tags = el("input", "pp-history-input");
    tags.type = "text";
    tags.value = (record.tags || []).join(", ");
    tags.placeholder = "e.g. portrait, cyberpunk, test, hero";
    tagsWrap.append(el("span", "pp-history-form-label", "Tags (comma-separated)"), tags);

    const saveStatus = el("span", "pp-history-save-status");
    const saveBtn = button("💾 Save annotations", async () => {
      saveStatus.textContent = "Saving…";
      const saved = await annotate(record, { notes: notes.value, tags: tags.value.split(",").map(x => x.trim()).filter(Boolean) });
      saveStatus.textContent = saved ? "✓ Annotations saved" : "Could not save — your edits are retained";
      setTimeout(() => { if (!disposed) saveStatus.textContent = ""; }, 2500);
    });
    saveBtn.className = "pp-history-btn pp-btn-primary";

    const annotActions = el("div", "pp-history-annot-actions");
    annotActions.append(saveBtn, saveStatus);
    annotCard.append(notesWrap, tagsWrap, annotActions);
    rightCol.append(annotCard);

    // Management footer
    const footerBar = el("div", "pp-history-footer-bar");
    const backBottomBtn = button("← Back to list", () => { detail.hidden = true; });
    backBottomBtn.className = "pp-history-btn";
    footerBar.append(backBottomBtn);

    if (record.missing) {
      const relinkBtn = button("Relink missing file…", async () => {
        const filename = prompt("Replacement filename in ComfyUI output/temp:", record.image.filename); if (!filename) return;
        const subfolder = prompt("Relative subfolder:", record.image.subfolder); if (subfolder === null) return;
        await annotate(record, { image: { type: record.image.type, filename, subfolder } }); await refresh();
      });
      relinkBtn.className = "pp-history-btn";
      footerBar.append(relinkBtn);
    }

    const removeBtn = button("🗑 Remove from history…", async () => {
      if (!confirm("Remove this generation from index? The original image file remains on disk.")) return;
      try {
        await request(`/${encodeURIComponent(record.id)}`, "DELETE", { revision: record.revision });
        detail.hidden = true;
        API.publishMetadataChange?.({ namespace: "generations", action: "delete", id: record.id });
        comparisonView.forget(record.id);
        await refresh();
      } catch (error) { report(error); }
    });
    removeBtn.className = "pp-history-btn pp-btn-danger";
    footerBar.append(removeBtn);
    rightCol.append(footerBar);

    layout.append(rightCol);
    detail.append(layout);
    syncCompareButtons();
    detail.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }

  function card(record) {
    const node = el("article", "wg-thumb-item pp-history-card");
    node.dataset.generationId = record.id;
    node.classList.toggle("pp-history-selected", comparisonView.has(record.id));
    const media = el("div", "wg-thumb-media");
    if (!record.missing) {
      const img = el("img", "wg-thumb-img");
      img.src = imageUrl(record.image);
      img.alt = record.image.filename;
      img.loading = "lazy";
      img.decoding = "async";
      img.addEventListener("load", () => {
        if (img.naturalWidth && img.naturalHeight) {
          collection?.notifyMediaDimensions(node, img.naturalWidth, img.naturalHeight);
        }
      }, { once: true });
      img.addEventListener("error", () => {
        img.remove();
        media.textContent = "Preview unavailable";
        collection?.notifyMediaError(node);
      }, { once: true });
      media.append(img);
    } else {
      media.append(el("span", "", "Original file missing"));
    }

    // Determine seed if present at record level or in any context
    const context = record.contexts?.find(c => c.seed != null);
    const seed = record.effective_seed_text ?? record.effective_seed ?? context?.seed_text ?? context?.seed;
    const badgeText = record.provenance === "verified" ? "✓ Verified" : "Run context";
    const dateStr = record.completed_at ? new Date(record.completed_at).toLocaleDateString() : "Date unknown";

    node.append(
      media,
      el("strong", "wg-thumb-name", record.image.filename),
      el("small", `pp-history-note pp-badge-${record.provenance}`, `${badgeText} · ${dateStr}${seed != null ? ` · Palette seed ${seed}` : ""}`)
    );

    const actions = el("div", "pp-history-actions");
    const detailsBtn = button("Details", () => showDetail(record));
    detailsBtn.className = "pp-history-btn pp-btn-sm";
    const favBtn = button(record.favorite ? "★" : "☆", () => annotate(record, { favorite: !record.favorite }));
    favBtn.className = "pp-history-btn pp-btn-sm" + (record.favorite ? " pp-btn-fav-active" : "");
    favBtn.dataset.historyFavorite = record.id;
    const compBtn = compareButton(record, true);
    compBtn.className = "pp-history-btn pp-btn-sm";
    const keepBtn = keeperButton(record); keepBtn.classList.add("pp-btn-sm");
    actions.append(detailsBtn, refineButton(record, true), favBtn, compBtn, keepBtn);

    if (!record.missing) {
      const link = el("a", "pp-history-btn pp-btn-sm", "Open ↗");
      link.href = imageUrl(record.image);
      link.target = "_blank";
      link.rel = "noopener";
      actions.append(link);
    }
    node.append(actions);
    return node;
  }
  function patchCard(node, record) {
    node.classList.toggle("pp-history-selected", comparisonView.has(record.id));
    const favBtn = node.querySelector("[data-history-favorite]");
    if (favBtn) {
      favBtn.textContent = record.favorite ? "★" : "☆";
      favBtn.className = "pp-history-btn pp-btn-sm" + (record.favorite ? " pp-btn-fav-active" : "");
    }
  }
  function emptyHistoryMessage() {
    if (query.value.trim() || favorite.checked || missing.checked || date.value !== "0") return "No matches. Clear the search or relax the filters to see more generations.";
    return prefs?.enabled ? "No indexed images yet. Queue a Prompt Palette generation or import existing ComfyUI history."
      : "No indexed images yet. Enable recording in Generation history settings, or import existing ComfyUI history.";
  }
  function paint(geometryOnly = false, { resetScroll = false } = {}) {
    if (disposed || !active) return;
    const prevScrollTop = list.scrollTop;
    list.dataset.historyView = mode.value;
    scope.set(list, { "--wg-personal-thumb-min": `${Number(size.value)}px` });
    if (!rows.length) { manager.clear(); collection = null; const empty = el("p", "pp-history-note", emptyHistoryMessage()); empty.setAttribute("role", "status"); list.replaceChildren(empty); return; }
    const minCardWidth = Number(size.value);
    const layout = {
      mode: mode.value,
      minCardWidth,
      estimateRowHeight: 100,
      estimateChromeHeight: 88,
      cardHeightForWidth: width => width + 88,
      estimateCardHeight: minCardWidth + 88,
      itemKey: record => record.id,
      getItemRatio: record => (record.width && record.height) ? { width: record.width, height: record.height } : null,
      thumbnailUrl: record => !record.missing && record.image ? imageUrl(record.image) : "",
    };
    if (!collection) {
      list.replaceChildren();
      collection = manager.mount(list, {
        ...layout,
        items: rows,
        renderItem: card,
        styleDeclaration: scope.declaration,
        releaseStyle: el => scope.release(el),
      });
      if (resetScroll) list.scrollTop = 0;
    } else {
      const modeChanged = collection.mode !== layout.mode;
      collection.updateLayout(layout);
      if (!geometryOnly) {
        if (modeChanged) collection.setItems(rows);
        else collection.updateItems(rows, { patchNode: patchCard });
      }
      collection.render();
      if (resetScroll) list.scrollTop = 0;
      else if (!modeChanged) list.scrollTop = prevScrollTop;
      manager.refresh();
    }
  }
  async function refresh(append = false, { resetScroll = false } = {}) {
    if (disposed || !active) return;
    if (syncHistoryTarget()) refreshCompared();
    const version = ++sequence;
    listPending?.abort();
    const controller = listPending = new AbortController();
    if (append) {
      more.disabled = true;
      more.textContent = "Loading…";
    }
    try {
      const params = new URLSearchParams({
        q: query.value,
        favorite: favorite.checked,
        missing: missing.checked,
        since: date.value === "0" ? "0" : String(Date.now() - Number(date.value) * 86400000),
        sort: sortOrder,
      });
      if (append && cursor) params.set("cursor", cursor);
      const page = await request(`?${params}`, "GET", undefined, controller.signal); if (disposed || !active || controller.signal.aborted || version !== sequence) return;
      const incoming = Array.isArray(page?.items) ? page.items : [];
      rows = mergeUniqueGenerationRows(rows, incoming, append); cursor = page?.next_cursor || null; more.hidden = !cursor; comparisonView.update(incoming);
      status.textContent = rows.length ? `${rows.length} indexed images shown${cursor ? " · more available" : ""}` : ""; paint(false, { resetScroll }); syncCompareButtons();
    } catch (error) { if (active && version === sequence) report(error); }
    finally {
      if (listPending === controller) listPending = null;
      if (!disposed && listPending === null) {
        more.disabled = false;
        more.textContent = "Load more";
      }
    }
  }
  async function saveSettings() {
    if (!prefs) return;
    try { prefs = await request("/settings", "PUT", { enabled: enabled.checked, capture_prompts: sensitive.checked, max_entries: Number(maximum.value), revision: prefs.revision || 0 }); syncCapture(); API.publishMetadataChange?.({ namespace: "settings", action: "generation-history", prefs }); if (prefs.enabled) { await request("/sync", "POST", {}); await refresh(); } }
    catch (error) { report(error); enabled.checked = !!prefs.enabled; sensitive.checked = !!prefs.capture_prompts; }
  }
  function syncCapture() { unsubscribe?.(); unsubscribe = null; if (prefs?.enabled && !disposed) unsubscribe = subscribe(() => { refreshCompared(); refresh(); }); }
  for (const control of [enabled, sensitive, maximum]) control.addEventListener("change", saveSettings);
  query.addEventListener("input", () => { clearTimeout(debounce); debounce = setTimeout(() => refresh(false, { resetScroll: true }), 125); });
  for (const control of [favorite, missing, date]) control.addEventListener("change", () => refresh(false, { resetScroll: true }));
  const displayChanged = () => { writeEditorPreference("generationHistoryDisplayV1", { ...readEditorPreference("generationHistoryDisplayV1", {}), mode: mode.value, size: Number(size.value) }); paint(true); };
  mode.addEventListener("change", displayChanged); size.addEventListener("input", displayChanged);
  (async () => { try { prefs = await request("/settings"); if (disposed) return; enabled.checked = prefs.enabled; sensitive.checked = prefs.capture_prompts; maximum.value = prefs.max_entries; enabled.disabled = prefs.capture_available === false; if (enabled.disabled) note.textContent += " Capture is unavailable in multi-user mode because ComfyUI does not expose authenticated run ownership."; syncCapture(); if (prefs.enabled && active) await request("/sync", "POST", {}); if (active) refreshCompared(); await refresh(); } catch (error) { report(error); } })();
  function cancelViewRequests() {
    sequence++; comparisonSequence++;
    listPending?.abort(); listPending = null;
    comparisonPending?.abort(); comparisonPending = null;
    clearTimeout(debounce);
  }
  return {
    refresh,
    refreshTarget() { if (disposed) return; if (syncHistoryTarget() && active) refreshCompared(); syncCompareButtons(); },
    setActive(value) {
      if (disposed || active === !!value) return;
      active = !!value;
      if (!active) {
        cancelViewRequests(); refineSequence++; comparisonActionSequence++; detailSequence++;
        refineReview?.close(); refineReview = null;
      } else {
        refreshCompared();
        if (prefs?.enabled) request("/sync", "POST", {}).then(() => refresh()).catch(report);
        else refresh();
      }
    },
    cleanup() {
      disposed = true; cancelViewRequests(); comparisonActionSequence++; detailSequence++; refineSequence++;
      refineReview?.close(); refineReview = null; importCancelled = true; unsubscribe?.();
      window.removeEventListener("pp-refinement-changed", refinementChanged);
      unsubMetadata?.(); comparisonView.cleanup(); manager.cleanup(); scope.cleanup(); root.remove();
    },
  };
}
