import { createEditorShell } from "./shell.js";
import { setToolbarLabel, installToolbarLayout } from "./toolbar.js";
import { createPowerToolsController } from "./power_tools_controller.js";
import { createPerformanceRuntime } from "./performance_runtime.js";
import { getPowerToolPreferences } from "../prompt_palette_state.js";
import { buildResolvedDiff } from "../prompt_palette_power_tools.js";
import { API } from "../prompt_palette_api.js";
import { dialogConfirm } from "./dialogs.js";
import { loadTheme, saveTheme } from "./preferences.js";
import { notify } from "./notifications.js";
import { createLibraryEntryEditor } from "./library_entry_editor.js";
import { positiveAntonymsEnabled } from "./positive_antonyms.js";

// Reuse the Editor's actual tool markup and controllers. Generation controls and
// batch execution remain owned by the Combinatorial node.
export function mountCombinatorialTools(root, settingsPopup) {
  const shell = createEditorShell();
  const take = name => shell.querySelector(`[data-el="${name}"]`);
  const toolbar = document.createElement("div"); toolbar.className = "wg-toolbar pp-combo-tools";
  const primary = document.createElement("div"); primary.className = "wg-toolbar-group left";
  primary.setAttribute("aria-label", "Prompt tools");
  primary.appendChild(root.querySelector('[data-el="btnGallery"]'));
  for (const name of ["btnEdit", "btnImportImage", "btnRecipes"]) primary.appendChild(take(name));
  toolbar.appendChild(primary);
  toolbar.appendChild(shell.querySelector(".wg-toolbar-center"));
  const actions = document.createElement("div"); actions.className = "wg-toolbar-group right";
  actions.setAttribute("aria-label", "Prompt Palette utilities");
  actions.appendChild(root.querySelector('[data-el="btnRefresh"]'));
  for (const name of ["btnUndo", "btnRedo", "btnCopy", "btnClear"]) actions.appendChild(take(name));
  actions.append(...root.querySelector(".pp-header-actions").children);
  root.querySelector(".pp-header-actions").remove();
  toolbar.appendChild(actions); root.querySelector(".pp-header").after(toolbar);
  root.querySelector(".wg-editor-wrap").appendChild(take("resolvedView"));
  for (const name of ["doctorPopup", "variationPopup", "libraryManagerPopup", "recipeBuilderPopup"]) root.querySelector(".wg-main").appendChild(take(name));
  root.querySelector(".wg-main").appendChild(shell.querySelector('[data-drawer="edit"]'));
  root.querySelector(".wg-drawer-head-actions").appendChild(take("libraryManagerBtn"));
  const recipeBuilder = root.querySelector('[data-el="btnRecipes"]').cloneNode(true);
  recipeBuilder.removeAttribute("data-el"); recipeBuilder.dataset.act = "buildRecipe";
  recipeBuilder.title = "Build a recipe from this prompt's library entries";
  recipeBuilder.setAttribute("aria-label", "Build a recipe from this prompt's library entries");
  root.querySelector(".wg-drawer-head-actions").appendChild(recipeBuilder);
  const tab = shell.querySelector('[data-settings-tab="power"]');
  settingsPopup.querySelector(".wg-settings-nav").appendChild(tab);
  const panel = shell.querySelector('[data-settings-panel="power"]');
  // Only move the controls implemented by the shared power-tools controller.
  const compact = document.createElement("section"); compact.className = "wg-settings-panel";
  compact.dataset.settingsPanel = "power"; compact.setAttribute("role", "tabpanel");
  for (const element of [...panel.children]) {
    if (element.classList.contains("wg-section-divider")) break;
    compact.appendChild(element);
  }
  settingsPopup.querySelector(".wg-settings-body").appendChild(compact);
  settingsPopup.querySelector('[data-settings-panel="behavior"]').appendChild(take("toggleImportImageBtn").closest(".wg-toggle-card"));
  settingsPopup.querySelector('[data-settings-panel="behavior"]').appendChild(take("toggleAnimaArtistFormatting").closest(".wg-toggle-card"));
  settingsPopup.querySelector('[data-settings-panel="behavior"]').appendChild(take("toolbarDesigner"));
}

