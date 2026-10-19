import { observeEditorSelection } from "./editor_selection.js";
import { exportRecipePack } from "./recipe_io.js";
import { sendPreparedPrompts } from "./prepared_handoff.js";
import { getPowerToolPreferences } from "../prompt_palette_state.js";
import { API } from "../prompt_palette_api.js";
import { attachAutocomplete, getBooruAutocompleteMatches, closeAcMenu, acState } from "./autocomplete.js";
import { app } from "../../../scripts/app.js";
import { locateWeightTarget, applyWeightDelta } from "./weight_edit.js";
import { libraryAcRows, rankLibraryPaths } from "./autocomplete_sources.js";
import { loadTheme, loadPinned, savePinned } from "./preferences.js";
import { categoryForTagKey, normalizeTagKey } from "./booru_tag_colors.js";
import { createPromptUsageStore } from "../prompt_quickness.js";
import { dialogPrompt, dialogConfirm } from "./dialogs.js";
import { pickJsonFile } from "../prompt_palette_shared.js";
import { scheduleDomWidgetRemeasure, hideNativeWidget } from "../prompt_palette_compat.js";
import { replaceRange, makeAlternatives, validateRecipe, fillRecipe, serializeRecipe, parseRecipe, recipeDependencies, preparedBatch, RECIPE_SCHEMA, preciseReplacement, installPreparedBatchState } from "./prompt_refinement.js";

const RECIPE_PATH = /^(?:recipes?|RECIPES)\//i;
const LIBRARY_PATH = /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/;
const PERSIST_KEY = "prompt_palette_refinement_v1";

