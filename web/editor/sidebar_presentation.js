import { applyPromptPaletteThemeScope, copyPromptPaletteThemeScope, installPromptPaletteKeyboardBoundary } from "../prompt_palette_shared.js";

const LAYOUT_ITEM_SELECTOR = "[data-path], [data-style-tag], [data-lora-name], [data-generation-id]";
const PORTAL_THEME_CLASSES = ["wg-high-contrast", "wg-reduce-motion", "wg-no-animations", "wg-disable-animations", "wg-large-text"];

function datasetKey(attr) {
  return String(attr).replace(/^data-/, "").replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
}

function setScopedAttr(element, attr, value) {
  if (!element || !attr) return;
  if (attr.startsWith("data-") && element.dataset) element.dataset[datasetKey(attr)] = String(value);
  else element.setAttribute?.(attr, String(value));
}

function clearScopedAttr(element, attr) {
  if (!element || !attr) return;
  if (attr.startsWith("data-") && element.dataset) delete element.dataset[datasetKey(attr)];
  else element.removeAttribute?.(attr);
}

function layoutItemKey(item) {
  return item?.dataset?.path || item?.dataset?.styleTag || item?.dataset?.loraName || item?.dataset?.generationId || "";
}

/**
 * One owned constructable stylesheet per Prompt Palette container; no element style attributes.
 * Dynamic geometry belongs in CSSOM declarations, never patched onto ComfyUI/LiteGraph ancestors.
 * Rules are released with their views.
 */
export class PresentationScope {
  static sequence = 0;

