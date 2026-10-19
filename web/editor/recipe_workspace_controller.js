import { workspaceGeneration, syncWorkspaceGeneration } from "./workspace_generation.js";
import { API } from "../prompt_palette_api.js";
import { getPowerToolPreferences } from "../prompt_palette_state.js";
import { positiveAntonymsEnabled } from "./positive_antonyms.js";
import { dialogPrompt, dialogConfirm } from "./dialogs.js";
import { notify } from "./notifications.js";
import { serializeRecipe, validateRecipe } from "./prompt_refinement.js";
import { exportRecipePack } from "./recipe_io.js";
import { attachRecipeFieldEditor } from "./recipe_field_editor.js";
import { cloneWorkspaceData, WORKSPACE_KEY, blankWorkspace, workspaceFromRecipe, validateWorkspaceRecipe, compileWorkspace, newField, fieldId, reorderField, separators } from "./recipe_workspace_model.js";
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

const ACCENT_PRESETS = [["#d86f70", "Red"], ["#82c6a2", "Green"], ["#75b7e8", "Blue"], ["#bb8ee8", "Purple"], ["#d49a52", "Amber"]];

export function createRecipeWorkspaceController({ node, root, textarea, render, flushHistory,
  getMatches, onCommit, paintSyntax, getSeed, getMode, getLibrary, refreshLibrary, onUndo, onRedo, holdHistory, releaseHistory, host, openHost, bindHover, onLibrarySaved, openVariations, onShowEditor }) {
  const wrap = root.querySelector(".wg-editor-wrap"), editors = new Map();
  let negativeWidget = node.widgets?.find(w => w.name === "negative_text");
  const negativeState = installNegativePromptState(node);
  let state = null, syncing = false, disposed = false, activeFieldId = null;
  let insightTimer = null, insightPending = null, insightVersion = 0, insightKey = "", insightResult = null;
  syncWorkspaceGeneration(node, null);
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
    return sendPreparedPrompts({ node, source: compileWorkspace(snapshot.recipe).positive, prompts: [result.positive], negative: result.negative, seed, session: { resolution_seed: seed } });
  }
  function make(tag, className, text) { const n = document.createElement(tag); if (className) n.className = className; if (text != null) n.textContent = text; return n; }
  const tabs = make("div", "pp-recipe-mode pp-refine-actions pp-split-rail");
  const section = make("section", "pp-recipe-workspace is-split"); section.hidden = true;
  const notice = make("span", "pp-refine-label");
  const modeGroup = make("div", "pp-split-seg"); modeGroup.setAttribute("role", "group"); modeGroup.setAttribute("aria-label", "Prompt editing mode");
  const railActions = make("div", "pp-split-actions");
  const fieldsPane = make("div", "pp-split-fields");
  const settingsPane = make("div", "pp-split-settings"); settingsPane.hidden = true;
  settingsPane.setAttribute("role", "region"); settingsPane.setAttribute("aria-label", "Workspace settings");
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
      state = { recipe, view: "workspace", path: "", baseline: "" }; sync(); rebuild(); render(); flushHistory();
    } else view("workspace");
  });
  const convert = button("Unlink fields", async () => {
    if (!state || !await dialogConfirm({ title: "Convert Workspace to Plain Prompt", message: "Keep the compiled prompt and unlink its fields, snapshots and variants? Undo restores the workspace." })) return;
    flushHistory(); state = null; persist(); rebuild(); render(); flushHistory();
  });
  convert.dataset.tone = "danger"; convert.title = "Keep the compiled prompt and switch to plain editing";
  modeGroup.append(editorTab, workspaceTab); tabs.append(modeGroup, notice, railActions, convert); wrap.before(tabs); wrap.after(section);
  function persist() { syncWorkspaceGeneration(node, state?.recipe || null); node.properties ||= {}; node.properties[WORKSPACE_KEY] = state ? cloneWorkspaceData(state) : null; node.setDirtyCanvas?.(true, true); }
  function currentCompilation() { return compileWorkspace(state.recipe); }
  function sync() {
    if (!state || syncing) return;
    syncing = true;
    try {
      const result = currentCompilation(); textarea.value = result.positive;
      negativeState.commit(result.negative);
      negativeWidget = node.widgets?.find(w => w.name === "negative_text");
      persist(); updatePreview();
    } finally { syncing = false; }
  }
  function mutate(action, { typing = false, rebuildUI = true } = {}) {
    if (!state) return;
    const previous = cloneWorkspaceData(state);
    if (!typing) flushHistory();
    try { action(state.recipe); state.recipe = captureBranch(validateWorkspaceRecipe(state.recipe)); sync(); }
    catch (error) { state = previous; throw error; }
    if (rebuildUI) rebuild();
    render(); if (!typing) flushHistory();
  }
  function clearEditors() { editors.forEach(e => e.cleanup()); editors.clear(); delete node._ppActiveRecipeEditor; }
  // Editors fill the node by default. Dragging the grip pins one field to a height; double-click returns it to filling.
  function attachResizeGrip(card, editWrap, id) {
    const MIN = 60, MAX = 2400, grip = make("div", "pp-split-grip");
    grip.setAttribute("role", "separator"); grip.setAttribute("aria-orientation", "horizontal"); grip.tabIndex = 0;
    grip.title = "Drag to resize · double-click to fill the space again";
    const size = height => { editWrap.style.height = `${height}px`; card.dataset.sized = "true"; };
    const commit = height => { state.editorHeights = { ...state.editorHeights, [id]: height }; persist(); };
    const saved = parseFloat(state?.editorHeights?.[id]); if (Number.isFinite(saved) && saved >= MIN && saved <= MAX) size(saved);
    let start = null;
    grip.addEventListener("pointerdown", event => { start = { y: event.clientY, h: editWrap.getBoundingClientRect().height }; grip.setPointerCapture?.(event.pointerId); event.preventDefault(); });
    grip.addEventListener("pointermove", event => { if (start) size(Math.min(MAX, Math.max(MIN, Math.round(start.h + event.clientY - start.y)))); });
    const finish = () => { if (!start) return; start = null; const height = parseFloat(editWrap.style.height); if (state && Number.isFinite(height)) commit(height); };
    grip.addEventListener("pointerup", finish); grip.addEventListener("pointercancel", finish);
    grip.addEventListener("keydown", event => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      event.preventDefault(); event.stopPropagation();
      const next = Math.min(MAX, Math.max(MIN, Math.round(editWrap.getBoundingClientRect().height + (event.key === "ArrowDown" ? 24 : -24)))); size(next); commit(next);
    });
    grip.addEventListener("dblclick", () => { editWrap.style.height = ""; delete card.dataset.sized; if (state?.editorHeights) { delete state.editorHeights[id]; persist(); } });
    return grip;
  }
  function fieldCard(id) { return section.querySelector(`[data-field-id="${CSS.escape(id)}"]`); }
  function optionsCard(id) { return section.querySelector(`[data-settings-field="${CSS.escape(id)}"]`); }
  function applyAccent(card, f) { card.dataset.accent = f.accent ? "custom" : "none"; if (f.accent) card.style.setProperty("--pp-field-accent", f.accent); else card.style.removeProperty("--pp-field-accent"); }
  function openSettings(tab = state?.settingsTab || "fields", fieldId = null) {
    if (!state) return;
    state.view = "workspace"; state.settingsOpen = true; state.settingsTab = tab;
    if (fieldId) state.optionsOpen = [...new Set([...(state.optionsOpen || []), fieldId])];
    persist(); rebuild();
    if (fieldId) optionsCard(fieldId)?.scrollIntoView?.({ block: "nearest" });
    settingsPane.querySelector('[role="tab"][aria-selected="true"]')?.focus({ preventScroll: true });
  }
  function closeSettings() {
    if (!state?.settingsOpen) return;
    state.settingsOpen = false; persist(); rebuild();
    (editors.get(activeFieldId) || editors.values().next().value)?.editor.focus({ preventScroll: true });
  }
  // Brings a field's editor into view (closing settings, expanding it) for actions that act on its text.
  function revealField(id) {
    if (!state) return null;
    state.settingsOpen = false; activeFieldId = id;
    if (state.recipe.fields.find(f => f.id === id)?.collapsed) mutate(r => { r.fields.find(f => f.id === id).collapsed = false; });
    else { persist(); rebuild(); }
    const tools = editors.get(id); tools?.editor.focus({ preventScroll: true }); return tools || null;
  }
  function variationGuard(id, captured = null) {
    const f = state?.recipe.fields.find(f => f.id === id);
    if (!f || !f.enabled) throw new Error("Enable this field before varying it.");
    if (f.experimentState === "lock") throw new Error("This field is locked. Change its experiment state before varying it.");
    const context = JSON.stringify({ recipe: state.recipe, seed: getSeed(), mode: getMode() });
    if (captured != null && captured !== context) throw new Error("The workspace or seed changed. Capture the selection again.");
    return context;
  }
  async function prepareFieldBatch(id, prompts, context) {
    variationGuard(id, context);
    if (node.inputs?.some(input => input.name === "negative_text" && input.link != null)) throw new Error("A connected negative input cannot be captured into a new batch. Copy the version instead.");
    const plan = createExperimentPlan(state.recipe, "current", id);
    const [captured] = await resolveExperiment(plan, getSeed(), getMode(), 1, API.resolveVariations, { namespace: node.id });
    if (disposed) throw new Error("The workspace was closed.");
    variationGuard(id, context);
    const versions = prompts.map(prompt => projectExperiment(plan, captured.baseline, { [id]: prompt }));
    return { source: plan.compiled.positive, prompts: versions.map(v => v.positive), negative: versions[0].negative };
  }
  function setReadOnly(enabled) {
    if (textarea.dataset.ppEditorSurface === "single") textarea.contentEditable = enabled ? "false" : "true";
    else textarea.readOnly = enabled;
    textarea.setAttribute("aria-readonly", String(enabled));
  }
  function view(mode) { if (!state) return; closeAcMenu(); state.view = mode; persist(); rebuild(); if (mode === "editor") { onShowEditor?.(); textarea.focus({ preventScroll: true }); } }
  function orderedFields() { const lookup = new Map(state.recipe.fields.map(f => [f.id, f])); return state.recipe.segments.filter(s => s.type === "field").map(s => lookup.get(s.id)); }
  async function freezeField(id) {
    const field = state?.recipe.fields.find(f => f.id === id);
    if (!field?.enabled || !field.value.trim()) throw new Error("Enable and fill this field before freezing it.");
    const captured = JSON.stringify(state.recipe), seed = getSeed(), mode = getMode();
    const last = node.properties?.prompt_palette_last_result;
    const payload = JSON.stringify(workspaceGeneration(state.recipe, { namespace: node.id }));
    const preview = last?.workspace_runtime === payload && last.workspace_fields?.[id] != null
      ? { fields: last.workspace_fields } : await resolveWorkspacePreview(state.recipe, seed, mode, API.resolveVariations, { namespace: node.id });
    if (disposed || !state || captured !== JSON.stringify(state.recipe) || seed !== getSeed() || mode !== getMode()) throw new Error("The workspace or seed changed. Freeze the current value again.");
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
    const vary = button("Vary field", () => { activeFieldId = f.id; return openVariations("current"); }); vary.dataset.varyField = f.id;
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
  function updatePreview() {
    if (!state) return;
    const result = currentCompilation();
    const summary = section.querySelector(".pp-recipe-preview > summary");
    if (summary) summary.textContent = positiveAntonymsEnabled(node) ? "Compiled source · Positive Antonyms apply in output preview" : "Compiled Prompt";
    section.querySelector('[data-compiled="positive"]')?.replaceChildren(document.createTextNode(result.positive || "(empty prompt)"));
    section.querySelector('[data-compiled="negative"]')?.replaceChildren(document.createTextNode(result.negative));
    notice.textContent = `${state.recipe.name || "Adjustable recipe"}${historyOf(state.recipe).activeVariantId ? " / " + historyOf(state.recipe).variants.find(v => v.id === historyOf(state.recipe).activeVariantId)?.name : ""}${JSON.stringify(state.recipe) !== state.baseline ? " • edited" : ""}`;
    for (const f of state.recipe.fields) {
      const card = fieldCard(f.id), options = optionsCard(f.id); ensureResolvedUI(options, f);
      const guide = options?.querySelector(".pp-field-variation-hint"); if (guide) guide.textContent = fieldVariationHint(f, state.recipe.fields);
      const vary = options?.querySelector("[data-vary-field]"); if (vary) vary.disabled = !f.enabled || !f.value.trim() || f.experimentState === "lock";
      const freeze = options?.querySelector("[data-freeze-field]"); if (freeze) { freeze.hidden = !hasDynamicSyntax(f.value); freeze.disabled = !f.enabled || !f.value.trim(); }
      const restore = options?.querySelector("[data-restore-choices]"); if (restore) restore.hidden = !f.variationTemplate;
      const saved = options?.querySelector(".pp-field-saved-choices"); if (saved) { saved.hidden = !f.variationTemplate; saved.querySelector("pre").textContent = f.variationTemplate || ""; }
      const resetBase = options?.querySelector("[data-reset-base]"); if (resetBase) resetBase.hidden = fieldInheritance(state.recipe, f.id) !== "overridden";
      const header = card?.querySelector(".pp-recipe-summary"); if (header) header.textContent = f.value.trim().replace(/\s+/g, " ") || "Empty field";
      const count = card?.querySelector(".pp-split-count"); if (count) count.textContent = `${f.value.length.toLocaleString()} chars`;
      section.querySelectorAll(`[data-inheritance-field="${CSS.escape(f.id)}"]`).forEach(inheritance => { inheritance.textContent = fieldInheritance(state.recipe, f.id) || ""; inheritance.dataset.inheritance = inheritance.textContent; inheritance.hidden = !inheritance.textContent; });
    }
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
    const choose = value => { try { mutate(r => { const target = r.fields.find(x => x.id === f.id); if (value) target.accent = value; else delete target.accent; }); } catch (error) { notify("error", "Recipe Workspace", error.message); } };
    const swatch = (value, name) => {
      const b = make("button", "pp-accent-swatch"); b.type = "button"; b.title = name; b.setAttribute("aria-label", `${name} accent for ${label}`);
      b.setAttribute("aria-pressed", String(value === current)); if (value) b.style.setProperty("--swatch", value); else b.dataset.auto = "";
      b.addEventListener("click", e => { e.stopPropagation(); choose(value); }); return b;
    };
    group.appendChild(swatch("", "Automatic (follows the theme)"));
    ACCENT_PRESETS.forEach(([value, name]) => group.appendChild(swatch(value, name)));
    const custom = make("input", "pp-accent-custom"); custom.type = "color"; custom.value = current || "#d49a52";
    custom.title = "Custom color"; custom.setAttribute("aria-label", `Custom accent color for ${label}`);
    custom.dataset.active = String(!!current && !ACCENT_PRESETS.some(([value]) => value === current));
    custom.addEventListener("input", () => { const card = fieldCard(f.id); if (card) applyAccent(card, { accent: custom.value }); });
    custom.addEventListener("change", () => choose(custom.value));
    group.appendChild(custom); return group;
  }
  function settingsRow(caption, ...controls) { const row = make("div", "pp-split-row"); row.appendChild(make("span", "pp-split-caption", caption)); row.append(...controls); return row; }
  function settingsGroup(title, ...nodes) { const group = make("section", "pp-split-group"); group.appendChild(make("strong", "pp-split-group-title", title)); group.append(...nodes); return group; }
  function buildFieldCard(f, index) {
    const card = make("article", "pp-recipe-field"); card.dataset.fieldId = f.id;
    const expanded = !!state.expandedEditors?.includes(f.id), name = f.titleHidden ? `field ${index + 1}` : f.label;
    card.classList.toggle("is-disabled", !f.enabled); card.classList.toggle("is-empty", !f.value.trim());
    card.classList.toggle("is-collapsed", !!f.collapsed); card.classList.toggle("is-expanded", expanded && !f.collapsed);
    card.dataset.experimentState = f.experimentState || ""; applyAccent(card, f);
    const head = make("div", "pp-recipe-field-head");
    const collapse = button(`${f.collapsed ? "▸" : "▾"}${f.titleHidden ? "" : ` ${f.label}`}`, () => mutate(r => { r.fields.find(x => x.id === f.id).collapsed = !f.collapsed; }), f.collapsed ? "Expand field" : "Collapse field");
    collapse.classList.add("pp-recipe-field-label"); collapse.setAttribute("aria-expanded", String(!f.collapsed)); collapse.setAttribute("aria-label", `${f.collapsed ? "Expand" : "Collapse"} ${name}`);
    const summary = make("span", "pp-recipe-summary");
    const inherited = make("span", "pp-field-inheritance"); inherited.dataset.inheritanceField = f.id; inherited.textContent = fieldInheritance(state.recipe, f.id) || ""; inherited.hidden = !inherited.textContent;
    const stateChip = f.experimentState ? make("span", "pp-recipe-state", f.experimentState[0].toUpperCase() + f.experimentState.slice(1)) : null;
    if (stateChip) stateChip.title = "Variation mode · change it in Field settings";
    const channel = make("span", "pp-recipe-channel", f.channel === "negative" ? "Neg" : "Pos"); channel.dataset.channel = f.channel; channel.title = f.channel === "negative" ? "Negative prompt" : "Positive prompt";
    const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.checked = f.enabled; checkbox.title = `Include ${name}`; checkbox.setAttribute("aria-label", checkbox.title);
    checkbox.addEventListener("change", () => mutate(r => { r.fields.find(x => x.id === f.id).enabled = checkbox.checked; }));
    const gear = button("⚙", () => openSettings("fields", f.id), `Field settings for ${name}`); gear.classList.add("pp-recipe-field-gear"); gear.setAttribute("aria-label", gear.title);
    head.append(collapse, summary, inherited, ...(stateChip ? [stateChip] : []), channel, checkbox, gear); card.appendChild(head); fieldsPane.appendChild(card);
    if (f.collapsed) return;
    const editWrap = make("div", "pp-recipe-editor wg-editor-real");
    const overlay = make("div", "wg-editor-layer wg-highlight");
    const input = make("textarea", "wg-editor-layer wg-textarea"); input.value = f.value; input.spellcheck = true; input.title = f.help || f.placeholder || name; input.placeholder = f.placeholder || "Text, tags or __wildcards__"; input.setAttribute("aria-label", name);
    editWrap.append(overlay, input); card.appendChild(editWrap); card.appendChild(attachResizeGrip(card, editWrap, f.id));
    const footer = make("div", "pp-split-footer"), count = make("span", "pp-split-count"); footer.appendChild(count);
    if (getPowerToolPreferences().promptDoctor) { const check = button("Review", () => { openSettings("fields", f.id); review(f); }, `Review ${name} with Prompt Doctor`); check.classList.add("pp-split-quiet"); footer.appendChild(check); }
    const expand = button(expanded ? "Compact editor" : "Expand editor", () => {
      state.expandedEditors = (state.expandedEditors || []).filter(id => id !== f.id).concat(expanded ? [] : [f.id]);
      if (state.editorHeights) delete state.editorHeights[f.id];
      persist(); rebuild(); editors.get(f.id)?.editor.focus();
    }, "Give this field more of the available height"); expand.classList.add("pp-split-quiet"); expand.setAttribute("aria-pressed", String(expanded)); footer.appendChild(expand); card.appendChild(footer);
    const tools = attachRecipeFieldEditor({ node, root: card, input, overlay, paintSyntax, getMatches, onCommit,
      getSeed, getMode, getLibrary, onUndo, onRedo, holdHistory, releaseHistory, host, openHost, bindHover, onLibrarySaved,
      moveFocus: direction => {
        const ids = orderedFields().filter(x => !x.collapsed).map(x => x.id), next = ids[ids.indexOf(f.id) + direction];
        if (!next) return false; editors.get(next)?.editor.focus(); return true;
      }, allowBatch: f.channel === "positive", getBatchSource: () => currentCompilation().positive,
      variationGuard: captured => variationGuard(f.id, captured), prepareBatchPrompts: (prompts, captured) => prepareFieldBatch(f.id, prompts, captured),
      mapBatchPrompt: value => compileWorkspace(state.recipe, { [f.id]: value }).positive,
      projectPrompt: value => compileWorkspace(state.recipe, { [f.id]: value })[f.channel],
      onChange: value => { mutate(r => { const field = r.fields.find(x => x.id === f.id); if (field.value !== value) delete field.variationTemplate; field.value = value; }, { typing: true, rebuildUI: false }); card.classList.toggle("is-empty", !value.trim()); },
      atomicEdit: value => mutate(r => { const field = r.fields.find(x => x.id === f.id); if (field.value !== value) delete field.variationTemplate; field.value = value; }, { rebuildUI: false }),
      onFocus: editor => { activeFieldId = f.id; node._ppActiveRecipeEditor = editor; scheduleInsights(); } }); editors.set(f.id, tools);
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
    body.appendChild(settingsRow("Accent", accentControl(f, name)));
    const experiment = selectControl(`Variation mode for ${name}`, [["", "Default"], ["lock", "Lock"], ["vary", "Vary"], ["follow", "Follow"]], f.experimentState || "", async value => { if (value && !node.widgets?.some(w => w.name === "workspace_runtime")) throw new Error("Restart ComfyUI and reload this workflow to activate field generation controls."); if (value === "lock" && f.enabled && f.value.trim()) await freezeField(f.id); else mutate(r => { r.fields.find(x => x.id === f.id).experimentState = value || null; }); });
    experiment.title = "Vary: change choices during generation. Lock: capture and keep a value across seeds and reloads. Follow: change only when a source field changes. Default: normal prompt syntax.";
    body.appendChild(settingsRow("Variation", experiment));
    body.appendChild(settingsRow("Prompt", selectControl(`Prompt channel for ${name}`, [["positive", "Positive"], ["negative", "Negative"]], f.channel, value => mutate(r => { r.fields.find(x => x.id === f.id).channel = value; }))));
    const builtinTypes = ["text", "character", "outfit", "pose", "lighting", "environment", "camera", "composition", "style", "negative", "custom"];
    body.appendChild(settingsRow("Type", selectControl(`Field type for ${name}`, [["text", "Unspecified"], ["character", "Character"], ["outfit", "Outfit"], ["pose", "Pose"], ["lighting", "Lighting"], ["environment", "Environment"], ["camera", "Camera"], ["composition", "Composition"], ["style", "Style"], ["negative", "Negative"], ["custom", "Custom"], ...(!builtinTypes.includes(f.fieldType || "text") ? [[f.fieldType, f.fieldType]] : [])], f.fieldType || "text", value => mutate(r => { r.fields.find(x => x.id === f.id).fieldType = value; }))));
    body.appendChild(settingsRow("Joined by", separatorControl(f)));
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
    const settingsScroll = settingsPane.querySelector(".pp-split-settings-body")?.scrollTop || 0;
    clearEditors(); section.replaceChildren(); fieldsPane.replaceChildren(); settingsPane.replaceChildren(); railActions.replaceChildren();
    const enabled = getPowerToolPreferences().adjustableRecipes;
    workspaceTab.hidden = !enabled; tabs.hidden = !enabled && !state;
    convert.hidden = !state; setReadOnly(false);
    const split = !!state && state.view === "workspace";
    editorTab.setAttribute("aria-pressed", String(!split)); workspaceTab.setAttribute("aria-pressed", String(split));
    wrap.hidden = !!state && state.view === "workspace"; section.hidden = !split; tabs.classList.toggle("is-workspace", split);
    root.classList.toggle("pp-recipe-active", split);
    if (!split) { cancelInsights(); if (!insightResult) insightKey = ""; if (state) updatePreview(); else notice.textContent = ""; return; }
    const settingsButton = button("Settings", () => state.settingsOpen ? closeSettings() : openSettings(), "Field and workspace settings");
    settingsButton.setAttribute("aria-expanded", String(!!state.settingsOpen)); settingsButton.classList.add("pp-split-settings-toggle");
    railActions.append(button("+ Field", () => {
      let added; state.settingsOpen = false;
      mutate(r => {
        if (r.fields.length >= 32) throw new Error("A workspace supports up to 32 fields.");
        added = newField(`Section ${r.fields.length + 1}`); added.titleHidden = true; r.fields.push(added); r.segments.push({ type: "field", id: added.id, join: true });
      });
      editors.get(added.id)?.editor.focus({ preventScroll: true });
    }), button("Variation Lab", () => openVariations("vary")), button("Save", () => saveRecipe()), button("Layouts", () => { openSettings("workspace"); const picker = section.querySelector(".pp-workspace-layout-picker"); if (picker) picker.open = true; }), settingsButton);

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
        const fixed = make("div", "pp-recipe-static", segment.text); fixed.title = "Fixed recipe text; preserved in this position"; fieldsPane.appendChild(fixed); continue;
      }
      const f = lookup.get(segment.id), index = fieldIndex++;
      buildFieldCard(f, index); panes.fields.appendChild(buildFieldOptions(f, index, total));
    }
    const presetHost = make("details", "pp-workspace-layout-picker"); presetHost.appendChild(make("summary", "", "Starter layouts"));
    panes.workspace.append(presetHost,
      settingsGroup("Layout", (() => { const row = make("div", "pp-refine-actions"); row.append(button("Collapse all", () => mutate(r => r.fields.forEach(f => { f.collapsed = true; }))), button("Expand all", () => mutate(r => r.fields.forEach(f => { f.collapsed = false; })))); return row; })()),
      settingsGroup("Joining", settingsRow("Default separator", separatorControl())),
      settingsGroup("Workspace", (() => { const row = make("div", "pp-refine-actions pp-split-global-actions"); row.append(button("Variation Lab", () => openVariations("vary")), button("Save copy", () => saveRecipe(true)), button("Rename workspace", renameRecipe), button("Export", () => exportRecipePack(state.recipe)), button("Reset workspace", () => mutate(r => r.fields.forEach(f => { f.value = f.default; delete f.variationTemplate; })))); return row; })()),
      guide);
    const preview = make("details", "pp-recipe-preview"); preview.open = state.previewOpen !== false;
    preview.appendChild(make("summary", "", "Compiled Prompt"));
    preview.addEventListener("toggle", () => { if (state && preview.isConnected) { state.previewOpen = preview.open; persist(); } });
    for (const channel of ["positive", "negative"]) {
      const text = make("pre"); text.dataset.compiled = channel; text.setAttribute("aria-label", `${channel} prompt`); preview.appendChild(text);
      preview.appendChild(button(`Copy ${channel}`, () => navigator.clipboard.writeText(currentCompilation()[channel])));
    }
    preview.appendChild(button("View in Editor", () => view("editor"))); panes.preview.append(preview, insights);
    appendIterationUI({ section: panes.history, state, button, selectControl, replaceRecipe, persist, getState: () => state, refreshLibrary, getLibrary, sendSnapshot, presetHost });

    const head = make("div", "pp-split-settings-head"), tabBar = make("div", "pp-split-tabbar"); tabBar.setAttribute("role", "tablist"); tabBar.setAttribute("aria-label", "Settings sections");
    const body = make("div", "pp-split-settings-body"), tabButtons = {};
    const showTab = key => {
      state.settingsTab = key;
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
    showTab(["fields", "workspace", "preview", "history"].includes(state.settingsTab) ? state.settingsTab : "fields");
    settingsPane.hidden = !state.settingsOpen; body.scrollTop = settingsScroll;
    settingsPane.addEventListener("keydown", event => { if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); closeSettings(); } });
    section.append(fieldsPane, settingsPane);
    updatePreview();
    if (needsEditorFocus && !state.settingsOpen) {
      const editor = (editors.get(focusedField || activeFieldId) || editors.values().next().value)?.editor;
      if (editor) { editor.focus({ preventScroll: true }); if (fieldSelection && editors.get(focusedField)?.editor === editor) editor.setSelectionRange(...fieldSelection); }
    }
  }
  function restore(snapshot, { commit = true } = {}) {
    cancelInsights(); insightKey = ""; insightResult = null;
    if (snapshot) { const saved = cloneWorkspaceData(snapshot); state = { ...saved, recipe: validateWorkspaceRecipe(saved.recipe) }; }
    else state = null;
    persist(); if (state) sync(); rebuild(); if (commit) render();
  }
  function open(recipe, path = "", values = {}) {
    const migrated = workspaceFromRecipe(validateRecipe(recipe));
    migrated.name ||= path ? path.split("/").at(-1).replace(/[_-]+/g, " ") : "Adjustable recipe";
    migrated.fields.forEach(f => { if (Object.hasOwn(values, f.id)) f.value = values[f.id]; else if (Object.hasOwn(values, f.name)) f.value = values[f.name]; });
    flushHistory(); restore({ recipe: migrated, path, view: "workspace", baseline: JSON.stringify(migrated) }); flushHistory();
  }
  function reconcile() {
    if (!state || syncing) return;
    const compiled = currentCompilation();
    if (textarea.value === compiled.positive) return;
    const selection = { start: textarea.selectionStart, end: textarea.selectionEnd, direction: textarea.selectionDirection };
    state.recipe = captureBranch(editCompiledPrompt(state.recipe, textarea.value));
    sync(); rebuild();
    textarea.setSelectionRange(selection.start, selection.end, selection.direction);
  }
  function refreshPresetOptions() {
    const select = section.querySelector('[aria-label="Field preset"]'); if (!select) return;
    const selected = select.value;
    const paths = getLibrary().map(item => typeof item === "string" ? item : item.path).filter(path => /^RECIPES\/_presets\//i.test(path));
    for (const option of [...select.options]) if (option.value.startsWith("saved:") && !paths.includes(option.value.slice(6))) option.remove();
    for (const path of paths) if (![...select.options].some(option => option.value === `saved:${path}`)) { const option = document.createElement("option"); option.value = `saved:${path}`; option.textContent = path.split("/").at(-1).replace(/[_-]/g, " "); select.appendChild(option); }
    select.value = [...select.options].some(option => option.value === selected) ? selected : "";
  }
  function refresh() {
    const saved = node.properties?.[WORKSPACE_KEY];
    if (JSON.stringify(saved || null) !== JSON.stringify(state)) restore(saved || null, { commit: false });
    else if (state) { insightKey = ""; sync(); refreshPresetOptions(); editors.forEach(e => e.repaint()); }
  }
  const settings = () => { if (state && !getPowerToolPreferences().adjustableRecipes) state.view = "editor"; persist(); rebuild(); };
  const showCompiledForPreview = event => { if (state?.view === "workspace" && event.target.closest('[data-act="resolve"]')) view("editor"); };
  root.addEventListener("click", showCompiledForPreview, true);
  root.addEventListener("pp-output-transform-changed", updatePreview);
  window.addEventListener("pp-power-tools-changed", settings);
  try { if (node.properties?.[WORKSPACE_KEY]) restore(node.properties[WORKSPACE_KEY], { commit: false }); else rebuild(); }
  catch (error) { notify("error", "Workspace could not be restored", error.message); state = null; rebuild(); }
  function experimentPlan(scope) { if (!state) throw new Error("Open a workspace first."); const plan = createExperimentPlan(state.recipe, scope, activeFieldId); plan.runtimeNamespace = String(node.id); return plan; }
  function assertPlan(plan) { if (disposed || !state) throw new Error("The workspace was closed."); applyExperiment(state.recipe, plan, {}); }
  return { open, reconcile, refresh, restore, snapshot: () => state ? cloneWorkspaceData(state) : null,
    isActive: () => !!state, showEditor: () => view("editor"), experimentPlan, assertPlan, contextChanged: () => scheduleInsights(),
    editingSurface: () => state?.view === "workspace" ? (editors.get(activeFieldId) || editors.values().next().value)?.editor : null,
    focusEditingSurface() {
      const editor = state?.view === "workspace" ? (editors.get(activeFieldId) || editors.values().next().value)?.editor : null;
      if (editor) editor.focus({ preventScroll: true });
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
    cleanup() { disposed = true; cancelInsights(); clearEditors(); window.removeEventListener("pp-power-tools-changed", settings); root.removeEventListener("pp-output-transform-changed", updatePreview); root.removeEventListener("click", showCompiledForPreview, true); tabs.remove(); section.remove(); delete node._ppActiveRecipeEditor; } };
}
import { isComfyQueueShortcut } from "../editor_shortcuts.js";
