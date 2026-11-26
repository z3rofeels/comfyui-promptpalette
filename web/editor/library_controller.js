import { mountLibraryFeatures } from "./library_features.js";
import { reviewHistoryRestore, applyHistoryText, historyTargetEditor } from "./history_restore.js";
import {
  libraryVirtualLayout,
  bindLibraryViewControls,
  libraryThumbnailMarkup,
  getLibraryOrganization,
  sortLibraryCategories,
  sortLibraryItems,
  renderLibraryHoverTip,
} from "./library_display.js";
import { bindEditorWildcardHover } from "./editor_hover.js";
import { saveEditorSelection } from "./selection_library.js";
import { copyPromptPaletteThemeScope, positionPromptPaletteTip } from "../prompt_palette_shared.js";
import { API } from "../prompt_palette_api.js";
import { tagSearch } from "./tag_search.js";
import { createStarterPackController, loadStarterPackCatalog, flattenStarterPackCatalog } from "../prompt_library.js";
import { readEditorPreference, writeEditorPreference } from "../prompt_palette_state.js";
import { closestPromptEntries, detectPromptModelProfile } from "../prompt_quickness.js";
import { svgIcon } from "../prompt_palette_shared.js";
import {
  nodeIsActive, scheduleNodeTimer, cancelNodeTimer, scheduleNodeFrame, scheduleDomWidgetRemeasure,
} from "../prompt_palette_compat.js";
import {
  savePinned, saveExpandedCats, saveCatOrder, savePickerView, loadPinned, onLibraryPinsChanged,
} from "./preferences.js";
import {
  categoryOf, isRecipeCategory, normalizeLibraryEntryPath, escapeHtml, highlightMatch, hashStr, categoryColorFromHue, wildcardInsertionText,
} from "./text_utils.js";
import { getBooruAutocompleteMatches, attachAutocomplete } from "./autocomplete.js";
import { libraryAcRows, recentAcRows, mergeUnifiedRows } from "./autocomplete_sources.js";
import {
  openInjectMenu, openInjectMenuAtPoint, closeInjectMenu, scheduleCloseInjectMenu,
  cancelScheduledCloseInjectMenu, injectState,
} from "./injector.js";
import { openCtxMenu, closeCtxMenu, ctxMenuOpen, attachLibraryContextMenu } from "./context_menu.js";
import { libraryThumbnailActions } from "./thumbnails.js";
import { notify } from "./notifications.js";
import { createLibraryEntryEditor } from "./library_entry_editor.js";
import { VirtualCollectionManager } from "../library/virtual_collection.js";
import { PresentationScope } from "./sidebar_presentation.js";

