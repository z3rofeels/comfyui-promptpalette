import { API } from "../prompt_palette_api.js";
import { getPowerToolPreferences } from "../prompt_palette_state.js";
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

export function createRecipeWorkspaceController({ node, root, textarea, render, flushHistory,
  getMatches, onCommit, paintSyntax, getSeed, getMode, getLibrary, refreshLibrary, onUndo, onRedo, host, openHost, bindHover, onLibrarySaved, openVariations, onShowEditor }) {
  const wrap = root.querySelector(".wg-editor-wrap"), editors = new Map(), resizeObservers = [];
  let negativeWidget = node.widgets?.find(w => w.name === "negative_text");
  const negativeState = installNegativePromptState(node);
  let state = null, syncing = false, disposed = false, activeFieldId = null;
  let insightTimer = null, insightPending = null, insightVersion = 0, insightKey = "", insightResult = null;
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
    const wanted = state.insightsOpen || section.querySelector("details.pp-field-resolved[open]");
    if (!wanted) { cancelInsights(); if (!insightResult) insightKey = ""; return; }
    const key = insightContext();
    if (!force && key === insightKey) { if (insightResult) paintInsights(insightResult); return; }
    cancelInsights(); insightKey = key; insightResult = null; paintInsights(null, "Resolving workspace context…");
    const requestId = insightVersion;
    insightTimer = setTimeout(async () => {
      const controller = new AbortController(); insightPending = controller;
      try {
        const recipe = cloneWorkspaceData(state.recipe), seed = getSeed(), mode = getMode(), currentId = activeFieldId;
        const preview = await resolveWorkspacePreview(recipe, seed, mode, API.resolveVariations, { signal: controller.signal });
        const estimate = state.insightsOpen ? await estimateWorkspaceCombinations(recipe, estimateScope, currentId, seed, mode, API, { signal: controller.signal, captured: preview }) : { count: 1, fields: [], notice: "Open Preview & safety to count this scope." };
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
    const result = await resolveWorkspacePreview(snapshot.recipe, seed, mode, API.resolveVariations);
    if (disposed || seed !== getSeed() || mode !== getMode() || !historyOf(state?.recipe || {}).snapshots.some(s => s.id === snapshot.id && JSON.stringify(s) === captured)) throw new Error("The snapshot or seed changed. Send it again.");
    return sendPreparedPrompts({ node, source: compileWorkspace(snapshot.recipe).positive, prompts: [result.positive], negative: result.negative, seed, session: { resolution_seed: seed } });
  }
  const tabs = document.createElement("div"); tabs.className = "pp-recipe-mode pp-refine-actions";
  const section = document.createElement("section"); section.className = "pp-recipe-workspace"; section.hidden = true;
  const notice = document.createElement("span"); notice.className = "pp-refine-label";
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
      flushHistory(); state = { recipe: { ...blankWorkspace(textarea.value), negative: String(negativeWidget?.value || "") }, view: "workspace", path: "", baseline: "" }; sync(); rebuild(); render(); flushHistory();
    } else view("workspace");
  });
  const convert = button("Unlink fields", async () => {
    if (!state || !await dialogConfirm({ title: "Convert Workspace to Plain Prompt", message: "Keep the compiled prompt and unlink its fields, snapshots and variants? Undo restores the workspace." })) return;
    flushHistory(); state = null; persist(); rebuild(); render(); flushHistory();
  });
  convert.dataset.tone = "danger"; convert.title = "Keep the compiled prompt and switch to plain editing";
  tabs.append(editorTab, workspaceTab, notice, convert); wrap.before(tabs); wrap.after(section);
  function persist() { node.properties ||= {}; node.properties[WORKSPACE_KEY] = state ? cloneWorkspaceData(state) : null; node.setDirtyCanvas?.(true, true); }
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
  function clearEditors() { resizeObservers.splice(0).forEach(observer => observer.disconnect()); editors.forEach(e => e.cleanup()); editors.clear(); delete node._ppActiveRecipeEditor; }
  function rememberEditorHeight(element, id) {
    const height = parseFloat(state?.editorHeights?.[id]);
    if (Number.isFinite(height) && height >= 100 && height <= 2400) element.style.height = `${height}px`;
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(() => {
      // A native CSS resize sets an inline height. Do not freeze the automatic
      // font-aware size when the theme, node width or layout changes.
      const height = parseFloat(element.style.height);
      if (!state || !element.isConnected || !Number.isFinite(height) || height < 100 || height > 2400 || state.editorHeights?.[id] === height) return;
      state.editorHeights = { ...state.editorHeights, [id]: height }; persist();
    });
    observer.observe(element); resizeObservers.push(observer);
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
    const [captured] = await resolveExperiment(plan, getSeed(), getMode(), 1, API.resolveVariations);
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
    const preview = await resolveWorkspacePreview(state.recipe, seed, mode, API.resolveVariations);
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
        editors.get(f.id)?.editor.focus();
      } catch (error) { choiceError.textContent = error.message; choiceError.hidden = false; }
    }), button("Cancel choices", () => { setup.hidden = true; }));
    setup.append(label, note, choiceError, actions);
    const setChoices = button("Set choices", () => {
      const current = state.recipe.fields.find(x => x.id === f.id);
      input.value = editableChoiceLines(current); setup.hidden = false; choiceError.hidden = true; input.focus();
    });
    const library = button("Insert wildcard", () => {
      const editor = editors.get(f.id)?.editor; if (!editor) return;
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
    for (const source of state.recipe.fields.filter(x => x.id !== f.id)) {
      const label = document.createElement("label"), check = document.createElement("input"); check.type = "checkbox"; check.checked = f.dependsOn.includes(source.id); check.setAttribute("aria-label", `${f.label} follows ${source.label}`);
      check.addEventListener("change", () => mutate(r => { const target = r.fields.find(x => x.id === f.id); target.dependsOn = target.dependsOn.filter(id => id !== source.id).concat(check.checked ? [source.id] : []); }));
      label.append(check, document.createTextNode(source.label)); dependencies.appendChild(label);
    }
    const hint = document.createElement("small"); hint.textContent = "Example: Lighting follows Pose. Mark Pose Vary and give both fields choices. Lighting joins when the pose changes. Selection edits stay limited to the selected phrase.";
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
    card.querySelector(".pp-recipe-field-head").after(resolved);
    resolved.addEventListener("toggle", () => { if (state && resolved.isConnected) { state.resolvedOpen = [...new Set((state.resolvedOpen || []).filter(id => id !== f.id).concat(resolved.open ? [f.id] : []))]; persist(); scheduleInsights(); } });
  }
  function updatePreview() {
    if (!state) return;
    const result = currentCompilation();
    section.querySelector('[data-compiled="positive"]')?.replaceChildren(document.createTextNode(result.positive || "(empty prompt)"));
    section.querySelector('[data-compiled="negative"]')?.replaceChildren(document.createTextNode(result.negative));
    notice.textContent = `${state.recipe.name || "Adjustable recipe"}${historyOf(state.recipe).activeVariantId ? " / " + historyOf(state.recipe).variants.find(v => v.id === historyOf(state.recipe).activeVariantId)?.name : ""}${JSON.stringify(state.recipe) !== state.baseline ? " • edited" : ""}`;
    for (const f of state.recipe.fields) {
      const card = section.querySelector(`[data-field-id="${CSS.escape(f.id)}"]`); ensureResolvedUI(card, f);
      const guide = card?.querySelector(".pp-field-variation-hint"); if (guide) guide.textContent = fieldVariationHint(f, state.recipe.fields);
      const vary = card?.querySelector("[data-vary-field]"); if (vary) vary.disabled = !f.enabled || !f.value.trim() || f.experimentState === "lock";
      const freeze = card?.querySelector("[data-freeze-field]"); if (freeze) { freeze.hidden = !hasDynamicSyntax(f.value); freeze.disabled = !f.enabled || !f.value.trim(); }
      const restore = card?.querySelector("[data-restore-choices]"); if (restore) restore.hidden = !f.variationTemplate;
      const saved = card?.querySelector(".pp-field-saved-choices"); if (saved) { saved.hidden = !f.variationTemplate; saved.querySelector("pre").textContent = f.variationTemplate || ""; }
      const resetBase = card?.querySelector("[data-reset-base]"); if (resetBase) resetBase.hidden = fieldInheritance(state.recipe, f.id) !== "overridden";
      const header = section.querySelector(`[data-field-id="${CSS.escape(f.id)}"] .pp-recipe-summary`);
      if (header) header.textContent = f.value.trim().replace(/\s+/g, " ") || "Empty field";
      const inheritance = section.querySelector(`[data-inheritance-field="${CSS.escape(f.id)}"]`);
      if (inheritance) { inheritance.textContent = fieldInheritance(state.recipe, f.id) || ""; inheritance.dataset.inheritance = inheritance.textContent; inheritance.hidden = !inheritance.textContent; }
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
    const box = section.querySelector(`[data-field-id="${CSS.escape(f.id)}"] .pp-recipe-review`);
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
  function rebuild() {
    const focused = document.activeElement;
    const focusedField = section.contains(focused) ? focused.closest?.("[data-field-id]")?.dataset.fieldId : null;
    const fieldSelection = focusedField && focused.classList?.contains("wg-textarea") ? [focused.selectionStart, focused.selectionEnd, focused.selectionDirection] : null;
    const needsEditorFocus = focused === textarea || !!focusedField;
    clearEditors(); section.replaceChildren();
    const enabled = getPowerToolPreferences().adjustableRecipes;
    workspaceTab.hidden = !enabled; tabs.hidden = !enabled && !state;
    convert.hidden = !state; setReadOnly(false);
    editorTab.setAttribute("aria-pressed", String(!state || state.view === "editor")); workspaceTab.setAttribute("aria-pressed", String(state?.view === "workspace"));
    wrap.hidden = !!state && state.view === "workspace"; section.hidden = !state || state.view !== "workspace";
    root.classList.toggle("pp-recipe-active", !!state && state.view === "workspace");
    if (!state || state.view !== "workspace") { cancelInsights(); if (!insightResult) insightKey = ""; if (state) updatePreview(); else notice.textContent = ""; return; }
    const toolbar = document.createElement("div"); toolbar.className = "pp-recipe-toolbar pp-refine-actions";
    toolbar.append(button("Collapse all", () => mutate(r => r.fields.forEach(f => { f.collapsed = true; }))), button("Expand all", () => mutate(r => r.fields.forEach(f => { f.collapsed = false; }))), button("+ Field", () => mutate(r => {
      if (r.fields.length >= 32) throw new Error("A workspace supports up to 32 fields.");
      const f = newField(`Section ${r.fields.length + 1}`); r.fields.push(f); r.segments.push({ type: "field", id: f.id, join: true });
    })), separatorControl(), button("Variation Lab", () => openVariations("vary")), button("Save", () => saveRecipe()));
    const more = document.createElement("details"); more.className = "pp-recipe-more";
    const moreTitle = document.createElement("summary"); moreTitle.textContent = "More"; more.appendChild(moreTitle);
    const moreActions = document.createElement("div"); moreActions.className = "pp-refine-actions";
    moreActions.append(button("Save copy", () => saveRecipe(true)), button("Rename", renameRecipe), button("Export", () => exportRecipePack(state.recipe)), button("Reset workspace", () => mutate(r => r.fields.forEach(f => { f.value = f.default; delete f.variationTemplate; }))));
    more.appendChild(moreActions); toolbar.appendChild(more);
    section.appendChild(toolbar);
    const guide = document.createElement("details"); guide.className = "pp-workspace-guide"; guide.open = !!state.guideOpen;
    const guideTitle = document.createElement("summary"); guideTitle.textContent = "How to vary: set choices → choose Vary / Lock → preview → apply";
    const guideText = document.createElement("p"); guideText.textContent = "A field is one editable part of the final prompt; its name is a label. Vary samples the alternatives you supply. Plain text is a single value. Set choices (standing, sitting, running on separate lines) or Insert wildcard to supply alternatives. Vary selects fields to explore; Lock holds their resolved values in this exploration. Freeze current value also keeps a literal choice across generation seeds. Apply edits only targeted fields and keeps their choices available for another preview. Use Combinatorial for the exact captured full versions.";
    guide.append(guideTitle, guideText); guide.addEventListener("toggle", () => { if (state && guide.isConnected) { state.guideOpen = guide.open; persist(); } }); section.appendChild(guide);
    const insights = document.createElement("details"); insights.className = "pp-recipe-insights"; insights.open = !!state.insightsOpen;
    const insightsTitle = document.createElement("summary"); insightsTitle.textContent = "Preview & safety"; insights.appendChild(insightsTitle);
    insights.addEventListener("toggle", () => { if (state && insights.isConnected) { state.insightsOpen = insights.open; persist(); scheduleInsights(true); } });
    const insightActions = document.createElement("div"); insightActions.className = "pp-refine-actions";
    insightActions.append(selectControl("Combination count scope", [["vary", "Vary Fields"], ["current", "Current Field"], ["unlocked", "All Unlocked Fields"], ["workspace", "Entire Workspace"]], estimateScope, value => { estimateScope = value; scheduleInsights(true); }), button("Refresh previews", () => scheduleInsights(true)));
    const countStatus = document.createElement("div"); countStatus.className = "pp-combination-status"; countStatus.setAttribute("role", "status"); countStatus.setAttribute("aria-live", "polite");
    const countFields = document.createElement("pre"); countFields.className = "pp-combination-fields";
    const doctorBox = document.createElement("div"); doctorBox.className = "pp-workspace-doctor"; doctorBox.hidden = true;
    if (getPowerToolPreferences().promptDoctor) insightActions.appendChild(button("Review workspace", () => {
      const analysis = analyzeWorkspace(state.recipe, { libraryEntries: getLibrary(), compiledPreview: { positive: textarea.value, negative: String(negativeWidget?.value || "") } });
      doctorBox.hidden = false; doctorBox.textContent = analysis.issues.length ? analysis.issues.map(i => `${i.title}: ${i.detail}`).join("\n\n") : "Prompt Doctor: no obvious issues.";
    }));
    const insightNote = document.createElement("p"); insightNote.className = "pp-refine-note"; insightNote.textContent = "Read-only previews and estimates. Use Variation Lab to sample actual choices, compare them and apply a version.";
    insights.append(insightNote, insightActions, countStatus, countFields, doctorBox);
    const lookup = new Map(state.recipe.fields.map(f => [f.id, f])); let fieldIndex = 0;
    for (const segment of state.recipe.segments) {
      if (segment.type === "static") {
        if (!segment.text.trim() || segment.boundary) continue;
        const fixed = document.createElement("div"); fixed.className = "pp-recipe-static"; fixed.textContent = segment.text; fixed.title = "Fixed recipe text; preserved in this position"; section.appendChild(fixed); continue;
      }
      const f = lookup.get(segment.id), index = fieldIndex++;
      const card = document.createElement("article"); card.className = "pp-recipe-field"; card.dataset.fieldId = f.id;
      card.classList.toggle("is-disabled", !f.enabled); card.classList.toggle("is-empty", !f.value.trim());
      const head = document.createElement("div"); head.className = "pp-recipe-field-head";
      const collapse = button(`${f.collapsed ? "▸" : "▾"} ${f.label}`, () => mutate(r => { r.fields.find(x => x.id === f.id).collapsed = !f.collapsed; })); collapse.classList.add("pp-recipe-field-label"); collapse.setAttribute("aria-expanded", String(!f.collapsed));
      const summary = document.createElement("span"); summary.className = "pp-recipe-summary";
      const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.checked = f.enabled; checkbox.title = `Enable ${f.label}`; checkbox.setAttribute("aria-label", checkbox.title); checkbox.addEventListener("change", () => mutate(r => { r.fields.find(x => x.id === f.id).enabled = checkbox.checked; }));
      const up = button("↑", () => mutate(r => reorderField(r, f.id, -1)), "Move field up"); up.disabled = index === 0;
      const down = button("↓", () => mutate(r => reorderField(r, f.id, 1)), "Move field down"); down.disabled = index === state.recipe.fields.length - 1;
      const experiment = selectControl(`Experiment state for ${f.label}`, [["", "Default"], ["lock", "Lock"], ["vary", "Vary"], ["follow", "Follow"]], f.experimentState || "", value => mutate(r => { r.fields.find(x => x.id === f.id).experimentState = value || null; }));
      experiment.classList.add("pp-recipe-experiment");
      experiment.title = "Default: included in broad scopes. Lock: hold in this exploration. Vary: explore explicitly. Follow: explore when a chosen source changes. Freeze current value pins a choice across generation seeds.";
      card.dataset.experimentState = f.experimentState || "";
      const inherited = document.createElement("span"); inherited.className = "pp-field-inheritance"; inherited.dataset.inheritanceField = f.id;
      inherited.textContent = fieldInheritance(state.recipe, f.id) || ""; inherited.hidden = !inherited.textContent;
      head.append(collapse, summary, inherited, experiment, checkbox, up, down); card.appendChild(head);
      ensureResolvedUI(card, f);
      if (!f.collapsed) {
        sourceControls(card, f);
        if (f.experimentState === "follow") followControls(card, f);
        const editorBar = document.createElement("div"); editorBar.className = "pp-recipe-editor-bar";
        const channel = document.createElement("span"); channel.className = "pp-recipe-channel"; channel.dataset.channel = f.channel; channel.textContent = f.channel === "negative" ? "Negative prompt" : "Positive prompt";
        const hint = document.createElement("span"); hint.className = "pp-recipe-editor-hint"; hint.textContent = "Text, tags or __wildcards__ · drag corner to resize";
        const expanded = !!state.expandedEditors?.includes(f.id);
        const expand = button(expanded ? "Compact editor" : "Expand editor", () => {
          state.expandedEditors = (state.expandedEditors || []).filter(id => id !== f.id).concat(expanded ? [] : [f.id]);
          if (state.editorHeights) delete state.editorHeights[f.id];
          persist(); rebuild(); editors.get(f.id)?.editor.focus();
        }); expand.setAttribute("aria-pressed", String(expanded));
        editorBar.append(channel, hint, expand); card.appendChild(editorBar);
        const editWrap = document.createElement("div"); editWrap.className = "pp-recipe-editor wg-editor-real";
        editWrap.classList.toggle("is-expanded", expanded);
        const overlay = document.createElement("div"); overlay.className = "wg-editor-layer wg-highlight";
        const input = document.createElement("textarea"); input.className = "wg-editor-layer wg-textarea"; input.value = f.value; input.spellcheck = false; input.title = f.help || f.placeholder || f.label; input.placeholder = f.placeholder || "Enter tags, text or __wildcards__"; input.setAttribute("aria-label", f.label);
        editWrap.append(overlay, input); card.appendChild(editWrap); section.appendChild(card);
        rememberEditorHeight(editWrap, f.id);
        const tools = attachRecipeFieldEditor({ node, root: card, input, overlay, paintSyntax, getMatches, onCommit,
          getSeed, getMode, getLibrary, onUndo, onRedo, host, openHost, bindHover, onLibrarySaved,
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
        const actions = document.createElement("details"); actions.className = "pp-recipe-field-tools";
        const more = document.createElement("summary"); more.textContent = "Field actions"; actions.appendChild(more);
        const actionsRow = document.createElement("div"); actionsRow.className = "pp-refine-actions";
        actionsRow.append(button("Rename", async () => { const label = await dialogPrompt({ title: "Rename field", message: "Display name", defaultValue: f.label }); if (label?.trim()) mutate(r => { r.fields.find(x => x.id === f.id).label = label.trim(); }); }), button("Duplicate", () => mutate(r => {
          if (r.fields.length >= 32) throw new Error("A workspace supports up to 32 fields.");
          const copy = { ...cloneWorkspaceData(r.fields.find(x => x.id === f.id)), id: fieldId(), label: `${f.label} copy` }; r.fields.push(copy); const i = r.segments.findIndex(s => s.id === f.id); r.segments.splice(i + 1, 0, { type: "field", id: copy.id, join: true });
        })), button("Reset to Default", () => mutate(r => { const field = r.fields.find(x => x.id === f.id); field.value = field.default; delete field.variationTemplate; })), button("Remove", () => mutate(r => { r.fields = r.fields.filter(x => x.id !== f.id); r.segments = r.segments.filter(s => s.id !== f.id); r.fields.forEach(x => { x.dependsOn = x.dependsOn.filter(id => id !== f.id); }); })), separatorControl(f), selectControl("Prompt channel", [["positive", "Positive"], ["negative", "Negative"]], f.channel, value => mutate(r => { r.fields.find(x => x.id === f.id).channel = value; })), button("Syntax", tools.syntax));
        actionsRow.append(selectControl(`Field type for ${f.label}`, [["text", "Unspecified"], ["character", "Character"], ["outfit", "Outfit"], ["pose", "Pose"], ["lighting", "Lighting"], ["environment", "Environment"], ["camera", "Camera"], ["composition", "Composition"], ["style", "Style"], ["negative", "Negative"], ["custom", "Custom"], ...(!["text", "character", "outfit", "pose", "lighting", "environment", "camera", "composition", "style", "negative", "custom"].includes(f.fieldType || "text") ? [[f.fieldType, f.fieldType]] : [])], f.fieldType || "text", value => mutate(r => { r.fields.find(x => x.id === f.id).fieldType = value; })));
        if (historyOf(state.recipe).activeVariantId && historyOf(state.recipe).base?.fields.some(x => x.id === f.id)) { const reset = button("Reset to base", () => replaceRecipe(resetInheritedField(state.recipe, f.id))); reset.dataset.resetBase = f.id; reset.hidden = fieldInheritance(state.recipe, f.id) !== "overridden"; actionsRow.append(reset); }
        if (getPowerToolPreferences().promptDoctor) actionsRow.append(button("Review field", () => review(f)));
        actions.appendChild(actionsRow); card.appendChild(actions);
        const reviewBox = document.createElement("div"); reviewBox.className = "pp-recipe-review"; reviewBox.hidden = true; card.appendChild(reviewBox);
      } else section.appendChild(card);
    }
    const preview = document.createElement("details"); preview.className = "pp-recipe-preview"; preview.open = !!state.previewOpen;
    const summary = document.createElement("summary"); summary.textContent = "Compiled Prompt"; preview.appendChild(summary);
    preview.addEventListener("toggle", () => { if (state && preview.isConnected) { state.previewOpen = preview.open; persist(); } });
    for (const channel of ["positive", "negative"]) {
      const text = document.createElement("pre"); text.dataset.compiled = channel; text.setAttribute("aria-label", `${channel} prompt`); preview.appendChild(text);
      preview.appendChild(button(`Copy ${channel}`, () => navigator.clipboard.writeText(currentCompilation()[channel])));
    }
    preview.appendChild(button("View in Editor", () => view("editor"))); section.append(preview, insights);
    appendIterationUI({ section, state, button, selectControl, replaceRecipe, persist, getState: () => state, refreshLibrary, getLibrary, sendSnapshot });
    updatePreview();
    if (needsEditorFocus) {
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
  window.addEventListener("pp-power-tools-changed", settings);
  try { if (node.properties?.[WORKSPACE_KEY]) restore(node.properties[WORKSPACE_KEY], { commit: false }); else rebuild(); }
  catch (error) { notify("error", "Workspace could not be restored", error.message); state = null; rebuild(); }
  function experimentPlan(scope) { if (!state) throw new Error("Open a workspace first."); return createExperimentPlan(state.recipe, scope, activeFieldId); }
  function assertPlan(plan) { if (disposed || !state) throw new Error("The workspace was closed."); applyExperiment(state.recipe, plan, {}); }
  return { open, reconcile, refresh, restore, snapshot: () => state ? cloneWorkspaceData(state) : null,
    isActive: () => !!state, showEditor: () => view("editor"), experimentPlan, assertPlan, contextChanged: () => scheduleInsights(),
    focusEditingSurface() {
      const editor = state?.view === "workspace" ? (editors.get(activeFieldId) || editors.values().next().value)?.editor : null;
      if (editor) editor.focus({ preventScroll: true });
      else { if (state) view("editor"); textarea.focus({ preventScroll: true }); }
    },
    analyze: () => state ? analyzeWorkspace(state.recipe, { libraryEntries: getLibrary(), compiledPreview: { positive: textarea.value, negative: String(negativeWidget?.value || "") } }) : null,
    focusField(id, token = null) { if (!state?.recipe.fields.some(f => f.id === id)) return; state.view = "workspace"; state.recipe.fields.find(f => f.id === id).collapsed = false; persist(); rebuild(); activeFieldId = id; const input = editors.get(id)?.editor; input?.focus(); if (token && input) input.setSelectionRange(token.start, token.end); },
    configureChoices(id) { this.focusField(id); const card = section.querySelector(`[data-field-id="${CSS.escape(id)}"]`); const action = [...(card?.querySelectorAll("button") || [])].find(b => b.textContent === "Set choices"); action?.click(); },
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
      if (!items.length || items.some(item => item.negative !== items[0].negative)) throw new Error("The existing batch format uses one shared negative prompt. Use a positive-field scope or apply a version with its negative changes first.");
      if (node.inputs?.some(input => input.name === "negative_text" && input.link != null)) throw new Error("Copy the resolved prompts or use the workspace version: a connected negative input cannot be captured into a new batch.");
      return sendPreparedPrompts({ node, source: plan.compiled.positive, prompts: items.map(item => item.resolved), negative: items[0].negative, seed,
        session: { resolution_seed: seed, wildcards: [...new Set(items.flatMap(item => item.wildcards))] } });
    },
    cleanup() { disposed = true; cancelInsights(); clearEditors(); window.removeEventListener("pp-power-tools-changed", settings); root.removeEventListener("click", showCompiledForPreview, true); tabs.remove(); section.remove(); delete node._ppActiveRecipeEditor; } };
}
