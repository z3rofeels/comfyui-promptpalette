import { loadSidebarDisplay, saveSidebarDisplay } from "./preferences.js";

const make = (tag, className = "", text = "") => {
  const element = document.createElement(tag);
  element.className = className; element.textContent = text;
  return element;
};

/** Owns display inputs and their placement; callers only supply collection identity. */
export class SidebarDisplayControls {
  constructor({ presentation, tabs, settingsHost, settingsAnchor, getKey, onChange, onDismiss }) {
    this.presentation = presentation; this.tabs = tabs; this.getKey = getKey;
    this.events = new AbortController();
    this.element = make("div", "pp-sidebar-display");
    this.settings = make("section", "pp-sidebar-display-settings");
    this.settings.append(make("strong", "", "Collection layout"));
    if (settingsAnchor) settingsAnchor.after(this.settings); else settingsHost.append(this.settings);
    this.layout = make("select"); this.layout.setAttribute("aria-label", "Sidebar layout");
    this.layout.append(new Option("Gallery", "gallery"), new Option("List", "list"), new Option("Masonry", "masonry"), new Option("Filmstrip / detail", "filmstrip"));
    const label = make("label", "pp-sidebar-size");
    this.size = make("input"); this.size.type = "range";
    this.size.min = "10"; this.size.max = "200"; this.size.step = "1";
    this.size.setAttribute("aria-label", "Sidebar item size");
    this.size.title = "Resize cards · Double-click to reset";
    this.output = make("output");
    label.append(make("span", "pp-sidebar-size-caption", "Item size"), this.size, this.output);
    this.element.append(this.layout, label);
    this.ratios = make("div", "pp-sidebar-ratios");
    this.ratios.setAttribute("role", "group"); this.ratios.setAttribute("aria-label", "Preview aspect ratio");
    this.ratioButtons = new Map();
    const listen = (element, type, callback) => element.addEventListener(type, callback, { signal: this.events.signal });
    const commit = changes => { saveSidebarDisplay(changes); onDismiss(); this.sync(this.visible); onChange(); };
    for (const [key, text] of [["square", "1:1"], ["portrait", "3:4"], ["tall", "2:3"], ["landscape", "4:3"], ["wide", "16:9"]]) {
      const pill = make("button", "pp-sidebar-ratio"); pill.type = "button";
      pill.dataset.ratio = key; pill.setAttribute("aria-label", `Preview aspect ratio ${text}`);
      pill.append(make("i", "pp-sidebar-ratio-shape"), make("span", "", text));
      listen(pill, "click", () => commit({ aspect: key }));
      this.ratios.append(pill); this.ratioButtons.set(key, pill);
    }
    listen(this.layout, "change", () => {
      commit({ layouts: { [getKey()]: this.layout.value } });
    });
    listen(this.size, "input", () => commit({ scale: Number(this.size.value) / 100 }));
    listen(this.size, "dblclick", () => commit({ scale: .9 }));
    listen(this.size, "pointerdown", onDismiss);
    tabs.after(this.element);
    this.resizeFrame = 0;
    this.resize = new ResizeObserver(() => {
      if (this.resizeFrame) return;
      this.resizeFrame = requestAnimationFrame(() => { this.resizeFrame = 0; this.sync(this.visible); });
    });
    this.resize.observe(tabs);
  }

  sync(visible = true) {
    this.visible = visible;
    const state = loadSidebarDisplay();
    this.layout.value = state.layouts[this.getKey()] || "gallery";
    this.size.value = String(Math.round(state.scale * 100));
    this.output.textContent = `${this.size.value}%`;
    this.size.setAttribute("aria-valuetext", `${this.size.value}% · 10% tiny, 200% full width`);
    this.presentation.set(this.size, { "--pp-size-progress": `${(Number(this.size.value) - 10) / 190 * 100}%` });
    const ui = parseFloat(getComputedStyle(this.tabs).getPropertyValue("--wg-ui-font-scale")) || 1;
    const width = this.tabs.clientWidth;
    // Relocate the existing inputs without changing saved toolbar preferences.
    const displayInToolbar = state.chrome.displayControls && width >= 220 * ui;
    const ratiosInToolbar = displayInToolbar && state.chrome.ratioControls && width >= 280 * ui;
    if (displayInToolbar) {
      if (this.element.previousElementSibling !== this.tabs) this.tabs.after(this.element);
    } else if (this.element.parentElement !== this.settings) this.settings.append(this.element);
    const ratioHost = ratiosInToolbar ? this.element : this.settings;
    if (this.ratios.parentElement !== ratioHost) ratioHost.append(this.ratios);
    const showRatios = this.layout.value === "gallery";
    this.ratios.hidden = !visible || !showRatios || !state.chrome.images;
    this.element.hidden = !visible;
    this.settings.hidden = !visible || (displayInToolbar && (ratiosInToolbar || this.ratios.hidden));
    for (const [key, pill] of this.ratioButtons) pill.setAttribute("aria-pressed", String(key === state.aspect));
  }

  cleanup() {
    this.resize.disconnect(); cancelAnimationFrame(this.resizeFrame);
    this.events.abort(); this.presentation.release(this.size);
    this.ratios.remove(); this.element.remove(); this.settings.remove();
  }
}
