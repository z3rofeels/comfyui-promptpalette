import { API } from "../prompt_palette_api.js";
import { copyPromptPaletteThemeScope, installPromptPaletteKeyboardBoundary } from "../prompt_palette_shared.js";
import { dialogChoice, dialogConfirm, trackDialog } from "./dialogs.js";
import { notify } from "./notifications.js";
import { parseCustomRow, resetCustomWords } from "./custom_words.js";
import { panelToneFor } from "./panel_tone.js";

// Local-only manager for Prompt Palette's own custom words list (autocomplete.txt in the ComfyUI
// user folder): find, remove, import and export. Nothing here talks to anything but this server.

const RENDER_LIMIT = 200;
const LARGE_IMPORT_WARNING_BYTES = 100 * 1024 * 1024;
const EXPORT_NAME = "prompt_palette_custom_words.csv";
const THEME_SCOPE = ".wg-root, .wg-node, .pp-node, .ppwc-surface";
const FORMAT_HINT = "CSV or text file, one word per line: tag,category,count,aliases. No Prompt Palette file-size limit; lists over 100 MB may be slow. "
  + "Category is a Danbooru id (0 general, 1 artist, 3 copyright, 4 character, 5 meta) or a name. "
  + "Only the tag is required.";

let activeManager = null;

function describeRow(row) {
  const parsed = parseCustomRow(row.fields) || {};
  const word = parsed.word || row.fields?.[0] || "";
  const aliases = parsed.aliases || [];
  return {
    id: row.id,
    word,
    category: parsed.category || "",
    count: parsed.count || 0,
    aliases,
    search: [word, ...aliases].join(" ").toLocaleLowerCase(),
    staged: false,
  };
}

function pill(text, modifier) {
  const el = document.createElement("span");
  el.className = `wg-ac-pill ${modifier}`;
  el.textContent = text;
  el.title = text;
  return el;
}

function button(label, className, title) {
  const el = document.createElement("button");
  el.type = "button";
  el.className = className;
  el.textContent = label;
  if (title) el.title = title;
  return el;
}

