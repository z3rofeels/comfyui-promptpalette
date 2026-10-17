import { onPromptPaletteAppearanceChanged } from "../prompt_palette_shared.js";
import { nudgeHexForContrast } from "./text_utils.js";
import { isDialogOpen } from "./dialogs.js";

// Shared presentation contracts. Visibility still uses the suite's existing
// theme preferences; these helpers do not introduce another settings store.
export const TOOLBAR_BUTTONS = [
  ["btnGallery", "showGalleryBtn", "toggleGalleryBtn"],
  ["btnEdit", "showEditBtn", "toggleEditBtn"],
  ["btnImportImage", "showImportImageBtn", "toggleImportImageBtn"],
  ["btnRecipes", "showRecipesBtn", "toggleRecipesBtn"],
  ["btnStash", "showStashBtn", "toggleStashBtn"],
  ["btnRefresh", "showRefreshBtn", "toggleRefreshBtn"],
  ["btnUndo", "showUndoBtn", "toggleUndoBtn"],
  ["btnRedo", "showRedoBtn", "toggleRedoBtn"],
  ["btnResolve", "showResolveBtn", "toggleResolveBtn"],
  ["btnCopy", "showCopyBtn", "toggleCopyBtn"],
  ["btnClear", "showClearBtn", "toggleClearBtn"],
];

export function applyToolbarVisibility(root, theme) {
  for (const [name, key, toggleName] of TOOLBAR_BUTTONS) {
    const button = root.querySelector(`[data-el="${name}"]`);
    if (button) button.style.display = theme[key] === false ? "none" : "";
    const toggle = root.querySelector(`[data-el="${toggleName}"]`);
    if (toggle) toggle.checked = theme[key] !== false;
  }
}

export function setToolbarLabel(button, text) {
  const label = button.querySelector(".wg-toolbar-label");
  if (label) label.textContent = text;
  else button.textContent = text;
}

// Stable action IDs, independent of translated captions, visibility and node type.
const MODULES = [
  ["resolve", "Preview", "run"], ["variations", "Variations", "run"],
  ["positiveAntonyms", "Positive Antonyms", "run"],
  ["undo", "Undo", "edit"], ["redo", "Redo", "edit"], ["copy", "Copy", "edit"],
  ["picker", "Library", "source"], ["importImage", "Import image", "source"],
  ["stash", "Stash", "source"], ["recipesShortcut", "Recipes", "source"], ["edit", "Edit library", "source"],
  ["refresh", "Rescan library", "view"], ["ioRailToggle", "Inputs / outputs", "view"],
  ["dayNightToggle", "Day / night", "view"], ["zenToggle", "Zen", "view"],
  ["clear", "Clear", "danger"],
];
export const DEFAULT_TOOLBAR_ORDER = Object.freeze(MODULES.map(([key]) => key));

export const TOOLBAR_SCALE_PRESETS = Object.freeze([
  [60, "Ultra compact"], [80, "Compact"], [100, "Balanced"], [130, "Comfortable"], [180, "Extra large"],
]);
export function normalizeToolbarPreferences(theme = {}) {
  const allowed = new Set(DEFAULT_TOOLBAR_ORDER);
  const supplied = Array.isArray(theme.toolbarOrder) ? theme.toolbarOrder : [];
  const order = [...new Set(supplied.filter(key => allowed.has(key)))];
  const legacyScale = { small: 80, medium: 100, large: 130 }[theme.toolbarSize] || 100;
  const scale = Number(theme.toolbarScale);
  const toolbarScale = Math.max(60, Math.min(180, Number.isFinite(scale) && scale > 0 ? scale : legacyScale));
  return {
    toolbarMode: ["always", "click", "auto", "hidden"].includes(theme.toolbarMode) ? theme.toolbarMode : "always",
    toolbarScale,
    toolbarSize: toolbarScale < 90 ? "small" : toolbarScale < 120 ? "medium" : "large",
    toolbarOrder: [...order, ...DEFAULT_TOOLBAR_ORDER.filter(key => !order.includes(key))],
  };
}

