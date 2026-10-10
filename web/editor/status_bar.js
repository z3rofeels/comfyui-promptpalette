import { svgIcon } from "../prompt_palette_shared.js";

export function wildcardStatusText(knownCount, missingCount) {
  return [knownCount ? `${knownCount} wildcard${knownCount === 1 ? "" : "s"}` : "", missingCount ? `${missingCount} missing` : ""].filter(Boolean).join(" · ");
}

export function statusBarMarkup({ doctor = false } = {}) {
  return `<div class="wg-footer wg-statusbar" role="group" aria-label="Prompt status">
    <div class="wg-status-left"><div class="wg-legend" data-el="legend" role="list" aria-label="Wildcard category colors"></div></div>
    ${doctor ? `<button type="button" class="wg-doctor-chip" data-el="doctorChip" data-act="doctor" aria-label="Open Prompt Doctor" aria-expanded="false" title="Prompt Doctor" hidden><span class="wg-doctor-icon" aria-hidden="true">${svgIcon("doctor", 13)}</span><span data-el="doctorDot" aria-hidden="true"></span><span data-el="doctorLabel">Doctor</span></button>` : `<span class="wg-status-center" aria-hidden="true"></span>`}
    <div class="wg-status-metrics">
      <span class="wg-hint" data-el="charCount"></span>
      ${doctor ? `<span class="wg-hint" data-el="tokenCount" data-el-token title="CLIP-L token count of the resolved prompt (visible while Preview result is open)"></span>` : ""}
      <${doctor ? "button type=\"button\"" : "span"} class="wg-hint" data-el="hintRight"${doctor ? " disabled" : ""}></${doctor ? "button" : "span"}>
    </div>
  </div>`;
}

// Status presentation owns neither prompt state nor node geometry. Measure an
// invisible copy, so testing label widths never changes the live row's height,
// focus, selection, or observer target. The row (not the collapsed legend) is
// the resize target, which makes growth restore the labels too.
export function createStatusBar(root) {
  const row = root.querySelector(".wg-statusbar");
  const legend = row.querySelector('[data-el="legend"]');
  const hint = row.querySelector('[data-el="hintRight"]');
  let frame = 0, disposed = false, items = [], signature = "";
  const raf = globalThis.requestAnimationFrame || (fn => setTimeout(fn, 0));
  const cancel = globalThis.cancelAnimationFrame || clearTimeout;

  function fit() {
    frame = 0;
    if (disposed || !row.isConnected || row.clientWidth <= 0) return;
    const missing = hint.textContent.match(/([\d,]+) missing/);
    const short = missing && Number(missing[1].replace(/,/g, "")) ? `${missing[1]} missing` : hint.textContent;
    if (hint.dataset.shortLabel !== short) hint.dataset.shortLabel = short;
    if (hint.getAttribute("aria-label") !== hint.textContent) hint.setAttribute("aria-label", hint.textContent);

    const probe = row.cloneNode(true);
    probe.classList.add("wg-status-measure");
    probe.setAttribute("aria-hidden", "true");
    probe.inert = true;
    probe.dataset.legendMode = "full";
    probe.dataset.metricsMode = "full";
    root.appendChild(probe);
    try {
      const css = getComputedStyle(row);
      const available = row.clientWidth - (parseFloat(css.paddingLeft) || 0) - (parseFloat(css.paddingRight) || 0);
      const gap = parseFloat(css.columnGap) || 6;
      const doctor = probe.querySelector('[data-el="doctorChip"]');
      const doctorWidth = doctor && !doctor.hidden ? doctor.offsetWidth : 0;
      const metrics = probe.querySelector(".wg-status-metrics");
      const legendProbe = probe.querySelector(".wg-legend");
      const rightSpace = doctorWidth ? Math.max(0, (available - doctorWidth) / 2 - gap) : available;
      let metricsMode = "full";
      if (metrics.offsetWidth > rightSpace) {
        probe.dataset.metricsMode = metricsMode = "trim";
        if (metrics.offsetWidth > rightSpace) probe.dataset.metricsMode = metricsMode = "compact";
      }
      const leftSpace = doctorWidth ? rightSpace : Math.max(0, available - metrics.offsetWidth - gap * 2);
      let legendMode = "full";
      if (legendProbe.offsetWidth > leftSpace) {
        probe.dataset.legendMode = legendMode = "medium";
        if (legendProbe.offsetWidth > leftSpace) legendMode = "minimal";
      }
      row.dataset.hasDoctor = String(!!doctorWidth);
      row.dataset.metricsMode = metricsMode;
      row.dataset.legendMode = legendMode;
      const counts = Array.from(row.querySelectorAll(".wg-status-metrics .wg-hint")).map(el => el.textContent).filter(Boolean).join(" · ");
      const summary = items.map(([name]) => name).join(", ");
      const title = [summary ? `Wildcard colors: ${summary}` : "", counts].filter(Boolean).join("\n");
      if (row.title !== title) row.title = title;
    } finally { probe.remove(); }
  }
  function refresh() { if (!disposed && !frame) frame = raf(fit); }
  const resize = typeof ResizeObserver === "function" ? new ResizeObserver(refresh) : null;
  resize?.observe(row);
  const mutations = typeof MutationObserver === "function" ? new MutationObserver(refresh) : null;
  mutations?.observe(row, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["hidden", "class"] });
  const appearance = typeof MutationObserver === "function" ? new MutationObserver(refresh) : null;
  appearance?.observe(root, { attributes: true, attributeFilter: ["style", "class"] });
  const fonts = document.fonts;
  fonts?.addEventListener?.("loadingdone", refresh);
  refresh();
  return {
    refresh,
    renderLegend(next) {
      const key = JSON.stringify(next);
      if (key === signature) return;
      signature = key; items = next;
      const fragment = document.createDocumentFragment();
      for (const [name, color] of next) {
        const chip = document.createElement("span"); chip.className = "wg-chip";
        chip.title = name; chip.setAttribute("role", "listitem"); chip.setAttribute("aria-label", name);
        const swatch = document.createElement("span"); swatch.className = "wg-sw"; swatch.style.background = color; swatch.setAttribute("aria-hidden", "true");
        const label = document.createElement("span"); label.className = "wg-chip-label"; label.textContent = name;
        chip.append(swatch, label); fragment.appendChild(chip);
      }
      legend.replaceChildren(fragment);
      legend.title = next.map(([name]) => name).join("\n");
      legend.setAttribute("aria-label", next.length ? `Wildcard category colors: ${next.map(([name]) => name).join(", ")}` : "Wildcard category colors");
      legend.tabIndex = next.length ? 0 : -1;
      refresh();
    },
    cleanup() {
      disposed = true; if (frame) cancel(frame); frame = 0;
      resize?.disconnect(); mutations?.disconnect(); appearance?.disconnect();
      fonts?.removeEventListener?.("loadingdone", refresh);
    },
  };
}
