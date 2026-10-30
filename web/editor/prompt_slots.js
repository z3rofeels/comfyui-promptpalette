export const PROMPT_SLOT_KEYS = ["A", "B", "C", "D"];
const SLOTS_PROP_KEY = "prompt_palette_slots_v1";

function cloneSlotWorkspace(ws) {
  if (!ws || typeof ws !== "object") return null;
  try {
    return JSON.parse(JSON.stringify(ws));
  } catch (_err) {
    return null;
  }
}

function emptySlotRecord() {
  return { text: "", negative: "", workspace: null };
}

function normalizeSlotRecord(raw) {
  if (!raw || typeof raw !== "object") return emptySlotRecord();
  return {
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
  if (!text && !neg) return "Empty";
  const firstLine = (text || `[Neg] ${neg}`).replace(/\s+/g, " ").trim();
  const clipped = firstLine.length > 68 ? `${firstLine.slice(0, 67)}…` : firstLine;
  return clipped;
}

export function promptSlotsMarkup() {
  return `<div class="wg-slot-switcher" data-act="promptSlots" data-el="btnSlots" role="group" aria-label="Quick prompt slots A–D">${PROMPT_SLOT_KEYS.map(
    (key, idx) =>
      `<button type="button" class="wg-slot-btn${key === "A" ? " active" : ""}" data-slot="${key}" aria-pressed="${
        key === "A" ? "true" : "false"
      }" title="Slot ${key} — Click to switch · Alt+Click to copy current prompt into Slot ${key} (Alt+${
        idx + 1
      })"><span class="wg-slot-label">${key}</span><span class="wg-slot-dot" aria-hidden="true"></span></button>`
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

  const persistToNode = () => {
    if (!node) return;
    if (!node.properties || typeof node.properties !== "object") {
      node.properties = {};
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

  const refreshUI = () => {
    const buttons = root.querySelectorAll(".wg-slot-switcher [data-slot]");
    buttons.forEach((btn) => {
      const key = btn.getAttribute("data-slot");
      if (!PROMPT_SLOT_KEYS.includes(key)) return;
      const idx = PROMPT_SLOT_KEYS.indexOf(key);
      const isActive = key === state.active;
      const slot = state.slots[key] || emptySlotRecord();
      const hasContent = Boolean(String(slot.text || "").trim() || String(slot.negative || "").trim());
      btn.classList.toggle("active", isActive);
      btn.classList.toggle("has-content", hasContent);
      btn.setAttribute("aria-pressed", isActive ? "true" : "false");
      const summary = summarizeSlotPreview(slot);
      const statusLabel = isActive ? "Active" : hasContent ? "Saved" : "Empty";
      btn.title = `Slot ${key} (${statusLabel}): ${summary}\nClick to switch · Alt+Click to duplicate current prompt into Slot ${key} · Alt+${idx + 1}`;
    });
  };

  const syncActiveSlot = () => {
    if (isSwitching) return;
    const activeKey = state.active;
    state.slots[activeKey] = {
      text: String(textarea.value ?? ""),
      negative: String(getNegative() ?? ""),
      workspace: typeof getWorkspace === "function" ? cloneSlotWorkspace(getWorkspace()) : state.slots[activeKey]?.workspace || null,
    };
    persistToNode();
    refreshUI();
  };

  const applySlotToEditor = (targetKey, { duplicated = false } = {}) => {
    const slot = normalizeSlotRecord(state.slots[targetKey]);
    isSwitching = true;
    try {
      state.active = targetKey;
      textarea.value = slot.text;
      setNegative(slot.negative);
      if (typeof setWorkspace === "function" && slot.workspace) {
        setWorkspace(cloneSlotWorkspace(slot.workspace));
      }
      persistToNode();
      refreshUI();
    } finally {
      isSwitching = false;
    }
    onSlotSwitched(targetKey, slot, { duplicated });
  };

  const duplicateToSlot = (targetKey) => {
    if (!PROMPT_SLOT_KEYS.includes(targetKey)) return false;
    syncActiveSlot();
    const source = normalizeSlotRecord(state.slots[state.active]);
    state.slots[targetKey] = {
      text: source.text,
      negative: source.negative,
      workspace: cloneSlotWorkspace(source.workspace),
    };
    applySlotToEditor(targetKey, { duplicated: true });
    return true;
  };

  const switchSlot = (targetKey, { duplicate = false } = {}) => {
    if (!PROMPT_SLOT_KEYS.includes(targetKey)) return false;
    if (duplicate && targetKey !== state.active) {
      return duplicateToSlot(targetKey);
    }
    syncActiveSlot();
    if (targetKey === state.active) {
      refreshUI();
      return false;
    }
    applySlotToEditor(targetKey, { duplicated: false });
    return true;
  };

  const restoreState = (rawState, { applyActive = false } = {}) => {
    const currentText = String(textarea.value ?? "");
    const currentNegative = String(getNegative() ?? "");
    const currentWs = typeof getWorkspace === "function" ? getWorkspace() : null;
    state = normalizePromptSlotsState(rawState, currentText, currentNegative, currentWs);
    // Ensure the active slot mirrors the restored editor text if the slot was blank.
    const activeSlot = state.slots[state.active];
    if (!activeSlot.text && currentText) {
      activeSlot.text = currentText;
    }
    if (!activeSlot.negative && currentNegative) {
      activeSlot.negative = currentNegative;
    }
    if (applyActive) {
      applySlotToEditor(state.active, { duplicated: false });
    } else {
      persistToNode();
      refreshUI();
    }
  };

  root.querySelectorAll(".wg-slot-switcher [data-slot]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const key = btn.getAttribute("data-slot");
      const duplicate = Boolean(e.altKey || e.shiftKey);
      switchSlot(key, { duplicate });
    });
  });

  textarea.addEventListener("input", () => syncActiveSlot());
  textarea.addEventListener("change", () => syncActiveSlot());

  root.addEventListener("keydown", (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    const digitMatch = /^(?:Digit|Numpad)([1-4])$/.exec(e.code || "") || /^([1-4])$/.exec(e.key || "");
    if (!digitMatch) return;
    const slotIdx = Number(digitMatch[1]) - 1;
    const targetKey = PROMPT_SLOT_KEYS[slotIdx];
    if (!targetKey) return;
    e.preventDefault();
    e.stopPropagation();
    switchSlot(targetKey, { duplicate: Boolean(e.shiftKey) });
  });

  if (node) {
    const prevSerialize = node.onSerialize;
    node.onSerialize = function (serialized) {
      syncActiveSlot();
      const r = prevSerialize ? prevSerialize.apply(this, arguments) : undefined;
      if (serialized && typeof serialized === "object") {
        serialized.properties = serialized.properties || {};
        serialized.properties[SLOTS_PROP_KEY] = node.properties[SLOTS_PROP_KEY];
      }
      return r;
    };

    const prevConfigure = node.onConfigure;
    node.onConfigure = function (info) {
      const r = prevConfigure ? prevConfigure.apply(this, arguments) : undefined;
      const savedSlots = info?.properties?.[SLOTS_PROP_KEY] || this.properties?.[SLOTS_PROP_KEY];
      if (savedSlots) {
        restoreState(savedSlots, { applyActive: false });
      } else {
        syncActiveSlot();
      }
      return r;
    };
  }

  persistToNode();
  refreshUI();

  return {
    switchSlot,
    duplicateToSlot,
    syncActiveSlot,
    refreshUI,
    getState: () => JSON.parse(JSON.stringify(state)),
    restoreState,
  };
}

