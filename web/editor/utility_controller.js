import { readEditorPreference, writeEditorPreference } from "../prompt_palette_state.js";
import { scheduleDomWidgetRemeasure, scheduleNodeTimer } from "../prompt_palette_compat.js";
import { registerPromptPaletteSettingsDrawer } from "../prompt_palette_shared.js";
import { escapeHtml } from "./text_utils.js";
import { dialogConfirm, isDialogOpen } from "./dialogs.js";
import { notify } from "./notifications.js";

export function createUtilityController(ctx) {
  const {
    node, root, theme, state, ioRail,
    settingsPopup, stashPopup, stashList, historyList, stashTabs, stashPanels,
    doctorPopup, variationPopup, libraryManagerPopup, recipeBuilderPopup,
    pickerDrawer, libraryTabs, libraryPanels,
    doctorChip, btnVariations, libraryManagerBtn, libraryButton,
    historyStore, textarea,
    closeAllPowerPopups, closePickerDrawer, closeEditDrawer,
    syncPowerToolSettingsUI, renderCatPins, updateThemeJson, getThemeController,
    addHistorySnapshot,
  } = ctx;

  const settingsBtn = root.querySelector('[data-act="settings"]');
  const settingsTabs = Array.from(settingsPopup.querySelectorAll("[data-settings-tab]"));
  const settingsPanels = Array.from(settingsPopup.querySelectorAll("[data-settings-panel]"));
  const stashBtn = root.querySelector('[data-act="stash"]');
  const stashSaveBtn = root.querySelector('[data-act="stashSave"]');
  const STASH_LIMIT = 20;

  function saveStash(arr) {
    writeEditorPreference("stash", Array.isArray(arr) ? arr : []);
  }

  function activateSettingsTab(name) {
    const target = settingsPanels.some((panel) => panel.dataset.settingsPanel === name) ? name : "appearance";
    settingsTabs.forEach((tab) => {
      const active = tab.dataset.settingsTab === target;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
    });
    settingsPanels.forEach((panel) => {
      const active = panel.dataset.settingsPanel === target;
      panel.classList.toggle("active", active);
      panel.setAttribute("aria-hidden", String(!active));
    });
    if (target === "colors") renderCatPins();
    if (target === "power") syncPowerToolSettingsUI();
    if (target === "data") updateThemeJson();
    if (target === "guide") getThemeController()?.renderHelpResults?.();
  }
  settingsTabs.forEach((tab) => tab.addEventListener("click", () => activateSettingsTab(tab.dataset.settingsTab)));

  const popupIdBase = `prompt-palette-${String(node.id ?? "node")}`;
  settingsPopup.id = `${popupIdBase}-settings`;
  stashPopup.id = `${popupIdBase}-stash`;
  doctorPopup.id = `${popupIdBase}-doctor`;
  variationPopup.id = `${popupIdBase}-variations`;
  libraryManagerPopup.id = `${popupIdBase}-library-manager`;
  recipeBuilderPopup.id = `${popupIdBase}-recipe-builder`;
  pickerDrawer.id = `${popupIdBase}-library`;
  settingsBtn.setAttribute("aria-controls", settingsPopup.id);
  stashBtn.setAttribute("aria-controls", stashPopup.id);
  doctorChip.setAttribute("aria-controls", doctorPopup.id);
  btnVariations.setAttribute("aria-controls", variationPopup.id);
  libraryManagerBtn.setAttribute("aria-controls", libraryManagerPopup.id);
  libraryButton.setAttribute("aria-controls", pickerDrawer.id);
  libraryTabs.forEach((tab) => {
    const name = tab.dataset.libraryTab;
    const panel = libraryPanels.find((item) => item.dataset.libraryPanel === name);
    if (!panel) return;
    tab.id = `${pickerDrawer.id}-tab-${name}`;
    panel.id = `${pickerDrawer.id}-panel-${name}`;
    tab.setAttribute("aria-controls", panel.id);
    panel.setAttribute("aria-labelledby", tab.id);
  });

  let activeUtilityPopup = null;
  const settingsDrawer = registerPromptPaletteSettingsDrawer({
    popup: settingsPopup,
    trigger: settingsBtn,
    isBlocked: isDialogOpen,
  });

  function setUtilityPopupState(name, popup, button, open) {
    const wasOpen = popup.classList.contains("open");
    if (!open && !wasOpen && activeUtilityPopup !== name) return;
    if (open) {
      closeAllPowerPopups();
      closeSettings({ restoreFocus: false, reason: "local-utility" });
      if (activeUtilityPopup && activeUtilityPopup !== name) closeStash();
      popup.hidden = false;
      popup.removeAttribute("inert");
      popup.setAttribute("aria-hidden", "false");
      popup.classList.add("open");
      button.classList.add("active");
      button.setAttribute("aria-expanded", "true");
      activeUtilityPopup = name;
    } else {
      popup.classList.remove("open");
      popup.setAttribute("aria-hidden", "true");
      popup.setAttribute("inert", "");
      button.classList.remove("active");
      button.setAttribute("aria-expanded", "false");
      if (activeUtilityPopup === name) activeUtilityPopup = null;
    }
    scheduleDomWidgetRemeasure(node);
  }

  function openSettings() {
    ioRail.close();
    closeAllPowerPopups();
    closeStash();
    if (pickerDrawer.classList.contains("open")) closePickerDrawer();
    if (root.querySelector('[data-drawer="edit"]')?.classList.contains("open")) closeEditDrawer();
    settingsDrawer.open();
    activateSettingsTab(settingsPopup.dataset.activeTab || "appearance");
    updateThemeJson();
  }

  function closeSettings(options = {}) {
    const active = settingsTabs.find((tab) => tab.classList.contains("active"));
    if (active) settingsPopup.dataset.activeTab = active.dataset.settingsTab;
    settingsDrawer.close(options);
  }

  settingsBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    if (settingsDrawer.isOpen()) closeSettings();
    else openSettings();
  });
  settingsPopup.querySelector('[data-act="closeSettings"]').addEventListener("click", closeSettings);

  let activeStashTab = "drafts";
  {
    const savedTab = readEditorPreference("stashTab", "drafts");
    if (savedTab === "history" || savedTab === "drafts") activeStashTab = savedTab;
  }

  function activateStashTab(name, { focus = false } = {}) {
    const next = name === "history" ? "history" : "drafts";
    activeStashTab = next;
    writeEditorPreference("stashTab", next);
    stashTabs.forEach((tab) => {
      const selected = tab.dataset.stashTab === next;
      tab.classList.toggle("active", selected);
      tab.setAttribute("aria-selected", String(selected));
      if (selected && focus) tab.focus({ preventScroll: true });
    });
    stashPanels.forEach((panel) => {
      const selected = panel.dataset.stashPanel === next;
      panel.classList.toggle("active", selected);
      panel.hidden = !selected;
    });
    if (next === "history") renderHistoryList();
    else renderStashList();
  }
  stashTabs.forEach((tab) => tab.addEventListener("click", () => activateStashTab(tab.dataset.stashTab)));

  function openStash() {
    ioRail.close();
    closePickerDrawer();
    closeEditDrawer();
    setUtilityPopupState("stash", stashPopup, stashBtn, true);
    activateStashTab(activeStashTab);
  }

  function closeStash() {
    setUtilityPopupState("stash", stashPopup, stashBtn, false);
  }

  node._wgBeforeIoRailOpen = () => {
    closeAllPowerPopups();
    closeSettings();
    closeStash();
    closePickerDrawer();
    closeEditDrawer();
  };

  stashBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    if (activeUtilityPopup === "stash") closeStash();
    else openStash();
  });
  root.querySelector('[data-act="closeStash"]').addEventListener("click", closeStash);

  function formatStashTime(ts) {
    const diffMin = Math.round((Date.now() - ts) / 60000);
    if (diffMin < 1) return "just now";
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.round(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const date = new Date(ts);
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
      " " + date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }

  function renderHistoryList() {
    historyList.innerHTML = "";
    const entries = historyStore.list();
    if (!entries.length) {
      historyList.innerHTML = '<div class="wg-stash-empty">History appears automatically after you pause while editing or queue a prompt. Nothing leaves your browser.</div>';
      return;
    }
    entries.forEach((entry) => {
      const row = document.createElement("div");
      row.className = `wg-stash-item wg-history-item${entry.pinned ? " pinned" : ""}`;
      const source = String(entry.source ?? "");
      const resolved = String(entry.resolved ?? "");
      const preview = source.trim() || resolved.trim() || "(empty prompt)";
      row.innerHTML = `
        <div class="wg-history-kicker"><span>${escapeHtml(String(entry.reason || "Prompt checkpoint"))}</span>${resolved ? "<em>resolved result saved</em>" : ""}</div>
        <div class="wg-stash-item-preview">${escapeHtml(preview)}</div>
        <div class="wg-stash-item-meta">
          <span class="wg-stash-item-time">${formatStashTime(entry.savedAt)}</span>
          <div class="wg-stash-item-btns">
            <button type="button" data-act="load">Load</button>
            <button type="button" data-act="pin" class="${entry.pinned ? "active" : ""}" title="${entry.pinned ? "Unpin checkpoint" : "Pin checkpoint"}" aria-label="${entry.pinned ? "Unpin checkpoint" : "Pin checkpoint"}">★</button>
            <button type="button" data-act="copy">Copy</button>
            <button type="button" class="danger" data-act="del" title="Delete this history entry">&#10005;</button>
          </div>
        </div>`;
      row.querySelector('[data-act="load"]').addEventListener("click", () => {
        addHistorySnapshot({ reason: "Before history restore", force: true });
        textarea.value = source;
        state.lastHistorySource = source;
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
        textarea.focus();
        closeStash();
      });
      row.querySelector('[data-act="pin"]').addEventListener("click", () => {
        historyStore.togglePin(entry.id);
        renderHistoryList();
      });
      row.querySelector('[data-act="copy"]').addEventListener("click", async (event) => {
        try {
          await navigator.clipboard.writeText(source);
          const button = event.currentTarget;
          button.textContent = "Copied";
          scheduleNodeTimer(node, () => { if (button.isConnected) button.textContent = "Copy"; }, 1100);
        } catch {}
      });
      row.querySelector('[data-act="del"]').addEventListener("click", () => {
        historyStore.remove(entry.id);
        renderHistoryList();
      });
      historyList.appendChild(row);
    });
  }

  function renderStashList() {
    stashList.innerHTML = "";
    const stash = state.stash;
    if (!stash.length) {
      stashList.innerHTML = '<div class="wg-stash-empty">No saved drafts yet — hit "Save current prompt" any time you want a checkpoint to come back to later.</div>';
      return;
    }
    stash.forEach((entry) => {
      const row = document.createElement("div");
      row.className = "wg-stash-item";
      const preview = entry.text.trim() || "(empty prompt)";
      row.innerHTML = `
        <div class="wg-stash-item-preview">${escapeHtml(preview)}</div>
        <div class="wg-stash-item-meta">
          <span class="wg-stash-item-time">${formatStashTime(entry.savedAt)}</span>
          <div class="wg-stash-item-btns">
            <button type="button" data-act="load">Load</button>
            <button type="button" data-act="copy">Copy</button>
            <button type="button" class="danger" data-act="del" title="Delete this draft">&#10005;</button>
          </div>
        </div>`;
      row.querySelector('[data-act="load"]').addEventListener("click", () => {
        addHistorySnapshot({ reason: "Before draft restore", force: true });
        textarea.value = entry.text;
        state.lastHistorySource = entry.text;
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
        textarea.focus();
        closeStash();
      });
      row.querySelector('[data-act="copy"]').addEventListener("click", async (event) => {
        try {
          await navigator.clipboard.writeText(entry.text);
          const button = event.currentTarget;
          const previousText = button.textContent;
          button.textContent = "Copied";
          scheduleNodeTimer(node, () => { button.textContent = previousText; }, 1100);
        } catch {}
      });
      row.querySelector('[data-act="del"]').addEventListener("click", () => {
        state.stash = state.stash.filter((item) => item.id !== entry.id);
        saveStash(state.stash);
        renderStashList();
      });
      stashList.appendChild(row);
    });
  }

  stashSaveBtn.addEventListener("click", () => {
    const text = textarea.value;
    if (!text.trim()) {
      notify("warn", "Nothing to stash", "The prompt is empty.");
      return;
    }
    state.stash = [
      { id: `s${Date.now()}${Math.random().toString(36).slice(2, 7)}`, text, savedAt: Date.now() },
      ...state.stash,
    ].slice(0, STASH_LIMIT);
    saveStash(state.stash);
    if (theme.promptHistoryEnabled !== false) addHistorySnapshot({ reason: "Saved draft", pinned: true, force: true });
    renderStashList();
    notify("success", "Saved to stash", `${state.stash.length} draft${state.stash.length === 1 ? "" : "s"} on the shelf`);
  });

  root.querySelector('[data-act="historyClear"]').addEventListener("click", async () => {
    const ok = await dialogConfirm({
      title: "Clear prompt history",
      message: "Clear every unpinned automatic history entry? Pinned checkpoints stay.",
    });
    if (!ok) return;
    historyStore.clearUnpinned();
    renderHistoryList();
  });

  return {
    activateSettingsTab,
    openSettings,
    closeSettings,
    openStash,
    closeStash,
    renderHistoryList,
    renderStashList,
    cleanup() { settingsDrawer.unregister(); },
  };
}