// Used by both settings surfaces; the existing visibility switches stay in place.
export function toolbarDesignerMarkup() {
  return `<section class="wg-toolbar-designer" data-el="toolbarDesigner">
    <div class="wg-panel-title"><div><h3>Toolbar layout</h3><p>Shared by Prompt Palette editors and Combinatorial.</p></div></div>
    <div class="wg-toolbar-options">
      <label><span>Presentation</span><select data-toolbar-mode aria-label="Toolbar presentation">
        <option value="always">Always visible</option><option value="auto">Auto hide</option><option value="click">Collapsed · click to expand</option><option value="hidden">Hidden · Settings only</option>
      </select><small>Settings always stays within reach.</small></label>
      <label class="wg-range-field"><span>Toolbar size <output data-toolbar-scale-value>100%</output></span>
        <input type="range" data-toolbar-scale min="60" max="180" step="1" value="100" aria-label="Toolbar size">
      </label>
      <div class="wg-toolbar-sizes" role="group" aria-label="Toolbar size presets">
        ${TOOLBAR_SCALE_PRESETS.map(([value, label]) => `<button type="button" data-toolbar-scale-preset="${value}" aria-pressed="false">${label}</button>`).join("")}
      </div>
      <div class="wg-toolbar-preview" aria-hidden="true"><span>↶</span><span>↷</span><span>✧ Preview</span><span>⊕ Library</span></div>
    </div>
    <p class="wg-toolbar-help">Adjust from 60–180% or choose a preset. Labels adapt to available space; arrow buttons reach overflow actions. Auto hide opens on hover, keyboard focus or tap. Collapsed stays open until you close it.</p>
    <details class="wg-toolbar-arrange"><summary>Arrange buttons</summary>
      <p class="wg-toolbar-help">Drag a grip or use the arrows. Hidden actions keep their place. Settings stays at the edge.</p>
      <ol data-toolbar-order aria-label="Toolbar button order"></ol>
      <div class="wg-toolbar-order-footer"><button type="button" class="wg-button" data-toolbar-reset>Reset order</button><span data-toolbar-message role="status" aria-live="polite"></span></div>
    </details>
  </section>`;
}

