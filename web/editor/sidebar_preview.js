import { API } from "../prompt_palette_api.js";

// Read-only views of the existing wildcard index, not a second library/editor.
export function createSidebarQuickPreview(root, announce) {
  const panel = document.createElement("section"); panel.className = "pp-sidebar-quickview"; panel.hidden = true; panel.setAttribute("role", "region"); panel.setAttribute("aria-label", "Read-only library quick preview");
  const head = document.createElement("div"); head.className = "pp-sidebar-quickview-head";
  const title = document.createElement("strong"), close = document.createElement("button"); close.type = "button"; close.textContent = "×"; close.setAttribute("aria-label", "Close quick preview"); head.append(title, close);
  const note = document.createElement("small"); note.className = "pp-sidebar-note"; note.textContent = "Sample contents · read only · up to five lines per entry";
  const body = document.createElement("div"); body.className = "pp-sidebar-quickview-body"; body.setAttribute("aria-live", "polite");
  panel.append(head, note, body); root.append(panel);
  let serial = 0, disposed = false, pinned = false, openTimer, closeTimer;
  const cache = new Map();
  function read(path) {
    if (!cache.has(path)) {
      const request = API.preview(path).catch(error => { cache.delete(path); throw error; });
      cache.set(path, request); if (cache.size > 64) cache.delete(cache.keys().next().value);
    }
    return cache.get(path);
  }
  function hide() { serial++; clearTimeout(openTimer); clearTimeout(closeTimer); panel.hidden = true; pinned = false; }
  async function show(label, paths, { pin = true, anchor = null, total = paths.length } = {}) {
    clearTimeout(openTimer); clearTimeout(closeTimer); const request = ++serial; pinned = pin;
    panel.hidden = false; title.textContent = label; body.textContent = "Reading local samples…";
    const names = paths.slice(0, 3);
    const results = await Promise.allSettled(names.map(read));
    if (disposed || request !== serial) return;
    if (anchor && !anchor.isConnected) { hide(); return; }
    body.replaceChildren();
    if (!names.length) { body.textContent = "No entries in this category."; return; }
    results.forEach((result, i) => {
      const block = document.createElement("div"); block.className = "pp-sidebar-quickview-entry";
      if (names.length > 1) { const name = document.createElement("strong"); name.textContent = names[i]; block.append(name); }
      const pre = document.createElement("pre");
      if (result.status === "fulfilled") { const data = result.value; pre.textContent = data.found === false ? "Entry unavailable. Rescan the local library." : (data.lines || []).slice(0, 5).map(line => String(line).slice(0, 1200)).join("\n") || "No sample lines."; }
      else pre.textContent = result.reason?.message || "Could not read this local entry.";
      block.append(pre); body.append(block);
    });
    if (total > names.length) { const tail = document.createElement("small"); tail.className = "pp-sidebar-note"; tail.textContent = `Showing ${names.length} of ${total.toLocaleString()} entries in this category.`; body.append(tail); }
  }
  function bind(control, path) {
    const open = () => { if (pinned) return; clearTimeout(openTimer); clearTimeout(closeTimer); openTimer = setTimeout(() => show(path, [path], { pin: false, anchor: control }), 280); };
    const leave = () => { clearTimeout(openTimer); if (!pinned) { clearTimeout(closeTimer); closeTimer = setTimeout(hide, 240); } };
    control.addEventListener("pointerenter", open); control.addEventListener("pointerleave", leave);
    // Keyboard users have an explicit Quick view button; focusing Insert does
    // not open a popover or move the editor selection.
  }
  const onKey = event => { if (event.key === "Escape" && !panel.hidden) { event.preventDefault(); event.stopPropagation(); hide(); } };
  panel.addEventListener("pointerenter", () => { clearTimeout(closeTimer); });
  panel.addEventListener("pointerleave", () => { if (!pinned) closeTimer = setTimeout(hide, 240); });
  close.addEventListener("click", hide); root.addEventListener("keydown", onKey);
  return { bind, show, hide, invalidate() { cache.clear(); hide(); }, cleanup() { disposed = true; hide(); root.removeEventListener("keydown", onKey); panel.remove(); } };
}
