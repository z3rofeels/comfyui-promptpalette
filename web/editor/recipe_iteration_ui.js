import { cloneWorkspaceData } from "./recipe_workspace_model.js";
import { API } from "../prompt_palette_api.js";
import { dialogPrompt, dialogConfirm, dialogChoice } from "./dialogs.js";
import { serializeRecipe, parseRecipe } from "./prompt_refinement.js";
import { historyOf, captureBranch, branchRecipe, switchBranch, saveVariant, saveSnapshot, restoreSnapshot, diffWorkspaces, BUILTIN_PRESETS, presetRecipe, instantiatePreset, starterPreset } from "./recipe_iteration.js";

// Uses the workspace controller's mutation/history boundary and existing recipe saves.
export function appendIterationUI({ section, state, button: makeButton, selectControl: makeSelect, replaceRecipe, persist, getState, refreshLibrary, getLibrary, sendSnapshot, presetHost = null }) {
  const details = document.createElement("details"); details.className = "pp-recipe-iteration"; details.open = !!state.iterationOpen;
  const summary = document.createElement("summary"); summary.textContent = "Snapshots & variants"; details.appendChild(summary);
  details.addEventListener("toggle", () => { const current = getState(); if (details.isConnected && current) { current.iterationOpen = details.open; persist(); } });
  section.appendChild(details);
  const initialRecipe = state.recipe;
  let captured = JSON.stringify(initialRecipe), busy = false;
  function run(action) {
    if (busy) throw new Error("Finish the current workspace action first.");
    busy = true; captured = JSON.stringify(getState()?.recipe);
    try {
      const result = action();
      if (result?.then) return result.finally(() => { busy = false; });
      busy = false; return result;
    } catch (error) { busy = false; throw error; }
  }
  const button = (label, action, title) => makeButton(label, () => run(action), title);
  const selectControl = (label, options, value, change) => makeSelect(label, options, value, next => run(() => change(next)));
  function current() { const s = getState(); if (!s || JSON.stringify(s.recipe) !== captured) throw new Error("The workspace changed while this action was open. Try again."); return s.recipe; }
  function row(title, ...items) {
    const group = document.createElement("section"); group.className = "pp-iteration-group"; group.setAttribute("aria-label", title);
    const heading = document.createElement("strong"); heading.className = "pp-iteration-heading"; heading.textContent = title;
    const element = document.createElement("div"); element.className = "pp-refine-actions pp-iteration-row"; element.append(...items);
    const note = document.createElement("p"); note.className = "pp-iteration-purpose";
    note.textContent = { Variants: "Alternate workspaces: keep shared Base fields and change only each branch's overrides.", Snapshots: "Named checkpoints. Compare first, or restore a checkpoint into the current branch.", Compare: "Inspect differences between saved states. Comparing does not edit your prompt.", "Field presets": "Choose a layout, preview its fields, then Apply. Starter values are optional and editable; saved presets retain their own values. No quality prefixes are added." }[title];
    group.append(heading, note, element); (title === "Field presets" && presetHost ? presetHost : details).appendChild(group); return element;
  }
  async function named(kind, items, defaultName, save) {
    const raw = await dialogPrompt({ title: `Save ${kind}`, message: `${kind} name`, defaultValue: defaultName }); if (raw == null) return;
    const recipe = current(), name = raw.trim(); if (!name) return;
    const old = items.find(x => x.name.toLowerCase() === name.toLowerCase());
    if (old && !await dialogConfirm({ title: `Replace ${kind}`, message: `Replace “${old.name}”?` })) return;
    current(); replaceRecipe(save(recipe, name, old?.id || null));
  }
  const h = historyOf(initialRecipe);
  const branch = selectControl("Active workspace variant", [["", "Base workspace"], ...h.variants.map(v => [v.id, v.name])], h.activeVariantId || "", value => replaceRecipe(switchBranch(current(), value || null)));
  branch.disabled = !h.base;
  const newVariant = button("+ Variant", () => named("variant", h.variants, `Variant ${h.variants.length + 1}`, saveVariant));
  const variantRow = row("Variants", branch, newVariant, button("Reset variant to base", async () => {
    const r = captureBranch(current()), h = historyOf(r); if (!h.activeVariantId) throw new Error("Select a variant first.");
    const base = branchRecipe(r); showDiff(r, base, "Reset variant preview");
    if (!await dialogConfirm({ title: "Reset variant to base", message: "Discard this branch's overrides, added fields and removals? Its name, snapshots and sibling variants are kept. Undo restores your overrides." })) return;
    current(); replaceRecipe({ ...base, name: r.name, experiments: h });
  }), button("Rename variant", async () => {
    const id = historyOf(current()).activeVariantId; if (!id) throw new Error("Select a variant first.");
    const v = historyOf(current()).variants.find(v => v.id === id);
    const name = await dialogPrompt({ title: "Rename variant", message: "Variant name", defaultValue: v.name }); if (name == null || !name.trim()) return;
    current(); const next = captureBranch(current());
    if (next.experiments.variants.some(v => v.id !== id && v.name.toLowerCase() === name.trim().toLowerCase())) throw new Error("A variant with that name already exists.");
    next.experiments.variants.find(v => v.id === id).name = name.trim(); replaceRecipe(next);
  }), button("Delete variant", async () => {
    const id = h.activeVariantId; if (!id) throw new Error("Select a variant first.");
    const v = h.variants.find(v => v.id === id);
    if (!await dialogConfirm({ title: "Delete variant", message: `Delete “${v.name}” and return to Base workspace?` })) return;
    const next = switchBranch(current(), null); next.experiments.variants = next.experiments.variants.filter(v => v.id !== id); replaceRecipe(next);
  }));
  for (const action of [...variantRow.querySelectorAll("button")].slice(1)) action.disabled = !h.activeVariantId;
  const snapshots = selectControl("Workspace snapshot", [["", "Choose snapshot"], ...h.snapshots.map(s => [s.id, s.name])], "", () => {});
  function selectedSnapshot() { const snapshot = historyOf(current()).snapshots.find(s => s.id === snapshots.value); if (!snapshot) throw new Error("Choose a snapshot first."); return snapshot; }
  const snapshotRow = row("Snapshots", snapshots, button("Save snapshot", () => named("snapshot", h.snapshots, `Snapshot ${h.snapshots.length + 1}`, saveSnapshot)), button("Restore snapshot", async () => {
    const snapshot = selectedSnapshot();
    showDiff(current(), snapshot.recipe, `Restore preview: ${snapshot.name}`);
    if (!await dialogConfirm({ title: "Restore snapshot", message: `Restore “${snapshot.name}” into the current branch? This replaces its fields, including locked fields. Undo restores the previous state.` })) return;
    replaceRecipe(restoreSnapshot(current(), snapshot.id));
  }), button("Compare snapshot", () => { const snapshot = selectedSnapshot(); showDiff(snapshot.recipe, current(), `${snapshot.name} → Current`); }), button("Snapshot to Combinatorial", () => sendSnapshot(selectedSnapshot())), button("Rename snapshot", async () => {
    const snapshot = selectedSnapshot(), name = await dialogPrompt({ title: "Rename snapshot", message: "Snapshot name", defaultValue: snapshot.name }); if (name == null || !name.trim()) return;
    const next = captureBranch(current());
    if (next.experiments.snapshots.some(s => s.id !== snapshot.id && s.name.toLowerCase() === name.trim().toLowerCase())) throw new Error("A snapshot with that name already exists.");
    next.experiments.snapshots.find(s => s.id === snapshot.id).name = name.trim(); replaceRecipe(next);
  }), button("Delete snapshot", async () => {
    const snapshot = selectedSnapshot(); if (!await dialogConfirm({ title: "Delete snapshot", message: `Delete “${snapshot.name}”?` })) return;
    const next = captureBranch(current()); next.experiments.snapshots = next.experiments.snapshots.filter(s => s.id !== snapshot.id); replaceRecipe(next);
  }));
  const snapshotActions = [...snapshotRow.querySelectorAll("button")].slice(1);
  const updateSnapshotActions = () => snapshotActions.forEach(action => { action.disabled = !snapshots.value; });
  snapshots.addEventListener("change", updateSnapshotActions); updateSnapshotActions();
  const compareChoices = [["current", "Current workspace"], ...(state.baseline ? [["saved", "Last saved state"]] : []), ...(h.base ? [["base", "Base workspace"]] : []), ...h.variants.map(v => [`variant:${v.id}`, `Variant: ${v.name}`]), ...h.snapshots.map(s => [`snapshot:${s.id}`, `Snapshot: ${s.name}`])];
  const from = selectControl("Compare from workspace", compareChoices, h.base ? "base" : state.baseline ? "saved" : "current", () => {});
  const to = selectControl("Compare to workspace", compareChoices, "current", () => {});
  function resolveChoice(value) {
    const r = captureBranch(current());
    if (value === "current") return r;
    if (value === "saved") return JSON.parse(getState().baseline);
    if (value === "base") return branchRecipe(r);
    if (value.startsWith("variant:")) return branchRecipe(r, value.slice(8));
    const s = historyOf(r).snapshots.find(s => s.id === value.slice(9)); if (!s) throw new Error("Comparison checkpoint is missing."); return s.recipe;
  }
  row("Compare", from, to, button("Compare workspaces", () => showDiff(resolveChoice(from.value), resolveChoice(to.value), "Workspace comparison")));
  const paths = getLibrary().map(item => typeof item === "string" ? item : item.path).filter(path => /^RECIPES\/_presets\//i.test(path));
  const presets = selectControl("Field preset", [["", "Choose field preset"], ...BUILTIN_PRESETS.map(p => [`builtin:${p.id}`, p.name]), ...paths.map(path => [`saved:${path}`, path.split("/").at(-1).replace(/[_-]/g, " ")])], "", () => {});
  const language = selectControl("Starter prompt language", [["natural", "Natural language · Krea2 / Qwen"], ["tags", "Tags · Illustrious and Booru"], ["anima", "Anima · tags / scene prose"]], state.presetLanguage || "natural", next => { getState().presetLanguage = next; persist(); refreshCards(); });
  const starterLabel = document.createElement("label"), starterValues = document.createElement("input"); starterValues.type = "checkbox"; starterValues.checked = state.includePresetValues !== false;
  starterValues.addEventListener("change", () => { getState().includePresetValues = starterValues.checked; persist(); });
  starterLabel.className = "pp-layout-starter-values"; starterLabel.append(starterValues, document.createTextNode("Include starter choices"));
  const gallery = document.createElement("div"); gallery.className = "pp-layout-gallery";
  function refreshCards() {
    gallery.replaceChildren();
    for (const preset of BUILTIN_PRESETS) {
      const card = document.createElement("button"); card.type = "button"; card.className = "pp-layout-card";
      card.setAttribute("aria-pressed", String(presets.value === `builtin:${preset.id}`));
      const title = document.createElement("strong"); title.textContent = preset.name;
      const preview = document.createElement("span"); preview.className = "pp-layout-fields";
      for (const f of preset.recipe.fields) { const chip = document.createElement("span"); chip.textContent = f.label; preview.append(chip); }
      const note = document.createElement("small"); note.textContent = preset.id === "anima" ? "Scene prose + separate character tag fields" : preset.id === "negative" ? "Separate positive and negative fields" : "Editable starter choices · cycle on generation";
      card.append(title, preview, note); card.addEventListener("click", () => { presets.value = `builtin:${preset.id}`; presets.dispatchEvent(new Event("change")); refreshCards(); });
      gallery.append(card);
    }
  }
  const presetRow = row("Field presets", language, starterLabel, gallery, presets, button("Apply preset", async () => {
    const value = presets.value; if (!value) throw new Error("Choose a field preset first.");
    let recipe;
    if (value.startsWith("builtin:")) recipe = starterPreset(BUILTIN_PRESETS.find(p => p.id === value.slice(8)).recipe, language.value, { includeValues: starterValues.checked });
    else { const data = await API.content(value.slice(6)); if (!data.found || !(recipe = parseRecipe(data.content))) throw new Error("This saved preset is not a workspace recipe."); }
    current(); const next = instantiatePreset(recipe, value);
    showDiff(current(), next, "Preset replacement preview");
    if (!await dialogConfirm({ title: "Apply field preset", message: "Replace the current branch's fields with this preset? Existing snapshots and sibling variants are kept. Undo restores your fields." })) return;
    const r = current(); const name = r.name === "Prompt workspace" || BUILTIN_PRESETS.some(p => p.name === r.name) ? next.name : r.name; replaceRecipe({ ...next, name, ...(r.experiments ? { experiments: cloneWorkspaceData(r.experiments) } : {}) });
  }), button("Save field preset", async () => {
    const choice = await dialogChoice({ title: "Save field preset", message: "Save only the structure, or include default prompt values? Fixed template text and the negative preamble are retained in both options.", choices: [{ label: "Structure only", value: "structure", primary: true }, { label: "Include values", value: "values" }, { label: "Cancel", value: null }] });
    if (!choice) return;
    const name = await dialogPrompt({ title: "Save field preset", message: "Preset name (letters, numbers, underscores or hyphens)", defaultValue: "my_preset" }); if (name == null) return;
    if (!/^[A-Za-z0-9_-]+$/.test(name.trim())) throw new Error("Use letters, numbers, underscores or hyphens.");
    const recipe = presetRecipe(current(), { keepText: choice === "values" }), path = `RECIPES/_presets/${name.trim()}`; recipe.name = name.trim().replace(/[_-]/g, " ");
    const existing = await API.content(path, { fresh: true });
    if (existing.found && !await dialogConfirm({ title: "Replace field preset", message: `Replace ${path}?` })) return;
    current(); const result = await API.save(path, serializeRecipe(recipe)); if (!result.ok) throw new Error(result.error || "Preset save failed.");
    await refreshLibrary();
  }));
  const applyPreset = presetRow.querySelector("button.wg-button"); applyPreset.disabled = !presets.value;
  presets.addEventListener("change", () => { applyPreset.disabled = !presets.value; });
  refreshCards();
  const diff = document.createElement("section"); diff.className = "pp-recipe-diff"; diff.hidden = true; details.appendChild(diff);
  function showDiff(before, after, title) {
    const result = diffWorkspaces(before, after); diff.replaceChildren(); diff.hidden = false; details.open = true;
    const heading = document.createElement("strong"); heading.textContent = title; diff.appendChild(heading);
    for (const change of result.changes) {
      const card = document.createElement("article"), label = document.createElement("strong"), text = document.createElement("pre");
      label.textContent = `${change.label} · ${change.type}${change.moved ? " · moved" : ""}`;
      text.textContent = `${change.type === "added" ? "" : `− ${change.before}\n`}${change.type === "removed" ? "" : `+ ${change.after}`}`;
      card.append(label, text);
      if (change.metadata.length) { const meta = document.createElement("div"); meta.textContent = change.metadata.map(m => {
        const names = { label: "Label", titleHidden: "Title hidden", accent: "Accent color", enabled: "Included", channel: "Prompt channel", separator: "Separator", experimentState: "Variation mode", variationMode: "Generation method", dependsOn: "Follow sources", fieldType: "Field type", default: "Default value", variationTemplate: "Reusable choices" };
        const display = (value, recipe) => m.key === "dependsOn" ? (value || []).map(id => recipe.fields.find(f => f.id === id)?.label || id).join(", ") || "None" : m.key === "experimentState" ? value || "Default" : JSON.stringify(value) ?? "default";
        return `${names[m.key] || m.key}: ${display(m.before, before)} → ${display(m.after, after)}`;
      }).join("\n"); card.appendChild(meta); }
      diff.appendChild(card);
    }
    if (!result.changes.length) { const empty = document.createElement("p"); empty.textContent = "No field changes."; diff.appendChild(empty); }
    if (result.properties.length) { const p = document.createElement("p"); p.textContent = `Workspace changes: ${result.properties.join(", ")}`; diff.appendChild(p); }
    const compiled = document.createElement("details"), caption = document.createElement("summary"); caption.textContent = "Compiled prompt diff"; compiled.appendChild(caption);
    for (const channel of ["positive", "negative"]) { const pre = document.createElement("pre"); pre.textContent = result.compiledBefore[channel] === result.compiledAfter[channel] ? `${channel}: unchanged` : `${channel}\n− ${result.compiledBefore[channel]}\n+ ${result.compiledAfter[channel]}`; compiled.appendChild(pre); }
    diff.append(compiled, button("Close comparison", () => { diff.hidden = true; }));
  }
}
