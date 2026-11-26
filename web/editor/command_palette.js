import {
  copyPromptPaletteThemeScope,
  installPromptPaletteKeyboardBoundary,
  onPromptPaletteAppearanceChanged,
  svgIcon,
} from "../prompt_palette_shared.js";
import { isComfyQueueShortcut } from "../editor_shortcuts.js";
import {
  getPowerToolPreferences,
  setPowerToolPreference,
  readQuicknessPreference,
  writeQuicknessPreference,
} from "../prompt_palette_state.js";
import { loadTheme, saveTheme } from "./preferences.js";
import { PROMPT_SLOT_KEYS } from "./prompt_slots.js";
import { openPromptHygieneModal } from "./prompt_hygiene.js";
import { openPromptTools } from "./prompt_tools_panel.js";
import { openLoraSidecar } from "./lora_sidecar.js";
import { openPromptPaletteSidebarTab } from "./main_sidebar.js";
import { shortcutHint } from "./context_menu.js";
import { trackDialog } from "./dialogs.js";
import { notify } from "./notifications.js";

const RECENT_COMMANDS_KEY = "command-palette-recent";
const MAX_RECENT_COMMANDS = 10;

const STARTER_PACK_SHORTCUTS = Object.freeze([
  ["universal", "Universal Starter Pack", "54 cross-model photography, design & illustration prompts"],
  ["krea-2", "Krea 2 Starter Pack", "50 flowing prose prompts tuned for Krea 2"],
  ["moss", "MOSS-Image Starter Pack", "30 Caption, Ordered Tags & Spatial JSON Layout prompts"],
  ["qwen-image", "Qwen Image Starter Pack", "Natural-language composition & typography starters"],
  ["z-image-turbo", "Z-Image Turbo Starter Pack", "Crisp photoreal & stylized starters"],
  ["sdxl", "SDXL Starter Pack", "Balanced tag & prose hybrid starters"],
  ["illustrious", "Illustrious Starter Pack", "Anime & character tag starters"],
  ["pony", "Pony Starter Pack", "Score-anchored stylized starters"],
  ["anima", "Anima Starter Pack", "@Artist & multi-character starters"],
  ["syntax", "Prompt Palette Syntax Pack", "Interactive wildcards, choices, variables & branches"],
]);

function readRecentCommandIds() {
  const saved = readQuicknessPreference(RECENT_COMMANDS_KEY, []);
  return Array.isArray(saved) ? saved.filter((x) => typeof x === "string") : [];
}

function recordRecentCommandId(id) {
  if (!id) return;
  const prev = readRecentCommandIds().filter((x) => x !== id);
  prev.unshift(id);
  writeQuicknessPreference(RECENT_COMMANDS_KEY, prev.slice(0, MAX_RECENT_COMMANDS));
}

export function scoreCommandMatch(query, command) {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return 1;
  const label = String(command?.label || "").toLowerCase();
  const detail = String(command?.detail || "").toLowerCase();
  const group = String(command?.group || "").toLowerCase();
  const keywords = String(command?.keywords || "").toLowerCase();
  const haystack = `${label} ${keywords} ${group} ${detail}`;

  if (label === q) return 1200;
  if (label.startsWith(q)) return 950 - Math.min(80, label.length);

  // Word initials / acronym matching (e.g. "fr" -> "Find & Replace", "lp" -> "LoraPal")
  const words = label
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[^a-z0-9]+/i)
    .filter(Boolean);
  const initials = words.map((w) => w[0].toLowerCase()).join("");
  if (initials.startsWith(q)) return 860;

  const tokens = q.split(/\s+/).filter(Boolean);
  let total = 0;
  for (const tok of tokens) {
    const labelWordHit = words.some((w) => w.toLowerCase().startsWith(tok));
    if (labelWordHit) {
      total += 320;
      continue;
    }
    const labelIdx = label.indexOf(tok);
    if (labelIdx >= 0) {
      total += 220 - Math.min(60, labelIdx);
      continue;
    }
    if (keywords.includes(tok)) {
      total += 160;
      continue;
    }
    if (group.includes(tok) || detail.includes(tok)) {
      total += 100;
      continue;
    }
    // Subsequence fuzzy match on label
    let qi = 0;
    let gaps = 0;
    for (let i = 0; i < label.length && qi < tok.length; i += 1) {
      if (label[i] === tok[qi]) qi += 1;
      else if (qi > 0) gaps += 1;
    }
    if (qi === tok.length && gaps <= 8) {
      total += Math.max(40, 120 - gaps * 10);
      continue;
    }
    return 0;
  }
  return total;
}

