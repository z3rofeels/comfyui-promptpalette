import { sidebarTargets, sidebarTextNeedsResolution } from "./sidebar_targets.js";
import { app } from "../../../scripts/app.js";
import { API } from "../prompt_palette_api.js";
import { onPromptPaletteCommandTargetsChanged } from "../prompt_palette_command_bus.js";
import { applyPromptPaletteThemeScope, onPromptPaletteAppearanceChanged, installPromptPaletteKeyboardBoundary, navigatePromptPaletteTabs, svgIcon } from "../prompt_palette_shared.js";
import { readSuiteAppearanceSnapshot } from "./suite_appearance.js";
import { loadPinned, savePinned, onLibraryPinsChanged, loadSidebarDisplay, saveSidebarDisplay, sidebarDisplayMetrics } from "./preferences.js";
import { createPromptUsageStore } from "../prompt_quickness.js";
import { PromptLibraryModel } from "../library/library_model.js";
import { VirtualCollectionManager } from "../library/virtual_collection.js";
import { libraryEditShell } from "./library_edit_shell.js";
import { createLibraryEntryEditor } from "./library_entry_editor.js";
import { getPowerToolPreferences, setPowerToolPreference } from "../prompt_palette_state.js";
import { SYNTAX_GUIDE_GROUPS, syntaxGuideInfo } from "./syntax_guide.js";
import { INJECT_MODIFIERS, INJECT_TEMPLATES } from "./injector.js";
import { syntaxTone, syntaxCodeHtml } from "./syntax_presentation.js";
import { categoryOf, hashStr, categoryColorFromHue, isRecipeCategory, wildcardInsertionText } from "./text_utils.js";
import { openPromptTools } from "./prompt_tools_panel.js";
import { editorStylesReady } from "./styles.js";
import { createStyleExplorer } from "./style_explorer.js";
import { createSidebarQuickPreview } from "./sidebar_preview.js";
import { styleInsertionAtSelection } from "./style_library_model.js";

const TAB_ID = "prompt-palette-library";
const session = { tab: "library", search: "", folder: "", filter: "all", code: "{+a|b|c}", entry: null, entryOpen: false, syntaxWorkshop: false, guideIndex: null, guideSearch: "", targetNode: null, targetWidget: null };
const make = (tag, className = "", text = "") => { const el = document.createElement(tag); el.className = className; el.textContent = text; return el; };
function button(text, fn, className = "") { const el = make("button", className, text); el.type = "button"; el.addEventListener("click", fn); return el; }
function select(label, options) { const el = make("select"); el.setAttribute("aria-label", label); for (const [value, label] of options) { const opt = make("option", "", label); opt.value = value; el.append(opt); } return el; }

