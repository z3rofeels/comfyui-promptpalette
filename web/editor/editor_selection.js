// One document selection listener shared by all Prompt Palette editor instances.
const owners = new Map();
let previous = null;
function changed() {
  const current = document.activeElement;
  if (previous !== current) owners.get(previous)?.forEach(fn => fn());
  previous = current; owners.get(current)?.forEach(fn => fn());
}
export function observeEditorSelection(editor, callback) {
  if (!owners.size) document.addEventListener("selectionchange", changed);
  if (!owners.has(editor)) owners.set(editor, new Set());
  owners.get(editor).add(callback);
  return () => {
    owners.get(editor)?.delete(callback);
    if (!owners.get(editor)?.size) { owners.delete(editor); if (previous === editor) previous = null; }
    if (!owners.size) document.removeEventListener("selectionchange", changed);
  };
}