export function filterCommands(query, commands, recentIds = []) {
  const q = String(query ?? "").trim();
  const recentRank = new Map(recentIds.map((id, idx) => [id, MAX_RECENT_COMMANDS - idx]));
  const scored = [];
  for (const cmd of commands) {
    if (!cmd || cmd.hidden) continue;
    const base = scoreCommandMatch(q, cmd);
    if (base <= 0) continue;
    const recencyBoost = q ? (recentRank.get(cmd.id) || 0) * 6 : (recentRank.get(cmd.id) || 0) * 100;
    scored.push({ cmd, score: base + recencyBoost });
  }
  if (q) {
    scored.sort((a, b) => b.score - a.score || a.cmd.label.localeCompare(b.cmd.label));
  } else {
    scored.sort((a, b) => {
      const ar = recentRank.get(a.cmd.id) || 0;
      const br = recentRank.get(b.cmd.id) || 0;
      if (ar !== br) return br - ar;
      return 0;
    });
  }
  return scored.map((s) => s.cmd);
}

export function buildCommandPaletteItems(host = {}) {
  const {
    node,
    root,
    textarea,
    getActiveEditor,
    openFind,
    openStarterPacks,
    openLibrary,
    openEditEntry,
    openSettings,
    openStash,
    openDoctor,
    openVariations,
    openLibraryManager,
    toggleFieldsWorkspace,
    isFieldsActive,
    isCombinatorial = false,
  } = host;

  const activeEditor = () => getActiveEditor?.() || node?._ppRecipeWorkspace?.editingSurface?.() || textarea;
  const clickToolbar = (act) => root?.querySelector(`[data-act="${act}"]`)?.click();

  const items = [
    {
      id: "hygiene-tidy",
      group: "Prompt Hygiene",
      icon: "sparkles",
      label: "Tidy & Deduplicate Prompt…",
      detail: "Collapse extra commas, spacing, and duplicate tags with diff preview",
      keywords: "clean fix dedup duplicate comma hygiene format",
      run: () => openPromptHygieneModal(activeEditor(), { mode: "tidy" }),
    },
    {
      id: "hygiene-adapt",
      group: "Prompt Hygiene",
      icon: "bolt",
      label: "Adapt Prompt for Model…",
      detail: "Convert weights, BREAK, score_9, or underscores for FLUX, Krea 2, Qwen, SDXL, Booru, or Anima",
      keywords: "flux krea2 qwen wan z-image sdxl illustrious pony anima booru convert weights",
      run: () => openPromptHygieneModal(activeEditor(), { mode: "adapt" }),
    },
    {
      id: "inspect-prompt",
      group: "Prompt Hygiene",
      icon: "doctor",
      label: "Prompt Inspector · Token & Weight Breakdown",
      detail: "Per-field/clause token share, ±0.05 weight scrubbers, and LoRA/embedding pre-flight",
      keywords: "tokens chunks clip weights embeddings loras preflight scrub",
      run: () => openPromptTools(activeEditor(), { tab: "inspect" }),
    },
    {
      id: "prompt-doctor",
      group: "Prompt Hygiene",
      icon: "doctor",
      label: "Open Prompt Doctor",
      detail: "Check syntax, missing wildcards, missing embeddings/LoRAs, and duplicates",
      keywords: "lint validate health errors warnings",
      run: () => {
        if (!getPowerToolPreferences().promptDoctor) setPowerToolPreference("promptDoctor", true);
        openDoctor?.();
      },
    },
    {
      id: "preview-resolve",
      group: "Toolbar & Editor",
      icon: "bolt",
      label: "Toggle Resolved Preview",
      detail: "Preview wildcard-resolved text and exact CLIP-L token count",
      keywords: "resolve output preview edit",
      run: () => clickToolbar("resolve"),
    },
    {
      id: "find-replace",
      group: "Toolbar & Editor",
      icon: "search",
      label: "Find & Replace in Prompt",
      detail: "Search literal/whole-word matches and preview replacements",
      shortcut: "Ctrl+H",
      keywords: "search replace match",
      hidden: typeof openFind !== "function" && !node?._ppFindReplace,
      run: () => (openFind ? openFind({ replace: true }) : node?._ppFindReplace?.openFind?.({ replace: true })),
    },
    {
      id: "fields-workspace",
      group: "Toolbar & Editor",
      icon: "grid",
      label: isFieldsActive?.() ? "Switch to Plain Text Editor" : "Open Fields Workspace",
      detail: isFieldsActive?.()
        ? "Edit the compiled prompt in a single text surface"
        : "Organize prompt sections into modular, color-coded Fields cards",
      keywords: "fields workspace split cards sections modular",
      hidden: typeof toggleFieldsWorkspace !== "function",
      run: () => toggleFieldsWorkspace?.(),
    },
    {
      id: "lorapal",
      group: "Toolbar & Editor",
      icon: "layers",
      label: "Open LoraPal Sidecar",
      detail: "Browse local LoRAs, previews, trigger words, strengths, and Audition Lab",
      keywords: "lora sidecar stack weights triggers",
      run: () => openLoraSidecar(activeEditor()),
    },
    {
      id: "style-studio",
      group: "Toolbar & Editor",
      icon: "palette",
      label: "Open Style Studio (Krea 2 & MOSS)",
      detail: "Curated styles, cameras, lenses, angles, poses, lighting & mixes",
      keywords: "styles krea2 moss camera lens lighting pose mix",
      run: () => {
        const cur = loadTheme();
        if (!cur.styleSelectorEnabled) {
          saveTheme({ ...cur, styleSelectorEnabled: true });
        }
        import("./style_selector.js").then(({ openStyleSelector }) => openStyleSelector(activeEditor()));
      },
    },
    {
      id: "choices-rules",
      group: "Toolbar & Editor",
      icon: "recipe",
      label: "Build Choices & Rules…",
      detail: "Create interactive ${variable} choices and conditional outputs",
      keywords: "rules if switch variable conditional choices",
      run: () => openPromptTools(activeEditor(), { tab: "rules" }),
    },
    {
      id: "variation-lab",
      group: "Toolbar & Editor",
      icon: "branch",
      label: "Open Variation Lab",
      detail: "Compare 4–16 deterministic resolved versions across seeds before queueing",
      keywords: "variations compare seeds lab batch",
      run: () => {
        if (!getPowerToolPreferences().variationLab) setPowerToolPreference("variationLab", true);
        openVariations?.();
      },
    },
    {
      id: "refine-draft",
      group: "Toolbar & Editor",
      icon: "edit",
      label: "Refine Active Draft",
      detail: "Start a safe Commit / Cancel refinement pass on the current prompt",
      keywords: "refine evolve commit cancel draft",
      run: () => (node?._ppHistoryRefinement ? node._ppHistoryRefinement.start() : clickToolbar("refine")),
    },
    ...(!isCombinatorial
      ? [
          {
            id: "seed-lab",
            group: "Toolbar & Editor",
            icon: "wheel",
            label: "Open Seed Controls & Seed Lab",
            detail: "Inspect prompt seed, run mode, Seed Fortunes, presets & history",
            keywords: "seed fortune random lock increment",
            run: () => {
              const cur = loadTheme();
              if (!cur.showSeedControls) saveTheme({ ...cur, showSeedControls: true });
              queueMicrotask(() => clickToolbar("seedPanel"));
            },
          },
          {
            id: "wheel-of-fortune",
            group: "Toolbar & Editor",
            icon: "sparkles",
            label: "Spin Wheel of Fortune",
            detail: "Open interactive archetype Wheel of Fortune seed hunt",
            keywords: "wheel spin seed game fortune",
            run: () => {
              const cur = loadTheme();
              if (!cur.showSeedControls) saveTheme({ ...cur, showSeedControls: true });
              queueMicrotask(() => {
                clickToolbar("seedPanel");
                root?.querySelector('[data-act="seedOpenWheel"]')?.click();
              });
            },
          },
        ]
      : []),
    {
      id: "port-layouts",
      group: "Toolbar & Editor",
      icon: "io",
      label: "Ports & Saved Port Layouts",
      detail: "Toggle node inputs/outputs and apply or save named port layouts",
      keywords: "ports sockets inputs outputs layouts io",
      run: () => (node?._wgToggleIoRail ? node._wgToggleIoRail() : clickToolbar("ioRailToggle")),
    },
    {
      id: "import-image",
      group: "Toolbar & Editor",
      icon: "upload",
      label: "Import Prompt from Image…",
      detail: "Extract embedded prompts from PNG, JPEG, or WebP metadata",
      keywords: "import png exif a1111 comfy metadata image",
      hidden: !node?._ppOpenImageImport,
      run: () => node?._ppOpenImageImport?.(),
    },
    ...(!isCombinatorial && typeof openStash === "function"
      ? [
          {
            id: "prompt-stash",
            group: "Toolbar & Editor",
            icon: "stash",
            label: "Open Prompt Stash & History",
            detail: "Save local drafts or recover automatic prompt checkpoints",
            keywords: "stash drafts history recovery",
            run: () => openStash(),
          },
        ]
      : []),
    {
      id: "my-library",
      group: "Library & Starter Packs",
      icon: "gallery",
      label: "Open My Library",
      detail: "Browse personal wildcard files, thumbnails, and RECIPES",
      keywords: "library wildcards files personal",
      run: () => (openLibrary ? openLibrary() : clickToolbar("picker")),
    },
    {
      id: "edit-library-entry",
      group: "Library & Starter Packs",
      icon: "edit",
      label: "Create or Edit Library Entry",
      detail: "Open the inline My Library file editor",
      keywords: "new create wildcard txt save library",
      run: () => (openEditEntry ? openEditEntry() : clickToolbar("edit")),
    },
    {
      id: "library-manager",
      group: "Library & Starter Packs",
      icon: "folder",
      label: "Open Library Manager",
      detail: "Audit library health, rename, move, or bulk-manage entries",
      keywords: "audit broken duplicates orphan rename move",
      run: () => {
        if (!getPowerToolPreferences().libraryManager) setPowerToolPreference("libraryManager", true);
        openLibraryManager?.();
      },
    },
    ...(!isCombinatorial && typeof openStarterPacks === "function"
      ? [
          {
            id: "starter-packs-all",
            group: "Library & Starter Packs",
            icon: "sparkles",
            label: "Browse Starter Packs",
            detail: "Open built-in prompt templates across 12 model packs",
            keywords: "templates examples starter packs",
            run: () => openStarterPacks(""),
          },
          ...STARTER_PACK_SHORTCUTS.map(([packId, packLabel, packDesc]) => ({
            id: `starter-pack-${packId}`,
            group: "Starter Packs",
            icon: "sparkles",
            label: `Starter Pack: ${packLabel}`,
            detail: packDesc,
            keywords: `starter pack template ${packId} ${packLabel}`,
            run: () => openStarterPacks(packId),
          })),
        ]
      : []),
  ];

  // Quick Slots A–D
  const slotsCtrl = node?._ppPromptSlots;
  if (slotsCtrl) {
    const slotsState = slotsCtrl.getState?.();
    for (const [idx, key] of PROMPT_SLOT_KEYS.entries()) {
      const slotRec = slotsState?.slots?.[key];
      const isAct = slotsState?.active === key;
      const customName = slotRec?.name ? ` · ${slotRec.name}` : "";
      const snippet = String(slotRec?.text || "").trim().replace(/\s+/g, " ").slice(0, 54);
      items.push({
        id: `quick-slot-${key}`,
        group: "Quick Slots A–D",
        icon: "pin",
        label: `Switch to Slot ${key}${customName}${isAct ? " (Active)" : ""}`,
        detail: snippet || (slotRec?.workspace ? "Fields workspace draft" : "Empty draft slot"),
        shortcut: `Alt+${idx + 1}`,
        keywords: `slot ${key} draft quick switch ${slotRec?.name || ""}`,
        run: () => slotsCtrl.switchSlot(key),
      });
    }
    items.push({
      id: "quick-slot-details",
      group: "Quick Slots A–D",
      icon: "info",
      label: "Inspect / Rename Active Quick Slot",
      detail: "Open inline name editor and positive/negative preview for current slot",
      keywords: "slot rename details preview copy",
      run: () => slotsCtrl.openDetails(slotsState?.active || "A"),
    });
  }

  // Main ComfyUI Sidebar tabs
  for (const [tabKey, label, desc] of [
    ["library", "Sidebar: Library Tab", "Open My Library in the ComfyUI side panel"],
    ["generations", "Sidebar: Recent Generations Tab", "Inspect & compare local generation history"],
    ["loras", "Sidebar: LoRAs Tab", "Browse LoraPal in the ComfyUI side panel"],
    ["styles", "Sidebar: Explore Styles Tab", "Browse offline styles, artists & Booru tags"],
    ["syntax", "Sidebar: Syntax Workshop Tab", "Interactive wildcard & conditional syntax guide"],
    ["tools", "Sidebar: Tools Tab", "Quick node tool launcher in the sidebar"],
  ]) {
    items.push({
      id: `sidebar-tab-${tabKey}`,
      group: "Main Sidebar",
      icon: "jump",
      label,
      detail: desc,
      keywords: `sidebar panel ${tabKey}`,
      run: () => openPromptPaletteSidebarTab(tabKey),
    });
  }

  // Appearance & Settings
  if (!isCombinatorial) {
    items.push(
      {
        id: "toggle-day-night",
        group: "Appearance & Settings",
        icon: "moon",
        label: "Switch Day / Night Theme",
        detail: "Toggle between your configured Day and Night palettes",
        keywords: "theme dark light mode appearance",
        run: () => (typeof host.toggleDayNight === "function" ? host.toggleDayNight() : clickToolbar("dayNightToggle")),
      },
      {
        id: "toggle-zen",
        group: "Appearance & Settings",
        icon: "zen",
        label: "Toggle Zen Mode",
        detail: "Hide secondary chrome and focus on writing",
        keywords: "zen minimal focus distraction free",
        run: () => (typeof host.toggleZenMode === "function" ? host.toggleZenMode() : clickToolbar("zenToggle")),
      }
    );
  }
  items.push({
    id: "open-settings",
    group: "Appearance & Settings",
    icon: "settings",
    label: isCombinatorial ? "Open Combinatorial Settings" : "Open Prompt Palette Settings",
    detail: "Themes, toolbar layout, autocomplete, Fields & power tools",
    keywords: "preferences options config theme",
    run: () => (openSettings ? openSettings() : clickToolbar("settings")),
  });

  return items;
}

