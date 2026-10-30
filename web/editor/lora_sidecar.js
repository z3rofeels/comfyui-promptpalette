import { createLoraPicker } from "./lora_picker.js";
import { readEditorPreference, writeEditorPreference } from "../prompt_palette_state.js";
import { copyPromptPaletteThemeScope, installPromptPaletteKeyboardBoundary, svgIcon } from "../prompt_palette_shared.js";
import { scheduleDomWidgetRemeasure } from "../prompt_palette_compat.js";

const make = (tag, cls = "", text = "") => { const el = document.createElement(tag); el.className = cls; el.textContent = text; return el; };
let sequence = 0;

const SIDECAR_GAP = 8;
const SIDECAR_MARGIN = 8;

export function installLoraSidecar({ root, node = null, editor, beforeOpen = () => {}, inlineHost = null }) {
  if (root.__ppLoraSidecar) return root.__ppLoraSidecar;

  const getViewportBounds = () => {
    const vw = globalThis.innerWidth || document.documentElement?.clientWidth || 1024;
    const vh = globalThis.innerHeight || document.documentElement?.clientHeight || 768;
    return { vw, vh };
  };

  const savedSize = readEditorPreference("loraSidecarSizeV1", null);
  const panelSize = {
    width: Number.isFinite(savedSize?.width) ? Math.max(320, Math.min(1200, savedSize.width)) : 540,
    height: Number.isFinite(savedSize?.height) ? Math.max(260, Math.min(1000, savedSize.height)) : 680,
  };
  const persistSize = () => writeEditorPreference("loraSidecarSizeV1", { ...panelSize });

  let floatingPosition = null;
  writeEditorPreference("loraSidecarPositionV1", null);
  const persistPosition = () => writeEditorPreference("loraSidecarPositionV1", floatingPosition ? { ...floatingPosition } : null);

  const isInline = !!inlineHost;
  const sidecar = make("div", isInline ? "wg-drawer left wg-library-popup pp-lora-sidecar pp-lora-inline" : "wg-root pp-lora-sidecar-window");
  sidecar.id = `pp-loras-${++sequence}`;
  sidecar.hidden = true;
  sidecar.setAttribute("role", "dialog");
  sidecar.setAttribute("aria-label", "LoraPal");
  sidecar.setAttribute("aria-modal", "false");

  if (!isInline) {
    sidecar.addEventListener("pointerdown", (e) => e.stopPropagation());
    sidecar.addEventListener("mousedown", (e) => e.stopPropagation());
    sidecar.addEventListener("click", (e) => e.stopPropagation());
    sidecar.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });
  }

  // Window Header
  const header = make("div", "wg-library-sidecar-head pp-lora-window-head");
  const dragHandle = make("button", "wg-library-sidecar-drag pp-lora-sidecar-drag");
  dragHandle.type = "button";
  dragHandle.setAttribute("data-lora-drag", "");
  dragHandle.setAttribute("aria-label", "Move LoraPal; use arrow keys. Double-click to toggle Follow Node.");
  dragHandle.title = "Drag to move · Arrow keys move · Double-click to toggle Follow Node";

  dragHandle.innerHTML = `<span class="pp-lora-brandmark" aria-hidden="true">${svgIcon("layers", 14)}</span><span class="pp-lora-title-wrap"><strong>LoraPal</strong><small class="pp-lora-target-name"></small></span>`;
  const targetSub = dragHandle.querySelector(".pp-lora-target-name");

  const ctrls = make("div", "pp-lora-window-ctrls");
  const useCursor = make("button", "wg-button pp-lora-win-btn");
  useCursor.type = "button";
  useCursor.innerHTML = `${svgIcon("select", 12)}<span>Use cursor</span>`;
  useCursor.title = "Target the editor’s current selection or cursor";

  const followBtn = make("button", "wg-button pp-lora-win-btn");
  followBtn.type = "button";
  followBtn.setAttribute("data-lora-follow", "");
  followBtn.innerHTML = `${svgIcon("pin", 12)}<span>Follow node</span>`;
  followBtn.title = "Keep sidecar beside node as canvas pans and zooms";
  followBtn.setAttribute("aria-pressed", String(!floatingPosition));

  const resetBtn = make("button", "wg-button pp-lora-win-btn");
  resetBtn.type = "button";
  resetBtn.setAttribute("data-lora-reset", "");
  resetBtn.innerHTML = `${svgIcon("undo", 12)}<span>Reset</span>`;
  resetBtn.title = "Restore default window size and dock beside node";

  const closeButton = make("button", "wg-close-btn");
  closeButton.type = "button";
  closeButton.innerHTML = svgIcon("close", 14);
  closeButton.setAttribute("aria-label", "Close LoraPal");

  if (!isInline) {
    ctrls.append(useCursor, followBtn, resetBtn);
  } else {
    ctrls.append(useCursor);
  }
  header.append(dragHandle, ctrls, closeButton);

  // Body & Footer
  const body = make("div", "pp-lora-body");
  const footer = make("div", "pp-lora-window-foot");
  const status = make("div", "pp-tool-status");
  status.setAttribute("role", "status");

  const resizeHandle = make("button", "pp-lora-sidecar-resize", "◢");
  resizeHandle.type = "button";
  resizeHandle.setAttribute("data-lora-resize", "");
  resizeHandle.setAttribute("aria-label", "Resize LoraPal; use arrow keys");
  resizeHandle.title = "Drag to resize · Arrow keys resize";

  const resizers = [];
  if (!isInline) {
    footer.append(status, resizeHandle);
    sidecar.append(header, body, footer);

    const edges = [
      { edge: "e", cls: "pp-lora-resizer-e", title: "Drag right border to resize width" },
      { edge: "w", cls: "pp-lora-resizer-w", title: "Drag left border to resize width" },
      { edge: "s", cls: "pp-lora-resizer-s", title: "Drag bottom border to resize height" },
      { edge: "sw", cls: "pp-lora-resizer-sw", title: "Drag bottom-left corner to resize" },
      { edge: "se", cls: "pp-lora-resizer-se", title: "Drag bottom-right corner to resize" },
    ];
    for (const item of edges) {
      const resizer = make("div", `pp-lora-resizer ${item.cls}`);
      resizer.setAttribute("data-lora-edge", item.edge);
      resizer.title = item.title;
      sidecar.appendChild(resizer);
      resizers.push({ el: resizer, edge: item.edge });
    }
    resizers.push({ el: resizeHandle, edge: "se" });
    document.body.appendChild(sidecar);
  } else {
    sidecar.append(header, body, status);
    inlineHost.appendChild(sidecar);
  }

  const trigger = root.querySelector('[data-act="loras"]');
  trigger?.setAttribute("aria-controls", sidecar.id);

  let picker = null, activeEditor = editor, lastEditor = editor, disposed = false;
  let gesture = null, sidecarFrame = 0, sidecarPlacement = "", themeObserver = null;

  const setStatus = (text, error = false) => {
    status.textContent = text;
    status.classList.toggle("is-error", error);
  };

  function syncTheme() {
    if (isInline || !sidecar.isConnected) return;
    const scope = root.closest?.(".wg-node, .pp-node, .ppwc-surface") || root;
    copyPromptPaletteThemeScope(scope, sidecar);
    for (const cls of ["wg-high-contrast", "wg-reduce-motion", "wg-no-animations", "wg-disable-animations", "wg-large-text"]) {
      sidecar.classList.toggle(cls, scope.classList?.contains(cls) === true);
    }
  }

  function finishGesture() {
    if (!gesture) return;
    const { target, id, type } = gesture;
    gesture = null;
    if (target?.hasPointerCapture?.(id)) {
      try { target.releasePointerCapture(id); } catch {}
    }
    sidecar.classList.remove("is-manipulating");
    if (type === "resize") {
      persistSize();
      persistPosition();
    } else {
      persistPosition();
    }
  }

  function getNodeScreenBounds(node, root) {
    if (root && root.isConnected) {
      const r = root.getBoundingClientRect();
      if (r.width >= 40 && r.height >= 40 && r.bottom > 0 && r.right > 0) {
        return r;
      }
    }
    if (node && node.pos && node.size) {
      const canvas = node.graph?.canvas || globalThis.app?.canvas || globalThis.LGraphCanvas?.active_canvas;
      if (canvas?.ds) {
        const p1 = canvas.ds.toScreen(node.pos[0], node.pos[1]);
        const p2 = canvas.ds.toScreen(node.pos[0] + node.size[0], node.pos[1] + node.size[1]);
        const w = Math.abs(p2[0] - p1[0]);
        const h = Math.abs(p2[1] - p1[1]);
        if (w >= 40 && h >= 40) {
          return {
            left: Math.min(p1[0], p2[0]),
            top: Math.min(p1[1], p2[1]),
            right: Math.max(p1[0], p2[0]),
            bottom: Math.max(p1[1], p2[1]),
            width: w,
            height: h,
          };
        }
      }
    }
    const vw = globalThis.innerWidth || 1024;
    const vh = globalThis.innerHeight || 768;
    return {
      left: Math.round(vw * 0.15),
      top: Math.round(vh * 0.1),
      right: Math.round(vw * 0.55),
      bottom: Math.round(vh * 0.7),
      width: Math.round(vw * 0.4),
      height: Math.round(vh * 0.6),
    };
  }

  function placeSidecar() {
    if (isInline || sidecar.hidden) return;
    if (gesture) return;
    const { vw, vh } = getViewportBounds();
    const maxW = Math.max(200, vw - SIDECAR_MARGIN * 2);
    const maxH = Math.max(200, vh - SIDECAR_MARGIN * 2);
    const width = Math.min(Math.max(320, panelSize.width), maxW);
    const height = Math.min(Math.max(260, panelSize.height), maxH);

    let left, top;
    if (floatingPosition) {
      left = floatingPosition.left;
      top = floatingPosition.top;
    } else {
      const bounds = getNodeScreenBounds(node, root);
      // Prefer docking to the right of node
      let dockLeft = bounds.right + SIDECAR_GAP;
      // If right side doesn't fit, dock to the left of node
      if (dockLeft + width > vw - SIDECAR_MARGIN) {
        dockLeft = bounds.left - SIDECAR_GAP - width;
      }
      // If neither side fits cleanly, pick side with more screen space
      if (dockLeft < SIDECAR_MARGIN && bounds.right + SIDECAR_GAP + width > vw - SIDECAR_MARGIN) {
        const spaceLeft = Math.max(0, bounds.left - SIDECAR_MARGIN);
        const spaceRight = Math.max(0, vw - SIDECAR_MARGIN - bounds.right);
        dockLeft = spaceRight >= spaceLeft ? bounds.right + SIDECAR_GAP : bounds.left - SIDECAR_GAP - width;
      }
      left = dockLeft;
      top = bounds.top;
    }

    // Unconditional viewport clamp: 100% of the window stays visible on screen
    left = Math.max(SIDECAR_MARGIN, Math.min(left, vw - width - SIDECAR_MARGIN));
    top = Math.max(SIDECAR_MARGIN, Math.min(top, vh - height - SIDECAR_MARGIN));

    const key = [Math.round(left), Math.round(top), Math.round(width), Math.round(height), floatingPosition ? "f" : "a"].join();
    if (key === sidecarPlacement) return;
    sidecarPlacement = key;

    Object.assign(sidecar.style, {
      left: `${Math.round(left)}px`,
      top: `${Math.round(top)}px`,
      width: `${Math.round(width)}px`,
      height: `${Math.round(height)}px`,
    });
    followBtn.setAttribute("aria-pressed", String(!floatingPosition));
  }

  function trackSidecar() {
    sidecarFrame = 0;
    if (isInline || sidecar.hidden) return;
    if (!document.hidden && !gesture) placeSidecar();
    if (!sidecar.hidden && typeof requestAnimationFrame === "function") {
      sidecarFrame = requestAnimationFrame(trackSidecar);
    }
  }

  function toggleFollow() {
    finishGesture();
    if (floatingPosition) {
      floatingPosition = null;
      persistPosition();
    } else {
      const r = sidecar.getBoundingClientRect();
      floatingPosition = { left: r.left, top: r.top };
      persistPosition();
    }
    sidecarPlacement = "";
    placeSidecar();
  }

  function resetWindow() {
    finishGesture();
    const { vw, vh } = getViewportBounds();
    panelSize.width = Math.min(540, Math.max(320, vw - SIDECAR_MARGIN * 2));
    panelSize.height = Math.min(680, Math.max(260, vh - SIDECAR_MARGIN * 2));
    floatingPosition = null;
    persistSize();
    persistPosition();
    sidecarPlacement = "";
    placeSidecar();
  }

  function onPointerMove(e) {
    if (!gesture || e.pointerId !== gesture.id) return;
    e.preventDefault();
    e.stopPropagation();
    const { vw, vh } = getViewportBounds();
    const maxW = Math.max(200, vw - SIDECAR_MARGIN * 2);
    const maxH = Math.max(200, vh - SIDECAR_MARGIN * 2);

    if (gesture.type === "resize") {
      const { edge, startX, startY, startLeft, startTop, startWidth, startHeight } = gesture;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      let newWidth = startWidth;
      let newHeight = startHeight;
      let newLeft = startLeft;
      let newTop = startTop;

      if (edge.includes("e")) {
        const rawW = startWidth + dx;
        const maxAllowedW = Math.min(1200, maxW, vw - startLeft - SIDECAR_MARGIN);
        newWidth = Math.max(320, Math.min(maxAllowedW, rawW));
      } else if (edge.includes("w")) {
        const startRight = startLeft + startWidth;
        const rawW = startWidth - dx;
        const maxAllowedW = Math.min(1200, maxW, startRight - SIDECAR_MARGIN);
        newWidth = Math.max(320, Math.min(maxAllowedW, rawW));
        newLeft = startRight - newWidth;
      }

      if (edge.includes("s")) {
        const rawH = startHeight + dy;
        const maxAllowedH = Math.min(1000, maxH, vh - startTop - SIDECAR_MARGIN);
        newHeight = Math.max(260, Math.min(maxAllowedH, rawH));
      } else if (edge.includes("n")) {
        const startBottom = startTop + startHeight;
        const rawH = startHeight - dy;
        const maxAllowedH = Math.min(1000, maxH, startBottom - SIDECAR_MARGIN);
        newHeight = Math.max(260, Math.min(maxAllowedH, rawH));
        newTop = startBottom - newHeight;
      }

      panelSize.width = Math.round(newWidth);
      panelSize.height = Math.round(newHeight);
      floatingPosition.left = Math.round(Math.max(SIDECAR_MARGIN, Math.min(newLeft, vw - panelSize.width - SIDECAR_MARGIN)));
      floatingPosition.top = Math.round(Math.max(SIDECAR_MARGIN, Math.min(newTop, vh - panelSize.height - SIDECAR_MARGIN)));

      Object.assign(sidecar.style, {
        left: `${floatingPosition.left}px`,
        top: `${floatingPosition.top}px`,
        width: `${panelSize.width}px`,
        height: `${panelSize.height}px`,
      });
    } else if (gesture.type === "move") {
      const { startX, startY, startLeft, startTop } = gesture;
      const width = Math.min(panelSize.width, maxW);
      const height = Math.min(panelSize.height, maxH);
      floatingPosition = {
        left: Math.round(Math.max(SIDECAR_MARGIN, Math.min(startLeft + (e.clientX - startX), vw - width - SIDECAR_MARGIN))),
        top: Math.round(Math.max(SIDECAR_MARGIN, Math.min(startTop + (e.clientY - startY), vh - height - SIDECAR_MARGIN))),
      };

      Object.assign(sidecar.style, {
        left: `${floatingPosition.left}px`,
        top: `${floatingPosition.top}px`,
      });
    }
  }

  function onKeyDown(e, isResize, edge = "se") {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key) || e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    e.stopPropagation();
    const step = e.shiftKey ? 40 : 10;
    const dx = e.key === "ArrowRight" ? step : e.key === "ArrowLeft" ? -step : 0;
    const dy = e.key === "ArrowDown" ? step : e.key === "ArrowUp" ? -step : 0;
    const { vw, vh } = getViewportBounds();
    const rect = sidecar.getBoundingClientRect();
    if (isResize) {
      if (!floatingPosition) floatingPosition = { left: rect.left, top: rect.top };
      if (edge.includes("w")) {
        const nextW = Math.max(320, Math.min(1200, vw - SIDECAR_MARGIN * 2, panelSize.width - dx));
        floatingPosition.left = Math.max(SIDECAR_MARGIN, Math.min(floatingPosition.left + (panelSize.width - nextW), vw - nextW - SIDECAR_MARGIN));
        panelSize.width = nextW;
      } else {
        panelSize.width = Math.max(320, Math.min(1200, vw - rect.left - SIDECAR_MARGIN, panelSize.width + dx));
      }
      if (edge.includes("n")) {
        const nextH = Math.max(260, Math.min(1000, vh - SIDECAR_MARGIN * 2, panelSize.height - dy));
        floatingPosition.top = Math.max(SIDECAR_MARGIN, Math.min(floatingPosition.top + (panelSize.height - nextH), vh - nextH - SIDECAR_MARGIN));
        panelSize.height = nextH;
      } else {
        panelSize.height = Math.max(260, Math.min(1000, vh - rect.top - SIDECAR_MARGIN, panelSize.height + dy));
      }
      persistSize();
      persistPosition();
    } else {
      if (!floatingPosition) floatingPosition = { left: rect.left, top: rect.top };
      floatingPosition.left = Math.max(SIDECAR_MARGIN, Math.min(floatingPosition.left + dx, vw - panelSize.width - SIDECAR_MARGIN));
      floatingPosition.top = Math.max(SIDECAR_MARGIN, Math.min(floatingPosition.top + dy, vh - panelSize.height - SIDECAR_MARGIN));
      persistPosition();
    }
    sidecarPlacement = "";
    placeSidecar();
  }

  const onViewportResize = () => {
    if (sidecar.hidden || isInline) return;
    sidecarPlacement = "";
    placeSidecar();
  };

  function startMove(e) {
    if (e.button !== 0 || gesture) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = sidecar.getBoundingClientRect();
    floatingPosition = { left: rect.left, top: rect.top };
    followBtn.setAttribute("aria-pressed", "false");
    gesture = {
      type: "move",
      target: e.currentTarget,
      id: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      startLeft: rect.left,
      startTop: rect.top,
    };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
    sidecar.classList.add("is-manipulating");
  }

  function startResize(e, edge) {
    if (e.button !== 0 || gesture) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = sidecar.getBoundingClientRect();
    floatingPosition = { left: rect.left, top: rect.top };
    followBtn.setAttribute("aria-pressed", "false");
    gesture = {
      type: "resize",
      edge,
      target: e.currentTarget,
      id: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      startLeft: rect.left,
      startTop: rect.top,
      startWidth: rect.width,
      startHeight: rect.height,
    };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
    sidecar.classList.add("is-manipulating");
  }

  // Setup dragging & resizing
  if (!isInline) {
    dragHandle.addEventListener("dblclick", (e) => { e.stopPropagation(); toggleFollow(); });
    header.addEventListener("dblclick", (e) => {
      if (e.target.closest("button:not(.pp-lora-sidecar-drag)")) return;
      e.stopPropagation();
      toggleFollow();
    });
    followBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleFollow(); });
    resetBtn.addEventListener("click", (e) => { e.stopPropagation(); resetWindow(); });

    header.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button:not(.pp-lora-sidecar-drag), select, input, textarea, a")) return;
      startMove(e);
    });
    dragHandle.addEventListener("pointerdown", startMove);
    dragHandle.addEventListener("keydown", (e) => onKeyDown(e, false));

    for (const { el, edge } of resizers) {
      el.addEventListener("pointerdown", (e) => startResize(e, edge));
      el.addEventListener("keydown", (e) => onKeyDown(e, true, edge));
    }

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", finishGesture);
    window.addEventListener("pointercancel", finishGesture);
    window.addEventListener("resize", onViewportResize, { passive: true });

    installPromptPaletteKeyboardBoundary(sidecar);
  }

  function close({ restoreFocus = false } = {}) {
    observer.disconnect();
    if (sidecarFrame) { cancelAnimationFrame(sidecarFrame); sidecarFrame = 0; }
    picker?.cleanup();
    picker = null;
    body.replaceChildren();
    sidecar.classList.remove("open");
    sidecar.hidden = true;
    sidecar.setAttribute("inert", "");
    sidecar.setAttribute("aria-hidden", "true");
    trigger?.classList.remove("active");
    trigger?.setAttribute("aria-expanded", "false");
    themeObserver?.disconnect();
    if (restoreFocus && activeEditor?.isConnected) activeEditor.focus({ preventScroll: true });
    if (node) scheduleDomWidgetRemeasure(node);
  }

  function open(target = lastEditor || editor, { range = null, focus = true, variation = null } = {}) {
    if (disposed || !target?.isConnected) return false;
    const readOnly = target.readOnly || target.disabled || target.getAttribute("aria-readonly") === "true";
    const draft = picker?.draft?.();
    beforeOpen();
    observer.observe(document.body, { childList: true, subtree: true });
    picker?.cleanup();
    body.replaceChildren();
    activeEditor = lastEditor = target;

    const context = target.__ppPromptTools || {};
    const snapshot = {
      source: target.value,
      start: range?.start ?? target.selectionStart,
      end: range?.end ?? target.selectionEnd,
      direction: target.selectionDirection,
    };
    let projection = context.project?.(snapshot.source) ?? snapshot.source;

    const guard = () => {
      if (!target.isConnected || target.value !== snapshot.source || (context.project?.(snapshot.source) ?? snapshot.source) !== projection) {
        const text = "Editor changed · choose Use cursor to retarget active selection.";
        setStatus(text, true);
        throw new Error(text);
      }
    };

    sidecar.hidden = false;
    sidecar.removeAttribute("inert");
    sidecar.setAttribute("aria-hidden", "false");
    sidecar.classList.add("open");
    trigger?.classList.add("active");
    trigger?.setAttribute("aria-expanded", "true");

    syncTheme();
    themeObserver?.disconnect();
    themeObserver = new MutationObserver(syncTheme);
    for (let el = root; el; el = el.parentElement) {
      themeObserver.observe(el, { attributes: true, attributeFilter: ["style", "class", "data-wg-tone", "data-wg-finish"] });
    }

    // Update target name indicator
    const targetField = context.label || (target.dataset?.field ? `Field: ${target.dataset.field}` : "Prompt text");
    targetSub.textContent = `· ${targetField}`;

    // Always start docked/pinned to main node on open
    floatingPosition = null;
    writeEditorPreference("loraSidecarPositionV1", null);
    sidecarPlacement = "";
    placeSidecar();
    trackSidecar();

    setStatus(readOnly ? "Browse & audition freely · choose an editable field and Use cursor to insert." : "Browse, audition & stack LoRAs. Use cursor to retarget.");

    picker = createLoraPicker({
      host: body,
      editor: target,
      context,
      snapshot,
      guard,
      close,
      message: setStatus,
      keepOpen: true,
      variation,
      draft,
      applied(next) {
        Object.assign(snapshot, next);
        projection = context.project?.(snapshot.source) ?? snapshot.source;
        setStatus("Applied · keep editing, auditioning or choose Use cursor to insert elsewhere.");
      },
    });

    if (focus) picker.focus();
    if (node) scheduleDomWidgetRemeasure(node);
    return true;
  }

  const remember = event => {
    if (event.target?.__ppPromptTools && (!node || event.target.__ppPromptTools.node === node) && !event.target.readOnly && !event.target.disabled) {
      lastEditor = event.target;
    }
  };

  const closeForOtherTool = event => {
    const action = event.target.closest?.("[data-act]")?.dataset.act;
    if (sidecar.classList.contains("open") && ["picker", "edit", "settings", "stash", "recipesShortcut", "variations", "ioRailToggle", "zenToggle"].includes(action)) {
      close();
    }
  };

  const toggle = () => sidecar.classList.contains("open") ? close({ restoreFocus: true }) : open();
  const rebase = () => open(lastEditor || activeEditor, { focus: false });
  const escape = event => {
    if (event.key === "Escape" && !event.defaultPrevented && sidecar.classList.contains("open")) {
      event.preventDefault();
      event.stopPropagation();
      close({ restoreFocus: true });
    }
  };

  trigger?.addEventListener("click", toggle);
  closeButton.addEventListener("click", () => close({ restoreFocus: true }));
  useCursor.addEventListener("mousedown", event => event.preventDefault());
  useCursor.addEventListener("click", rebase);
  root.addEventListener("click", closeForOtherTool, true);
  root.addEventListener("focusin", remember);
  sidecar.addEventListener("keydown", escape);

  const manager = {
    open,
    close,
    isOpen: () => sidecar.classList.contains("open"),
    cleanup() {
      if (disposed) return;
      close();
      disposed = true;
      if (sidecarFrame) cancelAnimationFrame(sidecarFrame);
      observer.disconnect();
      themeObserver?.disconnect();
      if (!isInline) {
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", finishGesture);
        window.removeEventListener("pointercancel", finishGesture);
        window.removeEventListener("resize", onViewportResize);
      }
      trigger?.removeEventListener("click", toggle);
      root.removeEventListener("click", closeForOtherTool, true);
      root.removeEventListener("focusin", remember);
      sidecar.remove();
      if (root.__ppLoraSidecar === manager) delete root.__ppLoraSidecar;
      if (node?._ppLoraSidecar === manager) delete node._ppLoraSidecar;
    },
  };

  const observer = new MutationObserver(() => {
    if (!root.isConnected) manager.cleanup();
    else if (picker && !activeEditor.isConnected) close();
  });

  root.__ppLoraSidecar = manager;
  if (node) node._ppLoraSidecar = manager;
  return manager;
}

export function openLoraSidecar(editor, options = {}) {
  const node = editor?.__ppPromptTools?.node;
  if (node?._ppLoraSidecar) return node._ppLoraSidecar.open(editor, options);
  for (let el = editor; el; el = el.parentElement) {
    if (el.__ppLoraSidecar) return el.__ppLoraSidecar.open(editor, options);
  }
  const root = editor?.closest?.(".wg-root, .pp-node, .wg-node") || editor?.parentElement;
  if (root?.__ppLoraSidecar) return root.__ppLoraSidecar.open(editor, options);

  return installLoraSidecar({ root: root || document.body, node, editor })?.open(editor, options) || false;
}
