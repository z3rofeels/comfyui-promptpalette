import { WORKSPACE_KEY } from "./recipe_workspace_model.js";

export const PROMPT_SLOT_KEYS = ["A", "B", "C", "D"];
const SLOTS_PROP_KEY = "prompt_palette_slots_v1";
let detailsId = 0;
const slotName = value => typeof value === "string" ? [...value.replace(/[\s\u0000-\u001f\u007f]+/gu, " ").trim()].slice(0, 60).join("") : "";

function cloneSlotWorkspace(ws) {
  if (!ws || typeof ws !== "object") return null;
  try {
    return JSON.parse(JSON.stringify(ws));
  } catch (_err) {
    return null;
  }
}

function emptySlotRecord() {
  return { name: "", text: "", negative: "", workspace: null };
}

function normalizeSlotRecord(raw) {
  if (!raw || typeof raw !== "object") return emptySlotRecord();
  return {
    name: slotName(raw.name),
    text: typeof raw.text === "string" ? raw.text : "",
    negative: typeof raw.negative === "string" ? raw.negative : "",
    workspace: cloneSlotWorkspace(raw.workspace),
  };
}

export function normalizePromptSlotsState(raw, fallbackText = "", fallbackNegative = "", fallbackWorkspace = null) {
  const active = PROMPT_SLOT_KEYS.includes(raw?.active) ? raw.active : "A";
  const rawSlots = raw && typeof raw.slots === "object" && raw.slots ? raw.slots : {};
  const slots = {};
  for (const key of PROMPT_SLOT_KEYS) {
    slots[key] = normalizeSlotRecord(rawSlots[key]);
  }
  if (!raw || typeof raw !== "object") {
    slots[active] = {
      name: "",
      text: typeof fallbackText === "string" ? fallbackText : "",
      negative: typeof fallbackNegative === "string" ? fallbackNegative : "",
      workspace: cloneSlotWorkspace(fallbackWorkspace),
    };
  }
  return {
    version: 1,
    active,
    slots,
  };
}

function summarizeSlotPreview(slot) {
  const text = String(slot?.text || "").trim();
  const neg = String(slot?.negative || "").trim();
  if (!text && !neg) return slot?.workspace ? "Fields workspace" : "Empty";
  const firstLine = (text || `[Neg] ${neg}`).replace(/\s+/g, " ").trim();
  const clipped = firstLine.length > 68 ? `${firstLine.slice(0, 67)}…` : firstLine;
  return clipped;
}