export function createLibraryController(ctx) {
  const {
    node, root, theme, state, ioRail, textarea, hoverTip, previewCache, pinned, expandedCats, usageStore, recipeSelection,
    recipeSelectToggle, recipeBar, recipeBarCount, pickerDrawer, libraryTabs, libraryPanels, editDrawer, el,
    render, closeSettings, closeStash, openLibraryWorkspace,
    promptSaveRecipe, prepareStarterAutocomplete: externalPrepareStarterAutocomplete, performanceRuntime, profiler, libraryModel, renderLibrary,
  } = ctx;

  let libraryFeatures = null;
  const cleanupPins = onLibraryPinsChanged(() => { pinned.clear(); for (const path of loadPinned()) pinned.add(path); renderPickerList(searchInput.value); });
  const libraryIndex = libraryModel;
  let indexedLibraryRef = null;
  let starterAutocompleteLoad = null;

  function ensureLibraryIndex() {
    if (indexedLibraryRef === state.libraryCache) return;
    if (libraryIndex.items !== state.libraryCache) {
      const searchMode = "token";
      profiler?.measure("library.index", () => libraryIndex.rebuild(state.libraryCache, { buildSearchIndex: searchMode }));
    }
    indexedLibraryRef = state.libraryCache;
    profiler?.gauge("libraryEntries", libraryIndex.size());
  }
  async function prepareStarterAutocomplete() {
    if (externalPrepareStarterAutocomplete) return externalPrepareStarterAutocomplete();
    if (theme.starterPacksEnabled === false) {
      state.starterAutocompleteRows = [];
      return [];
    }
    if (starterAutocompleteLoad) return starterAutocompleteLoad;
    starterAutocompleteLoad = loadStarterPackCatalog()
      .then((catalog) => {
        state.starterAutocompleteRows = flattenStarterPackCatalog(catalog);
        return state.starterAutocompleteRows;
      })
      .catch(() => {
        state.starterAutocompleteRows = [];
        return [];
      })
      .finally(() => { starterAutocompleteLoad = null; });
    return starterAutocompleteLoad;
  }

  function getCategoryColor(cat) {
    return theme.categoryPins[cat] || categoryColorFromHue((hashStr(cat) % 360 + theme.hueRotate) % 360, theme.saturation);
  }

  async function showTipForName(x, y, name, known) {
    const requestVersion = ++hoverRequestVersion;
    hoverTip.__lastClientX = x;
    hoverTip.__lastClientY = y;
    if (known) {
      let entry = previewCache.get(name);
      if (!entry) {
        try {
          entry = await API.preview(name);
          if (requestVersion === hoverRequestVersion && nodeIsActive(node)) previewCache.set(name, entry);
        } catch {
          entry = null;
        }
      }
      if (requestVersion !== hoverRequestVersion || !nodeIsActive(node)) return;
      const cat = categoryOf(name);
      const color = getCategoryColor(cat);
      const thumbRel = state.thumbMap?.[name];
      const thumbBustQs = state.thumbBust?.[name] ? `&v=${state.thumbBust[name]}` : "";
      const thumbUrl = thumbRel ? API.thumbnailUrl(thumbRel, thumbBustQs) : "";
      copyPromptPaletteThemeScope(root, hoverTip);
      renderLibraryHoverTip(hoverTip, {
        name,
        lines: entry?.lines || [],
        totalLines: entry?.total ?? entry?.lines?.length ?? 0,
        thumbUrl,
        category: cat,
        accent: color,
        isPinned: pinned.has(name),
        isRecipe: isRecipeCategory(cat),
        error: !entry,
      });
      positionPromptPaletteTip(hoverTip, hoverTip.__lastClientX ?? x, hoverTip.__lastClientY ?? y);
      const img = hoverTip.querySelector(".wg-tip-thumb");
      if (img) {
        img.addEventListener("load", () => {
          if (hoverTip.style.display === "block") {
            positionPromptPaletteTip(hoverTip, hoverTip.__lastClientX ?? x, hoverTip.__lastClientY ?? y);
          }
        }, { once: true });
      }
      return;
    }
    const lines = closestPromptEntries(name, state.knownSet, 3).map((path) => `Did you mean ${path}?`);
    copyPromptPaletteThemeScope(root, hoverTip);
    hoverTip.innerHTML = `<div class="wg-tip-title">${escapeHtml(name + " (not found)")}</div>` +
      (lines.length ? lines.map(l => `<div class="wg-tip-line">${escapeHtml(l)}</div>`).join("") :
        `<div class="wg-tip-line">file missing</div>`);
    positionPromptPaletteTip(hoverTip, x, y);
  }
  function hideTip() { hoverRequestVersion += 1; hoverTip.style.display = "none"; }
  let hoverRequestVersion = 0;
  function bindEditorHover(editor, getRanges, focusedOnly = false) {
    return bindEditorWildcardHover({ node, editor, getRanges, show: showTipForName, hide: hideTip,
      disabled: () => state.workspacePrefs?.disableHoverPreviews || (focusedOnly && document.activeElement !== editor) });
  }
  const cleanupEditorHover = bindEditorHover(textarea, () => state.tokenRanges);


  const searchInput = el("search");
  const pickerList = el("pickerList");
  const pickerDoc = pickerList?.ownerDocument || globalThis.document;
  const listScope = typeof CSSStyleSheet === "function" && pickerDoc && "adoptedStyleSheets" in pickerDoc
    ? new PresentationScope(pickerList, { scopeAttr: "data-pp-lib-scope", layoutAttr: "data-pp-lib-layout" })
    : null;
  const staticStyledNodes = new Set();
  function setListProp(element, prop, value) {
    if (!element) return;
    if (listScope) {
      listScope.set(element, { [prop]: value });
      staticStyledNodes.add(element);
    } else {
      element.style.setProperty(prop, String(value));
    }
  }
  function clearStaticStyles() {
    if (!staticStyledNodes.size) return;
    for (const element of staticStyledNodes) listScope?.release(element);
    staticStyledNodes.clear();
  }
  function entryThumbUrl(path) {
    const thumbRel = state.thumbMap?.[path];
    if (!thumbRel) return "";
    const thumbBustQs = state.thumbBust?.[path] ? `&v=${state.thumbBust[path]}` : "";
    return API.thumbnailUrl(thumbRel, thumbBustQs);
  }

  let pickerKbIndex = -1;
  function pickerRows() { return Array.from(pickerList.querySelectorAll(".wg-item[data-path], .wg-thumb-item[data-path]")); }
  function movePickerKbIndex(delta) {
    const rows = pickerRows();
    rows.forEach(r => r.classList.remove("wg-kb-active"));
    if (!rows.length) { pickerKbIndex = -1; return; }
    pickerKbIndex = pickerKbIndex === -1
      ? (delta > 0 ? 0 : rows.length - 1)
      : (pickerKbIndex + delta + rows.length) % rows.length;
    const row = rows[pickerKbIndex];
    row.classList.add("wg-kb-active");
    row.scrollIntoView({ block: "nearest" });
  }

  function insertWildcard(path) {
    const editor = node._ppRecipeWorkspace?.editingSurface() || textarea;
    if (editor.readOnly || editor.disabled || editor.getAttribute("aria-readonly") === "true") {
      notify("info", "Prompt is read-only", "Choose an editable prompt field before inserting."); return;
    }
    if (node._ppInsertAdjustableRecipe?.(path, {
      fallback: wildcardInsertionText(path, editor.value.slice(editor.selectionEnd)),
    })) return;
    const pos = editor.selectionStart ?? editor.value.length;
    const before = editor.value.slice(0, pos);
    const after = editor.value.slice(editor.selectionEnd ?? pos);

    const insertText = wildcardInsertionText(path, after);
    editor.value = before + insertText + after;
    if (editor === textarea) node._ppRecipeWorkspace?.showEditor();
    editor.focus();
    editor.selectionStart = editor.selectionEnd = pos + insertText.length;
    usageStore.recordLibrary(path);
    state.recentList = usageStore.libraryRecent(12);
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    renderPickerList(searchInput.value);
  }

  async function getAcMatches(query, contextKind = "wildcard") {
    const q = String(contextKind === "booru" ? tagSearch(query).query : query || "").trim().toLowerCase();
    ensureLibraryIndex();
    const recentEntries = usageStore.recentEntries(16);
    const recentRows = recentAcRows(q, {
      entries: contextKind === "booru" ? recentEntries : recentEntries.filter((entry) => entry?.kind === "library"),
      pinned, theme, contextKind, isLibraryPath: (path) => !!libraryIndex.get(path), limit: 12,
    });
    const recentLibraryPaths = new Set(recentRows.filter((item) => item.kind !== "booru" && item.kind !== "custom").map((item) => item.value));
    const recents = recentEntries.filter((entry) => entry?.kind === "library").map((entry) => entry.value);
    let rankedPaths;
    if (q && state.workerClient?.shouldUseForLibrary?.()) {
      try { rankedPaths = (await state.workerClient.search(q, 32, { pinned, recent: recents })).map((item) => item.path); } catch { rankedPaths = null; }
    }
    if (!rankedPaths) {
      const options = { limit: 32, pinned, recent: recents };
      rankedPaths = profiler?.measure("library.search", () => libraryIndex.search(q, options).map((item) => item.path))
        || libraryIndex.search(q, options).map((item) => item.path);
    }
    // Prompts, wildcards, recipes, favorites and recents, colored like the library itself.
    // (Starter Packs stay in the Prompt Library only, so autocomplete stays focused on prompt text.)
    const libraryRows = libraryAcRows(q, {
      rankedPaths, pinned, recents, excludePaths: recentLibraryPaths, theme,
      limit: contextKind === "booru" ? 24 : 28,
    }).filter((item) => item?.kind !== "starter");
    if (contextKind !== "booru") return [...recentRows, ...libraryRows];
    const tagRows = await getBooruAutocompleteMatches(query);
    return mergeUnifiedRows(tagRows, [...recentRows, ...libraryRows]);
  }

  function commitAcItem(item) {
    if (item?.kind === "booru" || item?.kind === "custom") {
      usageStore.recordTag(item.value, item.kind, item.category);
    } else if (item?.kind === "starter") {
      const entry = state.starterAutocompleteRows.find((row) => row.id === item.value);
      if (entry) {
        usageStore.recordStarter(entry);
        state.starterSaveSuggestion = normalizeLibraryEntryPath(`${entry.modelName}/${entry.categoryName}/${entry.title}`);
      }
    } else if (item?.value && item.kind !== "booru" && item.kind !== "custom" && item.kind !== "syntax" && item.kind !== "lora") {
      usageStore.recordLibrary(item.value);
      state.recentList = usageStore.libraryRecent(12);
      renderPickerList(searchInput.value);
    }
  }

  const cleanupAutocompleteBinding = attachAutocomplete(textarea, {
    getMatches: getAcMatches,
    onCommit: commitAcItem,
    // Clearing/removing a recent in the menu also updates the sidebar's Recent list.
    onRecentsChanged: () => {
      state.recentList = usageStore.libraryRecent(12);
      renderPickerList(searchInput.value);
    },
    syntax: true,
    node,
  });

  const WRAP_SYNTAX = {
    Digit1: { open: "[color1]", close: "[/color1]" },
    Digit2: { open: "[color2]", close: "[/color2]" },
    Digit3: { open: "[color3]", close: "[/color3]" },
  };

  textarea.addEventListener("keydown", (e) => {
    if (!e.ctrlKey || e.altKey) return;
    const pair = WRAP_SYNTAX[e.code];
    if (!pair) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    if (start === end) return;
    e.preventDefault();
    e.stopPropagation();
    const selected = textarea.value.slice(start, end);
    textarea.value = textarea.value.slice(0, start) + pair.open + selected + pair.close + textarea.value.slice(end);

    textarea.selectionStart = start + pair.open.length;
    textarea.selectionEnd = start + pair.open.length + selected.length;
    textarea.focus();
    render();
  });

  function toggleRecipeSelection(path) {
    if (recipeSelection.has(path)) recipeSelection.delete(path); else recipeSelection.add(path);
    updateRecipeBar();
    renderPickerList(searchInput.value);
  }
  function updateRecipeBar() {
    recipeBar.classList.toggle("on", state.recipeSelectMode);
    recipeBarCount.textContent = `${recipeSelection.size} selected`;
    root.querySelector('[data-act="recipeSave"]').disabled = recipeSelection.size === 0;
  }

  let activeQuickFilter = "all";

  function pickerRow(item, filter = "") {
    const cat = categoryOf(item.path);
    const isRecipe = isRecipeCategory(cat);
    const color = getCategoryColor(cat);
    const isPinned = pinned.has(item.path);
    const isSelected = recipeSelection.has(item.path);
    const thumbRel = state.thumbMap?.[item.path];
    const showListThumb = Boolean(thumbRel) && pickerDrawer?.dataset.listThumbs !== "false";
    const thumbBustQs = state.thumbBust?.[item.path] ? `&v=${state.thumbBust[item.path]}` : "";
    const row = document.createElement("div");
    row.className = "wg-item" + (isRecipe ? " wg-item-recipe" : "") + (isSelected ? " wg-selected" : "") + (showListThumb ? " has-list-thumb" : "");
    row.dataset.path = item.path;
    const swatchHtml = isRecipe
      ? `<span class="wg-sw wg-sw-recipe" style="background:${color};" title="Palette Recipe">&#128214;</span>`
      : `<span class="wg-sw" style="background:${color}; border-radius:50%;"></span>`;
    const miniThumbHtml = showListThumb
      ? `<span class="wg-item-thumb-wrap" style="--wg-item-accent:${color};"><img class="wg-item-thumb" src="${escapeHtml(API.thumbnailUrl(thumbRel, thumbBustQs))}" alt="" loading="lazy" decoding="async" fetchpriority="low"></span>`
      : "";
    const checkboxHtml = state.recipeSelectMode
      ? `<input type="checkbox" class="wg-recipe-check" ${isSelected ? "checked" : ""} title="Add to Palette Recipe selection">`
      : "";
    const injectHtml = theme.syntaxInjectorEnabled !== false
      ? `<button type="button" class="wg-inject-trigger" title="Insert wildcard syntax for &quot;${escapeHtml(item.path)}&quot;" draggable="false">&#9889;</button>`
      : "";
    row.innerHTML = `${checkboxHtml}${swatchHtml}${miniThumbHtml}<span class="wg-name">${highlightMatch(item.path.split("/").pop(), filter)}</span><button type="button" class="wg-copy-trigger" title="Copy __${escapeHtml(item.path)}__" draggable="false">&#128203;</button>${injectHtml}<span class="wg-pin ${isPinned ? "pinned" : ""}">${isPinned ? "★" : "☆"}</span>`;
    return row;
  }

  function wireTileImage(tile, getCollection = null) {
    const img = tile.querySelector(".wg-thumb-img");
    if (!img) return;
    const reportDimensions = () => {
      if (!img.naturalWidth || !img.naturalHeight) return;
      const collection = typeof getCollection === "function" ? getCollection() : getCollection;
      if (collection && typeof collection.notifyMediaDimensions === "function") {
        collection.notifyMediaDimensions(tile, img.naturalWidth, img.naturalHeight);
        return;
      }
      if (getCollection) {
        queueMicrotask(() => {
          const deferred = typeof getCollection === "function" ? getCollection() : null;
          if (deferred && typeof deferred.notifyMediaDimensions === "function") {
            deferred.notifyMediaDimensions(tile, img.naturalWidth, img.naturalHeight);
          }
        });
      }
      const ratio = Math.max(0.35, Math.min(2.8, img.naturalWidth / img.naturalHeight));
      setListProp(tile, "--pp-natural-ratio", ratio);
    };
    if (img.complete && img.naturalWidth && img.naturalHeight) {
      reportDimensions();
    } else {
      img.addEventListener("load", reportDimensions, { once: true });
    }
    img.addEventListener("error", () => {
      const collection = typeof getCollection === "function" ? getCollection() : getCollection;
      collection?.notifyMediaError?.(tile);
    }, { once: true });
  }

  function pickerTile(item, getCollection = null) {
    const cat = categoryOf(item.path);
    const isRecipe = isRecipeCategory(cat);
    const color = getCategoryColor(cat);
    const isPinned = pinned.has(item.path);
    const isSelected = recipeSelection.has(item.path);
    const name = item.path.split("/").pop();
    const thumbUrl = entryThumbUrl(item.path);
    const thumbHtml = libraryThumbnailMarkup(thumbUrl, isRecipe);

    const tile = document.createElement("div");
    tile.className = "wg-thumb-item" + (isRecipe ? " wg-item-recipe" : "") + (isSelected ? " wg-selected" : "") + (thumbUrl ? " has-thumb" : "");
    tile.dataset.path = item.path;
    tile.dataset.thumbUrl = thumbUrl;
    setListProp(tile, "--wg-card-accent", color);
    tile.title = isRecipe ? `${item.path} (Palette Recipe)` : item.path;
    const checkboxHtml = state.recipeSelectMode
      ? `<input type="checkbox" class="wg-recipe-check wg-thumb-check" ${isSelected ? "checked" : ""} title="Add to Palette Recipe selection">`
      : "";
    const injectHtml = theme.syntaxInjectorEnabled !== false
      ? `<button type="button" class="wg-inject-trigger wg-thumb-inject" title="Insert wildcard syntax for &quot;${escapeHtml(item.path)}&quot;" draggable="false">&#9889;</button>`
      : "";
    tile.innerHTML = `${thumbHtml}${checkboxHtml}${injectHtml}<span class="wg-thumb-pin ${isPinned ? "pinned" : ""}">${isPinned ? "★" : "☆"}</span><span class="wg-thumb-name">${escapeHtml(name)}</span><span class="wg-thumb-meta">${escapeHtml(item.path.includes("/") ? item.path.slice(0, item.path.lastIndexOf("/")) : "Unfiled")}</span>`;
    wireTileImage(tile, getCollection);
    return tile;
  }

  function patchVisualTile(tile, item, getCollection = null) {
    if (!tile || !item) return;
    const cat = categoryOf(item.path);
    const isRecipe = isRecipeCategory(cat);
    const isPinned = pinned.has(item.path);
    const isSelected = recipeSelection.has(item.path);
    tile.classList.toggle("wg-selected", isSelected);
    const pinEl = tile.querySelector(".wg-thumb-pin");
    if (pinEl) {
      pinEl.classList.toggle("pinned", isPinned);
      pinEl.textContent = isPinned ? "★" : "☆";
    }
    const checkEl = tile.querySelector(".wg-recipe-check");
    if (checkEl) checkEl.checked = isSelected;
    const nextUrl = entryThumbUrl(item.path);
    if ((tile.dataset.thumbUrl || "") !== nextUrl) {
      tile.dataset.thumbUrl = nextUrl;
      tile.classList.toggle("has-thumb", Boolean(nextUrl));
      const media = tile.querySelector(".wg-thumb-media");
      if (media) {
        const temp = document.createElement("div");
        temp.innerHTML = libraryThumbnailMarkup(nextUrl, isRecipe);
        const nextMedia = temp.firstElementChild;
        if (nextMedia) {
          media.replaceWith(nextMedia);
          wireTileImage(tile, getCollection);
        }
      }
    }
  }

  async function copyLibraryPath(path, button = null) {
    try {
      await navigator.clipboard.writeText(`__${path}__`);
      if (!button) return;
      const previous = button.innerHTML;
      button.innerHTML = "&#10003;";
      button.classList.add("copied");
      scheduleNodeTimer(node, () => { button.innerHTML = previous; button.classList.remove("copied"); }, 900);
    } catch {
      if (button) button.title = "Copy failed — clipboard permission denied";
    }
  }

  function moveCategoryByOffset(cat, delta) {
    const present = Array.from(new Set(state.libraryCache.map((e) => categoryOf(e.path))));
    const known = state.catOrder.filter((c) => present.includes(c));
    const unseen = present.filter((c) => !state.catOrder.includes(c)).sort();
    const order = [...known, ...unseen];
    const idx = order.indexOf(cat);
    if (idx === -1) return;
    const targetIdx = idx + delta;
    if (targetIdx < 0 || targetIdx >= order.length) return;
    const [moved] = order.splice(idx, 1);
    order.splice(targetIdx, 0, moved);
    state.catOrder = order;
    saveCatOrder(state.catOrder);
    pickerDrawer.__ppLibraryDisplayBinding?.setState?.({ catSort: "custom" }, { persist: true, notify: false });
    renderPickerList(searchInput.value);
  }

  function hideCategory(cat) {
    const org = getLibraryOrganization(pickerDrawer);
    const hidden = new Set(org.hiddenCats || []);
    hidden.add(cat);
    pickerDrawer.__ppLibraryDisplayBinding?.setState?.({ hiddenCats: Array.from(hidden) });
  }

  const searchCollapsedCats = new Set();

  function isCatExpanded(cat, hasSearch = Boolean((searchInput.value || "").trim())) {
    return hasSearch ? !searchCollapsedCats.has(cat) : expandedCats.has(cat);
  }

  function toggleCategoryExpanded(cat) {
    const hasSearch = Boolean((searchInput.value || "").trim());
    if (hasSearch) {
      if (searchCollapsedCats.has(cat)) searchCollapsedCats.delete(cat);
      else searchCollapsedCats.add(cat);
    } else {
      if (expandedCats.has(cat)) expandedCats.delete(cat);
      else expandedCats.add(cat);
      saveExpandedCats(expandedCats);
    }
    renderPickerList(searchInput.value);
  }

  function toggleSectionCollapsed(secId) {
    const org = getLibraryOrganization(pickerDrawer);
    const collapsed = new Set(org.collapsedSections || []);
    if (collapsed.has(secId)) collapsed.delete(secId);
    else collapsed.add(secId);
    pickerDrawer.__ppLibraryDisplayBinding?.setState?.({ collapsedSections: Array.from(collapsed) });
  }

  function expandAllCategories() {
    searchCollapsedCats.clear();
    for (const entry of state.libraryCache) expandedCats.add(categoryOf(entry.path));
    saveExpandedCats(expandedCats);
    pickerDrawer.__ppLibraryDisplayBinding?.setState?.({ collapsedSections: [] }, { persist: true, notify: false });
    renderPickerList(searchInput.value);
  }

  function collapseAllCategories() {
    for (const entry of state.libraryCache) searchCollapsedCats.add(categoryOf(entry.path));
    expandedCats.clear();
    saveExpandedCats(expandedCats);
    renderPickerList(searchInput.value);
  }

  function openCategoryContextMenu(event, cat) {
    const isExpanded = isCatExpanded(cat);
    const org = getLibraryOrganization(pickerDrawer);
    closeInjectMenu();
    const actions = [
      {
        label: isExpanded ? `Collapse "${cat}"` : `Expand "${cat}"`,
        icon: "jump",
        group: "folder",
        onSelect: () => toggleCategoryExpanded(cat),
      },
      { label: "Expand all folders", icon: "jump", group: "folder", onSelect: expandAllCategories },
      { label: "Collapse all folders", icon: "jump", group: "folder", onSelect: collapseAllCategories },
      { label: `Move "${cat}" up`, icon: "jump", group: "order", onSelect: () => moveCategoryByOffset(cat, -1) },
      { label: `Move "${cat}" down`, icon: "jump", group: "order", onSelect: () => moveCategoryByOffset(cat, 1) },
      { label: `Hide "${cat}" folder`, icon: "pin", group: "visibility", onSelect: () => hideCategory(cat) },
    ];
    if (org.hiddenCats?.length) {
      actions.push({
        label: `Show all hidden folders (${org.hiddenCats.length})`,
        icon: "pin",
        group: "visibility",
        onSelect: () => pickerDrawer.__ppLibraryDisplayBinding?.setState?.({ hiddenCats: [] }),
      });
    }
    openCtxMenu(event.clientX, event.clientY, actions);
  }

  function openLibraryContextMenu(event, path) {
    const cat = categoryOf(path);
    const nowPinned = pinned.has(path);
    const item = state.libraryCache.find(item => item.path === path);
    closeInjectMenu();
    openCtxMenu(event.clientX, event.clientY, [
      { label: "Insert wildcard", icon: "plus", group: "insert", onSelect: () => insertWildcard(path) },
      ...(theme.syntaxInjectorEnabled !== false ? [{ label: "Insert with syntax…", icon: "bolt", group: "insert", onSelect: () => {
        const editor = node._ppActiveRecipeEditor?.isConnected ? node._ppActiveRecipeEditor : textarea;
        if (editor === textarea) node._ppRecipeWorkspace?.showEditor();
        openInjectMenuAtPoint(event.clientX, event.clientY, path, editor, editor === textarea ? render : () => editor.dispatchEvent(new Event("input", { bubbles: true })));
      } }] : []),
      { label: "Edit library entry…", icon: "edit", group: "item", onSelect: () => openEditForItem(path) },
      { label: "Copy wildcard reference", icon: "path", group: "item", onSelect: () => copyLibraryPath(path) },
      { label: nowPinned ? "Unpin entry" : "Pin entry", icon: "pin", group: "item", onSelect: () => { if (pinned.has(path)) pinned.delete(path); else pinned.add(path); savePinned(pinned); renderPickerList(searchInput.value); } },
      ...libraryThumbnailActions(path, { hasThumbnail: !!state.thumbMap[path], editable: !item?.type || item.type === "txt",
        isActive: () => !libraryDisposed && nodeIsActive(node) }),
      { label: `Jump to "${cat}"`, icon: "jump", group: "nav", onSelect: () => jumpToCategory(cat) },
      { label: `Hide "${cat}" folder`, icon: "pin", group: "nav", onSelect: () => hideCategory(cat) },
    ]);
  }

  let delegatedInjectTimer = null;
  pickerList.addEventListener("click", (event) => {
    const resetFiltersBtn = event.target.closest('[data-act="libResetFilters"]');
    if (resetFiltersBtn) {
      event.stopPropagation();
      resetLibraryFilters();
      return;
    }
    const expandAllBtn = event.target.closest('[data-act="libExpandAll"]');
    if (expandAllBtn) {
      event.stopPropagation();
      expandAllCategories();
      return;
    }
    const clearRecent = event.target.closest('[data-act="clearRecent"]');
    if (clearRecent) {
      event.stopPropagation();
      usageStore.clearRecent();
      state.recentList = [];
      renderPickerList(searchInput.value);
      return;
    }
    const showHiddenBtn = event.target.closest('[data-act="showHiddenCats"]');
    if (showHiddenBtn) {
      event.stopPropagation();
      pickerDrawer.__ppLibraryDisplayBinding?.setState?.({ hiddenCats: [] });
      return;
    }
    const catActBtn = event.target.closest("[data-cat-act]");
    if (catActBtn) {
      event.stopPropagation();
      const folderEl = catActBtn.closest(".wg-folder[data-cat]");
      const cat = folderEl?.dataset.cat;
      if (!cat) return;
      const act = catActBtn.dataset.catAct;
      if (act === "up") moveCategoryByOffset(cat, -1);
      else if (act === "down") moveCategoryByOffset(cat, 1);
      else if (act === "hide") hideCategory(cat);
      return;
    }
    const secHeader = event.target.closest("[data-sec-collapse]");
    if (secHeader) {
      event.stopPropagation();
      toggleSectionCollapsed(secHeader.dataset.secCollapse);
      return;
    }
    const folder = event.target.closest(".wg-folder[data-cat]");
    if (folder) {
      toggleCategoryExpanded(folder.dataset.cat);
      return;
    }
    const host = event.target.closest(".wg-item[data-path], .wg-thumb-item[data-path]");
    if (!host) return;
    const path = host.dataset.path;
    if (event.target.closest(".wg-copy-trigger")) { event.stopPropagation(); copyLibraryPath(path, event.target.closest(".wg-copy-trigger")); return; }
    if (event.target.closest(".wg-inject-trigger")) {
      event.stopPropagation();
      const trigger = event.target.closest(".wg-inject-trigger");
      if (injectState && injectState.trigger === trigger) closeInjectMenu();
      else {
        const editor = node._ppActiveRecipeEditor?.isConnected ? node._ppActiveRecipeEditor : textarea;
        if (editor === textarea) node._ppRecipeWorkspace?.showEditor();
        openInjectMenu(trigger, path, editor, editor === textarea ? render : () => editor.dispatchEvent(new Event("input", { bubbles: true })));
      }
      return;
    }
    if (event.target.closest(".wg-pin, .wg-thumb-pin")) {
      event.stopPropagation();
      if (pinned.has(path)) pinned.delete(path); else pinned.add(path);
      savePinned(pinned);
      renderPickerList(searchInput.value);
      return;
    }
    if (event.target.closest(".wg-recipe-check")) return;
    if (host.classList.contains("wg-thumb-item") || event.target.closest(".wg-name, .wg-sw, .wg-item-thumb-wrap") || host.classList.contains("wg-item")) {
      if (state.recipeSelectMode) toggleRecipeSelection(path); else insertWildcard(path);
    }
  });
  pickerList.addEventListener("change", (event) => {
    const check = event.target.closest(".wg-recipe-check");
    const host = check?.closest("[data-path]");
    if (host) toggleRecipeSelection(host.dataset.path);
  });
  const contextEntry = event => event.target.closest?.(".wg-item[data-path], .wg-thumb-item[data-path], .wg-folder[data-cat]");
  const cleanupPickerContext = attachLibraryContextMenu(pickerList, (event) => {
    hideTip();
    cancelNodeTimer(node, delegatedInjectTimer);
    const target = contextEntry(event);
    if (!target) return;
    if (target.classList.contains("wg-folder") && target.dataset.cat) {
      openCategoryContextMenu(event, target.dataset.cat);
    } else if (target.dataset.path) {
      openLibraryContextMenu(event, target.dataset.path);
    }
  }, contextEntry);
  pickerList.addEventListener("mousemove", (event) => {
    const host = event.target.closest(".wg-item[data-path], .wg-thumb-item[data-path]");
    if (!host) return;
    hoverTip.__lastClientX = event.clientX;
    hoverTip.__lastClientY = event.clientY;
    if (hoverTip.style.display === "block") positionPromptPaletteTip(hoverTip, event.clientX, event.clientY);
  });
  pickerList.addEventListener("mouseover", (event) => {
    if (state.workspacePrefs?.disableHoverPreviews) return;
    const trigger = event.target.closest(".wg-inject-trigger");
    if (trigger && !trigger.contains(event.relatedTarget)) {
      cancelScheduledCloseInjectMenu();
      cancelNodeTimer(node, delegatedInjectTimer);
      const path = trigger.closest("[data-path]")?.dataset.path;
      delegatedInjectTimer = scheduleNodeTimer(node, () => {
        if (!path) return;
        const editor = node._ppActiveRecipeEditor?.isConnected ? node._ppActiveRecipeEditor : textarea;
        if (editor === textarea) node._ppRecipeWorkspace?.showEditor();
        openInjectMenu(trigger, path, editor, editor === textarea ? render : () => editor.dispatchEvent(new Event("input", { bubbles: true })));
      }, 90);
      return;
    }
    const host = event.target.closest(".wg-item[data-path], .wg-thumb-item[data-path]");
    if (host && !host.contains(event.relatedTarget)) showTipForName(event.clientX, event.clientY, host.dataset.path, true);
  });
  pickerList.addEventListener("mouseout", (event) => {
    const trigger = event.target.closest(".wg-inject-trigger");
    if (trigger && !trigger.contains(event.relatedTarget)) { cancelNodeTimer(node, delegatedInjectTimer); scheduleCloseInjectMenu(); }
    const host = event.target.closest(".wg-item[data-path], .wg-thumb-item[data-path]");
    if (host && !host.contains(event.relatedTarget)) hideTip();
  });

  let renderedLibraryItems = 0;
  let workerSearchVersion = 0;
  let needsPickerRender = false;
  let lastObservedListWidth = pickerList.clientWidth || 0;
  let lastRenderedSelectMode = Boolean(state.recipeSelectMode);
  const virtualManager = new VirtualCollectionManager(pickerList, {
    onVisibleCount: (count) => {
      renderedLibraryItems = count;
      profiler?.gauge("visibleLibraryItems", count);
    },
  });
  const pickerListResizeObserver = typeof ResizeObserver !== "undefined"
    ? new ResizeObserver(() => {
        if (libraryDisposed) return;
        const width = pickerList.clientWidth || 0;
        if (width <= 0) {
          lastObservedListWidth = 0;
          return;
        }
        if (needsPickerRender && pickerDrawer.classList.contains("open") && activeLibraryTab === "personal" && performanceRuntime?.visualActive?.() !== false) {
          lastObservedListWidth = width;
          renderPickerList(searchInput.value);
          return;
        }
        if (width !== lastObservedListWidth) {
          lastObservedListWidth = width;
          if (virtualManager.collections.size > 0) virtualManager.refresh();
        }
      })
    : null;
  pickerListResizeObserver?.observe(pickerList);
  let dragCat = null;

  pickerList.addEventListener("dragstart", (event) => {
    const header = event.target.closest?.(".wg-folder.wg-draggable[data-cat]");
    if (!header) return;
    dragCat = header.dataset.cat;
    header.classList.add("dragging");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", dragCat);
  });
  pickerList.addEventListener("dragend", (event) => {
    event.target.closest?.(".wg-folder")?.classList.remove("dragging");
    dragCat = null;
    pickerList.querySelectorAll(".wg-folder.drag-over").forEach((el) => el.classList.remove("drag-over"));
  });
  pickerList.addEventListener("dragover", (event) => {
    const header = event.target.closest?.(".wg-folder.wg-draggable[data-cat]");
    if (!header || !dragCat || dragCat === header.dataset.cat) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    header.classList.add("drag-over");
  });
  pickerList.addEventListener("dragleave", (event) => event.target.closest?.(".wg-folder")?.classList.remove("drag-over"));
  pickerList.addEventListener("drop", (event) => {
    const header = event.target.closest?.(".wg-folder.wg-draggable[data-cat]");
    if (!header) return;
    event.preventDefault(); header.classList.remove("drag-over");
    const dragged = dragCat || event.dataTransfer.getData("text/plain");
    const cat = header.dataset.cat;
    if (!dragged || dragged === cat) return;
    const from = state.catOrder.indexOf(dragged), to = state.catOrder.indexOf(cat);
    if (from === -1 || to === -1) return;
    state.catOrder.splice(from, 1); state.catOrder.splice(to, 0, dragged);
    saveCatOrder(state.catOrder); renderPickerList(searchInput.value);
  });

  function measurePickerRowHeight(item, filter = "") {
    if (!item) return 32;
    const probeHost = document.createElement("div");
    probeHost.className = "wg-virtual-collection wg-virtual-list wg-library-row-probe-host";
    const probe = pickerRow(item, filter);
    probe.classList.add("wg-library-row-probe");
    probeHost.appendChild(probe);
    pickerList.appendChild(probeHost);
    // offsetHeight is in local CSS pixels; viewport rectangles include the
    // ComfyUI canvas zoom and cannot be used as virtual row strides.
    const measured = Math.ceil(probe.offsetHeight || probe.getBoundingClientRect?.().height || 0);
    probeHost.remove();
    // One CSS pixel of headroom prevents fractional font metrics from being
    // rounded down differently between the hidden probe and mounted rows.
    return Math.max(32, (measured || 32) + 1);
  }

  function mountVirtualItems(container, items, filter = "") {
    const grid = state.pickerViewMode !== "list";
    const geometry = libraryVirtualLayout(pickerDrawer);
    // List virtualization must use the row's real themed/font-scaled height.
    // A hard-coded 32px estimate made each virtual host shorter than its rows
    // at larger UI scales, so following category headers overlapped and clipped
    // the list. List rows are single-line below, making one measured probe exact.
    const rowHeight = grid ? 32 : measurePickerRowHeight(items?.[0], filter);
    let mounted = null;
    mounted = virtualManager.mount(container, {
      items,
      mode: ["masonry", "filmstrip"].includes(state.pickerViewMode) ? state.pickerViewMode : grid ? "grid" : "list",
      estimateRowHeight: rowHeight,
      ...geometry,
      itemKey: (item) => item.path,
      thumbnailUrl: (item) => entryThumbUrl(item?.path),
      ...(listScope ? {
        styleDeclaration: listScope.declaration,
        releaseStyle: (el) => {
          staticStyledNodes.delete(el);
          listScope.release(el);
        },
      } : {}),
      overscan: 2,
      renderItem: (item) => grid ? pickerTile(item, () => mounted) : pickerRow(item, filter),
    });
    return mounted;
  }

  function refreshDisplayGeometry() {
    // Static categories reflow in CSS. Only the bounded search window needs
    // geometry updates; keep its anchor and all existing card/menu listeners.
    const anchor = virtualManager.captureViewportAnchor();
    const geometry = libraryVirtualLayout(pickerDrawer);
    for (const collection of virtualManager.collections) {
      if (collection.mode === "list") continue;
      collection.updateLayout(geometry);
    }
    virtualManager.restoreViewportAnchor(anchor);
    virtualManager.refresh();
  }

  // Expanded category folders are already an explicit user-controlled window, so
  // virtualizing every folder separately adds geometry without saving meaningful
  // DOM work. Render those folders in normal document flow: every .txt entry is
  // present, card heights are intrinsic, and category headers can never inherit a
  // stale estimated spacer height. Very large search result sets and visual views
  // (masonry/filmstrip) use one unified virtual collection below.
  function mountStaticItems(container, items, filter = "", category = "") {
    const grid = state.pickerViewMode !== "list";
    const host = grid ? document.createElement("div") : null;
    const categoryColor = category ? getCategoryColor(category) : "";
    if (host) {
      host.className = "wg-thumb-grid wg-static-collection" + (category ? " wg-category-content" : "");
      if (categoryColor) setListProp(host, "--wg-category-accent", categoryColor);
    }
    const target = host || container;
    const fragment = document.createDocumentFragment();
    const sourceItems = items || [];
    sourceItems.forEach((item, index) => {
      try {
        const entry = grid ? pickerTile(item) : pickerRow(item, filter);
        if (category) {
          entry.classList.add("wg-category-entry");
          if (index === 0) entry.classList.add("wg-category-first");
          if (index === sourceItems.length - 1) entry.classList.add("wg-category-last");
          if (categoryColor) setListProp(entry, "--wg-category-accent", categoryColor);
        }
        fragment.appendChild(entry);
      } catch (error) {
        console.error("Prompt Palette: library item render failed", error);
        const fallback = document.createElement("div");
        fallback.className = "wg-item wg-virtual-fallback" + (category ? " wg-category-entry" : "");
        fallback.dataset.path = item?.path || "";
        fallback.textContent = String(item?.path || "Library entry").split("/").pop();
        if (categoryColor) setListProp(fallback, "--wg-category-accent", categoryColor);
        fragment.appendChild(fallback);
      }
    });
    target.appendChild(fragment);
    if (host) container.appendChild(host);
    renderedLibraryItems += sourceItems.length;
    // In list mode rows intentionally live directly beside their category header.
    // There is no intermediate content-sized wrapper that can retain stale height.
    return host || container;
  }

  const LARGE_SEARCH_VIRTUAL_THRESHOLD = 1000;

  function isPickerHidden() {
    return !pickerDrawer.classList.contains("open")
      || activeLibraryTab !== "personal"
      || performanceRuntime?.visualActive?.() === false
      || pickerList.hidden;
  }

  function renderPickerList(filter = "", prefilteredItems = null) {
    const requestedFilter = String(filter || "");
    if (isPickerHidden()) {
      needsPickerRender = true;
      virtualManager.clear();
      clearStaticStyles();
      profiler?.count("libraryRendersSkippedHidden");
      return;
    }
    ensureLibraryIndex();
    if (requestedFilter && prefilteredItems == null && state.workerClient?.shouldUseForLibrary?.()) {
      const requestVersion = ++workerSearchVersion;
      performanceRuntime?.debounce("library-worker-search", 20, () => {
        state.workerClient.search(requestedFilter, Math.min(5000, Math.max(500, libraryIndex.size())), { pinned, recent: state.recentList }).then((matches) => {
          if (requestVersion !== workerSearchVersion || searchInput.value !== requestedFilter || !performanceRuntime?.visualActive?.()) return;
          renderPickerList(requestedFilter, matches);
        }).catch(() => {
          if (requestVersion !== workerSearchVersion || searchInput.value !== requestedFilter) return;
          renderPickerList(requestedFilter, libraryIndex.search(requestedFilter, { limit: libraryIndex.size(), pinned, recent: state.recentList }));
        });
      }, { visual: true });
      return;
    }
    if (!requestedFilter) { workerSearchVersion += 1; performanceRuntime?.cancelTimer("library-worker-search"); }
    if (injectState && injectState.textarea === textarea) closeInjectMenu();
    if (ctxMenuOpen) closeCtxMenu();
    needsPickerRender = false;
    lastObservedListWidth = pickerList.clientWidth || 0;
    pickerKbIndex = -1;
    const prevScrollTop = pickerList.scrollTop;
    const isUnifiedVisualView = ["masonry", "filmstrip"].includes(state.pickerViewMode);
    const existingCollection = virtualManager.collections.size === 1
      ? virtualManager.collections.values().next().value
      : null;

    const org = getLibraryOrganization(pickerDrawer);
    org.quickFilter = activeQuickFilter !== "all" ? activeQuickFilter : "";
    const hiddenSecSet = new Set(org.hiddenSections || []);
    const allCatsSet = new Set();
    for (const entry of state.libraryCache) allCatsSet.add(categoryOf(entry.path));
    const allPresentCats = Array.from(allCatsSet);
    const knownOrder = state.catOrder.filter((c) => allCatsSet.has(c));
    const unseenOrder = allPresentCats.filter((c) => !state.catOrder.includes(c)).sort();
    const canonicalCatOrder = [...knownOrder, ...unseenOrder];
    if (unseenOrder.length && !requestedFilter) {
      state.catOrder = canonicalCatOrder.slice();
      saveCatOrder(state.catOrder);
    }
    pickerDrawer.__ppLibraryDisplayBinding?.syncCategories?.(canonicalCatOrder, getCategoryColor);

    const rawItems = Array.isArray(prefilteredItems)
      ? prefilteredItems
      : requestedFilter
        ? (profiler?.measure("library.search", () => libraryIndex.search(requestedFilter, { limit: libraryIndex.size(), pinned, recent: state.recentList })) || libraryIndex.search(requestedFilter, { limit: libraryIndex.size(), pinned, recent: state.recentList }))
        : state.libraryCache;
    const items = sortLibraryItems(libraryFeatures?.filter(rawItems) || rawItems, org, pinned, state.thumbMap);
    const collapsedSecSet = new Set(org.collapsedSections || []);

    const canReuseUnified = Boolean(
      isUnifiedVisualView
      && !(requestedFilter && items.length > LARGE_SEARCH_VIRTUAL_THRESHOLD)
      && existingCollection
      && existingCollection.mode === state.pickerViewMode
      && pickerList.children.length === 1
      && pickerList.firstElementChild === existingCollection.host
      && lastRenderedSelectMode === Boolean(state.recipeSelectMode)
    );

    if (!canReuseUnified) {
      virtualManager.clear();
      clearStaticStyles();
    }
    renderedLibraryItems = 0;

    const runLibraryRenderPass = () => {
      if (!canReuseUnified) pickerList.replaceChildren();

      if (requestedFilter && items.length > LARGE_SEARCH_VIRTUAL_THRESHOLD) {
        const label = document.createElement("div");
        label.className = "wg-section-label";
        label.textContent = `Search results · ${items.length.toLocaleString()}`;
        pickerList.appendChild(label);
        mountVirtualItems(pickerList, items, requestedFilter);
        lastRenderedSelectMode = Boolean(state.recipeSelectMode);
        return;
      }

      if (isUnifiedVisualView) {
        const unifiedItems = [];
        const seenPaths = new Set();
        const pushUnique = (list) => {
          for (const entry of list || []) {
            if (!entry?.path || seenPaths.has(entry.path)) continue;
            seenPaths.add(entry.path);
            unifiedItems.push(entry);
          }
        };
        const collectCategoryEntries = (includeAllMatching) => {
          const grouped = new Map();
          for (const entry of items) {
            const cat = categoryOf(entry.path);
            if (!grouped.has(cat)) grouped.set(cat, []);
            grouped.get(cat).push(entry);
          }
          const catNames = sortLibraryCategories(
            Array.from(grouped.keys()),
            grouped,
            { ...org, includeHidden: Boolean(requestedFilter || org.quickFilter) },
            canonicalCatOrder
          );
          for (const cat of catNames) {
            if (includeAllMatching || isCatExpanded(cat, Boolean(requestedFilter))) {
              pushUnique(grouped.get(cat));
            }
          }
        };

        if (!requestedFilter && !org.quickFilter) {
          const sectionOrder = Array.isArray(org.sectionOrder) ? org.sectionOrder : ["pinned", "recent", "categories"];
          for (const secId of sectionOrder) {
            if (hiddenSecSet.has(secId)) continue;
            if (secId === "pinned") {
              if (!collapsedSecSet.has("pinned")) {
                pushUnique(sortLibraryItems(
                  state.libraryCache.filter((entry) => pinned.has(entry.path)),
                  org,
                  pinned,
                  state.thumbMap
                ));
              }
            } else if (secId === "recent") {
              if (!collapsedSecSet.has("recent")) {
                pushUnique(sortLibraryItems(
                  state.recentList.filter((path) => !pinned.has(path)).map((path) => libraryIndex.get(path)).filter(Boolean),
                  org,
                  pinned,
                  state.thumbMap
                ));
              }
            } else if (secId === "categories") {
              collectCategoryEntries(false);
            }
          }
        } else {
          collectCategoryEntries(Boolean(org.quickFilter && !requestedFilter));
        }

        if (unifiedItems.length) {
          if (canReuseUnified) {
            existingCollection.updateLayout(libraryVirtualLayout(pickerDrawer));
            existingCollection.updateItems(unifiedItems, {
              patchNode: (nodeEl, item) => patchVisualTile(nodeEl, item, () => existingCollection),
            });
          } else {
            mountVirtualItems(pickerList, unifiedItems, requestedFilter);
          }
          lastRenderedSelectMode = Boolean(state.recipeSelectMode);
          return;
        }

        if (canReuseUnified) {
          virtualManager.clear();
          clearStaticStyles();
          pickerList.replaceChildren();
        }
        const empty = document.createElement("div");
        empty.className = "wg-hint wg-lib-empty-state";
        const message = document.createElement("span");
        if (!items.length) {
          message.textContent = org.quickFilter ? `No ${org.quickFilter} entries match` : "No matching entries";
          empty.appendChild(message);
          if (requestedFilter || org.quickFilter) {
            const resetFilters = document.createElement("button");
            resetFilters.type = "button";
            resetFilters.className = "wg-lib-empty-reset";
            resetFilters.dataset.act = "libResetFilters";
            resetFilters.textContent = requestedFilter && org.quickFilter ? "Clear search & filter" : requestedFilter ? "Clear search" : "Show all";
            empty.appendChild(resetFilters);
          }
        } else {
          message.textContent = "No expanded folders or sections visible";
          empty.appendChild(message);
          const expandBtn = document.createElement("button");
          expandBtn.type = "button";
          expandBtn.className = "wg-lib-empty-reset";
          expandBtn.dataset.act = "libExpandAll";
          expandBtn.textContent = "Expand all folders";
          empty.appendChild(expandBtn);
        }
        pickerList.appendChild(empty);
        lastRenderedSelectMode = Boolean(state.recipeSelectMode);
        return;
      }

      const renderCategoriesSection = () => {
        const grouped = new Map();
        for (const entry of items) {
          const cat = categoryOf(entry.path);
          if (!grouped.has(cat)) grouped.set(cat, []);
          grouped.get(cat).push(entry);
        }
        const canReorder = !requestedFilter && !org.quickFilter && (org.catSort || "custom") === "custom";
        const catNames = sortLibraryCategories(
          Array.from(grouped.keys()),
          grouped,
          { ...org, includeHidden: Boolean(requestedFilter || org.quickFilter) },
          canonicalCatOrder
        );

        for (let idx = 0; idx < catNames.length; idx++) {
          const cat = catNames[idx];
          const catItems = grouped.get(cat) || [];
          const isExpanded = isCatExpanded(cat, Boolean(requestedFilter));
          const header = document.createElement("div");
          header.className = "wg-folder" + (isExpanded ? " expanded" : "") + (isRecipeCategory(cat) ? " wg-folder-recipe" : "") + (canReorder ? " wg-draggable" : "");
          header.dataset.cat = cat;
          header.draggable = canReorder;
          const categoryColor = getCategoryColor(cat);
          setListProp(header, "--wg-category-accent", categoryColor);
          const folderLabel = isRecipeCategory(cat) ? `&#128214; ${escapeHtml(cat)}` : escapeHtml(cat);
          const toolsHtml = !requestedFilter
            ? `<span class="wg-folder-tools">
                ${canReorder ? `<button type="button" class="wg-folder-act" data-cat-act="up" ${idx === 0 ? "disabled" : ""} title="Move folder up" aria-label="Move ${escapeHtml(cat)} up">↑</button><button type="button" class="wg-folder-act" data-cat-act="down" ${idx === catNames.length - 1 ? "disabled" : ""} title="Move folder down" aria-label="Move ${escapeHtml(cat)} down">↓</button>` : ""}
                <button type="button" class="wg-folder-act wg-folder-act-hide" data-cat-act="hide" title="Hide &quot;${escapeHtml(cat)}&quot; folder" aria-label="Hide ${escapeHtml(cat)} folder">✕</button>
              </span>`
            : "";
          header.innerHTML = `<span class="wg-folder-caret">${isExpanded ? "▾" : "▸"}</span><span class="wg-folder-name">${folderLabel}</span>${toolsHtml}<span class="wg-folder-count">${catItems.length}</span>`;
          header.title = isExpanded ? "Click to collapse · Right-click for folder options" : "Click to expand · Right-click for folder options";
          pickerList.appendChild(header);
          if (isExpanded) mountStaticItems(pickerList, catItems, requestedFilter, cat);
        }

        if (!requestedFilter && org.hiddenCats?.length) {
          const hiddenNote = document.createElement("div");
          hiddenNote.className = "wg-hidden-cats-bar";
          hiddenNote.innerHTML = `<span>${org.hiddenCats.length} ${org.hiddenCats.length === 1 ? "folder" : "folders"} hidden</span><button type="button" class="wg-clear-recent" data-act="showHiddenCats">Show all</button>`;
          pickerList.appendChild(hiddenNote);
        }
      };

      if (!requestedFilter && !org.quickFilter) {
        const sectionOrder = Array.isArray(org.sectionOrder) ? org.sectionOrder : ["pinned", "recent", "categories"];
        for (const secId of sectionOrder) {
          if (hiddenSecSet.has(secId)) continue;
          if (secId === "pinned") {
            const pinnedItems = sortLibraryItems(
              state.libraryCache.filter((entry) => pinned.has(entry.path)),
              org,
              pinned,
              state.thumbMap
            );
            if (pinnedItems.length) {
              const isCollapsed = collapsedSecSet.has("pinned");
              const label = document.createElement("div");
              label.className = "wg-section-label wg-section-label-row wg-section-collapsible" + (isCollapsed ? " is-collapsed" : " expanded");
              label.dataset.secCollapse = "pinned";
              label.title = isCollapsed ? "Click to expand Pinned" : "Click to collapse Pinned";
              label.innerHTML = `<span class="wg-section-head-left"><span class="wg-folder-caret">${isCollapsed ? "▸" : "▾"}</span><span>★ Pinned</span></span><span class="wg-section-count">${pinnedItems.length}</span>`;
              pickerList.appendChild(label);
              if (!isCollapsed) mountStaticItems(pickerList, pinnedItems);
            }
          } else if (secId === "recent") {
            const recentItems = sortLibraryItems(
              state.recentList.filter((path) => !pinned.has(path)).map((path) => libraryIndex.get(path)).filter(Boolean),
              org,
              pinned,
              state.thumbMap
            );
            if (recentItems.length) {
              const isCollapsed = collapsedSecSet.has("recent");
              const label = document.createElement("div");
              label.className = "wg-section-label wg-section-label-row wg-section-collapsible" + (isCollapsed ? " is-collapsed" : " expanded");
              label.dataset.secCollapse = "recent";
              label.title = isCollapsed ? "Click to expand Recent" : "Click to collapse Recent";
              label.innerHTML = `<span class="wg-section-head-left"><span class="wg-folder-caret">${isCollapsed ? "▸" : "▾"}</span><span>↺ Recent</span></span><span class="wg-section-head-right"><span class="wg-section-count">${recentItems.length}</span><button type="button" class="wg-clear-recent" data-act="clearRecent" title="Clear recent list">Clear</button></span>`;
              pickerList.appendChild(label);
              if (!isCollapsed) mountStaticItems(pickerList, recentItems);
            }
          } else if (secId === "categories") {
            renderCategoriesSection();
          }
        }
      } else {
        renderCategoriesSection();
      }

      if (!items.length) {
        const empty = document.createElement("div");
        empty.className = "wg-hint wg-lib-empty-state";
        const message = document.createElement("span");
        message.textContent = org.quickFilter ? `No ${org.quickFilter} entries match` : "No matching entries";
        empty.appendChild(message);
        if (requestedFilter || org.quickFilter) {
          const resetFilters = document.createElement("button");
          resetFilters.type = "button";
          resetFilters.className = "wg-lib-empty-reset";
          resetFilters.dataset.act = "libResetFilters";
          resetFilters.textContent = requestedFilter && org.quickFilter ? "Clear search & filter" : requestedFilter ? "Clear search" : "Show all";
          empty.appendChild(resetFilters);
        }
        pickerList.appendChild(empty);
      }
      lastRenderedSelectMode = Boolean(state.recipeSelectMode);
    };
    if (profiler?.measure) profiler.measure("library.render", runLibraryRenderPass);
    else runLibraryRenderPass();
    if (prevScrollTop > 0) {
      pickerList.scrollTop = Math.min(prevScrollTop, Math.max(0, pickerList.scrollHeight - pickerList.clientHeight));
    } else if (pickerList.scrollTop !== 0) {
      pickerList.scrollTop = 0;
    }
    virtualManager.refresh();
    let pinnedCount = 0;
    let thumbsCount = 0;
    let recipesCount = 0;
    const thumbs = state.thumbMap;
    for (const entry of state.libraryCache) {
      const p = entry?.path || "";
      if (pinned.has(p)) pinnedCount += 1;
      if (thumbs && thumbs[p]) thumbsCount += 1;
      const low = p.toLowerCase();
      if (low.startsWith("recipes/") || String(entry?.category || "").toLowerCase().startsWith("recipes")) recipesCount += 1;
    }
    const quickFilterCounts = {
      all: state.libraryCache.length,
      pinned: pinnedCount,
      thumbs: thumbsCount,
      recipes: recipesCount,
    };
    pickerDrawer.__ppLibraryDisplayBinding?.afterListRender?.({ counts: quickFilterCounts });
    profiler?.count("libraryRenders");
    profiler?.gauge("visibleLibraryItems", renderedLibraryItems);
  }

  pickerDrawer.addEventListener("pp-library-organize-change", () => {
    renderPickerList(searchInput.value);
  });

  const quickFilterBtns = Array.from(pickerDrawer.querySelectorAll("[data-lib-quick-filter]"));
  quickFilterBtns.forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      const next = btn.dataset.libQuickFilter || "all";
      activeQuickFilter = activeQuickFilter === next && next !== "all" ? "all" : next;
      if (activeQuickFilter !== "all") {
        const matchingItems = sortLibraryItems(state.libraryCache, { quickFilter: activeQuickFilter }, pinned, state.thumbMap);
        const matchingCats = Array.from(new Set(matchingItems.map((entry) => categoryOf(entry.path))));
        if (matchingCats.length && !matchingCats.some((cat) => expandedCats.has(cat))) {
          matchingCats.forEach((cat) => expandedCats.add(cat));
          saveExpandedCats(expandedCats);
        }
      }
      quickFilterBtns.forEach((candidate) => {
        const active = candidate.dataset.libQuickFilter === activeQuickFilter;
        candidate.classList.toggle("active", active);
        candidate.setAttribute("aria-pressed", String(active));
      });
      renderPickerList(searchInput.value);
    });
  });

  pickerDrawer.querySelector('[data-act="libExpandAll"]')?.addEventListener("click", (e) => {
    e.preventDefault();
    expandAllCategories();
  });
  pickerDrawer.querySelector('[data-act="libCollapseAll"]')?.addEventListener("click", (e) => {
    e.preventDefault();
    collapseAllCategories();
  });

  function resetLibraryFilters() {
    searchInput.value = "";
    searchCollapsedCats.clear();
    activeQuickFilter = "all";
    quickFilterBtns.forEach((candidate) => {
      const active = candidate.dataset.libQuickFilter === "all";
      candidate.classList.toggle("active", active);
      candidate.setAttribute("aria-pressed", String(active));
    });
    renderPickerList("");
    searchInput.focus({ preventScroll: true });
  }

  function jumpToCategory(cat) {
    searchInput.value = "";
    activeQuickFilter = "all";
    quickFilterBtns.forEach((candidate) => {
      const active = candidate.dataset.libQuickFilter === "all";
      candidate.classList.toggle("active", active);
      candidate.setAttribute("aria-pressed", String(active));
    });
    const org = getLibraryOrganization(pickerDrawer);
    if (org.hiddenCats?.includes(cat)) {
      pickerDrawer.__ppLibraryDisplayBinding?.setState?.({
        hiddenCats: org.hiddenCats.filter((c) => c !== cat),
      }, { persist: true, notify: false });
    }
    if (!expandedCats.has(cat)) {
      expandedCats.add(cat);
      saveExpandedCats(expandedCats);
    }
    renderPickerList("");
    scheduleNodeFrame(node, () => {
      const header = Array.from(pickerList.querySelectorAll(".wg-folder[data-cat]")).find((item) => item.dataset.cat === cat);
      if (!header) return;
      header.scrollIntoView({ block: "center" });
      header.classList.add("wg-jump-flash");
      scheduleNodeTimer(node, () => header.classList.remove("wg-jump-flash"), 900);
    });
  }

  let searchDebounce = null;
  searchInput.addEventListener("input", () => {
    searchCollapsedCats.clear();
    cancelNodeTimer(node, searchDebounce);
    searchDebounce = scheduleNodeTimer(node, () => renderPickerList(searchInput.value), 35);
  });

  searchInput.addEventListener("keydown", (e) => {
    if (state.workspacePrefs?.keyboardNavigation === false) return;
    if (e.key === "ArrowDown") {
      if (!pickerRows().length) return;
      e.preventDefault();
      movePickerKbIndex(1);
    } else if (e.key === "ArrowUp") {
      if (!pickerRows().length) return;
      e.preventDefault();
      movePickerKbIndex(-1);
    } else if (e.key === "Enter") {
      const rows = pickerRows();
      if (pickerKbIndex < 0 || !rows[pickerKbIndex]) return;
      e.preventDefault();
      (rows[pickerKbIndex].querySelector(".wg-name") || rows[pickerKbIndex]).click();
    } else if (e.key === "Escape" && searchInput.value) {
      e.preventDefault();
      e.stopPropagation();
      searchInput.value = "";
      renderPickerList("");
    }
  });

  let libraryRequestVersion = 0;
  let thumbnailRequestVersion = 0;
  let libraryDisposed = false;
  async function refreshLibrary(data = null) {
    const requestVersion = ++libraryRequestVersion;
    hideTip();
    previewCache.clear();
    const nextLibrary = Array.isArray(data?.items) ? data.items : await API.list();
    if (libraryDisposed || requestVersion !== libraryRequestVersion || !nodeIsActive(node)) return false;
    const thumbnailVersion = ++thumbnailRequestVersion;
    let nextThumbMap = state.thumbMap;
    try {
      nextThumbMap = await API.categories();
    } catch (error) {
      console.error("Prompt Palette: thumbnail refresh failed", error);
    }
    if (libraryDisposed || requestVersion !== libraryRequestVersion || !nodeIsActive(node)) return false;
    state.libraryCache = nextLibrary;
    state.knownSet = new Set(nextLibrary.map((item) => item.path));
    if (thumbnailVersion === thumbnailRequestVersion) state.thumbMap = nextThumbMap;
    renderLibrary?.();
    renderPickerList(searchInput.value);
    return true;
  }

  async function refreshThumbMap() {
    const requestVersion = ++thumbnailRequestVersion;
    try {
      const nextThumbMap = await API.categories();
      if (libraryDisposed || requestVersion !== thumbnailRequestVersion || !nodeIsActive(node)) return false;
      state.thumbMap = nextThumbMap;
      renderPickerList(searchInput.value);
      return true;
    } catch (error) {
      console.error("Prompt Palette: thumbnail refresh failed", error);
      return false;
    }
  }

  node._wgRefreshLibrary = refreshLibrary;
  const cleanupLibrarySubscription = API.onLibraryChanged(refreshLibrary);

  async function selectionSaved(path) {
    previewCache.delete(path); state.starterSaveSuggestion = "";
    await refreshLibrary();
    const cat = categoryOf(path);
    if (!expandedCats.has(cat)) { expandedCats.add(cat); saveExpandedCats(expandedCats); }
    renderPickerList(searchInput.value);
  }
  function promptExtractSelectionToWildcard(start, end) {
    return saveEditorSelection(textarea, start, end, {
      defaultValue: state.starterSaveSuggestion, hasPath: path => state.knownSet.has(path), onSaved: selectionSaved,
    });
  }
  function promptSaveSelectionAsList(start, end) {
    return saveEditorSelection(textarea, start, end, {
      list: true, hasPath: path => state.knownSet.has(path), onSaved: selectionSaved,
    });
  }
  textarea.__ppExtractSelectionToWildcard = promptExtractSelectionToWildcard;
  textarea.__ppSaveSelectionAsList = promptSaveSelectionAsList;

  const editPanel = createLibraryEntryEditor({
    drawer: editDrawer, el, getLibrary: () => state.libraryCache, getMatches: getAcMatches, onCommit: commitAcItem,
    onThumbnailChanged: async path => { state.thumbBust[path] = Date.now(); await refreshThumbMap(); },
    onChanged: async path => { previewCache.delete(path); await refreshLibrary(); renderPickerList(searchInput.value); },
  });
  function openEditForItem(path, options = {}) {
    closeSettings(); closeStash(); ioRail.close(); closePickerDrawer();
    editDrawer.classList.add("open");
    root.querySelector('[data-act="edit"]').classList.add("active");
    editPanel.load(path, { confirm: true, ...options });
  }

  const starterPackController = createStarterPackController({
    root,
    textarea,
    notify,
    isFavorite: (id) => usageStore.isStarterFavorite(id),
    onToggleFavorite: (id) => usageStore.toggleStarterFavorite(id),
    recentIds: () => usageStore.starterRecent(24).map((entry) => entry.id),
    onInsert: ({ model, category, prompt, range }) => {
      if (model.id === "prompt-palette-syntax" && range) {
        const samplePath = Array.from(state.knownSet).find((path) => !/^RECIPES?\//i.test(path));
        if (samplePath) {
          const inserted = textarea.value.slice(range.start, range.end);
          const adapted = inserted.replaceAll("Locations/Location", samplePath);
          if (adapted !== inserted) {
            textarea.setRangeText(adapted, range.start, range.end, "select");
            textarea.dispatchEvent(new Event("input", { bubbles: true }));
          }
        }
      }
      state.starterSaveSuggestion = normalizeLibraryEntryPath(`${model.name}/${category.name}/${prompt.title}`);
      const row = state.starterAutocompleteRows.find((entry) => entry.id === prompt.id);
      if (row) usageStore.recordStarter(row);
    },
  });
  let starterDetectionReady = false;
  async function prepareStarterPacks() {
    if (theme.starterPacksEnabled === false) return;
    prepareStarterAutocomplete();
    if (starterDetectionReady) return;
    starterDetectionReady = true;
    try {
      const catalog = await loadStarterPackCatalog();
      const modelIds = (catalog?.models || []).map((model) => model.id);
      const detected = detectPromptModelProfile(node, modelIds);
      if (detected.id) starterPackController.setSuggestedModel(detected.id, `Detected from connected nodes: ${detected.detail}`);
    } catch {
      starterDetectionReady = false;
    }
  }
  if (theme.starterPacksEnabled !== false) prepareStarterPacks();
  const libraryButton = root.querySelector('[data-act="picker"]');
  let activeLibraryTab = theme.starterPacksEnabled === false ? "personal" : "starter";
  {
    const savedTab = readEditorPreference("libraryTab", activeLibraryTab);
    if (savedTab === "personal" || savedTab === "starter") activeLibraryTab = savedTab;
  }
  if (theme.starterPacksEnabled === false) activeLibraryTab = "personal";

  function activateLibraryTab(name, { focus = false } = {}) {
    const starterEnabled = theme.starterPacksEnabled !== false;
    const next = name === "starter" && starterEnabled ? "starter" : "personal";
    activeLibraryTab = next;
    libraryFeatures?.setActive(next === "personal" && pickerDrawer.classList.contains("open"));
    writeEditorPreference("libraryTab", next);
    libraryTabs.forEach((tab) => {
      const selected = tab.dataset.libraryTab === next;
      tab.classList.toggle("active", selected);
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
    });
    libraryPanels.forEach((panel) => {
      const selected = panel.dataset.libraryPanel === next;
      panel.classList.toggle("active", selected);
      panel.hidden = !selected;
      panel.setAttribute("aria-hidden", String(!selected));
      if (selected) panel.removeAttribute("inert");
      else panel.setAttribute("inert", "");
    });
    pickerDrawer.__ppLibraryDisplayBinding?.syncHeader(next);
    starterPackController.setActive(next === "starter");
    if (next === "starter") {
      prepareStarterPacks();
      starterPackController.activate();
      if (focus) el("starterSearch")?.focus({ preventScroll: true });
    } else {
      if (pickerDrawer.classList.contains("open")) state.workerClient?.prepareLibrarySearch?.();
      renderPickerList(searchInput.value);
      if (focus) searchInput.focus({ preventScroll: true });
    }
    pickerDrawer.__ppLibraryDisplayBinding?.refreshScrollbars?.();
    scheduleDomWidgetRemeasure(node);
  }

  function openPickerDrawer(tab = activeLibraryTab) {
    closeSettings();
    closeStash();
    ioRail.close();
    closeEditDrawer();
    pickerDrawer.hidden = false;
    pickerDrawer.removeAttribute("inert");
    pickerDrawer.setAttribute("aria-hidden", "false");
    pickerDrawer.classList.add("open");
    // Preserve the user's current prompt workspace and add the remembered library rail beside it.
    openLibraryWorkspace();
    libraryButton.classList.add("active");
    libraryButton.setAttribute("aria-expanded", "true");
    activateLibraryTab(tab);
    scheduleDomWidgetRemeasure(node);
  }

  function closePickerDrawer() {
    libraryFeatures?.setActive(false);
    pickerDrawer.classList.remove("open");
    pickerDrawer.setAttribute("aria-hidden", "true");
    pickerDrawer.setAttribute("inert", "");
    libraryButton.classList.remove("active");
    libraryButton.setAttribute("aria-expanded", "false");
    starterPackController.setActive(false);
    virtualManager.clear();
    clearStaticStyles();
    needsPickerRender = false;
    workerSearchVersion += 1;
    performanceRuntime?.cancelTimer("library-worker-search");
    cancelNodeTimer(node, searchDebounce);
    searchDebounce = null;
    cancelNodeTimer(node, delegatedInjectTimer);
    delegatedInjectTimer = null;
    hideTip();
    scheduleDomWidgetRemeasure(node);
  }

  libraryTabs.forEach((tab) => {
    tab.addEventListener("click", () => activateLibraryTab(tab.dataset.libraryTab, { focus: true }));
    tab.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const visibleTabs = libraryTabs.filter((candidate) => !candidate.hidden);
      if (visibleTabs.length < 2) return;
      event.preventDefault();
      const currentIndex = Math.max(0, visibleTabs.indexOf(tab));
      const direction = event.key === "ArrowRight" ? 1 : -1;
      const next = visibleTabs[(currentIndex + direction + visibleTabs.length) % visibleTabs.length];
      activateLibraryTab(next.dataset.libraryTab);
      next.focus({ preventScroll: true });
    });
  });
  root.querySelector('[data-act="closePickerDrawer"]').addEventListener("click", closePickerDrawer);
  libraryButton.addEventListener("click", () => {
    if (pickerDrawer.classList.contains("open")) closePickerDrawer();
    else openPickerDrawer();
  });

  const cleanupLibraryViewControls = bindLibraryViewControls(pickerDrawer, {
    getView: () => state.pickerViewMode,
    setView: (mode) => {
      state.pickerViewMode = mode;
      savePickerView(mode);
      renderPickerList(searchInput.value);
    },
  });

  recipeSelectToggle.addEventListener("click", () => {
    state.recipeSelectMode = !state.recipeSelectMode;
    recipeSelectToggle.classList.toggle("active", state.recipeSelectMode);
    recipeSelectToggle.title = state.recipeSelectMode
      ? "Exit Palette Recipe selection"
      : "Select entries to combine into a Palette Recipe";
    if (!state.recipeSelectMode) recipeSelection.clear();
    updateRecipeBar();
    renderPickerList(searchInput.value);
  });

  const recipesShortcutBtn = root.querySelector('[data-act="recipesShortcut"]');
  recipesShortcutBtn.addEventListener("click", () => {
    if (!pickerDrawer.classList.contains("open")) openPickerDrawer("personal");
    else activateLibraryTab("personal");
    state.recipeSelectMode = false;
    recipeSelection.clear();
    recipeSelectToggle.classList.remove("active");
    recipesShortcutBtn.classList.remove("active");
    updateRecipeBar();
    jumpToCategory("RECIPES");
  });
  root.querySelector('[data-act="recipeCancel"]').addEventListener("click", () => {
    recipeSelection.clear();
    updateRecipeBar();
    renderPickerList(searchInput.value);
  });
  root.querySelector('[data-act="recipeSave"]').addEventListener("click", async () => {
    if (!recipeSelection.size) return;
    const saved = await promptSaveRecipe(Array.from(recipeSelection));
    if (!saved) return;
    recipeSelection.clear();
    state.recipeSelectMode = false;
    recipeSelectToggle.classList.remove("active");
    recipeSelectToggle.title = "Select entries to combine into a Palette Recipe";
    updateRecipeBar();
    renderPickerList(searchInput.value);
  });

  function closeEditDrawer() {
    editPanel.suspend();
    editDrawer.classList.remove("open");
    root.querySelector('[data-act="edit"]').classList.remove("active");
  }
  root.querySelector('[data-act="edit"]').addEventListener("click", (e) => {
    const opening = !editDrawer.classList.contains("open");
    if (opening) {
      closeSettings();
      closeStash();
      ioRail.close();
      closePickerDrawer();
    }
    if (!opening) editPanel.suspend();
    editDrawer.classList.toggle("open", opening);
    e.currentTarget.classList.toggle("active", opening);
  });

  root.querySelector('[data-act="closeEditDrawer"]').addEventListener("click", closeEditDrawer);


  // The customize panel is portaled outside the drawer while open; retain the
  // authoritative view control instead of querying only the old DOM ancestry.
  const collectionViewSelect = pickerDrawer.querySelector("[data-library-view]");
  libraryFeatures = mountLibraryFeatures({ host: pickerDrawer.querySelector('[data-library-panel="personal"]'), settingsHost: pickerDrawer.querySelector("[data-library-customize-panel]") || pickerDrawer, node, getItems: () => state.libraryCache, getPinned: () => pinned, getThumbnails: () => state.thumbMap, onFilter: () => renderPickerList(searchInput.value), onView: view => { if(collectionViewSelect){collectionViewSelect.value=view==="gallery"?"grid":view;collectionViewSelect.dispatchEvent(new Event("change",{bubbles:true}));} }, onOpenEntry: (path, options) => openEditForItem(path, options), announce: (message, error) => notify(error ? "error" : "info", "Prompt Library", message), content: [pickerList], restore: ({text,channel="positive"}) => reviewHistoryRestore(historyTargetEditor(node,textarea,channel),text,applyHistoryText,channel) });

  return {
    getAcMatches, commitAcItem, bindEditorHover, selectionSaved, insertWildcard,
    refreshLibrary,
    refreshThumbMap,
    renderPickerList,
    refreshDisplayGeometry,
    hideTip,
    promptExtractSelectionToWildcard,
    openEditForItem,
    closeEditDrawer,
    openPickerDrawer,
    closePickerDrawer,
    activateLibraryTab,
    prepareStarterPacks,
    prepareStarterAutocomplete,
    starterPackController,
    libraryButton,
    searchInput,
    get activeLibraryTab() { return activeLibraryTab; },
    get starterAutocompleteRows() { return state.starterAutocompleteRows; },
    set starterAutocompleteRows(value) { state.starterAutocompleteRows = Array.isArray(value) ? value : []; },
    performanceStats() {
      return {
        observerActive: virtualManager.collections.size > 0 && pickerDrawer.classList.contains("open") && activeLibraryTab === "personal",
        renderedItems: renderedLibraryItems,
        indexEntries: libraryIndex.size(),
      };
    },
    cleanup() {
      libraryFeatures?.cleanup();
      libraryDisposed = true;
      libraryRequestVersion++;
      cleanupLibrarySubscription();
      if (node._wgRefreshLibrary === refreshLibrary) delete node._wgRefreshLibrary;
      hideTip(); previewCache.clear();
      cleanupEditorHover();
      cleanupAutocompleteBinding?.();
      cleanupPins();
      cleanupPickerContext();
      cleanupLibraryViewControls();
      editPanel.cleanup();
      pickerListResizeObserver?.disconnect();
      virtualManager.cleanup();
      clearStaticStyles();
      listScope?.cleanup();
      starterPackController.cleanup();
    },
  };
}
