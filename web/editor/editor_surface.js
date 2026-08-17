let surfaceCounter = 0;
const EDITOR_SENTINEL = "\u200b";

function logicalText(root) {
  return String(root?.textContent || "").split(EDITOR_SENTINEL).join("");
}

function logicalLength(root) { return logicalText(root).length; }

function clampOffset(value, length) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(length, Math.trunc(numeric)));
}

function selectionBelongsTo(root, selection) {
  if (!selection?.anchorNode || !selection?.focusNode) return false;
  return root.contains(selection.anchorNode) && root.contains(selection.focusNode);
}

function readLiveSelection(root, fallbackStart = 0, fallbackEnd = 0) {
  const selection = window.getSelection?.();
  if (!selectionBelongsTo(root, selection)) return { start: fallbackStart, end: fallbackEnd, direction: "none" };
  try {
    const anchorRange = document.createRange();
    anchorRange.selectNodeContents(root);
    anchorRange.setEnd(selection.anchorNode, selection.anchorOffset);
    const focusRange = document.createRange();
    focusRange.selectNodeContents(root);
    focusRange.setEnd(selection.focusNode, selection.focusOffset);
    const anchorRaw = anchorRange.toString();
    const focusRaw = focusRange.toString();
    const anchor = anchorRaw.split(EDITOR_SENTINEL).join("").length;
    const focus = focusRaw.split(EDITOR_SENTINEL).join("").length;
    return {
      start: Math.min(anchor, focus),
      end: Math.max(anchor, focus),
      direction: anchor <= focus ? "forward" : "backward",
    };
  } catch {
    return { start: fallbackStart, end: fallbackEnd, direction: "none" };
  }
}

function textPointAtOffset(root, requestedOffset) {
  const target = clampOffset(requestedOffset, logicalLength(root));
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let consumed = 0;
  let node = walker.nextNode();
  let lastText = null;
  while (node) {
    lastText = node;
    let localLogical = 0;
    for (let raw = 0; raw <= node.data.length; raw++) {
      if (consumed + localLogical === target) return { node, offset: raw };
      if (raw < node.data.length && node.data[raw] !== EDITOR_SENTINEL) localLogical += 1;
    }
    consumed += localLogical;
    node = walker.nextNode();
  }
  if (lastText) {
    const sentinelAt = lastText.data.lastIndexOf(EDITOR_SENTINEL);
    return { node: lastText, offset: sentinelAt >= 0 ? sentinelAt : lastText.data.length };
  }
  const empty = document.createTextNode(EDITOR_SENTINEL);
  root.appendChild(empty);
  return { node: empty, offset: 0 };
}

export function createDomRangeForOffsets(root, start, end = start) {
  const textLength = logicalLength(root);
  const safeStart = clampOffset(start, textLength);
  const safeEnd = clampOffset(end, textLength);
  const from = textPointAtOffset(root, Math.min(safeStart, safeEnd));
  const to = textPointAtOffset(root, Math.max(safeStart, safeEnd));
  const range = document.createRange();
  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset);
  return range;
}

function setLiveSelection(root, start, end = start, direction = "forward") {
  const length = logicalLength(root);
  const safeStart = clampOffset(start, length);
  const safeEnd = clampOffset(end, length);
  const selection = window.getSelection?.();
  if (!selection) return;
  const range = createDomRangeForOffsets(root, safeStart, safeEnd);
  selection.removeAllRanges();
  selection.addRange(range);
  if (direction === "backward" && typeof selection.setBaseAndExtent === "function") {
    const from = textPointAtOffset(root, safeEnd);
    const to = textPointAtOffset(root, safeStart);
    selection.setBaseAndExtent(from.node, from.offset, to.node, to.offset);
  }
}

function supportsSingleSurfaceEditor() {
  return !!(globalThis.CSS?.highlights && globalThis.Highlight && document?.createRange && window?.getSelection);
}

function normalizePlainTextDom(root, state) {
  const onlyChild = root.childNodes.length === 1 ? root.firstChild : null;
  const raw = onlyChild?.nodeType === Node.TEXT_NODE ? onlyChild.data : "";
  const sentinelCount = raw ? raw.split(EDITOR_SENTINEL).length - 1 : 0;
  if (onlyChild?.nodeType === Node.TEXT_NODE && sentinelCount === 1 && raw.endsWith(EDITOR_SENTINEL)) return;
  const current = readLiveSelection(root, state.start, state.end);
  // Slow-path only: normal typing, Enter and paste stay in a single text node.
  const text = String(root.innerText || root.textContent || "").replace(/\r\n?/g, "\n").split(EDITOR_SENTINEL).join("");
  root.textContent = text + EDITOR_SENTINEL;
  state.start = clampOffset(current.start, text.length);
  state.end = clampOffset(current.end, text.length);
  state.direction = current.direction;
  setLiveSelection(root, state.start, state.end, state.direction);
}

