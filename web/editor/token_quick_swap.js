import { parsePrompt } from "../engine/wildcard_engine.js";
import { jsonObjectRanges, maskJsonObjects } from "../engine/json_literals.js";
import { API } from "../prompt_palette_api.js";
import {
  copyPromptPaletteThemeScope,
  installPromptPaletteKeyboardBoundary,
  onPromptPaletteAppearanceChanged,
  svgIcon,
} from "../prompt_palette_shared.js";
import { getCaretCoords } from "./autocomplete.js";
import { editorOffsetAtPoint } from "./editor_hover.js";
import { PresentationScope } from "./sidebar_presentation.js";
import { notify } from "./notifications.js";

const MULTI_PICK_PREFIX_RE = /^(\d+(?:-\d+)?\$\$[\s\S]*?\$\$)([\s\S]*)$/;
const OPTION_WEIGHT_RE = /^\s*(\d+(?:\.\d+)?)::\s*([\s\S]*)$/;

function splitBraceOptions(inner, baseOffset) {
  const rawParts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}" && depth > 0) depth -= 1;
    else if (ch === "|" && depth === 0) {
      rawParts.push({ raw: inner.slice(start, i), start: baseOffset + start, end: baseOffset + i });
      start = i + 1;
    }
  }
  rawParts.push({ raw: inner.slice(start), start: baseOffset + start, end: baseOffset + inner.length });
  return rawParts.map((part, index) => {
    const wm = OPTION_WEIGHT_RE.exec(part.raw);
    const weight = wm ? Number(wm[1]) : null;
    const body = wm ? wm[2] : part.raw;
    return {
      index,
      raw: part.raw.trim(),
      cleanText: body.trim(),
      weight,
      start: part.start,
      end: part.end,
    };
  });
}