function make(tag, className = "", text = "") {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text) el.textContent = text;
  return el;
}

let activeCommandPalette = null;

export function closeCommandPalette() {
  if (!activeCommandPalette) return false;
  activeCommandPalette.close();
  return true;
}

export function openCommandPalette(hostContext = {}) {
  closeCommandPalette();
  const previousFocus = document.activeElement;
  const commands = buildCommandPaletteItems(hostContext);
  const recentIds = readRecentCommandIds();
  let filtered = filterCommands("", commands, recentIds);
  let activeIndex = 0;
  let closed = false;

  const dialog = make("dialog", "pp-prompt-tools pp-command-palette wg-root");
  dialog.dataset.promptPaletteGlobal = "true";
  dialog.setAttribute("aria-label", "Prompt Palette command palette");

  const scope = hostContext.root || previousFocus?.closest?.(".wg-root, .wg-node, .pp-node, .ppwc-surface");
  const syncTheme = () => {
    if (scope) {
      copyPromptPaletteThemeScope(scope, dialog);
      dialog.classList.toggle("wg-high-contrast", scope.classList.contains("wg-high-contrast"));
    }
  };
  syncTheme();

  const searchBar = make("div", "pp-cmd-search-bar");
  const searchIcon = make("span", "pp-cmd-search-icon");
  searchIcon.innerHTML = svgIcon("sparkles", 15);
  const input = make("input", "pp-cmd-input");
  input.type = "search";
  input.placeholder = "Type a command, tool, slot, sidebar tab, or starter pack…";
  input.setAttribute("aria-label", "Search Prompt Palette commands");
  input.autocomplete = "off";
  input.spellcheck = false;
  const escHint = make("kbd", "pp-cmd-kbd", "Esc");
  searchBar.append(searchIcon, input, escHint);

  const list = make("div", "pp-cmd-list");
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "Matching commands");

  const footer = make("div", "pp-cmd-footer");
  footer.innerHTML = `<span><kbd>↑↓</kbd> Navigate</span><span><kbd>Enter</kbd> Run</span><span><kbd>Esc</kbd> Clear / Close</span>`;

  dialog.append(searchBar, list, footer);
  document.body.append(dialog);

  const cleanupKeys = installPromptPaletteKeyboardBoundary(dialog);
  const cleanupTheme = onPromptPaletteAppearanceChanged(syncTheme);
  let releaseDialog = null;

  function syncActiveRow() {
    const rows = [...list.querySelectorAll(".pp-cmd-item")];
    rows.forEach((row, idx) => {
      const isAct = idx === activeIndex;
      row.classList.toggle("active", isAct);
      row.setAttribute("aria-selected", String(isAct));
    });
    rows[activeIndex]?.scrollIntoView?.({ block: "nearest" });
  }

  function executeCommand(cmd) {
    if (!cmd || closed) return;
    recordRecentCommandId(cmd.id);
    close({ restoreFocus: false });
    try {
      Promise.resolve(cmd.run()).catch((err) =>
        notify("error", "Command failed", err?.message || String(err))
      );
    } catch (err) {
      notify("error", "Command failed", err?.message || String(err));
    }
  }

  function renderList() {
    filtered = filterCommands(input.value, commands, recentIds);
    activeIndex = Math.max(0, Math.min(activeIndex, Math.max(0, filtered.length - 1)));
    list.replaceChildren();

    if (!filtered.length) {
      list.append(make("div", "pp-cmd-empty", "No matching Prompt Palette commands."));
      return;
    }

    const isSearching = input.value.trim().length > 0;
    let lastGroup = null;
    filtered.forEach((cmd, idx) => {
      const groupName = !isSearching && recentIds.includes(cmd.id) && idx < recentIds.length
        ? "Recent"
        : cmd.group || "Commands";
      if (groupName !== lastGroup) {
        lastGroup = groupName;
        const heading = make("div", "pp-cmd-group", groupName);
        heading.setAttribute("role", "presentation");
        list.append(heading);
      }

      const row = make("button", "pp-cmd-item");
      row.type = "button";
      row.setAttribute("role", "option");
      const iconSpan = make("span", "pp-cmd-item-icon");
      iconSpan.innerHTML = svgIcon(cmd.icon || "bolt", 14);
      const copyWrap = make("span", "pp-cmd-item-copy");
      copyWrap.append(
        make("strong", "pp-cmd-item-label", cmd.label),
        make("small", "pp-cmd-item-detail", cmd.detail || "")
      );
      row.append(iconSpan, copyWrap);
      if (cmd.shortcut) {
        row.append(make("kbd", "pp-cmd-kbd", shortcutHint(cmd.shortcut)));
      }
      row.addEventListener("mouseenter", () => {
        activeIndex = idx;
        syncActiveRow();
      });
      row.addEventListener("click", (e) => {
        e.preventDefault();
        executeCommand(cmd);
      });
      list.append(row);
    });
    syncActiveRow();
  }

  function close({ restoreFocus = true } = {}) {
    if (closed) return;
    closed = true;
    releaseDialog?.();
    cleanupKeys();
    cleanupTheme();
    dialog.close();
    dialog.remove();
    if (activeCommandPalette?.dialog === dialog) activeCommandPalette = null;
    if (restoreFocus && previousFocus?.isConnected && !previousFocus.closest?.("[inert]")) {
      previousFocus.focus?.({ preventScroll: true });
    }
  }

  input.addEventListener("input", () => {
    activeIndex = 0;
    renderList();
  });

  dialog.addEventListener("keydown", (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (isComfyQueueShortcut(e)) {
      close({ restoreFocus: true });
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (input.value) {
        input.value = "";
        activeIndex = 0;
        renderList();
        return;
      }
      close({ restoreFocus: true });
      return;
    }
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key) && filtered.length > 0) {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Home") activeIndex = 0;
      else if (e.key === "End") activeIndex = filtered.length - 1;
      else if (e.key === "ArrowDown") activeIndex = (activeIndex + 1) % filtered.length;
      else activeIndex = (activeIndex - 1 + filtered.length) % filtered.length;
      syncActiveRow();
    } else if (e.key === "Enter" && filtered[activeIndex]) {
      e.preventDefault();
      e.stopPropagation();
      executeCommand(filtered[activeIndex]);
    }
  });

  dialog.addEventListener("cancel", (e) => {
    e.preventDefault();
    close({ restoreFocus: true });
  });
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) {
      const r = dialog.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) {
        close({ restoreFocus: true });
      }
    }
  });

  releaseDialog = trackDialog(() => close({ restoreFocus: false }));
  activeCommandPalette = { dialog, close };
  renderList();
  dialog.showModal();
  input.focus({ preventScroll: true });
  return activeCommandPalette;
}

