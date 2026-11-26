import { copyPromptPaletteThemeScope, installPromptPaletteKeyboardBoundary, onPromptPaletteAppearanceChanged, svgIcon } from "../prompt_palette_shared.js";
import { trackDialog } from "./dialogs.js";
import { cloneWorkspaceData, validateWorkspaceRecipe, compileWorkspace } from "./recipe_workspace_model.js";
import { workspaceGeneration } from "./workspace_generation.js";
import { editCompiledPrompt } from "./recipe_text_edit.js";
import { loraTags, loraTagName } from "../engine/lora_tags.js";
import { socketConnected } from "../renderer/base_renderer_adapter.js";
import { getPowerToolPreferences } from "../prompt_palette_state.js";
import { notify } from "./notifications.js";

const make = (tag, text = "") => { const element = document.createElement(tag); element.textContent = text; return element; };
const connected = (node, name) => { const input = node.inputs?.find(input => input.name === name); return !!input && socketConnected("input", input, node); };

// Sources retain their evidence and channel availability all the way to Apply.
// In particular, an empty negative is available; a missing negative is not.
export function historyRefinementSources(record, { includeFields = true } = {}) {
  const sources = [];
  const contexts = Array.isArray(record.contexts) ? record.contexts.filter(c => c && typeof c === "object") : [];
  if (record.provenance === "verified" && typeof record.resolved_positive === "string") {
    const context = contexts.find(c => record.pp_node_id != null && String(c.node_id) === String(record.pp_node_id));
    sources.push({ label: `Verified Palette output${context?.title ? ` · ${context.title}` : record.pp_node_id != null ? ` · node #${record.pp_node_id}` : ""}`, kind: "verified", positive: record.resolved_positive,
      negative: record.resolved_negative, context, seed: record.effective_seed_text ?? (Number.isSafeInteger(record.effective_seed) ? String(record.effective_seed) : null) });
  }
  for (const context of contexts) {
    const data = context.refinement?.schema_version === 1 ? context.refinement : {};
    const title = context.title || `Prompt Palette #${context.node_id}`;
    const seed = context.seed_text ?? (Number.isSafeInteger(context.seed) ? String(context.seed) : null);
    const channels = Array.isArray(data.verified_channels) ? data.verified_channels : [];
    if (channels.length && record.provenance !== "imported-unlinked" && !sources.some(s => s.kind === "verified" && s.context === context)) {
      sources.push({ label: `${title} · verified Palette output`, kind: "verified", context, seed,
        positive: channels.includes("positive") ? data.positive_prompt : null, negative: channels.includes("negative") ? data.negative_prompt : null });
    }
    if (!data.batch && (typeof data.positive_prompt === "string" || typeof data.negative_prompt === "string" || typeof context.resolved_prompt === "string")) {
      sources.push({ label: `${title} · resolved node context`, kind: "resolved", context, seed,
        positive: data.positive_prompt ?? context.resolved_prompt, negative: data.negative_prompt });
    }
    const positive = data.source_text ?? context.authored_positive, negative = data.source_negative_text ?? context.authored_negative;
    if (typeof positive === "string" || typeof negative === "string") sources.push({ label: `${title} · authored context`, kind: "authored", context, seed, positive, negative });
    if (typeof seed === "string" && /^\d+$/.test(seed) && Number.isSafeInteger(Number(seed)) && !sources.some(item => item.context === context)) sources.push({ label: `${title} · node seed context`, kind: "context", context, seed });
    if (includeFields && data.workspace && typeof data.workspace_runtime === "string") {
      try {
        const recipe = validateWorkspaceRecipe(cloneWorkspaceData(data.workspace.recipe));
        const runtime = JSON.parse(data.workspace_runtime), projected = workspaceGeneration(recipe);
        const sameFields = JSON.stringify(projected.fields) === JSON.stringify(runtime.fields);
        if (sameFields && runtime.schema === projected.schema && runtime.positive === projected.positive && runtime.negative === projected.negative && runtime.positive === data.source_text && runtime.negative === data.source_negative_text) {
          const pair = compileWorkspace(recipe);
          sources.push({ label: `${title} · authored Fields state`, kind: "fields", context, seed, ...pair,
            workspace: { recipe, path: "", baseline: JSON.stringify(recipe), view: "workspace" } });
        }
      } catch { /* Incomplete or legacy Fields data remains context, never a guessed recipe. */ }
    }
  }
  return sources;
}

