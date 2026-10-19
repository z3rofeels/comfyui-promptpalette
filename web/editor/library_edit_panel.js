// Behavior for the "Edit My Library" drawer: thumbnail square, path hints, live statistics,
// text clean-up tools, dirty tracking and Revert.
//
// The drawer's existing hooks (`editName`, `editContent`, `editStatus`, the save/delete buttons)
// stay owned by the host controllers, which still load, save and delete entries. The host tells
// this panel what is on disk through `setBaseline()`; everything else is derived from the DOM.
import { API } from "../prompt_palette_api.js";
import { pickThumbnailFile, thumbnailFileError, changeLibraryThumbnail } from "./thumbnails.js";
import { normalizeLibraryEntryPath, isRecipeCategory, categoryOf } from "./text_utils.js";
import { notify } from "./notifications.js";
import { attachLibraryEditPromptTools } from "./library_edit_prompt_tools.js";

const entryPath = raw => normalizeLibraryEntryPath(raw, { preserveName: true });

const isOptionLine = line => { const t = line.trim(); return t !== "" && !t.startsWith("#"); };
const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

// Pure text tools. Blank lines and `#` comment lines are never reordered or removed by
// sorting or de-duplicating, because the wildcard index treats them as notes, not options.
export function sortOptionLines(text) {
  const lines = String(text).split("\n");
  const sorted = lines.filter(isOptionLine).sort((a, b) => collator.compare(a.trim(), b.trim()));
  let next = 0;
  return lines.map(line => (isOptionLine(line) ? sorted[next++] : line)).join("\n");
}

export function removeDuplicateLines(text) {
  const seen = new Set();
  let removed = 0;
  const kept = String(text).split("\n").filter(line => {
    if (!isOptionLine(line)) return true;
    const key = line.trim();
    if (seen.has(key)) { removed += 1; return false; }
    seen.add(key);
    return true;
  });
  return { text: kept.join("\n"), removed };
}

export function tidyLines(text) {
  const lines = String(text).split("\n").map(line => line.replace(/\s+$/g, "").replace(/^\s+(?=\S)/, ""));
  const out = [];
  for (const line of lines) { if (line === "" && (out.length === 0 || out.at(-1) === "")) continue; out.push(line); }
  while (out.at(-1) === "") out.pop();
  return out.join("\n");
}

export function textStats(text) {
  const options = String(text).split("\n").filter(isOptionLine).map(line => line.trim());
  return { options: options.length, duplicates: options.length - new Set(options).size, chars: String(text).length };
}

let panelCounter = 0;