export function createPromptPaletteSidebar(container) {
  const root = make("section", "pp-main-sidebar wg-root"); root.setAttribute("aria-label", "Prompt Palette library and syntax");
  container.classList.add("pp-sidebar-host");
  container.append(root);
  // Node drawers use document outside-click handlers. A sidebar action is inside
  // the Prompt Palette workspace, so it must not immediately close what it opens.
  root.addEventListener("click", event => event.stopPropagation());
  const cleanups = [installPromptPaletteKeyboardBoundary(root)];
  // Some custom-tab hosts size to their content instead of supplying a definite
  // flex height. Keep our owned surface inside the visible viewport either way.
  const constrainHeight = () => {
    const rect = container.getBoundingClientRect();
    if (!rect.width) return;
    const limit = Math.max(0, document.documentElement.clientHeight - Math.max(0, rect.top));
    const value = `${limit}px`; if (root.style.maxHeight !== value) root.style.maxHeight = value;
  };
  const heightObserver = new ResizeObserver(constrainHeight);
  heightObserver.observe(container); heightObserver.observe(document.documentElement); constrainHeight();
  cleanups.push(() => { heightObserver.disconnect(); container.classList.remove("pp-sidebar-host"); });
  let disposed = false, libraryVersion = 0, previewVersion = 0, previewAbort = null;
  let currentNode = session.targetNode, currentWidget = session.targetWidget, lockedSelection = null, templateRange = session.code === "{+a|b|c}" ? [2, 7] : null, items = [], thumbnails = {};
  let appearance = readSuiteAppearanceSnapshot();
  const model = new PromptLibraryModel(), usage = createPromptUsageStore();
  let renderedTargets = [];
  const header = make("header", "pp-sidebar-head");
  const brand = make("div", "pp-sidebar-brand"); brand.innerHTML = `${svgIcon("gallery", 18)}<div><strong>Prompt Palette</strong></div>`;
  header.append(brand); root.append(header);
  const targetLabel = make("label", "pp-sidebar-target"); targetLabel.append(make("span", "", "Insert into"));
  const targets = select("Target prompt node or field", []); targetLabel.append(targets); root.append(targetLabel);
  const targetHint = make("p", "pp-sidebar-note pp-sidebar-target-hint pp-sr-only"); targetHint.id = `pp-sidebar-target-help-${createPromptPaletteSidebar.sequence}`; targets.setAttribute("aria-describedby", targetHint.id); root.append(targetHint);
  const tabs = make("nav", "pp-sidebar-tabs"); tabs.setAttribute("role", "tablist"); tabs.setAttribute("aria-label", "Prompt Palette sidebar sections"); root.append(tabs);
  const panes = new Map(), tabButtons = new Map();
  const message = make("div", "pp-sidebar-message"); message.setAttribute("role", "status"); message.setAttribute("aria-live", "polite");
  function announce(text, error = false) { message.textContent = text; message.classList.toggle("is-error", error); }
  const quickPreview = createSidebarQuickPreview(root, announce); cleanups.push(() => quickPreview.cleanup());
  const displayBar = make("div", "pp-sidebar-display"); tabs.after(displayBar);
  const layout = select("Sidebar layout", [["gallery", "Gallery"], ["list", "List"]]); displayBar.append(layout);
  const sizeLabel = make("label", "pp-sidebar-size"); sizeLabel.append(make("span", "pp-sidebar-size-caption", "Item size")); const size = make("input"); size.type = "range"; size.min = "10"; size.max = "150"; size.step = "1"; size.setAttribute("aria-label", "Sidebar item size");
  const sizeValue = make("output"); sizeLabel.append(size, sizeValue); displayBar.append(sizeLabel);
  let displayFrame = 0;
  function displayKey() { return session.tab === "styles" ? styleExplorer.displayKey() : "library"; }
  function syncDisplayControls() {
    displayBar.hidden = !["library", "styles"].includes(session.tab) || (session.tab === "library" && session.entryOpen);
    const state = loadSidebarDisplay(); layout.value = state.layouts[displayKey()] || "gallery"; size.value = String(Math.round(state.scale * 100)); sizeValue.textContent = `${size.value}%`;
  }
  function updateDisplay() {
    if (displayFrame) return;
    displayFrame = requestAnimationFrame(() => { displayFrame = 0; if (disposed) return; if (session.tab === "styles") styleExplorer.refreshAppearance(); else if (session.tab === "library") paintLibraryCollection(); });
  }
  layout.addEventListener("change", () => { saveSidebarDisplay({ layouts: { [displayKey()]: layout.value } }); quickPreview.hide(); updateDisplay(); });
  size.addEventListener("input", () => { saveSidebarDisplay({ scale: Number(size.value) / 100 }); sizeValue.textContent = `${size.value}%`; updateDisplay(); });
  cleanups.push(() => { if (displayFrame) cancelAnimationFrame(displayFrame); });
  function target() { return sidebarTargets(app.graph).find(t => t.node === currentNode && (t.widget || null) === currentWidget); }
  function selection() {
    const t = target();
    if (t?.handlers.sidebarSelection) return t.handlers.sidebarSelection();
    const editor = t?.handlers.sidebarEditor?.();
    if (!editor?.isConnected) throw new Error("Choose a prompt node or text field above.");
    if (editor.readOnly || editor.disabled || editor.getAttribute("aria-readonly") === "true" || editor.contentEditable === "false") throw new Error("Choose an editable prompt field in the node first.");
    return { editor, source: editor.value, start: editor.selectionStart ?? editor.value.length, end: editor.selectionEnd ?? editor.value.length };
  }
  async function insert(text, range = null, captured = null) {
    try {
      const t = target(), snap = captured || selection();
      if (!t?.handlers.sidebarInsert) throw new Error("Choose a target node first.");
      if (t.handlers.sidebarRequiresResolvedText && sidebarTextNeedsResolution(text)) {
        const seed = t.node.widgets?.find(w => w.name === "seed")?.value ?? 0;
        const data = await API.inspect(text, seed, "entire text as one");
        if (disposed || target() !== t) throw new Error("The target changed while resolving. Choose it again before inserting.");
        text = (text.match(/^\s*/)?.[0] || "") + (data.resolved || "") + (text.match(/\s*$/)?.[0] || ""); range = range ? [0, text.length] : null;
      }
      t.handlers.sidebarInsert(snap, text, range);
      lockedSelection = null; paintCode();
      captureInfo.textContent = "Inserted. The target text is selected when you choose Insert & edit in node.";
      announce("Inserted into the selected prompt field.");
      return true;
    } catch (error) { announce(error.message, true); return false; }
  }
  async function insertLibrary(path) {
    try {
      const snap = selection();
      if (isRecipeCategory(categoryOf(path)) && target()?.handlers.sidebarUseLibraryEntry) {
        const t = target(); t.handlers.sidebarUseLibraryEntry(path); usage.recordLibrary(path);
        announce("Recipe sent to the selected node’s existing recipe tools."); return true;
      }
      const before = snap.source.slice(0, snap.start);
      const separator = target()?.handlers.sidebarRequiresResolvedText && snap.start === snap.end && /[\p{L}\p{N}_)\]]$/u.test(before) ? ", " : "";
      if (!await insert(separator + wildcardInsertionText(path, snap.source.slice(snap.end)), null, snap)) return false;
      usage.recordLibrary(path);
      if (filter.value === "recent") renderLibrary();
      return true;
    } catch (error) { announce(error.message, true); return false; }
  }
  async function run(command, preference = null) {
    try {
      const t = target(); if (!t) throw new Error("Choose a target node first.");
      const handler = t.handlers[command]; if (typeof handler !== "function") throw new Error("This tool is unavailable for the selected node.");
      if (preference && !getPowerToolPreferences()[preference]) setPowerToolPreference(preference, true);
      await handler();
      refreshToolCards();
      announce("Opened the tool in the selected node.");
    } catch (error) { announce(error.message, true); }
  }
  function activate(tab) {
    session.tab = panes.has(tab) ? tab : "library";
    for (const [key, pane] of panes) {
      pane.hidden = key !== session.tab;
      const active = key === session.tab, b = tabButtons.get(key);
      b.classList.toggle("active", active); b.setAttribute("aria-selected", String(active)); b.tabIndex = active ? 0 : -1;
    }
    quickPreview.hide(); syncDisplayControls();
    if (session.tab === "library") renderLibrary();
    if (session.tab === "tools") refreshToolCards();
    if (session.tab === "styles") styleExplorer.activate();
  }
  let sidebarSequence = ++createPromptPaletteSidebar.sequence;
  for (const [key, label] of [["library", "Library"], ["styles", "Styles"], ["syntax", "Syntax"], ["tools", "Tools"]]) {
    const pane = make("div", `pp-sidebar-pane pp-sidebar-${key}`); pane.id = `pp-sidebar-${sidebarSequence}-${key}`; pane.setAttribute("role", "tabpanel"); pane.tabIndex = 0;
    const tab = button(label, () => activate(key)); tab.id = `${pane.id}-tab`; tab.setAttribute("role", "tab"); tab.setAttribute("aria-controls", pane.id); pane.setAttribute("aria-labelledby", tab.id);
    tabs.append(tab); panes.set(key, pane); tabButtons.set(key, tab); root.append(pane);
  }
  tabs.addEventListener("keydown", event => navigatePromptPaletteTabs(event, [...tabButtons.values()], tab => { tab.click(); tab.focus(); }));
  root.append(message);
  const styleExplorer = createStyleExplorer(panes.get("styles"), { announce, onViewChanged: syncDisplayControls, insert: async (text, { replace = false } = {}) => {
    try {
      const snap = selection();
      if (replace) { snap.start = 0; snap.end = snap.source.length; }
      return await insert(replace ? text : styleInsertionAtSelection(text, snap), null, snap);
    } catch (error) { announce(error.message, true); return false; }
  } });
  cleanups.push(() => styleExplorer.cleanup());

  // Search and filter the same disk library. Virtual rows keep large libraries responsive.
  const libraryPane = panes.get("library"), browse = make("div", "pp-sidebar-browse"); libraryPane.append(browse);
  const search = make("input"); search.type = "search"; search.placeholder = "Search names and folders…"; search.setAttribute("aria-label", "Search My Library"); search.value = session.search;
  const folder = select("Library folder", [["", "All folders"]]);
  const filter = select("Library view", [["all", "All entries"], ["pins", "Pinned"], ["recent", "Recent"]]); filter.value = session.filter;
  const controls = make("div", "pp-sidebar-filters"); controls.append(folder, filter); browse.append(search, controls);
  const actions = make("div", "pp-sidebar-actions");
  const create = button("New entry", () => editEntry(""), "primary");
  const refresh = button("Rescan", async () => { quickPreview.invalidate(); refresh.disabled = true; try { await API.refreshWildcards(); await refreshLibrary(); } catch (error) { announce(error.message, true); } finally { if (!disposed) refresh.disabled = false; } });
  const categoryPreview = button("Quick view", () => quickPreview.show(folder.value || "All library categories", libraryMatches.slice(0, 3).map(item => item.path), { total: libraryMatches.length }));
  const resumeEntry = button("Resume edits", () => showEntry()); resumeEntry.hidden = true;
  actions.append(create, resumeEntry, refresh, categoryPreview); browse.append(actions);
  const libraryHint = make("p", "pp-sidebar-note pp-sidebar-library-hint", "Click to insert · pencil to edit"); browse.append(libraryHint);
  const count = make("small", "pp-sidebar-note"); browse.append(count);
  const list = make("div", "pp-sidebar-list"); list.tabIndex = 0; list.setAttribute("aria-label", "Library entries"); browse.append(list);
  const virtual = new VirtualCollectionManager(list);
  let libraryMatches = [], libraryPins = loadPinned(), libraryGeometry = "";
  const entryHost = make("div", "pp-sidebar-entry"); entryHost.innerHTML = libraryEditShell(); entryHost.hidden = true; libraryPane.append(entryHost);
  const el = key => entryHost.querySelector(`[data-el="${key}"]`);
  let entryEditor = null, hasEntryDraft = !!session.entry, insertEntry = null;
  function syncEntryState(state) {
    if (!entryEditor) return;
    const draft = entryEditor.snapshot(), saved = state?.baseline || draft.baseline;
    resumeEntry.hidden = !hasEntryDraft;
    resumeEntry.disabled = !!state?.loading || !!state?.busy;
    resumeEntry.textContent = `Resume ${saved.path?.split("/").pop() || "new entry"}${entryEditor.dirty() ? " · unsaved" : ""}`;
    resumeEntry.title = saved.path || "Continue the retained new entry";
    if (insertEntry) {
      insertEntry.disabled = !saved.found || draft.path !== saved.path || entryEditor.dirty() || !!state?.loading || !!state?.busy;
      insertEntry.title = insertEntry.disabled ? "Save your entry before using it in a prompt" : `Insert __${saved.path}__ into the selected prompt`;
    }
  }
  entryEditor = createLibraryEntryEditor({ drawer: entryHost, el, getLibrary: () => items,
    onChanged: () => refreshLibrary(), onThumbnailChanged: () => refreshLibrary(), onStateChange: syncEntryState });
  if (session.entry) { entryEditor.restoreDraft(session.entry); browse.hidden = session.entryOpen; entryHost.hidden = !session.entryOpen; }
  const backToLibrary = entryHost.querySelector('[data-act="closeEditDrawer"]');
  backToLibrary.className = "pp-sidebar-back";
  backToLibrary.innerHTML = `${svgIcon("undo", 15)}<span>Back to library</span>`;
  backToLibrary.title = "Return to the library. Use Resume to continue this draft; save to update the entry.";
  backToLibrary.setAttribute("aria-label", "Back to library");
  entryHost.prepend(backToLibrary);
  backToLibrary.addEventListener("click", () => {
    entryEditor.suspend(); session.entryOpen = false; browse.hidden = false; entryHost.hidden = true;
    syncEntryState(); syncDisplayControls(); renderLibrary();
    resumeEntry.focus({ preventScroll: true });
  });
  insertEntry = button("Use", () => {
    const draft = entryEditor.snapshot();
    if (!entryEditor.dirty() && draft.baseline.found) insertLibrary(draft.baseline.path);
  });
  insertEntry.setAttribute("aria-label", "Use saved wildcard");
  entryHost.querySelector(".pp-ledit-use").append(insertEntry);
  function showEntry({ focus = true } = {}) {
    quickPreview.hide(); session.entryOpen = true; browse.hidden = true; entryHost.hidden = false;
    syncEntryState(); syncDisplayControls();
    if (focus) (el("editName").value ? el("editContent") : el("editName")).focus({ preventScroll: true });
  }
  async function editEntry(path) {
    const draft = entryEditor.snapshot();
    if (hasEntryDraft && path && draft.baseline.path === path) { showEntry(); return; }
    quickPreview.hide();
    const opened = await entryEditor.load(path, { confirm: true, existing: !!path });
    if (disposed) return;
    if (!opened) {
      if (el("editStatus").classList.contains("err")) announce(el("editStatus").textContent, true);
      return;
    }
    hasEntryDraft = true; announce(""); showEntry();
  }
  syncEntryState();
  function renderRow(item) {
    const gallery = list.dataset.layout === "gallery";
    const row = make("div", "pp-sidebar-row"); row.dataset.path = item.path; row.classList.toggle("is-editing", hasEntryDraft && entryEditor.snapshot().baseline.path === item.path); row.classList.toggle("pp-sidebar-gallery-card", gallery);
    const theme = appearance.theme, cat = categoryOf(item.path);
    row.style.setProperty("--pp-entry-color", theme.categoryPins?.[cat] || categoryColorFromHue((hashStr(cat) % 360 + (Number(theme.hueRotate) || 0)) % 360, theme.saturation, appearance.colors.bg));
    if (thumbnails[item.path]) { const img = make("img", "pp-sidebar-thumb"); img.alt = ""; img.loading = "lazy"; img.decoding = "async"; img.src = API.thumbnailUrl(thumbnails[item.path]); row.append(img); }
    const copy = button("", () => insertLibrary(item.path), "pp-sidebar-row-copy");
    copy.setAttribute("aria-label", `Insert ${item.path}`);
    copy.append(make("strong", "", item.path.split("/").pop()), make("small", "", `${cat} · ${Number(item.count) || 0} options`)); copy.title = `Insert ${item.path} into the selected prompt`; row.append(copy);
    if (gallery && !thumbnails[item.path]) { const mark = make("div", "pp-sidebar-gallery-fallback", item.path.split("/").pop().slice(0, 2).toUpperCase()); row.prepend(mark); }
    quickPreview.bind(copy, item.path);
    const inspect = button("", () => quickPreview.show(item.path, [item.path], { anchor: inspect }), "pp-sidebar-icon"); inspect.innerHTML = svgIcon("eye", 14); inspect.setAttribute("aria-label", `Quick view ${item.path}`); inspect.title = "Inspect sample lines without editing"; row.append(inspect);
    const pins = libraryPins;
    const pin = button(pins.has(item.path) ? "★" : "☆", () => { const next = loadPinned(); if (next.has(item.path)) next.delete(item.path); else next.add(item.path); savePinned(next); }, "pp-sidebar-icon");
    pin.title = pins.has(item.path) ? "Unpin entry" : "Pin entry"; pin.setAttribute("aria-label", `${pin.title}: ${item.path}`); pin.setAttribute("aria-pressed", String(pins.has(item.path))); row.append(pin);
    const edit = button("", () => editEntry(item.path), "pp-sidebar-icon pp-sidebar-pencil");
    edit.innerHTML = svgIcon("edit", 16); edit.title = `Edit ${item.path}`;
    edit.setAttribute("aria-label", `Edit ${item.path}`); row.append(edit);
    return row;
  }
  function paintLibraryCollection() {
    if (disposed) return;
    const oldScroll = list.scrollTop, metrics = sidebarDisplayMetrics("library", appearance.theme.uiFontScale);
    const geometry = `${metrics.mode}|${metrics.scale}|${metrics.rowHeight}`;
    const anchor = geometry !== libraryGeometry ? virtual.captureViewportAnchor() : null;
    libraryGeometry = geometry;
    virtual.clear(); list.replaceChildren(); libraryPins = loadPinned();
    list.dataset.density = metrics.scale < .45 ? "micro" : "normal";
    list.dataset.layout = metrics.mode; list.style.setProperty("--pp-library-scale", metrics.scale); list.style.setProperty("--pp-library-font-scale", metrics.font); list.style.setProperty("--pp-library-row-height", `${metrics.rowHeight}px`);
    if (!libraryMatches.length) { list.append(make("p", "pp-sidebar-empty", items.length ? "No matching entries." : "No library entries yet. Create an entry here or set your library folder in ComfyUI Settings → Prompt Palette.")); return; }
    virtual.mount(list, { items: libraryMatches, renderItem: renderRow, estimateRowHeight: metrics.rowHeight, mode: metrics.mode === "gallery" ? "grid" : "list", minCardWidth: metrics.cardWidth, estimateCardHeight: metrics.cardWidth + Math.round(76 * metrics.font * (Number(appearance.theme.uiFontScale) || 1)) });
    list.scrollTop = oldScroll; virtual.restoreViewportAnchor(anchor); virtual.refresh();
  }
  function renderLibrary() {
    if (disposed) return;
    session.search = search.value; session.folder = folder.value; session.filter = filter.value;
    const pins = loadPinned(), recents = usage.libraryRecent(24);
    let matches = model.search(search.value, { limit: Math.max(1, model.size()), pinned: pins, recent: recents });
    if (folder.value) matches = matches.filter(item => item.path.startsWith(folder.value + "/"));
    if (filter.value === "pins") matches = matches.filter(item => pins.has(item.path));
    if (filter.value === "recent") { matches = matches.filter(item => recents.includes(item.path)); matches.sort((a, b) => recents.indexOf(a.path) - recents.indexOf(b.path)); }
    libraryMatches = matches;
    count.textContent = `${matches.length.toLocaleString()} of ${items.length.toLocaleString()} entries`; categoryPreview.disabled = !matches.length;
    paintLibraryCollection();
  }
  async function refreshLibrary() {
    quickPreview.invalidate();
    const request = ++libraryVersion;
    try {
      const [next, images] = await Promise.all([API.list(), API.categories()]);
      if (disposed || request !== libraryVersion) return;
      items = next; thumbnails = images || {}; model.rebuild(items, { buildSearchIndex: "token" });
      const selected = session.folder;
      folder.replaceChildren(new Option("All folders", ""));
      const folders = new Set();
      for (const item of items) { const parts = item.path.split("/"); for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join("/")); }
      for (const path of [...folders].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) folder.append(new Option(path, path));
      folder.value = folders.has(selected) ? selected : "";
      entryEditor.refresh(); renderLibrary();
    } catch (error) { if (!disposed && request === libraryVersion) announce(error.message, true); }
  }
  for (const input of [search, folder, filter]) input.addEventListener(input === search ? "input" : "change", () => { list.scrollTop = 0; renderLibrary(); });

  // Templates come directly from the node syntax injector. Drafts are plain authored syntax.
  const syntaxPane = panes.get("syntax");
  const guideView = make("div", "pp-sidebar-guide-view"), workshop = make("div", "pp-sidebar-workshop"); syntaxPane.append(guideView, workshop);
  const guideIntro = make("div", "pp-sidebar-intro");
  guideIntro.append(make("span", "pp-sidebar-eyebrow", "A little prompt magic"), make("h3", "", "What do you want to do?"), make("p", "pp-sidebar-note", "Open a group to explore ideas, then pick a card to make it your own. No syntax knowledge needed.")); guideView.append(guideIntro);
  const guideActions = make("div", "pp-sidebar-actions"); guideView.append(guideActions);
  const guideSearch = make("input"); guideSearch.type = "search"; guideSearch.placeholder = "Find an idea: random, lighting, if…"; guideSearch.setAttribute("aria-label", "Search syntax guide"); guideSearch.value = session.guideSearch; guideView.append(guideSearch);
  const catalog = select("Syntax template", [["", "Choose syntax…"]]);
  const quickJump = make("details", "pp-sidebar-quickjump"); quickJump.append(make("summary", "", "Know the syntax? Quick jump"), catalog); guideView.append(quickJump);
  const snippetRows = [...INJECT_MODIFIERS.map(mod => ({ label: `Wildcard · ${mod.label}`, desc: mod.desc, wildcard: true, build: () => ({ prefix: "", editable: mod.build("category/name"), suffix: "" }) })), ...INJECT_TEMPLATES];
  const guideList = make("div", "pp-sidebar-guide-list"); guideView.append(guideList);
  const guideEmpty = make("p", "pp-sidebar-empty", "No matching ideas. Try “choice”, “list”, or “condition”."); guideEmpty.hidden = true; guideView.append(guideEmpty);
  const guideCards = [], guideGroups = [];
  const guideInfo = tpl => { const p = tpl.build("category/name"); return syntaxGuideInfo(tpl, syntaxTone(p.prefix + p.editable + p.suffix)); };
  for (const group of SYNTAX_GUIDE_GROUPS) {
    const details = make("details", "pp-sidebar-guide-group"); details.dataset.syntaxTone = group.tone; details.open = false;
    const summary = make("summary"), heading = make("span", "pp-sidebar-group-copy"); heading.append(make("strong", "", group.title), make("small", "", group.subtitle));
    const icon = make("span", "pp-sidebar-group-icon"); icon.innerHTML = svgIcon(group.icon, 18); summary.append(icon, heading); details.append(summary);
    const cards = make("div", "pp-sidebar-guide-cards"); details.append(cards); guideList.append(details); guideGroups.push(details);
    const options = make("optgroup"); options.label = group.title;
    snippetRows.forEach((tpl, i) => {
      const info = guideInfo(tpl); if (info.group !== group.id) return;
      options.append(new Option(tpl.label, String(i)));
      const card = button("", () => chooseTemplate(i), "pp-sidebar-syntax-card"); card.dataset.syntaxTone = group.tone;
      card.setAttribute("aria-label", `${info.title} — ${tpl.label}`);
      const title = make("strong", "", info.title), description = make("span", "pp-sidebar-card-description", info.description);
      const p = tpl.build("category/name"), example = make("code", "pp-sidebar-card-code"); example.innerHTML = syntaxCodeHtml(p.prefix + p.editable + p.suffix);
      card.append(title, description, example, make("small", "pp-sidebar-card-action", "Try this →")); cards.append(card);
      guideCards.push({ card, details, query: `${info.title} ${info.description} ${info.example} ${tpl.label} ${group.title}`.toLowerCase() });
    }); catalog.append(options);
  }
  function filterGuide() {
    session.guideSearch = guideSearch.value;
    const terms = guideSearch.value.toLowerCase().trim().split(/\s+/).filter(Boolean);
    for (const row of guideCards) row.card.hidden = !terms.every(term => row.query.includes(term));
    for (const group of guideGroups) {
      group.hidden = !guideCards.some(row => row.details === group && !row.card.hidden);
      if (terms.length && !group.hidden) group.open = true;
    }
    guideEmpty.hidden = guideCards.some(row => !row.card.hidden);
  }
  guideSearch.addEventListener("input", filterGuide); filterGuide();
  const workshopBack = button("", () => showWorkshop(false), "pp-sidebar-back"); workshopBack.innerHTML = `${svgIcon("undo", 15)}<span>Back to syntax guide</span>`; workshopBack.setAttribute("aria-label", "Back to syntax guide"); workshop.append(workshopBack);
  const workshopIntro = make("div", "pp-sidebar-intro");
  const workshopTitle = make("h3", "", "Make it your own"), explanation = make("p", "pp-sidebar-note"); workshopIntro.append(workshopTitle, explanation); workshop.append(workshopIntro);
  const exampleHelp = make("div", "pp-sidebar-example"); workshop.append(exampleHelp);
  function showWorkshop(open = true) { session.syntaxWorkshop = open; guideView.hidden = open; workshop.hidden = !open; syntaxPane.scrollTop = 0; }
  function chooseTemplate(index) {
    const tpl = snippetRows[index], p = tpl.build("category/name"), info = guideInfo(tpl);
    session.guideIndex = index; catalog.value = String(index);
    code.value = p.prefix + p.editable + p.suffix; templateRange = [p.prefix.length, p.prefix.length + p.editable.length]; session.code = code.value;
    workshopTitle.textContent = info.title; explanation.textContent = info.description;
    exampleHelp.replaceChildren(make("strong", "", "In plain English"), make("p", "", info.example));
    workshop.dataset.syntaxTone = SYNTAX_GUIDE_GROUPS.find(g => g.id === info.group)?.tone || "choice";
    invalidatePreview(); paintCode(); showWorkshop(); code.focus(); code.setSelectionRange(...templateRange);
  }
  const captureBar = make("div", "pp-sidebar-actions");
  const captureSelection = () => {
    try {
      const snap = selection(); if (snap.end <= snap.start) throw new Error("Select a syntax block or phrase in the target node first.");
      lockedSelection = { ...snap, node: currentNode, widgetTarget: currentWidget }; code.value = snap.source.slice(snap.start, snap.end); session.code = code.value; templateRange = null; catalog.value = ""; session.guideIndex = null;
      workshopTitle.textContent = "Edit your selection"; explanation.textContent = "Change this captured text, then replace only that selection in your node."; exampleHelp.replaceChildren(make("p", "", "Your prompt stays untouched until you choose Replace selection.")); showWorkshop();
      captureInfo.textContent = "Selection captured. Replace selection updates only this original range; other inserts use the current cursor."; paintCode();
      announce("Selection loaded for editing.");
    } catch (error) { announce(error.message, true); }
  };
  captureBar.append(button("Edit selection", captureSelection)); workshop.append(captureBar);
  guideActions.append(button("Edit selection", captureSelection), button("Continue editing draft", () => showWorkshop()));
  const captureInfo = make("small", "pp-sidebar-note", "No selection captured."); workshop.append(captureInfo);
  const codeLabel = make("label", "pp-sidebar-code-label", "Editable syntax");
  const code = make("textarea", "pp-sidebar-code"); code.value = session.code; code.spellcheck = false; code.rows = 6; code.setAttribute("aria-label", "Editable syntax snippet"); codeLabel.append(code); workshop.append(codeLabel);
  const colored = make("pre", "pp-sidebar-syntax-preview"); colored.setAttribute("aria-hidden", "true"); workshop.append(colored);
  const syntaxActions = make("div", "pp-sidebar-actions");
  const replace = button("Replace selection", () => { if (!lockedSelection || (lockedSelection.node !== currentNode || lockedSelection.widgetTarget !== currentWidget)) { announce("Capture a selection from this node first.", true); return; } insert(code.value, [0, code.value.length], lockedSelection); }, "primary");
  syntaxActions.append(button("Insert", () => insert(code.value)), button("Insert & edit in node", () => insert(code.value, templateRange || [0, code.value.length])), replace,
    button("Copy", async () => { try { await navigator.clipboard.writeText(code.value); announce("Syntax copied."); } catch { announce("Clipboard unavailable. Select the syntax and use your copy shortcut.", true); } })); workshop.append(syntaxActions);
  const result = make("pre", "pp-sidebar-result"); result.hidden = true; result.setAttribute("aria-label", "Resolved preview"); result.setAttribute("aria-live", "polite");
  const preview = button("Preview in prompt", async () => {
    const version = ++previewVersion; previewAbort?.abort(); previewAbort = new AbortController();
    try {
      const snap = lockedSelection && lockedSelection.node === currentNode && lockedSelection.widgetTarget === currentWidget ? lockedSelection : selection();
      if (selection().source !== snap.source) throw new Error("The prompt changed. Capture the selection again.");
      const t = target(); if (!t) throw new Error("Choose a target node first.");
      const context = snap.editor?.__ppPromptTools || {};
      const seed = context.getSeed?.() ?? t.node.widgets?.find(w => w.name === "seed")?.value ?? 0;
      const mode = context.getMode?.() ?? t.node.widgets?.find(w => w.name === "processing_mode")?.value ?? "entire text as one";
      const draft = snap.source.slice(0, snap.start) + code.value + snap.source.slice(snap.end);
      const prompt = context.project?.(draft) ?? draft;
      const data = await API.inspect(prompt, seed, mode, { signal: previewAbort.signal });
      if (disposed || version !== previewVersion) return;
      result.textContent = data.resolved || "(empty output)"; result.hidden = false; announce("Preview uses the target prompt, current seed and processing mode. Nothing was inserted.");
    } catch (error) { if (!disposed && version === previewVersion && error.name !== "AbortError") announce(error.message, true); }
  }); workshop.append(preview, result);
  workshop.append(make("p", "pp-sidebar-note", 'Assign values with ${genre=fantasy}. Compare with ==, !=, >, >=, <, <=, or in. Precedence: not, and, or; parentheses group conditions. If/elif and switch take the first matching branch. In line-by-line mode, keep assignments and their branches on the same line.'));
  function paintCode() { colored.innerHTML = syntaxCodeHtml(code.value); colored.dataset.syntaxTone = syntaxTone(code.value); replace.disabled = !lockedSelection || (lockedSelection.node !== currentNode || lockedSelection.widgetTarget !== currentWidget); }
  function invalidatePreview() { previewVersion++; previewAbort?.abort(); result.hidden = true; }
  code.addEventListener("input", () => { session.code = code.value; templateRange = null; invalidatePreview(); paintCode(); });
  catalog.addEventListener("change", () => { if (catalog.value !== "") chooseTemplate(Number(catalog.value)); });
  if (Number.isInteger(session.guideIndex) && snippetRows[session.guideIndex]) {
    const info = guideInfo(snippetRows[session.guideIndex]); workshopTitle.textContent = info.title; explanation.textContent = info.description;
    exampleHelp.replaceChildren(make("strong", "", "In plain English"), make("p", "", info.example));
  } else {
    explanation.textContent = "Edit the text here, then insert it at your node cursor or capture a selection to replace.";
    exampleHelp.append(make("p", "", "In choice lists, a, b, and c are placeholders. Replace them with your own scenes, outfits, or moods."));
  }
  showWorkshop(session.syntaxWorkshop);
  paintCode();

  const toolsPane = panes.get("tools"), toolsIntro = make("div", "pp-sidebar-intro");
  toolsIntro.append(make("span", "pp-sidebar-eyebrow", "Prompt tools"), make("h3", "", "Tools"), make("p", "pp-sidebar-note", "Open a tool in the selected node. Enable & open turns on an optional tool.")); toolsPane.append(toolsIntro);
  const toolList = make("div", "pp-sidebar-tool-list"); toolsPane.append(toolList);
  const toolCards = [];
  for (const [label, command, help, icon, preference] of [
    ["Prompt Doctor", "openDoctor", "Find missing library references and other prompt issues before you generate.", "doctor", "promptDoctor"],
    ["Variation Lab", "openVariations", "Compare different choices while keeping the parts you already like.", "branch", "variationLab"],
    ["Prompt Stash", "openStash", "Keep a draft you can return to, or restore a previous prompt.", "stash", null],
    ["Library Manager", "openLibraryManager", "Organize library files and check for broken or unused references.", "gallery", "libraryManager"],
    ["Node library", "openLibrary", "Browse starter packs and work with your structured recipes.", "recipe", null],
    ["Focus editor", "focusEditor", "Return to the main editor and keep writing your prompt.", "edit", null],
  ]) {
    const b = button("", () => run(command, preference), "pp-sidebar-tool"); b.setAttribute("aria-label", label);
    const symbol = make("span", "pp-sidebar-tool-icon"); symbol.innerHTML = svgIcon(icon, 21);
    const copy = make("span", "pp-sidebar-tool-copy"); copy.append(make("strong", "", label), make("small", "", help));
    const action = make("span", "pp-sidebar-tool-action"); b.append(symbol, copy, action); toolList.append(b); toolCards.push({ b, preference, action, command });
  }
  for (const [label, tab, help, icon] of [["Choices & rules", "rules", "Build choices and matching outputs with a visual form.", "branch"], ["Inspect prompt", "inspect", "Look at weights, variables, and the text your model will receive.", "doctor"]]) {
    const b = button("", () => { try { openPromptTools(selection().editor, { tab }); } catch (error) { announce(error.message, true); } }, "pp-sidebar-tool"); b.setAttribute("aria-label", label);
    const symbol = make("span", "pp-sidebar-tool-icon"); symbol.innerHTML = svgIcon(icon, 21);
    const copy = make("span", "pp-sidebar-tool-copy"); copy.append(make("strong", "", label), make("small", "", help));
    b.dataset.sidebarPromptTool = tab; b.append(symbol, copy); toolList.append(b);
  }
  function refreshToolCards() {
    const prefs = getPowerToolPreferences();
    const t = target();
    for (const { b, preference, action, command } of toolCards) {
      const off = preference && !prefs[preference]; b.dataset.toolState = off ? "off" : "ready";
      const supported = typeof t?.handlers[command] === "function";
      b.disabled = !supported;
      action.textContent = !supported ? (currentNode ? "Not available on this node" : "Choose a target above") : off ? "Off · Enable & open →" : "Open →";
    }
    toolList.querySelectorAll("[data-sidebar-prompt-tool]").forEach(b => {
      const editor = t?.handlers.sidebarEditor?.();
      b.disabled = !editor || (t?.handlers.sidebarSelection != null) || (b.dataset.sidebarPromptTool === "rules" && editor.__ppPromptTools?.canResolve === false);
    });
  }
  window.addEventListener("pp-power-tools-changed", refreshToolCards);
  cleanups.push(() => window.removeEventListener("pp-power-tools-changed", refreshToolCards));

  function refreshTargets() {
    if (disposed) return;
    const live = sidebarTargets(app.graph);
    const previous = currentNode, previousWidget = currentWidget;
    if (!live.some(t => t.node === currentNode && (t.widget || null) === currentWidget)) {
      currentNode = live.length === 1 ? live[0].node : null; currentWidget = live.length === 1 ? (live[0].widget || null) : null;
    }
    session.targetNode = currentNode; session.targetWidget = currentWidget;
    // Keep the target explicit when multiple nodes exist; never silently change it on focus.
    const entries = live.map(t => ({ node: t.node, widget: t.widget || null, label: t.label?.() || `${t.node.title || t.node.comfyClass || "Prompt node"} · #${t.node.id}` }));
    const changed = entries.length !== renderedTargets.length || entries.some((entry, i) => entry.node !== renderedTargets[i]?.node || entry.widget !== renderedTargets[i]?.widget || entry.label !== renderedTargets[i]?.label);
    if (changed || !targets.options.length) {
      targets.replaceChildren(new Option(live.length ? "Choose a node…" : "No compatible text fields in this workflow", ""));
      entries.forEach((entry, i) => targets.append(new Option(entry.label, String(i))));
      renderedTargets = entries;
    }
    targets.value = currentNode ? String(live.findIndex(t => t.node === currentNode && (t.widget || null) === currentWidget)) : "";
    targets.title = targets.selectedOptions[0]?.textContent || "Choose a target";
    if (previous !== currentNode || previousWidget !== currentWidget) { lockedSelection = null; invalidatePreview(); paintCode(); }
    targetHint.textContent = target()?.handlers.sidebarRequiresResolvedText ? "Inserts resolved text into this field." : currentNode ? "Inserts at your cursor or active field." : "Choose a target to insert. You can browse and edit without one.";
    refreshToolCards();
  }
  targets.addEventListener("change", () => {
    const selected = targets.value === "" ? null : sidebarTargets(app.graph)[Number(targets.value)];
    currentNode = selected?.node || null; currentWidget = selected?.widget || null;
    lockedSelection = null; invalidatePreview(); refreshTargets(); paintCode();
  });
  targets.addEventListener("pointerdown", refreshTargets);
  targets.addEventListener("focus", refreshTargets);
  const themeApply = () => {
    appearance = readSuiteAppearanceSnapshot(); applyPromptPaletteThemeScope(root, appearance.colors, appearance.typography, appearance.effects);
    root.classList.toggle("wg-reduce-motion", !!appearance.theme.reduceMotion);
    styleExplorer.refreshAppearance();
    if (items.length) renderLibrary();
  };
  cleanups.push(onPromptPaletteAppearanceChanged(themeApply), API.onLibraryChanged(refreshLibrary), onLibraryPinsChanged(renderLibrary), onPromptPaletteCommandTargetsChanged(refreshTargets));
  themeApply(); refreshTargets(); activate(session.tab); refreshLibrary();
  return { refreshTargets, cleanup() {
    session.entry = entryEditor.snapshot(); session.entryOpen = !entryHost.hidden;
    disposed = true; libraryVersion++; previewVersion++; previewAbort?.abort();
    cleanups.forEach(fn => fn()); entryEditor.cleanup(); virtual.cleanup(); root.remove();
  } };
}
createPromptPaletteSidebar.sequence = 0;

