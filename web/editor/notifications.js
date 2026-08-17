import { app } from "../../../scripts/app.js";

export function notify(severity, summary, detail) {
  try {
    app.extensionManager.toast.add({
      severity,
      summary,
      detail,
      life: severity === "error" ? 5000 : 3000,
    });
  } catch {
    if (severity === "error") console.error(`Prompt Palette: ${summary}: ${detail}`);
  }
}