export function createLibraryEditPanel({ drawer, el, getLibrary = () => [], enterLoads = false, onThumbnailChanged = null, onStateChange = null, getMatches, onCommit }) {
  const name = el("editName"), content = el("editContent"), status = el("editStatus");
  const badge = el("editBadge"), thumbBox = el("editThumb"), thumbImg = el("editThumbImg");
  const addBtn = el("editThumbAdd"), replaceBtn = el("editThumbReplace"), removeBtn = el("editThumbRemove"), thumbNote = el("editThumbNote");
  const syntax = el("editSyntax"), copyBtn = el("editCopy"), hint = el("editPathHint"), stats = el("editStats");
  const sortBtn = el("editSort"), dedupeBtn = el("editDedupe"), tidyBtn = el("editTidy");
  const revertBtn = el("editRevert"), folders = el("editFolders");
  const saveBtn = drawer.querySelector('[data-act="save"]'), deleteBtn = drawer.querySelector('[data-act="delete"]');
  const uid = `pp-ledit-${++panelCounter}`;
  name.id = `${uid}-name`; content.id = `${uid}-content`; folders.id = `${uid}-folders`; name.setAttribute("list", folders.id);
  drawer.querySelector('label[data-for="editName"]')?.setAttribute("for", name.id);
  drawer.querySelector('label[data-for="editContent"]')?.setAttribute("for", content.id);

  el("editHelp").id = `${uid}-help`;
  content.setAttribute("aria-describedby", el("editHelp").id);
  const promptTools = attachLibraryEditPromptTools({ drawer, el, getLibrary, getMatches, onCommit,
    applyText: (text, start, end) => { setContent(text); content.setSelectionRange(start, end); } });

  let baseline = { path: "", content: "", found: false, editable: true };
  let loading = false, disposed = false, busy = false, writing = false;
  let thumbMap = {}, thumbBust = 0, thumbVersion = 0;
  let pending = null; // { file, url } chosen for an entry that is not saved yet
  let choiceVersion = 0, attaching = null;
  let copyTimer = null;

  const currentPath = () => entryPath(name.value);
  let librarySnapshot = null, pathSet = new Set(), entryTypes = new Map();
  const libraryPaths = () => {
    const items = getLibrary() || [];
    if (items !== librarySnapshot) {
      librarySnapshot = items; pathSet = new Set(items.map(item => item.path));
      entryTypes = new Map(items.map(item => [item.path, item.type]));
    }
    return pathSet;
  };
  const isRecipe = path => !!path && isRecipeCategory(categoryOf(path));
  const dirty = () => !loading && (currentPath() !== baseline.path || content.value !== baseline.content);
  const thumbnailEditable = () => {
    libraryPaths();
    const path = currentPath(), type = entryTypes.get(path);
    return type ? type === "txt" : path !== baseline.path || !baseline.found || baseline.editable;
  };

  function fillFolders() {
    const set = new Set();
    for (const item of getLibrary() || []) {
      const parts = String(item.path || "").split("/");
      for (let i = 1; i < parts.length; i++) set.add(parts.slice(0, i).join("/") + "/");
    }
    folders.replaceChildren(...[...set].sort(collator.compare).slice(0, 300).map(value => { const option = document.createElement("option"); option.value = value; return option; }));
  }

  function setContent(text) {
    content.focus();
    content.select();
    // execCommand keeps the browser's own Ctrl+Z working after a tool runs; the fallback covers
    // an empty replacement and environments where it is unavailable.
    if (!text || !document.execCommand?.("insertText", false, text)) content.value = text;
    content.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function renderThumb() {
    if (disposed) return;
    const path = currentPath();
    const rel = path ? thumbMap[path] : "";
    const src = pending?.url || (rel ? API.thumbnailUrl(rel, thumbBust ? `&v=${thumbBust}` : "") : "");
    const has = !!src;
    thumbBox.classList.toggle("has-image", has);
    thumbBox.classList.toggle("busy", busy);
    thumbImg.hidden = !has;
    if (has) { if (thumbImg.getAttribute("src") !== src) thumbImg.src = src; } else thumbImg.removeAttribute("src");
    addBtn.hidden = has;
    replaceBtn.hidden = removeBtn.hidden = !has;
    const editable = thumbnailEditable();
    addBtn.disabled = replaceBtn.disabled = removeBtn.disabled = busy || loading || writing || !editable;
    thumbNote.textContent = !editable ? "TXT entries only" : pending ? "Added when you save" : "";
    thumbNote.hidden = !thumbNote.textContent;
  }

  function refresh() {
    if (disposed) return;
    const path = currentPath(), typed = name.value.trim().replace(/\\/g, "/");
    const known = libraryPaths(), changed = dirty() || !!pending;
    const readOnly = !baseline.editable && baseline.found;
    const state = loading ? "loading" : writing ? "saving" : readOnly ? "readonly" : changed ? "dirty" : baseline.found ? "saved" : "new";
    badge.dataset.state = state;
    badge.textContent = { loading: "Loading…", saving: "Saving…", readonly: "Read-only", dirty: "Unsaved changes", saved: "Saved", new: "New entry" }[state];

    el("editTitle").textContent = baseline.found ? "Edit entry" : "New entry";
    const recipe = isRecipe(path);
    el("editHelp").textContent = recipe ? "Recipe source. Keep its existing structure when editing." : "One option per line. Each line can be a word or a full prompt. Lines starting with # are notes.";

    syntax.textContent = path ? `__${path}__` : "__category/name__";
    syntax.classList.toggle("placeholder", !path);
    copyBtn.disabled = !path;

    let message = "Use folders to organize entries: category/subcategory/name", tone = "";
    if (path) {
      const exists = known.has(path), other = path !== baseline.path;
      if (typed && typed !== path) { message = `Will be saved as ${path}`; tone = "info"; }
      else { const folder = path.split("/").slice(0, -1).join("/"), format = readOnly ? "YAML/JSON" : "TXT"; message = folder ? `Folder: ${folder} · ${format}` : `No folder, saved at the top level · ${format}`; }
      if (exists && other) { message = enterLoads ? "Already exists. Press Enter to load it, or save to overwrite." : "Already exists. Saving will ask before overwriting."; tone = "warn"; }
      else if (baseline.found && other) { message = `Save a copy here. The original stays at ${baseline.path}.`; tone = "info"; }
    }
    hint.textContent = message; hint.dataset.tone = tone;

    const s = textStats(content.value);
    stats.textContent = `${s.options.toLocaleString()} option${s.options === 1 ? "" : "s"}${s.duplicates ? ` · ${s.duplicates} duplicate${s.duplicates === 1 ? "" : "s"}` : ""} · ${s.chars.toLocaleString()} char${s.chars === 1 ? "" : "s"}`;
    stats.dataset.tone = s.duplicates ? "warn" : "";

    const toolsOn = !content.disabled && !recipe && !loading && !writing;
    sortBtn.disabled = tidyBtn.disabled = !toolsOn || !content.value;
    dedupeBtn.disabled = !toolsOn || s.duplicates === 0;
    revertBtn.disabled = !changed || loading || writing;
    deleteBtn.disabled = !baseline.found || !baseline.editable || path !== baseline.path || loading || writing;
    saveBtn.disabled = readOnly || loading || writing || content.disabled || !path;
    saveBtn.textContent = writing ? "Saving…" : baseline.found && path !== baseline.path ? "Save copy" : "Save";
    drawer.setAttribute("aria-busy", String(loading || writing));
    promptTools.refresh();
    renderThumb();
    onStateChange?.({ baseline, path, dirty: changed, loading, busy: writing });
  }

  async function loadThumbMap() {
    const request = ++thumbVersion;
    try {
      const map = await API.categories();
      if (disposed || request !== thumbVersion) return;
      thumbMap = map && typeof map === "object" ? map : {};
    } catch { /* the square simply stays on its last known state */ }
    renderThumb();
  }

  async function uploadThumbnail(path, file) {
    busy = true; renderThumb();
    try {
      return await changeLibraryThumbnail(path, { file, isActive: () => !disposed, onChanged: async () => {
        thumbBust = Date.now(); await loadThumbMap();
        if (!disposed) await onThumbnailChanged?.(path);
      } });
    }
    finally { busy = false; if (!disposed) renderThumb(); }
  }

  function clearPending() {
    if (pending) URL.revokeObjectURL(pending.url);
    pending = null;
  }

  async function chooseThumbnail() {
    if (busy || loading || writing || !thumbnailEditable()) return;
    const path = currentPath(), choice = ++choiceVersion;
    const file = await pickThumbnailFile();
    if (!file || disposed || choice !== choiceVersion || path !== currentPath() || loading || writing) return;
    const problem = thumbnailFileError(file);
    if (problem) { notify("error", "Thumbnail not set", problem); return; }
    if (path && libraryPaths().has(path)) { clearPending(); await uploadThumbnail(path, file); return; }
    // Not in the library yet: show it now and attach it once the entry is saved.
    clearPending();
    pending = { file, url: URL.createObjectURL(file) };
    refresh();
  }

  async function removeThumbnail() {
    if (busy || loading || writing || !thumbnailEditable()) return;
    if (pending) { clearPending(); refresh(); return; }
    const path = currentPath();
    if (!path) return;
    busy = true; renderThumb();
    try {
      await changeLibraryThumbnail(path, { remove: true, isActive: () => !disposed, onChanged: async () => {
        thumbBust = Date.now(); await loadThumbMap();
        if (!disposed) await onThumbnailChanged?.(path);
      } });
    }
    finally { busy = false; if (!disposed) renderThumb(); }
  }

  // A save published by the host makes the staged image attachable.
  const unsubscribe = API.onLibraryChanged(async () => {
    if (disposed) return;
    fillFolders();
    loadThumbMap();
    if (!pending || attaching || busy) return;
    const path = currentPath(), staged = pending;
    if (!path || !thumbnailEditable()) return;
    attaching = staged;
    try {
      const found = (await API.content(path, { fresh: true }).catch(() => null))?.found;
      if (!found || pending !== staged || disposed || path !== currentPath()) return;
      if (await uploadThumbnail(path, staged.file)) {
        if (pending === staged) { clearPending(); refresh(); }
      }
    } finally { if (attaching === staged) attaching = null; }
  });

  const announce = (text, tone = "") => { status.textContent = text; status.className = tone ? `wg-status ${tone}` : "wg-status"; };
  const listeners = [];
  const on = (target, type, fn) => { target.addEventListener(type, fn); listeners.push(() => target.removeEventListener(type, fn)); };

  on(name, "input", () => { choiceVersion++; refresh(); });
  on(content, "input", refresh);
  on(addBtn, "click", chooseThumbnail);
  on(replaceBtn, "click", chooseThumbnail);
  on(removeBtn, "click", removeThumbnail);
  on(copyBtn, "click", async () => {
    try {
      await navigator.clipboard.writeText(syntax.textContent);
      copyBtn.classList.add("copied");
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => copyBtn.classList.remove("copied"), 900);
    } catch { copyBtn.title = "Copy failed: clipboard permission denied"; }
  });
  on(sortBtn, "click", () => { const next = sortOptionLines(content.value); if (next !== content.value) setContent(next); announce("Options sorted A–Z."); });
  on(dedupeBtn, "click", () => {
    const { text, removed } = removeDuplicateLines(content.value);
    if (removed) { setContent(text); announce(`Removed ${removed} duplicate option${removed === 1 ? "" : "s"}.`); }
  });
  on(tidyBtn, "click", () => { const next = tidyLines(content.value); if (next !== content.value) setContent(next); announce("Whitespace and extra blank lines cleaned up."); });
  on(revertBtn, "click", () => {
    name.value = baseline.path;
    clearPending();
    setContent(baseline.content);
    announce("Reverted to the saved version.");
  });

  fillFolders();
  loadThumbMap();
  refresh();

  return {
    beginLoad() { choiceVersion++; loading = true; promptTools.suspend(); refresh(); },
    endLoad() { loading = false; refresh(); },
    setBusy(value) { writing = value; if (value) promptTools.suspend(); refresh(); },
    suspend: promptTools.suspend,
    // `keepPending` is for a save: the staged thumbnail belongs to the entry that was just written.
    setBaseline(next, { keepPending = false } = {}) {
      choiceVersion++;
      baseline = { path: entryPath(next?.path), content: String(next?.content ?? ""), found: !!next?.found, editable: next?.editable !== false };
      loading = false;
      if (!keepPending) clearPending();
      fillFolders();
      loadThumbMap();
      refresh();
    },
    refresh,
    stagedThumbnail: () => pending?.file || null,
    restoreStagedThumbnail(file) { if (!file || thumbnailFileError(file)) return; clearPending(); pending = { file, url: URL.createObjectURL(file) }; refresh(); },
    cleanup() {
      disposed = true; thumbVersion++; choiceVersion++;
      clearTimeout(copyTimer); clearPending(); unsubscribe(); promptTools.cleanup();
      listeners.forEach(fn => fn());
    },
  };
}