// An adapter for the mounted editor, not another model or persistence store.
// Both editor types supply their existing undo/render boundaries.
export function installHistoryRefinement({ node, root, textarea, getState, beginEdit, endEdit, render, syncControls, clearPrepared, onFocus,
  history, restoreState, openVariations, onFinish }) {
  for (const close of [...(node._ppHistoryRefinement?.dialogs || [])]) close();
  node._ppHistoryRefinement?.cancel();
  const dialogs = new Set();
  const widget = name => node.widgets?.find(w => w.name === name);
  let session = null, disposed = false, revision = 0;
  const bar = make("div"); bar.className = "pp-refinement-session pp-refine-actions"; bar.hidden = true;
  bar.setAttribute("role", "region"); bar.setAttribute("aria-label", "Selective refinement");
  const note = make("span"); note.className = "pp-refine-note"; note.setAttribute("role", "status");
  const action = (label, run, existing = null) => {
    const button = existing || make("button", label); button.type = "button";
    if (!existing) button.className = "wg-button";
    button.addEventListener("mousedown", event => event.preventDefault());
    button.addEventListener("click", () => { try { run(); } catch (error) { if (bar.hidden) notify("info", "Refinement", error.message); else note.textContent = error.message; } });
    return button;
  };
  const fields = action("Lock / Vary / Follow", () => node._ppRecipeWorkspace.openFieldSettings());
  const vary = action("Variation Lab", () => openVariations());
  const loras = action("LoraPal", () => {
    const editor = node._ppRecipeWorkspace?.editingSurface() || textarea;
    const channel = editor.closest?.("[data-field-id]")?.querySelector("[data-channel]")?.dataset.channel || "positive";
    if (!adapter.can(channel === "positive" ? "text" : "negative_text") || editor.readOnly || editor.disabled) throw new Error("Focus an editable prompt field first.");
    if (!node._ppLoraSidecar?.open(editor)) throw new Error("LoraPal is unavailable in this editor.");
  });
  const preview = action("Preview result", () => {
    const button = root.querySelector('[data-act="resolve"]');
    if (!button) throw new Error("Result preview is unavailable in this editor.");
    if (!button.classList.contains("on")) button.click();
  });
  const commit = action("Commit", () => finish()); commit.classList.add("pp-refine-commit");
  const cancel = action("Cancel", () => finish(true)); cancel.classList.add("pp-refine-cancel");
  commit.title = "Keep these edits in the active draft and finish refinement";
  cancel.title = "Restore this draft to its state before refinement";
  preview.title = "Preview the resolved prompt with the current settings";
  bar.append(note, fields, vary, loras, preview, commit, cancel);
  const start = action("Refine", () => adapter.start(), root.querySelector('[data-act="refine"]'));
  start.classList.add("wg-pill"); start.dataset.act = "refine"; start.dataset.el ||= "btnRefine";
  start.innerHTML = `${svgIcon("edit")}<span class="wg-toolbar-label">Refine</span>`;
  start.title = "Refine the active draft using existing editors; Commit keeps edits and Cancel restores them";
  if (!start.parentElement) (root.querySelector(".wg-toolbar-center") || root.querySelector(".wg-toolbar"))?.append(start);
  (root.querySelector(".wg-editor-wrap") || textarea).before(bar);
  function refreshControls() {
    const preferences = getPowerToolPreferences();
    fields.disabled = !node._ppRecipeWorkspace?.isActive() || !preferences.adjustableRecipes;
    fields.title = fields.disabled ? "Fields are unavailable. Enable Adjustable Recipes and open an existing Fields workspace to use these controls." : "Choose Lock, Vary, Follow and variation methods in the existing Fields settings";
    vary.disabled = !openVariations || !preferences.variationLab;
    vary.title = vary.disabled ? "Enable Variation Lab in Settings → Power tools" : "Preview and apply choices using the existing Variation Lab";
  }
  window.addEventListener("pp-power-tools-changed", refreshControls);
  function captureSelection() {
    const active = node._ppRecipeWorkspace?.editingSurface() || textarea;
    return { workspace: node._ppRecipeWorkspace?.captureEditingContext(), active,
      start: textarea.selectionStart, end: textarea.selectionEnd, direction: textarea.selectionDirection, top: textarea.scrollTop, left: textarea.scrollLeft };
  }
  function restoreSelection(saved) {
    textarea.setSelectionRange(saved.start, saved.end, saved.direction); textarea.scrollTop = saved.top; textarea.scrollLeft = saved.left;
    if (saved.workspace) node._ppRecipeWorkspace?.restoreEditingContext(saved.workspace);
    else if (saved.active?.isConnected) saved.active.focus({ preventScroll: true });
  }
  const announceSession = () => window.dispatchEvent(new CustomEvent("pp-refinement-changed", { detail: { node } }));
  function finish(cancelled = false, { configuring = false } = {}) {
    if (!session) return;
    const saved = session;
    revision++;
    root.dispatchEvent(new Event("pp-refinement-reset"));
    node._ppLoraSidecar?.close();
    if (!configuring) onFocus?.();
    if (cancelled && !configuring) {
      restoreState(saved.value);
      node._ppRecipeWorkspace?.restore(saved.workspace, { commit: false });
      // LoRA execution mode is part of LoraPal's edit; queue-driven seed changes
      // remain normal ComfyUI behavior. Only an untouched recovered seed rolls back.
      if (saved.loraMode != null) node._ppLoraModeState?.commit(saved.loraMode);
      if (saved.seedPatch != null && widget("seed")?.value === saved.seedPatch && !connected(node, "seed") && !connected(node, "external_seed")) {
        widget("seed").value = saved.seed; widget("seed").callback?.(saved.seed);
      }
      render({ recordHistory: false }); syncControls();
    }
    const value = configuring ? saved.value : getState();
    history.endTransaction(value, { cancel: cancelled });
    session = null; bar.hidden = true; start.hidden = false;
    for (const [button, disabled, title] of saved.slots) { button.disabled = disabled; button.title = title; }
    if (!configuring) {
      node._ppPromptSlots?.syncActiveSlot?.();
      if (cancelled) restoreSelection(saved.selection);
      else node._ppRecipeWorkspace?.focusEditingSurface();
      if (!disposed) onFinish?.(cancelled);
    }
    announceSession();
    node.setDirtyCanvas?.(true, true);
  }
  const adapter = {
    root, dialogs,
    refreshControls,
    isRefining: () => !!session,
    revision: () => revision,
    cancel: () => finish(true),
    start(patch = {}, { focus = true } = {}) {
      if (session) throw new Error("Commit or cancel the current refinement first.");
      if (!adapter.alive()) throw new Error("The target editor is no longer open.");
      if (!adapter.can("text") && !adapter.can("negative_text")) throw new Error("Both prompt inputs are connected or unavailable.");
      const saved = { value: getState(), workspace: node._ppRecipeWorkspace?.snapshot(), selection: captureSelection(),
        seed: widget("seed")?.value, seedPatch: patch.seed, loraMode: node._ppLoraModeState?.current(),
        slots: [...root.querySelectorAll(".wg-slot-switcher button")].map(button => [button, button.disabled, button.title]) };
      history.beginTransaction(saved.value); session = saved; revision++;
      try {
        root.dispatchEvent(new Event("pp-refinement-reset"));
        clearPrepared?.();
        if (Object.keys(patch).length) adapter.apply(patch);
        else render();
        saved.slots.forEach(([button]) => { button.disabled = true; button.title = "Finish refinement with Commit or Cancel before switching drafts. Other saved drafts are preserved."; });
        root.dispatchEvent(new Event("pp-prompt-slots-hide"));
        refreshControls();
        note.textContent = `Refining draft ${node._ppPromptSlots?.getState?.().active || "A"} · Commit keeps edits; Cancel restores them. Draft switching is paused. Generation uses these edits; connected prompts stay external.`;
        if (JSON.parse(saved.value).prepared) note.textContent += " Cancel also restores the prepared batch.";
        bar.hidden = false; start.hidden = true; if (focus) adapter.focus();
        announceSession();
      } catch (error) { finish(true); throw error; }
    },
    alive: () => root.isConnected && !disposed,
    state: () => JSON.stringify([getState(), node._ppPromptSlots?.getState?.().active,
      node.inputs?.map((input, index) => [input.name, connected(node, input.name), typeof node.getInputLink === "function" ? node.getInputLink(index)?.id : input.link]),
      node.widgets?.filter(w => ["seed", "external_seed", "lora_mode", "processing_mode", "prompt_prefix", "prompt_suffix", "negative_prefix", "negative_suffix", "enhancer_override", "positive_antonyms", "vars_in", "prepared_batch", "seed_mode", "mode", "count", "max_prompts", "workspace_runtime"].includes(w.name) || /control.*generate/i.test(w.name)).map(w => [w.name, w.value])]),
    can: name => !connected(node, name) && (name === "text" ? !textarea.disabled && (node._ppRecipeWorkspace?.isActive() || !textarea.readOnly) : !!widget(name)),
    apply(patch) {
      if (!adapter.alive()) throw new Error("The target editor is no longer open.");
      for (const name of [typeof patch.positive === "string" || patch.workspace ? "text" : null, typeof patch.negative === "string" || patch.workspace ? "negative_text" : null, patch.seed != null ? "seed" : null, patch.loraMode ? "lora_mode" : null].filter(Boolean)) {
        if (!adapter.can(name) || name === "seed" && connected(node, "external_seed")) throw new Error(`The ${name} input is connected or unavailable. Review the target again.`);
      }
      let next = patch.workspace ? cloneWorkspaceData(patch.workspace) : node._ppRecipeWorkspace?.snapshot();
      if (next && !patch.workspace) {
        if (typeof patch.positive === "string") next.recipe = editCompiledPrompt(next.recipe, patch.positive);
        if (typeof patch.negative === "string") next.recipe = editCompiledPrompt(next.recipe, patch.negative, { channel: "negative" });
      }
      if (next) next.recipe = validateWorkspaceRecipe(next.recipe);
      beginEdit();
      if (patch.workspace || typeof patch.positive === "string" || typeof patch.negative === "string") {
        clearPrepared?.();
        if (next) node._ppRecipeWorkspace.restore(next);
        else {
          if (typeof patch.positive === "string") textarea.value = patch.positive;
          if (typeof patch.negative === "string") node._ppNegativePromptState.commit(patch.negative);
          render();
        }
      }
      for (const [name, value] of [["seed", patch.seed], ["lora_mode", patch.loraMode]]) if (value != null) {
        const target = widget(name); target.value = value; target.callback?.(value, node.graph?.canvas, node);
      }
      syncControls(); endEdit(); node._ppPromptSlots?.syncActiveSlot?.();
      if (patch.seed != null) { node._ppInvalidateRuntime?.("seed", { value: patch.seed }); node._ppRecipeWorkspace?.contextChanged(); }
      node.setDirtyCanvas?.(true, true);
    },
    focus: () => { onFocus?.(); node._ppRecipeWorkspace?.focusEditingSurface(); },
  };
  const configured = node.onConfigure;
  const configure = function() {
    // ComfyUI has already assigned incoming properties/widgets by this hook.
    // End the old session without writing its checkpoint into the new workflow.
    if (!disposed) {
      revision++;
      root.dispatchEvent(new Event("pp-refinement-reset"));
      finish(true, { configuring: true });
      for (const close of [...dialogs]) close();
    }
    const result = configured?.apply(this, arguments);
    if (!disposed) history.reset(getState());
    return result;
  };
  node.onConfigure = configure;
  node._ppHistoryRefinement = adapter;
  return () => { disposed = true; finish(true); for (const close of [...dialogs]) close(); window.removeEventListener("pp-power-tools-changed", refreshControls); bar.remove(); start.remove(); if (node.onConfigure === configure) node.onConfigure = configured; if (node._ppHistoryRefinement === adapter) delete node._ppHistoryRefinement; };
}

