import { applyPromptPaletteThemeScope, installPromptPaletteKeyboardBoundary } from "../prompt_palette_shared.js";
/** One owned stylesheet per mounted sidebar; no element style attributes.
 * Dynamic geometry belongs in CSSOM declarations, never in DOM measurements
 * patched onto ComfyUI/LiteGraph ancestors. Rules are released with their views.
 */
export class SidebarPresentation {
  static sequence = 0;

  constructor(root, container) {
    this.root = root;
    this.container = container;
    this.rules = new Map();
    this.categories = new Map();
    this.animations = new Map();
    this.sequence = 0;
    this.frame = 0;
    this.disposed = false;
    root.dataset.ppSidebarInstance = String(++SidebarPresentation.sequence);
    this.scope = `[data-pp-sidebar-instance="${root.dataset.ppSidebarInstance}"]`;
    this.sheet = new CSSStyleSheet();
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, this.sheet];
    this.declaration = element => {
      if (this.rules.has(element)) return this.rules.get(element).style;
      const selector = element === root ? this.scope : `${this.scope} [data-pp-layout="${++this.sequence}"]`;
      if (element !== root) element.dataset.ppLayout = String(this.sequence);
      const rule = this.insertRule(selector);
      this.rules.set(element, rule);
      return rule.style;
    };
    this.events = new AbortController();
    // Host-owned resize/selection gestures must reach their document listeners.
    // Only contain a move/release when its press began in this sidebar. Capture
    // bookkeeping observes controls that stop bubbling; it never cancels input.
    const pointers = new Set();
    let mouseOwned = false, touchOwned = false;
    const owner = root.ownerDocument;
    const capture = { capture: true, passive: true, signal: this.events.signal };
    owner.addEventListener("pointerdown", event => {
      if (root.contains(event.target)) pointers.add(event.pointerId);
      else pointers.delete(event.pointerId);
    }, capture);
    for (const type of ["pointerup", "pointercancel"]) owner.addEventListener(type, event => {
      queueMicrotask(() => pointers.delete(event.pointerId));
    }, capture);
    owner.addEventListener("mousedown", event => { mouseOwned = root.contains(event.target); }, capture);
    owner.addEventListener("mouseup", () => { queueMicrotask(() => { mouseOwned = false; }); }, capture);
    owner.addEventListener("touchstart", event => { touchOwned = root.contains(event.target); }, capture);
    for (const type of ["touchend", "touchcancel"]) owner.addEventListener(type, () => {
      queueMicrotask(() => { touchOwned = false; });
    }, capture);
    owner.defaultView.addEventListener("blur", () => { pointers.clear(); mouseOwned = touchOwned = false; }, { signal: this.events.signal });
    const stop = event => {
      if (["pointermove", "pointerup", "pointercancel"].includes(event.type) && !pointers.has(event.pointerId)) return;
      if (["mousemove", "mouseup"].includes(event.type) && !mouseOwned) return;
      if (["touchmove", "touchend", "touchcancel"].includes(event.type) && !touchOwned) return;
      event.stopPropagation();
    };
    for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel", "mousedown", "mousemove", "mouseup", "click", "dblclick", "auxclick", "contextmenu", "wheel", "touchstart", "touchmove", "touchend", "touchcancel", "dragstart", "dragover", "drop", "input", "change"]) {
      root.addEventListener(type, stop, { passive: true, signal: this.events.signal });
    }
    this.keyboardCleanup = installPromptPaletteKeyboardBoundary(root);
    this.resize = new ResizeObserver(() => this.scheduleHeight());
    this.resize.observe(container);
    this.resize.observe(document.documentElement);
    this.scheduleHeight();
  }

  insertRule(selector) {
    const index = this.sheet.insertRule(`${selector} {}`, this.sheet.cssRules.length);
    return this.sheet.cssRules[index];
  }

  release(element) {
    const rule = this.rules.get(element);
    if (!rule) return;
    this.sheet.deleteRule(Array.from(this.sheet.cssRules).indexOf(rule));
    this.rules.delete(element);
    delete element.dataset.ppLayout;
  }

  set(element, properties) {
    const declaration = this.declaration(element);
    for (const [key, value] of Object.entries(properties)) declaration.setProperty(key, String(value));
  }

  category(element, category, color) {
    let entry = this.categories.get(category);
    if (!entry) {
      const id = String(this.categories.size + 1);
      entry = { id, rule: this.insertRule(`${this.scope} [data-pp-entry-tone="${id}"]`) };
      this.categories.set(category, entry);
    }
    entry.rule.style.setProperty("--pp-entry-color", color);
    element.dataset.ppEntryTone = entry.id;
  }

  applyTheme(appearance) {
    applyPromptPaletteThemeScope(this.root, appearance.colors, appearance.typography, appearance.effects, this.declaration(this.root));
    this.root.classList.toggle("wg-reduce-motion", !!appearance.theme.reduceMotion);
  }

  captureLayout(container) {
    if (this.root.classList.contains("wg-reduce-motion") || matchMedia("(prefers-reduced-motion: reduce)").matches) return null;
    const viewport = container.getBoundingClientRect(), positions = new Map();
    for (const item of container.querySelectorAll("[data-path], [data-style-tag]")) {
      const rect = item.getBoundingClientRect();
      if (rect.bottom < viewport.top || rect.top > viewport.bottom) continue;
      positions.set(item.dataset.path || item.dataset.styleTag, rect);
      if (positions.size >= 64) break;
    }
    return positions;
  }

  animateLayout(container, positions) {
    if (!positions?.size) return;
    for (const animation of this.animations.values()) animation.cancel();
    this.animations.clear();
    const computed = getComputedStyle(this.root);
    const duration = parseFloat(computed.getPropertyValue("--pps-motion")) || 140;
    const easing = computed.getPropertyValue("--pps-ease").trim() || "ease-out";
    for (const item of container.querySelectorAll("[data-path], [data-style-tag]")) {
      const before = positions.get(item.dataset.path || item.dataset.styleTag);
      if (!before) continue;
      const after = item.getBoundingClientRect();
      if (!after.width || !after.height) continue;
      const x = before.left - after.left, y = before.top - after.top;
      const scaleX = before.width / after.width, scaleY = before.height / after.height;
      if (Math.abs(x) + Math.abs(y) < 1 && Math.abs(scaleX - 1) + Math.abs(scaleY - 1) < .01) continue;
      // Layout is committed once; the browser only interpolates composited
      // transforms/opacity. No width/height transitions or timer-driven layout.
      const animation = item.animate([
        { transform: `translate3d(${x}px, ${y}px, 0) scale(${scaleX}, ${scaleY})`, opacity: .8 },
        { transform: "none", opacity: 1 },
      ], { duration, easing });
      this.animations.set(item, animation);
      animation.addEventListener("finish", () => { if (this.animations.get(item) === animation) this.animations.delete(item); }, { once: true });
    }
  }

  scheduleHeight() {
    if (this.frame || this.disposed) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (this.disposed || !this.container.clientWidth) return;
      const top = Math.max(0, this.container.getBoundingClientRect().top);
      this.set(this.root, { "--pp-sidebar-available-height": `${Math.max(0, document.documentElement.clientHeight - top)}px` });
    });
  }

  cleanup() {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.events.abort();
    this.keyboardCleanup();
    this.resize.disconnect();
    for (const animation of this.animations.values()) animation.cancel();
    this.animations.clear();
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter(sheet => sheet !== this.sheet);
    this.rules.clear();
    this.categories.clear();
    delete this.root.dataset.ppSidebarInstance;
  }
}

export function captureSidebarFocus(container, selector, identity) {
  const element = document.activeElement, item = element?.closest(selector);
  return container.contains(element) && item
    ? { element, key: item.dataset[identity], label: element.getAttribute("aria-label") }
    : null;
}

export function restoreSidebarFocus(container, selector, identity, snapshot) {
  if (!snapshot || snapshot.element.isConnected) return;
  const item = [...container.querySelectorAll(selector)].find(element => element.dataset[identity] === snapshot.key);
  const control = [...item?.querySelectorAll("button") || []].find(element => element.getAttribute("aria-label") === snapshot.label);
  (control || container).focus({ preventScroll: true });
}