// Measure in local CSS pixels: ComfyUI zoom transforms screen coordinates.
// The existing groups/controls stay in place; only their presentation adapts.
export function installToolbarLayout(root, { loadTheme, saveTheme, settingsRoot = root } = {}) {
  const toolbar = root.querySelector(".wg-toolbar");
  if (!toolbar) return () => {};
  const settings = toolbar.querySelector('[data-act="settings"]');
  const track = document.createElement("div");
  track.className = "wg-toolbar-track";
  track.setAttribute("role", "toolbar"); track.setAttribute("aria-label", "Prompt actions");
  const slots = new Map();
  // Move the original buttons, including their listeners. One slot per module
  // allows DOM order, keyboard order and visual order to agree across old groups.
  for (const [key, label, group] of MODULES) {
    const button = toolbar.querySelector(`[data-act="${key}"]`);
    if (!button) continue;
    const slot = document.createElement("span");
    slot.className = button.closest(".wg-toolbar-center") ? "wg-toolbar-item wg-toolbar-center" : "wg-toolbar-item wg-toolbar-group";
    if (button.closest(".left")) slot.classList.add("left");
    button.dataset.toolbarKey = key; button.dataset.toolbarGroup = group;
    if (!button.querySelector(".wg-toolbar-label")) {
      const caption = document.createElement("span"); caption.className = "wg-toolbar-caption"; caption.textContent = label;
      caption.setAttribute("aria-hidden", "true");
      const count = button.querySelector("[data-io-count]");
      if (count) button.insertBefore(caption, count); else button.appendChild(caption);
    }
    slot.appendChild(button); track.appendChild(slot); slots.set(key, { slot, button, label, group });
  }
  const previous = document.createElement("button"), next = document.createElement("button");
  for (const [button, label, glyph] of [[previous, "Previous toolbar actions", "‹"], [next, "More toolbar actions", "›"]]) {
    button.type = "button"; button.className = "wg-toolbar-scroll-button";
    button.setAttribute("aria-label", label); button.title = label; button.textContent = glyph; button.hidden = true;
  }
  previous.dataset.toolbarScroll = "previous"; next.dataset.toolbarScroll = "next";
  toolbar.replaceChildren(previous, track, next);
  const anchor = document.createElement("span"); anchor.className = "wg-toolbar-group wg-toolbar-anchor";
  if (settings) anchor.appendChild(settings);
  toolbar.appendChild(anchor);
  const dock = document.createElement("div"); dock.className = "wg-toolbar-dock"; dock.hidden = true;
  const reveal = document.createElement("button"); reveal.type = "button"; reveal.className = "wg-toolbar-reveal";
  reveal.textContent = "Tools"; reveal.setAttribute("aria-expanded", "false");
  toolbar.id ||= `pp-toolbar-${++toolbarSequence}`;
  reveal.setAttribute("aria-controls", toolbar.id); reveal.title = "Show or hide prompt tools";
  const pin = document.createElement("button"); pin.type = "button"; pin.className = "wg-toolbar-pin";
  pin.textContent = "Keep open"; pin.setAttribute("aria-pressed", "false");
  pin.title = "Keep this toolbar open until you release it";
  const dockAnchor = document.createElement("span"); dockAnchor.className = "wg-toolbar-dock-anchor";
  dock.append(reveal, pin, dockAnchor); toolbar.before(dock);
  const designer = settingsRoot.querySelector('[data-el="toolbarDesigner"]');
  const orderList = designer?.querySelector("[data-toolbar-order]");
  const message = designer?.querySelector("[data-toolbar-message]");
  let frame = null;
  let disposed = false;
  let preferences = normalizeToolbarPreferences(loadTheme?.());
  let expanded = preferences.toolbarMode === "always", held = false, hideTimer = null, dragged = null;
  let renderedOrder = "";
  const cleanups = [];
  function listen(target, type, handler, options) {
    target?.addEventListener(type, handler, options);
    cleanups.push(() => target?.removeEventListener(type, handler, options));
  }
  const visibleButtons = () => [...track.querySelectorAll("[data-toolbar-key]")]
    .filter(button => !button.hidden && button.getClientRects().length && getComputedStyle(button).display !== "none");
  function blocked() {
    return !!root.querySelector('.wg-drawer.open, .pp-power-popup.open, [data-act][aria-expanded="true"]') ||
      settings?.getAttribute("aria-expanded") === "true" || isDialogOpen();
  }
  function cancelHide() { if (hideTimer !== null) clearTimeout(hideTimer); hideTimer = null; }
  function setHeld(value) {
    held = value; pin.setAttribute("aria-pressed", String(value));
    pin.textContent = value ? "Release" : "Keep open";
    pin.title = value ? "Resume hiding for this node" : "Keep this toolbar open until you release it";
    reveal.title = expanded ? (preferences.toolbarMode === "auto" && !value ? "Keep prompt tools open" : "Hide prompt tools") : "Show prompt tools";
  }
  function setExpanded(value) {
    if (preferences.toolbarMode === "always") value = true;
    if (preferences.toolbarMode === "hidden") value = false;
    expanded = value;
    toolbar.hidden = !value; toolbar.inert = !value;
    toolbar.dataset.retractable = String(preferences.toolbarMode !== "always");
    reveal.setAttribute("aria-expanded", String(value));
    reveal.title = value ? (preferences.toolbarMode === "auto" && !held ? "Keep prompt tools open" : "Hide prompt tools") : "Show prompt tools";
    pin.hidden = !value;
    schedule();
  }
  function queueHide() {
    cancelHide();
    if (preferences.toolbarMode !== "auto" || held || !expanded) return;
    hideTimer = setTimeout(() => {
      hideTimer = null;
      if (disposed || held || toolbar.matches(":hover") || dock.matches(":hover") ||
          toolbar.contains(document.activeElement) || dock.contains(document.activeElement) || blocked()) return;
      setExpanded(false);
    }, preferences.toolbarMode === "auto" ? 650 : 0);
  }
  function write(patch) {
    if (!saveTheme || !loadTheme) return;
    saveTheme({ ...loadTheme(), ...patch });
  }
  function renderOrder() {
    if (!orderList) return;
    const keys = preferences.toolbarOrder.filter(key => slots.has(key));
    const signature = keys.join("|");
    if (renderedOrder !== signature) {
      const focused = orderList.contains(document.activeElement) ? { key: document.activeElement.closest("[data-toolbar-row]")?.dataset.toolbarRow, action: document.activeElement.dataset.toolbarMove || "grip" } : null;
      orderList.replaceChildren();
      keys.forEach((key, index) => {
        const row = document.createElement("li"); row.dataset.toolbarRow = key;
        const grip = document.createElement("button"); grip.type = "button"; grip.draggable = true;
        grip.className = "wg-toolbar-grip"; grip.textContent = "⠿";
        grip.dataset.toolbarGrip = key; grip.title = "Drag to move · Alt+Up / Alt+Down";
        grip.setAttribute("aria-label", `Reorder ${slots.get(key).label}`);
        const label = document.createElement("span"); label.className = "wg-toolbar-order-label"; label.textContent = slots.get(key).label;
        const status = document.createElement("small"); status.dataset.toolbarVisibility = key;
        row.append(grip, label, status);
        for (const [direction, glyph, disabled] of [["earlier", "↑", index === 0], ["later", "↓", index === keys.length - 1]]) {
          const button = document.createElement("button"); button.type = "button"; button.dataset.toolbarMove = direction;
          button.textContent = glyph; button.disabled = disabled;
          button.setAttribute("aria-label", `Move ${slots.get(key).label} ${direction}`); row.appendChild(button);
        }
        orderList.appendChild(row);
      });
      renderedOrder = signature;
      if (focused) {
        const row = orderList.querySelector(`[data-toolbar-row="${focused.key}"]`);
        const target = row?.querySelector(focused.action === "grip" ? "[data-toolbar-grip]" : `[data-toolbar-move="${focused.action}"]`);
        (target?.disabled ? row.querySelector("[data-toolbar-grip]") : target)?.focus({ preventScroll: true });
      }
    }
    for (const [key, { button }] of slots) {
      const status = orderList.querySelector(`[data-toolbar-visibility="${key}"]`);
      if (status) status.textContent = button.hidden || button.style.display === "none" || (root.classList.contains("wg-zen") && button.closest(".left")) ? "Hidden" : "";
    }
  }
  function sync() {
    const next = normalizeToolbarPreferences(loadTheme?.());
    const changedMode = next.toolbarMode !== preferences.toolbarMode;
    preferences = next;
    toolbar.dataset.size = next.toolbarSize;
    const scale = String(next.toolbarScale / 100);
    toolbar.style.setProperty("--pp-toolbar-scale", scale);
    dock.style.setProperty("--pp-toolbar-scale", scale);
    designer?.style.setProperty("--pp-toolbar-scale", scale);
    dock.dataset.mode = next.toolbarMode;
    reveal.hidden = next.toolbarMode === "hidden";
    dock.hidden = next.toolbarMode === "always";
    if (settings) (dock.hidden ? anchor : dockAnchor).appendChild(settings);
    // Append only when the actual order changed: no observer feedback loop.
    const current = [...track.children].map(slot => slot.firstElementChild?.dataset.toolbarKey);
    const wanted = next.toolbarOrder.filter(key => slots.has(key));
    if (current.join("|") !== wanted.join("|")) wanted.forEach(key => track.appendChild(slots.get(key).slot));
    if (changedMode) { cancelHide(); setHeld(false); setExpanded(next.toolbarMode === "always" || blocked() || toolbar.contains(document.activeElement) || (next.toolbarMode === "auto" && (dock.matches(":hover") || dock.contains(document.activeElement)))); }
    else setExpanded(expanded);
    designer?.querySelectorAll("[data-toolbar-scale-preset]").forEach(button => button.setAttribute("aria-pressed", String(Number(button.dataset.toolbarScalePreset) === next.toolbarScale)));
    const slider = designer?.querySelector("[data-toolbar-scale]"); if (slider) slider.value = String(next.toolbarScale);
    const output = designer?.querySelector("[data-toolbar-scale-value]"); if (output) output.textContent = `${Math.round(next.toolbarScale)}%`;
    const mode = designer?.querySelector("[data-toolbar-mode]"); if (mode) mode.value = next.toolbarMode;
    renderOrder(); schedule();
  }
  function update() {
    frame = null;
    if (disposed || !root.isConnected) return;
    // Local foreground adjustments retain the saved palette and native node
    // colors. Reuse the existing contrast helper for bright custom accents.
    const palette = getComputedStyle(root);
    const background = palette.getPropertyValue("--wg-panel-bg").trim();
    for (const [property, source] of [["--pp-toolbar-ink", "--wg-text"], ["--pp-toolbar-accent-ink", "--wg-accent"]]) {
      const ink = nudgeHexForContrast(palette.getPropertyValue(source).trim(), background, 7);
      if (root.style.getPropertyValue(property) !== ink) root.style.setProperty(property, ink);
    }
    if (!toolbar.clientWidth) { renderOrder(); return; }
    toolbar.dataset.compact = String(preferences.toolbarSize === "small");
    const buttons = visibleButtons();
    const style = getComputedStyle(track);
    const barGap = parseFloat(getComputedStyle(toolbar).columnGap) || 0;
    const scrollControlSpace = previous.hidden ? 0 : previous.offsetWidth + next.offsetWidth + barGap * 2;
    const available = track.clientWidth + scrollControlSpace - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    let previousGroup = null;
    buttons.forEach(button => {
      const group = button.dataset.toolbarGroup;
      const start = previousGroup !== null && previousGroup !== group;
      if (button.classList.contains("wg-toolbar-section-start") !== start) button.classList.toggle("wg-toolbar-section-start", start);
      previousGroup = group;
    });
    const visible = new Set(buttons);
    slots.forEach(({ button }) => { if (!visible.has(button) && button.classList.contains("wg-toolbar-section-start")) button.classList.remove("wg-toolbar-section-start"); });
    const measure = () => buttons.reduce((width, button) => {
      const css = getComputedStyle(button);
      return width + parseFloat(css.width) + (parseFloat(css.marginLeft) || 0) + (parseFloat(css.marginRight) || 0);
    }, Math.max(0, buttons.length - 1) * (parseFloat(style.columnGap) || 0));
    toolbar.dataset.compact = String(preferences.toolbarSize === "small" || measure() > available + 0.5);
    const overflow = measure() > available + 1;
    toolbar.dataset.overflow = String(overflow);
    for (const button of [previous, next]) if (button.hidden === overflow) {
      const focused = button === document.activeElement;
      button.hidden = !overflow;
      if (!overflow && focused) {
        const enabled = buttons.filter(action => !action.disabled);
        (button === previous ? enabled[0] : enabled.at(-1))?.focus({ preventScroll: true });
      }
    }
    previous.disabled = track.scrollLeft <= 1;
    next.disabled = track.scrollLeft + track.clientWidth >= track.scrollWidth - 1;
    if (track.scrollWidth <= track.clientWidth) track.scrollLeft = 0;
    renderOrder();
  }
  function schedule() {
    if (!disposed && frame === null) frame = requestAnimationFrame(update);
  }
  const resize = new ResizeObserver(schedule);
  resize.observe(track);
  const mutations = new MutationObserver(schedule);
  mutations.observe(toolbar, { subtree: true, childList: true, characterData: true,
    attributes: true, attributeFilter: ["hidden", "style", "class", "aria-expanded"] });
  mutations.observe(root, { attributes: true, attributeFilter: ["style", "class"] });
  // Drawer closure and native dialog closure resume hiding after an interaction.
  const panels = new MutationObserver(queueHide);
  panels.observe(root, { subtree: true, attributes: true, attributeFilter: ["hidden", "aria-expanded"] });
  listen(document, "close", queueHide, true);
  listen(dock, "pointerenter", () => { cancelHide(); if (preferences.toolbarMode === "auto") setExpanded(true); });
  listen(toolbar, "pointerenter", cancelHide);
  for (const surface of [dock, toolbar]) { listen(surface, "pointerleave", queueHide); listen(surface, "focusout", queueHide); listen(surface, "focusin", () => {
    cancelHide(); if (preferences.toolbarMode === "auto") setExpanded(true);
  }); }
  listen(reveal, "click", () => {
    cancelHide(); if (preferences.toolbarMode === "auto" && expanded && !held) setHeld(true);
    else if (expanded) { setHeld(false); setExpanded(false); }
    else setExpanded(true);
  });
  listen(reveal, "keydown", event => {
    if (event.key !== "ArrowDown") return;
    event.preventDefault(); event.stopPropagation(); setExpanded(true); visibleButtons().find(button => !button.disabled)?.focus({ preventScroll: true });
  });
  listen(pin, "click", () => { setHeld(!held); if (!held) queueHide(); });
  for (const [button, direction] of [[previous, -1], [next, 1]]) listen(button, "click", () => {
    track.scrollBy({ left: direction * Math.max(80, track.clientWidth * .75), behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
  });
  listen(track, "scroll", schedule);
  listen(track, "focusin", event => {
    const button = event.target.closest("[data-toolbar-key]");
    if (button) {
      const bounds = track.getBoundingClientRect(), rect = button.getBoundingClientRect();
      const scale = bounds.width / track.clientWidth || 1;
      const left = (rect.left - bounds.left) / scale + track.scrollLeft, right = left + rect.width / scale;
      if (left < track.scrollLeft) track.scrollLeft = left;
      else if (right > track.scrollLeft + track.clientWidth) track.scrollLeft = right - track.clientWidth;
    }
  });
  listen(track, "keydown", event => {
    if (event.target.closest("button")?.parentElement?.closest(".wg-toolbar-track") !== track) return;
    const buttons = visibleButtons().filter(button => !button.disabled);
    const index = buttons.indexOf(event.target.closest("button"));
    const direction = getComputedStyle(track).direction === "rtl" ? -1 : 1;
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : event.key === "ArrowRight" ? (index + direction + buttons.length) % buttons.length : event.key === "ArrowLeft" ? (index - direction + buttons.length) % buttons.length : -1;
    if (next < 0) return;
    event.preventDefault(); event.stopPropagation(); buttons[next]?.focus({ preventScroll: true });
  });
  function handleToolbarEscape(event) {
    if (event.key !== "Escape" || !expanded || preferences.toolbarMode === "always" || blocked()) return;
    event.preventDefault(); event.stopPropagation(); setHeld(false); setExpanded(false); reveal.focus({ preventScroll: true });
  }
  listen(toolbar, "keydown", handleToolbarEscape);
  listen(dock, "keydown", handleToolbarEscape);
  listen(document, "pointerdown", event => { if (!toolbar.contains(event.target) && !dock.contains(event.target)) queueHide(); });
  function move(key, target, after = false) {
    const order = [...preferences.toolbarOrder];
    const from = order.indexOf(key); if (from < 0 || key === target) return;
    order.splice(from, 1); const destination = order.indexOf(target); if (destination < 0) return;
    order.splice(destination + Number(after), 0, key); write({ toolbarOrder: order });
    if (message) message.textContent = `${slots.get(key).label} moved.`;
  }
  function step(key, direction) {
    const keys = preferences.toolbarOrder.filter(id => slots.has(id));
    const target = keys[keys.indexOf(key) + (direction === "earlier" ? -1 : 1)];
    if (target) move(key, target, direction === "later");
  }
  listen(designer, "input", event => { if (event.target.matches("[data-toolbar-scale]")) write({ toolbarScale: Number(event.target.value) }); });
  listen(designer, "change", event => { if (event.target.matches("[data-toolbar-mode]")) write({ toolbarMode: event.target.value }); });
  listen(designer, "click", event => {
    const size = event.target.closest("[data-toolbar-scale-preset]"); if (size) write({ toolbarScale: Number(size.dataset.toolbarScalePreset) });
    const direction = event.target.closest("[data-toolbar-move]"); if (direction) step(direction.closest("[data-toolbar-row]").dataset.toolbarRow, direction.dataset.toolbarMove);
    if (event.target.closest("[data-toolbar-reset]")) { write({ toolbarOrder: [...DEFAULT_TOOLBAR_ORDER] }); if (message) message.textContent = "Default order restored."; }
  });
  listen(orderList, "keydown", event => { const grip = event.target.closest("[data-toolbar-grip]"); if (grip && event.altKey && ["ArrowUp", "ArrowDown"].includes(event.key)) { event.preventDefault(); event.stopPropagation(); step(grip.dataset.toolbarGrip, event.key === "ArrowUp" ? "earlier" : "later"); } });
  listen(orderList, "dragstart", event => {
    const grip = event.target.closest("[data-toolbar-grip]"); if (!grip) { event.preventDefault(); return; }
    dragged = grip.dataset.toolbarGrip; event.stopPropagation();
    event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("application/x-prompt-palette-toolbar", dragged);
    grip.closest("li").classList.add("dragging");
  });
  function clearDropMarks() { orderList?.querySelectorAll("[data-toolbar-drop]").forEach(row => row.removeAttribute("data-toolbar-drop")); }
  listen(orderList, "dragover", event => {
    const row = event.target.closest("[data-toolbar-row]"); if (!dragged || !row) return;
    event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "move";
    const bounds = row.getBoundingClientRect(); clearDropMarks();
    row.dataset.toolbarDrop = event.clientY > bounds.top + bounds.height / 2 ? "after" : "before";
  });
  listen(orderList, "drop", event => {
    const row = event.target.closest("[data-toolbar-row]"); if (!dragged || !row) return;
    event.preventDefault(); event.stopPropagation();
    const bounds = row.getBoundingClientRect(); clearDropMarks(); move(dragged, row.dataset.toolbarRow, event.clientY > bounds.top + bounds.height / 2); dragged = null;
  });
  listen(orderList, "dragend", event => { event.stopPropagation(); dragged = null; clearDropMarks(); orderList.querySelectorAll(".dragging").forEach(row => row.classList.remove("dragging")); });
  const unsubscribe = onPromptPaletteAppearanceChanged(sync);
  document.fonts?.addEventListener("loadingdone", schedule);
  sync();
  return () => {
    disposed = true;
    cancelHide(); unsubscribe(); cleanups.forEach(cleanup => cleanup()); panels.disconnect();
    if (frame !== null) cancelAnimationFrame(frame);
    resize.disconnect();
    mutations.disconnect();
    document.fonts?.removeEventListener("loadingdone", schedule);
  };
}
let toolbarSequence = 0;
