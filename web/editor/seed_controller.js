import { svgIcon, copyPromptPaletteThemeScope, installPromptPaletteKeyboardBoundary } from "../prompt_palette_shared.js";
import { escapeHtml } from "./text_utils.js";
import {
  getSeedFortune,
  generateRandomSeed,
  getSeedHistory,
  addSeedHistory,
  getFavoriteSeeds,
  toggleFavoriteSeed,
  isFavoriteSeed,
  SEED_PRESETS,
} from "./seed_fortune.js";

/**
 * Creates and installs the unified Seed Controller for Prompt Palette.
 * Enhances the seed bar with stepping, tumbling, Wheel of Fortune, and Seed Fortunes.
 */
export function installSeedController({
  root,
  seedWidget,
  controlWidget,
  modeWidget,
  node,
  reactiveRuntime,
  theme,
  saveTheme,
}) {
  const seedbar = root.querySelector('[data-el="seedbar"]');
  if (!seedbar) return { sync: () => {}, onRoll: () => {}, dispose: () => {} };

  const seedInput = seedbar.querySelector('[data-el="seedInput"]');
  const spinBtn = seedbar.querySelector('[data-act="seedRandomizeNow"]');
  const decBtn = seedbar.querySelector('[data-act="seedDecrement"]');
  const incBtn = seedbar.querySelector('[data-act="seedIncrement"]');
  const copyBtn = seedbar.querySelector('[data-act="seedCopy"]');
  const openWheelBtn = seedbar.querySelector('[data-act="seedOpenWheel"]');
  const menuBtn = seedbar.querySelector('[data-act="seedMenuToggle"]');

  const fortuneBadge = seedbar.querySelector('[data-el="seedFortuneBadge"]');
  const fortuneName = seedbar.querySelector('[data-el="seedFortuneName"]');
  const fortuneRating = seedbar.querySelector('[data-el="seedFortuneRating"]');

  const hubPopover = seedbar.querySelector('[data-el="seedHubPopover"]');
  const hubBody = seedbar.querySelector('[data-el="seedHubBody"]');
  const closeHubBtn = seedbar.querySelector('[data-act="closeSeedHub"]');

  const hubHome = hubPopover?.parentElement;
  const portal = document.createElement("div");
  portal.className = "wg-root wg-seed-portal";
  const hubHead = hubPopover?.querySelector(".wg-seed-hub-head");
  let hubPosition = null;
  let drag = null;
  let lastSeed = String(seedWidget?.value);
  let lastMode = String(controlWidget?.value);
  if (hubHead) {
    hubHead.tabIndex = 0;
    hubHead.title = "Drag to move · Arrow keys to move · Home to reset position";
    hubHead.setAttribute("aria-label", "Move Seed Lab; use arrow keys, Home to reset");
  }
  function positionHub(reset = false) {
    if (!hubPopover || hubPopover.hidden) return;
    copyPromptPaletteThemeScope(root, portal);
    const anchor = seedAnchorRect();
    const rect = hubPopover.getBoundingClientRect();
    if (reset || !hubPosition) hubPosition = { x: anchor.right - rect.width, y: anchor.bottom + 6 };
    hubPosition.x = Math.max(8, Math.min(hubPosition.x, innerWidth - rect.width - 8));
    hubPosition.y = Math.max(8, Math.min(hubPosition.y, innerHeight - rect.height - 8));
    hubPopover.style.left = `${hubPosition.x}px`;
    hubPopover.style.top = `${hubPosition.y}px`;
  }
  function startDrag(e) {
    if (e.button !== 0 || e.target.closest("button")) return;
    e.preventDefault();
    drag = { x: e.clientX, y: e.clientY, left: hubPosition.x, top: hubPosition.y };
    hubHead.setPointerCapture(e.pointerId);
  }
  function moveDrag(e) {
    if (!drag) return;
    hubPosition = { x: drag.left + e.clientX - drag.x, y: drag.top + e.clientY - drag.y };
    positionHub();
  }
  function moveByKey(e) {
    if (e.target !== hubHead) return;
    const steps = {ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]};
    if (e.key === "Home") { e.preventDefault(); positionHub(true); }
    if (!steps[e.key]) return;
    e.preventDefault();
    const [x,y] = steps[e.key], step = e.shiftKey ? 40 : 10;
    hubPosition.x += x * step; hubPosition.y += y * step; positionHub();
  }
  hubHead?.addEventListener("pointerdown", startDrag);
  hubHead?.addEventListener("pointermove", moveDrag);
  hubHead?.addEventListener("lostpointercapture", () => { drag = null; });
  hubHead?.addEventListener("keydown", moveByKey);
  hubPopover?.addEventListener("keydown", handlePopoverKeyDown);
  for (const type of ["pointerdown", "pointermove", "pointerup", "mousedown", "mouseup", "click", "dblclick", "wheel"]) {
    portal.addEventListener(type, e => e.stopPropagation());
  }
  const cleanupKeyboard = installPromptPaletteKeyboardBoundary(portal);
  const resizeHub = () => positionHub();
  window.addEventListener("resize", resizeHub);

  // ---------------------------------------------------------
  // Toolbar Seed module + anchored Seed panel
  // The seed controls no longer occupy a row of node height: the toolbar's Seed
  // module (wheel + live seed) opens them in a small panel portaled beside it,
  // escaping the canvas transform and node overflow like the Seed Lab does.
  // ---------------------------------------------------------
  const panelBtn = root.querySelector('[data-act="seedPanel"]');
  const panelValue = root.querySelector('[data-el="seedToolbarValue"]');
  const panelModeTag = root.querySelector('[data-el="seedToolbarMode"]');
  // No control_after_generate widget: hide the empty "After run" row.
  const seedModeField = seedbar.querySelector('[data-el="seedModeSelect"]')?.closest(".wg-seed-panel-field");
  if (seedModeField) seedModeField.hidden = !controlWidget;
  const panelPlaceholder = document.createComment("prompt-palette-seed-panel");
  seedbar.before(panelPlaceholder);
  const panelPortal = document.createElement("div");
  panelPortal.className = "wg-root wg-seed-panel-portal";
  const panelFrame = document.createElement("div");
  panelFrame.className = "wg-seed-panel-frame";
  panelPortal.append(panelFrame);
  for (const type of ["pointerdown", "pointermove", "pointerup", "mousedown", "mouseup", "click", "dblclick", "wheel", "contextmenu"]) {
    panelPortal.addEventListener(type, e => e.stopPropagation());
  }
  const cleanupPanelKeyboard = installPromptPaletteKeyboardBoundary(panelPortal);
  let panelFollowFrame = null;
  let panelAnchorKey = "";

  function visibleRect(element) {
    if (!element?.isConnected) return null;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 ? rect : null;
  }
  function seedAnchorRect() {
    return (!seedbar.hidden && visibleRect(panelFrame)) || visibleRect(panelBtn) || root.getBoundingClientRect();
  }
  function isPanelOpen() { return !seedbar.hidden; }
  function positionPanel() {
    if (!isPanelOpen()) return;
    const anchor = visibleRect(panelBtn) || root.getBoundingClientRect();
    const rect = panelFrame.getBoundingClientRect();
    let x = anchor.right - rect.width;
    let y = anchor.bottom + 6;
    if (y + rect.height > innerHeight - 8 && anchor.top - rect.height - 6 >= 8) y = anchor.top - rect.height - 6;
    x = Math.max(8, Math.min(x, innerWidth - rect.width - 8));
    y = Math.max(8, Math.min(y, innerHeight - rect.height - 8));
    panelFrame.style.setProperty("--pp-seed-panel-left", `${Math.round(x)}px`);
    panelFrame.style.setProperty("--pp-seed-panel-top", `${Math.round(y)}px`);
  }
  // Follow the node while the canvas pans/zooms; close if the module disappears
  // (toolbar collapsed, Seed module hidden, node removed).
  function followPanel() {
    panelFollowFrame = null;
    if (disposed || !isPanelOpen()) return;
    const anchor = visibleRect(panelBtn);
    if (!anchor || !root.isConnected) { closePanel(); return; }
    const key = `${anchor.left}|${anchor.top}|${anchor.right}|${anchor.bottom}|${innerWidth}|${innerHeight}`;
    if (key !== panelAnchorKey) { panelAnchorKey = key; positionPanel(); }
    panelFollowFrame = requestAnimationFrame(followPanel);
  }
  function openPanel() {
    if (disposed || isPanelOpen() || !panelBtn) return;
    closeHub({ restoreFocus: false });
    copyPromptPaletteThemeScope(root, panelPortal);
    panelFrame.append(seedbar);
    document.body.append(panelPortal);
    seedbar.hidden = false;
    seedbar.removeAttribute("inert");
    panelBtn.setAttribute("aria-expanded", "true");
    document.addEventListener("pointerdown", handlePanelDocumentPointerDown);
    sync();
    panelAnchorKey = "";
    positionPanel();
    seedInput?.focus({ preventScroll: true });
    if (panelFollowFrame == null) panelFollowFrame = requestAnimationFrame(followPanel);
  }
  function closePanel({ restoreFocus = false } = {}) {
    document.removeEventListener("pointerdown", handlePanelDocumentPointerDown);
    if (!isPanelOpen()) return;
    const hadFocus = seedbar.contains(document.activeElement);
    seedbar.hidden = true;
    seedbar.setAttribute("inert", "");
    panelPlaceholder.after(seedbar);
    panelPortal.remove();
    panelBtn?.setAttribute("aria-expanded", "false");
    if (panelFollowFrame != null) cancelAnimationFrame(panelFollowFrame);
    panelFollowFrame = null;
    if (restoreFocus && hadFocus && !disposed) panelBtn?.focus({ preventScroll: true });
  }
  function handlePanelButtonClick(e) {
    if (e.shiftKey) {
      if (hubPopover && !hubPopover.hidden && activeHubTab === "wheel") closeHub();
      else openHub("wheel");
      return;
    }
    if (isPanelOpen()) closePanel({ restoreFocus: false });
    else openPanel();
  }
  panelBtn?.addEventListener("click", handlePanelButtonClick);
  function handlePanelDocumentPointerDown(e) {
    if (isPanelOpen() && !panelFrame.contains(e.target) && !panelBtn?.contains(e.target)) closePanel();
  }
  function handlePanelKeyDown(e) {
    if (e.key !== "Escape" || !isPanelOpen()) return;
    e.preventDefault();
    e.stopPropagation();
    closePanel({ restoreFocus: true });
  }
  seedbar.addEventListener("keydown", handlePanelKeyDown);
  const handleExternalPanelClose = () => closePanel();
  root.addEventListener("pp-seed-panel-close", handleExternalPanelClose);

  const SEED_MODE_TAGS = { fixed: "fix", increment: "+1", decrement: "−1", randomize: "rnd" };
  function seedInputConnected() {
    return !!node?.inputs?.some(input => ["seed", "external_seed"].includes(input.name) && input.link != null);
  }
  function formatToolbarSeed(text) {
    return text.length > 10 ? `${text.slice(0, 4)}…${text.slice(-4)}` : text;
  }
  function updateToolbarModule(seedVal, fortune) {
    if (!panelBtn) return;
    const text = String(seedVal ?? 0);
    const mode = String(controlWidget?.value || "");
    const connected = seedInputConnected();
    const showFortunes = theme?.seedFortuneEnabled !== false;
    if (panelValue && panelValue.textContent !== formatToolbarSeed(text)) panelValue.textContent = formatToolbarSeed(text);
    if (panelModeTag) {
      const tag = connected ? "ext" : (SEED_MODE_TAGS[mode] ?? "");
      if (panelModeTag.textContent !== tag) panelModeTag.textContent = tag;
      panelModeTag.hidden = !tag;
    }
    panelBtn.dataset.seedMode = connected ? "connected" : mode;
    if (showFortunes && fortune) panelBtn.style.setProperty("--seed-accent", fortune.accentColor);
    else panelBtn.style.removeProperty("--seed-accent");
    const lines = [`Seed ${text}${mode ? ` · ${mode}` : ""}${connected ? " · overridden by connected seed input" : ""}`];
    if (showFortunes && fortune) lines.push(`Fortune: ${fortune.archetype}`);
    lines.push("Click: seed controls · Shift+Click: Wheel of Fortune");
    panelBtn.title = lines.join("\n");
    panelBtn.setAttribute("aria-label", `Seed ${text}. Open seed controls`);
  }

  let activeHubTab = "fortune"; // "fortune" | "wheel" | "history"
  let isTumbling = false;
  let isSpinningWheel = false;
  let disposed = false;
  let tumblerFrame = null;
  let tumblerTarget = null;
  let wheelFrame = null;
  let copyResetTimer = null;
  const timers = new Set();
  const originalCopyHtml = copyBtn?.innerHTML;

  function later(callback, delay) {
    const handle = setTimeout(() => {
      timers.delete(handle);
      if (!disposed) callback();
    }, delay);
    timers.add(handle);
    return handle;
  }
  function stopTumbler() {
    if (tumblerFrame != null) cancelAnimationFrame(tumblerFrame);
    tumblerFrame = null;
    tumblerTarget = null;
    isTumbling = false;
    seedInput?.classList.remove("tumbling");
    spinBtn?.classList.remove("spinning");
    panelBtn?.classList.remove("rolling");
  }
  function stopWheel() {
    if (wheelFrame != null) cancelAnimationFrame(wheelFrame);
    wheelFrame = null;
    isSpinningWheel = false;
  }

  // ---------------------------------------------------------
  // Helper: Commit a new seed value to widget and graph
  // ---------------------------------------------------------
  function commitSeed(newValue, { triggerPreview = true, recordHistory = true, refreshHub = true } = {}) {
    if (disposed || !seedWidget) return;
    stopTumbler();
    const cleanNum = Number(newValue);
    if (!Number.isFinite(cleanNum) || !Number.isInteger(cleanNum) || cleanNum < 0 || cleanNum >= 2 ** 64) return;
    seedWidget.value = cleanNum;
    if (seedInput) {
      seedInput.value = String(cleanNum);
      seedInput.removeAttribute("aria-invalid");
    }
    if (typeof seedWidget.callback === "function") {
      seedWidget.callback(cleanNum, node.graph?.canvas, node);
    }
    const actual = seedWidget.value;
    if (seedInput) seedInput.value = String(actual);
    lastSeed = String(actual);
    node.graph?.setDirtyCanvas(true, true);
    if (triggerPreview) {
      reactiveRuntime?.invalidate("seed", { value: actual });
    }
    if (recordHistory) {
      addSeedHistory(actual);
    }
    updateFortuneUI(actual);
    sync();
    if (refreshHub && hubPopover && !hubPopover.hidden) {
      renderHubContent();
    }
  }

  // ---------------------------------------------------------
  // Helper: Update Fortune Badge & Colors
  // ---------------------------------------------------------
  function updateFortuneUI(seedVal) {
    const fortune = getSeedFortune(seedVal);
    if (fortuneBadge) {
      const showFortunes = theme?.seedFortuneEnabled !== false;
      fortuneBadge.hidden = !showFortunes;
      if (fortuneName) fortuneName.textContent = fortune.archetype;
      if (fortuneRating) fortuneRating.textContent = fortune.symbol;
      fortuneBadge.style.setProperty("--seed-accent", fortune.accentColor);
      fortuneBadge.style.setProperty("--seed-glow", fortune.glowColor);
      fortuneBadge.title = `Seed Fortune: ${fortune.archetype} (${fortune.rarityBadge})\nCreative inspiration: "${fortune.omen}"\nClick to open Seed Lab & Wheel of Fortune`;
    }
    if (openWheelBtn) {
      openWheelBtn.hidden = theme?.seedFortuneEnabled === false;
    }
    seedbar?.style?.setProperty?.("--seed-accent", fortune.accentColor);
    updateToolbarModule(seedVal, fortune);
  }

  // ---------------------------------------------------------
  // Slot Tumbler Animation (Roll / Randomize)
  // ---------------------------------------------------------
  function playTumblerAnimation(targetSeed) {
    if (disposed || !seedInput) return;
    stopTumbler();
    tumblerTarget = targetSeed;
    isTumbling = true;
    spinBtn?.classList.add("spinning");
    seedInput.classList.add("tumbling");
    panelBtn?.classList.remove("rolling");
    void panelBtn?.offsetWidth;
    panelBtn?.classList.add("rolling");
    later(() => panelBtn?.classList.remove("rolling"), 700);

    const duration = matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 320;
    const startTime = performance.now();


    function scrambleFrame(now) {
      if (disposed) return;
      const elapsed = now - startTime;
      if (elapsed < duration) {
        seedInput.value = String(seedWidget?.value ?? targetSeed);
        tumblerFrame = requestAnimationFrame(scrambleFrame);
      } else {
        seedInput.value = String(seedWidget?.value ?? targetSeed);
        seedInput.classList.remove("tumbling");
        spinBtn?.classList.remove("spinning");
        seedInput.classList.add("settled");
        later(() => seedInput.classList.remove("settled"), 280);
        tumblerFrame = null;
        tumblerTarget = null;
        isTumbling = false;
      }
    }
    tumblerFrame = requestAnimationFrame(scrambleFrame);
  }

  function onRoll(newSeed) {
    if (disposed) return;
    const actual = seedWidget?.value ?? newSeed;
    addSeedHistory(actual);
    sync();
    playTumblerAnimation(actual);
  }

  // ---------------------------------------------------------
  // Sync Controls with Widgets
  // ---------------------------------------------------------
  function sync({ recordHistory = false } = {}) {
    if (disposed) return;
    const changed = lastSeed !== String(seedWidget?.value) || lastMode !== String(controlWidget?.value);
    lastSeed = String(seedWidget?.value); lastMode = String(controlWidget?.value);
    if (changed && hubPopover && !hubPopover.hidden) renderHubContent();
    const exactStep = Number.isSafeInteger(Number(seedWidget?.value));
    if (incBtn) incBtn.disabled = !exactStep || Number(seedWidget?.value) >= Number.MAX_SAFE_INTEGER;
    if (decBtn) decBtn.disabled = !exactStep || Number(seedWidget?.value) <= 0;
    for (const btn of [incBtn, decBtn]) if (btn) btn.title = exactStep ? "Step seed by 1 · Shift: 10" : "This imported seed exceeds exact browser stepping precision; enter an exact seed to step";
    if (isTumbling && String(seedWidget?.value) !== String(tumblerTarget)) stopTumbler();
    if (seedWidget) {
      const currentSeed = seedWidget.value ?? 0;
      if (seedInput && !isTumbling) {
        seedInput.value = String(currentSeed);
        seedInput.removeAttribute("aria-invalid");
      }
      updateFortuneUI(currentSeed);
      if (recordHistory) {
        addSeedHistory(currentSeed);
        if (hubPopover && !hubPopover.hidden) renderHubContent();
      }
    }
    if (fortuneBadge) {
      fortuneBadge.hidden = theme?.seedFortuneEnabled === false;
    }
    if (openWheelBtn) {
      openWheelBtn.hidden = theme?.seedFortuneEnabled === false;
    }
  }

  // Record a typed seed once editing finishes, rather than every partial digit.
  function handleSeedInputBlur() {
    if (!disposed && seedWidget) addSeedHistory(seedWidget.value);
  }
  seedInput?.addEventListener("blur", handleSeedInputBlur);

  // ---------------------------------------------------------
  // Event: Stepping (Increment / Decrement)
  // ---------------------------------------------------------
  if (incBtn) {
    incBtn.addEventListener("click", e => {
      const step = e.shiftKey ? 10 : 1;
      const current = Number(seedWidget?.value ?? 0);
      if (!Number.isSafeInteger(current)) return;
      // The last representable Number below uint64's upper limit is 2048 lower.
      const next = Math.min(Number.MAX_SAFE_INTEGER, current + step);
      incBtn.classList.add("flash");
      later(() => incBtn.classList.remove("flash"), 180);
      commitSeed(next);
      sync();
    });
  }

  if (decBtn) {
    decBtn.addEventListener("click", e => {
      const step = e.shiftKey ? 10 : 1;
      const current = Number(seedWidget?.value ?? 0);
      if (!Number.isSafeInteger(current)) return;
      const next = Math.max(0, current - step);
      decBtn.classList.add("flash");
      later(() => decBtn.classList.remove("flash"), 180);
      commitSeed(next);
      sync();
    });
  }

  // Spin button: Roll / Randomize new seed (Shift+Click: Wheel of Fortune)
  if (spinBtn) {
    spinBtn.addEventListener("click", e => {
      if (e.shiftKey) {
        e.stopImmediatePropagation();
        openHub("wheel");
        return;
      }
      const newSeed = generateRandomSeed();
      commitSeed(newSeed);
      playTumblerAnimation(seedWidget.value);
    });
  }

  // ---------------------------------------------------------
  // Event: Copy Seed to Clipboard
  // ---------------------------------------------------------
  if (copyBtn) {
    copyBtn.addEventListener("click", async () => {
      const val = String(seedWidget?.value ?? seedInput?.value ?? "0");
      try {
        await navigator.clipboard.writeText(val);
        if (disposed) return;
        if (copyResetTimer != null) { clearTimeout(copyResetTimer); timers.delete(copyResetTimer); }
        copyBtn.innerHTML = svgIcon("check", 12);
        copyBtn.classList.add("active");
        copyBtn.title = "Seed copied to clipboard!";
        copyResetTimer = later(() => {
          copyResetTimer = null;
          copyBtn.innerHTML = originalCopyHtml;
          copyBtn.classList.remove("active");
          copyBtn.title = "Copy seed to clipboard";
        }, 1400);
      } catch (err) {
        if (disposed) return;
        stopTumbler();
        if (seedInput) seedInput.value = val;
        seedInput?.select();
        document.execCommand("copy");
      }
    });
  }

  // ---------------------------------------------------------
  // Seed Lab & Fortune Hub Popover
  // ---------------------------------------------------------
  function openHub(tab = "fortune") {
    if (disposed) return;
    // The Seed Lab replaces the compact panel rather than stacking on top of it.
    closePanel();
    activeHubTab = tab;
    if (hubPopover) {
      hubPopover.hidden = false;
      hubPopover.removeAttribute("inert");
      copyPromptPaletteThemeScope(root, portal);
      document.body.append(portal);
      portal.append(hubPopover);
      renderHubContent();
      positionHub();
      hubHead?.focus({ preventScroll: true });
    }
  }

  function closeHub({ restoreFocus: allowFocus = true } = {}) {
    const restoreFocus = allowFocus && hubPopover?.contains(document.activeElement);
    stopWheel();
    if (hubPopover) {
      hubPopover.hidden = true;
      hubPopover.setAttribute("inert", "true");
      hubHome?.append(hubPopover);
      portal.remove();
      if (restoreFocus && !disposed) (isPanelOpen() ? menuBtn : panelBtn || menuBtn)?.focus({ preventScroll: true });
    }
  }

  if (fortuneBadge) {
    fortuneBadge.addEventListener("click", () => {
      if (hubPopover && !hubPopover.hidden && activeHubTab === "fortune") {
        closeHub();
      } else {
        openHub("fortune");
      }
    });
  }

  if (openWheelBtn) {
    openWheelBtn.addEventListener("click", () => {
      if (hubPopover && !hubPopover.hidden && activeHubTab === "wheel") {
        closeHub();
      } else {
        openHub("wheel");
      }
    });
  }

  if (menuBtn) {
    menuBtn.addEventListener("click", () => {
      if (hubPopover && !hubPopover.hidden) {
        closeHub();
      } else {
        openHub("fortune");
      }
    });
  }

  if (closeHubBtn) {
    closeHubBtn.addEventListener("click", closeHub);
  }

  function handleDocumentPointerDown(e) {
    if (hubPopover && !hubPopover.hidden) {
      if (
        !hubPopover.contains(e.target) &&
        !fortuneBadge?.contains(e.target) &&
        !openWheelBtn?.contains(e.target) &&
        !menuBtn?.contains(e.target) &&
        !panelBtn?.contains(e.target)
      ) {
        closeHub();
      }
    }
  }
  document.addEventListener("pointerdown", handleDocumentPointerDown);

  function handlePopoverKeyDown(e) {
    if (e.key === "Escape" && hubPopover && !hubPopover.hidden) {
      closeHub();
      e.stopPropagation();
    }
  }
  seedbar.addEventListener("keydown", handlePopoverKeyDown);

  // ---------------------------------------------------------
  // Render Hub Content by Active Tab
  // ---------------------------------------------------------
  function seedBehavior() {
    const connected = node.inputs?.some(input => ["seed", "external_seed"].includes(input.name) && input.link != null);
    if (connected) return "Connected seed overrides this local value at execution.";
    const mode = controlWidget?.value || "fixed";
    const descriptions = {fixed:"Fixed: reuse this seed.", increment:"Increment: ComfyUI advances the seed after queueing.", decrement:"Decrement: ComfyUI reduces the seed after queueing.", randomize:"Randomize: ComfyUI chooses the next seed after queueing."};
    return (descriptions[mode] || String(mode)) + " This is the current widget value, not a record of the last generated image.";
  }

  function renderHubContent() {
    if (disposed || !hubBody) return;
    stopWheel();
    const currentSeed = seedWidget?.value ?? 0;
    const fortune = getSeedFortune(currentSeed);
    const isFav = isFavoriteSeed(currentSeed);

    hubBody.innerHTML = `
      <div class="wg-seed-current"><strong>Node seed: ${escapeHtml(String(currentSeed))}</strong><span>${escapeHtml(seedBehavior())}</span></div>
      <div class="wg-seed-hub-nav">
        <button type="button" class="wg-seed-hub-tab ${activeHubTab === "fortune" ? "active" : ""}" data-tab="fortune">
          ${svgIcon("sparkles", 12)} Identity
        </button>
        <button type="button" class="wg-seed-hub-tab ${activeHubTab === "wheel" ? "active" : ""}" data-tab="wheel">
          ${svgIcon("wheel", 12)} Wheel
        </button>
        <button type="button" class="wg-seed-hub-tab ${activeHubTab === "history" ? "active" : ""}" data-tab="history">
          ${svgIcon("history", 12)} Saved &amp; recent
        </button>
      </div>
      <div class="wg-seed-hub-tab-pane" data-pane="${activeHubTab}"></div>
    `;

    hubBody.querySelectorAll(".wg-seed-hub-tab").forEach(tabBtn => {
      tabBtn.addEventListener("click", () => {
        activeHubTab = tabBtn.dataset.tab;
        renderHubContent();
      });
    });

    const pane = hubBody.querySelector(`[data-pane="${activeHubTab}"]`);
    if (!pane) return;

    if (activeHubTab === "fortune") {
      renderFortunePane(pane, fortune, isFav);
    } else if (activeHubTab === "wheel") {
      renderWheelPane(pane);
    } else if (activeHubTab === "history") {
      renderHistoryPane(pane, currentSeed);
    }
    positionHub();
  }

  // Tab 1: Fortune & Meaning Card
  function renderFortunePane(pane, fortune, isFav) {
    pane.innerHTML = `
      <p class="wg-seed-empty-note">Stable nicknames and creative inspiration, not predictions of image quality. Reproduce a result with the same seed, prompt, model and settings.</p>
      <div class="wg-seed-fortune-card" style="--card-accent: ${fortune.accentColor};">
        <div class="wg-seed-fortune-card-head">
          <div class="wg-seed-card-badge">${escapeHtml(fortune.rarityBadge)}</div>
          <div class="wg-seed-card-resonance">Creative identity</div>
          <button type="button" class="wg-icon-btn wg-seed-fav-btn ${isFav ? "active" : ""}" data-act="toggleFav" title="${isFav ? "Remove from favorite seeds" : "Pin to favorite seeds"}">
            ${svgIcon(isFav ? "starFilled" : "star", 13)}
          </button>
        </div>
        <div class="wg-seed-card-title">
          <span class="wg-seed-card-symbol">${escapeHtml(fortune.symbol)}</span>
          <h3>${escapeHtml(fortune.archetype)}</h3>
        </div>
        <div class="wg-seed-card-omen">
          <span class="wg-seed-omen-quote">&ldquo;</span>
          ${escapeHtml(fortune.omen)}
          <span class="wg-seed-omen-quote">&rdquo;</span>
        </div>
        <div class="wg-seed-card-details">
          <div class="wg-seed-detail-item">
            <span>Current Seed</span>
            <strong class="wg-seed-num">${escapeHtml(String(fortune.seed))}</strong>
          </div>
          <div class="wg-seed-detail-item">
            <span>Numerology Root</span>
            <strong>${escapeHtml(String(fortune.numerology))}</strong>
          </div>
          <div class="wg-seed-detail-item">
            <span>Theme Harmony</span>
            <strong style="color: ${fortune.accentColor};">Harmonized</strong>
          </div>
        </div>
      </div>

      <div class="wg-seed-hub-footer">
        <label class="wg-seed-toggle-opt">
          <input type="checkbox" data-act="toggleFortunesEnabled" ${theme?.seedFortuneEnabled !== false ? "checked" : ""}>
          <span>Show Seed Fortunes on toolbar</span>
        </label>
        <button type="button" class="wg-pill wg-seed-spin-trigger-btn" data-act="quickSpin">
          ${svgIcon("dice", 12)} Roll New Fortune
        </button>
      </div>
    `;

    pane.querySelector('[data-act="toggleFav"]')?.addEventListener("click", () => {
      toggleFavoriteSeed(fortune.seed);
      renderHubContent();
    });

    pane.querySelector('[data-act="toggleFortunesEnabled"]')?.addEventListener("change", e => {
      if (theme) {
        theme.seedFortuneEnabled = e.target.checked;
        saveTheme?.(theme);
        updateFortuneUI(seedWidget?.value ?? 0);
      }
    });

    pane.querySelector('[data-act="quickSpin"]')?.addEventListener("click", () => {
      const newSeed = generateRandomSeed();
      commitSeed(newSeed);
      playTumblerAnimation(seedWidget.value);
    });
  }

  // Tab 2: Interactive Wheel of Fortune Game
  function renderWheelPane(pane) {
    pane.innerHTML = `
      <div class="wg-seed-wheel-stage">
        <div class="wg-seed-wheel-pointer">${svgIcon("chevronDown", 16)}</div>
        <canvas class="wg-seed-wheel-canvas" width="220" height="220"></canvas>
        <button type="button" class="wg-seed-wheel-center-btn" data-act="spinWheelCenter">
          <span>SPIN</span>
        </button>
      </div>
      <div class="wg-seed-wheel-status" data-el="wheelStatus" role="status" aria-live="polite">
        Spin to discover a seed identity. Apply it only when you choose.
      </div>
      <div class="wg-seed-wheel-actions">
        <button type="button" class="wg-pill wg-pill-resolve wg-seed-big-spin-btn" data-act="spinWheelBtn">
          ${svgIcon("wheel", 14)} Spin the Wheel!
        </button>
      </div>
    `;

    const canvas = pane.querySelector(".wg-seed-wheel-canvas");
    const statusEl = pane.querySelector('[data-el="wheelStatus"]');
    const centerBtn = pane.querySelector('[data-act="spinWheelCenter"]');
    const spinBtnMain = pane.querySelector('[data-act="spinWheelBtn"]');
    const pointer = pane.querySelector(".wg-seed-wheel-pointer");
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const size = 280;
    const menuScale = parseFloat(getComputedStyle(portal).getPropertyValue("--wg-menu-scale")) || 1;
    const pixelRatio = Math.min(6, (window.devicePixelRatio || 1) * menuScale);
    canvas.width = canvas.height = size * pixelRatio;
    ctx.scale(pixelRatio, pixelRatio);
    const numSlices = 8;
    let candidates = Array.from({length:numSlices}, () => generateRandomSeed());
    const sliceAngle = (Math.PI * 2) / numSlices;
    let currentAngle = 0;
    let lastPegIndex = -1;

    function getThemeAccentHue() {
      try {
        const comp = getComputedStyle(seedbar);
        const raw = (comp.getPropertyValue("--wg-accent") || "#d49a52").trim();
        if (raw.startsWith("#")) {
          let hex = raw.slice(1);
          if (hex.length === 3) hex = hex.split("").map(c => c + c).join("");
          const r = parseInt(hex.slice(0, 2), 16) / 255;
          const g = parseInt(hex.slice(2, 4), 16) / 255;
          const b = parseInt(hex.slice(4, 6), 16) / 255;
          const max = Math.max(r, g, b), min = Math.min(r, g, b);
          let h = 0;
          if (max !== min) {
            const d = max - min;
            if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
            else if (max === g) h = (b - r) / d + 2;
            else h = (r - g) / d + 4;
            h *= 60;
          }
          return Math.round(h);
        }
      } catch (e) {}
      return 38;
    }

    const baseHue = getThemeAccentHue();
    const colors = Array.from({ length: numSlices }, (_, i) => {
      const h = (baseHue + i * 36) % 360;
      return `hsl(${h}, 70%, 46%)`;
    });

    function drawWheel(angle) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const cx = size / 2;
      const cy = size / 2;
      const radius = cx - 8;

      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(angle);

      // Draw slices
      for (let i = 0; i < numSlices; i++) {
        const start = i * sliceAngle;
        const end = start + sliceAngle;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, radius, start, end);
        ctx.closePath();
        ctx.fillStyle = colors[i % colors.length];
        ctx.fill();
        ctx.strokeStyle = "rgba(0,0,0,0.25)";
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // Pegs
        ctx.save();
        ctx.rotate(start);
        ctx.beginPath();
        ctx.arc(radius - 2, 0, 2.5, 0, Math.PI * 2);
        ctx.fillStyle = "#fff";
        ctx.shadowColor = "rgba(0,0,0,0.5)";
        ctx.shadowBlur = 3;
        ctx.fill();
        ctx.restore();

        // Label
        ctx.save();
        ctx.rotate(start + sliceAngle / 2);
        ctx.textAlign = "right";
        ctx.textBaseline = "middle";
        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 12px sans-serif";
        ctx.shadowColor = "rgba(0,0,0,0.8)";
        ctx.shadowBlur = 4;
        ctx.fillText(`${getSeedFortune(candidates[i]).symbol} …${String(candidates[i]).slice(-4)}`, radius - 16, 0);
        ctx.restore();
      }

      // Outer rim
      ctx.beginPath();
      ctx.arc(0, 0, radius, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(255,255,255,0.4)";
      ctx.lineWidth = 2.5;
      ctx.stroke();

      ctx.restore();
    }

    drawWheel(currentAngle);

    function triggerSpin() {
      if (disposed || isSpinningWheel) return;
      isSpinningWheel = true;
      if (spinBtnMain) spinBtnMain.disabled = true;
      if (centerBtn) centerBtn.disabled = true;

      candidates = Array.from({length:numSlices}, () => generateRandomSeed());
      const winner = Math.floor(Math.random() * numSlices);
      const targetSeed = candidates[winner];
      const fortune = getSeedFortune(targetSeed);
      if (statusEl) statusEl.textContent = "Spinning the wheel of fortune…";

      const tau = Math.PI * 2;
      const destination = ((-Math.PI / 2 - (winner + 0.5) * sliceAngle) % tau + tau) % tau;
      const finalAngle = 5 * tau + (destination - currentAngle % tau + tau) % tau;
      const duration = matchMedia("(prefers-reduced-motion: reduce)").matches ? 1 : 2600;
      const start = performance.now();
      const initialAngle = currentAngle;

      function step(now) {
        if (disposed || !isSpinningWheel) return;
        const t = Math.min(1, (now - start) / duration);
        const ease = 1 - Math.pow(1 - t, 3);
        currentAngle = initialAngle + finalAngle * ease;
        drawWheel(currentAngle);

        const currentPeg = Math.floor((currentAngle % (Math.PI * 2)) / sliceAngle);
        if (currentPeg !== lastPegIndex) {
          lastPegIndex = currentPeg;
          if (pointer) {
            pointer.style.transform = "translateX(-50%) rotate(14deg)";
            later(() => { if (pointer) pointer.style.transform = "translateX(-50%) rotate(0deg)"; }, 45);
          }
        }

        if (t < 1) {
          wheelFrame = requestAnimationFrame(step);
        } else {
          wheelFrame = null;
          isSpinningWheel = false;
          if (spinBtnMain) spinBtnMain.disabled = false;
          if (centerBtn) centerBtn.disabled = false;

          canvas.dataset.winner = String(winner);
          canvas.dataset.seed = String(targetSeed);

          if (statusEl) {
            statusEl.innerHTML = `
              <div class="wg-seed-wheel-win">
                <strong>🎉 Discovered seed ${escapeHtml(String(targetSeed))}!</strong>
                <span>${escapeHtml(fortune.archetype)} (${escapeHtml(fortune.rarityBadge)})</span>
                <button type="button" class="wg-pill" data-act="applyDiscovery">Use this seed</button>
                <button type="button" class="wg-pill" data-act="pinDiscovery">Pin discovery</button>
              </div>
            `;
            statusEl.querySelector('[data-act="applyDiscovery"]').onclick = () => { commitSeed(targetSeed); sync(); };
            statusEl.querySelector('[data-act="pinDiscovery"]').onclick = e => {
              if (!isFavoriteSeed(targetSeed)) toggleFavoriteSeed(targetSeed);
              e.currentTarget.textContent = "Pinned"; e.currentTarget.disabled = true;
            };
          }
        }
      }
      wheelFrame = requestAnimationFrame(step);
    }

    spinBtnMain?.addEventListener("click", triggerSpin);
    centerBtn?.addEventListener("click", triggerSpin);
  }

  // Tab 3: History & Presets Pane
  function renderHistoryPane(pane, currentSeed) {
    const history = getSeedHistory();
    const favorites = getFavoriteSeeds();

    pane.innerHTML = `
      <div class="wg-seed-history-section">
        <h4>Classic Seed Presets</h4>
        <div class="wg-seed-pills-grid">
          ${SEED_PRESETS.map(p => `
            <button type="button" class="wg-seed-preset-pill ${String(p.seed) === String(currentSeed) ? "active" : ""}" data-seed="${p.seed}" title="${escapeHtml(p.desc)}">
              <strong>${escapeHtml(p.label)}</strong>
            </button>
          `).join("")}
        </div>
      </div>

      <div class="wg-seed-history-section">
        <div class="wg-seed-section-head">
          <h4>Pinned Favorites (${favorites.length})</h4>
        </div>
        ${favorites.length === 0 ? `
          <div class="wg-seed-empty-note">No pinned seeds yet. Click the star on any seed to favorite it!</div>
        ` : `
          <div class="wg-seed-pills-grid">
            ${favorites.map(seedStr => {
              const fortune = getSeedFortune(seedStr);
              return `
                <div class="wg-seed-item-pill ${seedStr === String(currentSeed) ? "active" : ""}">
                  <button type="button" class="wg-seed-item-click" data-seed="${escapeHtml(seedStr)}">
                    <span>${escapeHtml(fortune.symbol)}</span>
                    <strong>${escapeHtml(seedStr)}</strong>
                    <small>${escapeHtml(fortune.archetype)}</small>
                  </button>
                  <button type="button" class="wg-seed-item-unfav" data-unfav="${escapeHtml(seedStr)}" title="Remove favorite">${svgIcon("close", 10)}</button>
                </div>
              `;
            }).join("")}
          </div>
        `}
      </div>

      <div class="wg-seed-history-section">
        <div class="wg-seed-section-head">
          <h4>Recent Seeds (${history.length})</h4>
        </div>
        ${history.length === 0 ? `
          <div class="wg-seed-empty-note">No recent seeds yet. Roll or type a seed to start history!</div>
        ` : `
          <div class="wg-seed-pills-grid">
            ${history.map(seedStr => {
              const fortune = getSeedFortune(seedStr);
              return `
                <button type="button" class="wg-seed-item-pill ${seedStr === String(currentSeed) ? "active" : ""}" data-seed="${escapeHtml(seedStr)}">
                  <span>${escapeHtml(fortune.symbol)}</span>
                  <strong>${escapeHtml(seedStr)}</strong>
                  <small>${escapeHtml(fortune.archetype)}</small>
                </button>
              `;
            }).join("")}
          </div>
        `}
      </div>
    `;

    pane.querySelectorAll("[data-seed]").forEach(btn => {
      btn.addEventListener("click", () => {
        const chosen = btn.dataset.seed;
        commitSeed(chosen);
      });
    });

    pane.querySelectorAll("[data-unfav]").forEach(btn => {
      btn.addEventListener("click", e => {
        e.stopPropagation();
        toggleFavoriteSeed(btn.dataset.unfav);
        renderHubContent();
      });
    });
  }

  // Initial Sync
  sync();

  return {
    sync,
    onRoll,
    dispose: () => {
      disposed = true;
      stopTumbler();
      stopWheel();
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      seedInput?.removeEventListener("blur", handleSeedInputBlur);
      document.removeEventListener("pointerdown", handleDocumentPointerDown);
      seedbar.removeEventListener("keydown", handlePopoverKeyDown);
      closeHub();
      closePanel();
      panelBtn?.removeEventListener("click", handlePanelButtonClick);
      document.removeEventListener("pointerdown", handlePanelDocumentPointerDown);
      seedbar.removeEventListener("keydown", handlePanelKeyDown);
      root.removeEventListener("pp-seed-panel-close", handleExternalPanelClose);
      panelPortal.remove();
      cleanupPanelKeyboard();
      window.removeEventListener("resize", resizeHub);
      portal.remove();
      cleanupKeyboard();
    },
  };
}
