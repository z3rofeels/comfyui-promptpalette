import { API } from "../prompt_palette_api.js";
import { setToolbarLabel } from "./toolbar.js";
import {
  analyzePromptSource, buildRecipeSource, summarizeLibraryHealth, extractPromptTokens,
} from "../prompt_palette_power_tools.js";
import {
  getPowerToolPreferences, setPowerToolPreference, replacePowerToolPreferences,
} from "../prompt_palette_state.js";
import { nodeIsActive, scheduleDomWidgetRemeasure, scheduleNodeFrame } from "../prompt_palette_compat.js";
import { dialogPrompt, dialogConfirm } from "./dialogs.js";
import { saveExpandedCats } from "./preferences.js";
import { escapeHtml, normalizeLibraryEntryPath, slugifyRecipeName } from "./text_utils.js";
import { notify } from "./notifications.js";
import { createToolRegistry } from "../tools/tool_registry.js";
import { ReversibleLibraryHistory } from "./undo_manager.js";
import { WORKSPACE_SCOPES, resolveExperiment } from "./recipe_experiment.js";
import { resolveFieldComparisons } from "./recipe_comparison.js";
import { fieldVariationSource, hasVariationSyntax } from "./recipe_variation_source.js";
import { positiveAntonymsEnabled, projectPositiveOutput, installPositiveAntonymsControl } from "./positive_antonyms.js";