function installTextareaCompatibility(root) {
  const state = { start: 0, end: 0, direction: "none" };

  const refreshSelection = () => {
    const current = readLiveSelection(root, state.start, state.end);
    state.start = clampOffset(current.start, (root.textContent || "").length);
    state.end = clampOffset(current.end, (root.textContent || "").length);
    state.direction = current.direction;
    return state;
  };

  const applySelection = () => {
    if (document.activeElement === root || selectionBelongsTo(root, window.getSelection?.())) {
      setLiveSelection(root, state.start, state.end, state.direction);
    }
  };

  Object.defineProperty(root, "value", {
    configurable: true,
    get() { return logicalText(root); },
    set(value) {
      const text = String(value ?? "").replace(/\r\n?/g, "\n").split(EDITOR_SENTINEL).join("");
      root.textContent = text + EDITOR_SENTINEL;
      state.start = state.end = text.length;
      state.direction = "none";
      applySelection();
    },
  });

  Object.defineProperty(root, "selectionStart", {
    configurable: true,
    get() { return refreshSelection().start; },
    set(value) {
      const length = root.value.length;
      const next = clampOffset(value, length);
      state.start = next;
      if (state.end < next) state.end = next;
      state.direction = "forward";
      applySelection();
    },
  });

  Object.defineProperty(root, "selectionEnd", {
    configurable: true,
    get() { return refreshSelection().end; },
    set(value) {
      const length = root.value.length;
      const next = clampOffset(value, length);
      state.end = next;
      if (state.start > next) state.start = next;
      state.direction = "forward";
      applySelection();
    },
  });

  Object.defineProperty(root, "selectionDirection", {
    configurable: true,
    get() { return refreshSelection().direction; },
    set(value) { state.direction = value === "backward" ? "backward" : value === "forward" ? "forward" : "none"; applySelection(); },
  });

  root.setSelectionRange = (start, end = start, direction = "forward") => {
    const length = root.value.length;
    state.start = clampOffset(Math.min(start, end), length);
    state.end = clampOffset(Math.max(start, end), length);
    state.direction = direction === "backward" ? "backward" : "forward";
    setLiveSelection(root, state.start, state.end, state.direction);
  };

  root.select = () => root.setSelectionRange(0, root.value.length, "forward");

  root.setRangeText = (replacement, start = root.selectionStart, end = root.selectionEnd, selectionMode = "preserve") => {
    const source = root.value;
    const safeStart = clampOffset(Math.min(start, end), source.length);
    const safeEnd = clampOffset(Math.max(start, end), source.length);
    const insert = String(replacement ?? "");
    const oldSelection = refreshSelection();
    root.value = source.slice(0, safeStart) + insert + source.slice(safeEnd);
    const insertedEnd = safeStart + insert.length;
    if (selectionMode === "select") root.setSelectionRange(safeStart, insertedEnd);
    else if (selectionMode === "start") root.setSelectionRange(safeStart, safeStart);
    else if (selectionMode === "end") root.setSelectionRange(insertedEnd, insertedEnd);
    else {
      const delta = insert.length - (safeEnd - safeStart);
      const map = (pos) => pos <= safeStart ? pos : pos >= safeEnd ? pos + delta : insertedEnd;
      root.setSelectionRange(map(oldSelection.start), map(oldSelection.end), oldSelection.direction);
    }
  };

  let correctingSelection = false;
  const onSelectionChange = () => {
    const selection = window.getSelection?.();
    if (!selectionBelongsTo(root, selection) || correctingSelection) return;
    const current = refreshSelection();
    try {
      const anchorRange = document.createRange();
      anchorRange.selectNodeContents(root);
      anchorRange.setEnd(selection.anchorNode, selection.anchorOffset);
      const focusRange = document.createRange();
      focusRange.selectNodeContents(root);
      focusRange.setEnd(selection.focusNode, selection.focusOffset);
      const crossedSentinel = anchorRange.toString().includes(EDITOR_SENTINEL) || focusRange.toString().includes(EDITOR_SENTINEL);
      if (crossedSentinel) {
        correctingSelection = true;
        setLiveSelection(root, current.start, current.end, current.direction);
        queueMicrotask(() => { correctingSelection = false; });
      }
    } catch { /* selection is still safely clamped by the compatibility getters */ }
  };
  document.addEventListener("selectionchange", onSelectionChange);

  const insertPlainText = (text, inputType = "insertText") => {
    const start = root.selectionStart;
    const end = root.selectionEnd;
    root.setRangeText(text, start, end, "end");
    root.dispatchEvent(new InputEvent("input", { bubbles: true, inputType, data: text }));
  };

  const onBeforeInput = (event) => {
    event.stopPropagation();
    if (event.inputType !== "insertParagraph" && event.inputType !== "insertLineBreak") return;
    event.preventDefault();
    insertPlainText("\n", event.inputType);
  };

  const onPaste = (event) => {
    event.stopPropagation();
    const text = event.clipboardData?.getData("text/plain");
    if (text == null) return;
    event.preventDefault();
    insertPlainText(text.replace(/\r\n?/g, "\n"), "insertFromPaste");
  };

  const onDrop = (event) => {
    event.stopPropagation();
    const text = event.dataTransfer?.getData("text/plain");
    if (!text) return;
    event.preventDefault();
    root.focus({ preventScroll: true });
    insertPlainText(text.replace(/\r\n?/g, "\n"), "insertFromDrop");
  };

  const onInputNormalize = () => normalizePlainTextDom(root, state);
  const onKeyDown = (event) => {
    event.stopPropagation();
    if ((event.ctrlKey || event.metaKey) && !event.altKey && String(event.key).toLowerCase() === "a") {
      event.preventDefault();
      root.select();
    }
  };
  root.addEventListener("beforeinput", onBeforeInput);
  root.addEventListener("paste", onPaste);
  root.addEventListener("drop", onDrop);
  root.addEventListener("input", onInputNormalize);
  const onKeyBubbleStop = (event) => event.stopPropagation();
  root.addEventListener("keydown", onKeyDown);
  root.addEventListener("keyup", onKeyBubbleStop);
  root.addEventListener("keypress", onKeyBubbleStop);

  return () => {
    document.removeEventListener("selectionchange", onSelectionChange);
    root.removeEventListener("beforeinput", onBeforeInput);
    root.removeEventListener("paste", onPaste);
    root.removeEventListener("drop", onDrop);
    root.removeEventListener("input", onInputNormalize);
    root.removeEventListener("keydown", onKeyDown);
    root.removeEventListener("keyup", onKeyBubbleStop);
    root.removeEventListener("keypress", onKeyBubbleStop);
  };
}

