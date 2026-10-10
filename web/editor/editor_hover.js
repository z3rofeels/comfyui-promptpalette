import { getCaretCoords } from "./autocomplete.js";
import { scheduleNodeTimer, cancelNodeTimer } from "../prompt_palette_compat.js";

// Ask the browser for the real text position, including wrapping, scrolling and
// canvas zoom. The native textarea fallback uses its existing caret mirror.
export function editorOffsetAtPoint(editor, x, y) {
  if (editor.dataset.ppEditorSurface === "single") {
    const position = document.caretPositionFromPoint?.(x, y);
    const range = position ? null : document.caretRangeFromPoint?.(x, y);
    const node = position?.offsetNode || range?.startContainer;
    const offset = position?.offset ?? range?.startOffset;
    if (!node || !editor.contains(node)) return -1;
    try {
      const prefix = document.createRange();
      prefix.selectNodeContents(editor); prefix.setEnd(node, offset);
      return Math.min(editor.value.length, prefix.toString().length);
    } catch { return -1; }
  }
  const rect = editor.getBoundingClientRect();
  const scaleX = rect.width / (editor.offsetWidth || rect.width) || 1;
  const scaleY = rect.height / (editor.offsetHeight || rect.height) || 1;
  // Convert pointer coordinates to the mirror's untransformed CSS pixels.
  x = rect.left + (x - rect.left) / scaleX;
  y = rect.top + (y - rect.top) / scaleY;
  let low = 0, high = editor.value.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2), caret = getCaretCoords(editor, middle);
    if (y >= caret.top + caret.lineHeight || (y >= caret.top && x > caret.left)) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function bindEditorWildcardHover({ node, editor, getRanges, show, hide, disabled = () => false }) {
  let timer = null;
  const leave = () => { cancelNodeTimer(node, timer); timer = null; hide(); };
  const move = event => {
    if (event.buttons || editor.selectionEnd > editor.selectionStart || disabled()) return leave();
    const offset = editorOffsetAtPoint(editor, event.clientX, event.clientY);
    const token = getRanges().find(range => range.start <= offset && offset < range.end);
    cancelNodeTimer(node, timer);
    if (!token) return leave();
    timer = scheduleNodeTimer(node, () => {
      timer = null;
      if (editor.isConnected && !disabled() && editor.selectionStart === editor.selectionEnd) show(event.clientX, event.clientY, token.name, token.known);
    }, 120);
  };
  editor.addEventListener("mousemove", move);
  for (const event of ["mouseleave", "blur", "pointerdown", "keydown", "contextmenu"]) editor.addEventListener(event, leave);
  return () => {
    leave(); editor.removeEventListener("mousemove", move);
    for (const event of ["mouseleave", "blur", "pointerdown", "keydown", "contextmenu"]) editor.removeEventListener(event, leave);
  };
}