export function createPowerToolsController(ctx) {
  const {
    node, root, settingsPopup, ioRail,
    doctorPopup, variationPopup, libraryManagerPopup, recipeBuilderPopup,
    doctorChip, doctorLabel, doctorSummary, doctorList,
    btnVariations, libraryManagerBtn, editorReal, resolvedView, btnResolve, textarea,
    variationStatus, variationList, variationCount, seedInput, seedWidget, modeWidget,
    libraryManagerSearch, libraryManagerEntries, libraryManagerSelectedCount, libraryHealthSummary, libraryHealthList,
    recipeBuilderOperator, recipeBuilderSeparator, recipeBuilderPrefix, recipeBuilderSuffix, recipeBuilderPreview,
    recipeBuilderList, recipeBuilderName, recipeBuilderStatus, previewCache, expandedCats, searchInput,
    closeSettings, closeStash, closePickerDrawer, closeEditDrawer,
    syncSeedControlsFromWidgets, refreshResolvedView, refreshLibrary, openEditForItem, renderPickerList, updateThemeJson, el,
    performanceRuntime, profiler,
  } = ctx;
  const settingsRoot = settingsPopup || root;
  const antonyms = installPositiveAntonymsControl({ node, root, settingsRoot, onChange: () => {
    variationRequestId++;
    clearResultView();
    if (resolvedView.classList.contains("on")) refreshResolvedView();
    if (variationPopup.classList.contains("open") && ctx.state.powerTools.variationLab) refreshVariations();
  } });

  const toolRegistry = createToolRegistry();
  toolRegistry.register({ id: "promptDoctor", elements: [doctorChip, doctorPopup], unmount: () => { closePowerPopup(doctorPopup); performanceRuntime?.cancelTimer("doctor"); } });
  toolRegistry.register({ id: "variationLab", elements: [btnVariations], unmount: () => closePowerPopup(variationPopup) });
  toolRegistry.register({ id: "libraryManager", elements: [libraryManagerBtn, libraryManagerPopup], unmount: () => closePowerPopup(libraryManagerPopup) });
  toolRegistry.register({ id: "recipeBuilder2", elements: [recipeBuilderPopup], unmount: () => closePowerPopup(recipeBuilderPopup) });
  toolRegistry.register({ id: "resolvedDiff", elements: [] });
  toolRegistry.register({ id: "nativeCommands", elements: [] });

  let currentDoctorAnalysis = { issues: [], counts: { error: 0, warning: 0, info: 0 }, status: "clean" };
  let currentLibraryHealth = null;
  const libraryManagerSelection = new Set();
  const libraryHistory = new ReversibleLibraryHistory({ limit: 30 });
  const libraryUndoBtn = root.querySelector('[data-act="libraryUndo"]');
  let recipeBuilderPaths = [];
  let recipeBuilderCompletion = null;
  let variationRequestId = 0;
  const cleanupLibrarySubscription = API.onLibraryChanged(() => {
    variationRequestId++;
    performanceRuntime?.abortRequest("variations");
    clearResultView();
    if (variationPopup.classList.contains("open")) setVariationStatus("Library changed. Resolve again to preview the current wildcard values.");
  });
  let libraryHealthRequestId = 0;
  let doctorAnalysisRequestId = 0;
  const resultControls = el("variationResults"), resultSummary = el("variationSummary"), uniqueOnly = el("variationUnique");
  const keptSummary = el("variationKept"), copyKept = el("variationCopyKept"), clearKept = el("variationClearKept");
  let keptItems = [], resetKept = null;
  clearKept.addEventListener("click", () => resetKept?.());
  copyKept.addEventListener("click", async () => {
    if (!keptItems.length) return;
    const count = keptItems.length, text = keptItems.map(item => String(item.outputPositive ?? item.resolved ?? "")).join("\n\n");
    const requestId = variationRequestId;
    try {
      await navigator.clipboard.writeText(text);
      if (requestId === variationRequestId) setVariationStatus(`${count} kept positive prompt${count === 1 ? "" : "s"} copied.`);
    } catch {
      if (requestId === variationRequestId) setVariationStatus("Clipboard permission was denied.", true);
    }
  });
  let updateResultVisibility = null;
  uniqueOnly.addEventListener("change", () => updateResultVisibility?.());
  function clearResultView() {
    updateResultVisibility = null;
    keptItems = []; resetKept = null;
    copyKept.disabled = clearKept.disabled = true;
    resultControls.hidden = true;
    variationList.replaceChildren();
  }
  function showResultView(items, onFilter = null) {
    const cards = [...variationList.querySelectorAll(":scope > .wg-variation-card")];
    const selected = new Set(), checks = [];
    const seen = new Map();
    const firstIndices = items.map((item, index) => {
      const key = JSON.stringify([String(item.outputPositive ?? item.resolved ?? ""), String(item.negative ?? "")]);
      if (!seen.has(key)) seen.set(key, index);
      return seen.get(key);
    });
    updateResultVisibility = () => {
      cards.forEach((card, index) => { card.hidden = uniqueOnly.checked && firstIndices[index] !== index; });
      resultSummary.textContent = `${seen.size} unique of ${items.length} previews${uniqueOnly.checked ? ` · ${items.length - seen.size} repeats hidden` : ""}`;
      keptItems = items.filter((_, index) => selected.has(index));
      const hiddenKept = cards.filter((card, index) => card.hidden && selected.has(index)).length;
      keptSummary.textContent = selected.size ? `${selected.size} kept${hiddenKept ? ` · ${hiddenKept} hidden by filter` : ""}` : "Keep previews to make a shortlist.";
      copyKept.disabled = clearKept.disabled = !selected.size;
      onFilter?.(selected.size ? keptItems : items.filter((_, index) => !cards[index].hidden), selected.size);
    };
    cards.forEach((card, index) => {
      const label = document.createElement("label"); label.className = "wg-variation-keep";
      label.title = "Keep this preview for copying or a workspace batch. Resolving again starts a new shortlist.";
      const input = document.createElement("input"); input.type = "checkbox";
      input.setAttribute("aria-label", `Keep preview ${index + 1}, seed ${items[index].seed}`);
      input.addEventListener("change", () => {
        if (input.checked) selected.add(index); else selected.delete(index);
        card.classList.toggle("is-kept", input.checked); updateResultVisibility();
      });
      label.append(input, document.createTextNode("Keep")); card.prepend(label); checks.push(input);
    });
    resetKept = () => {
      selected.clear(); checks.forEach(input => { input.checked = false; });
      cards.forEach(card => card.classList.remove("is-kept")); updateResultVisibility();
    };
    resultControls.hidden = !items.length;
    updateResultVisibility();
  }
  const scopeRow = document.createElement("label"); scopeRow.className = "pp-refine-field pp-workspace-scope"; scopeRow.hidden = true;
  const scopeLabel = document.createElement("span"); scopeLabel.textContent = "Workspace scope";
  const scopeSelect = document.createElement("select"); scopeSelect.className = "wg-theme-select"; scopeSelect.setAttribute("aria-label", "Workspace variation scope");
  WORKSPACE_SCOPES.forEach(([value, label]) => { const option = document.createElement("option"); option.value = value; option.textContent = label; scopeSelect.appendChild(option); });
  scopeRow.append(scopeLabel, scopeSelect); variationStatus.before(scopeRow);
  const strategyRow = document.createElement("label"); strategyRow.className = "pp-refine-field pp-workspace-scope"; strategyRow.hidden = true;
  const strategyLabel = document.createElement("span"); strategyLabel.textContent = "Explore";
  const strategySelect = document.createElement("select"); strategySelect.className = "wg-theme-select"; strategySelect.setAttribute("aria-label", "Variation strategy");
  for (const [value, label] of [["together", "Vary together"], ["one-field", "One field at a time"]]) {
    const option = document.createElement("option"); option.value = value; option.textContent = label; strategySelect.appendChild(option);
  }
  strategySelect.value = node.properties?.prompt_palette_variation_strategy_v1 === "one-field" ? "one-field" : "together";
  strategySelect.addEventListener("change", () => {
    node.properties ||= {}; node.properties.prompt_palette_variation_strategy_v1 = strategySelect.value;
    node.setDirtyCanvas?.(true, true); refreshVariations();
  });
  strategyRow.append(strategyLabel, strategySelect); scopeRow.after(strategyRow);
  const countLabel = variationCount.closest("label")?.querySelector("span");
  const workspacePlan = document.createElement("section"); workspacePlan.className = "pp-experiment-plan"; workspacePlan.hidden = true; scopeRow.after(workspacePlan);
  const labHeading = variationPopup.querySelector(".wg-panel-title h3"), labIntro = variationPopup.querySelector(".wg-panel-title p");
  scopeSelect.addEventListener("change", () => refreshVariations());
  function describeWorkspacePlan(workspace, plan = null, items = null) {
    workspacePlan.replaceChildren(); workspacePlan.hidden = !workspace;
    if (!workspace) return;
    const recipe = plan?.recipe || workspace.snapshot().recipe;
    const line = (text, className = "") => { const p = document.createElement("p"); p.className = className; p.textContent = text; workspacePlan.appendChild(p); return p; };
    line("1 Choose fields and their choices. 2 Preview seeds. 3 Apply a version or send the exact results to Combinatorial.", "pp-experiment-steps");
    if (!plan) { line("Choose Vary on at least one enabled field. Plain text needs choices or a __library_wildcard__ to produce alternatives."); return; }
    const targets = recipe.fields.filter(f => plan.primaryTargets.includes(f.id));
    line(`Exploring: ${targets.map(f => f.label).join(", ")}.`);
    if (plan.strategy === "one-field") {
      line("Baseline first, then one changed field per trial. All other resolved text, including Follow fields and text outside fields, stays identical. Samples per field is a search budget; repeats are skipped.", "pp-experiment-note");
      line("The new batch starts with Fixed seed mode. Connect Seed list and the matching positive/negative list outputs to compare at the same sampler seed. Applying a field value keeps the rest of your authored workspace.", "pp-experiment-note");
      return;
    }
    const following = recipe.fields.filter(f => plan.targets.includes(f.id) && !plan.primaryTargets.includes(f.id));
    if (following.length) line(`Follow when a source changes: ${following.map(f => f.label).join(", ")}.`);
    const fixed = targets.filter(f => !hasVariationSyntax(fieldVariationSource(f)));
    if (fixed.length) {
      line(`One fixed value: ${fixed.map(f => f.label).join(", ")}. Vary cannot invent alternatives for plain text.`, "pp-experiment-warning");
      const jump = document.createElement("button"); jump.type = "button"; jump.className = "wg-button"; jump.textContent = `Set choices for ${fixed[0].label}`;
      jump.addEventListener("click", () => { closePowerPopup(variationPopup); workspace.configureChoices(fixed[0].id); }); workspacePlan.appendChild(jump);
    }
    if (plan.scope === "workspace") line("Entire Workspace also resamples dynamic text outside fields. Locked field results remain held.");
    line("Lock holds the captured result in these previews and exact batches. Apply updates targeted fields; Freeze current value in a field also fixes its generation value across seeds.", "pp-experiment-note");
    if (!items?.length) return;
    const unique = new Set(items.map(item => JSON.stringify([item.outputPositive ?? item.resolved, item.negative]))).size;
    if (unique === 1 && !fixed.length) line("These samples resolve alike. Your list may have one choice, nearby seeds may repeat, or a fixed-pick modifier may hold a choice. Check the source or sample more seeds.", "pp-experiment-warning");
    const held = recipe.fields.filter(f => plan.markers.some(m => m.id === f.id) && !plan.targets.includes(f.id));
    if (held.length) {
      const details = document.createElement("details"), summary = document.createElement("summary"); summary.textContent = `Held fixed during this preview (${held.length})`;
      const baseline = { ...items[0].baseline[0].fields, ...items[0].baseline[1].fields };
      details.className = "pp-experiment-held"; details.appendChild(summary);
      for (const f of held) { const p = document.createElement("p"); const label = document.createElement("strong"); label.textContent = `${f.label} · ${f.experimentState === "lock" ? "Lock" : "Outside scope"}`; const value = document.createElement("span"); value.textContent = baseline[f.id]; p.append(label, value); details.appendChild(p); }
      workspacePlan.appendChild(details);
    }
  }

  const powerPopupEntries = [doctorPopup, variationPopup, libraryManagerPopup, recipeBuilderPopup];
  function closePowerPopup(popup) {
    if (!popup?.classList.contains("open")) return;
    if (popup === variationPopup) { variationRequestId += 1; performanceRuntime?.abortRequest("variations"); }
    if (popup === libraryManagerPopup) {
      libraryHealthRequestId += 1;
      performanceRuntime?.abortRequest("library-health");
      performanceRuntime?.cancelTimer("library-manager-search");
    }
    if (popup === recipeBuilderPopup && recipeBuilderCompletion) {
      const finish = recipeBuilderCompletion;
      recipeBuilderCompletion = null;
      finish(false);
    }
    popup.classList.remove("open");
    popup.setAttribute("aria-hidden", "true");
    popup.setAttribute("inert", "");
    if (popup === doctorPopup) { doctorChip.setAttribute("aria-expanded", "false"); doctorChip.classList.remove("active"); }
    if (popup === variationPopup) { btnVariations.setAttribute("aria-expanded", "false"); btnVariations.classList.remove("active"); }
    if (popup === libraryManagerPopup) { libraryManagerBtn.setAttribute("aria-expanded", "false"); libraryManagerBtn.classList.remove("active"); }
    scheduleDomWidgetRemeasure(node);
  }
  function closeAllPowerPopups(except = null) {
    powerPopupEntries.forEach((popup) => { if (popup !== except) closePowerPopup(popup); });
    doctorChip?.classList.remove("active");
    btnVariations?.classList.remove("active");
    libraryManagerBtn?.classList.remove("active");
  }
  function openPowerPopup(popup) {
    if (!popup) return;
    ioRail.close();
    closeSettings();
    closeStash();
    closePickerDrawer();
    closeEditDrawer();
    closeAllPowerPopups(popup);
    popup.hidden = false;
    popup.removeAttribute("inert");
    popup.setAttribute("aria-hidden", "false");
    popup.classList.add("open");
    if (popup === doctorPopup) doctorChip.setAttribute("aria-expanded", "true");
    if (popup === variationPopup) btnVariations.setAttribute("aria-expanded", "true");
    if (popup === libraryManagerPopup) libraryManagerBtn.setAttribute("aria-expanded", "true");
    scheduleDomWidgetRemeasure(node);
  }

  function renderDoctorAnalysis() {
    const result = currentDoctorAnalysis;
    const counts = result.counts || { error: 0, warning: 0, info: 0 };
    doctorSummary.innerHTML = `
      <span class="wg-power-summary-pill"><span class="wg-severity-dot ${result.status}"></span><strong>${result.status === "clean" ? "Clean" : `${result.issues.length} check${result.issues.length === 1 ? "" : "s"}`}</strong></span>
      <span class="wg-power-summary-pill"><strong>${counts.error}</strong> errors</span>
      <span class="wg-power-summary-pill"><strong>${counts.warning}</strong> warnings</span>
      <span class="wg-power-summary-pill"><strong>${counts.info}</strong> notes</span>`;
    doctorList.innerHTML = "";
    if (!result.issues.length) {
      doctorList.innerHTML = '<div class="wg-empty-power">No obvious syntax or library problems found in this prompt.</div>';
      return;
    }
    result.issues.forEach((issue) => {
      const row = document.createElement("div");
      row.className = "wg-power-item";
      row.dataset.severity = issue.severity;
      row.innerHTML = `<div class="wg-power-item-head"><div class="wg-power-item-title"><span class="wg-severity-dot ${escapeHtml(issue.severity)}"></span>${escapeHtml(issue.title)}</div><span class="wg-badge">${escapeHtml(issue.severity)}</span></div><p>${escapeHtml(issue.detail)}</p>`;
      if (issue.fieldIds?.length) {
        const actions = document.createElement("div"); actions.className = "wg-power-actions";
        for (const id of issue.fieldIds) {
          const jump = document.createElement("button"); jump.type = "button";
          const workspace = node._ppRecipeWorkspace?.snapshot()?.recipe;
          jump.textContent = `Show ${workspace?.fields.find(f => f.id === id)?.label || "field"}`;
          jump.addEventListener("click", () => { closePowerPopup(doctorPopup); node._ppRecipeWorkspace?.focusField(id, issue.fieldToken); }); actions.appendChild(jump);
        }
        row.appendChild(actions);
      } else if (issue.token && Number.isFinite(issue.token.start)) {
        const actions = document.createElement("div");
        actions.className = "wg-power-actions";
        const jump = document.createElement("button");
        jump.type = "button";
        jump.textContent = "Show in editor";
        jump.addEventListener("click", () => {
          closePowerPopup(doctorPopup);
          editorReal.classList.remove("hidden");
          resolvedView.classList.remove("on");
          btnResolve.classList.remove("on");
          setToolbarLabel(btnResolve, "Preview result");
          textarea.focus({ preventScroll: true });
          textarea.setSelectionRange(issue.token.start, issue.token.end);
        });
        actions.appendChild(jump);
        row.appendChild(actions);
      }
      doctorList.appendChild(row);
    });
  }

  async function updateDoctorStatus() {
    if (!ctx.state.powerTools.promptDoctor) return;
    const requestId = ++doctorAnalysisRequestId;
    const text = textarea.value;
    const tokenCount = ctx.state.lastTokenStatsSource === text ? (ctx.state.lastTokenStats?.tokens ?? null) : null;
    let analysis = null;
    const workspace = node._ppRecipeWorkspace?.isActive() ? node._ppRecipeWorkspace : null;
    const workspaceKey = workspace ? JSON.stringify(workspace.snapshot().recipe) : null;
    if (workspace) analysis = workspace.analyze();
    const worker = ctx.state.workerClient;
    if (!analysis && worker?.shouldUseForPrompt?.(text)) {
      try { analysis = await worker.validate(text, tokenCount); } catch { analysis = null; }
    }
    if (!analysis) analysis = analyzePromptSource({ text, parsed: ctx.state.parsedPrompt, libraryEntries: ctx.state.libraryCache, tokenCount });
    if (requestId !== doctorAnalysisRequestId || textarea.value !== text || !ctx.state.powerTools.promptDoctor || workspace && (!workspace.isActive() || workspaceKey !== JSON.stringify(workspace.snapshot().recipe))) return;
    currentDoctorAnalysis = analysis;
    const count = currentDoctorAnalysis.issues.length;
    doctorChip.dataset.status = currentDoctorAnalysis.status;
    doctorLabel.textContent = currentDoctorAnalysis.status === "clean" ? "Doctor" : `${count} check${count === 1 ? "" : "s"}`;
    doctorChip.title = currentDoctorAnalysis.status === "clean" ? "Prompt Doctor: no obvious issues" : `Prompt Doctor: ${count} item${count === 1 ? "" : "s"} to review`;
    if (doctorPopup.classList.contains("open")) renderDoctorAnalysis();
  }

  function openDoctor() {
    if (!ctx.state.powerTools.promptDoctor) { notify("info", "Prompt Doctor is off", "Enable it in Settings → Power tools."); return; }
    updateDoctorStatus();
    renderDoctorAnalysis();
    openPowerPopup(doctorPopup);
    doctorChip.classList.add("active");
  }

  function setVariationStatus(message = "", isError = false) {
    variationStatus.textContent = message;
    variationStatus.className = `wg-status${isError ? " err" : ""}`;
  }
  function useVariationSeed(seed, { preview = false } = {}) {
    const value = Math.max(0, Math.trunc(Number(seed) || 0));
    seedInput.value = String(value);
    if (seedWidget) {
      seedWidget.value = value;
      if (typeof seedWidget.callback === "function") seedWidget.callback(value, node.graph?.canvas, node);
    }
    syncSeedControlsFromWidgets();
    if (preview) {
      closePowerPopup(variationPopup);
      if (!resolvedView.classList.contains("on")) btnResolve.click();
      else refreshResolvedView();
    }
  }
  function renderVariations(items, assertCurrent, didUseSeed) {
    variationList.innerHTML = "";
    if (!items.length) {
      variationList.innerHTML = '<div class="wg-empty-power">No variations were returned.</div>';
      return;
    }
    items.forEach((item, index) => {
      const card = document.createElement("article");
      card.className = "wg-variation-card";
      const tokens = Number(item?.token_stats?.tokens);
      const wildcardCount = Array.isArray(item?.wildcards) ? item.wildcards.length : 0;
      card.innerHTML = `<div class="wg-variation-meta"><strong>#${index + 1} · seed ${escapeHtml(String(item.seed ?? ""))}</strong><span>${Number.isFinite(tokens) ? `${tokens} tokens · ` : ""}${wildcardCount} wildcard${wildcardCount === 1 ? "" : "s"}</span></div><div class="wg-variation-text"></div><div class="wg-power-actions"><button type="button" data-use>Use seed</button><button type="button" data-preview>Use + preview</button><button type="button" data-copy>Copy resolved</button></div>`;
      card.querySelector(".wg-variation-text").textContent = String(item.outputPositive ?? item.resolved ?? "");
      card.querySelector("[data-use]").addEventListener("click", () => {
        try {
          assertCurrent(); useVariationSeed(item.seed); didUseSeed();
          setVariationStatus(`Seed ${item.seed} is now active. Your source choices are unchanged.`);
        } catch (error) { setVariationStatus(error.message, true); }
      });
      card.querySelector("[data-preview]").addEventListener("click", () => {
        try { assertCurrent(); useVariationSeed(item.seed, { preview: true }); didUseSeed(); }
        catch (error) { setVariationStatus(error.message, true); }
      });
      card.querySelector("[data-copy]").addEventListener("click", async () => {
        try { await navigator.clipboard.writeText(String(item.outputPositive ?? item.resolved ?? "")); setVariationStatus(`Variation ${index + 1} copied.`); }
        catch { setVariationStatus("Clipboard permission was denied.", true); }
      });
      variationList.appendChild(card);
    });
    showResultView(items);
  }
  async function refreshVariations() {
    if (!ctx.state.powerTools.variationLab) return;
    const requestId = ++variationRequestId;
    clearResultView();
    const source = textarea.value;
    const positiveAntonyms = positiveAntonymsEnabled(node);
    const seed = seedWidget?.value ?? 0;
    const mode = modeWidget?.value || "entire text as one";
    const count = Math.max(1, Math.min(16, Number(variationCount.value) || 4));
    const workspace = node._ppRecipeWorkspace?.isActive() ? node._ppRecipeWorkspace : null;
    scopeRow.hidden = !workspace;
    strategyRow.hidden = !workspace || scopeSelect.value === "selection";
    const strategy = workspace && scopeSelect.value !== "selection" ? strategySelect.value : "together";
    if (countLabel) countLabel.textContent = strategy === "one-field" ? "Samples per field" : "Versions";
    if (labHeading) labHeading.textContent = workspace ? "Explore choices without changing held fields" : "Resolve before you queue";
    if (labIntro) labIntro.textContent = workspace ? "Choices come from inline alternatives or library wildcards. Previewing does not edit or queue anything." : "Same source prompt, predictable seed steps. Nothing is generated.";
    describeWorkspacePlan(workspace);
    if (workspace && scopeSelect.value === "selection") {
      variationList.replaceChildren();
      try { await workspace.varySelection(); } catch (error) { setVariationStatus(error.message, true); }
      return;
    }
    let plan;
    try { if (workspace) { plan = workspace.experimentPlan(scopeSelect.value); plan.strategy = strategy; } }
    catch (error) { variationList.replaceChildren(); setVariationStatus(error.message, true); return; }
    if (workspace) describeWorkspacePlan(workspace, plan);
    const stillCurrent = () => requestId === variationRequestId
      && nodeIsActive(node)
      && variationPopup.classList.contains("open")
      && ctx.state.powerTools.variationLab
      && textarea.value === source
      && positiveAntonymsEnabled(node) === positiveAntonyms
      && (seedWidget?.value ?? 0) === seed
      && (modeWidget?.value || "entire text as one") === mode
      && !!node._ppRecipeWorkspace?.isActive() === !!workspace
      && (!workspace || strategySelect.value === strategy)
      && (!workspace || (workspace.isActive() && scopeSelect.value === plan.scope && (() => { try { workspace.assertPlan(plan); return true; } catch { return false; } })()));
    setVariationStatus(strategy === "one-field" ? "Capturing baseline and comparing fields…" : `Resolving ${count} versions…`);
    variationList.innerHTML = "";
    const requestController = performanceRuntime?.beginRequest("variations") || new AbortController();
    try {
      let comparison = null;
      const resolve = async () => {
        if (strategy === "one-field") {
          comparison = await resolveFieldComparisons(plan, seed, mode, count, API.resolveVariations, { signal: requestController.signal });
          return comparison.items;
        }
        return workspace ? resolveExperiment(plan, seed, mode, count, API.resolveVariations, { signal: requestController.signal }) : API.resolveVariations(source, seed, mode, count, { signal: requestController.signal });
      };
      let items = profiler ? await profiler.measureAsync("variations.resolve", resolve) : await resolve();
      if (positiveAntonyms) items = await Promise.all(items.map(async item => {
        const output = await projectPositiveOutput(item.resolved || "", true, { signal: requestController.signal });
        return { ...item, outputPositive: output.resolved, token_stats: output.tokenStats || item.token_stats };
      }));
      performanceRuntime?.endRequest("variations", requestController);
      if (!stillCurrent() || requestController.signal.aborted) {
        if (requestId === variationRequestId && variationPopup.classList.contains("open") && !requestController.signal.aborted) setVariationStatus("The prompt, workspace or seed changed. Resolve again to preview the current values.", true);
        return;
      }
      if (workspace) {
        describeWorkspacePlan(workspace, plan, items);
        renderWorkspaceVariations(workspace, plan, items, seed, mode);
        setVariationStatus(comparison
          ? `Baseline + ${items.length - 1} distinct trials · up to ${comparison.samples} samples per field.${comparison.unchanged.length ? ` No new sampled value: ${comparison.unchanged.join(", ")}.` : ""} Send the batch to compare images; nothing was queued.`
          : `${items.length} previews ready. Held values stay fixed; Use version keeps the original choices.`);
        return;
      }
      let acceptedSeed = seed;
      renderVariations(items, () => {
        if (requestId !== variationRequestId || !nodeIsActive(node) || !ctx.state.powerTools.variationLab ||
            textarea.value !== source || positiveAntonymsEnabled(node) !== positiveAntonyms || (seedWidget?.value ?? 0) !== acceptedSeed ||
            (modeWidget?.value || "entire text as one") !== mode || node._ppRecipeWorkspace?.isActive())
          throw new Error("The prompt or seed changed. Resolve again before using a preview.");
        if (node.inputs?.some(input => ["seed", "external_seed"].includes(input.name) && input.link != null))
          throw new Error("The seed is connected. Change its upstream value or disconnect it before using a preview seed.");
      }, () => { acceptedSeed = seedWidget?.value ?? 0; });
      const hasUnseeded = extractPromptTokens(source).some((token) => token.mode === "*" || token.mode === "~") || /\{[\*~][^{}]*\}/.test(source);
      setVariationStatus(hasUnseeded
        ? `${items.length} seed-stepped version${items.length === 1 ? "" : "s"}. Unseeded * / ~ syntax remains intentionally random. Nothing was queued.`
        : `${items.length} deterministic version${items.length === 1 ? "" : "s"}. No image generation was queued.`);
      if (items.length > 1 && new Set(items.map(item => String(item.outputPositive ?? item.resolved ?? ""))).size === 1)
        setVariationStatus(hasVariationSyntax(source)
          ? "These seeds produced the same result. Check your choices or resolve more versions; filtering repeats does not create new alternatives."
          : "This prompt has one fixed result. Add {choice A|choice B} or a library wildcard to explore alternatives.");
    } catch (error) {
      performanceRuntime?.endRequest("variations", requestController);
      if (error?.name === "AbortError" || requestController.signal.aborted || !stillCurrent()) return;
      setVariationStatus(error?.message || "Could not resolve variations.", true);
    }
  }
  function renderWorkspaceVariations(workspace, plan, items, seed, mode) {
    variationList.replaceChildren();
    const renderedRequestId = variationRequestId, outputMode = positiveAntonymsEnabled(node);
    const assertCurrent = () => {
      if (renderedRequestId !== variationRequestId || positiveAntonymsEnabled(node) !== outputMode || !nodeIsActive(node) || !ctx.state.powerTools.variationLab)
        throw new Error("This preview has expired. Resolve again before applying or sending it.");
      workspace.assertPlan(plan);
      if ((seedWidget?.value ?? 0) !== seed || (modeWidget?.value || "entire text as one") !== mode || scopeSelect.value !== plan.scope || strategySelect.value !== plan.strategy) throw new Error("The scope, strategy or seed changed. Refresh variations first.");
    };
    function action(text, run) {
      const button = document.createElement("button"); button.type = "button"; button.textContent = text;
      button.addEventListener("click", () => Promise.resolve().then(run).catch(error => setVariationStatus(error.message, true)));
      return button;
    }
    const seen = new Map();
    const versions = items.map((item, originalIndex) => {
      const key = JSON.stringify([item.outputPositive ?? item.resolved, item.negative]), duplicateOf = seen.get(key);
      if (!seen.has(key)) seen.set(key, originalIndex);
      const changed = item.changes.some(change => change.changed) || item.resolved !== items[0].resolved || item.negative !== items[0].negative;
      return { item, originalIndex, duplicateOf, priority: duplicateOf != null ? 2 : changed ? 0 : 1 };
    }).sort((a, b) => plan.strategy === "one-field" ? a.originalIndex - b.originalIndex : a.priority - b.priority || a.originalIndex - b.originalIndex);
    versions.forEach(({ item, originalIndex, duplicateOf }, index) => {
      const card = document.createElement("article"); card.className = "wg-variation-card";
      card.dataset.previewBaseline = String(originalIndex === 0);
      const title = document.createElement("strong"); title.textContent = `#${index + 1} · ${item.trial ? `${item.trial.label} · ` : ""}seed ${item.seed}`;
      if (item.trial) card.dataset.trialKind = item.trial.kind;
      const fields = document.createElement("div"); fields.className = "pp-refine-text pp-workspace-changes";
      const changed = item.changes.filter(change => change.changed), same = item.changes.filter(change => !change.changed);
      const status = document.createElement("span"); status.className = "pp-candidate-status"; status.dataset.changed = String(changed.length > 0); status.textContent = changed.length ? `${changed.length} field${changed.length === 1 ? "" : "s"} changed` : "No target value changed";
      if (item.trial?.kind === "baseline") status.textContent = "Reference · all trials compare against this";
      if (!changed.length) fields.textContent = item.trial?.kind === "baseline" ? "Reference prompt. Every trial holds this resolved context except for its named field." : "Same target values at this seed.";
      for (const change of changed) {
        const row = document.createElement("article"); row.className = "pp-candidate-change";
        const name = document.createElement("strong"); name.textContent = `${change.label}${change.channel === "negative" ? " (negative)" : ""}${!item.trial && plan.recipe.fields.find(f => f.id === change.id).experimentState === "follow" ? " · Follow activated" : ""}`;
        const before = document.createElement("div"); before.className = "pp-candidate-before"; before.textContent = `Before: ${change.resolvedBefore}`;
        const after = document.createElement("div"); after.className = "pp-candidate-after"; after.textContent = `After: ${change.after}`; row.append(name, before, after); fields.appendChild(row);
      }
      if (same.length) { const note = document.createElement("p"); note.className = "pp-candidate-same"; note.textContent = `Unchanged targets: ${same.map(change => change.label).join(", ")}.`; fields.appendChild(note); }
      const inactive = item.trial ? [] : plan.recipe.fields.filter(f => plan.targets.includes(f.id) && !Object.hasOwn(item.values, f.id));
      const waiting = document.createElement("p"); waiting.className = "pp-candidate-follow"; waiting.hidden = !inactive.length; waiting.textContent = `Held until a source changes: ${inactive.map(f => f.label).join(", ")}.`;
      const duplicate = duplicateOf == null ? null : versions.findIndex(v => v.originalIndex === duplicateOf) + 1;
      const repeated = document.createElement("p"); repeated.className = "pp-candidate-repeat"; repeated.hidden = duplicate == null; repeated.textContent = `Same resolved result as #${duplicate}.`;
      if (!changed.length && plan.scope === "workspace" && (item.resolved !== items[0].resolved || item.negative !== items[0].negative)) status.textContent = "Dynamic text outside fields changed";
      const preview = document.createElement("details"), summary = document.createElement("summary"); summary.textContent = "Resolved prompt";
      const text = document.createElement("div"); text.className = "wg-variation-text"; text.textContent = (item.outputPositive ?? item.resolved) + (item.negative ? `\n\nNegative:\n${item.negative}` : ""); preview.append(summary, text);
      const actions = document.createElement("div"); actions.className = "wg-power-actions";
      const apply = action(item.trial ? "Use field value" : "Use version", () => { assertCurrent(); workspace.applyVariation(plan, item.values); setVariationStatus(`Applied values to ${item.changes.map(change => change.label).join(", ")}. Original choices were kept. Press Resolve to explore again, or Restore choices in a field to return to its template. Held fields retain their authored text.`); });
      apply.disabled = item.trial?.kind === "baseline";
      apply.title = "Apply the selected values to target fields. Original choices stay available for future previews. Undo restores the previous workspace.";
      actions.append(apply,
        action(item.trial ? "Copy trial" : "Copy resolved", () => navigator.clipboard.writeText(item.trial
          ? `${item.trial.label} · seed ${item.seed}\n\nPositive:\n${item.outputPositive ?? item.resolved}\n\nNegative:\n${item.negative}`
          : item.outputPositive ?? item.resolved)));
      card.append(title, status, repeated, fields, waiting, preview, actions); variationList.appendChild(card);
    });
    let batchItems = [];
    const batch = action("Send to Combinatorial", async () => { assertCurrent(); const selected = batchItems.slice(); await workspace.sendVariations(plan, selected, seed); setVariationStatus(`${selected.length} exact version${selected.length === 1 ? "" : "s"} sent to a new Combinatorial node in preview order. Connect its existing outputs and queue normally.`); });
    batch.className = "wg-button";
    const note = document.createElement("p"); note.className = "pp-refine-note";
    note.textContent = "Negative changes travel with their matching positive prompts. Use Negative prompt list / Negative conditioning list for every trial; the single-value negative outputs return the first item.";
    variationList.appendChild(note);
    variationList.appendChild(batch);
    showResultView(versions.map(v => v.item), (selected, keptCount) => {
      batchItems = selected;
      const variedNegative = selected.some(item => item.negative !== selected[0]?.negative);
      batch.disabled = !selected.length;
      batch.title = "Send the exact resolved positive/negative pairs in preview order; nothing is queued.";
      note.hidden = !variedNegative;
      batch.textContent = `Send ${selected.length}${keptCount ? " kept" : ""} to Combinatorial`;
    });
  }
  function openVariations(scope = null) {
    root.dispatchEvent(new Event("pp-refinement-reset"));
    variationPopup.querySelector(".wg-settings-body")?.dispatchEvent(new CustomEvent("pp-refinement-owner", { detail: null }));
    variationPopup.querySelector(".wg-settings-body")?.classList.remove("pp-refine-active");
    const workspace = node._ppRecipeWorkspace;
    if (workspace?.isActive()) scopeSelect.value = scope || workspace.defaultScope();
    if (!ctx.state.powerTools.variationLab) { notify("info", "Variation Lab is off", "Enable it in Settings → Power tools."); return; }
    openPowerPopup(variationPopup);
    btnVariations.classList.add("active");
    refreshVariations();
  }

  let managerIndexRef = null;
  let managerSortedEntries = [];
  let managerRenderLimit = 120;
  function ensureManagerIndex() {
    if (managerIndexRef === ctx.state.libraryCache) return;
    managerIndexRef = ctx.state.libraryCache;
    managerSortedEntries = (ctx.state.libraryCache || [])
      .filter((item) => String(item?.type || "txt").toLowerCase() === "txt")
      .slice()
      .sort((a, b) => String(a.path || "").localeCompare(String(b.path || ""), undefined, { sensitivity: "base" }));
    profiler?.gauge("libraryManagerEntries", managerSortedEntries.length);
  }
  function managerVisibleEntries() {
    ensureManagerIndex();
    const query = String(libraryManagerSearch?.value || "").trim();
    if (!query) return managerSortedEntries;
    const search = () => ctx.state.libraryModel?.search?.(query, { limit: Math.max(300, ctx.state.libraryModel?.size?.() || 300) })
      ?.filter((item) => String(item?.type || "txt").toLowerCase() === "txt") || [];
    return profiler?.measure("library.manager.search", search) || search();
  }
  function syncLibraryManagerSelection() {
    const valid = new Set(ctx.state.libraryCache.map((item) => String(item?.path || "")));
    for (const path of [...libraryManagerSelection]) if (!valid.has(path)) libraryManagerSelection.delete(path);
    libraryManagerSelectedCount.textContent = `${libraryManagerSelection.size} selected`;
  }
  function renderLibraryManagerEntries() {
    syncLibraryManagerSelection();
    const entries = managerVisibleEntries();
    profiler?.measure("library.manager.render", () => {
      libraryManagerEntries.replaceChildren();
      if (!entries.length) {
        libraryManagerEntries.innerHTML = '<div class="wg-empty-power">No matching TXT-backed library entries.</div>';
        return;
      }
      const fragment = document.createDocumentFragment();
      for (const item of entries.slice(0, managerRenderLimit)) {
        const path = String(item.path || "");
        const row = document.createElement("div");
        row.className = "wg-manager-entry";
        row.dataset.path = path;
        row.innerHTML = `<span class="wg-manager-entry-main"><input class="wg-manager-entry-select" type="checkbox" aria-label="Select ${escapeHtml(path)}" ${libraryManagerSelection.has(path) ? "checked" : ""}><span class="wg-manager-entry-name" title="${escapeHtml(path)}">${escapeHtml(path)}</span></span><span class="wg-manager-entry-actions"><button type="button" data-manager-action="edit" title="Edit">✎</button><button type="button" data-manager-action="copy" title="Copy">⧉</button><button type="button" data-manager-action="rename" title="Rename / move">↪</button><button type="button" data-manager-action="delete" title="Delete">×</button></span>`;
        fragment.appendChild(row);
      }
      if (entries.length > managerRenderLimit) {
        const more = document.createElement("button");
        more.type = "button";
        more.className = "wg-virtual-more";
        more.dataset.managerMore = "true";
        more.textContent = `Load ${Math.min(120, entries.length - managerRenderLimit)} more · ${entries.length} matches`;
        fragment.appendChild(more);
      }
      libraryManagerEntries.appendChild(fragment);
    });
    profiler?.gauge("visibleLibraryManagerItems", Math.min(entries.length, managerRenderLimit));
  }

  function syncLibraryUndoButton() {
    if (!libraryUndoBtn) return;
    libraryUndoBtn.disabled = !libraryHistory.canUndo();
    const entry = libraryHistory.peek();
    libraryUndoBtn.title = entry ? `Undo: ${entry.label || "last library change"}` : "Nothing safely reversible to undo";
  }

  function rememberLibraryChange(label, undo) {
    libraryHistory.push({ label, undo });
    syncLibraryUndoButton();
  }

  async function undoLibraryChange() {
    if (!libraryHistory.canUndo()) return;
    libraryUndoBtn.disabled = true;
    const result = await libraryHistory.undo();
    syncLibraryUndoButton();
    if (!result.ok) return notify("error", "Library undo failed", result.error || "Could not undo the last library change.");
    await refreshLibrary(); await loadLibraryHealth();
    notify("success", "Library change undone", result.label || "Previous library change restored.");
  }

  libraryManagerEntries.addEventListener("change", (event) => {
    const checkbox = event.target.closest(".wg-manager-entry-select");
    const path = checkbox?.closest(".wg-manager-entry[data-path]")?.dataset.path;
    if (!path) return;
    if (checkbox.checked) libraryManagerSelection.add(path); else libraryManagerSelection.delete(path);
    syncLibraryManagerSelection();
  });
  libraryManagerEntries.addEventListener("click", async (event) => {
    const more = event.target.closest("[data-manager-more]");
    if (more) { managerRenderLimit += 120; renderLibraryManagerEntries(); return; }
    const action = event.target.closest("[data-manager-action]")?.dataset.managerAction;
    const path = event.target.closest(".wg-manager-entry[data-path]")?.dataset.path;
    if (!action || !path) return;
    if (action === "edit") { closePowerPopup(libraryManagerPopup); openEditForItem(path); return; }
    if (action === "copy") {
      const requested = await dialogPrompt({ title: "Copy library entry", message: "Copy to a new My Library path:", defaultValue: `${path}-copy` });
      if (requested == null) return;
      const target = normalizeLibraryEntryPath(requested);
      if (!target) return notify("error", "Copy failed", "Enter a valid My Library path.");
      const result = await API.libraryAction("copy", path, target);
      if (!result.ok) return notify("error", "Copy failed", result.error || "The entry could not be copied.");
      rememberLibraryChange(`copy ${path} → ${target}`, async () => API.libraryAction("delete", target, ""));
      await refreshLibrary(); await loadLibraryHealth();
      notify("success", "Library entry copied", `${path} → ${target}`);
      return;
    }
    if (action === "rename") {
      const requested = await dialogPrompt({ title: "Rename or move library entry", message: "Choose a new My Library path:", defaultValue: path });
      if (requested == null) return;
      const target = normalizeLibraryEntryPath(requested);
      if (!target || target === path) return;
      const result = await API.libraryAction("rename", path, target);
      if (!result.ok) return notify("error", "Rename failed", result.error || "The entry could not be renamed.");
      libraryManagerSelection.delete(path);
      rememberLibraryChange(`rename ${path} → ${target}`, async () => API.libraryAction("rename", target, path));
      await refreshLibrary(); await loadLibraryHealth();
      notify("success", "Library entry renamed", `${path} → ${target}`);
      return;
    }
    if (action === "delete") {
      const ok = await dialogConfirm({ title: "Delete library entry", message: `Delete “${path}”? This removes its TXT file and matching thumbnail.` });
      if (!ok) return;
      const result = await API.libraryAction("delete", path, "");
      if (!result.ok) return notify("error", "Delete failed", result.error || "The entry could not be deleted.");
      libraryManagerSelection.delete(path);
      await refreshLibrary(); await loadLibraryHealth();
      notify("success", "Library entry deleted", path);
    }
  });
  async function runLibraryBatch(action, destination, successTitle) {
    const sources = [...libraryManagerSelection];
    if (!sources.length) { notify("info", "Nothing selected", "Select one or more TXT-backed entries first."); return; }
    const result = await API.libraryBatch(action, sources, destination);
    if (!result.ok) { notify("error", `${successTitle} failed`, result.error || "The batch action could not be completed."); return; }
    const completed = Array.isArray(result.items) ? result.items.map((item) => ({ source: String(item.source || ""), target: String(item.target || "") })).filter((item) => item.source && item.target) : [];
    if (completed.length) {
      if (action === "copy_to_folder") {
        rememberLibraryChange(`${successTitle.toLowerCase()} (${completed.length})`, async () => {
          for (const item of [...completed].reverse()) {
            const undoResult = await API.libraryAction("delete", item.target, "");
            if (!undoResult.ok) return undoResult;
          }
          return { ok: true };
        });
      } else {
        rememberLibraryChange(`${successTitle.toLowerCase()} (${completed.length})`, async () => {
          const reversed = [];
          for (const item of [...completed].reverse()) {
            const undoResult = await API.libraryAction("rename", item.target, item.source);
            if (!undoResult.ok) {
              for (const rollback of reversed.reverse()) await API.libraryAction("rename", rollback.source, rollback.target);
              return undoResult;
            }
            reversed.push(item);
          }
          return { ok: true };
        });
      }
    }
    libraryManagerSelection.clear();
    await refreshLibrary(); await loadLibraryHealth();
    notify("success", successTitle, `${result.items?.length || sources.length} entr${sources.length === 1 ? "y" : "ies"} updated.`);
  }
  async function promptLibraryBatchFolder(action, title) {
    if (!libraryManagerSelection.size) return notify("info", "Nothing selected", "Select one or more TXT-backed entries first.");
    const raw = await dialogPrompt({ title, message: "Destination folder inside My Library:", defaultValue: "organized" });
    if (raw == null) return;
    const folder = normalizeLibraryEntryPath(raw);
    if (!folder) {
      return notify("error", "Invalid folder", "Use a normal My Library folder path without wildcards or filesystem traversal.");
    }
    await runLibraryBatch(action, folder, action === "copy_to_folder" ? "Entries copied" : "Entries moved");
  }

  function renderLibraryHealth(payload) {
    currentLibraryHealth = payload || {};
    libraryHealthSummary.innerHTML = summarizeLibraryHealth(currentLibraryHealth).map((item) => `<div class="wg-health-card"><strong>${item.count}</strong><span>${escapeHtml(item.label)}</span></div>`).join("");
    renderLibraryManagerEntries();
    libraryHealthList.innerHTML = "";
    const sections = [];
    (currentLibraryHealth.emptyEntries || []).forEach((item) => sections.push({ severity: "warning", title: "Empty entry", detail: item.path }));
    (currentLibraryHealth.duplicateGroups || []).forEach((item) => sections.push({ severity: "info", title: `Duplicate content · ${item.count} entries`, detail: (item.paths || []).join(" · ") }));
    (currentLibraryHealth.brokenRecipes || []).forEach((item) => sections.push({ severity: "error", title: `Broken recipe · ${item.path}`, detail: `Missing: ${(item.missing || []).join(", ")}` }));
    (currentLibraryHealth.orphanThumbnails || []).forEach((item) => sections.push({ severity: "warning", title: "Orphan thumbnail", detail: item.file, orphan: item.file }));
    if (!sections.length) {
      libraryHealthList.innerHTML = '<div class="wg-empty-power">Library audit is clean. No empty entries, duplicate content groups, broken recipe references, or orphan thumbnails were found.</div>';
      return;
    }
    sections.forEach((item) => {
      const row = document.createElement("div");
      row.className = "wg-power-item";
      row.innerHTML = `<div class="wg-power-item-title"><span class="wg-severity-dot ${item.severity}"></span>${escapeHtml(item.title)}</div><p>${escapeHtml(item.detail)}</p>`;
      if (item.orphan) {
        const actions = document.createElement("div");
        actions.className = "wg-power-actions";
        const remove = document.createElement("button");
        remove.className = "danger";
        remove.textContent = "Remove thumbnail";
        remove.addEventListener("click", async () => {
          const ok = await dialogConfirm({ title: "Remove orphan thumbnail", message: `Delete “${item.orphan}”?` });
          if (!ok) return;
          const result = await API.libraryAction("remove_orphan_thumbnail", item.orphan, "");
          if (!result.ok) return notify("error", "Thumbnail not removed", result.error || "The file could not be removed.");
          await loadLibraryHealth();
          notify("success", "Orphan thumbnail removed", item.orphan);
        });
        actions.append(remove); row.append(actions);
      }
      libraryHealthList.appendChild(row);
    });
  }
  async function loadLibraryHealth() {
    const requestId = ++libraryHealthRequestId;
    const stillCurrent = () => requestId === libraryHealthRequestId
      && nodeIsActive(node)
      && libraryManagerPopup.classList.contains("open")
      && ctx.state.powerTools.libraryManager;
    libraryHealthSummary.innerHTML = '<div class="wg-health-card"><strong>…</strong><span>Scanning library</span></div>';
    const requestController = performanceRuntime?.beginRequest("library-health") || new AbortController();
    try {
      const payload = await profiler?.measureAsync("library.health", () => API.libraryHealth({ signal: requestController.signal }))
        ?? await API.libraryHealth({ signal: requestController.signal });
      performanceRuntime?.endRequest("library-health", requestController);
      if (!stillCurrent() || requestController.signal.aborted) return;
      renderLibraryHealth(payload);
    } catch (error) {
      performanceRuntime?.endRequest("library-health", requestController);
      if (error?.name === "AbortError" || requestController.signal.aborted || !stillCurrent()) return;
      libraryHealthSummary.innerHTML = "";
      libraryHealthList.innerHTML = `<div class="wg-power-item"><div class="wg-power-item-title"><span class="wg-severity-dot error"></span>Audit failed</div><p>${escapeHtml(error?.message || "Could not audit My Library.")}</p></div>`;
    }
  }
  function openLibraryManager() {
    if (!ctx.state.powerTools.libraryManager) { notify("info", "Library Manager is off", "Enable it in Settings → Power tools."); return; }
    openPowerPopup(libraryManagerPopup);
    libraryManagerBtn.classList.add("active");
    renderLibraryManagerEntries();
    loadLibraryHealth();
  }

  function recipeBuilderSource() {
    return buildRecipeSource({
      paths: recipeBuilderPaths,
      operator: recipeBuilderOperator.value,
      separator: recipeBuilderSeparator.value,
      prefix: recipeBuilderPrefix.value,
      suffix: recipeBuilderSuffix.value,
    });
  }
  function updateRecipeBuilderPreview() { recipeBuilderPreview.value = recipeBuilderSource(); }
  function moveRecipeIngredient(from, to) {
    if (from < 0 || to < 0 || from >= recipeBuilderPaths.length || to >= recipeBuilderPaths.length || from === to) return;
    const [item] = recipeBuilderPaths.splice(from, 1);
    recipeBuilderPaths.splice(to, 0, item);
    renderRecipeBuilderList();
  }
  function renderRecipeBuilderList() {
    recipeBuilderList.innerHTML = "";
    recipeBuilderPaths.forEach((path, index) => {
      const row = document.createElement("div");
      row.className = "wg-recipe-row";
      row.draggable = true;
      row.dataset.index = String(index);
      row.innerHTML = `<span class="wg-recipe-drag" title="Drag to reorder">⋮⋮</span><span class="wg-recipe-path" title="${escapeHtml(path)}">${escapeHtml(path)}</span><span class="wg-recipe-row-actions"><button type="button" data-up title="Move up">↑</button><button type="button" data-down title="Move down">↓</button><button type="button" data-remove title="Remove">×</button></span>`;
      row.querySelector("[data-up]").disabled = index === 0;
      row.querySelector("[data-down]").disabled = index === recipeBuilderPaths.length - 1;
      row.querySelector("[data-up]").addEventListener("click", () => moveRecipeIngredient(index, index - 1));
      row.querySelector("[data-down]").addEventListener("click", () => moveRecipeIngredient(index, index + 1));
      row.querySelector("[data-remove]").addEventListener("click", () => { recipeBuilderPaths.splice(index, 1); renderRecipeBuilderList(); });
      row.addEventListener("dragstart", (event) => { row.classList.add("dragging"); event.dataTransfer?.setData("text/plain", String(index)); });
      row.addEventListener("dragend", () => row.classList.remove("dragging"));
      row.addEventListener("dragover", (event) => { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = "move"; });
      row.addEventListener("drop", (event) => { event.preventDefault(); const from = Number(event.dataTransfer?.getData("text/plain")); moveRecipeIngredient(from, index); });
      recipeBuilderList.appendChild(row);
    });
    if (!recipeBuilderPaths.length) recipeBuilderList.innerHTML = '<div class="wg-empty-power">No recipe ingredients selected.</div>';
    updateRecipeBuilderPreview();
  }
  function openRecipeBuilder(paths) {
    if (!ctx.state.powerTools.recipeBuilder2) return Promise.resolve(false);
    if (recipeBuilderCompletion) {
      const finishPrevious = recipeBuilderCompletion;
      recipeBuilderCompletion = null;
      finishPrevious(false);
    }
    recipeBuilderPaths = Array.from(new Set((paths || []).map(String).filter(Boolean)));
    recipeBuilderName.value = "";
    recipeBuilderOperator.value = "seeded";
    recipeBuilderSeparator.value = ", ";
    recipeBuilderPrefix.value = "";
    recipeBuilderSuffix.value = "";
    recipeBuilderStatus.textContent = "";
    renderRecipeBuilderList();
    openPowerPopup(recipeBuilderPopup);
    scheduleNodeFrame(node, () => recipeBuilderName.focus({ preventScroll: true }));
    return new Promise((resolve) => { recipeBuilderCompletion = resolve; });
  }
  async function saveRecipeContent(rawName, content, ingredientCount) {
    const slug = slugifyRecipeName(rawName);
    if (!slug) {
      notify("error", "Recipe not saved", "Enter a valid name (letters, numbers, - or _).");
      return false;
    }
    const legacyMatch = Array.from(ctx.state.knownSet).find((path) => {
      const parts = String(path || "").split("/");
      const rootName = (parts.shift() || "").toLowerCase();
      return (rootName === "recipe" || rootName === "recipes") && parts.join("/").toLowerCase() === slug.toLowerCase();
    });
    const fullName = legacyMatch || `RECIPES/${slug}`;
    if ((await API.content(fullName, { fresh: true }))?.found) {
      const overwrite = await dialogConfirm({ title: "Overwrite Recipe", message: `“${fullName}” already exists — overwrite it?` });
      if (!overwrite) return false;
    }
    const res = await API.save(fullName, content);
    if (!res.ok) { notify("error", "Recipe not saved", res.error || "save failed"); return false; }
    previewCache.delete(fullName);
    await refreshLibrary();
    if (!expandedCats.has("RECIPES")) { expandedCats.add("RECIPES"); saveExpandedCats(expandedCats); }
    renderPickerList(searchInput.value);
    notify("success", "Palette Recipe saved", `__${fullName}__ → ${ingredientCount} entr${ingredientCount === 1 ? "y" : "ies"}`);
    return true;
  }

  function syncPowerToolSettingsUI() {
    antonyms.sync();
    settingsRoot.querySelectorAll("[data-power-tool]").forEach((input) => { input.checked = !!ctx.state.powerTools[input.dataset.powerTool]; });
    const enabledCount = Object.values(ctx.state.powerTools).filter(Boolean).length;
    const status = el("powerToolsStatus");
    if (status) status.textContent = `${enabledCount} of ${Object.keys(ctx.state.powerTools).length} optional tools enabled${ctx.state.powerTools.nativeCommands ? " · restart after changing command palette integration" : ""}.`;
  }
  function applyPowerToolSettings({ refreshPreview = false } = {}) {
    for (const key of Object.keys(ctx.state.powerTools)) toolRegistry.setEnabled(key, !!ctx.state.powerTools[key]);
    if (ctx.state.powerTools.promptDoctor && doctorChip) doctorChip.hidden = false;
    if (ctx.state.powerTools.variationLab && btnVariations) btnVariations.hidden = false;
    if (ctx.state.powerTools.libraryManager && libraryManagerBtn) libraryManagerBtn.hidden = false;
    if (ctx.state.powerTools.promptDoctor) updateDoctorStatus();
    syncPowerToolSettingsUI();
    if (refreshPreview && resolvedView.classList.contains("on")) refreshResolvedView();
    scheduleDomWidgetRemeasure(node);
  }

  const syncSharedPowerPreferences = () => {
    const previous = ctx.state.powerTools;
    ctx.state.powerTools = getPowerToolPreferences();
    applyPowerToolSettings({ refreshPreview: previous.resolvedDiff !== ctx.state.powerTools.resolvedDiff });
  };
  window.addEventListener("pp-power-tools-changed", syncSharedPowerPreferences);

  settingsRoot.querySelectorAll("[data-power-tool]").forEach((input) => {
    input.addEventListener("change", () => {
      const key = input.dataset.powerTool;
      setPowerToolPreference(key, input.checked);
      ctx.state.powerTools = getPowerToolPreferences();
      updateThemeJson();
      if (key === "nativeCommands") notify("info", "Command palette setting saved", "Restart ComfyUI to add or remove Prompt Palette commands. No keyboard shortcuts are assigned by Prompt Palette.");
    });
  });
  settingsRoot.querySelector('[data-act="powerToolsAllOn"]').addEventListener("click", () => {
    ctx.state.powerTools = replacePowerToolPreferences(Object.fromEntries(Object.keys(ctx.state.powerTools).map((key) => [key, true])));
    updateThemeJson();
    notify("info", "Power tools enabled", "Prompt Palette command-palette actions appear after restart; no keyboard shortcuts are assigned.");
  });
  settingsRoot.querySelector('[data-act="powerToolsAllOff"]').addEventListener("click", () => {
    ctx.state.powerTools = replacePowerToolPreferences({ selectionTools: ctx.state.powerTools.selectionTools !== false });
    updateThemeJson();
  });

  doctorChip.addEventListener("click", () => doctorPopup.classList.contains("open") ? closePowerPopup(doctorPopup) : openDoctor());
  btnVariations.addEventListener("click", () => variationPopup.classList.contains("open") ? closePowerPopup(variationPopup) : openVariations());
  libraryManagerBtn.addEventListener("click", (event) => { event.stopPropagation(); openLibraryManager(); });
  root.querySelector('[data-act="closeDoctor"]').addEventListener("click", () => closePowerPopup(doctorPopup));
  root.querySelector('[data-act="closeVariations"]').addEventListener("click", () => closePowerPopup(variationPopup));
  root.querySelector('[data-act="variationRefresh"]').addEventListener("click", refreshVariations);
  root.querySelector('[data-act="closeLibraryManager"]').addEventListener("click", () => closePowerPopup(libraryManagerPopup));
  root.querySelector('[data-act="libraryAuditRefresh"]').addEventListener("click", async () => { await refreshLibrary(); await loadLibraryHealth(); });
  libraryManagerSearch.addEventListener("input", () => {
    managerRenderLimit = 120;
    performanceRuntime?.debounce("library-manager-search", 35, renderLibraryManagerEntries, { visual: true });
  });
  root.querySelector('[data-act="librarySelectVisible"]').addEventListener("click", () => {
    managerVisibleEntries().forEach((item) => libraryManagerSelection.add(String(item.path || "")));
    renderLibraryManagerEntries();
  });
  libraryUndoBtn?.addEventListener("click", undoLibraryChange);
  root.querySelector('[data-act="libraryBulkClear"]').addEventListener("click", () => { libraryManagerSelection.clear(); renderLibraryManagerEntries(); });
  root.querySelector('[data-act="libraryBulkMove"]').addEventListener("click", () => promptLibraryBatchFolder("move_to_folder", "Move selected entries"));
  root.querySelector('[data-act="libraryBulkCopy"]').addEventListener("click", () => promptLibraryBatchFolder("copy_to_folder", "Copy selected entries"));
  root.querySelector('[data-act="libraryBulkPrefix"]').addEventListener("click", async () => {
    if (!libraryManagerSelection.size) return notify("info", "Nothing selected", "Select one or more TXT-backed entries first.");
    const raw = await dialogPrompt({ title: "Prefix selected entries", message: "Prefix each selected filename with:", defaultValue: "set_" });
    if (raw == null) return;
    const prefix = String(raw).trim();
    if (!prefix || /[\\/:*?"<>|]/.test(prefix)) return notify("error", "Invalid prefix", "Use a Windows-safe filename prefix.");
    await runLibraryBatch("add_prefix", prefix, "Entries renamed");
  });
  root.querySelector('[data-act="closeRecipeBuilder"]').addEventListener("click", () => closePowerPopup(recipeBuilderPopup));
  root.querySelector('[data-act="recipeBuilderCancel"]').addEventListener("click", () => closePowerPopup(recipeBuilderPopup));
  [recipeBuilderOperator, recipeBuilderSeparator, recipeBuilderPrefix, recipeBuilderSuffix].forEach((control) => control.addEventListener("input", updateRecipeBuilderPreview));
  root.querySelector('[data-act="recipeBuilderSave"]').addEventListener("click", async () => {
    if (!recipeBuilderPaths.length) { recipeBuilderStatus.textContent = "Add at least one library entry."; recipeBuilderStatus.className = "wg-status err"; return; }
    recipeBuilderStatus.textContent = "Saving…"; recipeBuilderStatus.className = "wg-status";
    try {
      const saved = await saveRecipeContent(recipeBuilderName.value, recipeBuilderSource(), recipeBuilderPaths.length);
      if (saved) {
        const finish = recipeBuilderCompletion;
        recipeBuilderCompletion = null;
        closePowerPopup(recipeBuilderPopup);
        finish?.(true);
      } else { recipeBuilderStatus.textContent = "Recipe was not saved."; recipeBuilderStatus.className = "wg-status err"; }
    } catch (error) { recipeBuilderStatus.textContent = error?.message || "Recipe could not be saved."; recipeBuilderStatus.className = "wg-status err"; }
  });

  async function promptSaveRecipe(paths) {
    const unique = Array.from(new Set(paths));
    if (!unique.length) return false;
    if (ctx.state.powerTools.recipeBuilder2) return await openRecipeBuilder(unique);
    const raw = await dialogPrompt({
      title: "Save Palette Recipe",
      message: `Name this Palette Recipe (combines ${unique.length} library entr${unique.length === 1 ? "y" : "ies"}):`,
      defaultValue: "",
    });
    if (raw === null || raw === undefined) return false;
    return saveRecipeContent(raw, unique.map((path) => `__${path}__`).join(", "), unique.length);
  }
  return {
    closeAllPowerPopups,
    updateDoctorStatus,
    openDoctor,
    openVariations,
    openSelectionLab: () => openPowerPopup(variationPopup),
    openLibraryManager,
    applyPowerToolSettings,
    syncPowerToolSettingsUI,
    promptSaveRecipe,
    cleanup() { antonyms.cleanup(); cleanupLibrarySubscription(); window.removeEventListener("pp-power-tools-changed", syncSharedPowerPreferences); closeAllPowerPopups(); libraryHistory.clear(); toolRegistry.cleanup(); scopeRow.remove(); strategyRow.remove(); workspacePlan.remove(); },
    toolRegistry,
  };
}