export function upgradeEditorSurface(original) {
  if (!original || !supportsSingleSurfaceEditor()) {
    return { element: original, mode: "textarea-overlay", nativeHighlights: false, cleanup() {} };
  }

  const editor = document.createElement("div");
  editor.className = original.className;
  for (const attr of original.attributes) {
    if (attr.name === "class") continue;
    editor.setAttribute(attr.name, attr.value);
  }
  editor.removeAttribute("spellcheck");
  // ComfyUI's current keybinding guard recognizes contentEditable === "true" as a text
  // input, but not the standards-valid "plaintext-only" value. Keep this surface
  // explicitly "true" and enforce plain text ourselves in beforeinput/paste/drop so
  // Backspace, printable keys, and sidebar shortcuts never escape into the canvas.
  editor.setAttribute("contenteditable", "true");
  editor.setAttribute("spellcheck", original.spellcheck ? "true" : "false");
  editor.setAttribute("role", "textbox");
  editor.setAttribute("aria-multiline", "true");
  editor.setAttribute("autocapitalize", "off");
  editor.setAttribute("autocomplete", "off");
  editor.dataset.ppEditorSurface = "single";
  editor.dataset.ppEditorId = `pp-editor-${++surfaceCounter}`;
  editor.textContent = String(original.value || "") + EDITOR_SENTINEL;
  original.replaceWith(editor);
  const cleanupCompatibility = installTextareaCompatibility(editor);

  return {
    element: editor,
    mode: "single-surface",
    nativeHighlights: true,
    cleanup() { cleanupCompatibility(); },
  };
}
