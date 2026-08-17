const STYLE_PROMISES = new Map();

export function loadExtensionStylesheet(href, id = href) {
  if (STYLE_PROMISES.has(id)) return STYLE_PROMISES.get(id);
  const existing = Array.from(document.querySelectorAll("link[data-prompt-palette-style]")).find(
    (link) => link.dataset.promptPaletteStyle === String(id),
  );
  if (existing) {
    const ready = Promise.resolve(existing);
    STYLE_PROMISES.set(id, ready);
    return ready;
  }
  const promise = new Promise((resolve, reject) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.dataset.promptPaletteStyle = id;
    link.addEventListener("load", () => resolve(link), { once: true });
    link.addEventListener("error", () => {
      link.remove();
      reject(new Error(`Unable to load ${href}`));
    }, { once: true });
    document.head.appendChild(link);
  });
  const tracked = promise.catch((error) => {
    if (STYLE_PROMISES.get(id) === tracked) STYLE_PROMISES.delete(id);
    throw error;
  });
  STYLE_PROMISES.set(id, tracked);
  return tracked;
}

export function downloadJsonFile(filename, value) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function pickJsonFile({ multiple = false } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.multiple = multiple;
    input.style.display = "none";
    input.addEventListener("change", async () => {
      const files = Array.from(input.files || []);
      input.remove();
      if (!files.length) return resolve([]);
      const results = [];
      for (const file of files) {
        results.push({ file, text: await file.text() });
      }
      resolve(results);
    }, { once: true });
    input.addEventListener("cancel", () => { input.remove(); resolve([]); }, { once: true });
    document.body.appendChild(input);
    input.click();
  });
}

export function normalizeThemeFilename(name) {
  const clean = String(name || "prompt-palette-theme")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "prompt-palette-theme";
  return `${clean}.prompt-palette.json`;
}

