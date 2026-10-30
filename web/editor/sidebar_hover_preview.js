import { normalizePromptPaletteMenuScale } from "../prompt_palette_shared.js";
import { loadSidebarDisplay } from "./preferences.js";

/** One lazy image tooltip per sidebar; virtual cards only retain weak metadata. */
export class SidebarHoverPreview {
  static sequence = 0;

  constructor(root, presentation) {
    this.root = root; this.presentation = presentation;
    this.entries = new WeakMap(); this.events = new AbortController();
    this.serial = 0; this.timer = 0; this.disposed = false;
    this.panel = document.createElement("aside");
    this.panel.className = "pp-sidebar-image-hover";
    this.panel.id = `pp-sidebar-image-hover-${++SidebarHoverPreview.sequence}`;
    this.panel.setAttribute("popover", "manual"); this.panel.setAttribute("role", "tooltip");
    this.image = document.createElement("img"); this.image.alt = ""; this.image.decoding = "async";
    this.title = document.createElement("strong"); this.subtitle = document.createElement("small");
    this.panel.append(this.image, this.title, this.subtitle); root.append(this.panel);
    const listen = (target, type, fn, options = {}) => target.addEventListener(type, fn, { ...options, signal: this.events.signal });
    const card = target => target instanceof Element ? target.closest(".pp-sidebar-row, .pp-style-card") : null;
    listen(root, "pointerover", event => {
      if (event.pointerType === "touch" || event.buttons) return;
      const anchor = card(event.target);
      if (anchor && !anchor.contains(event.relatedTarget)) this.schedule(anchor);
    });
    listen(root, "pointerout", event => {
      const anchor = card(event.target);
      if (anchor && !anchor.contains(event.relatedTarget)) this.dismiss();
    });
    listen(root, "focusin", event => { const anchor = card(event.target); if (anchor) this.schedule(anchor, event.target); });
    listen(root, "focusout", event => { if (!card(event.target)?.contains(event.relatedTarget)) this.dismiss(); });
    for (const type of ["scroll", "pointerdown", "input", "contextmenu"]) listen(root, type, () => this.dismiss(), { capture: true, passive: true });
    listen(root, "pointerleave", () => this.dismiss());
    listen(root, "keydown", event => { if (event.key === "Escape") this.dismiss(); });
    listen(root.ownerDocument.defaultView, "blur", () => this.dismiss());
    this.resize = new ResizeObserver(() => this.dismiss()); this.resize.observe(root);
  }

  bind(element, metadata) { this.entries.set(element, metadata); }

  schedule(anchor, control = anchor.querySelector("button") || anchor) {
    if (anchor === this.anchor) return;
    this.dismiss();
    const entry = this.entries.get(anchor);
    if (!entry?.image || !loadSidebarDisplay().chrome.hoverImages) return;
    this.anchor = anchor;
    const serial = this.serial;
    this.timer = setTimeout(() => {
      if (this.disposed || serial !== this.serial || !anchor.isConnected || !loadSidebarDisplay().chrome.hoverImages) return;
      this.show(anchor, control, entry, serial);
    }, 320);
  }

  show(anchor, control, entry, serial) {
    this.title.textContent = entry.title; this.subtitle.textContent = entry.subtitle || "";
    this.panel.classList.remove("is-loaded");
    this.image.onload = () => { if (serial === this.serial) this.panel.classList.add("is-loaded"); };
    this.image.onerror = () => { if (serial === this.serial) this.dismiss(); };
    this.image.src = entry.image;
    // Suppress native titles while the richer preview is visible, then restore.
    this.nativeTitles = [...anchor.querySelectorAll("[title]")].map(element => [element, element.getAttribute("title")]);
    for (const [element] of this.nativeTitles) element.removeAttribute("title");
    this.control = control; this.description = control.getAttribute("aria-describedby");
    control.setAttribute("aria-describedby", [this.description, this.panel.id].filter(Boolean).join(" "));
    const rect = anchor.getBoundingClientRect(), root = this.root.getBoundingClientRect();
    const viewport = this.root.ownerDocument.documentElement, gap = 8;
    const scale = normalizePromptPaletteMenuScale(getComputedStyle(this.root).getPropertyValue("--wg-menu-scale").trim());
    const width = Math.min(288 * scale, viewport.clientWidth - gap * 2);
    const height = Math.min(360 * scale, viewport.clientHeight - gap * 2);
    const right = root.right + gap, left = root.left - width - gap;
    const x = right + width <= viewport.clientWidth - gap ? right : left >= gap ? left
      : Math.max(gap, Math.min(rect.right + gap, viewport.clientWidth - width - gap));
    const y = Math.max(gap, Math.min(rect.top, viewport.clientHeight - height - gap));
    const fontSize = parseFloat(getComputedStyle(this.panel).fontSize) || 12;
    const captionHeight = Math.ceil((48 * scale + fontSize * 4.2) / 4) * 4;
    this.presentation.set(this.panel, { left: `${x}px`, top: `${y}px`, width: `${width}px`,
      "max-height": `${height}px`, "--pp-hover-image-height": `${Math.max(24, height - captionHeight)}px` });
    this.panel.showPopover();
  }

  dismiss() {
    this.serial++; clearTimeout(this.timer); this.timer = 0; this.anchor = null;
    this.image.onload = this.image.onerror = null;
    if (this.panel.matches(":popover-open")) this.panel.hidePopover();
    if (this.control) {
      if (this.description == null) this.control.removeAttribute("aria-describedby");
      else this.control.setAttribute("aria-describedby", this.description);
    }
    for (const [element, title] of this.nativeTitles || []) element.setAttribute("title", title);
    this.nativeTitles = []; this.control = null;
  }

  cleanup() {
    if (this.disposed) return;
    this.disposed = true; this.dismiss(); this.events.abort(); this.resize.disconnect();
    this.image.removeAttribute("src"); this.presentation.release(this.panel); this.panel.remove();
  }
}
