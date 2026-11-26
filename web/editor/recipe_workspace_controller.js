import { app } from "../../../scripts/app.js";
import { workspaceGeneration, syncWorkspaceGeneration, syncWorkspaceFieldSockets, prepareWorkspaceFieldSockets, recoverWorkspaceFromNode, hasOccupiedWorkspaceFields } from "./workspace_generation.js";
import { API } from "../prompt_palette_api.js";
import { getPowerToolPreferences } from "../prompt_palette_state.js";
import { onPromptPaletteAppearanceChanged, svgIcon } from "../prompt_palette_shared.js";
import { positiveAntonymsEnabled } from "./positive_antonyms.js";
import { loadTheme } from "./preferences.js";
import { normalizeFieldEditorPreferences, fieldGridRows, fieldEditorHeight, fieldGridColumns, fieldAccentPlan } from "./field_editor_preferences.js";
import { nudgeHexForContrast, currentUiSurface } from "./text_utils.js";
import { dialogPrompt, dialogConfirm, dialogChoice } from "./dialogs.js";
import { notify } from "./notifications.js";
import { serializeRecipe, validateRecipe } from "./prompt_refinement.js";
import { exportRecipePack } from "./recipe_io.js";
import { attachRecipeFieldEditor } from "./recipe_field_editor.js";
import { cloneWorkspaceData, WORKSPACE_KEY, blankWorkspace, workspaceFromRecipe, validateWorkspaceRecipe, compileWorkspace, combineFieldInput, newField, fieldId, reorderField, normalizeWorkspaceLoraDock, separators } from "./recipe_workspace_model.js";
import { findFieldInputConnection, resolveFieldInputText, disconnectFieldInput } from "./upstream_input_import.js";
import { LORA_DOCK_HEADER, LORA_DOCK_HEADER_RE, isLoraDockSegment, splitLoraDock } from "../engine/lora_tags.js";
import { closeAcMenu, openOrUpdateAcMenu } from "./autocomplete.js";
import { fieldVariationHint, choicesFromLines, editableChoiceLines } from "./recipe_variation_source.js";
import { createExperimentPlan, resolveExperiment, applyExperiment, projectExperiment } from "./recipe_experiment.js";
import { captureBranch, fieldInheritance, resetInheritedField, historyOf } from "./recipe_iteration.js";
import { appendIterationUI } from "./recipe_iteration_ui.js";
import { hasDynamicSyntax, resolveWorkspacePreview, estimateWorkspaceCombinations, analyzeWorkspace } from "./recipe_insights.js";
import { workspaceCore } from "./recipe_workspace_model.js";
import { sendPreparedPrompts } from "./prepared_handoff.js";
import { installNegativePromptState } from "../prompt_palette_compat.js";
import { editCompiledPrompt } from "./recipe_text_edit.js";
import { onTagColorsChanged } from "./booru_tag_colors.js";
import { socketConnected } from "../renderer/base_renderer_adapter.js";

const ACCENT_PRESETS = [["#d86f70", "Red"], ["#82c6a2", "Green"], ["#75b7e8", "Blue"], ["#bb8ee8", "Purple"], ["#d49a52", "Amber"]];

