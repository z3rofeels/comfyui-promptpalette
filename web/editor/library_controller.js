import { copyPromptPaletteThemeScope } from "../prompt_palette_shared.js";
import { API } from "../prompt_palette_api.js";
import { createStarterPackController, loadStarterPackCatalog, flattenStarterPackCatalog } from "../prompt_library.js";
import { readEditorPreference, writeEditorPreference } from "../prompt_palette_state.js";
import { closestPromptEntries, detectPromptModelProfile } from "../prompt_quickness.js";
import { svgIcon } from "../prompt_palette_shared.js";
import {
  nodeIsActive, scheduleNodeTimer, cancelNodeTimer, scheduleNodeFrame, scheduleDomWidgetRemeasure,
} from "../prompt_palette_compat.js";
import {
  savePinned, saveExpandedCats, saveCatOrder, savePickerView,
} from "./preferences.js";
import {
  categoryOf, isRecipeCategory, normalizeLibraryEntryPath, escapeHtml, highlightMatch, hashStr, categoryColorFromHue,
} from "./text_utils.js";
import {
  findWildcardFragment, openOrUpdateAcMenu, closeAcMenu, renderAcMenu, commitAcSelection, acState,
} from "./autocomplete.js";
import {
  runTextareaEditCommand, insertInjectorText, openInjectMenu, closeInjectMenu, scheduleCloseInjectMenu,
  cancelScheduledCloseInjectMenu, injectState,
} from "./injector.js";
import { openCtxMenu, closeCtxMenu, ctxMenuOpen } from "./context_menu.js";
import { pickThumbnailFile, thumbnailFileError } from "./thumbnails.js";
import { dialogPrompt, dialogConfirm } from "./dialogs.js";
import { notify } from "./notifications.js";
import { VirtualCollectionManager } from "../library/virtual_collection.js";