export function createRefinementController({ node, root, textarea, render, atomicEdit = null,
  getSeed = () => 0, getMode = () => "entire text as one", getLibrary = () => [],
  refreshLibrary = async () => {}, host = null, openHost = null, preparedWidget = null,
  fieldOnly = false, onOpenWorkspace = null, mapBatchPrompt = null, getBatchSource = null, allowBatch = true,
  variationGuard = null, prepareBatchPrompts = null }) {
  const preparedState = installPreparedBatchState(node, preparedWidget);
  const cleanups = []; let disposed = false, version = 0, pending = null;
  let selection = null, session = null, recipeDraft = null, filling = null;
  let panelKind = "", selectionToolsEnabled = getPowerToolPreferences().selectionTools !== false, recipesEnabled = (!fieldOnly && getPowerToolPreferences().adjustableRecipes);
  let alternatives = "", candidates = [], excluded = new Set(), fieldValues = {};
  const saved = fieldOnly ? null : node.properties?.[PERSIST_KEY];
  try { if (saved?.recipeDraft) recipeDraft = validateRecipe(saved.recipeDraft); } catch { /* invalid legacy draft */ }
  if (saved?.session && ["source", "prefix", "selected", "suffix"].every(key => typeof saved.session[key] === "string") && saved.session.source.length <= 1_000_000) {
    session = saved.session; alternatives = typeof saved.alternatives === "string" ? saved.alternatives.slice(0, 1_000_000) : "";
  }
  const bar = document.createElement("div"); bar.className = "pp-refine-bar"; bar.setAttribute("aria-label", "Selection actions");
  const selectionActions = document.createElement("div"); selectionActions.className = "pp-refine-actions";
  const label = document.createElement("span"); label.className = "pp-refine-label"; label.textContent = "Selection";
  selectionActions.appendChild(label); bar.appendChild(selectionActions);
  const savedActions = document.createElement("div"); savedActions.className = "pp-refine-saved"; bar.appendChild(savedActions);
  (root.querySelector(".wg-editor-wrap") || textarea.parentElement)?.insertAdjacentElement("afterend", bar);
  let ownHost = false;
  if (!host) {
    ownHost = true; host = document.createElement("section"); host.className = "wg-drawer right wg-settings-popup wg-power-popup pp-refine-drawer";
    host.hidden = true; host.setAttribute("aria-label", "Variation Lab"); host.setAttribute("aria-hidden", "true"); host.setAttribute("inert", "");
    const head = document.createElement("div"); head.className = "wg-settings-head"; head.appendChild(document.createTextNode("Variation Lab"));
    const close = makeButton("×", () => closeHost()); close.setAttribute("aria-label", "Close Variation Lab"); head.appendChild(close);
    host.appendChild(head); root.appendChild(host);
  }
  const panel = document.createElement("section"); panel.className = "pp-refine-panel"; panel.hidden = true;
  if (ownHost) { const body = document.createElement("div"); body.className = "wg-settings-body"; body.appendChild(panel); host.appendChild(body); }
  else host.prepend(panel);
  const status = document.createElement("div"); status.className = "wg-status pp-refine-status"; status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
  let inputCleanups = [];
  let variationContext = null;
  function checkVariation() { variationGuard?.(variationContext); }

  function persist() {
    if (fieldOnly) return;
    node.properties ||= {};
    node.properties[PERSIST_KEY] = { session, alternatives, recipeDraft };
    node.setDirtyCanvas?.(true, true);
  }
  function message(text, error = false) { status.textContent = text; status.classList.toggle("err", error); }
  function makeButton(text, action, title = text) {
    const b = document.createElement("button"); b.type = "button"; b.className = "wg-button"; b.textContent = text; b.title = title;
    if (text === "Send to Combinatorial" && !allowBatch) b.hidden = true;
    b.addEventListener("mousedown", event => event.preventDefault());
    b.addEventListener("click", () => { Promise.resolve().then(action).catch(error => { if (disposed || error?.name === "AbortError") return; if (!panel.contains(status)) panel.appendChild(status); showHost(); message(error?.message || "Could not complete this action.", true); }); });
    return b;
  }
  function listen(target, type, fn) { target.addEventListener(type, fn); cleanups.push(() => target.removeEventListener(type, fn)); }
  function showHost() {
    host.dispatchEvent(new CustomEvent("pp-refinement-owner", { detail: panel }));
    closeAcMenu(); panel.hidden = false;
    if (!ownHost) host.classList.add("pp-refine-active");
    if (openHost) openHost();
    else { host.hidden = false; host.removeAttribute("inert"); host.setAttribute("aria-hidden", "false"); host.classList.add("open"); }
    scheduleDomWidgetRemeasure(node);
  }
  function closeHost() {
    version++; pending?.abort(); panel.hidden = true; host.classList.remove("pp-refine-active");
    if (!ownHost) host.closest('[data-el="variationPopup"]')?.querySelector('[data-act="closeVariations"]')?.click();
    if (ownHost) { host.classList.remove("open"); host.hidden = true; host.setAttribute("inert", ""); host.setAttribute("aria-hidden", "true"); }
    scheduleDomWidgetRemeasure(node);
  }
  function resetPanel(title, detail) {
    inputCleanups.forEach(fn => fn()); inputCleanups = [];
    panelKind = "other";
    panel.replaceChildren();
    const heading = document.createElement("h3"); heading.textContent = title;
    const note = document.createElement("p"); note.className = "pp-refine-note"; note.textContent = detail;
    panel.append(heading, note, status); message(""); showHost();
  }
  function row(...elements) { const r = document.createElement("div"); r.className = "pp-refine-actions"; r.append(...elements); return r; }
  function field(title, value = "", multiline = false) {
    const l = document.createElement("label"); l.className = "pp-refine-field";
    const caption = document.createElement("span"); caption.textContent = title;
    const input = document.createElement(multiline ? "textarea" : "input");
    input.className = "wg-theme-select"; input.value = value;
    if (!multiline) input.type = "text"; else input.rows = 3;
    input.setAttribute("aria-label", title); input.spellcheck = true; l.append(caption, input); return { label: l, input };
  }
  function preview(title, text) {
    const box = document.createElement("div"); box.className = "pp-refine-preview";
    const heading = document.createElement("strong"); heading.textContent = title;
    const pre = document.createElement("div"); pre.className = "pp-refine-text"; pre.textContent = text; box.append(heading, pre); panel.appendChild(box); return pre;
  }
  async function matches(query, kind = "booru") {
    const paths = getLibrary().map(item => typeof item === "string" ? item : item.path).filter(Boolean);
    const lib = libraryAcRows(query, { rankedPaths: rankLibraryPaths(paths, query, 16), pinned: loadPinned(), theme: loadTheme() });
    return kind === "wildcard" ? lib : [...await getBooruAutocompleteMatches(query), ...lib];
  }
  function autocomplete(input, onChange = () => {}) {
    inputCleanups.push(attachAutocomplete(input, { getMatches: matches, onInput: onChange, onCommit: onChange, syntax: true }));
  }
  function currentSelection() {
    if (!selection || textarea.value !== selection.source || selection.start === selection.end) throw new Error("Select a phrase or a complete wildcard in the editor first.");
    return { ...selection };
  }
  function apply(text, start = text.length, end = start) {
    if (atomicEdit) atomicEdit(text, start, end);
    else {
      textarea.value = text; textarea.setSelectionRange(start, end); render();
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    }
    textarea.focus({ preventScroll: true }); updateBar();
  }
  function guard(source) { if (textarea.value !== source) throw new Error("The prompt changed. Select it again to keep your edits safe."); }
  function updateSelection() {
    if (document.activeElement !== textarea) { selection = null; updateBar(); return; }
    const start = textarea.selectionStart, end = textarea.selectionEnd;
    if (end > start) selection = { source: textarea.value, start, end };
    else selection = null;
    updateBar();
  }
  function updateBar() {
    const valid = selection && selection.source === textarea.value && selection.end > selection.start;
    // The switch only hides the selection actions; Explore, Recipe draft and prepared-batch controls stay available.
    selectionActions.hidden = !selectionToolsEnabled || !valid;
    bar.hidden = selectionActions.hidden && !session && !(recipesEnabled && recipeDraft) && !preparedWidget?.value;
    savedActions.replaceChildren();
    if (recipesEnabled && recipeDraft) savedActions.appendChild(makeButton("Recipe draft", showRecipeBuilder));
    if (session) savedActions.appendChild(makeButton("Explore", () => showExploration()));
    if (preparedWidget?.value) {
      let count = "", batch;
      try { batch = JSON.parse(preparedWidget.value); count = batch.prompts.length; } catch { count = "invalid"; }
      const tag = document.createElement("span"); tag.className = "pp-refine-label";
      const fixed = node.widgets?.find(w => w.name === "seed_mode")?.value === "fixed";
      tag.textContent = batch?.comparison === "one-field" ? `${count} controlled trials · ${fixed ? "Fixed seed mode" : "Choose Fixed seed mode for equal seeds"}` : `${count} prepared variations`;
      if (batch?.negative_prompts && new Set(batch.negative_prompts).size > 1) tag.textContent += " · paired negatives";
      tag.title = "Wire Seed list to the sampler for equal noise seeds. Use the matching negative list output when negatives vary. Existing single-value negative outputs return the first item.";
      savedActions.append(tag, makeButton("Clear batch", () => { preparedState.commit(""); node.setDirtyCanvas?.(true, true); updateBar(); render(); }));
    }
  }
  function onSourceChanged() {
    if (selection?.source !== textarea.value) selection = null;
    if (preparedWidget?.value) {
      try { if (JSON.parse(preparedWidget.value).source !== textarea.value) preparedState.commit(""); } catch { preparedState.commit(""); }
    }
    if (session && !recipeDraft && !filling && textarea.value !== session.source && textarea.value !== session.resolved && !panel.hidden) message("Prompt changed. Recapture a selection before applying these variations.", true);
    updateBar();
  }
  function openReplace() {
    filling = null;
    const selected = currentSelection(); resetPanel("Replace selection", "Replace only the selected text. Existing weight and surrounding punctuation are preserved.");
    const original = selected.source.slice(selected.start, selected.end);
    const replacement = field("Replacement", original); panel.appendChild(replacement.label);
    const out = preview("Result", selected.source);
    const update = () => { out.textContent = replaceRange(selected.source, selected.start, selected.end, replacement.input.value).text; };
    replacement.input.addEventListener("input", update); autocomplete(replacement.input, update);
    panel.appendChild(row(makeButton("Apply replacement", () => { guard(selected.source); const next = replaceRange(selected.source, selected.start, selected.end, replacement.input.value); apply(next.text, next.start, next.end); closeHost(); })));
    replacement.input.focus(); replacement.input.select();
  }
  // ComfyUI's "Ctrl+up/down precision" setting; the same step drives the keyboard and the panel buttons.
  function weightStep() {
    try {
      const value = Number(app?.extensionManager?.setting?.get?.("Comfy.EditAttention.Delta") ?? app?.ui?.settings?.getSettingValue?.("Comfy.EditAttention.Delta"));
      if (Number.isFinite(value) && value >= 0.01 && value <= 0.5) return Math.round(value * 100) / 100;
    } catch { /* setting unavailable: use ComfyUI's default */ }
    return 0.05;
  }
  function changeWeight(range, direction) {
    const next = applyWeightDelta(textarea.value, range, direction * weightStep());
    apply(next.text, next.start, next.end);
  }
  function adjustWeight(direction) {
    const selected = currentSelection();
    changeWeight(locateWeightTarget(selected.source, selected.start, selected.end) || selected, direction);
  }
  function removeWeight() {
    const selected = currentSelection(), text = selected.source.slice(selected.start, selected.end);
    const m = text.match(/^\((.*):[+-]?(?:\d+(?:\.\d*)?|\.\d+)\)$/);
    if (!m) return;
    const next = replaceRange(selected.source, selected.start, selected.end, m[1], false); apply(next.text, next.start, next.end);
  }
  async function capture() {
    variationContext = variationGuard?.() ?? null;
    filling = null;
    const selected = currentSelection(), request = ++version;
    pending?.abort(); pending = new AbortController();
    resetPanel("Vary this selection", "Capture the current choices, then change only the selected part."); message("Capturing resolved choices…");
    const captured = await API.captureSelection(selected.source, selected.start, selected.end, getSeed(), getMode(), { signal: pending.signal });
    if (disposed || request !== version) return;
    checkVariation(); guard(selected.source); session = { ...captured, start: selected.start, end: selected.end };
    alternatives = captured.selected; candidates = []; excluded = new Set(); persist(); showExploration(); updateBar();
    const token = selected.source.slice(selected.start, selected.end).match(/^__[+\-*%~@]?([A-Za-z0-9_\-\/]+)__$/);
    if (token) { const options = await API.alternatives(token[1]); if (!disposed && request === version && session.source === textarea.value && Array.isArray(options.lines)) { if (options.truncated) { message(`This list has ${options.total} choices. Use a smaller list or enter up to 256 alternatives.`, true); return; } alternatives = options.lines.join("\n"); persist(); showExploration(); } }
  }
  function sessionCurrent() { return session && textarea.value === session.source; }
  function showExploration() {
    if (!session) return;
    candidates = []; excluded.clear();
    resetPanel("Keep the rest. Vary this.", "Everything outside the selected part is captured text. Previewing alternatives does not generate images.");
    const original = preview("Selected result", session.selected);
    original.classList.add("pp-refine-selected");
    preview("Kept before", session.prefix || "—"); preview("Kept after", session.suffix || "—");
    const choices = field("Alternatives · one per line", alternatives, true); panel.appendChild(choices.label);
    const library = field("Use a wildcard list", ""); library.input.placeholder = "category/list"; panel.appendChild(library.label);
    panel.appendChild(row(makeButton("Load alternatives", async () => {
      const request = ++version, path = library.input.value.trim().replace(/^__[+\-*%~@]?|__$/g, "");
      const response = await API.alternatives(path); if (disposed || request !== version) return;
      if (!Array.isArray(response.lines) || !response.lines.length) throw new Error("That library list has no alternatives.");
      if (response.truncated || response.lines.length > 256) throw new Error("This list has more than 256 choices. Select a smaller list for this exploration.");
      alternatives = response.lines.join("\n"); choices.input.value = alternatives; persist();
    })));
    choices.input.addEventListener("input", () => { version++; alternatives = choices.input.value; candidates = []; excluded.clear(); persist(); results.replaceChildren(); });
    const results = document.createElement("div"); results.className = "wg-variation-grid pp-refine-results";
    async function build() {
      checkVariation();
      if (!sessionCurrent()) throw new Error("The prompt changed. Restore the template or capture your new selection.");
      const request = ++version, captured = session;
      alternatives = choices.input.value; const rawCandidates = makeAlternatives(captured, alternatives);
      message("Resolving selected alternatives; kept text stays fixed…");
      const resolved = [];
      for (let index = 0; index < rawCandidates.length; index++) {
        const result = await API.resolve(rawCandidates[index].value, (Number(captured.resolution_seed) + index) % 18446744073709551616, "entire text as one");
        if (disposed || request !== version) return;
        checkVariation();
        if (!sessionCurrent() || choices.input.value !== alternatives) throw new Error("The prompt or alternatives changed. Preview them again.");
        if (/__[+\-*%~@]?[A-Za-z0-9_\-/]+(?:\([^\n]*?\))?__/.test(result.resolved)) throw new Error("An alternative contains a missing wildcard list.");
        const value = preciseReplacement(captured.selected, result.resolved);
        if (!resolved.some(item => item.value === value)) resolved.push({ value, prompt: captured.prefix + value + captured.suffix });
      }
      candidates = resolved; persist();
      if (!candidates.length) throw new Error("Add at least one alternative.");
      results.replaceChildren(); excluded.clear();
      candidates.forEach((candidate, index) => {
        const card = document.createElement("article"); card.className = "wg-variation-card";
        const label = document.createElement("strong"); label.textContent = `${index + 1} · ${candidate.value}`;
        const text = document.createElement("div"); text.className = "wg-variation-text"; text.textContent = candidate.prompt;
        const skip = makeButton("Skip", () => { if (excluded.has(index)) excluded.delete(index); else excluded.add(index); skip.textContent = excluded.has(index) ? "Include" : "Skip"; card.classList.toggle("pp-refine-skipped", excluded.has(index)); updateCount(); });
        card.append(label, text, row(makeButton("Use version", () => { checkVariation(); if (!sessionCurrent()) throw new Error("The prompt changed. Capture your new selection."); apply(candidate.prompt); variationContext = variationGuard?.() ?? null; message("Captured version applied. Restore template returns to your original wildcards."); }), makeButton("Copy", () => navigator.clipboard.writeText(candidate.prompt)), skip)); results.appendChild(card);
      }); updateCount();
    }
    function updateCount() { message(`${candidates.length - excluded.size} prepared prompt${candidates.length - excluded.size === 1 ? "" : "s"} · resolution seed ${session.resolution_seed}. Sampler seeds remain controlled by the workflow.`); }
    panel.appendChild(row(makeButton("Preview alternatives", build), makeButton("Keep selected result", () => {
      checkVariation();
      if (!sessionCurrent()) throw new Error("The prompt changed. Capture your new selection.");
      const next = replaceRange(session.source, session.start, session.end, session.selected, false); apply(next.text, next.start, next.end); closeHost();
    }), makeButton("Restore template", async () => {
      checkVariation();
      if (textarea.value !== session.source && textarea.value !== session.resolved && !candidates.some(c => c.prompt === textarea.value)) {
        if (!await dialogConfirm({ title: "Restore captured template", message: "This replaces your current edits with the captured source prompt. You can undo the replacement." })) return;
      }
      checkVariation(); apply(session.source, session.start, session.end); variationContext = variationGuard?.() ?? null; showExploration();
    }), makeButton(preparedWidget ? "Prepare this batch" : "Send to Combinatorial", async () => {
      checkVariation();
      if (!sessionCurrent()) throw new Error("Restore the template or capture the edited prompt before preparing a batch.");
      if (!candidates.length) await build();
      if (!candidates.length || !sessionCurrent()) return;
      const prompts = candidates.filter((_, index) => !excluded.has(index)).map(c => c.prompt);
      if (!prompts.length) throw new Error("Include at least one version.");
      if (preparedWidget) {
        if (node.inputs?.some(input => input.name === "text" && input.link != null)) throw new Error("Disconnect the connected Prompt input before preparing captured variations.");
        apply(session.source); preparedState.commit(preparedBatch(session.source, prompts, session)); updateBar(); render(); message(`${prompts.length} exact versions prepared. Editing the prompt clears the batch.`); }
      else await sendBatch(prompts);
    })));
    panel.appendChild(row(makeButton("Clear exploration", () => { session = null; alternatives = ""; candidates = []; persist(); closeHost(); updateBar(); })));
    panel.appendChild(results);
    if (!sessionCurrent()) message("Source changed. Restore the template or capture a new selection.", true);
  }
  async function sendBatch(prompts) {
    checkVariation();
    const prepared = prepareBatchPrompts ? await prepareBatchPrompts(prompts, variationContext) : {
      source: getBatchSource ? getBatchSource() : session.source, prompts: mapBatchPrompt ? prompts.map(mapBatchPrompt) : prompts };
    if (disposed) return;
    checkVariation();
    const target = sendPreparedPrompts({ node, ...prepared, seed: getSeed(), session });
    target.properties ||= {}; if (!fieldOnly) target.properties[PERSIST_KEY] = { session, alternatives };
    message(`${prompts.length} exact versions sent to a new Combinatorial node. Connect its Prompt list or conditioning output; nothing was queued.`);
  }
  async function addRecipeField() {
    if (!recipesEnabled) return;
    const selected = currentSelection();
    if (!recipeDraft || recipeDraft.source !== selected.source) recipeDraft = { schema: RECIPE_SCHEMA, source: selected.source, fields: [], negative: "" };
    const draft = recipeDraft;
    const name = await dialogPrompt({ title: "Adjustable recipe field", message: "Name this selected part (for example: subject, outfit, lighting).", defaultValue: `field_${draft.fields.length + 1}` });
    if (name == null || disposed || !recipesEnabled) return; guard(selected.source);
    const next = validateRecipe({ ...draft, fields: [...draft.fields, { name: String(name).trim(), start: selected.start, end: selected.end, default: selected.source.slice(selected.start, selected.end) }] });
    recipeDraft = next; persist(); showRecipeBuilder(); updateBar();
  }
  function showRecipeBuilder() {
    if (!recipesEnabled || !recipeDraft) return;
    filling = null;
    resetPanel("Adjustable recipe", "Select another phrase in the editor and choose Add field. The rest of the prompt stays ordinary text.");
    panelKind = "recipe";
    recipeDraft.fields.forEach((item, index) => {
      const name = field("Field name", item.name), value = field("Default value", item.default);
      name.input.addEventListener("input", () => { item.name = name.input.value.trim(); persist(); });
      value.input.addEventListener("input", () => { item.default = value.input.value; persist(); }); autocomplete(value.input);
      panel.append(name.label, value.label, row(makeButton("Remove field", () => { recipeDraft.fields.splice(index, 1); persist(); showRecipeBuilder(); })));
    });
    panel.appendChild(row(makeButton("Select another field", () => { closeHost(); textarea.focus({ preventScroll: true }); })));
    const negative = field("Negative prompt (optional, kept separately)", recipeDraft.negative, true);
    negative.input.addEventListener("input", () => { recipeDraft.negative = negative.input.value; persist(); }); panel.appendChild(negative.label);
    const path = field("Save in My Library", "RECIPES/adjustable_recipe"); panel.appendChild(path.label);
    panel.appendChild(row(makeButton("Discard draft", () => { recipeDraft = null; persist(); closeHost(); updateBar(); })));
    const output = preview("Default positive prompt", recipeDraft.fields.length ? fillRecipe(recipeDraft).positive : recipeDraft.source);
    if (onOpenWorkspace) panel.appendChild(row(makeButton("Open as Workspace", () => { onOpenWorkspace(validateRecipe(recipeDraft)); closeHost(); })));
    panel.appendChild(row(makeButton("Preview defaults", () => { output.textContent = fillRecipe(recipeDraft).positive; }), makeButton("Save recipe", async () => {
      guard(recipeDraft.source); const name = path.input.value.trim().replace(/\.txt$/i, "");
      if (!RECIPE_PATH.test(name) || !LIBRARY_PATH.test(name)) throw new Error("Use a RECIPES/path with letters, numbers, underscores or hyphens.");
      const content = serializeRecipe(recipeDraft), existing = await API.content(name, { fresh: true });
      if (existing?.found && !await dialogConfirm({ title: "Overwrite recipe", message: `Replace ${name}?` })) return;
      const result = await API.save(name, content); if (!result?.ok) throw new Error(result?.error || "Recipe could not be saved.");
      await refreshLibrary(); message(`Saved ${name}. Choose it from My Library to fill its fields.`);
    }), makeButton("Export recipe", async () => {
      await exportRecipePack(recipeDraft); message("Recipe and its TXT dependencies exported.");
    })));
  }
  async function insertRecipe(path, savedSelection, fallback, committed = null) {
    const request = ++version;
    const response = await API.content(path); if (disposed || request !== version) return;
    if (!recipesEnabled) return;
    guard(savedSelection.source); const recipe = response?.found ? parseRecipe(response.content) : null;
    if (recipe?.schema.endsWith(".v2") && onOpenWorkspace) {
      if (await dialogConfirm({ title: "Open recipe workspace", message: "Replace the current prompt with this structured recipe? This change can be undone." })) { onOpenWorkspace(recipe, path); committed?.(); closeHost(); }
      return;
    }
    if (!recipe) { const next = replaceRange(savedSelection.source, savedSelection.start, savedSelection.end, fallback, false); apply(next.text, next.end); committed?.(); return; }
    filling = { recipe, savedSelection, committed }; fieldValues = Object.fromEntries(recipe.fields.map(f => [f.id || f.name, f.value ?? f.default]));
    resetPanel("Fill adjustable recipe", path);
    panelKind = "recipe";
    for (const item of recipe.fields) {
      const f = field(item.label || item.name, fieldValues[item.id || item.name]); panel.appendChild(f.label);
      const update = () => { fieldValues[item.id || item.name] = f.input.value; positive.textContent = fillRecipe(recipe, fieldValues).positive; };
      f.input.addEventListener("input", update); autocomplete(f.input, update);
    }
    if (onOpenWorkspace) panel.appendChild(row(makeButton("Open as Workspace", async () => {
      guard(savedSelection.source);
      if (await dialogConfirm({ title: "Open recipe workspace", message: "Replace the current prompt with this structured recipe? This change can be undone." })) { onOpenWorkspace(recipe, path, fieldValues); committed?.(); closeHost(); }
    })));
    const positive = preview("Positive prompt", fillRecipe(recipe, fieldValues).positive);
    if (recipe.negative) { preview("Negative prompt", recipe.negative); panel.appendChild(row(makeButton("Copy negative", () => navigator.clipboard.writeText(recipe.negative)))); }
    const dependencies = recipeDependencies(recipe), known = new Set(getLibrary().map(item => typeof item === "string" ? item : item.path));
    const missing = dependencies.filter(p => !known.has(p));
    if (missing.length) message(`Missing lists: ${missing.join(", ")}. Replace those fields or add the lists before inserting.`, true);
    panel.appendChild(row(makeButton("Insert filled recipe", () => {
      const current = filling; guard(current.savedSelection.source);
      const result = fillRecipe(current.recipe, fieldValues);
      const unresolved = recipeDependencies({ ...current.recipe, source: result.positive, negative: result.negative, fields: [] }).filter(p => !known.has(p));
      if (unresolved.length) throw new Error(`Missing lists: ${unresolved.join(", ")}. Replace them before insertion.`);
      const next = replaceRange(current.savedSelection.source, current.savedSelection.start, current.savedSelection.end, result.positive, false);
      apply(next.text, next.end); current.committed?.(); closeHost();
    })));
  }
  function recipeHook(path, data = {}) {
    if (!recipesEnabled || !RECIPE_PATH.test(path)) return false;
    const range = { source: data.source ?? textarea.value, start: data.start ?? textarea.selectionStart, end: data.end ?? textarea.selectionEnd };
    insertRecipe(path, range, data.fallback ?? `__${path}__`, data.committed).catch(error => { if (!disposed && error?.name !== "AbortError") { resetPanel("Recipe", "Your prompt has not been changed."); message(error.message, true); } });
    return true;
  }
  async function importRecipe() {
    if (!recipesEnabled) return;
    const files = await pickJsonFile(); if (!files.length || disposed || !recipesEnabled) return;
    const pack = JSON.parse(files[0].text);
    if (pack.schema !== "prompt-palette.recipe-pack.v1") throw new Error("Choose an exported Prompt Palette recipe pack.");
    const recipe = validateRecipe(pack.recipe);
    if (!pack.dependencies || typeof pack.dependencies !== "object" || Array.isArray(pack.dependencies) || Object.keys(pack.dependencies).length > 256) throw new Error("Invalid recipe dependencies.");
    const entries = Object.entries(pack.dependencies);
    if (entries.some(([name, content]) => !LIBRARY_PATH.test(name) || typeof content !== "string" || content.length > 1_000_000)) throw new Error("A dependency has an invalid path or is too large.");
    const raw = await dialogPrompt({ title: "Import adjustable recipe", message: "Save this recipe in My Library as:", defaultValue: "RECIPES/imported_recipe" });
    if (raw == null || disposed || !recipesEnabled) return;
    const name = String(raw).trim().replace(/\.txt$/i, "");
    if (!RECIPE_PATH.test(name) || !LIBRARY_PATH.test(name)) throw new Error("Use a valid RECIPES/path.");
    const targetContent = serializeRecipe(recipe);
    const writes = [...entries, [name, targetContent]], backups = [];
    if (new Set(writes.map(([path]) => path)).size !== writes.length) throw new Error("The recipe path overlaps one of its dependencies; choose another name.");
    for (const [path, content] of writes) {
      const current = await API.content(path, { fresh: true });
      if (current?.found && !current.editable) throw new Error(`Cannot replace a non-TXT entry: ${path}`);
      if (current?.found && current.content !== content) {
        if (!await dialogConfirm({ title: "Recipe import conflict", message: `Replace existing My Library entry ${path}? Cancel leaves the pack unimported.` })) return;
      }
      backups.push({ path, content, old: current?.found ? current.content : null });
    }
    const known = new Set([...getLibrary().map(item => typeof item === "string" ? item : item.path), ...writes.map(([path]) => path)]);
    const required = recipeDependencies(recipe).concat(...entries.map(([, content]) => recipeDependencies({ source: content, negative: "", fields: [] })));
    const missing = required.filter(path => !known.has(path));
    if (missing.length) throw new Error(`The pack is missing lists: ${[...new Set(missing)].join(", ")}`);
    if (!recipesEnabled) return;
    resetPanel("Import adjustable recipe", "Saving the recipe and its dependency lists…");
    panelKind = "recipe";
    const done = [];
    try {
      for (const entry of backups) {
        if (entry.old === entry.content) continue;
        const result = await API.save(entry.path, entry.content); if (!result?.ok) throw new Error(result?.error || `Could not save ${entry.path}`);
        done.push(entry);
      }
    } catch (error) {
      const failures = [];
      for (const entry of done.reverse()) {
        try { const result = entry.old == null ? await API.del(entry.path) : await API.save(entry.path, entry.old); if (!result?.ok) failures.push(entry.path); } catch { failures.push(entry.path); }
      }
      throw new Error(`${error.message}${failures.length ? ` Some changes could not be restored: ${failures.join(", ")}` : " Applied changes were restored."}`);
    }
    await refreshLibrary(); message(`Imported ${name} and ${entries.length} dependency list${entries.length === 1 ? "" : "s"}.`);
  }
  const importButton = makeButton("Import recipe", importRecipe, "Import an adjustable recipe with its wildcard lists");
  const libraryActions = root.querySelector(".wg-personal-head .wg-drawer-head-actions") || root.querySelector('[data-drawer="picker"] .wg-drawer-head');
  if (!fieldOnly) { libraryActions?.appendChild(importButton); textarea.__ppRecipeInsert = recipeHook; node._ppInsertAdjustableRecipe = recipeHook; }
  selectionActions.append(makeButton("Replace", openReplace), makeButton("Vary this", capture), makeButton("Weight −", () => adjustWeight(-1), "Lower the weight of the selection by ComfyUI's Ctrl+up/down precision"), makeButton("Weight +", () => adjustWeight(1), "Raise the weight of the selection by ComfyUI's Ctrl+up/down precision"), makeButton("Reset weight", removeWeight), makeButton("Favorite", () => {
    const s = currentSelection(), value = s.source.slice(s.start, s.end), wildcard = value.match(/^__[+\-*%~@]?([A-Za-z0-9_\-\/]+)__$/);
    if (wildcard) { const pins = loadPinned(); pins.add(wildcard[1]); savePinned(pins); }
    else { const store = createPromptUsageStore(); if (!store.isTagFavorite("custom", value)) store.toggleTagFavorite("custom", value, categoryForTagKey(normalizeTagKey(value)) || "custom"); }
  }));
  const makeRecipeButton = makeButton("Make recipe", () => { recipeDraft = null; return addRecipeField(); });
  const addFieldButton = makeButton("Add field", addRecipeField);
  selectionActions.append(makeRecipeButton, addFieldButton);
  // Ctrl/Cmd+Up/Down: weight the selection, or the tag / (group) at the caret. Works whether or not the
  // Selection bar is shown. Autocomplete keeps its own arrow navigation while its menu is open.
  function weightShortcut(event) {
    if (disposed || event.isComposing || event.keyCode === 229 || event.altKey || event.shiftKey || !(event.ctrlKey || event.metaKey)) return;
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    if (acState && acState.textarea === textarea) return;
    const range = locateWeightTarget(textarea.value, textarea.selectionStart, textarea.selectionEnd);
    if (!range) return;
    event.preventDefault(); event.stopPropagation();
    changeWeight(range, event.key === "ArrowUp" ? 1 : -1);
  }
  function syncRecipeSettings() {
    selectionToolsEnabled = getPowerToolPreferences().selectionTools !== false;
    recipesEnabled = (!fieldOnly && getPowerToolPreferences().adjustableRecipes);
    makeRecipeButton.hidden = addFieldButton.hidden = importButton.hidden = !recipesEnabled;
    if (!recipesEnabled && panelKind === "recipe") {
      version++; pending?.abort(); filling = null;
      inputCleanups.forEach(fn => fn()); inputCleanups = []; closeHost();
    }
    updateBar(); scheduleDomWidgetRemeasure(node);
  }
  listen(window, "pp-power-tools-changed", syncRecipeSettings);
  syncRecipeSettings();
  listen(root, "pp-refinement-reset", () => { panelKind = "other"; filling = null; version++; pending?.abort(); panel.hidden = true; host.classList.remove("pp-refine-active"); });
  cleanups.push(observeEditorSelection(textarea, updateSelection));
  listen(host, "pp-refinement-owner", event => { if (event.detail !== panel) { version++; pending?.abort(); panel.hidden = true; } });
  listen(textarea, "focus", updateSelection); listen(textarea, "blur", updateSelection); listen(textarea, "select", updateSelection); listen(textarea, "keyup", updateSelection); listen(textarea, "mouseup", updateSelection); listen(textarea, "input", onSourceChanged);
  listen(textarea, "keydown", weightShortcut);
  listen(root, "keydown", event => { if (event.key === "Escape" && ownHost && host.classList.contains("open")) closeHost(); });
  if (preparedWidget) hideNativeWidget(preparedWidget);
  updateBar();
  return { sourceChanged: onSourceChanged, varySelection() { textarea.focus(); updateSelection(); return capture(); }, varyAll() { textarea.focus(); textarea.select(); updateSelection(); return capture(); }, cleanup() {
    if (!panel.hidden) closeHost();
    disposed = true; version++; pending?.abort(); cleanups.forEach(fn => fn()); inputCleanups.forEach(fn => fn());
    if (textarea.__ppRecipeInsert === recipeHook) delete textarea.__ppRecipeInsert;
    if (node._ppInsertAdjustableRecipe === recipeHook) delete node._ppInsertAdjustableRecipe;
    importButton.remove(); bar.remove(); panel.remove(); if (ownHost) host.remove();
  }, recipeHook };
}