function downloadText(text, filename) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function openCustomWordsManager({ themeSource = null } = {}) {
  if (activeManager) { activeManager.focus(); return; }

  const returnFocus = document.activeElement;
  const scope = themeSource?.closest?.(THEME_SCOPE) || returnFocus?.closest?.(THEME_SCOPE) || null;

  let rows = [];
  let external = false;
  let query = "";
  let busy = false;
  let loadError = "";
  let loaded = false;
  let closed = false;

  const overlay = document.createElement("div");
  overlay.className = "wg-choice-backdrop wg-cw-backdrop wg-root";
  overlay.dataset.promptPaletteGlobal = "true";
  if (scope) copyPromptPaletteThemeScope(scope, overlay);
  const releaseKeyboard = installPromptPaletteKeyboardBoundary(overlay);

  const dialog = document.createElement("div");
  dialog.className = "wg-cw-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", "wg-cw-title");

  const head = document.createElement("div");
  head.className = "wg-cw-head";
  const title = document.createElement("strong");
  title.id = "wg-cw-title";
  title.textContent = "Custom words";
  const closeButton = button("\u00d7", "wg-cw-close", "Close");
  closeButton.setAttribute("aria-label", "Close");
  head.append(title, closeButton);

  const toolbar = document.createElement("div");
  toolbar.className = "wg-cw-toolbar";
  const search = document.createElement("input");
  search.type = "search";
  search.className = "wg-cw-search";
  search.placeholder = "Find a word or shortcut";
  search.setAttribute("aria-label", "Find a word or shortcut");
  search.autocomplete = "off";
  search.spellcheck = false;
  const importButton = button("Import\u2026", "wg-button", FORMAT_HINT);
  const exportButton = button("Export", "wg-button", "Download your custom words as a CSV file");
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = ".csv,.txt,text/csv,text/plain";
  fileInput.hidden = true;
  toolbar.append(search, importButton, exportButton, fileInput);

  const list = document.createElement("div");
  list.className = "wg-cw-list";
  list.setAttribute("role", "list");

  const foot = document.createElement("div");
  foot.className = "wg-cw-foot";
  const status = document.createElement("span");
  status.className = "wg-cw-status";
  status.setAttribute("aria-live", "polite");
  const removeButton = button("Remove", "wg-button danger-quiet wg-cw-apply");
  const doneButton = button("Done", "wg-button primary");
  foot.append(status, removeButton, doneButton);

  dialog.append(head, toolbar, list, foot);
  overlay.appendChild(dialog);

  const stagedCount = () => rows.reduce((total, row) => total + (row.staged ? 1 : 0), 0);

  function renderFooter() {
    const staged = stagedCount();
    removeButton.hidden = staged === 0;
    removeButton.disabled = busy;
    removeButton.textContent = staged === 1 ? "Remove 1 word" : `Remove ${staged} words`;
    if (staged) status.textContent = "Marked words are removed when you press Remove.";
    else if (loadError) status.textContent = loadError;
    else status.textContent = external
      ? "Words from ComfyUI-Custom-Scripts also load here, but they are read-only."
      : "Stored on this computer, in your ComfyUI user folder.";
    status.classList.toggle("error", !!loadError && !staged);
    importButton.disabled = exportButton.disabled = busy;
  }

  function renderList() {
    list.textContent = "";
    if (!loaded) return;
    const tokens = query.toLocaleLowerCase().split(/[_\s]+/).filter(Boolean);
    const matches = tokens.length ? rows.filter((row) => tokens.every((token) => row.search.includes(token))) : rows;
    if (!matches.length) {
      const empty = document.createElement("div");
      empty.className = "wg-cw-empty";
      empty.textContent = rows.length
        ? "No matches."
        : "No custom words yet. Add one from the autocomplete menu, or import a CSV.";
      list.appendChild(empty);
      return;
    }
    for (const row of matches.slice(0, RENDER_LIMIT)) {
      const el = document.createElement("div");
      el.className = "wg-cw-row";
      el.setAttribute("role", "listitem");
      el.dataset.cat = row.category || "custom";
      el.dataset.staged = String(row.staged);

      const word = document.createElement("strong");
      word.className = "wg-cw-word";
      word.textContent = row.word;
      word.title = row.word;

      const pills = document.createElement("span");
      pills.className = "wg-cw-pills";
      if (row.count) pills.appendChild(pill(row.count.toLocaleString(), "wg-ac-count"));
      for (const alias of row.aliases) pills.appendChild(pill(alias, "wg-ac-alias"));

      const toggle = button(row.staged ? "\u21ba" : "\u00d7", "wg-cw-remove");
      toggle.title = row.staged ? "Keep this word" : "Mark for removal";
      toggle.setAttribute("aria-label", `${row.staged ? "Keep" : "Remove"} ${row.word}`);
      toggle.addEventListener("click", () => {
        row.staged = !row.staged;
        el.dataset.staged = String(row.staged);
        toggle.textContent = row.staged ? "\u21ba" : "\u00d7";
        toggle.title = row.staged ? "Keep this word" : "Mark for removal";
        toggle.setAttribute("aria-label", `${row.staged ? "Keep" : "Remove"} ${row.word}`);
        renderFooter();
      });

      el.append(word, pills, toggle);
      list.appendChild(el);
    }
    if (matches.length > RENDER_LIMIT) {
      const more = document.createElement("div");
      more.className = "wg-cw-empty";
      more.textContent = `Showing the first ${RENDER_LIMIT}. Search to narrow the list.`;
      list.appendChild(more);
    }
  }

  async function load() {
    const result = await API.customWordRows();
    if (closed) return;
    loaded = true;
    if (result?.ok !== true || !Array.isArray(result.rows)) {
      loadError = result?.error || "Couldn't load your custom words.";
      rows = [];
    } else {
      loadError = "";
      rows = result.rows.map(describeRow);
      external = !!result.external;
    }
    renderList();
    renderFooter();
  }

  async function applyRemoval() {
    const staged = rows.filter((row) => row.staged);
    if (!staged.length || busy) return;
    busy = true;
    renderFooter();
    const result = await API.removeCustomWords(staged.map((row) => row.id));
    busy = false;
    resetCustomWords();
    if (result?.ok !== true) {
      notify("error", "Couldn't remove words", result?.error || "The custom words file could not be updated.");
      if (!closed) renderFooter();
      return;
    }
    notify("success", result.removed === 1 ? "Removed 1 word" : `Removed ${result.removed} words`);
    if (closed) return;
    rows = rows.filter((row) => !row.staged);
    renderList();
    renderFooter();
  }

  async function importFile(file) {
    if (!file || busy) return;
    if (file.size >= LARGE_IMPORT_WARNING_BYTES) {
      const size = (file.size / (1024 * 1024)).toFixed(1);
      const proceed = await dialogConfirm({
        title: "Large custom word list",
        message: `${size} MB is a large list. Importing and searching it may use more memory and make autocomplete slower. Continue?`,
      });
      if (!proceed) return;
    }
    let text = "";
    try { text = await file.text(); }
    catch { notify("error", "Couldn't read that file"); return; }
    let mode = "merge";
    if (rows.length) {
      mode = await dialogChoice({
        title: "Import custom words",
        message: `Add the words in \u201c${file.name}\u201d to your list, or replace your list with them? Replacing keeps a backup copy (autocomplete.txt.bak) next to your list.`,
        choices: [
          { label: "Add to my list", value: "merge", primary: true },
          { label: "Replace my list", value: "replace", danger: true },
          { label: "Cancel", value: null },
        ],
      });
      if (!mode || closed) return;
    }
    busy = true;
    renderFooter();
    const result = await API.importCustomWords(text, mode);
    busy = false;
    resetCustomWords();
    if (result?.ok !== true) {
      notify("error", "Import failed", result?.error || "Couldn't import that file.");
      if (!closed) renderFooter();
      return;
    }
    const parts = [`${result.added} added`];
    if (result.duplicates) parts.push(`${result.duplicates} already in your list`);
    if (result.skipped) parts.push(`${result.skipped} skipped`);
    notify(result.added || mode === "replace" ? "success" : "info", mode === "replace" ? "List replaced" : "Custom words imported", parts.join(", "));
    if (!closed) await load();
  }

  async function exportWords() {
    if (busy) return;
    const result = await API.customWordRows();
    if (result?.ok !== true || !Array.isArray(result.rows)) {
      notify("error", "Couldn't export", result?.error || "Couldn't read your custom words.");
      return;
    }
    if (!result.rows.length) {
      notify("info", "Nothing to export", "Your custom words list is empty.");
      return;
    }
    downloadText(result.rows.map((row) => row.id).join("\n") + "\n", EXPORT_NAME);
    notify("success", "Custom words exported", result.rows.length === 1 ? "1 word" : `${result.rows.length} words`);
  }

  function close() {
    if (closed) return;
    closed = true;
    activeManager = null;
    releaseDialog();
    releaseKeyboard();
    overlay.remove();
    if (returnFocus instanceof HTMLElement && returnFocus.isConnected) returnFocus.focus({ preventScroll: true });
  }
  const releaseDialog = trackDialog(close);

  overlay.addEventListener("mousedown", (event) => { if (event.target === overlay) close(); });
  overlay.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      if (document.activeElement === search && search.value) {
        search.value = "";
        query = "";
        renderList();
      } else {
        close();
      }
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...dialog.querySelectorAll("button:not([disabled]):not([hidden]), input:not([hidden]):not([disabled])")];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  closeButton.addEventListener("click", close);
  doneButton.addEventListener("click", close);
  removeButton.addEventListener("click", applyRemoval);
  importButton.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    importFile(file);
  });
  exportButton.addEventListener("click", exportWords);
  search.addEventListener("input", () => { query = search.value; renderList(); });

  activeManager = { focus: () => search.focus({ preventScroll: true }) };
  document.body.appendChild(overlay);
  dialog.dataset.acTone = panelToneFor(dialog);
  renderFooter();
  search.focus({ preventScroll: true });
  load();
}
