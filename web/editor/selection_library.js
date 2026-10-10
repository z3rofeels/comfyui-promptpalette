import { API } from "../prompt_palette_api.js";
import { normalizeLibraryEntryPath } from "./text_utils.js";
import { dialogPrompt, dialogConfirm } from "./dialogs.js";
import { notify } from "./notifications.js";

export function selectionListContent(selected) {
  const parts = [], stack = [];
  let current = "", escaped = false;
  const closing = { "(": ")", "{": "}", "[": "]" };
  for (const char of String(selected).replace(/\r\n?/g, "\n")) {
    if (escaped) { current += char; escaped = false; continue; }
    if (char === "\\") { current += char; escaped = true; continue; }
    if (closing[char]) stack.push(closing[char]);
    else if (char === stack.at(-1)) stack.pop();
    if ((char === "," || char === "\n") && !stack.length) {
      if (current.trim()) parts.push(current.trim());
      current = "";
    } else current += char === "\n" ? " " : char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts.join("\n");
}

// One library-save operation for every prompting surface. List saves retain the
// prompt; entry saves replace only the captured range, while it is still current.
export async function saveEditorSelection(editor, start, end, {
  list = false, defaultValue = "", hasPath = null, onSaved = null,
} = {}) {
  const source = editor.value;
  const selected = source.slice(start, end).trim();
  const content = list ? selectionListContent(selected) : selected;
  if (!content) return;
  const raw = await dialogPrompt({
    title: list ? "Save as list" : "Save to My Library",
    message: list ? "Choose a My Library path for this tag list:" : 'Choose a My Library path (for example, "poses/playful_foxes"):',
    defaultValue: list ? "lists/new_list" : defaultValue,
  });
  if (raw == null) return;
  const path = normalizeLibraryEntryPath(raw);
  if (!path) { notify("error", "Library entry not saved", "Enter a valid path using letters, numbers, - _ or /."); return; }
  // A cached list or capped search can miss a file edited outside this UI.
  const existing = await API.content(path, { fresh: true });
  if (existing?.found && !await dialogConfirm({ title: "Overwrite Library Entry", message: `"${path}" already exists — overwrite it?` })) return;
  const result = await API.save(path, content);
  if (!result.ok) { notify("error", "Library entry not saved", result.error || "save failed"); return; }
  await onSaved?.(path);
  if (!list && editor.isConnected && editor.value === source) {
    editor.setRangeText(`__${path}__`, start, end, "end");
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    editor.focus({ preventScroll: true });
  }
  notify("success", list ? "Saved list" : "Saved to My Library", list ? `${content.split("\n").length} tags → __${path}__` : `${selected.slice(0, 40)} → __${path}__`);
  return path;
}