export function findQuickSwapTokenAt(sourceText, offset) {
  const source = String(sourceText ?? "");
  if (!source || !Number.isFinite(offset) || offset < 0 || offset > source.length) return null;

  const jsonRanges = jsonObjectRanges(source);
  if (jsonRanges.some((r) => offset >= r.start && offset < r.end)) return null;

  const lineStart = source.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
  const lineEndIdx = source.indexOf("\n", offset);
  const lineText = source.slice(lineStart, lineEndIdx < 0 ? source.length : lineEndIdx);
  if (/^\s*#/.test(lineText)) return null;

  const parsed = parsePrompt(source);
  const wildcard =
    parsed.wildcards.find((w) => w.start <= offset && offset < w.end) ||
    parsed.wildcards.find((w) => w.end === offset);
  if (wildcard) {
    return {
      kind: "wildcard",
      start: wildcard.start,
      end: wildcard.end,
      raw: wildcard.text,
      name: wildcard.name,
      mode: wildcard.mode || "",
      argsRaw: wildcard.argsRaw || "",
    };
  }

  const masked = maskJsonObjects(source, jsonRanges)
    .split("\n")
    .map((ln) => (/^\s*#/.test(ln) ? " ".repeat(ln.length) : ln))
    .join("\n");

  const stack = [];
  const groups = [];
  for (let i = 0; i < masked.length; i += 1) {
    const ch = masked[i];
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === "{") {
      const isVar = i > 0 && masked[i - 1] === "$";
      stack.push({ start: i, isVar });
    } else if (ch === "}" && stack.length > 0) {
      const open = stack.pop();
      if (!open.isVar) {
        groups.push({ start: open.start, end: i + 1 });
      }
    }
  }

  const enclosing = groups
    .filter((g) => g.start <= offset && offset <= g.end)
    .sort((a, b) => (a.end - a.start) - (b.end - b.start));

  for (const grp of enclosing) {
    const whole = source.slice(grp.start, grp.end);
    let inner = whole.slice(1, -1);
    let innerOffset = grp.start + 1;
    let modifier = "";
    if (inner.length > 0 && "*~+-@%".includes(inner[0])) {
      modifier = inner[0];
      inner = inner.slice(1);
      innerOffset += 1;
    }
    let multiSelectPrefix = "";
    const mm = MULTI_PICK_PREFIX_RE.exec(inner);
    if (mm) {
      multiSelectPrefix = mm[1];
      innerOffset += mm[1].length;
      inner = mm[2];
    }
    const options = splitBraceOptions(inner, innerOffset).filter((o) => o.cleanText.length > 0 || rawHasChoices(whole));
    if (options.length >= 2) {
      return {
        kind: "choice",
        start: grp.start,
        end: grp.end,
        raw: whole,
        modifier,
        multiSelectPrefix,
        options,
      };
    }
  }

  return null;
}

function rawHasChoices(whole) {
  return whole.includes("|");
}

let cachedCategoriesPromise = null;
function fetchCategoryThumbMap() {
  if (!cachedCategoriesPromise) {
    cachedCategoriesPromise = API.categories().catch(() => ({}));
  }
  return cachedCategoriesPromise;
}

function resolveThumbFile(thumbMap, wildcardName) {
  if (!thumbMap || typeof thumbMap !== "object" || !wildcardName) return null;
  const clean = String(wildcardName).replace(/^\/+|\/+$/g, "");
  if (thumbMap[clean]) return thumbMap[clean];
  const lower = clean.toLowerCase();
  for (const [k, v] of Object.entries(thumbMap)) {
    if (k.toLowerCase() === lower) return v;
  }
  return null;
}

function make(tag, className = "", text = "") {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text) el.textContent = text;
  return el;
}

let activeQuickSwap = null;

export function closeTokenQuickSwap({ restoreFocus = true } = {}) {
  if (!activeQuickSwap) return false;
  activeQuickSwap.close({ restoreFocus });
  return true;
}

export function openTokenQuickSwap(editor, { offset = null, anchorPoint = null, applyEdit = null } = {}) {
  closeTokenQuickSwap({ restoreFocus: false });
  if (!editor?.isConnected) return null;
  if (editor.readOnly || editor.disabled || editor.getAttribute("aria-readonly") === "true") {
    notify("info", "Read-only prompt", "Switch to an editable prompt field to swap tokens.");
    return null;
  }

  const source = editor.value || "";
  const targetOffset = Number.isFinite(offset) ? offset : (editor.selectionStart ?? 0);
  const token = findQuickSwapTokenAt(source, targetOffset);
  if (!token) return null;

  const savedSelection = {
    start: editor.selectionStart ?? token.start,
    end: editor.selectionEnd ?? token.end,
    direction: editor.selectionDirection || "none",
  };

  const popover = make("div", "pp-token-swap-popover wg-root");
  popover.dataset.promptPaletteGlobal = "true";
  popover.setAttribute("role", "dialog");
  popover.setAttribute("aria-label", token.kind === "wildcard" ? `Quick-swap wildcard ${token.name}` : "Quick-swap choice options");

  const presentation = new PresentationScope(popover, {
    scopeAttr: "data-pp-swap-scope",
    layoutAttr: "data-pp-swap-layout",
  });
  const scope = editor.closest(".wg-root, .wg-node, .pp-node, .ppwc-surface");
  const syncTheme = () => {
    if (scope) {
      copyPromptPaletteThemeScope(scope, popover, presentation.declaration(popover, { portal: true }));
      popover.classList.toggle("wg-high-contrast", scope.classList.contains("wg-high-contrast"));
    }
  };
  syncTheme();

  let closed = false;
  let allOptions = [];
  let filteredOptions = [];
  let activeIndex = 0;
  let candidateIndex = 0;
  let abortCtrl = null;

  const head = make("div", "pp-swap-head");
  const headInfo = make("div", "pp-swap-head-info");
  const badge = make("span", "pp-swap-kind-badge", token.kind === "wildcard" ? "WILDCARD" : "CHOICE");
  const titleEl = make("strong", "pp-swap-title", token.kind === "wildcard" ? `__${token.mode}${token.name}__` : `${token.options.length} inline options`);
  headInfo.append(badge, titleEl);

  const closeBtn = make("button", "wg-editor-find-close", "×");
  closeBtn.type = "button";
  closeBtn.title = "Close (Esc)";
  closeBtn.setAttribute("aria-label", "Close quick swap (Esc)");
  head.append(headInfo, closeBtn);

  const heroWrap = make("div", "pp-swap-hero");
  heroWrap.hidden = true;

  const candidateBar = make("div", "pp-swap-candidate-bar");
  const candidateCopy = make("div", "pp-swap-candidate-copy");
  const candidateEyebrow = make("small", "", "Candidate pick");
  const candidateValueEl = make("span", "pp-swap-candidate-val", "Loading…");
  candidateCopy.append(candidateEyebrow, candidateValueEl);

  const candidateBtns = make("div", "pp-swap-candidate-btns");
  const rerollBtn = make("button", "wg-pill pp-swap-reroll-btn");
  rerollBtn.type = "button";
  rerollBtn.innerHTML = `${svgIcon("dice", 12)} <span>Reroll slot</span>`;
  rerollBtn.title = "Cycle to another random candidate";

  const pinCandidateBtn = make("button", "wg-pill pp-swap-pin-btn", "Pin pick");
  pinCandidateBtn.type = "button";
  pinCandidateBtn.title = "Replace token with this candidate (Ctrl/Cmd+Z to undo)";
  candidateBtns.append(rerollBtn, pinCandidateBtn);
  candidateBar.append(candidateCopy, candidateBtns);

  const searchWrap = make("div", "pp-swap-search-wrap");
  searchWrap.hidden = true;
  const searchInput = make("input", "pp-swap-search");
  searchInput.type = "search";
  searchInput.placeholder = "Filter options…";
  searchInput.setAttribute("aria-label", "Filter token options");
  searchInput.autocomplete = "off";
  searchWrap.append(searchInput);

  const listEl = make("div", "pp-swap-list");
  listEl.setAttribute("role", "listbox");
  listEl.setAttribute("aria-label", "Available candidates");

  const footer = make("div", "pp-swap-footer", "Click an option to pin · Esc closes · Ctrl/Cmd+Z reverts");

  popover.append(head, heroWrap, candidateBar, searchWrap, listEl, footer);
  document.body.append(popover);

  const cleanupKeys = installPromptPaletteKeyboardBoundary(popover);
  const cleanupTheme = onPromptPaletteAppearanceChanged(syncTheme);

  function positionPopover() {
    if (closed) return;
    let ax = anchorPoint?.x;
    let ay = anchorPoint?.y;
    let lineH = 18;
    if (!Number.isFinite(ax) || !Number.isFinite(ay)) {
      const coords = getCaretCoords(editor, token.start);
      ax = coords.left;
      ay = coords.top;
      lineH = coords.lineHeight || 18;
    }
    const pad = 10;
    const vw = window.innerWidth || 1024;
    const vh = window.innerHeight || 768;
    const rect = popover.getBoundingClientRect();
    const pw = rect.width || 320;
    const ph = rect.height || 260;

    let left = Math.max(pad, Math.min(ax, vw - pw - pad));
    let top = ay + lineH + 6;
    if (top + ph > vh - pad && ay - ph - 6 >= pad) {
      top = ay - ph - 6;
    } else {
      top = Math.max(pad, Math.min(top, vh - ph - pad));
    }
    presentation.declaration(popover, { portal: true })?.setProperty("--pp-swap-left", `${Math.round(left)}px`);
    presentation.declaration(popover, { portal: true })?.setProperty("--pp-swap-top", `${Math.round(top)}px`);
  }

  function commitOption(textToInsert) {
    if (closed) return;
    if (!editor.isConnected || editor.value !== source) {
      close({ restoreFocus: true });
      notify("info", "Prompt changed", "Reopen Quick-Swap to replace the updated token.");
      return;
    }
    const cleanInsert = String(textToInsert ?? "");
    const nextValue = source.slice(0, token.start) + cleanInsert + source.slice(token.end);
    const caretEnd = token.start + cleanInsert.length;
    close({ restoreFocus: false });
    const customApply = applyEdit || editor.__ppPromptTools?.apply;
    if (typeof customApply === "function") {
      customApply(nextValue, token.start, caretEnd);
    } else {
      editor.value = nextValue;
      editor.setSelectionRange?.(token.start, caretEnd);
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    }
    editor.focus({ preventScroll: true });
  }

  function updateCandidateBanner() {
    if (!allOptions.length) {
      candidateValueEl.textContent = "No options available";
      rerollBtn.disabled = true;
      pinCandidateBtn.disabled = true;
      return;
    }
    rerollBtn.disabled = allOptions.length < 2;
    pinCandidateBtn.disabled = false;
    const picked = allOptions[candidateIndex] || allOptions[0];
    candidateValueEl.textContent = picked.text;
    candidateValueEl.title = picked.text;
  }

  function syncActiveRow() {
    const rows = [...listEl.querySelectorAll(".pp-swap-option")];
    rows.forEach((row, idx) => {
      const isAct = idx === activeIndex;
      row.classList.toggle("active", isAct);
      row.setAttribute("aria-selected", String(isAct));
      row.tabIndex = isAct ? 0 : -1;
    });
    rows[activeIndex]?.scrollIntoView?.({ block: "nearest" });
  }

  function renderList(thumbMap = null) {
    const q = searchInput.value.trim().toLowerCase();
    filteredOptions = q
      ? allOptions.filter((o) => o.text.toLowerCase().includes(q))
      : [...allOptions];
    activeIndex = Math.max(0, Math.min(activeIndex, Math.max(0, filteredOptions.length - 1)));
    listEl.replaceChildren();

    if (!filteredOptions.length) {
      listEl.append(make("div", "pp-swap-empty", q ? "No matching options." : "No options found in this entry."));
      return;
    }

    filteredOptions.forEach((opt, idx) => {
      const row = make("button", "pp-swap-option");
      row.type = "button";
      row.setAttribute("role", "option");
      row.classList.toggle("is-candidate", allOptions[candidateIndex] === opt);

      const subWildcardMatch = /^__([+\-*%~@]?)([A-Za-z0-9_\-/*]+)__$/.exec(opt.text);
      const subThumb = subWildcardMatch && thumbMap ? resolveThumbFile(thumbMap, subWildcardMatch[2]) : null;
      if (subThumb) {
        const img = make("img", "pp-swap-option-thumb");
        img.src = API.thumbnailUrl(subThumb);
        img.alt = "";
        img.loading = "lazy";
        row.append(img);
      }

      const label = make("span", "pp-swap-option-text", opt.text);
      row.append(label);
      if (opt.weight != null) {
        row.append(make("span", "pp-swap-option-weight", `${opt.weight}::`));
      }
      row.addEventListener("mouseenter", () => {
        activeIndex = idx;
        syncActiveRow();
      });
      row.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        commitOption(opt.text);
      });
      listEl.append(row);
    });
    syncActiveRow();
    positionPopover();
  }

  function rerollCandidate() {
    if (allOptions.length < 2) return;
    let next = Math.floor(Math.random() * allOptions.length);
    if (next === candidateIndex) next = (candidateIndex + 1) % allOptions.length;
    candidateIndex = next;
    updateCandidateBanner();
    const inFiltered = filteredOptions.indexOf(allOptions[candidateIndex]);
    if (inFiltered >= 0) activeIndex = inFiltered;
    const rows = [...listEl.querySelectorAll(".pp-swap-option")];
    rows.forEach((r, idx) => r.classList.toggle("is-candidate", filteredOptions[idx] === allOptions[candidateIndex]));
    syncActiveRow();
  }

  function handleDocMouseDown(e) {
    if (!closed && !popover.contains(e.target)) {
      close({ restoreFocus: false });
    }
  }

  function handleDocKeyDown(e) {
    if (closed) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (document.activeElement === searchInput && searchInput.value) {
        searchInput.value = "";
        renderList();
        return;
      }
      close({ restoreFocus: true });
      return;
    }
    if (!popover.contains(document.activeElement)) return;
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key) && filteredOptions.length > 0) {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Home") activeIndex = 0;
      else if (e.key === "End") activeIndex = filteredOptions.length - 1;
      else if (e.key === "ArrowDown") activeIndex = (activeIndex + 1) % filteredOptions.length;
      else activeIndex = (activeIndex - 1 + filteredOptions.length) % filteredOptions.length;
      syncActiveRow();
    } else if (e.key === "Enter" && !e.ctrlKey && !e.metaKey && filteredOptions[activeIndex]) {
      e.preventDefault();
      e.stopPropagation();
      commitOption(filteredOptions[activeIndex].text);
    }
  }

  function handleViewportChange(e) {
    if (!closed && !(e.target instanceof Node && popover.contains(e.target))) {
      positionPopover();
    }
  }

  function close({ restoreFocus = true } = {}) {
    if (closed) return;
    closed = true;
    abortCtrl?.abort();
    document.removeEventListener("mousedown", handleDocMouseDown, true);
    document.removeEventListener("keydown", handleDocKeyDown, true);
    document.removeEventListener("scroll", handleViewportChange, true);
    window.removeEventListener("resize", handleViewportChange);
    cleanupKeys();
    cleanupTheme();
    presentation.cleanup();
    popover.remove();
    if (activeQuickSwap?.popover === popover) activeQuickSwap = null;
    if (restoreFocus && editor.isConnected) {
      editor.focus({ preventScroll: true });
      if (editor.value === source) {
        editor.setSelectionRange?.(savedSelection.start, savedSelection.end, savedSelection.direction);
      }
    }
  }

  closeBtn.addEventListener("click", () => close({ restoreFocus: true }));
  rerollBtn.addEventListener("click", (e) => {
    e.preventDefault();
    rerollCandidate();
  });
  pinCandidateBtn.addEventListener("click", (e) => {
    e.preventDefault();
    if (allOptions[candidateIndex]) commitOption(allOptions[candidateIndex].text);
  });
  searchInput.addEventListener("input", () => renderList());

  document.addEventListener("mousedown", handleDocMouseDown, true);
  document.addEventListener("keydown", handleDocKeyDown, true);
  document.addEventListener("scroll", handleViewportChange, true);
  window.addEventListener("resize", handleViewportChange);

  activeQuickSwap = { popover, editor, close };
  positionPopover();

  if (token.kind === "choice") {
    allOptions = token.options.map((o) => ({ text: o.cleanText, weight: o.weight }));
    candidateIndex = 0;
    searchWrap.hidden = allOptions.length <= 6;
    updateCandidateBanner();
    fetchCategoryThumbMap().then((thumbMap) => {
      if (!closed) renderList(thumbMap);
    });
    renderList();
    (searchWrap.hidden ? rerollBtn : searchInput).focus({ preventScroll: true });
  } else {
    abortCtrl = new AbortController();
    Promise.all([
      API.alternatives(token.name),
      fetchCategoryThumbMap(),
    ])
      .then(([altData, thumbMap]) => {
        if (closed) return;
        const heroFile = resolveThumbFile(thumbMap, token.name);
        if (heroFile) {
          heroWrap.replaceChildren();
          const img = make("img", "pp-swap-hero-img");
          img.src = API.thumbnailUrl(heroFile);
          img.alt = token.name;
          const caption = make("span", "pp-swap-hero-caption", `${token.name} (${altData?.total ?? 0} entries)`);
          heroWrap.append(img, caption);
          heroWrap.hidden = false;
        }
        const lines = Array.isArray(altData?.lines) ? altData.lines : [];
        allOptions = lines.map((ln) => ({ text: String(ln).trim(), weight: null })).filter((o) => o.text.length > 0);
        const seedVal = Number(editor.__ppPromptTools?.node?.widgets?.find?.((w) => w.name === "seed")?.value || 0);
        candidateIndex = allOptions.length ? Math.abs(Math.trunc(seedVal)) % allOptions.length : 0;
        searchWrap.hidden = allOptions.length <= 6;
        if (altData?.total) {
          titleEl.textContent = `__${token.mode}${token.name}__ (${altData.total})`;
        }
        updateCandidateBanner();
        renderList(thumbMap);
        (searchWrap.hidden ? rerollBtn : searchInput).focus({ preventScroll: true });
      })
      .catch((err) => {
        if (closed || err?.name === "AbortError") return;
        candidateValueEl.textContent = "Could not load wildcard lines";
        listEl.replaceChildren(make("div", "pp-swap-empty", err?.message || "Wildcard lookup failed."));
      });
  }

  return activeQuickSwap;
}

export function attachTokenQuickSwap(editor, { applyEdit = null } = {}) {
  if (!editor) return () => {};
  const onClick = (event) => {
    if (event.button !== 0 || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (editor.readOnly || editor.disabled) return;
    const hitOffset = editorOffsetAtPoint(editor, event.clientX, event.clientY);
    const offset = hitOffset >= 0 ? hitOffset : (editor.selectionStart ?? -1);
    const token = findQuickSwapTokenAt(editor.value || "", offset);
    if (!token) return;
    event.preventDefault();
    event.stopPropagation();
    openTokenQuickSwap(editor, {
      offset,
      anchorPoint: { x: event.clientX, y: event.clientY + 4 },
      applyEdit,
    });
  };
  editor.addEventListener("click", onClick);
  return () => {
    if (activeQuickSwap?.editor === editor) closeTokenQuickSwap({ restoreFocus: false });
    editor.removeEventListener("click", onClick);
  };
}
