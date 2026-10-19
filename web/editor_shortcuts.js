// Let ComfyUI handle its own queue shortcut exactly once, with the original event.
export function isComfyQueueShortcut(event) {
  return !event.isComposing && event.keyCode !== 229 && !event.altKey
    && (event.ctrlKey || event.metaKey) && event.key === "Enter";
}