export function svgIcon(name, size = 14) {
  const paths = {
    gallery: '<path d="M3 4.5h6l1.4 1.7H21v12.3a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2v-12a2 2 0 0 1 2-2Z"/><path d="m6 16 3-3 2.5 2.5 2-2L18 18"/><circle cx="16.5" cy="10" r="1.5"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/>',
    recipe: '<path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v17H6.5A2.5 2.5 0 0 0 4 21.5Z"/><path d="M4 4.5v17"/><path d="M8 7h8M8 11h6"/>',
    stash: '<path d="M4 7h16v14H4z"/><path d="M2 3h20v4H2z"/><path d="M9 11h6"/>',
    refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
    undo: '<path d="M9 7 4 12l5 5"/><path d="M20 17a8 8 0 0 0-11-8l-5 3"/>',
    redo: '<path d="m15 7 5 5-5 5"/><path d="M4 17a8 8 0 0 1 11-8l5 3"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
    trash: '<path d="M3 6h18"/><path d="M8 6V3h8v3M19 6l-1 15H6L5 6M10 11v5M14 11v5"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6V21h-4v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H3v-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V3h4v.1a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9A1.7 1.7 0 0 0 21 10h.1v4H21a1.7 1.7 0 0 0-1.6 1Z"/>',
    zen: '<path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"/><path d="M9 12h6"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon: '<path d="M20.5 14.5A8 8 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11Z"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    dice: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1"/><circle cx="16" cy="8" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="8" cy="16" r="1"/><circle cx="16" cy="16" r="1"/>',
    branch: '<path d="M6 3v12a4 4 0 0 0 4 4h8"/><path d="m14 15 4 4-4 4"/><circle cx="6" cy="5" r="2"/><path d="M8 8h5a4 4 0 0 1 4 4v1"/>',
    io: '<path d="M4 6h6M14 6h6M4 18h6M14 18h6"/><circle cx="12" cy="6" r="2"/><circle cx="12" cy="18" r="2"/><path d="M12 8v8"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>',
    bolt: '<path d="m13 2-9 12h8l-1 8 9-12h-8Z"/>',
    folder: '<path d="M3 5h6l2 2h10v12H3z"/>',
    upload: '<path d="M12 16V3M7 8l5-5 5 5"/><path d="M4 14v6h16v-6"/>',
    download: '<path d="M12 3v13M7 11l5 5 5-5"/><path d="M4 14v6h16v-6"/>',
    palette: '<path d="M12 3a9 9 0 0 0 0 18h1.5a2 2 0 0 0 0-4H12a2 2 0 0 1 0-4h3a6 6 0 0 0 0-12Z"/><circle cx="7.5" cy="10" r="1"/><circle cx="9" cy="6.5" r="1"/><circle cx="14" cy="6" r="1"/><circle cx="17" cy="9" r="1"/>',
    github: '<path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3.3-.4 6.8-1.6 6.8-7A5.4 5.4 0 0 0 19.4 4 5 5 0 0 0 19.3.5S18.2.1 15 1.8a13.4 13.4 0 0 0-6 0C5.8.1 4.7.5 4.7.5A5 5 0 0 0 4.6 4a5.4 5.4 0 0 0-1.4 3.7c0 5.4 3.5 6.6 6.8 7A4.8 4.8 0 0 0 9 18v4"/><path d="M9 18c-4.5 2-5-2-7-2"/>',
  };
  const body = paths[name] || paths.settings;
  return `<svg class="wg-svg-icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}


const PROMPT_PALETTE_THEME_KEYS = Object.freeze([
  "bg", "panel-bg", "surface", "border", "border-strong", "text", "text-dim", "text-faint",
  "accent", "accent-text", "success", "danger",
]);
const PROMPT_PALETTE_TYPOGRAPHY_KEYS = Object.freeze([
  "font-family", "editor-font-size", "ui-font-scale", "prompt-text",
]);
const PROMPT_PALETTE_EFFECT_KEYS = Object.freeze(["accent-glow", "corner-radius"]);

function clampPromptPaletteNumber(value, min, max, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

/** Normalize the small suite-wide shape setting shared by every Prompt Palette surface. */
export function promptPaletteEffectSettings(theme = {}) {
  const cornerRadius = clampPromptPaletteNumber(theme?.cornerRadius, 4, 18, 10);
  return {
    // Keep the legacy data attribute stable for older mounted surfaces, but use one
    // consistent palette-driven treatment instead of alternate finish modes.
    finish: "clean",
    "accent-glow": "0%",
    "corner-radius": `${cornerRadius}px`,
  };
}

/** Apply Prompt Palette variables to a Prompt Palette-owned DOM surface only. */
export function applyPromptPaletteThemeScope(target, colors = {}, typography = {}, effects = null) {
  if (!target?.style) return;
  for (const key of PROMPT_PALETTE_THEME_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(colors || {}, key)) continue;
    const value = colors[key];
    if (value == null || value === "") target.style.removeProperty(`--wg-${key}`);
    else target.style.setProperty(`--wg-${key}`, String(value));
  }
  for (const key of PROMPT_PALETTE_TYPOGRAPHY_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(typography || {}, key)) continue;
    const value = typography[key];
    if (value == null || value === "") target.style.removeProperty(`--wg-${key}`);
    else target.style.setProperty(`--wg-${key}`, String(value));
  }
  if (effects && typeof effects === "object") {
    const finish = ["clean", "soft", "glow", "glass"].includes(effects.finish) ? effects.finish : "soft";
    target.dataset.wgFinish = finish;
    for (const key of PROMPT_PALETTE_EFFECT_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(effects, key)) continue;
      const value = effects[key];
      if (value == null || value === "") target.style.removeProperty(`--wg-${key}`);
      else target.style.setProperty(`--wg-${key}`, String(value));
    }
  }
}

/** Remove variables written by Prompt Palette versions that themed :root globally. */
export function clearLegacyPromptPaletteGlobalTheme() {
  const style = globalThis.document?.documentElement?.style;
  if (!style) return;
  for (const key of [...PROMPT_PALETTE_THEME_KEYS, ...PROMPT_PALETTE_TYPOGRAPHY_KEYS, ...PROMPT_PALETTE_EFFECT_KEYS]) {
    style.removeProperty(`--wg-${key}`);
  }
}

/** Copy the currently resolved Prompt Palette variables to a body-mounted Prompt Palette popup. */
export function copyPromptPaletteThemeScope(source, target) {
  if (!source || !target?.style || typeof globalThis.getComputedStyle !== "function") return;
  const computed = getComputedStyle(source);
  for (const key of [...PROMPT_PALETTE_THEME_KEYS, ...PROMPT_PALETTE_TYPOGRAPHY_KEYS, ...PROMPT_PALETTE_EFFECT_KEYS]) {
    const value = computed.getPropertyValue(`--wg-${key}`).trim();
    if (value) target.style.setProperty(`--wg-${key}`, value);
  }
  const finish = source.dataset?.wgFinish;
  if (finish) target.dataset.wgFinish = finish;
}

/**
 * Mark a Prompt Palette-owned surface as a keyboard boundary.
 * Keyboard and clipboard events are allowed to complete normally inside the focused field,
 * then stop at the Prompt Palette root so ComfyUI canvas/sidebar shortcuts never receive them.
 */
export function installPromptPaletteKeyboardBoundary(target) {
  if (!target?.addEventListener) return () => {};
  target.dataset.promptPaletteKeyboardBoundary = "true";
  const stop = (event) => event.stopPropagation();
  for (const type of ["keydown", "keyup", "keypress", "copy", "cut", "paste"]) target.addEventListener(type, stop);

  let cleaned = false;
  return () => {
    if (cleaned) return;
    cleaned = true;
    for (const type of ["keydown", "keyup", "keypress", "copy", "cut", "paste"]) target.removeEventListener(type, stop);
    delete target.dataset.promptPaletteKeyboardBoundary;
  };
}

// Appearance synchronization uses one Prompt Palette-owned runtime registry per page.
// Keeping it on globalThis makes separate extension-module instances converge on the
// same subscriber set without broadcasting DOM events to unrelated ComfyUI UI. Calls
// are frame-coalesced so theme/font controls trigger at most one suite-wide refresh per frame.
const PROMPT_PALETTE_APPEARANCE_RUNTIME_KEY = Symbol.for("comfyui.prompt-palette.appearance-runtime.v1");
const promptPaletteAppearanceRuntime = globalThis[PROMPT_PALETTE_APPEARANCE_RUNTIME_KEY]
  || (globalThis[PROMPT_PALETTE_APPEARANCE_RUNTIME_KEY] = { subscribers: new Set(), frame: 0 });

function flushPromptPaletteAppearanceChanged() {
  const runtime = promptPaletteAppearanceRuntime;
  runtime.frame = 0;
  for (const callback of Array.from(runtime.subscribers)) {
    try { callback(); }
    catch (error) { console.error("Prompt Palette: appearance sync failed", error); }
  }
}

export function notifyPromptPaletteAppearanceChanged({ immediate = false } = {}) {
  const runtime = promptPaletteAppearanceRuntime;
  if (!runtime.subscribers.size) return;

  // Theme selection is a discrete action. Flush it synchronously so every mounted
  // Prompt Palette surface changes from the same stored theme before ComfyUI can
  // repaint one node with stale chrome. Continuous controls (color pickers, sliders)
  // keep the existing frame coalescing to avoid redundant work.
  if (immediate) {
    if (runtime.frame) {
      const cancel = globalThis.cancelAnimationFrame || clearTimeout;
      try { cancel(runtime.frame); } catch {}
      runtime.frame = 0;
    }
    flushPromptPaletteAppearanceChanged();
    return;
  }

  if (runtime.frame) return;
  const raf = globalThis.requestAnimationFrame || ((callback) => setTimeout(callback, 0));
  runtime.frame = raf(flushPromptPaletteAppearanceChanged);
}

/**
 * Apply Prompt Palette colors to ComfyUI's native node chrome.
 *
 * Some frontend builds (notably older/bundled Vue Nodes 2 paths) do not react
 * reliably to raw `node.color` / `node.bgcolor` assignments. Modern ComfyUI
 * listens for `node:property:changed`; explicitly emitting the same event keeps
 * the Vue chrome and LiteGraph state in sync while remaining harmless on legacy
 * canvas nodes.
 */
export function applyPromptPaletteNodeChrome(node, colors = {}) {
  if (!node) return;
  const graph = node.graph;
  const changes = [
    ["color", colors.accent],
    ["bgcolor", colors.bg],
    ["boxcolor", colors.accent],
  ];

  for (const [property, newValue] of changes) {
    if (newValue == null || newValue === "") continue;
    const oldValue = node[property];
    node[property] = newValue;

    // `color` and `bgcolor` are reactive properties in current Vue Nodes.
    // Send an explicit event even when the value was already assigned so a stale
    // renderer snapshot can be refreshed. Older graphs simply ignore this path.
    if ((property === "color" || property === "bgcolor") && typeof graph?.trigger === "function") {
      try {
        graph.trigger("node:property:changed", {
          nodeId: node.id,
          property,
          oldValue,
          newValue,
        });
      } catch {}
    }
  }

  node.setDirtyCanvas?.(true, true);
  graph?.setDirtyCanvas?.(true, true);
}

export function onPromptPaletteAppearanceChanged(callback) {
  if (typeof callback !== "function") return () => {};
  const subscribers = promptPaletteAppearanceRuntime.subscribers;
  subscribers.add(callback);
  let cleaned = false;
  return () => {
    if (cleaned) return;
    cleaned = true;
    subscribers.delete(callback);
  };
}

// ---------------------------------------------------------------------------
// Suite-wide viewport Settings drawer coordinator.
//
// Settings are rendered through one Prompt Palette-owned viewport portal rather
// than as direct children of ComfyUI's canvas/document layout. Closed drawers are
// removed from rendering with the native `hidden` attribute after their exit
// transition completes. This keeps the settings redesign isolated from node DOM
// measurement in both canvas and Vue renderers.
// ---------------------------------------------------------------------------
const PROMPT_PALETTE_SETTINGS_DRAWERS = new Set();
let activePromptPaletteSettingsDrawer = null;
let promptPaletteSettingsGlobalsInstalled = false;
let promptPaletteSettingsPortal = null;

function settingsDrawerDocument() {
  return globalThis.document || null;
}

function ensurePromptPaletteSettingsPortal() {
  const doc = settingsDrawerDocument();
  if (!doc?.body) return null;
  if (promptPaletteSettingsPortal?.isConnected) return promptPaletteSettingsPortal;
  const portal = doc.createElement("div");
  portal.className = "wg-settings-viewport-portal";
  portal.dataset.promptPaletteSettingsPortal = "true";
  portal.setAttribute("aria-live", "off");
  doc.body.appendChild(portal);
  promptPaletteSettingsPortal = portal;
  return portal;
}

function removePromptPaletteSettingsPortalIfIdle() {
  if (PROMPT_PALETTE_SETTINGS_DRAWERS.size) return;
  promptPaletteSettingsPortal?.remove?.();
  promptPaletteSettingsPortal = null;
}

function cancelSettingsDrawerClose(entry) {
  if (entry.closeTimer) {
    clearTimeout(entry.closeTimer);
    entry.closeTimer = 0;
  }
  if (entry.openFrame) {
    const cancel = globalThis.cancelAnimationFrame || clearTimeout;
    cancel(entry.openFrame);
    entry.openFrame = 0;
  }
}

function finishSettingsDrawerClose(entry) {
  if (!entry?.popup || activePromptPaletteSettingsDrawer === entry || entry.popup.classList.contains("open")) return;
  cancelSettingsDrawerClose(entry);
  entry.popup.hidden = true;
}

function scheduleSettingsDrawerClose(entry) {
  const { popup } = entry;
  if (!popup || popup.hidden) return;
  const onTransitionEnd = (event) => {
    if (event.target !== popup || event.propertyName !== "transform") return;
    popup.removeEventListener("transitionend", onTransitionEnd);
    finishSettingsDrawerClose(entry);
  };
  popup.addEventListener("transitionend", onTransitionEnd, { once: true });
  // A transition event is not emitted when reduced motion disables transitions.
  // The fallback only finalizes visibility; it never changes node geometry.
  entry.closeTimer = setTimeout(() => {
    popup.removeEventListener("transitionend", onTransitionEnd);
    finishSettingsDrawerClose(entry);
  }, 260);
}

function setSettingsDrawerState(entry, open) {
  const { popup, trigger } = entry;
  if (!popup) return;
  cancelSettingsDrawerClose(entry);
  if (open) {
    popup.hidden = false;
    popup.removeAttribute("inert");
    popup.setAttribute("aria-hidden", "false");
    trigger?.classList?.add("active");
    trigger?.setAttribute?.("aria-expanded", "true");

    // Add the visible state on the next paint so the portal can animate from its
    // closed transform without forcing synchronous layout measurement.
    const raf = globalThis.requestAnimationFrame || ((callback) => setTimeout(callback, 0));
    entry.openFrame = raf(() => {
      entry.openFrame = 0;
      if (activePromptPaletteSettingsDrawer !== entry) return;
      popup.classList.add("open");
    });
  } else {
    const wasVisible = !popup.hidden && popup.classList.contains("open");
    popup.classList.remove("open");
    popup.setAttribute("aria-hidden", "true");
    popup.setAttribute("inert", "");
    trigger?.classList?.remove("active");
    trigger?.setAttribute?.("aria-expanded", "false");
    if (wasVisible) scheduleSettingsDrawerClose(entry);
    else popup.hidden = true;
  }
}

function restoreSettingsTriggerFocus(entry) {
  const trigger = entry?.trigger;
  if (!trigger?.focus || trigger.isConnected === false) return;
  const focus = () => {
    try { trigger.focus({ preventScroll: true }); }
    catch { try { trigger.focus(); } catch {} }
  };
  if (typeof globalThis.queueMicrotask === "function") globalThis.queueMicrotask(focus);
  else Promise.resolve().then(focus);
}

export function closeActivePromptPaletteSettingsDrawer({ restoreFocus = true, reason = "programmatic" } = {}) {
  const entry = activePromptPaletteSettingsDrawer;
  if (!entry) return false;
  activePromptPaletteSettingsDrawer = null;
  setSettingsDrawerState(entry, false);
  try { entry.onClose?.(reason); }
  catch (error) { console.error("Prompt Palette: settings close hook failed", error); }
  if (restoreFocus) restoreSettingsTriggerFocus(entry);
  return true;
}

function handlePromptPaletteSettingsPointerDown(event) {
  const entry = activePromptPaletteSettingsDrawer;
  if (!entry || entry.isBlocked?.()) return;
  const target = event.target;
  if (entry.popup?.contains?.(target) || entry.trigger?.contains?.(target)) return;
  closeActivePromptPaletteSettingsDrawer({ restoreFocus: false, reason: "outside" });
}

function handlePromptPaletteSettingsKeyDown(event) {
  const entry = activePromptPaletteSettingsDrawer;
  if (!entry || event.key !== "Escape" || entry.isBlocked?.()) return;
  event.preventDefault?.();
  event.stopPropagation?.();
  closeActivePromptPaletteSettingsDrawer({ restoreFocus: true, reason: "escape" });
}

function installPromptPaletteSettingsGlobals() {
  if (promptPaletteSettingsGlobalsInstalled) return;
  const doc = settingsDrawerDocument();
  if (!doc?.addEventListener) return;
  doc.addEventListener("pointerdown", handlePromptPaletteSettingsPointerDown, true);
  doc.addEventListener("keydown", handlePromptPaletteSettingsKeyDown, true);
  promptPaletteSettingsGlobalsInstalled = true;
}

function cleanupPromptPaletteSettingsGlobalsIfIdle() {
  if (!promptPaletteSettingsGlobalsInstalled || PROMPT_PALETTE_SETTINGS_DRAWERS.size) return;
  const doc = settingsDrawerDocument();
  doc?.removeEventListener?.("pointerdown", handlePromptPaletteSettingsPointerDown, true);
  doc?.removeEventListener?.("keydown", handlePromptPaletteSettingsKeyDown, true);
  promptPaletteSettingsGlobalsInstalled = false;
}

export function registerPromptPaletteSettingsDrawer({
  popup, trigger, isBlocked = null, onOpen = null, onClose = null,
} = {}) {
  if (!popup || !trigger) throw new Error("Prompt Palette settings drawer requires popup and trigger elements.");

  const portal = ensurePromptPaletteSettingsPortal();
  if (!portal) throw new Error("Prompt Palette settings drawer could not create its viewport portal.");
  portal.appendChild(popup);

  popup.classList.add("wg-root", "wg-global-settings-popup");
  popup.setAttribute("role", "dialog");
  popup.setAttribute("aria-modal", "false");
  popup.setAttribute("aria-hidden", "true");
  popup.setAttribute("inert", "");
  popup.hidden = true;
  trigger.setAttribute("aria-expanded", "false");

  const entry = { popup, trigger, isBlocked, onOpen, onClose, openFrame: 0, closeTimer: 0 };
  PROMPT_PALETTE_SETTINGS_DRAWERS.add(entry);
  installPromptPaletteSettingsGlobals();

  let cleaned = false;
  const controller = {
    open() {
      if (cleaned) return false;
      if (activePromptPaletteSettingsDrawer === entry) return true;
      if (activePromptPaletteSettingsDrawer) {
        closeActivePromptPaletteSettingsDrawer({ restoreFocus: false, reason: "switch" });
      }
      activePromptPaletteSettingsDrawer = entry;
      setSettingsDrawerState(entry, true);
      try { entry.onOpen?.(); }
      catch (error) { console.error("Prompt Palette: settings open hook failed", error); }
      return true;
    },
    close(options = {}) {
      if (activePromptPaletteSettingsDrawer !== entry) {
        setSettingsDrawerState(entry, false);
        return false;
      }
      return closeActivePromptPaletteSettingsDrawer(options);
    },
    toggle() {
      return activePromptPaletteSettingsDrawer === entry ? controller.close() : controller.open();
    },
    isOpen() {
      return activePromptPaletteSettingsDrawer === entry;
    },
    unregister() {
      if (cleaned) return;
      cleaned = true;
      if (activePromptPaletteSettingsDrawer === entry) {
        closeActivePromptPaletteSettingsDrawer({ restoreFocus: false, reason: "unregister" });
      } else {
        setSettingsDrawerState(entry, false);
      }
      cancelSettingsDrawerClose(entry);
      popup.hidden = true;
      PROMPT_PALETTE_SETTINGS_DRAWERS.delete(entry);
      cleanupPromptPaletteSettingsGlobalsIfIdle();
      removePromptPaletteSettingsPortalIfIdle();
    },
  };
  return controller;
}

export { PROMPT_PALETTE_THEME_KEYS, PROMPT_PALETTE_TYPOGRAPHY_KEYS };