  constructor(root, {
    scopeAttr = "data-pp-scope",
    instanceAttr = "",
    layoutAttr = "data-pp-layout",
    portalAttr = "data-pp-portal-layout",
    portalScopeAttr = "data-pp-portal",
    entryToneAttr = "data-pp-entry-tone",
  } = {}) {
    this.root = root;
    this.scopeAttr = instanceAttr || scopeAttr || "data-pp-scope";
    this.layoutAttr = layoutAttr || "data-pp-layout";
    this.portalAttr = portalAttr || "data-pp-portal-layout";
    this.portalScopeAttr = portalScopeAttr || "data-pp-portal";
    this.entryToneAttr = entryToneAttr || "data-pp-entry-tone";
    this.rules = new Map();
    this.categories = new Map();
    this.animations = new Map();
    this.portals = new Set();
    this.sequence = 0;
    this.disposed = false;
    this.instanceId = String(++PresentationScope.sequence);
    setScopedAttr(root, this.scopeAttr, this.instanceId);
    this.scope = `[${this.scopeAttr}="${this.instanceId}"]`;
    this.sheet = new CSSStyleSheet();
    const doc = root?.ownerDocument || globalThis.document;
    this.adoptedDocument = doc;
    if (doc && "adoptedStyleSheets" in doc) {
      doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, this.sheet];
    }
    this.declaration = (element, options = {}) => this.getDeclaration(element, options);
  }

  insertRule(selector) {
    const index = this.sheet.insertRule(`${selector} {}`, this.sheet.cssRules.length);
    return this.sheet.cssRules[index];
  }

  getDeclaration(element, { portal = false } = {}) {
    if (!element) return null;
    const isRoot = element === this.root;
    // Detached nodes (!element.isConnected) are styled before DOM insertion (e.g. Masonry cards);
    // keep them scoped with (0,2,0) unless explicitly marked as a portal or connected outside root.
    const isPortal = !isRoot && (
      portal === true
      || this.portals.has(element)
      || (Boolean(element.isConnected) && !this.root?.contains?.(element))
    );
    const existing = this.rules.get(element);
    if (existing) {
      if (!isPortal || existing.selectorText?.includes(this.portalAttr) || isRoot) {
        return existing.style;
      }
      const prevCss = existing.style.cssText;
      const wasPortal = this.portals.has(element);
      this.release(element);
      if (wasPortal) this.portals.add(element);
      const upgraded = this.getDeclaration(element, { portal: true });
      if (prevCss) upgraded.cssText = prevCss;
      return upgraded;
    }
    let selector;
    if (isRoot) {
      selector = this.scope;
    } else if (isPortal) {
      const id = `${this.instanceId}-${++this.sequence}`;
      setScopedAttr(element, this.portalAttr, id);
      selector = `[${this.portalAttr}="${id}"]`;
    } else {
      const id = String(++this.sequence);
      setScopedAttr(element, this.layoutAttr, id);
      selector = `${this.scope} [${this.layoutAttr}="${id}"]`;
    }
    const rule = this.insertRule(selector);
    this.rules.set(element, rule);
    return rule.style;
  }

  release(element) {
    if (!element) return;
    this.portals.delete(element);
    const rule = this.rules.get(element);
    if (!rule) return;
    const idx = Array.from(this.sheet.cssRules).indexOf(rule);
    if (idx >= 0) this.sheet.deleteRule(idx);
    this.rules.delete(element);
    clearScopedAttr(element, this.layoutAttr);
    clearScopedAttr(element, this.portalAttr);
  }

  set(element, properties) {
    const declaration = this.declaration(element);
    if (!declaration) return;
    for (const [key, value] of Object.entries(properties)) declaration.setProperty(key, String(value));
  }

  category(element, category, color) {
    let entry = this.categories.get(category);
    if (!entry) {
      const id = String(this.categories.size + 1);
      entry = {
        id,
        rule: this.insertRule(
          `${this.scope} [${this.entryToneAttr}="${id}"], [${this.portalScopeAttr}="${this.instanceId}"] [${this.entryToneAttr}="${id}"]`
        ),
      };
      this.categories.set(category, entry);
    }
    entry.rule.style.setProperty("--pp-entry-color", color);
    setScopedAttr(element, this.entryToneAttr, entry.id);
  }

  syncPortalTheme(portal) {
    if (!portal || this.disposed) return;
    setScopedAttr(portal, this.portalScopeAttr, this.instanceId);
    this.portals.add(portal);
    copyPromptPaletteThemeScope(this.root, portal, this.declaration(portal, { portal: true }));
    for (const cls of PORTAL_THEME_CLASSES) {
      portal.classList?.toggle(cls, this.root?.classList?.contains(cls) === true);
    }
  }

  applyTheme(appearance) {
    if (!appearance || this.disposed) return;
    applyPromptPaletteThemeScope(this.root, appearance.colors, appearance.typography, appearance.effects, this.declaration(this.root));
    this.root?.classList?.toggle("wg-reduce-motion", !!appearance.theme?.reduceMotion);
    for (const portal of this.portals) {
      if (portal.isConnected) this.syncPortalTheme(portal);
    }
  }

  captureLayout(container) {
    if (!container || this.root?.classList?.contains("wg-reduce-motion") || globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) return null;
    const viewport = container.getBoundingClientRect(), positions = new Map();
    for (const item of container.querySelectorAll(LAYOUT_ITEM_SELECTOR)) {
      const key = layoutItemKey(item);
      if (!key) continue;
      const rect = item.getBoundingClientRect();
      if (rect.bottom < viewport.top || rect.top > viewport.bottom) continue;
      positions.set(key, rect);
      if (positions.size >= 64) break;
    }
    return positions;
  }

  animateLayout(container, positions) {
    if (!container || !positions?.size) return;
    for (const animation of this.animations.values()) animation.cancel();
    this.animations.clear();
    const computed = getComputedStyle(this.root);
    const duration = parseFloat(computed.getPropertyValue("--pps-motion")) || 140;
    const easing = computed.getPropertyValue("--pps-ease").trim() || "ease-out";
    for (const item of container.querySelectorAll(LAYOUT_ITEM_SELECTOR)) {
      const key = layoutItemKey(item);
      const before = key ? positions.get(key) : null;
      if (!before) continue;
      const after = item.getBoundingClientRect();
      if (!after.width || !after.height) continue;
      const x = before.left - after.left, y = before.top - after.top;
      const scaleX = before.width / after.width, scaleY = before.height / after.height;
      if (Math.abs(x) + Math.abs(y) < 1 && Math.abs(scaleX - 1) + Math.abs(scaleY - 1) < .01) continue;
      if (typeof item.animate !== "function") continue;
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

  cleanup() {
    if (this.disposed) return;
    this.disposed = true;
    for (const animation of this.animations.values()) animation.cancel();
    this.animations.clear();
    const doc = this.adoptedDocument || this.root?.ownerDocument || globalThis.document;
    if (doc && "adoptedStyleSheets" in doc) {
      doc.adoptedStyleSheets = doc.adoptedStyleSheets.filter(sheet => sheet !== this.sheet);
    }
    for (const element of this.rules.keys()) {
      if (element !== this.root) {
        clearScopedAttr(element, this.layoutAttr);
        clearScopedAttr(element, this.portalAttr);
      }
    }
    this.rules.clear();
    this.categories.clear();
    this.portals.clear();
    clearScopedAttr(this.root, this.scopeAttr);
  }
}

/** Sidebar presentation controller adding pointer/keyboard isolation and available-height tracking. */
export class SidebarPresentation extends PresentationScope {
  constructor(root, container) {
    super(root, {
      instanceAttr: "data-pp-sidebar-instance",
      layoutAttr: "data-pp-layout",
      portalAttr: "data-pp-portal-layout",
      portalScopeAttr: "data-pp-sidebar-portal",
      entryToneAttr: "data-pp-entry-tone",
    });
    this.container = container;
    this.frame = 0;
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
    owner.defaultView?.addEventListener("blur", () => { pointers.clear(); mouseOwned = touchOwned = false; }, { signal: this.events.signal });
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
    this.resize = typeof ResizeObserver === "function" ? new ResizeObserver(() => this.scheduleHeight()) : null;
    if (this.resize && container) {
      this.resize.observe(container);
      this.resize.observe(owner.documentElement);
    }
    this.scheduleHeight();
  }

  scheduleHeight() {
    if (this.frame || this.disposed || !this.container) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (this.disposed || !this.container.clientWidth) return;
      const top = Math.max(0, this.container.getBoundingClientRect().top);
      this.set(this.root, { "--pp-sidebar-available-height": `${Math.max(0, document.documentElement.clientHeight - top)}px` });
    });
  }

  cleanup() {
    if (this.disposed) return;
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.events.abort();
    this.keyboardCleanup();
    this.resize?.disconnect();
    super.cleanup();
  }
}

export function captureSidebarFocus(container, selector, identity) {
  const element = document.activeElement, item = element?.closest?.(selector);
  return container?.contains?.(element) && item
    ? { element, key: item.dataset?.[identity], label: element.getAttribute?.("aria-label"), wasItem: element === item }
    : null;
}

export function restoreSidebarFocus(container, selector, identity, snapshot) {
  if (!snapshot || snapshot.element?.isConnected) return;
  const item = [...container.querySelectorAll(selector)].find(element => element.dataset?.[identity] === snapshot.key);
  const control = !snapshot.wasItem && snapshot.label != null
    ? [...item?.querySelectorAll("button") || []].find(element => element.getAttribute("aria-label") === snapshot.label)
    : null;
  const focusableItem = item && typeof item.focus === "function"
    && (item.tabIndex >= 0 || item.hasAttribute?.("tabindex") || snapshot.wasItem)
    ? item
    : null;
  (control || focusableItem || container)?.focus?.({ preventScroll: true });
}
