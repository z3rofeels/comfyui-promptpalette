import { getCaretCoords } from "./autocomplete.js";

function escapeRegExp(str) {
  return String(str || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function editorFindReplaceMarkup() {
  return `<div class="wg-editor-find-bar" data-el="editorFindBar" hidden inert role="region" aria-label="Find and replace in prompt">
    <div class="wg-editor-find-clip"><div class="wg-editor-find-content">
    <div class="wg-editor-find-row">
      <button type="button" class="wg-editor-find-expand" data-el="editorFindExpand" aria-expanded="false" aria-label="Toggle replace" title="Toggle replace (Ctrl+H / Cmd+Option+F)">▸</button>
      <input type="search" class="wg-editor-find-input" data-el="editorFindInput" placeholder="Find in prompt… (Ctrl+F)" aria-label="Find in prompt" autocomplete="off" spellcheck="false" />
      <span class="wg-editor-find-count" data-el="editorFindCount" role="status" aria-live="polite"></span>
      <button type="button" class="wg-editor-find-toggle" data-el="editorFindCase" aria-pressed="false" title="Match case (Aa)">Aa</button>
      <button type="button" class="wg-editor-find-toggle" data-el="editorFindWord" aria-pressed="false" title="Match whole words">Word</button>
      <button type="button" class="wg-editor-find-toggle" data-el="editorFindInSelection" aria-pressed="false" title="Search and replace only within selected text">In selection</button>
      <button type="button" class="wg-editor-find-nav" data-el="editorFindPrev" title="Previous match (Shift+Enter)" aria-label="Previous match">↑</button>
      <button type="button" class="wg-editor-find-nav" data-el="editorFindNext" title="Next match (Enter)" aria-label="Next match">↓</button>
      <button type="button" class="wg-editor-find-close" data-el="editorFindClose" title="Close find bar (Esc)" aria-label="Close find bar">×</button>
    </div>
    <div class="wg-editor-replace-row" data-el="editorReplaceRow" hidden>
      <input type="text" class="wg-editor-replace-input" data-el="editorReplaceInput" placeholder="Replace with… (Ctrl+H)" aria-label="Replace with" autocomplete="off" spellcheck="false" />
      <button type="button" class="wg-editor-replace-btn" data-el="editorReplaceOne" title="Replace current match (Enter)">Replace</button>
      <button type="button" class="wg-editor-replace-btn" data-el="editorReplaceAll" title="Replace all matches in active scope (Ctrl/Cmd+Enter)">Replace all</button>
    </div>
    </div></div>
  </div>`;
}

export function attachEditorFindReplace({
  root,
  textarea,
  applyEdit = null,
  onStateChange = () => {},
} = {}) {
  const findBar = root?.querySelector('[data-el="editorFindBar"]');
  if (!root || !textarea || !findBar) {
    return {
      isOpen: () => false,
      openFind: () => {},
      closeFind: () => false,
      toggleReplace: () => {},
      getDecorations: () => [],
      getState: () => ({ open: false, replaceOpen: false, matches: [], activeIndex: -1, inSelection: false, scopeRange: null }),
      scan: () => {},
    };
  }

  const q = (name) => findBar.querySelector(`[data-el="${name}"]`);
  const expandBtn = q("editorFindExpand");
  const findInput = q("editorFindInput");
  const countEl = q("editorFindCount");
  const caseBtn = q("editorFindCase");
  const wordBtn = q("editorFindWord");
  const selBtn = q("editorFindInSelection");
  const prevBtn = q("editorFindPrev");
  const nextBtn = q("editorFindNext");
  const closeBtn = q("editorFindClose");
  const replaceRow = q("editorReplaceRow");
  const replaceInput = q("editorReplaceInput");
  const replaceOneBtn = q("editorReplaceOne");
  const replaceAllBtn = q("editorReplaceAll");

  let isOpenState = false;
  let replaceOpenState = false;
  let caseSensitive = false;
  let wholeWord = false;
  let scannedSource = textarea.value || "";
  let inSelectionMode = false;
  let scopeRange = null;
  let lastUserSelection = null;
  let matches = [];
  let activeIndex = -1;

  const commitReplacement = (nextValue, selStart, selEnd) => {
    if (typeof applyEdit === "function") {
      applyEdit(nextValue, selStart, selEnd);
    } else if (textarea) {
      textarea.value = nextValue;
      if (typeof textarea.setSelectionRange === "function" && typeof selStart === "number") {
        textarea.setSelectionRange(selStart, selEnd ?? selStart);
      }
      textarea.dispatchEvent?.(new Event("input", { bubbles: true }));
    }
  };

  const clampScopeRange = () => {
    if (!scopeRange) return null;
    const len = (textarea.value || "").length;
    const start = Math.max(0, Math.min(len, Number(scopeRange.start) || 0));
    const end = Math.max(start, Math.min(len, Number(scopeRange.end) || 0));
    scopeRange = { start, end };
    return scopeRange;
  };

  const updateControlsUI = () => {
    if (expandBtn) {
      expandBtn.textContent = replaceOpenState ? "▾" : "▸";
      expandBtn.setAttribute("aria-expanded", replaceOpenState ? "true" : "false");
    }
    if (replaceRow) {
      replaceRow.hidden = !replaceOpenState;
    }
    if (caseBtn) {
      caseBtn.classList.toggle("active", caseSensitive);
      caseBtn.setAttribute("aria-pressed", caseSensitive ? "true" : "false");
    }
    if (wordBtn) {
      wordBtn.classList.toggle("active", wholeWord);
      wordBtn.setAttribute("aria-pressed", String(wholeWord));
    }
    const validScope = inSelectionMode ? clampScopeRange() : null;
    if (selBtn) {
      const activeScope = Boolean(inSelectionMode && validScope);
      selBtn.classList.toggle("active", activeScope);
      selBtn.setAttribute("aria-pressed", activeScope ? "true" : "false");
      selBtn.textContent = activeScope
        ? `In selection (${validScope.end - validScope.start})`
        : "In selection";
    }
    const query = findInput?.value || "";
    const hasMatches = matches.length > 0;
    if (countEl) {
      if (!query) {
        countEl.textContent = validScope ? "Scoped" : "";
        countEl.classList.remove("is-empty");
      } else if (!hasMatches) {
        countEl.textContent = "0 matches";
        countEl.classList.add("is-empty");
      } else if (activeIndex >= 0 && activeIndex < matches.length) {
        countEl.textContent = `${(activeIndex + 1).toLocaleString()} / ${matches.length.toLocaleString()}`;
        countEl.classList.remove("is-empty");
      } else {
        countEl.textContent = `${matches.length.toLocaleString()} match${matches.length === 1 ? "" : "es"}`;
        countEl.classList.remove("is-empty");
      }
    }
    if (prevBtn) prevBtn.disabled = !hasMatches;
    if (nextBtn) nextBtn.disabled = !hasMatches;
    if (replaceOneBtn) replaceOneBtn.disabled = !hasMatches;
    if (replaceAllBtn) replaceAllBtn.disabled = !hasMatches;
  };

  const scan = ({ preserveActive = true } = {}) => {
    const prevMatch = preserveActive && activeIndex >= 0 ? matches[activeIndex] : null;
    matches = [];
    activeIndex = -1;
    const query = findInput?.value || "";
    const source = textarea.value || "";
    scannedSource = source;
    const validScope = inSelectionMode ? clampScopeRange() : null;
    if (query && (!inSelectionMode || validScope)) {
      const flags = caseSensitive ? "gu" : "giu";
      const pattern = new RegExp(escapeRegExp(query), flags);
      for (const hit of source.matchAll(pattern)) {
        const start = hit.index;
        const end = start + hit[0].length;
        if (validScope && (start < validScope.start || end > validScope.end)) {
          continue;
        }
        if (wholeWord && (/[\p{L}\p{N}\p{M}_]$/u.test(source.slice(0, start)) || /^[\p{L}\p{N}\p{M}_]/u.test(source.slice(end)))) continue;
        matches.push({ start, end, text: hit[0] });
      }
    }
    if (matches.length > 0) {
      if (prevMatch) {
        const sameIdx = matches.findIndex((m) => m.start === prevMatch.start && m.end === prevMatch.end);
        if (sameIdx >= 0) {
          activeIndex = sameIdx;
        }
      }
      if (activeIndex < 0) {
        const caret = textarea.selectionStart || 0;
        const nextIdx = matches.findIndex((m) => m.start >= caret);
        activeIndex = nextIdx >= 0 ? nextIdx : 0;
      }
    }
    updateControlsUI();
    onStateChange();
  };

  const scrollTextareaToPos = (pos) => {
    try {
      const caret = getCaretCoords(textarea, pos);
      const rect = textarea.getBoundingClientRect();
      if (rect.height > 0) {
        textarea.scrollTop += caret.top - rect.top - rect.height / 2;
      }
    } catch (_err) {
      // Ignore layout measurement failures in headless environments.
    }
  };

  const go = (direction = 1, { focusTextarea = false } = {}) => {
    if ((textarea.value || "") !== scannedSource) scan();
    if (!matches.length) return false;
    if (activeIndex < 0) {
      activeIndex = direction >= 0 ? 0 : matches.length - 1;
    } else {
      activeIndex = (activeIndex + direction + matches.length) % matches.length;
    }
    const target = matches[activeIndex];
    if (focusTextarea) {
      textarea.focus({ preventScroll: true });
    }
    if (!inSelectionMode) {
      textarea.setSelectionRange(target.start, target.end);
    }
    scrollTextareaToPos(target.start);
    updateControlsUI();
    onStateChange();
    return true;
  };

  const replaceOne = () => {
    if ((textarea.value || "") !== scannedSource) scan();
    if (!matches.length) return false;
    if (activeIndex < 0 || activeIndex >= matches.length) {
      activeIndex = 0;
    }
    const target = matches[activeIndex];
    const replacement = replaceInput?.value ?? "";
    const current = textarea.value || "";
    const nextValue = current.slice(0, target.start) + replacement + current.slice(target.end);
    const delta = replacement.length - (target.end - target.start);
    if (inSelectionMode && scopeRange) {
      scopeRange = {
        start: scopeRange.start,
        end: Math.max(scopeRange.start, scopeRange.end + delta),
      };
    }
    const nextCursor = target.start + replacement.length;
    commitReplacement(
      nextValue,
      inSelectionMode && scopeRange ? scopeRange.start : target.start,
      inSelectionMode && scopeRange ? scopeRange.end : nextCursor
    );
    scan({ preserveActive: false });
    if (matches.length > 0) {
      const nextIdx = matches.findIndex((m) => m.start >= nextCursor);
      activeIndex = nextIdx >= 0 ? nextIdx : 0;
      updateControlsUI();
      onStateChange();
    }
    return true;
  };

  const replaceAll = () => {
    if ((textarea.value || "") !== scannedSource) scan();
    if (!matches.length) return 0;
    const replacement = replaceInput?.value ?? "";
    const current = textarea.value || "";
    let out = "";
    let lastIndex = 0;
    let totalDelta = 0;
    for (const hit of matches) {
      out += current.slice(lastIndex, hit.start) + replacement;
      lastIndex = hit.end;
      totalDelta += replacement.length - (hit.end - hit.start);
    }
    out += current.slice(lastIndex);
    const replacedCount = matches.length;
    if (inSelectionMode && scopeRange) {
      scopeRange = {
        start: scopeRange.start,
        end: Math.max(scopeRange.start, scopeRange.end + totalDelta),
      };
      commitReplacement(out, scopeRange.start, scopeRange.end);
    } else {
      commitReplacement(out, textarea.selectionStart || 0, textarea.selectionEnd || 0);
    }
    scan({ preserveActive: false });
    if (countEl) {
      countEl.textContent = `Replaced ${replacedCount.toLocaleString()}`;
      countEl.classList.remove("is-empty");
    }
    return replacedCount;
  };

  const setScopeFromSelection = (enable, explicitRange = null) => {
    if (!enable) {
      inSelectionMode = false;
      scopeRange = null;
      scan();
      return false;
    }
    const candidate =
      explicitRange ||
      (textarea.selectionEnd > textarea.selectionStart
        ? { start: textarea.selectionStart, end: textarea.selectionEnd }
        : lastUserSelection);
    if (!candidate || candidate.end <= candidate.start) {
      inSelectionMode = false;
      scopeRange = null;
      scan();
      return false;
    }
    inSelectionMode = true;
    scopeRange = { start: candidate.start, end: candidate.end };
    scan();
    return true;
  };

  const openFind = ({ replace = false, inSelection = null, query = null } = {}) => {
    const selStart = textarea.selectionStart || 0;
    const selEnd = textarea.selectionEnd || 0;
    const hasSelection = selEnd > selStart;
    if (hasSelection) {
      lastUserSelection = { start: selStart, end: selEnd };
    }
    const selectedText = hasSelection ? (textarea.value || "").slice(selStart, selEnd) : "";

    isOpenState = true;
    replaceOpenState = Boolean(replace);
    findBar.hidden = false;
    findBar.inert = false;

    if (typeof query === "string") {
      findInput.value = query;
    }

    if (inSelection === true && hasSelection) {
      inSelectionMode = true;
      scopeRange = { start: selStart, end: selEnd };
    } else if (inSelection === false) {
      inSelectionMode = false;
      scopeRange = null;
    } else if (hasSelection) {
      const multilineOrLong = selectedText.includes("\n") || (replace && selectedText.length > 24);
      if (multilineOrLong) {
        inSelectionMode = true;
        scopeRange = { start: selStart, end: selEnd };
      } else if (query === null) {
        findInput.value = selectedText;
      }
    }

    scan({ preserveActive: false });
    if (replace && findInput.value && document.activeElement === findInput) {
      replaceInput?.focus();
      replaceInput?.select();
    } else {
      findInput?.focus();
      findInput?.select();
    }
  };

  const closeFind = ({ restoreFocus = true } = {}) => {
    if (!isOpenState && findBar.hidden) return false;
    isOpenState = false;
    findBar.inert = true;
    findBar.hidden = true;
    matches = [];
    activeIndex = -1;
    inSelectionMode = false;
    scopeRange = null;
    updateControlsUI();
    onStateChange();
    if (restoreFocus) {
      textarea.focus({ preventScroll: true });
    }
    return true;
  };

  const toggleReplace = (force) => {
    replaceOpenState = typeof force === "boolean" ? force : !replaceOpenState;
    if (!isOpenState) {
      openFind({ replace: replaceOpenState });
      return;
    }
    updateControlsUI();
    if (replaceOpenState) {
      replaceInput?.focus();
      replaceInput?.select();
    } else {
      findInput?.focus();
    }
  };

  const getDecorations = () => {
    if (!isOpenState) return [];
    const decorations = [];
    const validScope = inSelectionMode ? clampScopeRange() : null;
    if (validScope) {
      decorations.push({
        start: validScope.start,
        end: validScope.end,
        kind: "find-scope",
      });
    }
    matches.forEach((m, idx) => {
      decorations.push({
        start: m.start,
        end: m.end,
        kind: idx === activeIndex ? "find-current" : "find-match",
      });
    });
    return decorations;
  };

  expandBtn?.addEventListener("click", (e) => {
    e.preventDefault();
    toggleReplace();
  });

  caseBtn?.addEventListener("click", (e) => {
    e.preventDefault();
    caseSensitive = !caseSensitive;
    scan();
  });

  wordBtn?.addEventListener("click", (e) => {
    e.preventDefault();
    wholeWord = !wholeWord;
    scan();
  });

  selBtn?.addEventListener("click", (e) => {
    e.preventDefault();
    setScopeFromSelection(!inSelectionMode);
  });

  prevBtn?.addEventListener("click", (e) => {
    e.preventDefault();
    go(-1);
  });

  nextBtn?.addEventListener("click", (e) => {
    e.preventDefault();
    go(1);
  });

  closeBtn?.addEventListener("click", (e) => {
    e.preventDefault();
    closeFind({ restoreFocus: true });
  });

  replaceOneBtn?.addEventListener("click", (e) => {
    e.preventDefault();
    replaceOne();
  });

  replaceAllBtn?.addEventListener("click", (e) => {
    e.preventDefault();
    replaceAll();
  });

  findInput?.addEventListener("input", () => scan({ preserveActive: false }));
  findInput?.addEventListener("keydown", (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      go(e.shiftKey ? -1 : 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeFind({ restoreFocus: true });
    }
  });

  replaceInput?.addEventListener("keydown", (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      if (e.ctrlKey || e.metaKey) {
        replaceAll();
      } else {
        replaceOne();
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeFind({ restoreFocus: true });
    }
  });

  textarea.addEventListener("select", () => {
    if (textarea.selectionEnd > textarea.selectionStart) {
      lastUserSelection = {
        start: textarea.selectionStart,
        end: textarea.selectionEnd,
      };
    }
  });

  textarea.addEventListener("input", () => {
    if (isOpenState) {
      scan({ preserveActive: true });
    }
  });

  const handleShortcut = (e) => {
    if (e.isComposing || e.keyCode === 229 || !(e.ctrlKey || e.metaKey) || e.shiftKey) return;
    const key = String(e.key || "").toLowerCase();
    const target = e.target;
    const inPrimaryEditor =
      target === textarea ||
      findBar.contains(target) ||
      (target === root || root.querySelector(".wg-editor-wrap")?.contains(target));
    if (!inPrimaryEditor) return;

    if (key === "f" && e.altKey) {
      // Cmd+Alt+F on macOS opens Find & Replace
      e.preventDefault();
      e.stopPropagation();
      openFind({ replace: true });
      return;
    }
    if (key === "f" && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      openFind({ replace: isOpenState ? replaceOpenState : false });
      return;
    }
    if (key === "h" && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      openFind({ replace: true });
    }
  };

  findBar.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      e.stopPropagation();
      closeFind({ restoreFocus: true });
    }
  });
  for (const type of ["pointerdown", "mousedown", "click", "dblclick"]) {
    findBar.addEventListener(type, (e) => e.stopPropagation());
  }
  // Capture only our shortcuts before the single-surface editor stops bubbling.
  root.addEventListener("keydown", handleShortcut, true);

  return {
    isOpen: () => isOpenState,
    openFind,
    closeFind,
    toggleReplace,
    replaceOne,
    replaceAll,
    setScopeFromSelection,
    getDecorations,
    getState: () => ({
      open: isOpenState,
      replaceOpen: replaceOpenState,
      caseSensitive,
      wholeWord,
      inSelection: Boolean(inSelectionMode && scopeRange),
      scopeRange: scopeRange ? { ...scopeRange } : null,
      matches: matches.map((m) => ({ ...m })),
      activeIndex,
    }),
    refreshSource: () => { if (isOpenState && (textarea.value || "") !== scannedSource) scan(); },
    scan,
  };
}