let mounted = null, registered = false;
function registerSidebar(enabled) {
  const manager = app.extensionManager;
  if (!manager?.registerSidebarTab) return;
  if (!enabled) { if (registered) manager.unregisterSidebarTab?.(TAB_ID); mounted?.cleanup(); mounted = null; registered = false; return; }
  if (registered) return;
  manager.registerSidebarTab({ id: TAB_ID, type: "custom", title: "Prompt Palette", tooltip: "Prompt library, editable syntax and prompting tools", icon: "pi pi-palette",
    render(container) { mounted?.cleanup(); mounted = createPromptPaletteSidebar(container); },
    destroy() { mounted?.cleanup(); mounted = null; },
  });
  registered = true;
}
app.registerExtension({ name: "comfyui.promptpalette.main-sidebar",
  settings: [{ id: "PromptPalette.MainSidebarEnabled", category: ["Prompt Palette", "Prompt Library", "Main sidebar"], name: "Show Prompt Palette in the main sidebar", type: "boolean", defaultValue: true,
    tooltip: "Access My Library, editable syntax and existing prompting tools beside the ComfyUI canvas. The node’s own library panel remains available.", onChange: value => registerSidebar(value !== false) }],
  async setup() { await editorStylesReady; registerSidebar(app.ui?.settings?.getSettingValue?.("PromptPalette.MainSidebarEnabled", true) !== false); },
  nodeCreated() { queueMicrotask(() => mounted?.refreshTargets()); },
  afterConfigureGraph() { mounted?.refreshTargets(); },
});