export function createRecipeWorkspaceController({ node, root, textarea, render, flushHistory,
  getMatches, onCommit, paintSyntax, getSeed, getMode, getLibrary, refreshLibrary, onUndo, onRedo, holdHistory, releaseHistory, host, openHost, bindHover, onLibrarySaved, openVariations, onShowEditor }) {
  const wrap = root.querySelector(".wg-editor-wrap"), editors = new Map();
  let negativeWidget = node.widgets?.find(w => w.name === "negative_text");
  const negativeState = installNegativePromptState(node);
  let state = null, syncing = false, syncingSlots = false, previewReturnToWorkspace = false, disposed = false, activeFieldId = null;
  const importingFieldIds = new Set();
  function syncFieldInputImportState() {
    if (!state?.recipe?.fields || state.view !== "workspace") return;
    for (const f of state.recipe.fields) {
      const conn = f.hasInput ? findFieldInputConnection(node, f.id) : { connected: false, sourceLabel: "" };
      const busy = importingFieldIds.has(f.id);
      const cardBtn = fieldsPane.querySelector(`[data-field-import="${CSS.escape(f.id)}"]`);
      if (cardBtn) {
        cardBtn.hidden = !conn.connected;
        cardBtn.disabled = busy;
        cardBtn.title = conn.connected
          ? `Import text from ${conn.sourceLabel} into ${f.label} before running`
          : "Connect an upstream node to this field's input socket to import text";
      }
      const settingsBtn = settingsPane.querySelector(`[data-settings-import="${CSS.escape(f.id)}"]`);
      if (settingsBtn) {
        settingsBtn.disabled = !conn.connected || busy;
        settingsBtn.title = conn.connected
          ? `Import text from ${conn.sourceLabel} into ${f.label} before running`
          : "Connect an upstream node to this field's input socket to import text";
      }
      const disconnectBtn = settingsPane.querySelector(`[data-settings-disconnect="${CSS.escape(f.id)}"]`);
      if (disconnectBtn) disconnectBtn.hidden = !conn.connected;
    }
  }
  async function importFieldInput(id) {
    if (disposed || !state || importingFieldIds.has(id)) return;
    const field = state.recipe.fields.find(x => x.id === id);
    if (!field?.hasInput) return;
    importingFieldIds.add(id);
    syncFieldInputImportState();
    try {
      const { text, sourceLabel } = await resolveFieldInputText({ node, fieldId: id, app });
      if (disposed || !state) return;
      const liveField = state.recipe.fields.find(x => x.id === id);
      if (!liveField) return;
      if (!text.trim()) {
        notify("warn", "Input is empty", `${sourceLabel} returned empty text.`);
        return;
      }
      const currentText = liveField.value || "";
      let mode = "replace";
      if (currentText.trim()) {
        const clean = text.trim();
        const preview = clean.length > 160 ? `${clean.slice(0, 160)}…` : clean;
        mode = await dialogChoice({
          title: `Import into ${liveField.label}`,
          message: `From ${sourceLabel}:\n\n"${preview}"\n\nChoose how to apply this text:`,
          choices: [
            { label: "Replace", value: "replace", primary: true },
            { label: "Replace & disconnect wire", value: "replace-disconnect" },
            { label: "Append", value: "append" },
            { label: "Prepend", value: "prepend" },
            { label: "Cancel", value: null },
          ],
        });
        if (!mode || disposed || !state) return;
      }
      const sep = liveField.separator ?? state.recipe.separator ?? ", ";
      const nextValue = mode === "append"
        ? combineFieldInput(currentText, text, { placement: "after", separator: sep })
        : mode === "prepend"
          ? combineFieldInput(currentText, text, { placement: "before", separator: sep })
          : text;
      mutate(r => {
        const target = r.fields.find(x => x.id === id);
        if (!target) return;
        delete target.variationTemplate;
        target.value = nextValue;
        if (target.collapsed && !state.settingsOpen) target.collapsed = false;
      });
      if (mode === "replace-disconnect") {
        disconnectFieldInput(node, id);
      }
      activeFieldId = id;
      if (!state.settingsOpen) focusActiveField();
      notify(
        "info",
        `Imported from ${sourceLabel}`,
        mode === "replace-disconnect"
          ? `Replaced ${liveField.label} and disconnected the input wire.`
          : `Loaded ${text.length.toLocaleString()} characters into ${liveField.label}. Disconnect the input wire before running if you don't want it combined again.`
      );
    } catch (error) {
      notify("error", "Could not import input text", error?.message || String(error));
    } finally {
      importingFieldIds.delete(id);
      syncFieldInputImportState();
    }
  }
  const channelConnected = channel => {
    const input = node.inputs?.find(input => input.name === (channel === "negative" ? "negative_text" : "text"));
    return !!input && socketConnected("input", input, node);
  };
  const refinementRevision = () => node._ppHistoryRefinement?.revision() ?? 0;
  function syncFieldReadOnly(editor, channel) {
    const readOnly = channelConnected(channel);
    if (editor.readOnly === readOnly) return;
    editor.readOnly = readOnly; editor.contentEditable = readOnly ? "false" : "true";
    editor.setAttribute("aria-readonly", String(readOnly));
  }
  const summarySources = new WeakMap();
  const fieldProjections = new WeakMap();
  const fieldViewports = new Map();
  let summaryRevision = 0;
  let insightTimer = null, insightPending = null, insightVersion = 0, insightKey = "", insightResult = null;
  syncWorkspaceFieldSockets(node, recoverWorkspaceFromNode(node)?.recipe || null);
  let estimateScope = "vary";
  function cancelInsights() { clearTimeout(insightTimer); insightTimer = null; insightPending?.abort(); insightPending = null; insightVersion++; }
  function insightContext() { return state ? JSON.stringify({ recipe: workspaceCore(state.recipe), seed: getSeed(), mode: getMode(), scope: estimateScope, currentId: activeFieldId }) : ""; }
  function paintInsights(result, error = "") {
    if (!state) return;
    for (const f of state.recipe.fields) {
      const box = section.querySelector(`[data-resolved-field="${CSS.escape(f.id)}"] pre`);
      if (box) box.textContent = !f.enabled || !f.value.trim() ? "Not included in the compiled prompt." : error || (result?.preview.fields[f.id] ?? "Open to resolve with the current seed.");
    }
    const summary = section.querySelector(".pp-combination-status"), fields = section.querySelector(".pp-combination-fields");
    if (summary) {
      summary.textContent = error || (result ? `${result.estimate.lowerBound ? "At least " : "Estimated "}${result.estimate.count.toLocaleString()} combination${result.estimate.count === 1 ? "" : "s"}${result.estimate.warning ? " · large experiment" : ""}` : "Open to count combinations for this scope.");
      summary.classList.toggle("is-warning", !!error || !!result?.estimate.warning);
    }
    if (fields) fields.textContent = result ? result.estimate.fields.map(f => `${f.label}: ${f.lowerBound ? "at least " : ""}${f.count.toLocaleString()} option${f.count === 1 ? "" : "s"}`).join("\n") + (result.estimate.warning ? "\nLarge scopes can produce long batches. Preview a smaller set or deliberately set the existing Combinatorial limit." : "") + `\n${result.estimate.notice}` : error;
  }
  function scheduleInsights(force = false) {
    if (disposed || !state || state.view !== "workspace") { cancelInsights(); return; }
    const wanted = state.settingsOpen && ((state.settingsTab === "preview" && state.insightsOpen) || (state.settingsTab === "fields" && section.querySelector("details.pp-field-resolved[open]")));
    if (!wanted) { cancelInsights(); if (!insightResult) insightKey = ""; return; }
    const key = insightContext();
    if (!force && key === insightKey) { if (insightResult) paintInsights(insightResult); return; }
    cancelInsights(); insightKey = key; insightResult = null; paintInsights(null, "Resolving workspace context…");
    const requestId = insightVersion;
    insightTimer = setTimeout(async () => {
      const controller = new AbortController(); insightPending = controller;
      try {
        const recipe = cloneWorkspaceData(state.recipe), seed = getSeed(), mode = getMode(), currentId = activeFieldId;
        const preview = await resolveWorkspacePreview(recipe, seed, mode, API.resolveVariations, { signal: controller.signal, namespace: node.id });
        const estimate = state.insightsOpen && state.settingsTab === "preview" ? await estimateWorkspaceCombinations(recipe, estimateScope, currentId, seed, mode, API, { signal: controller.signal, captured: preview }) : { count: 1, fields: [], notice: "Open Preview & safety to count this scope." };
        if (disposed || controller.signal.aborted || requestId !== insightVersion || key !== insightContext()) return;
        insightResult = { preview, estimate }; paintInsights(insightResult);
      } catch (error) {
        if (!disposed && !controller.signal.aborted && requestId === insightVersion && key === insightContext()) paintInsights(null, `Preview unavailable: ${error.message}`);
      } finally { if (insightPending === controller) insightPending = null; }
    }, force ? 0 : 350);
  }
  function replaceRecipe(recipe) { mutate(r => { Object.keys(r).forEach(key => delete r[key]); Object.assign(r, cloneWorkspaceData(recipe)); }); }
  async function sendSnapshot(snapshot) {
    if (node.inputs?.some(input => input.name === "negative_text" && input.link != null)) throw new Error("A connected negative input cannot be captured into a new batch.");
    const seed = getSeed(), mode = getMode(), captured = JSON.stringify(snapshot);
    const result = await resolveWorkspacePreview(snapshot.recipe, seed, mode, API.resolveVariations, { namespace: node.id });
    if (disposed || seed !== getSeed() || mode !== getMode() || !historyOf(state?.recipe || {}).snapshots.some(s => s.id === snapshot.id && JSON.stringify(s) === captured)) throw new Error("The snapshot or seed changed. Send it again.");
    return sendPreparedPrompts({ node, source: compileWorkspace(snapshot.recipe).positive, prompts: [result.positive], negative: result.negative, seed,
      session: { resolution_seed: seed, negative_prompts: [result.negative], wildcards: result.wildcards || [] } });
  }
  function make(tag, className, text) { const n = document.createElement(tag); if (className) n.className = className; if (text != null) n.textContent = text; return n; }
  const tabs = make("div", "pp-recipe-mode pp-refine-actions pp-split-rail");
  const section = make("section", "pp-recipe-workspace is-split"); section.hidden = true;
  const notice = make("span", "pp-refine-label");
  const fieldNav = make("select", "pp-field-navigator"); fieldNav.hidden = true;
  fieldNav.setAttribute("aria-label", "Jump to field"); fieldNav.title = "Jump to a field · keeps your selection and scroll position";
  fieldNav.addEventListener("change", () => revealField(fieldNav.value));
  fieldNav.addEventListener("keydown", event => event.stopPropagation());
  fieldNav.addEventListener("pointerdown", event => event.stopPropagation());
  const modeGroup = make("div", "pp-split-seg"); modeGroup.setAttribute("role", "group"); modeGroup.setAttribute("aria-label", "Prompt editing mode");
  const railActions = make("div", "pp-split-actions");
  const fieldsPane = make("div", "pp-split-fields");
  fieldsPane.addEventListener("focusout", event => {
    const id = event.target.closest?.("[data-field-id]")?.dataset.fieldId;
    if (editors.get(id)?.editor !== event.target) return;
    const editor = event.target;
    fieldViewports.set(id, { start: editor.selectionStart, end: editor.selectionEnd, direction: editor.selectionDirection, top: editor.scrollTop, left: editor.scrollLeft });
  });
  const settingsPane = make("div", "pp-split-settings"); settingsPane.hidden = true;
  settingsPane.setAttribute("role", "region"); settingsPane.setAttribute("aria-label", "Workspace settings");
  settingsPane.addEventListener("keydown", event => { if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); closeSettings(); } });
  function button(text, action, title = text) {
    const b = document.createElement("button"); b.type = "button"; b.className = "wg-button"; b.textContent = text; b.title = title;
    // Action roles share the user's palette, including custom themes.
    b.dataset.tone = /^(Save|Export|Copy|Freeze|Snapshot to Combinatorial)/.test(text) ? "save" : /^(Remove|Delete|Reset|Convert)/.test(text) ? "danger" : /^(Variation Lab|Vary|Set choices|Replace field|Insert wildcard|\+ Field|\+ Variant|Apply|Restore)/.test(text) ? "accent" : "neutral";
    b.addEventListener("mousedown", e => e.preventDefault());
    b.addEventListener("click", e => { e.stopPropagation(); Promise.resolve().then(() => action({ currentTarget: b, target: e.target })).catch(err => notify("error", "Recipe Workspace", err.message)); }); return b;
  }
  const editorTab = button("Editor", () => view("editor"));
  const workspaceTab = button("Workspace", async () => {
    if (!state) {
      flushHistory(); const recipe = { ...blankWorkspace(textarea.value), negative: String(negativeWidget?.value || "") }; recipe.fields[0].titleHidden = true;
      state = { recipe, view: "workspace", path: "", baseline: "", settingsTab: "fields" }; sync({ commitPromptState: false }); rebuild(); render(); flushHistory();
    } else view("workspace");
  });
  const convert = button("Unlink fields", async () => {
    if (!state || !await dialogConfirm({ title: "Convert Workspace to Plain Prompt", message: "Keep the compiled prompt and unlink its fields, snapshots and variants? Undo restores the workspace." })) return;
    flushHistory(); state = null; persist(); rebuild(); render(); flushHistory();
  });
  convert.dataset.tone = "danger"; convert.title = "Keep the compiled prompt and switch to plain editing";
  modeGroup.append(editorTab, workspaceTab); tabs.append(modeGroup, fieldNav, notice, railActions, convert); wrap.before(tabs); wrap.after(section);
  function persist() {
    syncWorkspaceGeneration(node, state?.recipe || null);
    node.properties ||= {};
    node._ppWorkspaceVersion = (node._ppWorkspaceVersion || 0) + 1;
    if (state) {
      const saved = cloneWorkspaceData(state);
      if (previewReturnToWorkspace) saved.view = "workspace";
      node.properties[WORKSPACE_KEY] = saved;
      node._ppConfiguredWorkspace = saved;
    } else {
      node.properties[WORKSPACE_KEY] = null;
      delete node._ppConfiguredWorkspace;
    }
    if (!syncingSlots) {
      syncingSlots = true;
      try { node._ppPromptSlots?.syncActiveSlot?.(); } finally { syncingSlots = false; }
    }
    node.setDirtyCanvas?.(true, true);
  }
  function currentCompilation() { return compileWorkspace(state.recipe); }
  function sync({ commitPromptState = true } = {}) {
    if (!state || syncing) return;
    syncing = true;
    try {
      const result = currentCompilation();
      const changed = textarea.value !== result.positive || node._ppPromptStateGuard?.current?.() !== result.positive;
      textarea.value = result.positive;
      if (commitPromptState) {
        node._ppPromptStateGuard?.commit?.(result.positive, { notify: false, dirty: false });
      }
      negativeState.commit(result.negative);
      negativeWidget = node.widgets?.find(w => w.name === "negative_text");
      persist(); updatePreview({ compilation: result });
      if (changed && commitPromptState) textarea.dispatchEvent(new CustomEvent("pp-workspace-sync"));
    } finally { syncing = false; }
  }
  function mutate(action, { typing = false, rebuildUI = true } = {}) {
    if (!state) return;
    const previous = cloneWorkspaceData(state);
    if (!typing) flushHistory();
    try {
      action(state.recipe);
      normalizeWorkspaceLoraDock(state.recipe);
      state.recipe = captureBranch(validateWorkspaceRecipe(state.recipe));
      for (const channel of ["positive", "negative"]) if (channelConnected(channel)) {
        const channelState = recipe => JSON.stringify([compileWorkspace(recipe)[channel], recipe.fields.filter(f => f.channel === channel)]);
        if (channelState(state.recipe) !== channelState(previous.recipe)) throw new Error(`The ${channel} prompt is controlled by a connected input.`);
      }
      sync({ commitPromptState: false });
    }
    catch (error) { state = previous; throw error; }
    if (rebuildUI) rebuild();
    render(); updateWorkspaceCharCount(); if (!typing) flushHistory();
  }
  const resizeCleanups = new Set();
  function clearEditors() { if (observedField) gridObserver?.unobserve(observedField); observedField = null; resizeCleanups.forEach(cleanup => cleanup()); resizeCleanups.clear(); editors.forEach(e => e.cleanup()); editors.clear(); delete node._ppActiveRecipeEditor; }
  let gridFrame = null, revealActive = false, observedField = null;
  function observeActiveField() {
    const card = fieldCard(activeFieldId);
    if (card === observedField) return;
    if (observedField) gridObserver?.unobserve(observedField);
    observedField = card; if (card) gridObserver?.observe(card);
  }
  function keepFieldVisible(id) {
    const card = fieldCard(id);
    if (!card || !fieldsPane.clientHeight) return;
    const pane = fieldsPane.getBoundingClientRect(), box = card.getBoundingClientRect();
    const scale = pane.height / fieldsPane.offsetHeight || 1;
    const bottom = box.height <= pane.height ? box.bottom : box.top + Math.min(pane.height, 96 * scale);
    if (box.top < pane.top) fieldsPane.scrollTop += (box.top - pane.top) / scale;
    else if (bottom > pane.bottom) fieldsPane.scrollTop += (bottom - pane.bottom) / scale;
  }
  function scheduleFieldGrid() {
    if (disposed || gridFrame != null) return;
    gridFrame = requestAnimationFrame(() => {
      gridFrame = null;
      if (section.hidden) return;
      let columns = fieldGridColumns(section.dataset.fieldColumns, fieldsPane.clientWidth);
      if (section.dataset.fieldColumns === "auto") columns = Math.min(columns, Math.max(1, state.recipe.fields.length));
      const tracks = `repeat(${columns}, minmax(0, 1fr))`;
      if (fieldsPane.style.gridTemplateColumns !== tracks) fieldsPane.style.gridTemplateColumns = tracks;
      const rows = fieldGridRows([...fieldsPane.children].map(card => ({
        static: card.classList.contains("pp-recipe-static"),
        flexible: !card.classList.contains("is-collapsed") && card.dataset.heightMode === "fill",
      })), columns);
      if (fieldsPane.style.getPropertyValue("--pp-field-rows") !== rows) fieldsPane.style.setProperty("--pp-field-rows", rows || "none");
      if (!fieldsPane.classList.contains("is-resizing") && (revealActive || fieldsPane.contains(document.activeElement))) keepFieldVisible(activeFieldId);
      revealActive = false;
    });
  }
  const gridObserver = typeof ResizeObserver === "function" ? new ResizeObserver(() => {
    if (root.contains(document.activeElement)) revealActive = true;
    scheduleFieldGrid();
  }) : null;
  gridObserver?.observe(fieldsPane);
  window.addEventListener("resize", scheduleFieldGrid);
  // The existing grip owns one gesture, including cancellation and canvas zoom.
  function attachResizeGrip(card, editWrap, id, onModeChanged) {
    const grip = make("div", "pp-split-grip");
    grip.setAttribute("role", "separator"); grip.setAttribute("aria-orientation", "horizontal"); grip.tabIndex = 0;
    grip.setAttribute("aria-label", "Field editor height");
    grip.setAttribute("aria-valuemin", "48"); grip.setAttribute("aria-valuemax", "2400");
    grip.title = "Drag to resize · Shift snaps to 8px · Escape cancels · double-click or Home restores Grid";
    const badge = make("span", "pp-resize-badge"); badge.hidden = true; card.appendChild(badge);
    let badgeTimer = null, start = null;
    const showBadge = (text, hold = false) => {
      clearTimeout(badgeTimer);
      badge.textContent = text; badge.hidden = false; card.classList.add("is-resizing");
      if (!hold) badgeTimer = setTimeout(() => { badge.hidden = true; card.classList.remove("is-resizing"); }, 650);
    };
    const applyMode = value => {
      const height = value != null && value !== "auto" ? fieldEditorHeight(value, false) : null;
      const mode = value === "auto" ? "auto" : height != null ? "manual" : "fill";
      editWrap.style.height = height == null ? "" : `${height}px`;
      if (height == null) delete card.dataset.sized; else card.dataset.sized = "true";
      card.dataset.heightMode = mode;
      grip.setAttribute("aria-valuenow", String(height ?? Math.round(editWrap.offsetHeight)));
      grip.setAttribute("aria-valuetext", mode === "fill" ? "Grid cell" : mode === "auto" ? "Fit content" : `${height} pixels`);
      onModeChanged?.(mode); scheduleFieldGrid();
    };
    const commit = value => {
      if (!state) return;
      state.editorHeights = { ...(state.editorHeights || {}) };
      if (value == null) delete state.editorHeights[id]; else state.editorHeights[id] = value;
      persist();
    };
    const saved = state?.editorHeights?.[id];
    applyMode(saved === "auto" ? saved : saved != null && Number.isFinite(Number(saved)) ? Number(saved) : null);
    const owner = grip.ownerDocument, win = owner.defaultView;
    const stopListening = () => {
      owner.removeEventListener("pointermove", onMove, true);
      owner.removeEventListener("pointerup", onUp, true);
      owner.removeEventListener("pointercancel", onCancel, true);
      owner.removeEventListener("keydown", onEscape, true);
      win.removeEventListener("blur", onCancel);
    };
    const finish = (cancel = false) => {
      if (!start) return;
      const previous = start; start = null; stopListening();
      try { if (grip.hasPointerCapture?.(previous.pointerId)) grip.releasePointerCapture(previous.pointerId); } catch {}
      fieldsPane.classList.remove("is-resizing");
      if (cancel) applyMode(previous.mode);
      else commit(parseFloat(editWrap.style.height));
      showBadge(cancel ? "Cancelled" : editWrap.style.height, false);
    };
    const onMove = event => {
      if (!start || event.pointerId !== start.pointerId) return;
      const next = fieldEditorHeight(start.h + (event.clientY - start.y) / start.scale, start.snap || event.shiftKey);
      applyMode(next); showBadge(`${next}px`, true);
      event.preventDefault(); event.stopPropagation();
    };
    const onUp = event => { if (event.pointerId === start?.pointerId) { finish(); event.preventDefault(); event.stopPropagation(); } };
    const onCancel = event => { if (event.type === "blur" || event.pointerId === start?.pointerId) finish(true); };
    const onEscape = event => { if (event.key === "Escape") { finish(true); event.preventDefault(); event.stopPropagation(); } };
    grip.addEventListener("pointerdown", event => {
      if (start || event.button !== 0) return;
      const rect = editWrap.getBoundingClientRect();
      start = { pointerId: event.pointerId, y: event.clientY, h: editWrap.offsetHeight,
        scale: rect.height / Math.max(1, editWrap.offsetHeight) || 1,
        snap: loadTheme().workspaceSnapGrid !== false,
        mode: card.dataset.heightMode === "manual" ? parseFloat(editWrap.style.height) : card.dataset.heightMode === "auto" ? "auto" : null };
      // Pin the starting height before grid tracks redistribute their free space.
      applyMode(start.h); fieldsPane.classList.add("is-resizing");
      try { grip.setPointerCapture?.(event.pointerId); } catch {}
      owner.addEventListener("pointermove", onMove, true);
      owner.addEventListener("pointerup", onUp, true);
      owner.addEventListener("pointercancel", onCancel, true);
      owner.addEventListener("keydown", onEscape, true);
      win.addEventListener("blur", onCancel);
      event.preventDefault(); event.stopPropagation();
    });
    grip.addEventListener("lostpointercapture", () => finish(true));
    grip.addEventListener("mousedown", event => event.stopPropagation());
    grip.addEventListener("keydown", event => {
      if (!["ArrowUp", "ArrowDown", "Home"].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      const next = event.key === "Home" ? null : fieldEditorHeight(editWrap.offsetHeight + (event.key === "ArrowDown" ? 8 : -8), loadTheme().workspaceSnapGrid !== false || event.shiftKey);
      applyMode(next); commit(next); showBadge(next == null ? "Grid" : `${next}px`);
    });
    grip.addEventListener("dblclick", event => { event.preventDefault(); event.stopPropagation(); applyMode(null); commit(null); showBadge("Grid"); });
    card._ppSetHeightMode = mode => { applyMode(mode); commit(mode); showBadge(mode === "auto" ? "Auto" : mode == null ? "Grid" : editWrap.style.height); };
    resizeCleanups.add(() => { start = null; stopListening(); clearTimeout(badgeTimer); fieldsPane.classList.remove("is-resizing"); });
    return grip;
  }
  function fieldCard(id) { return section.querySelector(`[data-field-id="${CSS.escape(id)}"]`); }
  function optionsCard(id) { return section.querySelector(`[data-settings-field="${CSS.escape(id)}"]`); }
  // The accent can color the card, the title or both (workspace default, per-field override).
  // Only the card chrome, the title text and the caret are touched; editor syntax colors, theme
  // variables and the theme's own title color (Automatic / No accent) are never overridden. The
  // title and caret colors are nudged to stay readable on the active theme's field surface, and
  // re-derived whenever the appearance changes (`summaryRevision`).
  let accentContext = { revision: -1, surface: "", target: "both" };
  function accentEnvironment() {
    if (accentContext.revision !== summaryRevision) accentContext = { revision: summaryRevision, surface: currentUiSurface(), target: normalizeFieldEditorPreferences(loadTheme()).fieldColorTarget };
    return accentContext;
  }
  function applyAccent(card, f) {
    const { surface, target } = accentEnvironment(), plan = fieldAccentPlan(f, target), style = card.style;
    card.dataset.accent = plan.chrome;
    if (plan.chrome === "custom") { style.setProperty("--pp-field-accent", plan.hex); style.setProperty("--pp-field-caret", nudgeHexForContrast(plan.hex, surface, 3)); }
    else { style.removeProperty("--pp-field-accent"); style.removeProperty("--pp-field-caret"); }
    if (plan.title) { card.dataset.titleAccent = "true"; style.setProperty("--pp-field-title-color", nudgeHexForContrast(plan.hex, surface, 4.5)); }
    else { delete card.dataset.titleAccent; style.removeProperty("--pp-field-title-color"); }
  }
  function refreshAccents() {
    if (!state?.recipe?.fields) return;
    for (const f of state.recipe.fields) { const card = fieldCard(f.id); if (card) applyAccent(card, f); }
  }
  function openSettings(tab = state?.settingsTab || "fields", fieldId = null) {
    if (!state) return;
    state.view = "workspace"; state.settingsOpen = true;
    state.settingsTab = ["fields", "workspace", "preview", "history"].includes(tab) ? tab : "fields";
    if (fieldId) state.optionsOpen = [...new Set([...(state.optionsOpen || []), fieldId])];
    persist(); rebuild();
    if (fieldId) optionsCard(fieldId)?.scrollIntoView?.({ block: "nearest" });
    (fieldId ? optionsCard(fieldId)?.querySelector("[data-field-variation]") : settingsPane.querySelector('[role="tab"][aria-selected="true"]'))?.focus({ preventScroll: true });
  }
  function closeSettings() {
    if (!state?.settingsOpen) return;
    state.settingsOpen = false; persist(); rebuild();
    focusActiveField();
  }
  // Brings a field's editor into view (closing settings, expanding it) for actions that act on its text.
  function revealField(id) {
    if (!state) return null;
    state.settingsOpen = false; activeFieldId = id;
    if (state.recipe.fields.find(f => f.id === id)?.collapsed) mutate(r => { r.fields.find(f => f.id === id).collapsed = false; });
    else { persist(); rebuild(); }
    // Rebuilding may restore the previously focused editor first.
    activeFieldId = id; return focusActiveField();
  }
  function focusActiveField() {
    const tools = editors.get(activeFieldId) || editors.values().next().value;
    tools?.editor.focus({ preventScroll: true }); revealActive = true; scheduleFieldGrid(); return tools || null;
  }
  function variationGuard(id, captured = null) {
    const f = state?.recipe.fields.find(f => f.id === id);
    if (!f || !f.enabled) throw new Error("Enable this field before varying it.");
    if (channelConnected(f.channel)) throw new Error("This field is controlled by a connected prompt input.");
    if (f.experimentState === "lock") throw new Error("This field is locked. Change its experiment state before varying it.");
    const context = JSON.stringify({ recipe: state.recipe, seed: getSeed(), mode: getMode(), refinement: refinementRevision() });
    if (captured != null && captured !== context) throw new Error("The workspace or seed changed. Capture the selection again.");
    return context;
  }
  async function prepareFieldBatch(id, prompts, context) {
    variationGuard(id, context);
    if (node.inputs?.some(input => input.name === "negative_text" && input.link != null)) throw new Error("A connected negative input cannot be captured into a new batch. Copy the version instead.");
    const plan = createExperimentPlan(state.recipe, "current", id);
    plan.runtimeNamespace = String(node.id);
    const [captured] = await resolveExperiment(plan, getSeed(), getMode(), 1, API.resolveVariations);
    if (disposed) throw new Error("The workspace was closed.");
    variationGuard(id, context);
    const versions = prompts.map(prompt => projectExperiment(plan, captured.baseline, { [id]: prompt }));
    return { source: plan.compiled.positive, prompts: versions.map(v => v.positive), negative: versions[0].negative,
      session: { negative_prompts: versions.map(v => v.negative), wildcards: captured.wildcards || [] } };
  }
  function setReadOnly(enabled) {
    if (textarea.dataset.ppEditorSurface === "single") textarea.contentEditable = enabled ? "false" : "true";
    else textarea.readOnly = enabled;
    textarea.setAttribute("aria-readonly", String(enabled));
  }
  function view(mode, { fromPreview = false } = {}) {
    if (!state) return;
    if (!fromPreview) previewReturnToWorkspace = false;
    if (mode === "workspace" && state.view !== "workspace") {
      reconcile({ commitPromptState: true });
    } else if (mode === "editor" && state.view === "workspace") {
      for (const [id, { editor }] of editors) {
        const current = state.recipe.fields.find(x => x.id === id);
        if (current && editor.value !== current.value) {
          mutate(r => {
            const f = r.fields.find(x => x.id === id);
            if (f && f.value !== editor.value) { delete f.variationTemplate; f.value = editor.value; }
          }, { typing: true, rebuildUI: false });
        }
      }
    }
    closeAcMenu(); state.view = mode; persist(); rebuild();
    if (mode === "editor") { onShowEditor?.(); if (!fromPreview) textarea.focus({ preventScroll: true }); }
    else if (mode === "workspace") onShowEditor?.();
  }
  function orderedFields() { const lookup = new Map(state.recipe.fields.map(f => [f.id, f])); return state.recipe.segments.filter(s => s.type === "field").map(s => lookup.get(s.id)); }
  async function freezeField(id) {
    const field = state?.recipe.fields.find(f => f.id === id);
    if (!field?.enabled || !field.value.trim()) throw new Error("Enable and fill this field before freezing it.");
    if (channelConnected(field.channel)) throw new Error("This field is controlled by a connected prompt input.");
    const captured = JSON.stringify(state.recipe), seed = getSeed(), mode = getMode(), revision = refinementRevision();
    const last = node.properties?.prompt_palette_last_result;
    const payload = JSON.stringify(workspaceGeneration(state.recipe, { namespace: node.id }));
    const preview = last?.workspace_runtime === payload && last.workspace_fields?.[id] != null
      ? { fields: last.workspace_fields } : await resolveWorkspacePreview(state.recipe, seed, mode, API.resolveVariations, { namespace: node.id });
    if (disposed || !state || revision !== refinementRevision() || captured !== JSON.stringify(state.recipe) || seed !== getSeed() || mode !== getMode()) throw new Error("The workspace or seed changed. Freeze the current value again.");
    if (!Object.hasOwn(preview.fields, id)) throw new Error("This field has no active resolved value.");
    mutate(r => {
      const f = r.fields.find(f => f.id === id);
      if (!f.variationTemplate && hasDynamicSyntax(f.value)) f.variationTemplate = f.value;
      f.value = preview.fields[id]; f.experimentState = "lock";
    });
  }
  function sourceControls(card, f) {
    const help = document.createElement("p"); help.className = "pp-field-variation-hint";
    const controls = document.createElement("div"); controls.className = "pp-field-source-controls pp-refine-actions";
    const setup = document.createElement("section"); setup.className = "pp-field-choices"; setup.hidden = true;
    const label = document.createElement("label"); label.textContent = "Choices · one per line";
    const input = document.createElement("textarea"); input.className = "pp-choice-input"; input.rows = 5; input.setAttribute("aria-label", `Choices for ${f.label}`); input.placeholder = "standing\nsitting\nrunning"; label.appendChild(input);
    const note = document.createElement("p"); note.className = "pp-refine-note"; note.textContent = "Each line is one alternative for the whole field. Replace field with choices saves them and marks it Vary. You can undo the replacement.";
    const choiceError = document.createElement("p"); choiceError.className = "pp-choice-error"; choiceError.setAttribute("role", "alert"); choiceError.hidden = true;
    const actions = document.createElement("div"); actions.className = "pp-refine-actions";
    actions.append(button("Replace field with choices", () => {
      try {
        const value = choicesFromLines(input.value);
        mutate(r => { const target = r.fields.find(x => x.id === f.id); target.value = value; delete target.variationTemplate; target.experimentState = "vary"; });
        revealField(f.id);
      } catch (error) { choiceError.textContent = error.message; choiceError.hidden = false; }
    }), button("Cancel choices", () => { setup.hidden = true; }));
    setup.append(label, note, choiceError, actions);
    const setChoices = button("Set choices", () => {
      const current = state.recipe.fields.find(x => x.id === f.id);
      input.value = editableChoiceLines(current); setup.hidden = false; choiceError.hidden = true; input.focus();
    });
    const library = button("Insert wildcard", () => {
      const editor = revealField(f.id)?.editor; if (!editor) return;
      editor.focus(); const caret = editor.selectionStart; editor.setSelectionRange(caret, caret);
      return openOrUpdateAcMenu(editor, { kind: "wildcard", query: "", modifier: "", start: caret, end: caret }, getMatches, onCommit, { force: true });
    }, "Insert an existing library wildcard at the caret. Each list line can provide an alternative.");
    const vary = button("Vary field", () => { activeFieldId = f.id; return openVariations("current"); }); vary.dataset.varyField = f.id; vary.hidden = !getPowerToolPreferences().variationLab;
    const freeze = button("Freeze current value", () => freezeField(f.id), "Resolve this field at the current seed, store its literal result and Lock it. Original choices remain available."); freeze.dataset.freezeField = f.id;
    const restore = button("Restore choices", () => mutate(r => { const target = r.fields.find(x => x.id === f.id); target.value = target.variationTemplate; delete target.variationTemplate; })); restore.dataset.restoreChoices = f.id;
    const saved = document.createElement("details"); saved.className = "pp-field-saved-choices";
    const savedTitle = document.createElement("summary"); savedTitle.textContent = "Original choices (kept for reuse)";
    const savedText = document.createElement("pre"); saved.append(savedTitle, savedText);
    controls.append(setChoices, library, vary, freeze, restore); card.append(help, controls, saved, setup);
    return help;
  }
  function followControls(card, f) {
    const dependencies = document.createElement("fieldset"); dependencies.className = "pp-follow-dependencies";
    const legend = document.createElement("legend"); legend.textContent = "Follow when these fields change"; dependencies.appendChild(legend);
    for (const source of state.recipe.fields.filter(x => x.id !== f.id && !(f.channel === "positive" && x.channel === "negative"))) {
      const label = document.createElement("label"), check = document.createElement("input"); check.type = "checkbox"; check.checked = f.dependsOn.includes(source.id); check.setAttribute("aria-label", `${f.label} follows ${source.label}`);
      check.addEventListener("change", () => mutate(r => { const target = r.fields.find(x => x.id === f.id); target.dependsOn = target.dependsOn.filter(id => id !== source.id).concat(check.checked ? [source.id] : []); }));
      label.append(check, document.createTextNode(source.label)); dependencies.appendChild(label);
    }
    const hint = document.createElement("small"); hint.textContent = "Example: Lighting follows Pose. Mark Pose Vary and give both fields choices. Lighting changes only when the resolved Pose changes; otherwise its last choice is held. This follows changes, not semantic matching between lists. Keep sources in the same prompt channel, or follow a positive source from a negative field.";
    dependencies.appendChild(hint); card.appendChild(dependencies);
  }
  function ensureResolvedUI(card, f) {
    if (!card) return;
    let resolved = card.querySelector(".pp-field-resolved");
    if (!hasDynamicSyntax(f.value)) { resolved?.remove(); return; }
    if (resolved) return;
    resolved = document.createElement("details"); resolved.className = "pp-field-resolved"; resolved.dataset.resolvedField = f.id;
    resolved.open = !!state.resolvedOpen?.includes(f.id);
    const title = document.createElement("summary"); title.textContent = "Resolved field";
    const text = document.createElement("pre"); text.textContent = "Open to resolve with the current seed."; resolved.append(title, text);
    (card.querySelector(".pp-split-options-head") || card.firstChild)?.after(resolved);
    resolved.addEventListener("toggle", () => { if (state && resolved.isConnected) { state.resolvedOpen = [...new Set((state.resolvedOpen || []).filter(id => id !== f.id).concat(resolved.open ? [f.id] : []))]; persist(); scheduleInsights(); } });
  }
  function updateWorkspaceCharCount() {
    if (!state) return;
    for (const f of state.recipe.fields) {
      const chip = section.querySelector(`[data-field-count="${CSS.escape(f.id)}"]`);
      const text = `${f.value.length.toLocaleString()}c`;
      if (chip && chip.textContent !== text) chip.textContent = text;
    }
    const charCountEl = root.querySelector('[data-el="charCount"]');
    if (!charCountEl) return;
    if (state.view === "workspace" && activeFieldId && section.contains(document.activeElement)) {
      const active = state.recipe.fields.find(x => x.id === activeFieldId);
      if (active) {
        const label = active.titleHidden ? "Field" : active.label;
        charCountEl.textContent = `${label}: ${active.value.length.toLocaleString()} · ${textarea.value.length.toLocaleString()} chars`;
        return;
      }
    }
    charCountEl.textContent = `${textarea.value.length.toLocaleString()} chars`;
  }
  function refreshChrome() {
    const variationEnabled = !!getPowerToolPreferences().variationLab;
    const doctorEnabled = !!getPowerToolPreferences().promptDoctor;
    const ui = normalizeFieldEditorPreferences(loadTheme());
    for (const [key, value] of Object.entries(ui)) if (key.startsWith("showField")) section.dataset[key] = String(value);
    section.dataset.fieldColumns = ui.fieldEditorColumns;
    section.style.setProperty("--pp-field-min-height", `${ui.fieldEditorMinHeight}px`);
    refreshAccents();
    notice.hidden = !ui.showWorkspaceName;
    convert.hidden = !state || !ui.showFieldUnlink;
    const railPreferences = { add: "showFieldAdd", save: "showFieldSave", variation: "showFieldVariation", layouts: "showLayoutsShortcut" };
    for (const [action, key] of Object.entries(railPreferences)) tabs.querySelectorAll(`[data-workspace-act="${action}"]`).forEach(btn => { btn.hidden = !ui[key] || (action === "variation" && !variationEnabled); });
    section.querySelectorAll('[data-workspace-global="variation"], [data-vary-field]').forEach(btn => { btn.hidden = !variationEnabled; });
    section.querySelectorAll('[data-field-doctor]').forEach(btn => { btn.hidden = !doctorEnabled || !ui.showFieldReview; });
    scheduleFieldGrid();
  }
  function updatePreview({ compilation = null } = {}) {
    if (!state) return;
    const result = compilation || currentCompilation();
    const summary = section.querySelector(".pp-recipe-preview > summary");
    if (summary) summary.textContent = positiveAntonymsEnabled(node) ? "Compiled source · Positive Antonyms apply in output preview" : "Compiled Prompt";
    for (const channel of ["positive", "negative"]) {
      const preview = section.querySelector(`[data-compiled="${channel}"]`);
      const text = result[channel] || (channel === "positive" ? "(empty prompt)" : "");
      if (preview && preview.textContent !== text) preview.textContent = text;
    }
    notice.textContent = `${state.recipe.name || "Adjustable recipe"}${historyOf(state.recipe).activeVariantId ? " / " + historyOf(state.recipe).variants.find(v => v.id === historyOf(state.recipe).activeVariantId)?.name : ""}${JSON.stringify(state.recipe) !== state.baseline ? " • edited" : ""}`;
    const variationEnabled = !!getPowerToolPreferences().variationLab;
    for (const f of state.recipe.fields) {
      const card = fieldCard(f.id), options = optionsCard(f.id);
      const hint = fieldVariationHint(f, state.recipe.fields), inheritanceText = fieldInheritance(state.recipe, f.id) || "";
      const projection = [f.value, f.enabled, f.experimentState, f.variationTemplate, variationEnabled, hint, inheritanceText, summaryRevision];
      const owner = card || options;
      const previousProjection = owner && fieldProjections.get(owner);
      if (previousProjection?.every((value, index) => value === projection[index])) continue;
      if (owner) fieldProjections.set(owner, projection);
      ensureResolvedUI(options, f);
      const guide = options?.querySelector(".pp-field-variation-hint"); if (guide && guide.textContent !== hint) guide.textContent = hint;
      const vary = options?.querySelector("[data-vary-field]"); if (vary) { vary.disabled = !f.enabled || !f.value.trim() || f.experimentState === "lock"; vary.hidden = !variationEnabled; vary.title = !f.enabled ? "Include this field before previewing choices" : !f.value.trim() ? "Add text, choices or a wildcard first" : f.experimentState === "lock" ? "Locked: choose Vary in this field’s settings to explore its choices" : "Preview choices for this field in Variation Lab"; }
      const freeze = options?.querySelector("[data-freeze-field]"); if (freeze) { freeze.hidden = !hasDynamicSyntax(f.value); freeze.disabled = !f.enabled || !f.value.trim(); }
      const restore = options?.querySelector("[data-restore-choices]"); if (restore) restore.hidden = !f.variationTemplate;
      const saved = options?.querySelector(".pp-field-saved-choices"); if (saved) { saved.hidden = !f.variationTemplate; saved.querySelector("pre").textContent = f.variationTemplate || ""; }
      const resetBase = options?.querySelector("[data-reset-base]"); if (resetBase) resetBase.hidden = inheritanceText !== "overridden";
      const header = card?.querySelector(".pp-recipe-summary");
      if (header) {
        const singleLine = f.value.trim().replace(/\s+/g, " ");
        const previous = summarySources.get(header);
        if (previous?.source !== singleLine || previous?.revision !== summaryRevision) {
          if (singleLine && typeof paintSyntax === "function") {
            const html = paintSyntax(singleLine).html;
            if (header.innerHTML !== html) header.innerHTML = html;
          } else if (header.textContent !== (singleLine || "Empty field")) header.textContent = singleLine || "Empty field";
          summarySources.set(header, { source: singleLine, revision: summaryRevision });
        }
      }
      section.querySelectorAll(`[data-inheritance-field="${CSS.escape(f.id)}"]`).forEach(inheritance => {
        if (inheritance.textContent !== inheritanceText) inheritance.textContent = inheritanceText;
        if (inheritance.dataset.inheritance !== inheritanceText) inheritance.dataset.inheritance = inheritanceText;
        if (inheritance.hidden !== !inheritanceText) inheritance.hidden = !inheritanceText;
      });
    }
    updateWorkspaceCharCount();
    scheduleInsights();
  }
  async function renameRecipe() {
    const name = await dialogPrompt({ title: "Rename workspace", message: "Recipe name", defaultValue: state.recipe.name || "Prompt workspace" });
    if (name?.trim()) mutate(r => { r.name = name.trim(); });
  }
  async function saveRecipe(copy = false) {
    const snapshot = cloneWorkspaceData(state.recipe);
    const raw = await dialogPrompt({ title: copy ? "Save recipe copy" : "Save workspace as recipe", message: "My Library path (RECIPES/name). Existing entries require confirmation.", defaultValue: copy ? `${state.path || "RECIPES/workspace"}_copy` : state.path || "RECIPES/workspace" });
    if (raw == null || disposed) return;
    const path = raw.trim().replace(/\.txt$/i, "");
    if (!/^RECIPES\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/i.test(path)) throw new Error("Use a RECIPES/name path with letters, numbers, underscores or hyphens.");
    const existing = await API.content(path, { fresh: true });
    if (existing?.found && !await dialogConfirm({ title: "Update existing recipe", message: `Replace ${path} with this workspace?` })) return;
    const result = await API.save(path, serializeRecipe(snapshot));
    if (!result?.ok) throw new Error(result?.error || "Could not save recipe.");
    if (state && JSON.stringify(state.recipe) === JSON.stringify(snapshot)) { state.path = path; state.baseline = JSON.stringify(snapshot); persist(); updatePreview(); }
    await refreshLibrary(); notify("success", "Recipe saved", path);
  }
  function review(f) {
    if (!getPowerToolPreferences().promptDoctor) return;
    const analysis = analyzeWorkspace(state.recipe, { libraryEntries: getLibrary() });
    analysis.issues = analysis.issues.filter(i => i.fieldIds?.includes(f.id));
    const box = optionsCard(f.id)?.querySelector(".pp-recipe-review"); if (!box) return;
    box.hidden = false; box.textContent = analysis.issues.length ? analysis.issues.map(i => `${i.title}: ${i.detail}`).join("\n") : "Prompt Doctor: no obvious issues.";
  }
  function selectControl(label, options, value, change) {
    const select = document.createElement("select"); select.className = "wg-theme-select"; select.setAttribute("aria-label", label); select.title = label;
    options.forEach(([key, text]) => { const option = document.createElement("option"); option.value = key; option.textContent = text; select.appendChild(option); });
    select.value = value; select.addEventListener("change", () => {
      const fail = error => { notify("error", "Recipe Workspace", error.message); rebuild(); };
      try { Promise.resolve(change(select.value)).catch(fail); } catch (error) { fail(error); }
    }); return select;
  }
  function separatorControl(f = null) {
    const value = f ? f.separator : state.recipe.separator;
    const key = value == null ? "inherit" : Object.keys(separators).find(k => separators[k] === value) || "custom";
    return selectControl(f ? "Field separator before this field" : "Default separator", [...(f ? [["inherit", "Recipe separator"]] : []), ["comma", "Comma"], ["newline", "Newline"], ["space", "Space"], ["none", "None"], ["custom", "Custom…"]], key, async selected => {
      try {
      let next = selected === "inherit" ? null : separators[selected];
      if (selected === "custom") { next = await dialogPrompt({ title: "Custom separator", message: "Text inserted between fields (literal text)", defaultValue: value || "" }); if (next == null) { rebuild(); return; } }
      mutate(r => { if (f) r.fields.find(x => x.id === f.id).separator = next; else { r.separator = next; r.overrideBoundaries = true; } });
      } catch (error) { notify("error", "Recipe separator", error.message); rebuild(); }
    });
  }
  function accentControl(f, label) {
    const group = make("div", "pp-accent-picker"); group.setAttribute("role", "group"); group.setAttribute("aria-label", `Accent color for ${label}`);
    const current = (f.accent || "").toLowerCase();
    const isHex = /^#[0-9a-f]{6}$/i.test(current);
    const choose = value => { try { mutate(r => { const target = r.fields.find(x => x.id === f.id); if (value) target.accent = value; else delete target.accent; }); } catch (error) { notify("error", "Recipe Workspace", error.message); } };
    const swatch = (value, name) => {
      const b = make("button", "pp-accent-swatch"); b.type = "button"; b.title = name; b.setAttribute("aria-label", `${name} accent for ${label}`);
      b.setAttribute("aria-pressed", String(value === current));
      if (value === "none") b.dataset.none = "";
      else if (value) b.style.setProperty("--swatch", value);
      else b.dataset.auto = "";
      b.addEventListener("click", e => { e.stopPropagation(); choose(value); }); return b;
    };
    group.appendChild(swatch("", "Automatic (follows the theme)"));
    group.appendChild(swatch("none", "No accent"));
    ACCENT_PRESETS.forEach(([value, name]) => group.appendChild(swatch(value, name)));
    const custom = make("input", "pp-accent-custom"); custom.type = "color"; custom.value = isHex ? current : "#d49a52";
    custom.title = "Custom color"; custom.setAttribute("aria-label", `Custom accent color for ${label}`);
    custom.dataset.active = String(isHex && !ACCENT_PRESETS.some(([value]) => value === current));
    custom.addEventListener("input", () => { const card = fieldCard(f.id); if (card) applyAccent(card, { ...f, accent: custom.value }); });
    custom.addEventListener("change", () => choose(custom.value));
    group.appendChild(custom); return group;
  }
  function settingsRow(caption, ...controls) { const row = make("div", "pp-split-row"); row.appendChild(make("span", "pp-split-caption", caption)); row.append(...controls); return row; }
  function settingsGroup(title, ...nodes) { const group = make("section", "pp-split-group"); group.appendChild(make("strong", "pp-split-group-title", title)); group.append(...nodes); return group; }
  function addField() {
    let added; state.settingsOpen = false;
    mutate(r => {
      if (r.fields.length >= 32) throw new Error("A workspace supports up to 32 fields.");
      added = newField(`Section ${r.fields.length + 1}`); added.titleHidden = true;
      r.fields.push(added); r.segments.push({ type: "field", id: added.id, join: true });
    });
    activeFieldId = added.id; focusActiveField();
  }
  function buildFieldCard(f, index) {
    const card = make("article", "pp-recipe-field"); card.dataset.fieldId = f.id;
    const expanded = !!state.expandedEditors?.includes(f.id), name = f.titleHidden ? `field ${index + 1}` : f.label;
    card.classList.toggle("is-disabled", !f.enabled); card.classList.toggle("is-empty", !f.value.trim());
    card.classList.toggle("is-collapsed", !!f.collapsed); card.classList.toggle("is-expanded", expanded && !f.collapsed);
    card.dataset.experimentState = f.experimentState || ""; applyAccent(card, f);
    const head = make("div", "pp-recipe-field-head");
    const collapse = button(`${f.collapsed ? "▸" : "▾"}${f.titleHidden ? "" : ` ${f.label}`}`, () => mutate(r => { r.fields.find(x => x.id === f.id).collapsed = !f.collapsed; }), f.collapsed ? "Expand field" : "Collapse field");
    collapse.replaceChildren(make("span", "pp-field-collapse-icon", f.collapsed ? "▸" : "▾"), make("span", "pp-field-title", f.titleHidden ? "" : f.label));
    collapse.classList.add("pp-recipe-field-label"); collapse.setAttribute("aria-expanded", String(!f.collapsed)); collapse.setAttribute("aria-label", `${f.collapsed ? "Expand" : "Collapse"} ${name}`);
    const summary = make("span", "pp-recipe-summary");
    const inherited = make("span", "pp-field-inheritance"); inherited.dataset.inheritanceField = f.id; inherited.textContent = fieldInheritance(state.recipe, f.id) || ""; inherited.hidden = !inherited.textContent;
    const stateChip = f.experimentState ? make("span", "pp-recipe-state", f.experimentState[0].toUpperCase() + f.experimentState.slice(1)) : null;
    if (stateChip) stateChip.title = `${fieldVariationHint(f, state.recipe.fields)} Open ⚙ to change Lock / Vary / Follow.`;
    const ioChip = (f.hasInput && f.hasOutput)
      ? make("span", "pp-recipe-state pp-field-io-chip", "IN·OUT")
      : f.hasInput
      ? make("span", "pp-recipe-state pp-field-io-chip", "IN")
      : f.hasOutput
      ? make("span", "pp-recipe-state pp-field-io-chip", "OUT")
      : null;
    if (ioChip) {
      ioChip.title = f.hasInput && f.hasOutput
        ? "Field Input & Output sockets enabled on node"
        : f.hasInput
        ? "Field Input socket enabled on node"
        : "Field Output socket enabled on node";
    }
    const charChip = make("span", "pp-field-char-count", `${f.value.length.toLocaleString()}c`);
    charChip.dataset.fieldCount = f.id; charChip.title = "Characters in this field";
    const isNeg = f.channel === "negative";
    const channel = make("span", "pp-recipe-channel");
    channel.dataset.channel = f.channel;
    channel.setAttribute("role", "img");
    channel.title = isNeg ? "Negative prompt channel" : "Positive prompt channel";
    channel.setAttribute("aria-label", isNeg ? "Negative prompt" : "Positive prompt");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "pp-field-switch";
    checkbox.setAttribute("role", "switch");
    checkbox.checked = f.enabled;
    checkbox.title = `${f.enabled ? "Disable" : "Enable"} ${name}`;
    checkbox.setAttribute("aria-label", `Include ${name}`);
    checkbox.addEventListener("change", () => mutate(r => { r.fields.find(x => x.id === f.id).enabled = checkbox.checked; }));
    const headActions = make("span", "pp-field-head-actions");
    if (f.hasInput) {
      const conn = findFieldInputConnection(node, f.id);
      const importBtn = button("", () => importFieldInput(f.id), conn.connected
        ? `Import text from ${conn.sourceLabel} into ${name} before running`
        : "Connect an upstream node to this field's input socket to import text");
      importBtn.innerHTML = `${svgIcon("download", 11)}<span>Import</span>`;
      importBtn.classList.add("pp-field-action", "pp-field-import-btn");
      importBtn.dataset.fieldImport = f.id;
      importBtn.hidden = !conn.connected;
      importBtn.disabled = importingFieldIds.has(f.id);
      headActions.appendChild(importBtn);
    }
    let heightBtn = null;
    if (!f.collapsed) {
      heightBtn = button("Auto", () => {
        const nextMode = card.dataset.heightMode === "auto" ? null : "auto";
        card._ppSetHeightMode?.(nextMode);
      }, "Toggle Auto height (fit content) vs flexible/manual height");
      heightBtn.classList.add("pp-field-action", "pp-field-height-btn");
      heightBtn.dataset.fieldHeightMode = f.id;
      const doctorBtn = button("Review", () => { openSettings("fields", f.id); review(f); }, `Review ${name} with Prompt Doctor`);
      doctorBtn.classList.add("pp-field-action", "pp-field-doctor-btn");
      doctorBtn.dataset.fieldDoctor = f.id;
      doctorBtn.hidden = !getPowerToolPreferences().promptDoctor;
      headActions.append(heightBtn, doctorBtn);
    }
    const gear = button("", () => openSettings("fields", f.id), `Settings for ${name} · Lock / Vary / Follow, choices and appearance`);
    gear.innerHTML = svgIcon("settings", 12);
    gear.classList.add("pp-recipe-field-gear", "pp-field-action");
    gear.setAttribute("aria-label", gear.title);
    headActions.appendChild(gear);
    head.append(collapse, summary, inherited, ...(stateChip ? [stateChip] : []), ...(ioChip ? [ioChip] : []), charChip, headActions, channel, checkbox);
    card.appendChild(head); fieldsPane.appendChild(card);
    if (f.collapsed) return;
    const editWrap = make("div", "pp-recipe-editor wg-editor-real");
    const overlay = make("div", "wg-editor-layer wg-highlight");
    const input = make("textarea", "wg-editor-layer wg-textarea"); input.value = f.value; input.spellcheck = true; input.title = f.help || f.placeholder || name; input.placeholder = f.placeholder || "Text, tags or __wildcards__"; input.setAttribute("aria-label", name);
    editWrap.append(overlay, input); card.appendChild(editWrap);
    const syncHeightBtn = mode => {
      if (!heightBtn) return;
      const isAuto = mode === "auto";
      heightBtn.textContent = isAuto ? "Auto" : "↕";
      heightBtn.setAttribute("aria-pressed", String(isAuto));
      heightBtn.title = isAuto ? "Auto height active · click for flexible/manual height" : mode === "manual" ? "Manual height pinned · click for Auto height" : "Switch to Auto height (fit content)";
    };
    card.appendChild(attachResizeGrip(card, editWrap, f.id, syncHeightBtn));
    const tools = attachRecipeFieldEditor({ node, root: card, input, overlay, paintSyntax, getMatches, onCommit,
      getSeed, getMode, getLibrary, onUndo, onRedo, holdHistory, releaseHistory, host, openHost, bindHover, onLibrarySaved,
      moveFocus: direction => {
        const ids = orderedFields().filter(x => !x.collapsed).map(x => x.id), next = ids[ids.indexOf(f.id) + direction];
        if (!next) return false; editors.get(next)?.editor.focus(); return true;
      }, allowBatch: f.channel === "positive", getBatchSource: () => currentCompilation().positive,
      variationGuard: captured => variationGuard(f.id, captured), prepareBatchPrompts: (prompts, captured) => prepareFieldBatch(f.id, prompts, captured),
      mapBatchPrompt: value => compileWorkspace(state.recipe, { [f.id]: value }).positive,
      projectPrompt: value => compileWorkspace(state.recipe, { [f.id]: value })[f.channel],
      onChange: value => {
        // Composition-end and tool sync can repeat the final native input.
        // Keep their selection/paint behavior without committing the same edit.
        if (state?.recipe.fields.find(x => x.id === f.id)?.value === value) return;
        mutate(r => { const field = r.fields.find(x => x.id === f.id); if (field.value !== value) delete field.variationTemplate; field.value = value; }, { typing: true, rebuildUI: false });
        card.classList.toggle("is-empty", !value.trim());
      },
      atomicEdit: value => {
        const dock = f.channel === "positive" && LORA_DOCK_HEADER_RE.test(value);
        mutate(r => {
          const field = r.fields.find(x => x.id === f.id);
          if (dock) {
            const { body, items } = splitLoraDock(value);
            if (field.value !== body) delete field.variationTemplate;
            field.value = body;
            if (items.length) {
              r.segments.push({ type: "static", text: `${LORA_DOCK_HEADER}\n${items.join(" ")}`, channel: "positive" });
            }
          } else {
            if (field.value !== value) delete field.variationTemplate;
            field.value = value;
          }
        }, { rebuildUI: dock });
      },
      onFocus: editor => {
        activeFieldId = f.id; fieldNav.value = f.id; node._ppActiveRecipeEditor = editor;
        for (const field of fieldsPane.children) field.classList.toggle("is-active-field", field === card);
        observeActiveField(); revealActive = true; scheduleFieldGrid(); updateWorkspaceCharCount(); scheduleInsights();
      } }); editors.set(f.id, tools);
    const viewport = fieldViewports.get(f.id);
    syncFieldReadOnly(tools.editor, f.channel);
    if (viewport) tools.editor.setSelectionRange(viewport.start, viewport.end, viewport.direction);
  }
  function buildFieldOptions(f, index, total) {
    const name = f.titleHidden ? `field ${index + 1}` : f.label;
    const opts = make("details", "pp-split-field-options"); opts.dataset.settingsField = f.id; opts.open = !!state.optionsOpen?.includes(f.id);
    opts.addEventListener("toggle", () => {
      if (!state || !opts.isConnected) return;
      const open = new Set(state.optionsOpen || []); if (opts.open) open.add(f.id); else open.delete(f.id);
      state.optionsOpen = [...open]; persist(); scheduleInsights();
    });
    const head = make("summary", "pp-split-options-head");
    head.append(make("span", "pp-split-options-name", `${index + 1}. ${f.titleHidden ? "Untitled field" : f.label}`));
    const inherited = make("span", "pp-field-inheritance"); inherited.dataset.inheritanceField = f.id; inherited.textContent = fieldInheritance(state.recipe, f.id) || ""; inherited.hidden = !inherited.textContent; head.appendChild(inherited);
    opts.appendChild(head);
    const body = make("div", "pp-split-options-body"); opts.appendChild(body);
    const title = make("input", "pp-split-title-input"); title.type = "text"; title.maxLength = 120; title.value = f.titleHidden ? "" : f.label; title.placeholder = `Untitled · ${f.label}`;
    title.setAttribute("aria-label", `Title for ${name}`); title.title = "Shown above the field. Leave empty to hide the title.";
    title.addEventListener("keydown", event => { if (isComfyQueueShortcut(event)) return; if (event.key === "Enter") title.blur(); event.stopPropagation(); });
    title.addEventListener("change", () => { const value = title.value.trim(); mutate(r => { const target = r.fields.find(x => x.id === f.id); if (value) { target.label = value; delete target.titleHidden; } else target.titleHidden = true; }); });
    body.appendChild(settingsRow("Title", title));
    const include = make("input"); include.type = "checkbox"; include.checked = f.enabled; include.setAttribute("aria-label", `Include ${name} in prompt`);
    include.addEventListener("change", () => mutate(r => { r.fields.find(x => x.id === f.id).enabled = include.checked; }));
    body.appendChild(settingsRow("Include", include));
    const savedHeight = state.editorHeights?.[f.id];
    const height = selectControl(`Editor height for ${name}`, [["fill", "Grid cell"], ["auto", "Fit content"], ["custom", "Custom pixels…"]], savedHeight === "auto" ? "auto" : Number.isFinite(Number(savedHeight)) && savedHeight != null ? "custom" : "fill", async mode => {
      let next = mode === "auto" ? "auto" : null;
      if (mode === "custom") {
        const raw = await dialogPrompt({ title: "Field editor height", message: "Height in pixels (48–2400)", defaultValue: String(Number(savedHeight) || 160) });
        if (raw == null) { rebuild(); return; }
        next = Number(raw); if (!Number.isFinite(next) || next < 48 || next > 2400) throw new Error("Choose a height from 48 to 2400 pixels.");
        next = fieldEditorHeight(next, loadTheme().workspaceSnapGrid !== false);
      }
      state.editorHeights = { ...(state.editorHeights || {}) };
      if (next == null) delete state.editorHeights[f.id]; else state.editorHeights[f.id] = next;
      persist(); rebuild();
    });
    body.appendChild(settingsRow("Editor height", height));
    body.appendChild(settingsRow("Accent", accentControl(f, name)));
    const targetNames = { both: "Field and title", field: "Field only", title: "Title only" }, hasAccentColor = /^#[0-9a-f]{6}$/i.test(f.accent || "");
    const targetControl = selectControl(`Accent color target for ${name}`, [["", `Workspace default · ${targetNames[normalizeFieldEditorPreferences(loadTheme()).fieldColorTarget]}`], ...Object.entries(targetNames)], f.accentTarget || "", value => mutate(r => { const target = r.fields.find(x => x.id === f.id); if (value) target.accentTarget = value; else delete target.accentTarget; }));
    targetControl.disabled = !hasAccentColor; targetControl.dataset.fieldAccentTarget = f.id;
    targetControl.title = hasAccentColor ? "Where this field's accent shows: its card, its title, or both. Editor text colors never change." : "Choose an accent color above to pick where it shows.";
    body.appendChild(settingsRow("Color on", targetControl));
    const experiment = selectControl(`Variation mode for ${name}`, [["", "Default"], ["lock", "Lock"], ["vary", "Vary"], ["follow", "Follow"]], f.experimentState || "", async value => {
      if (value && !node.widgets?.some(w => w.name === "workspace_runtime")) throw new Error("Restart ComfyUI and reload this workflow to activate field generation controls.");
      // Typing replaces validated recipe objects without rebuilding these controls.
      const field = state?.recipe.fields.find(x => x.id === f.id);
      if (!field || disposed) return;
      if (value === "lock" && field.enabled && field.value.trim()) await freezeField(field.id);
      else mutate(r => { r.fields.find(x => x.id === field.id).experimentState = value || null; });
    });
    experiment.title = "Vary: change choices during generation. Lock: capture and keep a value across seeds and reloads. Follow: change only when a source field changes. Default: normal prompt syntax.";
    experiment.dataset.fieldVariation = f.id;
    experiment.setAttribute("aria-description", experiment.title);
    body.appendChild(settingsRow("Lock / Vary / Follow", experiment));
    body.appendChild(settingsRow("Prompt", selectControl(`Prompt channel for ${name}`, [["positive", "Positive"], ["negative", "Negative"]], f.channel, value => mutate(r => { r.fields.find(x => x.id === f.id).channel = value; }))));
    const builtinTypes = ["text", "character", "outfit", "pose", "lighting", "environment", "camera", "composition", "style", "negative", "custom"];
    body.appendChild(settingsRow("Type", selectControl(`Field type for ${name}`, [["text", "Unspecified"], ["character", "Character"], ["outfit", "Outfit"], ["pose", "Pose"], ["lighting", "Lighting"], ["environment", "Environment"], ["camera", "Camera"], ["composition", "Composition"], ["style", "Style"], ["negative", "Negative"], ["custom", "Custom"], ...(!builtinTypes.includes(f.fieldType || "text") ? [[f.fieldType, f.fieldType]] : [])], f.fieldType || "text", value => mutate(r => { r.fields.find(x => x.id === f.id).fieldType = value; }))));
    body.appendChild(settingsRow("Joined by", separatorControl(f)));
    function fieldInputControl() {
      const wrap = make("div", "pp-split-row-group");
      const check = make("input"); check.type = "checkbox"; check.checked = !!f.hasInput;
      check.setAttribute("aria-label", `Enable input socket for ${name}`);
      check.title = "Expose an input socket on the node to send external text into this field";
      check.addEventListener("change", () => {
        mutate(r => { const target = r.fields.find(x => x.id === f.id); target.hasInput = check.checked; });
      });
      const checkLabel = make("label", "pp-split-check-label");
      checkLabel.append(check, document.createTextNode("Socket")); wrap.append(checkLabel);
      if (f.hasInput) {
        const conn = findFieldInputConnection(node, f.id);
        const placement = selectControl(`Placement for ${name}`, [["before", "Insert before text"], ["after", "Insert after text"]], f.inputPlacement || "before", value => mutate(r => { r.fields.find(x => x.id === f.id).inputPlacement = value; }));
        placement.title = "Choose whether incoming external text is prepended before or appended after the widget text";
        const importBtn = button("Import", () => importFieldInput(f.id), conn.connected
          ? `Import text from ${conn.sourceLabel} into ${name} before running`
          : "Connect an upstream node to this field's input socket to import text");
        importBtn.classList.add("pp-field-settings-import");
        importBtn.dataset.settingsImport = f.id;
        importBtn.disabled = !conn.connected || importingFieldIds.has(f.id);
        const disconnectBtn = button("Disconnect", () => {
          if (disconnectFieldInput(node, f.id)) notify("info", "Input disconnected", `Disconnected input wire from ${name}.`);
        }, `Disconnect input wire from ${name}`);
        disconnectBtn.classList.add("pp-field-settings-disconnect");
        disconnectBtn.dataset.settingsDisconnect = f.id;
        disconnectBtn.hidden = !conn.connected;
        wrap.append(placement, importBtn, disconnectBtn);
      }
      return wrap;
    }
    function fieldOutputControl() {
      const wrap = make("div", "pp-split-row-group");
      const check = make("input"); check.type = "checkbox"; check.checked = !!f.hasOutput;
      check.setAttribute("aria-label", `Enable output socket for ${name}`);
      check.title = "Expose an output socket on the node to pipe the resolved prompt from this field to other nodes";
      check.addEventListener("change", () => {
        mutate(r => { const target = r.fields.find(x => x.id === f.id); target.hasOutput = check.checked; });
      });
      const checkLabel = make("label", "pp-split-check-label");
      checkLabel.append(check, document.createTextNode("Socket (STRING)")); wrap.append(checkLabel);
      return wrap;
    }
    body.appendChild(settingsRow("Input text", fieldInputControl()));
    body.appendChild(settingsRow("Output text", fieldOutputControl()));
    if (f.hasInput || f.hasOutput) {
      const route = make("p", "pp-refine-note");
      route.dataset.fieldRouting = f.id;
      const separator = f.separator ?? state.recipe.separator ?? ", ";
      const separatorLabel = separator === "\n" ? "a newline" : separator === "" ? "no separator" : separator === " " ? "a space" : JSON.stringify(separator);
      route.textContent = [
        f.hasInput ? `${f.inputPlacement === "after" ? "Field text → incoming text" : "Incoming text → field text"}, joined with ${separatorLabel}. Empty field text accepts incoming text on its own; empty incoming text keeps your writing. Upstream text is available at execution; previews show authored text.` : "",
        f.hasOutput ? `Out: ${name} supplies only this field’s resolved text, including its input. Global prefix/suffix and other fields are excluded. Connect to a text encoder for regional conditioning. The field stays in its original place in the full prompt.` : "",
        !f.enabled ? "This field is disabled: its input is ignored and its output is empty." : "",
      ].filter(Boolean).join(" ");
      body.appendChild(route);
    }
    if (["vary", "follow"].includes(f.experimentState)) body.appendChild(settingsRow("How to vary", selectControl(`Generation method for ${name}`, [["cycle", "Cycle choices · every generation"], ["shuffle", "Shuffle · avoid repeats"], ["seed", "By seed · reproducible"], ["syntax", "Use written syntax · advanced"]], f.variationMode || "cycle", value => mutate(r => { r.fields.find(x => x.id === f.id).variationMode = value; }))));
    ensureResolvedUI(opts, f); sourceControls(body, f);
    if (f.experimentState === "follow") followControls(body, f);
    const actions = make("div", "pp-refine-actions pp-split-field-actions");
    const up = button("↑ Move up", () => mutate(r => reorderField(r, f.id, -1)), "Move field up"); up.disabled = index === 0;
    const down = button("↓ Move down", () => mutate(r => reorderField(r, f.id, 1)), "Move field down"); down.disabled = index === total - 1;
    actions.append(up, down, button("Duplicate", () => mutate(r => {
      if (r.fields.length >= 32) throw new Error("A workspace supports up to 32 fields.");
      const copy = { ...cloneWorkspaceData(r.fields.find(x => x.id === f.id)), id: fieldId(), label: `${f.label} copy` }; r.fields.push(copy); const i = r.segments.findIndex(s => s.id === f.id); r.segments.splice(i + 1, 0, { type: "field", id: copy.id, join: true });
    })), button("Reset to Default", () => mutate(r => { const field = r.fields.find(x => x.id === f.id); field.value = field.default; delete field.variationTemplate; })),
    button("Remove", () => mutate(r => { r.fields = r.fields.filter(x => x.id !== f.id); r.segments = r.segments.filter(s => s.id !== f.id); r.fields.forEach(x => { x.dependsOn = x.dependsOn.filter(id => id !== f.id); }); })),
    button("Syntax", () => revealField(f.id)?.syntax()));
    if (historyOf(state.recipe).activeVariantId && historyOf(state.recipe).base?.fields.some(x => x.id === f.id)) { const reset = button("Reset to base", () => replaceRecipe(resetInheritedField(state.recipe, f.id))); reset.dataset.resetBase = f.id; reset.hidden = fieldInheritance(state.recipe, f.id) !== "overridden"; actions.append(reset); }
    if (getPowerToolPreferences().promptDoctor) actions.append(button("Review field", () => review(f)));
    body.appendChild(actions);
    const reviewBox = make("div", "pp-recipe-review"); reviewBox.hidden = true; body.appendChild(reviewBox);
    return opts;
  }
  function rebuild() {
    const focused = document.activeElement;
    const focusedField = section.contains(focused) ? focused.closest?.("[data-field-id]")?.dataset.fieldId : null;
    const fieldSelection = focusedField && focused.classList?.contains("wg-textarea") ? [focused.selectionStart, focused.selectionEnd, focused.selectionDirection] : null;
    const needsEditorFocus = focused === textarea || !!focusedField;
    // Every edit rebuilds the surface. Remember where the person was so the rebuild is invisible to them.
    const settingsScroll = settingsPane.querySelector(".pp-split-settings-body")?.scrollTop || 0;
    const settingsWasOpen = !settingsPane.hidden;
    const fieldsScroll = fieldsPane.scrollTop;
    for (const [id, { editor }] of editors) {
      const previous = fieldViewports.get(id);
      const selection = editor === focused || !previous ? { start: editor.selectionStart, end: editor.selectionEnd, direction: editor.selectionDirection } : previous;
      fieldViewports.set(id, { ...selection, top: editor.scrollTop, left: editor.scrollLeft });
    }
    clearEditors(); section.replaceChildren(); fieldsPane.replaceChildren(); settingsPane.replaceChildren(); railActions.replaceChildren();
    const enabled = getPowerToolPreferences().adjustableRecipes;
    workspaceTab.hidden = !enabled && !state; tabs.hidden = !enabled && !state;
    convert.hidden = !state; setReadOnly(false);
    const split = !!state && state.view === "workspace";
    fieldNav.hidden = !split || state.recipe.fields.length < 2;
    editorTab.setAttribute("aria-pressed", String(!split)); workspaceTab.setAttribute("aria-pressed", String(split));
    wrap.hidden = !!state && state.view === "workspace"; section.hidden = !split; tabs.classList.toggle("is-workspace", split);
    root.classList.toggle("pp-recipe-active", split);
    if (!split) { cancelInsights(); if (!insightResult) insightKey = ""; if (state) updatePreview(); else notice.textContent = ""; return; }
    if (!state.recipe.fields.some(f => f.id === activeFieldId)) activeFieldId = orderedFields().find(f => !f.collapsed)?.id || orderedFields()[0]?.id;
    for (const id of fieldViewports.keys()) if (!state.recipe.fields.some(f => f.id === id)) fieldViewports.delete(id);
    fieldNav.replaceChildren(...orderedFields().map((f, i) => {
      const option = make("option", "", `${i + 1}. ${f.titleHidden ? "Untitled field" : f.label}${f.channel === "negative" ? " · Negative" : ""}${!f.enabled ? " · Excluded" : f.experimentState ? ` · ${f.experimentState}` : ""}`);
      option.value = f.id; return option;
    })); fieldNav.value = activeFieldId;
    section.dataset.settingsOpen = String(!!state.settingsOpen);
    const settingsButton = button("Settings", () => state.settingsOpen ? closeSettings() : openSettings(), "Field and workspace settings");
    settingsButton.setAttribute("aria-expanded", String(!!state.settingsOpen)); settingsButton.classList.add("pp-split-settings-toggle");
    const variationBtn = button("Variation Lab", () => openVariations(), "Preview choices for a scope, then apply a version or send it to Combinatorial");
    variationBtn.dataset.workspaceAct = "variation";
    variationBtn.hidden = !getPowerToolPreferences().variationLab;
    const layoutsBtn = button("Layouts", () => { openSettings("workspace"); const picker = section.querySelector(".pp-workspace-layout-picker"); if (picker) picker.open = true; });
    layoutsBtn.dataset.workspaceAct = "layouts";
    layoutsBtn.hidden = loadTheme().showLayoutsShortcut === false;
    const addButton = button("+ Field", addField); addButton.dataset.workspaceAct = "add";
    const saveButton = button("Save", () => saveRecipe()); saveButton.dataset.workspaceAct = "save";
    railActions.append(addButton, variationBtn, saveButton, layoutsBtn, settingsButton);

    // Settings surface: four panes, one visible at a time.
    const panes = Object.fromEntries(["fields", "workspace", "preview", "history"].map(key => { const pane = make("div", "pp-split-pane"); pane.dataset.pane = key; pane.setAttribute("role", "tabpanel"); return [key, pane]; }));
    const guide = make("details", "pp-workspace-guide"); guide.open = !!state.guideOpen;
    const guideText = make("p", "", "A field is one editable part of the final prompt; its title is only a label. Vary samples the alternatives you supply. Plain text is a single value. Set choices (standing, sitting, running on separate lines) or Insert wildcard to supply alternatives. Vary cycles choices during generation by default, even at a fixed seed. Choose shuffle, by seed or written syntax in field settings. Lock captures a literal choice that survives seeds and reloads. Follow changes its choice only when a selected source changes. Apply edits only targeted fields and keeps their choices available for another preview. Use Combinatorial for the exact captured full versions.");
    guide.append(make("summary", "", "Generation: set choices → choose Vary, Lock or Follow"), guideText);
    guide.addEventListener("toggle", () => { if (state && guide.isConnected) { state.guideOpen = guide.open; persist(); } });
    const insights = make("details", "pp-recipe-insights"); insights.open = !!state.insightsOpen; insights.appendChild(make("summary", "", "Preview & safety"));
    insights.addEventListener("toggle", () => { if (state && insights.isConnected) { state.insightsOpen = insights.open; persist(); scheduleInsights(true); } });
    const insightActions = make("div", "pp-refine-actions");
    insightActions.append(selectControl("Combination count scope", [["vary", "Vary Fields"], ["current", "Current Field"], ["unlocked", "All Unlocked Fields"], ["workspace", "Entire Workspace"]], estimateScope, value => { estimateScope = value; scheduleInsights(true); }), button("Refresh previews", () => scheduleInsights(true)));
    const countStatus = make("div", "pp-combination-status"); countStatus.setAttribute("role", "status"); countStatus.setAttribute("aria-live", "polite");
    const countFields = make("pre", "pp-combination-fields");
    const doctorBox = make("div", "pp-workspace-doctor"); doctorBox.hidden = true;
    if (getPowerToolPreferences().promptDoctor) insightActions.appendChild(button("Review workspace", () => {
      const analysis = analyzeWorkspace(state.recipe, { libraryEntries: getLibrary(), compiledPreview: { positive: textarea.value, negative: String(negativeWidget?.value || "") } });
      doctorBox.hidden = false; doctorBox.textContent = analysis.issues.length ? analysis.issues.map(i => `${i.title}: ${i.detail}`).join("\n\n") : "Prompt Doctor: no obvious issues.";
    }));
    insights.append(make("p", "pp-refine-note", "Read-only previews and estimates. Use Variation Lab to sample actual choices, compare them and apply a version."), insightActions, countStatus, countFields, doctorBox);

    const lookup = new Map(state.recipe.fields.map(f => [f.id, f])), total = state.recipe.fields.length; let fieldIndex = 0;
    for (const segment of state.recipe.segments) {
      if (segment.type === "static") {
        if (!segment.text.trim() || segment.boundary) continue;
        const isDock = isLoraDockSegment(segment);
        const display = isDock ? segment.text.trim() : segment.text;
        const fixed = make("div", isDock ? "pp-recipe-static pp-recipe-lora-dock" : "pp-recipe-static");
        if (isDock && typeof paintSyntax === "function") fixed.innerHTML = paintSyntax(display).html;
        else fixed.textContent = display;
        fixed.title = isDock ? "Docked LoRAs · always kept at the end of the prompt after all fields" : "Fixed recipe text; preserved in this position";
        fieldsPane.appendChild(fixed); continue;
      }
      const f = lookup.get(segment.id), index = fieldIndex++;
      buildFieldCard(f, index); panes.fields.appendChild(buildFieldOptions(f, index, total));
    }
    const presetHost = make("details", "pp-workspace-layout-picker"); presetHost.appendChild(make("summary", "", "Starter layouts"));
    panes.workspace.append(presetHost,
      settingsGroup("Layout", (() => { const row = make("div", "pp-refine-actions"); row.append(button("Reset field sizes", () => { flushHistory(); state.editorHeights = {}; state.expandedEditors = []; persist(); rebuild(); flushHistory(); }), button("Collapse all", () => mutate(r => r.fields.forEach(f => { f.collapsed = true; }))), button("Expand all", () => mutate(r => r.fields.forEach(f => { f.collapsed = false; })))); return row; })()),
      settingsGroup("Joining", settingsRow("Default separator", separatorControl())),
      settingsGroup("Workspace", (() => {
        const row = make("div", "pp-refine-actions pp-split-global-actions");
        const globalVariation = button("Variation Lab", () => openVariations(), "Preview choices for a scope, then apply a version or send it to Combinatorial");
        globalVariation.dataset.workspaceGlobal = "variation";
        globalVariation.hidden = !getPowerToolPreferences().variationLab;
        row.append(button("+ Field", addField), button("Save", () => saveRecipe()), globalVariation, button("Save copy", () => saveRecipe(true)), button("Rename workspace", renameRecipe), button("Export", () => exportRecipePack(state.recipe)), button("Unlink fields", () => convert.click()), button("Reset workspace", () => mutate(r => r.fields.forEach(f => { f.value = f.default; delete f.variationTemplate; }))));
        return row;
      })()),
      guide);
    const preview = make("details", "pp-recipe-preview"); preview.open = state.previewOpen !== false;
    preview.appendChild(make("summary", "", "Compiled Prompt"));
    preview.addEventListener("toggle", () => { if (state && preview.isConnected) { state.previewOpen = preview.open; persist(); } });
    for (const channel of ["positive", "negative"]) {
      const text = make("pre"); text.dataset.compiled = channel; text.setAttribute("aria-label", `${channel} prompt`); preview.appendChild(text);
      preview.appendChild(button(`Copy ${channel}`, () => navigator.clipboard.writeText(currentCompilation()[channel])));
    }
    panes.preview.append(preview, insights);
    appendIterationUI({ section: panes.history, state, button, selectControl, replaceRecipe, persist, getState: () => state, refreshLibrary, getLibrary, sendSnapshot, presetHost });

    const head = make("div", "pp-split-settings-head"), tabBar = make("div", "pp-split-tabbar"); tabBar.setAttribute("role", "tablist"); tabBar.setAttribute("aria-label", "Settings sections");
    const body = make("div", "pp-split-settings-body"), tabButtons = {};
    const showTab = (key, { updateState = true } = {}) => {
      if (updateState) state.settingsTab = key;
      for (const [name, pane] of Object.entries(panes)) { pane.hidden = name !== key; tabButtons[name].setAttribute("aria-selected", String(name === key)); tabButtons[name].tabIndex = name === key ? 0 : -1; }
    };
    for (const [key, text] of [["fields", "Fields"], ["workspace", "Workspace"], ["preview", "Preview"], ["history", "History"]]) {
      const tab = make("button", "pp-split-tab", text); tab.type = "button"; tab.setAttribute("role", "tab"); tabButtons[key] = tab;
      tab.addEventListener("click", () => { showTab(key); persist(); scheduleInsights(); });
      tab.addEventListener("keydown", event => {
        const keys = Object.keys(tabButtons), at = keys.indexOf(key), move = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
        if (!move) return; event.preventDefault(); const next = keys[(at + move + keys.length) % keys.length]; showTab(next); persist(); tabButtons[next].focus();
      });
      tabBar.appendChild(tab); body.appendChild(panes[key]);
    }
    const close = button("×", () => closeSettings(), "Close settings"); close.classList.add("wg-close-btn", "pp-split-close"); close.setAttribute("aria-label", "Close settings");
    head.append(tabBar, close); settingsPane.append(head, body);
    showTab(["fields", "workspace", "preview", "history"].includes(state.settingsTab) ? state.settingsTab : "fields", { updateState: false });
    settingsPane.hidden = !state.settingsOpen;
    section.append(fieldsPane, settingsPane);
    fieldsPane.scrollTop = fieldsScroll;
    for (const [id, { editor }] of editors) {
      const viewport = fieldViewports.get(id);
      if (viewport) { editor.scrollTop = viewport.top; editor.scrollLeft = viewport.left; }
    }
    fieldCard(activeFieldId)?.classList.add("is-active-field");
    observeActiveField();
    revealActive ||= needsEditorFocus || (!!state.settingsOpen && !settingsWasOpen);
    updatePreview(); refreshChrome();
    // Offsets only stick on attached, visible elements that already have their final height. The cards are
    // populated by updatePreview/refreshChrome, so restoring earlier clamps the offset against a short pane.
    if (state.settingsOpen) body.scrollTop = settingsScroll;
    fieldsPane.scrollTop = fieldsScroll;
    if (needsEditorFocus && !state.settingsOpen) {
      const editor = (editors.get(focusedField || activeFieldId) || editors.values().next().value)?.editor;
      if (editor) { editor.focus({ preventScroll: true }); if (fieldSelection && editors.get(focusedField)?.editor === editor) editor.setSelectionRange(...fieldSelection); const viewport = fieldViewports.get(activeFieldId); if (viewport) editor.scrollTop = viewport.top; }
    }
  }
  function restore(snapshot, { commit = true } = {}) {
    cancelInsights(); insightKey = ""; insightResult = null;
    if (snapshot) {
      const saved = cloneWorkspaceData(snapshot);
      state = {
        ...saved,
        recipe: validateWorkspaceRecipe(saved.recipe),
        settingsTab: ["fields", "workspace", "preview", "history"].includes(saved.settingsTab) ? saved.settingsTab : "fields",
      };
    }
    else state = null;
    persist(); if (state) sync({ commitPromptState: !commit }); rebuild(); if (commit) render();
  }
  function open(recipe, path = "", values = {}) {
    const migrated = workspaceFromRecipe(validateRecipe(recipe));
    migrated.name ||= path ? path.split("/").at(-1).replace(/[_-]+/g, " ") : "Adjustable recipe";
    migrated.fields.forEach(f => { if (Object.hasOwn(values, f.id)) f.value = values[f.id]; else if (Object.hasOwn(values, f.name)) f.value = values[f.name]; });
    flushHistory(); restore({ recipe: migrated, path, view: "workspace", baseline: JSON.stringify(migrated) }); flushHistory();
  }
  function reconcile({ commitPromptState = false } = {}) {
    if (!state || syncing) return;
    const compiled = currentCompilation();
    const currentText = textarea.value;
    if (currentText === compiled.positive) return;
    const selection = { start: textarea.selectionStart, end: textarea.selectionEnd, direction: textarea.selectionDirection };
    try {
      state.recipe = captureBranch(editCompiledPrompt(state.recipe, currentText));
    } catch (error) {
      console.warn("Prompt Palette: could not reconcile edited prompt into workspace fields", error);
      return;
    }
    sync({ commitPromptState });
    let rebuilt = false;
    if (state.view === "workspace" || !section.hidden || editors.size > 0 || fieldsPane.childElementCount > 0) {
      rebuild();
      rebuilt = true;
    }
    if (rebuilt || textarea.value !== currentText) {
      textarea.setSelectionRange(selection.start, selection.end, selection.direction);
    }
  }
  function refreshPresetOptions() {
    const select = section.querySelector('[aria-label="Field preset"]'); if (!select) return;
    const selected = select.value;
    const paths = getLibrary().map(item => typeof item === "string" ? item : item.path).filter(path => /^RECIPES\/_presets\//i.test(path));
    for (const option of [...select.options]) if (option.value.startsWith("saved:") && !paths.includes(option.value.slice(6))) option.remove();
    for (const path of paths) if (![...select.options].some(option => option.value === `saved:${path}`)) { const option = document.createElement("option"); option.value = `saved:${path}`; option.textContent = path.split("/").at(-1).replace(/[_-]/g, " "); select.appendChild(option); }
    select.value = [...select.options].some(option => option.value === selected) ? selected : "";
  }
  function refresh({ fromConfigure = false, info = null } = {}) {
    summaryRevision++;
    const saved = fromConfigure ? recoverWorkspaceFromNode(node, info) : (node.properties?.[WORKSPACE_KEY] ?? recoverWorkspaceFromNode(node));
    if (fromConfigure && saved && hasOccupiedWorkspaceFields(saved)) saved.view = "workspace";
    const comparableSaved = (!fromConfigure && state && previewReturnToWorkspace && saved && saved.view === "workspace" && state.view === "editor")
      ? { ...saved, view: state.view }
      : (saved || null);
    if (JSON.stringify(comparableSaved) !== JSON.stringify(state)) restore(saved || null, { commit: false });
    else if (state) {
      insightKey = "";
      if (state.view !== "workspace" && textarea.value !== currentCompilation().positive) reconcile({ commitPromptState: true });
      else sync();
      refreshPresetOptions(); refreshChrome(); editors.forEach(e => e.repaint());
    }
  }
  const settings = () => { if (state && state.view !== "workspace") reconcile({ commitPromptState: true }); rebuild(); };
  const nativeConfigure = node.configure;
  const shouldWrapConfigure = !node.__ppWorkspaceConfigureHookInstalled && typeof nativeConfigure === 'function';
  const configure = function(info, ...args) {
    return nativeConfigure.call(this, prepareWorkspaceFieldSockets(this, info), ...args);
  };
  if (shouldWrapConfigure) {
    node.__ppWorkspaceConfigureHookInstalled = true;
    node.configure = configure;
  }
  const previousConfigure = node.onConfigure;
  const onConfigure = function(info) {
    // Synchronous restoration also covers hosts calling onConfigure directly.
    const incoming = recoverWorkspaceFromNode(this, info);
    if (incoming) {
      if (hasOccupiedWorkspaceFields(incoming)) incoming.view = "workspace";
      this.properties ||= {};
      this.properties[WORKSPACE_KEY] = cloneWorkspaceData(incoming);
      this._ppConfiguredWorkspace = cloneWorkspaceData(incoming);
    }
    syncWorkspaceFieldSockets(node, incoming?.recipe || this.properties?.[WORKSPACE_KEY]?.recipe || null);
    if (!disposed && incoming) refresh({ fromConfigure: true, info });
    const result = previousConfigure?.apply(this, arguments);
    if (!disposed) refresh({ fromConfigure: true, info });
    return result;
  };
  node.onConfigure = onConfigure;
  const previousSerialize = node.onSerialize;
  const onSerialize = function(data) {
    const result = previousSerialize?.apply(this, arguments);
    if (!data || typeof data !== "object") return result;
    syncWorkspaceGeneration(this, state?.recipe || null);
    if (state) {
      const saved = cloneWorkspaceData(state);
      if (previewReturnToWorkspace) saved.view = "workspace";
      data.properties ||= {};
      data.properties[WORKSPACE_KEY] = saved;
      const runtimeWidget = this.widgets?.find?.(w => w.name === "workspace_runtime");
      const runtimeVal = runtimeWidget?.serializeValue?.() ?? runtimeWidget?.value ?? "";
      if (runtimeVal) {
        data.widgets_values_named = {
          ...(data.widgets_values_named && typeof data.widgets_values_named === "object" ? data.widgets_values_named : {}),
          workspace_runtime: runtimeVal,
        };
      }
    }
    return result;
  };
  node.onSerialize = onSerialize;
  const unsubscribeAppearance = onPromptPaletteAppearanceChanged(() => {
    if (disposed) return;
    summaryRevision++; refreshChrome();
    if (state?.view === "workspace") updatePreview();
  });
  const unsubscribeTagColors = onTagColorsChanged(() => {
    if (disposed) return;
    summaryRevision++;
    if (state?.view === "workspace") updatePreview();
  });
  const showCompiledForPreview = event => {
    if (!state || !event.target.closest('[data-act="resolve"]')) return;
    const resolvedView = root.querySelector('[data-el="resolvedView"]');
    const enteringPreview = !resolvedView?.classList.contains("on");
    if (enteringPreview && state.view === "workspace") {
      previewReturnToWorkspace = true;
      view("editor", { fromPreview: true });
    } else if (!enteringPreview && previewReturnToWorkspace) {
      previewReturnToWorkspace = false;
      queueMicrotask(() => { if (!disposed && state) view("workspace"); });
    }
  };
  root.addEventListener("click", showCompiledForPreview, true);
  root.addEventListener("pp-output-transform-changed", updatePreview);
  window.addEventListener("pp-power-tools-changed", settings);
  try {
    const initialSaved = recoverWorkspaceFromNode(node);
    if (initialSaved) {
      if (hasOccupiedWorkspaceFields(initialSaved)) initialSaved.view = "workspace";
      restore(initialSaved, { commit: false });
    } else rebuild();
  }
  catch (error) { notify("error", "Workspace could not be restored", error.message); state = null; rebuild(); }
  function experimentPlan(scope) {
    if (!state) throw new Error("Open a workspace first.");
    const plan = createExperimentPlan(state.recipe, scope, activeFieldId);
    const editable = id => !channelConnected(state.recipe.fields.find(f => f.id === id).channel);
    plan.primaryTargets = plan.primaryTargets.filter(editable); plan.targets = plan.targets.filter(editable);
    if (!plan.primaryTargets.length) throw new Error("This scope has no editable fields; its prompt inputs are connected.");
    plan.runtimeNamespace = String(node.id); plan.refinementRevision = refinementRevision(); return plan;
  }
  function assertPlan(plan) {
    if (disposed || !state || plan.refinementRevision !== refinementRevision()) throw new Error("The workspace or refinement changed. Refresh variations first.");
    applyExperiment(state.recipe, plan, {});
  }
  return { open, reconcile, refresh, refreshChrome, restore, snapshot: () => state ? cloneWorkspaceData(state) : null,
    openFieldSettings: () => openSettings("fields"),
    captureEditingContext() {
      for (const [id, { editor }] of editors) fieldViewports.set(id, { start: editor.selectionStart, end: editor.selectionEnd, direction: editor.selectionDirection, top: editor.scrollTop, left: editor.scrollLeft });
      return state ? { activeFieldId, viewports: [...fieldViewports].map(([id, viewport]) => [id, { ...viewport }]), scroll: fieldsPane.scrollTop, focusField: state.view === "workspace" } : null;
    },
    restoreEditingContext(saved) {
      if (!state || !saved) return;
      rebuild();
      activeFieldId = saved.activeFieldId; fieldViewports.clear();
      for (const [id, viewport] of saved.viewports) fieldViewports.set(id, viewport);
      if (saved.focusField) focusActiveField(); else textarea.focus({ preventScroll: true });
      for (const [id, { editor }] of editors) { const viewport = fieldViewports.get(id); if (viewport) { editor.setSelectionRange(viewport.start, viewport.end, viewport.direction); editor.scrollTop = viewport.top; editor.scrollLeft = viewport.left; } }
      fieldsPane.scrollTop = saved.scroll;
    },
    isActive: () => !!state, isWorkspaceView: () => state?.view === "workspace", showEditor: () => view("editor"),
    openWorkspace() {
      if (!state) {
        flushHistory();
        const recipe = { ...blankWorkspace(textarea.value), negative: String(negativeWidget?.value || "") };
        recipe.fields[0].titleHidden = true;
        state = { recipe, view: "workspace", path: "", baseline: "", settingsTab: "fields" };
        sync({ commitPromptState: false });
        rebuild();
        render();
        flushHistory();
      } else {
        view("workspace");
      }
      focusActiveField();
    },
    experimentPlan, assertPlan, contextChanged: () => {
      for (const [id, { editor }] of editors) {
        syncFieldReadOnly(editor, state.recipe.fields.find(f => f.id === id).channel);
      }
      syncFieldInputImportState();
      node._ppHistoryRefinement?.refreshControls();
      scheduleInsights();
    },
    editingSurface: () => state?.view === "workspace" ? (editors.get(activeFieldId) || editors.values().next().value)?.editor : null,
    focusEditingSurface() {
      const editor = state?.view === "workspace" ? (editors.get(activeFieldId) || editors.values().next().value)?.editor : null;
      if (editor) focusActiveField();
      else { if (state) view("editor"); textarea.focus({ preventScroll: true }); }
    },
    analyze: () => state ? analyzeWorkspace(state.recipe, { libraryEntries: getLibrary(), compiledPreview: { positive: textarea.value, negative: String(negativeWidget?.value || "") } }) : null,
    focusField(id, token = null) { if (!state?.recipe.fields.some(f => f.id === id)) return; state.view = "workspace"; state.settingsOpen = false; state.recipe.fields.find(f => f.id === id).collapsed = false; persist(); rebuild(); activeFieldId = id; const input = editors.get(id)?.editor; input?.focus(); if (token && input) input.setSelectionRange(token.start, token.end); },
    configureChoices(id) { if (!state?.recipe.fields.some(f => f.id === id)) return; openSettings("fields", id); const card = optionsCard(id); const action = [...(card?.querySelectorAll("button") || [])].find(b => b.textContent === "Set choices"); action?.click(); },
    defaultScope: () => state?.recipe.fields.some(f => f.enabled && f.experimentState === "vary") ? "vary" : activeFieldId ? "current" : "vary",
    varySelection() {
      variationGuard(activeFieldId);
      const tools = editors.get(activeFieldId);
      if (!tools || tools.editor.selectionEnd <= tools.editor.selectionStart) throw new Error("Select text in an expanded workspace field first.");
      return tools.varySelection();
    },
    applyVariation(plan, values) { assertPlan(plan); mutate(r => { const next = applyExperiment(r, plan, values); Object.assign(r, next); }); },
    sendVariations(plan, items, seed) {
      assertPlan(plan);
      if (!items.length) throw new Error("Keep at least one version to send.");
      if (node.inputs?.some(input => input.name === "negative_text" && input.link != null)) throw new Error("Copy the resolved prompts or use the workspace version: a connected negative input cannot be captured into a new batch.");
      return sendPreparedPrompts({ node, source: plan.compiled.positive, prompts: items.map(item => item.resolved), negative: items[0].negative, seed,
        session: { resolution_seed: seed, wildcards: [...new Set(items.flatMap(item => item.wildcards))], negative_prompts: items.map(item => item.negative),
          ...(plan.strategy === "one-field" ? { comparison: "one-field", labels: items.map(item => item.trial?.label || "Trial") } : {}) } });
    },
    cleanup() { disposed = true; if (shouldWrapConfigure && node.configure === configure) { node.configure = nativeConfigure; delete node.__ppWorkspaceConfigureHookInstalled; } if (node.onConfigure === onConfigure) node.onConfigure = previousConfigure; if (node.onSerialize === onSerialize) node.onSerialize = previousSerialize; cancelInsights(); gridObserver?.disconnect(); if (gridFrame != null) cancelAnimationFrame(gridFrame); window.removeEventListener("resize", scheduleFieldGrid); clearEditors(); unsubscribeAppearance?.(); unsubscribeTagColors(); window.removeEventListener("pp-power-tools-changed", settings); root.removeEventListener("pp-output-transform-changed", updatePreview); root.removeEventListener("click", showCompiledForPreview, true); tabs.remove(); section.remove(); delete node._ppActiveRecipeEditor; } };
}
import { isComfyQueueShortcut } from "../editor_shortcuts.js";