export function createCombinatorialTools(ctx) {
  const { node, root, settingsPopup, el, textarea, seedWidget, ioRail, getLibrary, getKnown,
    previewCache, expandedCats, searchInput, closeSettings, closePickerDrawer, openPickerDrawer,
    syncControlsFromWidgets, refreshLibrary, renderPickerList, applyEdit, undo, redo } = ctx;
  const runtime = createPerformanceRuntime({ node, root });
  const cleanupToolbarLayout = installToolbarLayout(root, { loadTheme, saveTheme, settingsRoot: settingsPopup });
  const state = { powerTools: getPowerToolPreferences(), get libraryCache() { return getLibrary(); }, get knownSet() { return getKnown(); } };
  const editDrawer = root.querySelector('[data-drawer="edit"]');
  let disposed = false, editVersion = 0, previewVersion = 0;
  const editPanel = createLibraryEntryEditor({ drawer: editDrawer, el, getLibrary, getMatches: ctx.getMatches,
    onChanged: async path => { previewCache.delete(path); await refreshLibrary(); renderPickerList(searchInput.value); },
    onThumbnailChanged: () => refreshLibrary() });
  const showEditor = () => {
    previewVersion++; runtime.abortRequest("preview");
    el("editorReal").classList.remove("hidden"); el("resolvedView").classList.remove("on");
    el("btnResolve").classList.remove("on"); setToolbarLabel(el("btnResolve"), "Preview result");
    el("btnResolve").setAttribute("aria-pressed", "false");
  };
  function closeEditDrawer() {
    editVersion++; editPanel.suspend(); editDrawer.classList.remove("open"); editDrawer.hidden = true;
    editDrawer.setAttribute("aria-hidden", "true"); editDrawer.setAttribute("inert", "");
  }
  async function openEditForItem(path = "") {
    const request = ++editVersion;
    const opened = await editPanel.load(path, { confirm: true, existing: !!path });
    if (disposed || request !== editVersion) return;
    if (!opened) { if (el("editStatus").classList.contains("err")) notify("error", "Entry not opened", el("editStatus").textContent); return; }
    tools.closeAllPowerPopups(); closeSettings(); closePickerDrawer(); ioRail.close();
    editDrawer.hidden = false; editDrawer.removeAttribute("inert"); editDrawer.setAttribute("aria-hidden", "false"); editDrawer.classList.add("open");
    el("editName").focus();
  }
  async function refreshResolvedView() {
    if (!el("resolvedView").classList.contains("on")) return;
    const request = ++previewVersion, source = textarea.value, seed = seedWidget?.value ?? 0;
    const positiveAntonyms = positiveAntonymsEnabled(node);
    const workspaceRuntime = node.widgets?.find(w => w.name === "workspace_runtime")?.serializeValue?.() || "";
    const controller = runtime.beginRequest("preview");
    el("resolvedView").textContent = "Resolving…";
    try {
      const result = await API.resolve(source, seed, "entire text as one", { signal: controller.signal, positiveAntonyms, workspaceRuntime });
      if (disposed || request !== previewVersion || source !== textarea.value || seed !== (seedWidget?.value ?? 0) || positiveAntonyms !== positiveAntonymsEnabled(node) || workspaceRuntime !== (node.widgets?.find(w => w.name === "workspace_runtime")?.serializeValue?.() || "")) return;
      const fragment = document.createDocumentFragment();
      const segments = state.powerTools.resolvedDiff ? buildResolvedDiff(source, result.resolved) : [{ type: "same", text: result.resolved }];
      for (const segment of segments) {
        const span = document.createElement("span"); span.textContent = segment.text;
        if (segment.type === "changed") span.className = "wg-resolved-changed";
        fragment.appendChild(span);
      }
      el("resolvedView").replaceChildren(fragment);
      state.lastTokenStats = result.tokenStats; state.lastTokenStatsSource = source;
      el("tokenCount").textContent = result.tokenStats ? `${result.tokenStats.tokens} tokens` : "";
    } catch (error) {
      if (!disposed && request === previewVersion && error.name !== "AbortError") el("resolvedView").textContent = error.message;
    } finally { runtime.endRequest("preview", controller); }
  }
  const toolNames = ["doctorPopup", "variationPopup", "libraryManagerPopup", "recipeBuilderPopup", "doctorChip", "doctorLabel", "doctorSummary", "doctorList", "btnVariations", "libraryManagerBtn", "editorReal", "resolvedView", "btnResolve", "variationStatus", "variationList", "variationCount", "seedInput", "libraryManagerSearch", "libraryManagerEntries", "libraryManagerSelectedCount", "libraryHealthSummary", "libraryHealthList", "recipeBuilderOperator", "recipeBuilderSeparator", "recipeBuilderPrefix", "recipeBuilderSuffix", "recipeBuilderPreview", "recipeBuilderList", "recipeBuilderName", "recipeBuilderStatus"];
  const tools = createPowerToolsController({
    node, root, settingsPopup, el, state, ioRail, textarea, seedWidget,
    ...Object.fromEntries(toolNames.map(name => [name, el(name)])),
    previewCache, expandedCats, searchInput, closeSettings, closePickerDrawer, closeEditDrawer,
    closeStash: () => {}, syncSeedControlsFromWidgets: syncControlsFromWidgets,
    refreshResolvedView, refreshLibrary, openEditForItem, renderPickerList, updateThemeJson: () => {},
    performanceRuntime: runtime, profiler: runtime.profiler,
  });
  const cleanups = [];
  function listen(target, type, fn) { target.addEventListener(type, fn); cleanups.push(() => target.removeEventListener(type, fn)); }
  function action(name, fn) {
    const button = root.querySelector(`[data-act="${name}"]`);
    listen(button, "click", () => Promise.resolve().then(fn).catch(error => { if (!disposed) notify("error", "Combinatorial", error.message); }));
  }
  action("resolve", () => {
    if (el("resolvedView").classList.contains("on")) { showEditor(); return; }
    node._ppRecipeWorkspace?.showEditor();
    el("editorReal").classList.add("hidden"); el("resolvedView").classList.add("on");
    el("btnResolve").classList.add("on"); setToolbarLabel(el("btnResolve"), "Back to editor");
    el("btnResolve").setAttribute("aria-pressed", "true"); return refreshResolvedView();
  });
  action("undo", undo); action("redo", redo);
  action("copy", () => navigator.clipboard.writeText(textarea.value));
  action("clear", async () => { if (await dialogConfirm({ title: "Clear prompt", message: "Clear this prompt? You can undo the change." })) applyEdit("", 0, 0); });
  action("edit", () => openEditForItem());
  action("recipesShortcut", () => { searchInput.value = "RECIPES"; openPickerDrawer(); renderPickerList(searchInput.value); });
  action("buildRecipe", () => tools.promptSaveRecipe([...new Set(ctx.getSourcePaths())]));
  action("closeEditDrawer", closeEditDrawer);
  listen(root, "keydown", event => { if (event.key === "Escape") { tools.closeAllPowerPopups(); closeEditDrawer(); showEditor(); } });
  const unsubscribe = API.onLibraryChanged(() => { state.lastTokenStats = null; tools.updateDoctorStatus(); if (el("resolvedView").classList.contains("on")) refreshResolvedView(); });
  tools.syncPowerToolSettingsUI(); tools.applyPowerToolSettings();
  return { ...tools, showEditor, refresh() {
    tools.syncPowerToolSettingsUI();
    tools.updateDoctorStatus();
    el("btnUndo").disabled = !ctx.canUndo(); el("btnRedo").disabled = !ctx.canRedo();
    if (el("resolvedView").classList.contains("on")) refreshResolvedView();
  }, cleanup() { disposed = true; previewVersion++; editVersion++; cleanupToolbarLayout(); unsubscribe(); cleanups.forEach(fn => fn()); editPanel.cleanup(); tools.cleanup(); runtime.cleanup(); } };
}