export function attachCommandPaletteShortcut(root, getHostContext) {
  if (!root) return () => {};
  // Attached strictly to Prompt Palette-owned root — never intercepts global unfocused Ctrl/Cmd+K.
  const onKeyDown = (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    if (isComfyQueueShortcut(event)) return;
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && String(event.key).toLowerCase() === "k") {
      event.preventDefault();
      event.stopPropagation();
      openCommandPalette(getHostContext?.() || { root });
    }
  };
  root.addEventListener("keydown", onKeyDown, true);
  return () => root.removeEventListener("keydown", onKeyDown, true);
}

export function emptyQuickStartMarkup({ starterLabel = "Starter Packs" } = {}) {
  const cmdHint = shortcutHint("Ctrl+K");
  return `<div class="wg-empty-quickstart" data-el="emptyQuickStart" hidden role="region" aria-label="Empty editor quick start">
    <div class="wg-empty-quickstart-chips">
      <button type="button" class="wg-quickstart-pill" data-quickstart="starter">${svgIcon("sparkles", 12)}<span>${starterLabel}</span></button>
      <button type="button" class="wg-quickstart-pill" data-quickstart="fields">${svgIcon("grid", 12)}<span>Fields Workspace</span></button>
      <button type="button" class="wg-quickstart-pill" data-quickstart="loras">${svgIcon("layers", 12)}<span>Browse LoRAs</span></button>
      <button type="button" class="wg-quickstart-pill" data-quickstart="import">${svgIcon("upload", 12)}<span>Import Image</span></button>
      <button type="button" class="wg-quickstart-pill wg-quickstart-cmd" data-quickstart="palette" title="Open Command Palette (${cmdHint})"><span>${cmdHint}</span></button>
    </div>
    <button type="button" class="wg-quickstart-dismiss" data-quickstart="dismiss" title="Hide empty-state quick-start chips (re-enable anytime in Settings → Editor)" aria-label="Dismiss quick start shortcuts">×</button>
  </div>`;
}

