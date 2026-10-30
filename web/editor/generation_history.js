import { loadExtensionStylesheet } from "../prompt_palette_shared.js";
loadExtensionStylesheet(new URL("../css/editor/104-generation-history.css", import.meta.url).href, "prompt-palette-history");
import { api } from "../../../scripts/api.js";
import { readEditorPreference, writeEditorPreference } from "../prompt_palette_state.js";
import { VirtualCollectionManager } from "../library/virtual_collection.js";
import { API } from "../prompt_palette_api.js";

const BASE = "/zf-prompt-palette/api/v1/generations";
const subscribers = new Set();
let captureTimer = 0, listening = false;
async function request(path = "", method = "GET", body) {
  const response = await api.fetchApi(BASE + path, { method, ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
  const text = await response.text(); let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = null; }
  if (!response.ok) throw new Error(data?.error || data?.message || text || `History request failed (${response.status})`);
  return data;
}
function completed() {
  clearTimeout(captureTimer);
  captureTimer = setTimeout(async () => {
    captureTimer = 0;
    try { await request("/sync", "POST", {}); for (const fn of subscribers) fn(); } catch { /* Each mounted view reports recovery errors on refresh. */ }
  }, 1200);
}
function subscribe(fn) {
  subscribers.add(fn);
  if (!listening) { for (const type of ["executed", "execution_success"]) api.addEventListener(type, completed); listening = true; }
  return () => { subscribers.delete(fn); if (!subscribers.size) { for (const type of ["executed", "execution_success"]) api.removeEventListener(type, completed); clearTimeout(captureTimer); captureTimer = 0; listening = false; } };
}
function el(tag, cls = "", text = "") { const node = document.createElement(tag); node.className = cls; node.textContent = text; return node; }
function imageUrl(image) { return api.apiURL(`/view?${new URLSearchParams(image)}`); }
function button(text, action) { const node = el("button", "", text); node.type = "button"; node.addEventListener("click", action); return node; }
function label(text, control) { const node = el("label"); node.append(control, document.createTextNode(` ${text}`)); return node; }
function checkbox() { const node = el("input"); node.type = "checkbox"; return node; }
function select(values, name) { const node = el("select"); node.setAttribute("aria-label", name); for (const [value, text] of values) { const option = el("option", "", text); option.value = value; node.append(option); } return node; }

export function createGenerationHistory(host, { restore, onBack } = {}) {
  const root = el("section", "pp-generation-history"); host.append(root);

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
  settings.append(label("Record Prompt Palette generations", enabled), label("Store authored prompt text (may contain sensitive information)", sensitive), label("Maximum indexed entries", maximum));
  const note = el("p", "pp-history-note", "Images stay in ComfyUI output/temp. Run-associated entries do not prove a particular resolved prompt or seed. Verified labels identify saved Prompt Palette output with an unambiguous conditioning path. Downstream prompt changes and the sampler noise seed are not inferred."); settings.append(note); root.append(settings);
  const query = el("input"); query.type = "search"; query.placeholder = "Search prompt, filename, tag or run…"; query.setAttribute("aria-label", "Search generation history");
  const favorite = checkbox(), missing = checkbox();
  const date = select([["0", "All dates"], ["1", "Last day"], ["7", "Last week"], ["30", "Last month"]], "History date filter");
  const mode = select([["grid", "Gallery"], ["masonry", "Masonry"], ["list", "Compact rows"], ["filmstrip", "Filmstrip / detail"]], "History view");
  const size = el("input"); size.type = "range"; size.min = "64"; size.max = "320"; size.value = "160"; size.setAttribute("aria-label", "History thumbnail size");
  const savedDisplay = readEditorPreference("generationHistoryDisplayV1", {}) || {};
  if (["grid", "masonry", "list", "filmstrip"].includes(savedDisplay.mode)) mode.value = savedDisplay.mode;
  if (Number.isFinite(savedDisplay.size)) size.value = Math.max(64, Math.min(320, savedDisplay.size));
  const refreshButton = button("Refresh", () => refresh());
  let importing = false, importCancelled = false;
  const importButton = button("Import existing ComfyUI history", async () => {
    if (importing) { importCancelled = true; return; }
    if (!confirm("Index images from existing ComfyUI runs containing Prompt Palette? Original files stay in place. Authored text is stored only if enabled above.")) return;
    importing = true; importCancelled = false; importButton.textContent = "Cancel history import";
    try { let offset = 0, total = 0; do { const page = await request("/sync", "POST", { import_existing: true, offset }); total += page.added; status.textContent = `Indexed ${total} images…`; offset = page.next_offset; } while (offset !== null && !importCancelled && !disposed); await refresh(); }
    catch (error) { report(error); } finally { importing = false; importButton.textContent = "Import existing ComfyUI history"; }
  });
  head.append(query, label("Favorites", favorite), label("Missing files", missing), date, mode, size, refreshButton, importButton); root.append(head);
  const status = el("p", "pp-history-note"); status.setAttribute("role", "status"); root.append(status);
  const list = el("div", "pp-history-list wg-library-display-scope"); list.tabIndex = 0; list.dataset.cardStretch = "true"; root.append(list);
  const more = button("Load more", () => refresh(true)); more.hidden = true; root.append(more);
  const detail = el("section", "pp-history-detail"); detail.hidden = true; root.append(detail);
  const comparison = el("section", "pp-history-compare"); comparison.hidden = true; root.append(comparison);
  const manager = new VirtualCollectionManager(list);
  let prefs = null, rows = [], cursor = null, sequence = 0, disposed = false, active = true, debounce = 0, unsubscribe = null;
  const unsubMetadata = API.onMetadataChange?.(detail => {
    if (["generations", "settings", "all"].includes(detail.namespace)) {
      refresh();
    }
  });
  const compared = new Map();
  function report(error) { if (!disposed) status.textContent = error.message || String(error); }
  function paintCompare() {
    comparison.replaceChildren(); comparison.hidden = !compared.size;
    if (!compared.size) return;
    comparison.append(el("strong", "", `Compare ${compared.size}/4`), button("Clear comparison", () => { compared.clear(); paintCompare(); }));
    for (const record of compared.values()) { const figure = el("figure"); if (!record.missing) { const img = el("img"); img.src = imageUrl(record.image); img.alt = record.image.filename; img.loading = "lazy"; figure.append(img); } figure.append(el("figcaption", "", `${record.image.filename} · ${record.provenance} · Palette seed ${record.effective_seed ?? "Unknown"}`)); comparison.append(figure); }
  }
  async function annotate(record, patch) {
    try { const saved = await request(`/${encodeURIComponent(record.id)}`, "PATCH", { ...patch, revision: record.revision }); Object.assign(record, saved); API.publishMetadataChange?.({ namespace: "generations", action: "annotate", id: record.id }); paint(); return true; }
    catch (error) { report(error); return false; }
  }
  async function showDetail(record) {
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
    const compBtn = button(compared.has(record.id) ? "✓ Compared" : "Compare", () => {
      if (compared.has(record.id)) compared.delete(record.id);
      else if (compared.size < 4) compared.set(record.id, record);
      else { status.textContent = "Compare up to four images."; return; }
      paintCompare();
      showDetail(record);
    });
    compBtn.className = "pp-history-btn";
    topActions.append(favBtn, compBtn);
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
      addMetaRow("Palette seed", record.effective_seed, String(record.effective_seed));
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
      if (record.resolved_negative) {
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
          cHead.append(el("span", "pp-history-seed-badge", `Palette seed: ${ctx.seed}`));
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
        if (ctx.resolved_prompt) {
          const resBlock = el("div", "pp-history-prompt-block");
          const rHead = el("div", "pp-history-prompt-header");
          rHead.append(el("span", "pp-history-prompt-label", "Resolved prompt"));
          const rActions = el("div", "pp-history-btn-group");
          const copyResBtn = button("📋 Copy resolved", async () => {
            try { await navigator.clipboard.writeText(ctx.resolved_prompt); status.textContent = "Copied resolved prompt."; } catch (e) { report(e); }
          });
          copyResBtn.className = "pp-history-btn pp-btn-sm";
          rActions.append(copyResBtn);
          if (restore) {
            const restResBtn = button("↺ Restore resolved…", async () => {
              try { await restore({ text: ctx.resolved_prompt, channel: ctx.channel_role === "negative" ? "negative" : "positive", record, context: ctx, requiresConfirmation: true }); } catch (e) { report(e); }
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
          if (typeof ctx[key] !== "string" || !ctx[key]) continue;
          const pBlock = el("div", "pp-history-prompt-block");
          const pHead = el("div", "pp-history-prompt-header");
          const labelText = (channel === "negative" || ctx.channel_role === "negative") ? "Authored negative prompt" : "Authored prompt";
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
        compared.delete(record.id);
        paintCompare();
        await refresh();
      } catch (error) { report(error); }
    });
    removeBtn.className = "pp-history-btn pp-btn-danger";
    footerBar.append(removeBtn);
    rightCol.append(footerBar);

    layout.append(rightCol);
    detail.append(layout);
    detail.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }

  function card(record) {
    const node = el("article", "wg-thumb-item pp-history-card");
    const media = el("div", "wg-thumb-media");
    if (!record.missing) {
      const img = el("img", "wg-thumb-img");
      img.src = imageUrl(record.image);
      img.alt = record.image.filename;
      img.loading = "lazy";
      img.decoding = "async";
      img.addEventListener("error", () => { img.remove(); media.textContent = "Preview unavailable"; }, { once: true });
      media.append(img);
    } else {
      media.append(el("span", "", "Original file missing"));
    }

    // Determine seed if present at record level or in any context
    const seed = record.effective_seed != null ? record.effective_seed : (record.contexts?.find(c => c.seed != null)?.seed);
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
    const compBtn = button(compared.has(record.id) ? "✓ Comp" : "Compare", () => {
      if (compared.has(record.id)) compared.delete(record.id);
      else if (compared.size < 4) compared.set(record.id, record);
      else { status.textContent = "Compare up to four images."; return; }
      paintCompare();
    });
    compBtn.className = "pp-history-btn pp-btn-sm";
    actions.append(detailsBtn, favBtn, compBtn);

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
  function paint() {
    list.dataset.historyView = mode.value;
    list.style.setProperty("--wg-personal-thumb-min", `${Number(size.value)}px`);
    manager.clear(); list.replaceChildren();
    if (!rows.length) { list.append(el("p", "pp-history-note", "No indexed generations match these filters.")); return; }
    manager.mount(list, { items: rows, mode: mode.value, minCardWidth: Number(size.value), estimateRowHeight: 100, estimateCardHeight: Number(size.value) + 100, renderItem: card });
  }
  async function refresh(append = false) {
    if (disposed || !active) return;
    const version = ++sequence;
    try {
      const params = new URLSearchParams({ q: query.value, favorite: favorite.checked, missing: missing.checked, since: date.value === "0" ? "0" : String(Date.now() - Number(date.value) * 86400000) });
      if (append && cursor) params.set("cursor", cursor);
      const page = await request(`?${params}`); if (disposed || version !== sequence) return;
      rows = append ? [...rows, ...page.items] : page.items; cursor = page.next_cursor; more.hidden = !cursor;
      status.textContent = `${rows.length} indexed images shown${cursor ? " · more available" : ""}`; paint();
    } catch (error) { report(error); }
  }
  async function saveSettings() {
    if (!prefs) return;
    try { prefs = await request("/settings", "PUT", { enabled: enabled.checked, capture_prompts: sensitive.checked, max_entries: Number(maximum.value), revision: prefs.revision || 0 }); syncCapture(); if (prefs.enabled) { await request("/sync", "POST", {}); await refresh(); } }
    catch (error) { report(error); enabled.checked = !!prefs.enabled; sensitive.checked = !!prefs.capture_prompts; }
  }
  function syncCapture() { unsubscribe?.(); unsubscribe = null; if (prefs?.enabled && !disposed) unsubscribe = subscribe(() => refresh()); }
  for (const control of [enabled, sensitive, maximum]) control.addEventListener("change", saveSettings);
  query.addEventListener("input", () => { clearTimeout(debounce); debounce = setTimeout(() => refresh(), 125); });
  for (const control of [favorite, missing, date]) control.addEventListener("change", () => refresh());
  const displayChanged = () => { writeEditorPreference("generationHistoryDisplayV1", { mode: mode.value, size: Number(size.value) }); paint(); };
  mode.addEventListener("change", displayChanged); size.addEventListener("input", displayChanged);
  (async () => { try { prefs = await request("/settings"); if (disposed) return; enabled.checked = prefs.enabled; sensitive.checked = prefs.capture_prompts; maximum.value = prefs.max_entries; enabled.disabled = prefs.capture_available === false; if (enabled.disabled) note.textContent += " Capture is unavailable in multi-user mode because ComfyUI does not expose authenticated run ownership."; syncCapture(); if (prefs.enabled && active) await request("/sync", "POST", {}); await refresh(); } catch (error) { report(error); } })();
  return { refresh, setActive(value) { active = !!value; syncCapture(); if (active) { if (prefs?.enabled) request("/sync", "POST", {}).then(() => refresh()).catch(report); else refresh(); } }, cleanup() { disposed = true; sequence++; importCancelled = true; unsubscribe?.(); clearTimeout(debounce); unsubMetadata?.(); manager.cleanup(); root.remove(); } };
}