export function promptSlotsMarkup() {
  return `<div class="wg-slot-switcher" data-act="promptSlots" data-el="btnSlots" role="group" aria-label="Prompt drafts A–D">${PROMPT_SLOT_KEYS.map(
    (key, idx) =>
      `<button type="button" class="wg-slot-btn${key === "A" ? " active" : ""}" data-slot="${key}" aria-pressed="${
        key === "A" ? "true" : "false"
      }" title="Slot ${key} — Click to switch · Alt+Click to copy current prompt into Slot ${key} (Alt+${
        idx + 1
      }) · Right-click for slot details"><span class="wg-slot-label">${key}</span><span class="wg-slot-dot" aria-hidden="true"></span></button>`
  ).join("")}</div>`;
}

export function installPromptSlots({
  node,
  root,
  textarea,
  getNegative = () => "",
  setNegative = () => {},
  getWorkspace = null,
  setWorkspace = null,
  onSlotSwitched = () => {},
} = {}) {
  if (!root || !textarea) {
    return {
      switchSlot: () => false,
      duplicateToSlot: () => false,
      syncActiveSlot: () => {},
      refreshUI: () => {},
      getState: () => normalizePromptSlotsState(null),
      restoreState: () => {},
      openDetails: () => false,
      cleanup: () => {},
    };
  }

  if (node && (!node.properties || typeof node.properties !== "object")) {
    node.properties = {};
  }

  let state = normalizePromptSlotsState(
    node?.properties?.[SLOTS_PROP_KEY],
    textarea.value || "",
    getNegative() || "",
    typeof getWorkspace === "function" ? getWorkspace() : null
  );

  let isSwitching = false;
  let disposed = false;
  let inspectedKey = null;
  let pendingCopy = null;
  const listeners = [];
  const listen = (element, type, fn, options) => {
    element.addEventListener(type, fn, options);
    listeners.push(() => element.removeEventListener(type, fn, options));
  };
  // Details use the same four records as the toolbar. No stash, history, or
  // additional draft store: this surface only reviews and edits those records.
  const panel = document.createElement("section");
  panel.className = "wg-slot-details";
  panel.id = `pp-slot-details-${++detailsId}`;
  panel.hidden = true;
  panel.setAttribute("role", "region");
  panel.setAttribute("aria-label", "Quick slot details");
  panel.innerHTML = `<div class="wg-slot-details-head"><strong data-slot-heading></strong><button type="button" data-slot-close aria-label="Close slot details">×</button></div>
    <div class="wg-slot-name-row"><label>Name<input data-slot-name aria-label="Slot name" maxlength="120" placeholder="Optional draft name" autocomplete="off"></label><button type="button" data-slot-save-name>Save name</button></div>
    <div data-slot-summary></div>
    <details><summary>Prompt preview</summary><div data-slot-preview></div></details>
    <div class="wg-slot-details-actions"><button type="button" data-slot-switch></button><button type="button" data-slot-copy></button></div>
    <div data-slot-review hidden><p data-slot-review-note></p><div class="wg-slot-copy-preview" data-slot-copy-preview></div><div class="wg-slot-details-actions"><button type="button" data-slot-confirm></button><button type="button" data-slot-cancel>Cancel</button></div></div>
    <div data-slot-feedback role="status" aria-live="polite"></div>`;
  const toolbar = root.querySelector(".wg-toolbar") || root.firstElementChild;
  if (toolbar) toolbar.after(panel); else root.prepend(panel);
  const part = name => panel.querySelector(`[data-slot-${name}]`);
  const hasContent = slot => Boolean(slot?.text?.trim() || slot?.negative?.trim() || slot?.workspace);
  const titleFor = key => `Slot ${key}${state.slots[key]?.name ? ` · ${state.slots[key].name}` : ""}`;
  const workspaceSummary = slot => {
    const fields = slot.workspace?.recipe?.fields;
    return Array.isArray(fields) ? `${fields.length} Fields workspace field${fields.length === 1 ? "" : "s"}` : slot.workspace ? "Fields workspace" : "Plain prompt";
  };
  const preview = (host, slot, label = "") => {
    host.replaceChildren();
    if (label) { const heading = document.createElement("strong"); heading.textContent = label; host.append(heading); }
    for (const [name, value] of [["Positive", slot.text], ["Negative", slot.negative]]) {
      const heading = document.createElement("span"), text = document.createElement("pre");
      heading.textContent = name; text.textContent = value || "(empty)"; host.append(heading, text);
    }
    const fields = document.createElement("small"); fields.textContent = workspaceSummary(slot); host.append(fields);
  };
  const cancelCopy = () => { pendingCopy = null; part("review").hidden = true; };
  const refreshDetails = () => {
    if (!inspectedKey || panel.hidden) return;
    const slot = state.slots[inspectedKey];
    part("heading").textContent = titleFor(inspectedKey);
    part("summary").textContent = `${inspectedKey === state.active ? "Active · edits save automatically" : hasContent(slot) ? "Saved · replacing requires review" : "Empty · switch to start a draft"} · ${workspaceSummary(slot)}`;
    preview(part("preview"), slot);
    part("switch").textContent = `Switch to ${inspectedKey}`;
    part("switch").disabled = inspectedKey === state.active;
    part("copy").textContent = `Copy ${state.active} into ${inspectedKey}…`;
    part("copy").disabled = inspectedKey === state.active;
  };
  const closeDetails = ({ focus = false } = {}) => {
    const key = inspectedKey;
    panel.hidden = true; inspectedKey = null; cancelCopy(); refreshUI();
    if (focus && key) root.querySelector(`.wg-slot-switcher [data-slot="${key}"]`)?.focus({ preventScroll: true });
  };
  const openDetails = (key, { focus = true } = {}) => {
    if (!PROMPT_SLOT_KEYS.includes(key) || disposed) return false;
    syncActiveSlot(); inspectedKey = key; panel.hidden = false; panel.scrollTop = 0; cancelCopy();
    part("name").value = state.slots[key].name;
    part("feedback").textContent = "";
    refreshUI(); refreshDetails();
    if (focus) part("name").focus({ preventScroll: true });
    return true;
  };

  const UNSET_WS = Symbol();
  let lastSyncedWsVersion = undefined;
  let lastSyncedWsExists = undefined;
  let lastSyncedRawWs = UNSET_WS;
  const persistToNode = (onlyKey = null, { wsUnchanged = false } = {}) => {
    if (!node) return;
    if (!node.properties || typeof node.properties !== "object") {
      node.properties = {};
    }
    const existing = node.properties[SLOTS_PROP_KEY];
    if (onlyKey && existing?.version === 1 && existing.slots && typeof existing.slots === "object") {
      existing.active = state.active;
      const cur = state.slots[onlyKey];
      const prev = existing.slots[onlyKey];
      existing.slots[onlyKey] = (wsUnchanged && prev && typeof prev === "object")
        ? {
            name: slotName(cur?.name),
            text: typeof cur?.text === "string" ? cur.text : "",
            negative: typeof cur?.negative === "string" ? cur.negative : "",
            workspace: prev.workspace ?? null,
          }
        : normalizeSlotRecord(cur);
      return;
    }
    node.properties[SLOTS_PROP_KEY] = {
      version: 1,
      active: state.active,
      slots: {
        A: normalizeSlotRecord(state.slots.A),
        B: normalizeSlotRecord(state.slots.B),
        C: normalizeSlotRecord(state.slots.C),
        D: normalizeSlotRecord(state.slots.D),
      },
    };
  };

  const buttonRenderCache = new Map();
  const refreshUI = () => {
    const refining = !!node?._ppHistoryRefinement?.isRefining();
    const buttons = root.querySelectorAll(".wg-slot-switcher [data-slot]");
    buttons.forEach((btn) => {
      const key = btn.getAttribute("data-slot");
      if (!PROMPT_SLOT_KEYS.includes(key)) return;
      const idx = PROMPT_SLOT_KEYS.indexOf(key);
      const isActive = key === state.active;
      const slot = state.slots[key] || emptySlotRecord();
      const filled = hasContent(slot);
      const expanded = !panel.hidden && inspectedKey === key;
      const summary = summarizeSlotPreview(slot);
      const slotTitle = titleFor(key);
      const prev = buttonRenderCache.get(btn);
      if (
        prev
        && prev.isActive === isActive
        && prev.filled === filled
        && prev.expanded === expanded
        && prev.refining === refining
        && prev.summary === summary
        && prev.slotTitle === slotTitle
      ) return;
      buttonRenderCache.set(btn, { isActive, filled, expanded, refining, summary, slotTitle });
      btn.classList.toggle("active", isActive);
      btn.classList.toggle("has-content", filled);
      btn.setAttribute("aria-pressed", isActive ? "true" : "false");
      btn.setAttribute("aria-expanded", String(expanded));
      btn.setAttribute("aria-controls", panel.id);
      const statusLabel = isActive ? "Active" : filled ? "Saved" : "Empty";
      btn.setAttribute("aria-label", `${slotTitle} (${statusLabel})`);
      btn.setAttribute("aria-description", "Enter to switch or inspect the active draft. Down arrow opens details. Left and right arrows move between drafts. Copying over a saved draft requires review.");
      btn.title = `${slotTitle} (${statusLabel}): ${summary}\n${isActive ? "Click for draft details" : "Click to switch"} · ↓ / Right-click for details · Alt+Click to copy here (review before replacing) · Alt+${idx + 1}`;
      if (refining) {
        btn.title = "Finish refinement with Commit or Cancel before switching drafts. Other saved drafts are preserved.";
        btn.setAttribute("aria-description", btn.title);
      }
    });
  };

  const syncActiveSlot = () => {
    if (isSwitching || disposed) return;
    const activeKey = state.active;
    const nextText = String(textarea.value ?? "");
    const nextNegative = String(getNegative() ?? "");
    const wsVersion = node?._ppWorkspaceVersion;
    const curSlot = state.slots[activeKey];
    const hasWorkspaceGetter = typeof getWorkspace === "function";
    const rawWorkspace = hasWorkspaceGetter ? node?.properties?.[WORKSPACE_KEY] : undefined;
    const wsUnchanged = !hasWorkspaceGetter
      || (
        wsVersion !== undefined
          ? wsVersion === lastSyncedWsVersion && rawWorkspace === lastSyncedRawWs
          : (
            rawWorkspace !== undefined
              ? rawWorkspace === lastSyncedRawWs
              : (!curSlot?.workspace && lastSyncedWsExists === false && lastSyncedRawWs === undefined)
          )
      );
    if (
      curSlot
      && curSlot.text === nextText
      && curSlot.negative === nextNegative
      && wsUnchanged
    ) {
      return;
    }
    const workspaceSnapshot = !hasWorkspaceGetter
      ? (curSlot?.workspace || null)
      : (wsUnchanged && curSlot
          ? curSlot.workspace
          : (rawWorkspace !== undefined ? cloneSlotWorkspace(rawWorkspace) : cloneSlotWorkspace(getWorkspace())));
    lastSyncedWsVersion = wsVersion;
    lastSyncedWsExists = !!workspaceSnapshot;
    lastSyncedRawWs = rawWorkspace;
    state.slots[activeKey] = {
      name: curSlot?.name || "",
      text: nextText,
      negative: nextNegative,
      workspace: workspaceSnapshot,
    };
    persistToNode(activeKey, { wsUnchanged });
    refreshUI();
    refreshDetails();
  };

  const applySlotToEditor = (targetKey, { duplicated = false } = {}) => {
    const slot = normalizeSlotRecord(state.slots[targetKey]);
    isSwitching = true;
    try {
      state.active = targetKey;
      lastSyncedWsVersion = undefined;
      lastSyncedWsExists = undefined;
      lastSyncedRawWs = UNSET_WS;
      textarea.value = slot.text;
      setNegative(slot.negative);
      if (typeof setWorkspace === "function") {
        setWorkspace(cloneSlotWorkspace(slot.workspace));
      }
      persistToNode();
      refreshUI();
    } finally {
      isSwitching = false;
    }
    onSlotSwitched(targetKey, slot, { duplicated });
  };

  const commitCopy = (targetKey, source) => {
    state.slots[targetKey] = {
      name: state.slots[targetKey]?.name || "",
      text: source.text,
      negative: source.negative,
      workspace: cloneSlotWorkspace(source.workspace),
    };
    closeDetails();
    applySlotToEditor(targetKey, { duplicated: true });
    textarea.focus({ preventScroll: true });
  };

  const duplicateToSlot = (targetKey) => {
    if (node?._ppHistoryRefinement?.isRefining()) return false;
    if (!PROMPT_SLOT_KEYS.includes(targetKey) || targetKey === state.active || disposed) return false;
    syncActiveSlot();
    const source = normalizeSlotRecord(state.slots[state.active]);
    if (hasContent(state.slots[targetKey])) {
      const sourceKey = state.active;
      openDetails(targetKey, { focus: false });
      pendingCopy = { sourceKey, targetKey, source: JSON.stringify(source), target: JSON.stringify(state.slots[targetKey]) };
      part("review-note").textContent = `Replace ${titleFor(targetKey)} with ${titleFor(sourceKey)}? Review both drafts. The name of ${targetKey} is kept.`;
      const host = part("copy-preview"); host.replaceChildren();
      for (const [label, record] of [[`Current ${targetKey}`, state.slots[targetKey]], [`Copy from ${sourceKey}`, source]]) {
        const column = document.createElement("div"); preview(column, record, label); host.append(column);
      }
      part("confirm").textContent = `Replace ${targetKey} and switch`;
      part("review").hidden = false;
      // Scroll this panel only, leaving the graph and the editor in place.
      panel.scrollTop = panel.scrollHeight;
      part("cancel").focus({ preventScroll: true });
      return false;
    }
    commitCopy(targetKey, source);
    return true;
  };

  const switchSlot = (targetKey, { duplicate = false } = {}) => {
    if (node?._ppHistoryRefinement?.isRefining()) return false;
    if (!PROMPT_SLOT_KEYS.includes(targetKey) || disposed) return false;
    if (duplicate && targetKey !== state.active) {
      return duplicateToSlot(targetKey);
    }
    syncActiveSlot();
    if (targetKey === state.active) {
      refreshUI();
      return false;
    }
    const fromDetails = !panel.hidden;
    closeDetails();
    applySlotToEditor(targetKey, { duplicated: false });
    if (fromDetails) textarea.focus({ preventScroll: true });
    return true;
  };

  const restoreState = (rawState, { applyActive = false } = {}) => {
    if (disposed) return;
    closeDetails();
    const currentText = String(textarea.value ?? "");
    const currentNegative = String(getNegative() ?? "");
    const currentWs = typeof getWorkspace === "function" ? getWorkspace() : null;
    state = normalizePromptSlotsState(rawState, currentText, currentNegative, currentWs);
    // Ensure the active slot mirrors the restored editor text if the slot was blank.
    const activeSlot = state.slots[state.active];
    if (!applyActive && !activeSlot.text && currentText) {
      activeSlot.text = currentText;
    }
    if (!applyActive && !activeSlot.negative && currentNegative) {
      activeSlot.negative = currentNegative;
    }
    if (!applyActive && !activeSlot.workspace && currentWs) {
      activeSlot.workspace = cloneSlotWorkspace(currentWs);
    } else if (!applyActive && activeSlot.workspace && typeof setWorkspace === "function") {
      setWorkspace(cloneSlotWorkspace(activeSlot.workspace));
    }
    if (applyActive) {
      applySlotToEditor(state.active, { duplicated: false });
    } else {
      persistToNode();
      refreshUI();
    }
  };

  root.querySelectorAll(".wg-slot-switcher [data-slot]").forEach((btn) => {
    listen(btn, "click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const key = btn.getAttribute("data-slot");
      const duplicate = Boolean(e.altKey || e.shiftKey);
      if (!duplicate && key === state.active) {
        if (!panel.hidden && inspectedKey === key) closeDetails(); else openDetails(key);
        return;
      }
      switchSlot(key, { duplicate });
    });
    listen(btn, "contextmenu", e => { e.preventDefault(); e.stopPropagation(); openDetails(btn.dataset.slot); });
    listen(btn, "keydown", e => {
      if (e.isComposing || e.keyCode === 229) return;
      if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key) && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        e.preventDefault(); e.stopPropagation();
        const index = PROMPT_SLOT_KEYS.indexOf(btn.dataset.slot);
        const next = e.key === "Home" ? 0 : e.key === "End" ? 3 : (index + (e.key === "ArrowRight" ? 1 : 3)) % 4;
        root.querySelector(`.wg-slot-switcher [data-slot="${PROMPT_SLOT_KEYS[next]}"]`)?.focus({ preventScroll: true });
      }
      if (e.key === "ContextMenu" || e.shiftKey && e.key === "F10" || e.key === "ArrowDown" && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        e.preventDefault(); e.stopPropagation(); openDetails(btn.dataset.slot);
      }
    });
  });

  listen(textarea, "input", () => syncActiveSlot());
  listen(textarea, "change", () => syncActiveSlot());
  listen(root, "pp-prompt-slots-hide", () => closeDetails());
  listen(panel, "click", e => e.stopPropagation());
  listen(panel, "keydown", e => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeDetails({ focus: true }); }
  }, true);
  listen(part("close"), "click", () => closeDetails({ focus: true }));
  const saveName = () => {
    if (!inspectedKey) return;
    syncActiveSlot();
    state.slots[inspectedKey].name = slotName(part("name").value);
    part("name").value = state.slots[inspectedKey].name;
    cancelCopy(); persistToNode(); refreshUI(); refreshDetails();
    part("feedback").textContent = state.slots[inspectedKey].name ? "Slot name saved with this workflow." : "Slot name cleared.";
  };
  listen(part("save-name"), "click", saveName);
  listen(part("name"), "keydown", e => {
    if (e.key === "Enter" && !e.isComposing && e.keyCode !== 229 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault(); e.stopPropagation(); saveName();
    }
  });
  listen(part("switch"), "click", () => switchSlot(inspectedKey));
  listen(part("copy"), "click", () => duplicateToSlot(inspectedKey));
  listen(part("cancel"), "click", () => { cancelCopy(); part("copy").focus({ preventScroll: true }); });
  listen(part("confirm"), "click", () => {
    if (!pendingCopy) return;
    syncActiveSlot();
    const { sourceKey, targetKey, source, target } = pendingCopy;
    if (state.active !== sourceKey || JSON.stringify(state.slots[sourceKey]) !== source || JSON.stringify(state.slots[targetKey]) !== target) {
      cancelCopy(); refreshDetails();
      part("feedback").textContent = "A draft changed. Choose Copy again to review the latest text.";
      return;
    }
    commitCopy(targetKey, JSON.parse(source));
  });

  // The single-surface editor contains its own keyboard events. Capture only
  // the existing Alt+1–4 shortcuts before they reach that boundary.
  listen(root, "keydown", (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    const digitMatch = /^(?:Digit|Numpad)([1-4])$/.exec(e.code || "") || /^([1-4])$/.exec(e.key || "");
    if (!digitMatch) return;
    const slotIdx = Number(digitMatch[1]) - 1;
    const targetKey = PROMPT_SLOT_KEYS[slotIdx];
    if (!targetKey) return;
    e.preventDefault();
    e.stopPropagation();
    switchSlot(targetKey, { duplicate: Boolean(e.shiftKey) });
  }, true);

  let serializeHandler, configureHandler, prevSerialize, prevConfigure;
  if (node) {
    prevSerialize = node.onSerialize;
    serializeHandler = function (serialized) {
      if (!disposed) syncActiveSlot();
      const r = prevSerialize ? prevSerialize.apply(this, arguments) : undefined;
      if (!disposed && serialized && typeof serialized === "object") {
        serialized.properties = serialized.properties || {};
        serialized.properties[SLOTS_PROP_KEY] = node.properties[SLOTS_PROP_KEY];
      }
      return r;
    };
    node.onSerialize = serializeHandler;

    prevConfigure = node.onConfigure;
    configureHandler = function (info) {
      const r = prevConfigure ? prevConfigure.apply(this, arguments) : undefined;
      if (disposed) return r;
      const savedSlots = info?.properties?.[SLOTS_PROP_KEY] || this.properties?.[SLOTS_PROP_KEY];
      if (savedSlots) {
        restoreState(savedSlots, { applyActive: false });
      } else {
        syncActiveSlot();
      }
      return r;
    };
    node.onConfigure = configureHandler;
  }

  persistToNode();
  refreshUI();

  return {
    switchSlot,
    duplicateToSlot,
    syncActiveSlot,
    refreshUI,
    getState: () => JSON.parse(JSON.stringify(state)),
    // Reviewed history promotion writes an existing inactive record without
    // switching drafts or disturbing the active editor/undo transaction.
    promoteToSlot(targetKey, record, { expected, overwrite = false } = {}) {
      if (disposed || !PROMPT_SLOT_KEYS.includes(targetKey)) throw new Error("The target draft is unavailable.");
      if (node?._ppHistoryRefinement?.isRefining()) throw new Error("Commit or cancel the current refinement first.");
      syncActiveSlot();
      if (targetKey === state.active) throw new Error("The target draft became active. Review promotion in the editor again.");
      const target = state.slots[targetKey];
      if (JSON.stringify(target) !== expected) throw new Error("The target draft changed. Review promotion again.");
      if ((hasContent(target) || target.name) && !overwrite) throw new Error("Confirm replacement of the saved draft first.");
      state.slots[targetKey] = { ...normalizeSlotRecord(record), name: target.name };
      closeDetails(); persistToNode(); refreshUI();
      node?.setDirtyCanvas?.(true, true);
      return true;
    },
    restoreState,
    openDetails,
    cleanup: () => {
      if (disposed) return;
      syncActiveSlot(); disposed = true; pendingCopy = null;
      for (const remove of listeners) remove();
      panel.remove();
      for (const btn of root.querySelectorAll(".wg-slot-switcher [data-slot]")) { btn.removeAttribute("aria-controls"); btn.removeAttribute("aria-expanded"); }
      if (node?.onSerialize === serializeHandler) node.onSerialize = prevSerialize;
      if (node?.onConfigure === configureHandler) node.onConfigure = prevConfigure;
    },
  };
}