export function attachEmptyQuickStart({
  root,
  textarea,
  isWorkspaceActive = () => false,
  isPreviewActive = () => false,
  onStarter = null,
  onFields = null,
  onLoras = null,
  onImport = null,
  onCommandPalette = null,
  onThemeSaved = null,
} = {}) {
  const strip = root?.querySelector('[data-el="emptyQuickStart"]');
  if (!root || !textarea || !strip) {
    return { sync() {}, cleanup() {} };
  }

  let disposed = false;
  let focused = false;

  function sync() {
    if (disposed) return;
    const enabled = loadTheme().emptyQuickStartEnabled !== false;
    const isEmpty = (textarea.value || "").length === 0;
    const editable = !textarea.readOnly && !textarea.disabled && textarea.getAttribute("aria-readonly") !== "true";
    const visible =
      enabled &&
      editable &&
      isEmpty &&
      focused &&
      !isWorkspaceActive() &&
      !isPreviewActive();
    strip.hidden = !visible;
  }

  const onFocus = () => {
    focused = true;
    sync();
  };
  const onBlur = (e) => {
    if (e.relatedTarget && strip.contains(e.relatedTarget)) return;
    focused = false;
    sync();
  };
  const onStripFocusOut = (e) => {
    if (e.relatedTarget === textarea || (e.relatedTarget && strip.contains(e.relatedTarget))) return;
    focused = document.activeElement === textarea;
    sync();
  };
  const onInput = () => sync();

  const onMouseDown = (e) => {
    // Keep textarea focus intact while clicking a quick-start pill
    if (e.target.closest("button")) {
      e.preventDefault();
    }
  };

  const onClick = (e) => {
    const btn = e.target.closest("[data-quickstart]");
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const kind = btn.dataset.quickstart;
    if (kind === "dismiss") {
      const nextTheme = { ...loadTheme(), emptyQuickStartEnabled: false };
      saveTheme(nextTheme);
      onThemeSaved?.(nextTheme);
      sync();
      notify("info", "Quick-start hidden", "Re-enable anytime in Settings → Editor & suggestions.");
      return;
    }
    if (kind === "starter") onStarter?.();
    else if (kind === "fields") onFields?.();
    else if (kind === "loras") onLoras?.();
    else if (kind === "import") onImport?.();
    else if (kind === "palette") onCommandPalette?.();
  };

  const cleanupAppearance = onPromptPaletteAppearanceChanged(sync);
  textarea.addEventListener("focus", onFocus);
  textarea.addEventListener("blur", onBlur);
  textarea.addEventListener("input", onInput);
  strip.addEventListener("mousedown", onMouseDown);
  strip.addEventListener("click", onClick);
  strip.addEventListener("focusout", onStripFocusOut);

  focused = document.activeElement === textarea;
  sync();

  return {
    sync,
    cleanup() {
      disposed = true;
      cleanupAppearance();
      textarea.removeEventListener("focus", onFocus);
      textarea.removeEventListener("blur", onBlur);
      textarea.removeEventListener("input", onInput);
      strip.removeEventListener("mousedown", onMouseDown);
      strip.removeEventListener("click", onClick);
      strip.removeEventListener("focusout", onStripFocusOut);
    },
  };
}
