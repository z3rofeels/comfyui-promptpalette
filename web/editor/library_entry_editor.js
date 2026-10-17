// Shared disk-backed entry editing for the node drawer and the ComfyUI sidebar.
import { API } from "../prompt_palette_api.js";
import { createLibraryEditPanel } from "./library_edit_panel.js";
import { dialogConfirm } from "./dialogs.js";
import { normalizeLibraryEntryPath } from "./text_utils.js";

const entryPath = raw => normalizeLibraryEntryPath(raw, { preserveName: true });

export function createLibraryEntryEditor({ drawer, el, getLibrary, onChanged = null, onThumbnailChanged = null, onStateChange = null, getMatches, onCommit }) {
  const name = el("editName"), content = el("editContent"), status = el("editStatus");
  const panel = createLibraryEditPanel({ drawer, el, getLibrary, enterLoads: true, onThumbnailChanged, onStateChange, getMatches, onCommit });
  let version = 0, disposed = false, busy = false, loading = false;
  let baseline = { path: "", content: "", found: false, editable: true };
  const listeners = [];
  const on = (target, type, fn) => { target.addEventListener(type, fn); listeners.push(() => target.removeEventListener(type, fn)); };
  const message = (text, error = false) => { status.textContent = text; status.className = error ? "wg-status err" : "wg-status"; };
  const dirty = () => !!panel.stagedThumbnail() || entryPath(name.value) !== baseline.path || content.value !== baseline.content;
  function setBaseline(next, options) { baseline = next; panel.setBaseline(next, options); }
  async function mayDiscard() {
    return !dirty() || await dialogConfirm({ title: "Unsaved library changes", message: "Discard these changes and open another entry?" });
  }
  async function load(path, { confirm = false, existing = false } = {}) {
    if (busy || disposed) return false;
    // Reserve request order before awaiting a discard dialog, so a newer open
    // cannot be replaced by an earlier read.
    const request = ++version;
    if (confirm && !loading && !await mayDiscard()) return false;
    if (disposed || request !== version || busy) return false;
    path = entryPath(path);
    const expected = existing || (getLibrary() || []).some(item => item.path === path);
    loading = true; name.disabled = content.disabled = true; panel.beginLoad();
    message(path ? `Loading ${path}…` : "");
    try {
      const data = path ? await API.content(path, { fresh: true }) : null;
      if (disposed || request !== version) return false;
      if (path && expected && !data?.found) throw new Error(`Could not load “${path}”. Rescan the library and try again. Your previous draft is kept.`);
      if (data?.found && typeof data.content !== "string") throw new Error("This entry returned invalid content. Your previous draft is kept.");
      name.value = path;
      content.value = data?.found ? data.content : "";
      content.scrollTop = content.scrollLeft = 0; content.setSelectionRange(0, 0);
      setBaseline({ path, content: content.value, found: !!data?.found, editable: data?.editable !== false });
      message(data?.found ? (baseline.editable ? `Editing ${path}` : "YAML/JSON entries are read-only. Edit their source file.") : "New entry — add a path and one prompt option per line.");
      return true;
    } catch (error) {
      if (disposed || request !== version) return false;
      // Keep the previous baseline, text and staged thumbnail after a failed read.
      message(error.message, true); return false;
    } finally {
      if (!disposed && request === version) {
        loading = false; name.disabled = false; content.disabled = !baseline.editable;
        panel.endLoad();
      }
    }
  }
  async function save() {
    if (busy || loading || disposed) return;
    const path = entryPath(name.value), text = content.value;
    if (!path) { message("Enter an entry path first.", true); return; }
    if (content.disabled) { message("This entry is read-only; edit its source file.", true); return; }
    busy = true; name.disabled = content.disabled = true; panel.setBusy(true);
    try {
      const disk = await API.content(path, { fresh: true });
      if (disposed) return;
      if (disk?.found && disk.editable === false) throw new Error("A read-only YAML/JSON entry already uses this path. Choose a different path.");
      if (disk?.found && (path !== baseline.path || disk.content !== baseline.content)
        && !await dialogConfirm({ title: "Overwrite Library Entry", message: `“${path}” already exists or changed in another panel. Overwrite it?` })) return;
      if (disposed) return;
      const res = await API.save(path, text);
      if (!res.ok) throw new Error(res.error || "Save failed.");
      if (disposed) return;
      name.value = path;
      setBaseline({ path, content: text, found: true, editable: true }, { keepPending: true });
      message(`Saved ${path}`); await onChanged?.(path);
    } catch (error) { if (!disposed) message(error.message, true); }
    finally { busy = false; if (!disposed) { name.disabled = false; content.disabled = !baseline.editable; panel.setBusy(false); } }
  }
  async function remove() {
    if (busy || loading || disposed || !baseline.found || !baseline.editable || entryPath(name.value) !== baseline.path) return;
    const path = baseline.path;
    busy = true;
    try {
      if (!await dialogConfirm({ title: "Delete Library Entry", message: `Delete “${path}”${dirty() ? " and discard your unsaved changes" : ""}?` })) return;
      if (disposed) return;
      name.disabled = content.disabled = true; panel.setBusy(true);
      const res = await API.del(path);
      if (!res.ok) throw new Error(res.error || "Delete failed.");
      if (disposed) return;
      name.value = ""; content.value = "";
      setBaseline({ path: "", content: "", found: false, editable: true }); message(`Deleted ${path}`);
      await onChanged?.(path);
    } catch (error) { if (!disposed) message(error.message, true); }
    finally { busy = false; if (!disposed) { name.disabled = false; content.disabled = !baseline.editable; panel.setBusy(false); } }
  }
  on(drawer.querySelector('[data-act="save"]'), "click", save);
  on(drawer.querySelector('[data-act="delete"]'), "click", remove);
  for (const input of [name, content]) on(input, "input", () => {
    if (!loading && !busy) message(dirty() ? "Unsaved changes. Save to update the library." : baseline.found ? `Editing ${baseline.path}` : "New entry — add a path and one prompt option per line.");
  });
  on(name, "keydown", event => { if (event.key === "Enter") { event.preventDefault(); load(name.value, { confirm: true }); } });
  on(drawer, "keydown", event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); event.stopPropagation(); save(); } });
  return { load, save, mayDiscard, dirty, refresh: panel.refresh, suspend: panel.suspend,
    snapshot: () => ({ baseline: { ...baseline }, path: name.value, content: content.value, disabled: !baseline.editable, thumbnail: panel.stagedThumbnail() }),
    restoreDraft(draft) {
      if (!draft?.baseline || disposed) return;
      version++; loading = false;
      name.value = draft.path; content.value = draft.content; content.disabled = !!draft.disabled;
      setBaseline(draft.baseline); panel.restoreStagedThumbnail(draft.thumbnail); panel.refresh();
    },
    cleanup() { disposed = true; version++; panel.cleanup(); listeners.forEach(fn => fn()); } };
}
