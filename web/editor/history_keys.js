// Shared Ctrl/Cmd+Z, Ctrl/Cmd+Y and Ctrl/Cmd+Shift+Z detection for Prompt Palette text editors.
//
// The logical `event.key` is authoritative whenever it is a Latin letter, so layouts that swap
// Z and Y (QWERTZ) or move letters around (AZERTY) keep the shortcut the user actually typed.
// The physical `event.code` (KeyZ / KeyY) is the fallback when the layout cannot produce a Latin
// letter with Ctrl held: Cyrillic, Greek, Hebrew and Arabic letters, or an unidentified key.
// A layout that put ASCII punctuation or a digit on that key (Dvorak's `;` on KeyZ) is left
// alone, because that key press is not a Z or Y.
const LATIN_LETTER = /^[a-z]$/;
const ASCII_SYMBOL = /^[\x20-\x7e]$/;

export function historyShortcut(event) {
  if (!event || event.isComposing || event.keyCode === 229 || event.altKey || !(event.ctrlKey || event.metaKey)) return "";
  const name = String(event.key || "").toLowerCase();
  let letter = "";
  if (LATIN_LETTER.test(name)) letter = name;
  else if (!ASCII_SYMBOL.test(name)) letter = event.code === "KeyZ" ? "z" : event.code === "KeyY" ? "y" : "";
  if (letter === "z") return event.shiftKey ? "redo" : "undo";
  if (letter === "y") return "redo";
  return "";
}