export function createLibraryController(ctx) {
  const {
    node, root, theme, state, ioRail, textarea, hoverTip, previewCache, pinned, expandedCats, usageStore, recipeSelection,
    recipeSelectToggle, recipeBar, recipeBarCount, pickerDrawer, libraryTabs, libraryPanels, editDrawer, el,
    render, closeSettings, closeStash, openLibraryWorkspace,
    promptSaveRecipe, prepareStarterAutocomplete: externalPrepareStarterAutocomplete, performanceRuntime, profiler, libraryModel, renderLibrary,
  } = ctx;

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

  function charIndexFromEvent(e) {
    const cs = getComputedStyle(textarea);
    const lineH = parseFloat(cs.lineHeight) || 20;
    const padT = parseFloat(cs.paddingTop) || 8;
    const padL = parseFloat(cs.paddingLeft) || 10;
    const charW = 7.4;
    const rect = textarea.getBoundingClientRect();
    const x = e.clientX - rect.left + textarea.scrollLeft - padL;
    const y = e.clientY - rect.top + textarea.scrollTop - padT;
    const row = Math.max(0, Math.floor(y / lineH));
    const col = Math.max(0, Math.round(x / charW));
    const lines = textarea.value.split("\n");
    if (row >= lines.length) return -1;
    let idx = 0;
    for (let i = 0; i < row; i++) idx += lines[i].length + 1;
    return idx + Math.min(col, lines[row].length);
  }
  async function showTipForName(x, y, name, known) {
    let lines = [];
    if (known) {
      let entry = previewCache.get(name);
      if (!entry) {
        try {
          entry = await API.preview(name);
          previewCache.set(name, entry);
        } catch {
          entry = null;
        }
      }
      lines = (entry?.lines || []).slice(0, 4);
    } else {
      lines = closestPromptEntries(name, state.knownSet, 3).map((path) => `Did you mean ${path}?`);
    }
    copyPromptPaletteThemeScope(root, hoverTip);
    hoverTip.innerHTML = `<div class="wg-tip-title">${escapeHtml(known ? name : name + " (not found)")}</div>` +
      (lines.length ? lines.map(l => `<div class="wg-tip-line">${escapeHtml(l)}</div>`).join("") :
        `<div class="wg-tip-line">${known ? "no preview available" : "file missing"}</div>`);
    hoverTip.style.left = (x + 14) + "px";
    hoverTip.style.top = (y + 14) + "px";
    hoverTip.style.display = "block";
  }
  function hideTip() { hoverTip.style.display = "none"; }
  let hoverDebounce = null;
  textarea.addEventListener("mousemove", (e) => {
    if (state.workspacePrefs?.disableHoverPreviews) { hideTip(); return; }
    const idx = charIndexFromEvent(e);
    const tok = state.tokenRanges.find(t => idx >= t.start && idx < t.end);
    cancelNodeTimer(node, hoverDebounce);
    if (tok) {
      hoverDebounce = scheduleNodeTimer(node, () => showTipForName(e.clientX, e.clientY, tok.name, tok.known), 120);
    } else hideTip();
  });
  textarea.addEventListener("mouseleave", hideTip);

  const searchInput = el("search");
  const pickerList = el("pickerList");

  let pickerKbIndex = -1;
  function pickerRows() { return Array.from(pickerList.querySelectorAll(".wg-item")); }
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
    const tag = `__${path}__`;
    const pos = textarea.selectionStart ?? textarea.value.length;
    const before = textarea.value.slice(0, pos);
    const after = textarea.value.slice(pos);

    const alreadySeparated = /^\s*,/.test(after);
    const insertText = alreadySeparated ? tag : tag + ", ";
    textarea.value = before + insertText + after;
    textarea.focus();
    textarea.selectionStart = textarea.selectionEnd = pos + insertText.length;
    usageStore.recordLibrary(path);
    state.recentList = usageStore.libraryRecent(12);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    renderPickerList(searchInput.value);
  }

  async function getAcMatches(query) {
    const q = String(query || "").trim().toLowerCase();
    ensureLibraryIndex();
    const contains = (value) => !q || String(value).toLowerCase().includes(q);
    const used = new Set();
    const rows = [];
    const pushLibrary = (path, group, kind = "library", favorite = false, allowFuzzy = false) => {
      if (!path || used.has(`library:${path}`) || (!allowFuzzy && !contains(path))) return;
      used.add(`library:${path}`);
      rows.push({ value: path, label: path, group, kind, favorite, meta: path.split("/").slice(0, -1).join(" / ") });
    };
    let rankedPaths;
    if (q && state.workerClient?.shouldUseForLibrary?.()) {
      try { rankedPaths = (await state.workerClient.search(q, 32, { pinned, recent: usageStore.libraryRecent(12) })).map((item) => item.path); } catch { rankedPaths = null; }
    }
    if (!rankedPaths) {
      const options = { limit: 32, pinned, recent: usageStore.libraryRecent(12) };
      rankedPaths = profiler?.measure("library.search", () => libraryIndex.search(q, options).map((item) => item.path))
        || libraryIndex.search(q, options).map((item) => item.path);
    }

    [...pinned].filter(contains).slice(0, 6).forEach((path) => pushLibrary(path, "Favorites", "favorite", true));
    usageStore.libraryRecent(12).filter(contains).forEach((path) => pushLibrary(path, "Recent", "recent"));
    rankedPaths.slice(0, 16).forEach((path) => pushLibrary(path, "My Library", "library", false, true));

    if (q.length >= 2 && state.starterAutocompleteRows.length) {
      const starterMatches = state.starterAutocompleteRows
        .filter((entry) => `${entry.title} ${entry.categoryName} ${entry.modelName} ${entry.note} ${entry.prompt}`.toLowerCase().includes(q))
        .sort((a, b) => {
          const at = a.title.toLowerCase();
          const bt = b.title.toLowerCase();
          const ar = at.startsWith(q) ? 0 : 1;
          const br = bt.startsWith(q) ? 0 : 1;
          return ar - br || a.modelName.localeCompare(b.modelName) || a.title.localeCompare(b.title);
        })
        .slice(0, 6);
      starterMatches.forEach((entry) => rows.push({
        value: entry.id,
        label: entry.title,
        group: "Starter Packs",
        kind: "starter",
        meta: `${entry.modelName} · ${entry.categoryName}`,
        insertText: entry.prompt,
        selectInserted: true,
        starterEntry: entry,
      }));
    }
    return rows.slice(0, 28);
  }

  function commitAcItem(item) {
    if (item?.kind === "starter") {
      const entry = state.starterAutocompleteRows.find((row) => row.id === item.value);
      if (entry) {
        usageStore.recordStarter(entry);
        state.starterSaveSuggestion = normalizeLibraryEntryPath(`${entry.modelName}/${entry.categoryName}/${entry.title}`);
      }
    } else if (item?.value) {
      usageStore.recordLibrary(item.value);
      state.recentList = usageStore.libraryRecent(12);
      renderPickerList(searchInput.value);
    }
  }

  textarea.addEventListener("input", () => {
    const fragment = findWildcardFragment(textarea.value, textarea.selectionStart);
    if (!fragment) return closeAcMenu();
    openOrUpdateAcMenu(textarea, fragment, getAcMatches, commitAcItem);
  });

  textarea.addEventListener("keydown", (e) => {
    if (state.workspacePrefs?.keyboardNavigation === false) return;
    if (!acState || acState.textarea !== textarea) return;
    const count = acState.items.length;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      acState.activeIndex = count ? (acState.activeIndex + 1) % count : 0;
      renderAcMenu();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      acState.activeIndex = count ? (acState.activeIndex - 1 + count) % count : 0;
      renderAcMenu();
    } else if (e.key === "Enter" || e.key === "Tab") {
      if (!count) return;
      e.preventDefault();
      e.stopPropagation();
      commitAcSelection(acState.activeIndex);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeAcMenu();
    }
  });

  function recheckAcOnCaretMove() {
    if (!acState || acState.textarea !== textarea) return;
    const fragment = findWildcardFragment(textarea.value, textarea.selectionStart);
    if (!fragment || fragment.start !== acState.start) closeAcMenu();
  }
  textarea.addEventListener("keyup", (e) => {
    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) recheckAcOnCaretMove();
  });
  textarea.addEventListener("click", recheckAcOnCaretMove);

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

  function pickerRow(item, filter = "") {
    const cat = categoryOf(item.path);
    const isRecipe = isRecipeCategory(cat);
    const color = theme.categoryPins[cat] || categoryColorFromHue((hashStr(cat) % 360 + theme.hueRotate) % 360, theme.saturation);
    const isPinned = pinned.has(item.path);
    const isSelected = recipeSelection.has(item.path);
    const row = document.createElement("div");
    row.className = "wg-item" + (isRecipe ? " wg-item-recipe" : "") + (isSelected ? " wg-selected" : "");
    row.dataset.path = item.path;
    const swatchHtml = isRecipe
      ? `<span class="wg-sw wg-sw-recipe" style="background:${color};" title="Palette Recipe">&#128214;</span>`
      : `<span class="wg-sw" style="background:${color}; border-radius:50%;"></span>`;
    const checkboxHtml = state.recipeSelectMode
      ? `<input type="checkbox" class="wg-recipe-check" ${isSelected ? "checked" : ""} title="Add to Palette Recipe selection">`
      : "";
    const injectHtml = theme.syntaxInjectorEnabled !== false
      ? `<button type="button" class="wg-inject-trigger" title="Insert wildcard syntax for &quot;${escapeHtml(item.path)}&quot;" draggable="false">&#9889;</button>`
      : "";
    row.innerHTML = `${checkboxHtml}${swatchHtml}<span class="wg-name">${highlightMatch(item.path.split("/").pop(), filter)}</span><button type="button" class="wg-copy-trigger" title="Copy __${escapeHtml(item.path)}__" draggable="false">&#128203;</button>${injectHtml}<span class="wg-pin ${isPinned ? "pinned" : ""}">${isPinned ? "★" : "☆"}</span>`;
    return row;
  }

  function pickerTile(item) {
    const cat = categoryOf(item.path);
    const isRecipe = isRecipeCategory(cat);
    const color = theme.categoryPins[cat] || categoryColorFromHue((hashStr(cat) % 360 + theme.hueRotate) % 360, theme.saturation);
    const isPinned = pinned.has(item.path);
    const isSelected = recipeSelection.has(item.path);
    const name = item.path.split("/").pop();
    const thumbRel = state.thumbMap[item.path];
    const thumbBustQs = state.thumbBust[item.path] ? `&v=${state.thumbBust[item.path]}` : "";
    const thumbHtml = thumbRel
      ? `<img class="wg-thumb-img" src="${escapeHtml(API.thumbnailUrl(thumbRel, thumbBustQs))}" alt="" loading="lazy" decoding="async" fetchpriority="low">`
      : `<div class="wg-thumb-fallback" style="background:color-mix(in srgb, ${color} 20%, var(--wg-surface, #121417));"><span class="wg-thumb-fallback-glyph" style="color:${color};">${isRecipe ? "&#128214;" : "&#128193;"}</span></div>`;
    const tile = document.createElement("div");
    tile.className = "wg-thumb-item" + (isRecipe ? " wg-item-recipe" : "") + (isSelected ? " wg-selected" : "");
    tile.dataset.path = item.path;
    tile.title = isRecipe ? `${item.path} (Palette Recipe)` : item.path;
    const checkboxHtml = state.recipeSelectMode
      ? `<input type="checkbox" class="wg-recipe-check wg-thumb-check" ${isSelected ? "checked" : ""} title="Add to Palette Recipe selection">`
      : "";
    tile.innerHTML = `${thumbHtml}${checkboxHtml}<span class="wg-thumb-pin ${isPinned ? "pinned" : ""}">${isPinned ? "★" : "☆"}</span><span class="wg-thumb-name">${escapeHtml(name)}</span>`;
    return tile;
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

  function openLibraryContextMenu(event, path) {
    const cat = categoryOf(path);
    const nowPinned = pinned.has(path);
    const hasThumb = !!state.thumbMap[path];
    closeInjectMenu();
    openCtxMenu(event.clientX, event.clientY, [
      { label: "Edit", onSelect: () => openEditForItem(path) },
      { label: "Copy path", onSelect: () => copyLibraryPath(path) },
      { label: nowPinned ? "Unpin" : "Pin", onSelect: () => { if (pinned.has(path)) pinned.delete(path); else pinned.add(path); savePinned(pinned); renderPickerList(searchInput.value); } },
      { label: hasThumb ? "Change Thumbnail…" : "Set Thumbnail…", onSelect: () => setThumbnailForItem(path) },
      ...(hasThumb ? [{ label: "Remove Thumbnail", onSelect: () => removeThumbnailForItem(path) }] : []),
      { label: `Jump to "${cat}"`, onSelect: () => jumpToCategory(cat) },
    ]);
  }

  let delegatedInjectTimer = null;
  pickerList.addEventListener("click", (event) => {
    const clearRecent = event.target.closest('[data-act="clearRecent"]');
    if (clearRecent) {
      event.stopPropagation();
      usageStore.clearRecent();
      state.recentList = [];
      renderPickerList(searchInput.value);
      return;
    }
    const folder = event.target.closest(".wg-folder[data-cat]");
    if (folder) {
      const cat = folder.dataset.cat;
      if (expandedCats.has(cat)) expandedCats.delete(cat); else expandedCats.add(cat);
      saveExpandedCats(expandedCats);
      renderPickerList(searchInput.value);
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
      else openInjectMenu(trigger, path, textarea, render);
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
    if (host.classList.contains("wg-thumb-item") || event.target.closest(".wg-name, .wg-sw")) {
      if (state.recipeSelectMode) toggleRecipeSelection(path); else insertWildcard(path);
    }
  });
  pickerList.addEventListener("change", (event) => {
    const check = event.target.closest(".wg-recipe-check");
    const host = check?.closest("[data-path]");
    if (host) toggleRecipeSelection(host.dataset.path);
  });
  pickerList.addEventListener("contextmenu", (event) => {
    const host = event.target.closest(".wg-item[data-path], .wg-thumb-item[data-path]");
    if (!host) return;
    event.preventDefault();
    openLibraryContextMenu(event, host.dataset.path);
  });
  pickerList.addEventListener("mousemove", (event) => {
    const host = event.target.closest(".wg-item[data-path], .wg-thumb-item[data-path]");
    if (!host) return;
    hoverTip.style.left = `${event.clientX + 14}px`;
    hoverTip.style.top = `${event.clientY + 14}px`;
  });
  pickerList.addEventListener("mouseover", (event) => {
    if (state.workspacePrefs?.disableHoverPreviews) return;
    const trigger = event.target.closest(".wg-inject-trigger");
    if (trigger && !trigger.contains(event.relatedTarget)) {
      cancelScheduledCloseInjectMenu();
      cancelNodeTimer(node, delegatedInjectTimer);
      const path = trigger.closest("[data-path]")?.dataset.path;
      delegatedInjectTimer = scheduleNodeTimer(node, () => { if (path) openInjectMenu(trigger, path, textarea, render); }, 90);
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
  const virtualManager = new VirtualCollectionManager(pickerList, {
    onVisibleCount: (count) => {
      renderedLibraryItems = count;
      profiler?.gauge("visibleLibraryItems", count);
    },
  });
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
    const measured = Math.ceil(probe.getBoundingClientRect?.().height || probe.offsetHeight || 0);
    probeHost.remove();
    // One CSS pixel of headroom prevents fractional font metrics from being
    // rounded down differently between the hidden probe and mounted rows.
    return Math.max(32, (measured || 32) + 1);
  }

  function mountVirtualItems(container, items, filter = "") {
    const grid = state.pickerViewMode === "grid";
    const density = String(ctx.state.libraryDensity || "medium");
    const cardHeight = density === "small" ? 112 : density === "large" ? 168 : 136;
    const minCardWidth = density === "small" ? 74 : density === "large" ? 120 : 92;
    // List virtualization must use the row's real themed/font-scaled height.
    // A hard-coded 32px estimate made each virtual host shorter than its rows
    // at larger UI scales, so following category headers overlapped and clipped
    // the list. List rows are single-line below, making one measured probe exact.
    const rowHeight = grid ? 32 : measurePickerRowHeight(items?.[0], filter);
    return virtualManager.mount(container, {
      items,
      mode: grid ? "grid" : "list",
      estimateRowHeight: rowHeight,
      estimateCardHeight: cardHeight,
      minCardWidth,
      overscan: 2,
      renderItem: (item) => grid ? pickerTile(item) : pickerRow(item, filter),
    });
  }

  // Expanded category folders are already an explicit user-controlled window, so
  // virtualizing every folder separately adds geometry without saving meaningful
  // DOM work. Render those folders in normal document flow: every .txt entry is
  // present, card heights are intrinsic, and category headers can never inherit a
  // stale estimated spacer height. Very large search result sets still use one
  // virtual collection below.
  function mountStaticItems(container, items, filter = "", category = "") {
    const grid = state.pickerViewMode === "grid";
    const host = grid ? document.createElement("div") : null;
    const categoryColor = category
      ? (theme.categoryPins[category] || categoryColorFromHue((hashStr(category) % 360 + theme.hueRotate) % 360, theme.saturation))
      : "";
    if (host) {
      host.className = "wg-thumb-grid wg-static-collection" + (category ? " wg-category-content" : "");
      if (categoryColor) host.style.setProperty("--wg-category-accent", categoryColor);
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
          if (categoryColor) entry.style.setProperty("--wg-category-accent", categoryColor);
        }
        fragment.appendChild(entry);
      } catch (error) {
        console.error("Prompt Palette: library item render failed", error);
        const fallback = document.createElement("div");
        fallback.className = "wg-item wg-virtual-fallback" + (category ? " wg-category-entry" : "");
        fallback.dataset.path = item?.path || "";
        fallback.textContent = String(item?.path || "Library entry").split("/").pop();
        if (categoryColor) fallback.style.setProperty("--wg-category-accent", categoryColor);
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

  function renderPickerList(filter = "", prefilteredItems = null) {
    const requestedFilter = String(filter || "");
    if (!pickerDrawer.classList.contains("open") || activeLibraryTab !== "personal" || performanceRuntime?.visualActive?.() === false) {
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
    pickerKbIndex = -1;
    const prevScrollTop = pickerList.scrollTop;
    virtualManager.clear();
    renderedLibraryItems = 0;
    const items = Array.isArray(prefilteredItems)
      ? prefilteredItems
      : requestedFilter
        ? (profiler?.measure("library.search", () => libraryIndex.search(requestedFilter, { limit: libraryIndex.size(), pinned, recent: state.recentList })) || libraryIndex.search(requestedFilter, { limit: libraryIndex.size(), pinned, recent: state.recentList }))
        : state.libraryCache;
    profiler?.measure("library.render", () => {
      pickerList.replaceChildren();
      if (!requestedFilter) {
        const pinnedItems = state.libraryCache.filter((entry) => pinned.has(entry.path));
        if (pinnedItems.length) {
          const label = document.createElement("div"); label.className = "wg-section-label"; label.textContent = "Pinned";
          pickerList.appendChild(label); mountStaticItems(pickerList, pinnedItems);
        }
        const recentItems = state.recentList.filter((path) => !pinned.has(path)).map((path) => libraryIndex.get(path)).filter(Boolean);
        if (recentItems.length) {
          const label = document.createElement("div"); label.className = "wg-section-label wg-section-label-row";
          label.innerHTML = `<span>Recent</span><button type="button" class="wg-clear-recent" data-act="clearRecent" title="Clear recent list">Clear</button>`;
          pickerList.appendChild(label); mountStaticItems(pickerList, recentItems);
        }
      }

      if (requestedFilter && items.length > LARGE_SEARCH_VIRTUAL_THRESHOLD) {
        const label = document.createElement("div");
        label.className = "wg-section-label";
        label.textContent = `Search results · ${items.length.toLocaleString()}`;
        pickerList.appendChild(label);
        mountVirtualItems(pickerList, items, requestedFilter);
        return;
      }

      const grouped = new Map();
      for (const entry of items) {
        const cat = categoryOf(entry.path);
        if (!grouped.has(cat)) grouped.set(cat, []);
        grouped.get(cat).push(entry);
      }
      const canReorder = !requestedFilter;
      let catNames;
      if (canReorder) {
        const present = Array.from(grouped.keys());
        const known = state.catOrder.filter((cat) => present.includes(cat));
        const unseen = present.filter((cat) => !state.catOrder.includes(cat)).sort();
        catNames = [...known, ...unseen];
        if (unseen.length) { state.catOrder = catNames.slice(); saveCatOrder(state.catOrder); }
      } else catNames = Array.from(grouped.keys()).sort();

      for (const cat of catNames) {
        const catItems = grouped.get(cat) || [];
        const isExpanded = !!requestedFilter || expandedCats.has(cat);
        const header = document.createElement("div");
        header.className = "wg-folder" + (isExpanded ? " expanded" : "") + (isRecipeCategory(cat) ? " wg-folder-recipe" : "") + (canReorder ? " wg-draggable" : "");
        header.dataset.cat = cat; header.draggable = canReorder;
        const categoryColor = theme.categoryPins[cat] || categoryColorFromHue((hashStr(cat) % 360 + theme.hueRotate) % 360, theme.saturation);
        header.style.setProperty("--wg-category-accent", categoryColor);
        const folderLabel = isRecipeCategory(cat) ? `&#128214; ${escapeHtml(cat)}` : escapeHtml(cat);
        header.innerHTML = `<span class="wg-folder-caret">${isExpanded ? "▾" : "▸"}</span><span class="wg-folder-name">${folderLabel}</span><span class="wg-folder-count">${catItems.length}</span>`;
        header.title = isExpanded ? "Click to collapse" : "Click to expand";
        pickerList.appendChild(header);
        if (isExpanded) mountStaticItems(pickerList, catItems, requestedFilter, cat);
      }
      if (!items.length) {
        const empty = document.createElement("div"); empty.className = "wg-hint"; empty.style.padding = "6px"; empty.textContent = "no matches"; pickerList.appendChild(empty);
      }
    });
    pickerList.scrollTop = Math.min(prevScrollTop, Math.max(0, pickerList.scrollHeight - pickerList.clientHeight));
    virtualManager.refresh();
    profiler?.count("libraryRenders");
    profiler?.gauge("visibleLibraryItems", renderedLibraryItems);
  }

  function jumpToCategory(cat) {
    searchInput.value = "";
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
      rows[pickerKbIndex].querySelector(".wg-name").click();
    } else if (e.key === "Escape" && searchInput.value) {

      e.preventDefault();
      e.stopPropagation();
      searchInput.value = "";
      renderPickerList("");
    }
  });

  async function refreshLibrary() {
    const nextLibrary = await API.list();
    if (!nodeIsActive(node)) return false;
    let nextThumbMap = state.thumbMap;
    try {
      nextThumbMap = await API.categories();
    } catch (error) {
      console.error("Prompt Palette: thumbnail refresh failed", error);
    }
    if (!nodeIsActive(node)) return false;
    state.libraryCache = nextLibrary;
    state.knownSet = new Set(nextLibrary.map((item) => item.path));
    state.thumbMap = nextThumbMap;
    renderLibrary?.();
    renderPickerList(searchInput.value);
    return true;
  }

  async function refreshThumbMap() {
    try {
      const nextThumbMap = await API.categories();
      if (!nodeIsActive(node)) return false;
      state.thumbMap = nextThumbMap;
      renderPickerList(searchInput.value);
      return true;
    } catch (error) {
      console.error("Prompt Palette: thumbnail refresh failed", error);
      return false;
    }
  }

  async function setThumbnailForItem(path) {
    const file = await pickThumbnailFile();
    if (!file) return;
    const err = thumbnailFileError(file);
    if (err) { notify("error", "Thumbnail not set", err); return; }
    try {
      const res = await API.setThumbnail(path, file);
      if (!res.ok) { notify("error", "Thumbnail not set", res.error || "the server rejected the upload"); return; }
      state.thumbBust[path] = Date.now();
      await refreshThumbMap();
      notify("success", "Thumbnail updated", path.split("/").pop());
    } catch (e) {
      notify("error", "Thumbnail not set", "network error while uploading");
    }
  }

  async function removeThumbnailForItem(path) {
    try {
      const res = await API.removeThumbnail(path);
      if (!res.ok) { notify("error", "Thumbnail not removed", res.error || "the server rejected the request"); return; }
      state.thumbBust[path] = Date.now();
      await refreshThumbMap();
      notify("success", "Thumbnail removed", path.split("/").pop());
    } catch (e) {
      notify("error", "Thumbnail not removed", "network error");
    }
  }

  node._wgRefreshLibrary = refreshLibrary;

  async function promptExtractSelectionToWildcard(start, end) {
    const selectedText = textarea.value.slice(start, end);
    const trimmed = selectedText.trim();
    if (!trimmed) return;
    const raw = await dialogPrompt({
      title: "Save to My Library",
      message: 'Choose a My Library path (for example, "poses/playful_foxes"):',
      defaultValue: state.starterSaveSuggestion,
    });
    if (raw === null || raw === undefined) return;
    const slug = normalizeLibraryEntryPath(raw);
    if (!slug) {
      notify("error", "Library entry not saved", "Enter a valid path using letters, numbers, - _ or /.");
      return;
    }
    if (state.knownSet.has(slug)) {
      const overwrite = await dialogConfirm({
        title: "Overwrite Library Entry",
        message: `"${slug}" already exists \u2014 overwrite it?`,
      });
      if (!overwrite) return;
    }
    const res = await API.save(slug, trimmed);
    if (!res.ok) {
      notify("error", "Library entry not saved", res.error || "save failed");
      return;
    }
    previewCache.delete(slug);
    state.starterSaveSuggestion = "";

    await refreshLibrary();
    insertInjectorText(textarea, render, `__${slug}__`, null, null, { start, end });
    const cat = categoryOf(slug);
    if (!expandedCats.has(cat)) {
      expandedCats.add(cat);
      saveExpandedCats(expandedCats);
    }
    renderPickerList(searchInput.value);
    const label = trimmed.length > 40 ? trimmed.slice(0, 40) + "\u2026" : trimmed;
    notify("success", "Saved to My Library", `${label} \u2192 __${slug}__`);
  }

  const editName = el("editName");
  const editContent = el("editContent");
  const editStatus = el("editStatus");

  async function loadIntoEditDrawer(name) {
    editName.value = name;
    let data;
    try { data = await API.content(name); }
    catch (error) {
      editStatus.textContent = error?.message || "couldn't load library entry";
      editStatus.className = "wg-status err";
      return;
    }
    if (data && data.found) {
      editContent.value = data.content;
      editContent.disabled = !data.editable;
      editStatus.textContent = data.editable ? "" : "YAML/JSON library entries are edited in their source file.";
      editStatus.className = "wg-status";
    } else {
      editContent.value = "";
      editContent.disabled = false;
      editStatus.textContent = "new library entry \u2014 write one option per line, then save.";
      editStatus.className = "wg-status";
    }
  }

  function openEditForItem(path) {
    closeSettings();
    closeStash();
    ioRail.close();
    closePickerDrawer();
    editDrawer.classList.add("open");
    root.querySelector('[data-act="edit"]').classList.add("active");
    loadIntoEditDrawer(path);
  }

  async function saveEditDrawer() {
    const name = editName.value.trim();
    if (!name) { editStatus.textContent = "enter a name/path first"; editStatus.className = "wg-status err"; return; }
    const res = await API.save(name, editContent.value);
    if (res.ok) {
      editStatus.textContent = "saved.";
      editStatus.className = "wg-status";
      previewCache.delete(name);
      await refreshLibrary();
      renderPickerList(searchInput.value);
    } else {
      editStatus.textContent = res.error || "save failed";
      editStatus.className = "wg-status err";
    }
  }
  root.querySelector('[data-act="save"]').addEventListener("click", saveEditDrawer);

  editName.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const name = editName.value.trim();
    if (name) loadIntoEditDrawer(name);
  });
  root.querySelector('[data-act="delete"]').addEventListener("click", async () => {
    const name = editName.value.trim();
    if (!name) return;
    const res = await API.del(name);
    if (res.ok) {
      editStatus.textContent = "deleted.";
      editStatus.className = "wg-status";
      previewCache.delete(name);
      editContent.value = "";
      await refreshLibrary();
      renderPickerList(searchInput.value);
    } else {
      editStatus.textContent = res.error || "delete failed";
      editStatus.className = "wg-status err";
    }
  });

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
    pickerDrawer.classList.remove("open");
    pickerDrawer.setAttribute("aria-hidden", "true");
    pickerDrawer.setAttribute("inert", "");
    libraryButton.classList.remove("active");
    libraryButton.setAttribute("aria-expanded", "false");
    starterPackController.setActive(false);
    virtualManager.clear();
    workerSearchVersion += 1;
    performanceRuntime?.cancelTimer("library-worker-search");
    cancelNodeTimer(node, searchDebounce);
    searchDebounce = null;
    cancelNodeTimer(node, hoverDebounce);
    hoverDebounce = null;
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

  const pickerViewToggleBtn = el("pickerViewToggle");
  function syncPickerViewToggleBtn() {
    pickerViewToggleBtn.classList.toggle("active", state.pickerViewMode === "grid");
    pickerViewToggleBtn.title = state.pickerViewMode === "grid" ? "Switch to list view" : "Switch to grid view";
    pickerViewToggleBtn.innerHTML = svgIcon(state.pickerViewMode === "grid" ? "list" : "grid");
  }
  syncPickerViewToggleBtn();
  pickerViewToggleBtn.addEventListener("click", () => {
    state.pickerViewMode = state.pickerViewMode === "grid" ? "list" : "grid";
    savePickerView(state.pickerViewMode);
    syncPickerViewToggleBtn();
    renderPickerList(searchInput.value);
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
    editDrawer.classList.toggle("open", opening);
    e.currentTarget.classList.toggle("active", opening);
  });

  root.querySelector('[data-act="closeEditDrawer"]').addEventListener("click", closeEditDrawer);

  editDrawer.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      saveEditDrawer();
    }
  });
  return {
    refreshLibrary,
    refreshThumbMap,
    renderPickerList,
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
    cleanup() { virtualManager.cleanup(); starterPackController.cleanup(); },
  };
}
