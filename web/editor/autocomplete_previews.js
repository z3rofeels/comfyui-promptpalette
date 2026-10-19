import { API } from "../prompt_palette_api.js";
import { copyPromptPaletteThemeScope } from "../prompt_palette_shared.js";
import { stylePreviewUrl } from "./style_library_model.js";
import { getWorkspacePreferences } from "../prompt_palette_state.js";

let revision = -1, categories = null;
const cached = new Map();
let activeRequests = 0;
const waiting = [];
function requestPreviews(items) {
  if (waiting.length >= 8) return Promise.reject(new Error("Preview requests are busy"));
  return new Promise((resolve, reject) => {
    const run = () => {
      activeRequests += 1;
      API.completionPreviews(items).then(resolve, reject).finally(() => {
        activeRequests -= 1; waiting.shift()?.();
      });
    };
    if (activeRequests < 2) run(); else waiting.push(run);
  });
}
const identity = item => JSON.stringify([item.kind, item.source || "", item.category, item.value]);
function refreshRevision() {
  const current = API.previewRevision();
  if (revision !== current) { revision = current; categories = null; cached.clear(); }
  return current;
}

async function previewUrls(rows) {
  const version = refreshRevision();
  const tags = rows.filter(({item}) => item.kind === "booru");
  const missing = [...new Map(tags.filter(({item}) => !cached.has(identity(item))).map(({item}) => [identity(item), item])).values()];
  for (let start = 0; start < missing.length; start += 100) {
    const chunk = missing.slice(start, start + 100);
    const pending = requestPreviews(chunk.map(({kind, source, category, value}) => ({kind, source, category, value})))
      .then(data => chunk.map((_, index) => stylePreviewUrl(data.items?.[index] || {})));
    // Cache in-flight lookups as well as results; typed updates share the same work.
    chunk.forEach((item, index) => {
      const key = identity(item), value = pending.then(urls => urls[index]);
      cached.set(key, value);
      value.catch(() => { if (version === revision && cached.get(key) === value) cached.delete(key); });
    });
  }
  while (cached.size > 512) cached.delete(cached.keys().next().value);
  const library = rows.some(({item}) => !["booru", "custom", "syntax"].includes(item.kind));
  if (library && !categories) {
    const pending = API.categories(); categories = pending;
    pending.catch(() => { if (categories === pending) categories = null; });
  }
  const map = library ? await categories.catch(() => ({})) : {};
  // Metadata errors cannot take away text suggestions or the other image source.
  return Promise.all(rows.map(async ({item}) => {
    if (item.kind === "booru") return cached.get(identity(item))?.catch(() => "") || "";
    if (item.kind === "custom" || item.kind === "syntax") return "";
    const path = map[item.value] || map[item.value.replace(/\.txt$/i, "")];
    return path ? API.thumbnailUrl(path, `&v=${version}`) : "";
  }));
}

export function hydrateAcThumbnails(menu, rows, activeIndex, isCurrent, onLayout = () => {}) {
  let disposed = false, timer = null, tip = null, hovering = activeIndex, layoutFrame = 0;
  const listeners = [], images = [];
  const hide = () => { clearTimeout(timer); timer = null; tip?.remove(); tip = null; };
  const show = (row, url) => {
    hide();
    if (getWorkspacePreferences().disableHoverPreviews) return;
    timer = setTimeout(() => {
      if (disposed || !isCurrent() || getWorkspacePreferences().disableHoverPreviews || !row.isConnected || hovering !== Number(row.dataset.acIndex)) return;
      const rect = menu.getBoundingClientRect(), width = 204, gap = 10;
      const right = rect.right + gap, left = rect.left - width - gap;
      if (right + width > window.innerWidth - 8 && left < 8) return;
      tip = document.createElement("div");
      tip.className = "wg-ac-preview wg-root"; tip.dataset.promptPaletteGlobal = "true";
      tip.setAttribute("aria-hidden", "true"); copyPromptPaletteThemeScope(menu, tip);
      const image = document.createElement("img"); image.alt = ""; image.src = url;
      image.addEventListener("error", hide, {once:true}); tip.append(image);
      tip.style.left = `${right + width <= window.innerWidth - 8 ? right : left}px`;
      tip.style.top = `${Math.max(8, Math.min(row.getBoundingClientRect().top, window.innerHeight - 212))}px`;
      document.body.append(tip);
    }, 320);
  };
  const leave = () => { hovering = -1; hide(); };
  menu.addEventListener("mouseleave", leave); listeners.push(() => menu.removeEventListener("mouseleave", leave));
  for (const {row, index} of rows) {
    const enter = () => { hovering = index; hide(); };
    row.addEventListener("mouseenter", enter); listeners.push(() => row.removeEventListener("mouseenter", enter));
  }
  previewUrls(rows).then(urls => {
    if (disposed || !isCurrent()) return;
    rows.forEach(({row, index}, position) => {
      const url = urls[position]; if (!url) return;
      const image = document.createElement("img");
      image.className = "wg-ac-thumb"; image.alt = ""; image.decoding = "async"; image.hidden = true;
      image.onload = () => {
        if (disposed || !isCurrent()) return;
        image.hidden = false;
        if (!layoutFrame) layoutFrame = requestAnimationFrame(() => { layoutFrame = 0; if (!disposed && isCurrent()) onLayout(); });
        if (hovering === index) show(row, url);
      };
      image.onerror = () => { image.hidden = true; image.remove(); if (hovering === index) hide(); };
      row.prepend(image); images.push(image); image.src = url;
      const enter = () => { hovering = index; if (!image.hidden) show(row, url); else hide(); };
      row.addEventListener("mouseenter", enter); listeners.push(() => row.removeEventListener("mouseenter", enter));
    });
  }).catch(() => { /* Optional imagery must leave autocomplete usable. */ });
  const cleanup = () => { disposed = true; hide(); cancelAnimationFrame(layoutFrame); for (const remove of listeners) remove(); for (const image of images) { image.onload = null; image.onerror = null; image.remove(); } };
  cleanup.dismiss = leave;
  return cleanup;
}