export function reviewHistoryRefinement(node, record, { getTarget, validateRecord, promote = false } = {}) {
  const adapter = node?._ppHistoryRefinement;
  if (!adapter?.alive()) throw new Error("Choose an open Prompt Palette or Combinatorial editor as the target first.");
  if (adapter.isRefining()) throw new Error("Commit or cancel the current refinement before recovering another generation.");
  const sources = historyRefinementSources(record).filter(item => !promote || item.workspace || typeof item.positive === "string" || typeof item.negative === "string");
  if (!sources.length) throw new Error("This generation has no recoverable inputs or Fields state.");
  node._ppPromptSlots?.syncActiveSlot();
  const baseline = adapter.state(), slots = node._ppPromptSlots, slotState = slots?.getState();
  const dialog = make("dialog"); dialog.className = "wg-root pp-history-restore pp-history-refine";
  dialog.setAttribute("aria-label", promote ? "Promote generation" : "Refine generation");
  dialog.append(make("h3", promote ? "Promote generation" : "Refine generation"), make("p", `Target: ${node.title || node.comfyClass || "Prompt Palette"} #${node.id} · active draft ${slotState?.active || "A"}. Review replacements before applying.`));
  const destination = make("select"); destination.setAttribute("aria-label", "Promotion destination");
  for (const [id, label] of [["editor", "Current editor"], ...(slots?.promoteToSlot ? Object.keys(slotState.slots).map(key => [key, `Draft ${key}${slotState.slots[key].name ? ` · ${slotState.slots[key].name}` : ""}${key === slotState.active ? " (active editor)" : ""}`]) : [])]) {
    const option = make("option", label); option.value = id; destination.append(option);
  }
  if (promote) dialog.append(destination);
  const source = make("select"); source.setAttribute("aria-label", "Recovered source");
  sources.forEach((item, index) => { const option = make("option", item.label); option.value = String(index); source.append(option); });
  const evidence = make("p"), body = make("div"), status = make("p"); status.setAttribute("role", "status");
  const cancel = make("button", "Cancel"), apply = make("button", promote ? "Promote to editor" : "Refine in editor"); cancel.type = apply.type = "button";
  const actions = make("div"); actions.className = "pp-history-actions"; actions.append(cancel, apply);
  dialog.append(source, evidence, body, status, make("p", promote
    ? "Only selected prompt data is promoted. Unavailable channels and draft names are preserved. Inactive drafts stay inactive. Editor changes use Prompt Undo and clear any prepared batch; other drafts stay saved. Current prefixes, suffixes, seeds, LoRA execution mode and connected inputs remain active. Recorded context does not establish reproducibility."
    : "Continue in the existing editor, then Commit or Cancel the refinement. Only selected data replaces this draft; other A–D drafts stay saved. Use Fields settings for Lock/Vary/Follow, Variation Lab for choices, LoraPal for tags and strengths, and Preview result. Prompt Undo covers text and Fields; seed and execution mode remain settings. Current prefixes, suffixes, seed behavior and connected inputs remain active. Palette seeds are not sampler noise seeds; recovered context does not establish reproducibility."), actions);
  let selected, choices, closed = false, busy = false;
  function check(text, checked, available = true) { const input = make("input"); input.type = "checkbox"; input.checked = checked && available; input.disabled = !available; const label = make("label"); label.append(input, document.createTextNode(` ${text}`)); body.append(label); return input; }
  function preview(label, value) { const heading = make("label", label), text = make("textarea"); text.readOnly = true; text.value = value; heading.append(text); body.append(heading); }
  const inactiveTarget = () => promote && destination.value !== "editor" && destination.value !== slotState?.active;
  const currentTarget = () => inactiveTarget() ? slotState.slots[destination.value] : JSON.parse(JSON.parse(baseline)[0]);
  function paint() {
    selected = sources[Number(source.value)]; choices = {}; body.replaceChildren();
    apply.disabled = false; status.textContent = "";
    evidence.textContent = selected.kind === "verified" ? "Verified Palette output on an unambiguous conditioning path. Downstream transformations are not recovered." : "Authored / resolved node context associated with this run. It is not proof of this image's exact inputs.";
    if (record.missing) evidence.textContent += " The image is missing; retained inputs are still available.";
    const current = currentTarget(), can = name => inactiveTarget() || adapter.can(name);
    if (promote) apply.textContent = inactiveTarget() ? `Promote to draft ${destination.value}` : "Promote to editor";
    if (selected.workspace) {
      choices.fields = check("Replace the complete Fields workspace with the recorded authored state", false, can("text") && can("negative_text"));
      preview("Current workspace / prompts", JSON.stringify(current.workspace?.recipe || { positive: current.text, negative: current.negative }, null, 2));
      preview("Recorded authored Fields (includes choices, locks and Follow state)", JSON.stringify(selected.workspace.recipe, null, 2));
      const values = selected.context?.refinement?.workspace_fields;
      if (values && Object.keys(values).length) preview("Resolved field values from node execution (context; authored state above is restored)", JSON.stringify(values, null, 2));
    } else for (const channel of ["positive", "negative"]) {
      const available = typeof selected[channel] === "string", editable = can(channel === "positive" ? "text" : "negative_text");
      choices[channel] = check(`Replace ${channel} prompt${!available ? " · unavailable" : !editable ? " · connected or unavailable target" : ""}`, available, available && editable);
      preview(`Current ${channel}`, channel === "positive" ? current.text : current.negative);
      preview(`Recovered ${channel}`, available ? selected[channel] : "Unavailable — current prompt is preserved.");
    }
    if (promote) {
      const targetSlot = slotState?.slots[inactiveTarget() ? destination.value : slotState.active];
      const occupied = !!(current.text?.length || current.negative?.length || current.workspace || current.prepared?.length || targetSlot?.name);
      choices.overwrite = check(`Replace selected data in ${inactiveTarget() ? `saved draft ${destination.value}` : "the current editor"} (reviewed above)`, false, occupied);
      choices.overwriteRequired = occupied;
      if (!occupied) choices.overwrite.closest("label").hidden = true;
      if (current.prepared) body.append(make("p", "Promotion to the editor clears the current prepared batch. Prompt Undo can restore it."));
      return;
    }
    const exactSeed = typeof selected.seed === "string" && /^\d+$/.test(selected.seed) && Number.isSafeInteger(Number(selected.seed));
    const data = selected.context?.refinement?.schema_version === 1 ? selected.context.refinement : {}, loras = data.loras;
    const seedEvidence = data.seed_source === "execution" || selected.kind === "verified" && !selected.context?.refinement ? "node execution" : "run input / legacy context; actual seed unverified";
    choices.seed = check(`Restore Palette seed: ${selected.seed ?? "unavailable"} · ${seedEvidence}${selected.seed && !exactSeed ? " · exceeds exact editor precision; copy from preview" : ""}`, false, exactSeed && adapter.can("seed") && !connected(node, "external_seed"));
    if (selected.seed) preview("Recorded Palette seed (not sampler noise)", selected.seed);
    const canRestoreLoras = ["verified", "resolved"].includes(selected.kind) && Array.isArray(loras) && loras.length > 0 && ["auto", "external", "strip", "bypass"].includes(data.lora_mode) && adapter.can("lora_mode");
    choices.loras = check("Restore recorded LoRA tags in selected prompts and the node-wide execution mode", false, canRestoreLoras);
    preview("Recorded node LoRA configuration (execution context)", Array.isArray(loras) ? JSON.stringify({ mode: data.lora_mode ?? "unavailable", loras }, null, 2) : "Unavailable — no separate LoRA configuration can be recovered.");
    if (!sources.some(item => item.workspace)) body.append(make("p", "Fields state is unavailable or could not be matched to the executed inputs."));
    if (current.prepared) body.append(make("p", "Replacing prompts clears the current prepared batch so it cannot override your refinement. Prompt Undo can restore it."));
    apply.disabled = false; status.textContent = "";
  }
  paint(); source.addEventListener("change", paint); destination.addEventListener("change", paint);
  const updateTheme = () => copyPromptPaletteThemeScope(adapter.root, dialog);
  updateTheme(); const offTheme = onPromptPaletteAppearanceChanged(updateTheme), offKeys = installPromptPaletteKeyboardBoundary(dialog);
  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  const release = trackDialog(close);
  function close(value = false) { if (closed) return; closed = true; adapter.dialogs.delete(close); release(); offTheme(); offKeys(); dialog.close(); dialog.remove(); resolveDone(value === true); }
  adapter.dialogs.add(close);
  cancel.onclick = () => close(); dialog.addEventListener("cancel", event => { event.preventDefault(); close(); }); dialog.addEventListener("close", () => close());
  apply.onclick = async () => {
    if (closed || busy) return;
    busy = true; apply.disabled = true; source.disabled = true; destination.disabled = true;
    try {
      const patch = {};
      if (choices.fields?.checked) patch.workspace = selected.workspace;
      for (const channel of ["positive", "negative"]) if (choices[channel]?.checked) patch[channel] = selected[channel];
      if (choices.seed?.checked) patch.seed = Number(selected.seed);
      if (choices.loras?.checked && (patch.positive != null || patch.negative != null)) {
        const data = selected.context.refinement;
        for (const channel of ["positive", "negative"]) if (patch[channel] != null) {
          const text = patch[channel]; let clean = text;
          for (const tag of loraTags(text).reverse()) clean = clean.slice(0, tag.start) + clean.slice(tag.end);
          const tags = data.loras.filter(item => (item.source || "positive") === channel).map(item => `<lora:${loraTagName(item.filename || item.name)}:${item.model_strength}:${item.clip_strength}>`);
          patch[channel] = clean + (tags.length ? ` ${tags.join(" ")}` : "");
        }
        patch.loraMode = data.lora_mode;
      }
      if (!Object.keys(patch).length) throw new Error(promote ? "Select available prompt data to promote." : "Select available data to refine.");
      if (promote && choices.overwriteRequired && !choices.overwrite.checked) throw new Error("Confirm replacement of the reviewed saved work before promoting.");
      const targetKey = destination.value;
      const selection = JSON.stringify([...body.querySelectorAll("input")].map(input => input.checked));
      await validateRecord?.();
      if (closed) return;
      if (JSON.stringify([...body.querySelectorAll("input")].map(input => input.checked)) !== selection) throw new Error("The selected replacements changed. Review and Apply again.");
      if (!adapter.alive() || node._ppHistoryRefinement !== adapter || getTarget && getTarget() !== node || adapter.state() !== baseline) throw new Error("The target, active draft, prompts or settings changed. Close and review Refine again.");
      if (promote) {
        if (node._ppPromptSlots !== slots || slots && JSON.stringify(slots.getState()) !== JSON.stringify(slotState) || destination.value !== targetKey || adapter.isRefining()) throw new Error("The target drafts changed. Close and review promotion again.");
        if (inactiveTarget()) {
          const current = currentTarget(), next = { ...current, workspace: patch.workspace ? cloneWorkspaceData(patch.workspace) : cloneWorkspaceData(current.workspace) };
          if (next.workspace && !patch.workspace) {
            for (const channel of ["positive", "negative"]) if (typeof patch[channel] === "string") next.workspace.recipe = editCompiledPrompt(next.workspace.recipe, patch[channel], { channel });
          }
          if (next.workspace) {
            next.workspace.recipe = validateWorkspaceRecipe(next.workspace.recipe);
            const compiled = compileWorkspace(next.workspace.recipe); next.text = compiled.positive; next.negative = compiled.negative;
          } else {
            if (typeof patch.positive === "string") next.text = patch.positive;
            if (typeof patch.negative === "string") next.negative = patch.negative;
          }
          slots.promoteToSlot(targetKey, next, { expected: JSON.stringify(current), overwrite: choices.overwrite.checked });
          close(true);
        } else { adapter.apply(patch); close(true); adapter.focus(); }
      } else { adapter.start(patch, { focus: false }); close(true); adapter.focus(); }
    } catch (error) { if (!closed) { status.textContent = error.message || String(error); apply.disabled = false; } }
    finally { busy = false; source.disabled = false; destination.disabled = false; }
  };
  document.body.append(dialog); dialog.showModal(); cancel.focus();
  return { done, close };
}
export function reviewHistoryRestore(editor, text, apply, channel = "positive") {
  if (!editor?.isConnected || editor.disabled || editor.readOnly) throw new Error('Choose an editable positive prompt field first.');
  const original = editor.value;
  const node = editor.__ppPromptTools?.node, adapter = node?._ppHistoryRefinement;
  const baseline = adapter?.state(), revision = adapter?.revision();
  const dialog = document.createElement('dialog'); dialog.className='wg-root pp-history-restore';
  const title=document.createElement('h3');title.textContent=`Restore ${channel} prompt`;dialog.append(title);
  const note=document.createElement('p');note.textContent=`Review the replacement. The ${channel === 'negative' ? 'positive' : 'negative'} prompt is preserved.`;dialog.append(note);
  for (const [label,value] of [['Current',original],['Replacement',text]]) { const heading=document.createElement('label');heading.textContent=label;const preview=document.createElement('textarea');preview.readOnly=true;preview.value=value;heading.append(preview);dialog.append(heading); }
  const cancel=document.createElement('button');cancel.type='button';cancel.textContent='Cancel';const confirm=document.createElement('button');confirm.type='button';confirm.textContent='Restore';dialog.append(cancel,confirm);
  const updateTheme = () => copyPromptPaletteThemeScope(editor.closest?.(".wg-root") || editor, dialog);
  updateTheme();
  const offTheme = onPromptPaletteAppearanceChanged(updateTheme), offKeys = installPromptPaletteKeyboardBoundary(dialog);
  document.body.append(dialog);
  return new Promise((resolve,reject)=>{
    let closed = false;
    const release = trackDialog(close);
    function close(value = false, error = null) {
      if (closed) return;
      closed = true; adapter?.dialogs.delete(close); release(); offTheme(); offKeys();
      dialog.close(); dialog.remove();
      if (error) reject(error); else resolve(value === true);
    }
    adapter?.dialogs.add(close);
    cancel.onclick=()=>close();
    dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
    dialog.addEventListener('close',()=>close());
    confirm.onclick=()=>{
      try {
        if (!editor.isConnected || editor.value!==original || editor.readOnly || editor.disabled ||
            adapter && (node._ppHistoryRefinement !== adapter || !adapter.alive() || adapter.revision() !== revision || adapter.state() !== baseline))
          throw new Error('The target prompt or draft changed. Review the replacement again.');
        apply(editor,text); close(true);
      } catch(error) { close(false, error); }
    };
    dialog.showModal();cancel.focus();
  });
}
export function applyHistoryText(editor,text) {
  if (!editor.__ppPromptTools?.apply) throw new Error('This target does not expose Prompt Palette undo support. Open its editor first.');
  editor.focus({preventScroll:true});editor.__ppPromptTools.apply(text,text.length,text.length);editor.dispatchEvent(new Event('input',{bubbles:true}));
}

export function historyTargetEditor(node, fallback, channel='positive') {
  const active=node?._ppActiveRecipeEditor;
  const activeChannel=active?.closest?.('.pp-recipe-field')?.querySelector('[data-channel]')?.dataset.channel;
  if(active?.isConnected && activeChannel===channel) return active;
  if(channel==='positive') return fallback;
  const editor=node?.widgets?.find(widget=>widget.name==='negative_text')?.inputEl;
  if(editor?.isConnected && editor.__ppPromptTools?.apply) return editor;
  throw new Error('Open and focus a negative field in the Fields workspace before restoring negative text.');
}
