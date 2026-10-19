import { app } from "../../../scripts/app.js";

export function notify(severity, summary, detail) {
  try {
    const toast = app.extensionManager?.toast;
    const method = severity === "warn" ? "warning" : severity;
    const duration = severity === "error" ? 5000 : 3000;
    // Current ComfyUI exposes typed methods; retain the legacy bridge for older Desktop builds.
    if (typeof toast?.[method] === "function") {
      toast[method](summary, { description: detail, duration });
    } else if (typeof toast?.add === "function") {
      toast.add({ severity: method === "warning" ? "warn" : severity, summary, detail, life: duration });
    } else if (severity === "error") console.error(`Prompt Palette: ${summary}: ${detail}`);
  } catch {
    if (severity === "error") console.error(`Prompt Palette: ${summary}: ${detail}`);
  }
}
