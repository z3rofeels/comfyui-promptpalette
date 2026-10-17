import { observeEditorSelection } from "./editor_selection.js";
let surfaceCounter = 0;
const EDITOR_SENTINEL = "\u200b";

function logicalText(root) {
  const text = String(root?.textContent || "");
  return text.endsWith(EDITOR_SENTINEL) ? text.slice(0, -1) : text;
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
    const length = logicalLength(root);
    const anchor = Math.min(anchorRaw.length, length);
    const focus = Math.min(focusRaw.length, length);
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
    if (target <= consumed + node.data.length) return { node, offset: target - consumed };
    consumed += node.data.length;
    node = walker.nextNode();
  }
  if (lastText) {
    return { node: lastText, offset: lastText.data.length };
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
  if (onlyChild?.nodeType === Node.TEXT_NODE && raw.endsWith(EDITOR_SENTINEL)) return;
  const current = readLiveSelection(root, state.start, state.end);
  // Slow-path only: normal typing, Enter and paste stay in a single text node.
  const rawText = String(root.innerText || root.textContent || "").replace(/\r\n?/g, "\n");
  const text = rawText.endsWith(EDITOR_SENTINEL) ? rawText.slice(0, -1) : rawText;
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
      const text = String(value ?? "").replace(/\r\n?/g, "\n");
      // A projection refresh must not replace the live text node, move the caret
      // or interrupt an IME composition when the value has not changed.
      if (text === logicalText(root)) return;
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
    applySelection();
  };

  root.select = () => root.setSelectionRange(0, root.value.length, "forward");

  root.setRangeText = (replacement, start = root.selectionStart, end = root.selectionEnd, selectionMode = "preserve") => {
    const source = root.value;
    const safeStart = clampOffset(Math.min(start, end), source.length);
    const safeEnd = clampOffset(Math.max(start, end), source.length);
    const insert = String(replacement ?? "").replace(/\r\n?/g, "\n");
    // The value setter updates the same state object returned by refreshSelection.
    const oldSelection = { ...refreshSelection() };
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

  let correctingSelection = false, pointerSelecting = false, selectionFrame = 0;
  const onSelectionChange = () => {
    const selection = window.getSelection?.();
    // Replacing a native range while the mouse is down resets Chromium's drag
    // anchor. A click after the final __ can land beyond our zero-width marker;
    // clamp the public offsets now, but leave that live gesture untouched.
    if (!selectionBelongsTo(root, selection) || correctingSelection || pointerSelecting) return;
    const current = refreshSelection();
    try {
      const anchorRange = document.createRange();
      anchorRange.selectNodeContents(root);
      anchorRange.setEnd(selection.anchorNode, selection.anchorOffset);
      const focusRange = document.createRange();
      focusRange.selectNodeContents(root);
      focusRange.setEnd(selection.focusNode, selection.focusOffset);
      const crossedSentinel = anchorRange.toString().length > root.value.length || focusRange.toString().length > root.value.length;
      if (crossedSentinel) {
        correctingSelection = true;
        setLiveSelection(root, current.start, current.end, current.direction);
        queueMicrotask(() => { correctingSelection = false; });
      }
    } catch { /* selection is still safely clamped by the compatibility getters */ }
  };
  const cleanupSelection = observeEditorSelection(root, onSelectionChange);
  const finishPointerSelection = () => {
    pointerSelecting = false;
    document.removeEventListener("pointerup", finishPointerSelection, true);
    document.removeEventListener("pointercancel", finishPointerSelection, true);
    document.removeEventListener("mouseup", finishPointerSelection, true);
    window.removeEventListener("blur", finishPointerSelection);
    if (selectionFrame) cancelAnimationFrame(selectionFrame);
    selectionFrame = requestAnimationFrame(() => { selectionFrame = 0; onSelectionChange(); });
  };
  const startPointerSelection = event => {
    event.stopPropagation();
    if (event.button !== 0) return;
    if (selectionFrame) cancelAnimationFrame(selectionFrame);
    selectionFrame = 0; pointerSelecting = true;
    document.addEventListener("pointerup", finishPointerSelection, true);
    document.addEventListener("pointercancel", finishPointerSelection, true);
    document.addEventListener("mouseup", finishPointerSelection, true);
    window.addEventListener("blur", finishPointerSelection);
  };
  const stopPointerBubble = event => { if (pointerSelecting) event.stopPropagation(); };

  const insertPlainText = (text, inputType = "insertText") => {
    const start = root.selectionStart;
    const end = root.selectionEnd;
    root.setRangeText(text, start, end, "end");
    root.dispatchEvent(new InputEvent("input", { bubbles: true, inputType, data: text }));
  };

  const onSurfaceClick = (event) => {
    if (event.button != null && event.button !== 0) return;
    if (event.target !== root) return;
    // Clicking the empty padding/gutter of a contenteditable can produce a DOM
    // selection anchored to the root element instead of a text node. That leaves
    // subsequent typing/selection feeling inert in Nodes 2. Put a real caret at the
    // nearest safe boundary without touching clicks that already landed in text.
    queueMicrotask(() => {
      if (document.activeElement !== root) root.focus({ preventScroll: true });
      const selection = window.getSelection?.();
      if (selectionBelongsTo(root, selection) && (!selection.isCollapsed || selection.anchorNode?.nodeType === Node.TEXT_NODE)) return;
      const end = root.value.length;
      root.setSelectionRange(end, end);
    });
  };

  const onBeforeInput = (event) => {
    event.stopPropagation();
    onSelectionChange();
    if (event.inputType?.startsWith("format")) { event.preventDefault(); return; }
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

  const onCopyCut = (event) => {
    event.stopPropagation();
    const start = root.selectionStart, end = root.selectionEnd;
    if (end <= start || !event.clipboardData) return;
    event.preventDefault();
    event.clipboardData.setData("text/plain", root.value.slice(start, end));
    if (event.type === "cut") insertPlainText("", "deleteByCut");
  };

  const onDrop = (event) => {
    event.stopPropagation();
    const text = event.dataTransfer?.getData("text/plain");
    if (!text) return;
    event.preventDefault();
    root.focus({ preventScroll: true });
    insertPlainText(text.replace(/\r\n?/g, "\n"), "insertFromDrop");
  };

  const onInputNormalize = event => { if (!event.isComposing) normalizePlainTextDom(root, state); };
  const onCompositionEnd = () => normalizePlainTextDom(root, state);
  const onFocusSelection = () => { if (!pointerSelecting) setLiveSelection(root, state.start, state.end, state.direction); };
  const onKeyDown = (event) => {
    if (event.key !== "Escape") event.stopPropagation();
    if ((event.ctrlKey || event.metaKey) && !event.altKey && String(event.key).toLowerCase() === "a") {
      event.preventDefault();
      root.select();
    }
  };
  root.addEventListener("click", onSurfaceClick);
  root.addEventListener("pointerdown", startPointerSelection);
  root.addEventListener("mousedown", startPointerSelection);
  root.addEventListener("pointermove", stopPointerBubble);
  root.addEventListener("mousemove", stopPointerBubble);
  root.addEventListener("focus", onFocusSelection);
  root.addEventListener("blur", refreshSelection);
  root.addEventListener("beforeinput", onBeforeInput);
  root.addEventListener("paste", onPaste);
  root.addEventListener("copy", onCopyCut);
  root.addEventListener("cut", onCopyCut);
  root.addEventListener("compositionend", onCompositionEnd);
  root.addEventListener("drop", onDrop);
  root.addEventListener("input", onInputNormalize);
  const onKeyBubbleStop = (event) => event.stopPropagation();
  root.addEventListener("keydown", onKeyDown);
  root.addEventListener("keyup", onKeyBubbleStop);
  root.addEventListener("keypress", onKeyBubbleStop);

  return () => {
    if (selectionFrame) cancelAnimationFrame(selectionFrame);
    document.removeEventListener("pointerup", finishPointerSelection, true);
    document.removeEventListener("pointercancel", finishPointerSelection, true);
    document.removeEventListener("mouseup", finishPointerSelection, true);
    window.removeEventListener("blur", finishPointerSelection);
    root.removeEventListener("pointerdown", startPointerSelection);
    root.removeEventListener("mousedown", startPointerSelection);
    root.removeEventListener("pointermove", stopPointerBubble);
    root.removeEventListener("mousemove", stopPointerBubble);
    cleanupSelection();
    root.removeEventListener("click", onSurfaceClick);
    root.removeEventListener("focus", onFocusSelection);
    root.removeEventListener("blur", refreshSelection);
    root.removeEventListener("beforeinput", onBeforeInput);
    root.removeEventListener("paste", onPaste);
    root.removeEventListener("copy", onCopyCut);
    root.removeEventListener("cut", onCopyCut);
    root.removeEventListener("compositionend", onCompositionEnd);
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
  // Some ComfyUI frontends skip graph-level undo only when the focused element reports
  // `type === "textarea"`. This surface is a contenteditable div (for syntax highlighting),
  // so expose the same marker without changing how it is edited.
  Object.defineProperty(editor, "type", { configurable: true, enumerable: true, writable: true, value: "textarea" });
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
