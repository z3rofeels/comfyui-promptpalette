import { app } from "../../../scripts/app.js";
import { copyPromptPaletteThemeScope, installPromptPaletteKeyboardBoundary } from "../prompt_palette_shared.js";


let openDialogCount = 0;
const activeChoiceDialogs = new Set();
function isDialogOpen() { return openDialogCount > 0; }
async function dialogPrompt(opts) {
  openDialogCount++;
  try { return await app.extensionManager.dialog.prompt(opts); }
  finally { openDialogCount--; }
}
async function dialogConfirm(opts) {
  openDialogCount++;
  try { return await app.extensionManager.dialog.confirm(opts); }
  finally { openDialogCount--; }
}
function dialogChoice({ title, message, choices }) {
  openDialogCount++;
  return new Promise((resolve) => {
    let finished = false;
    const overlay = document.createElement("div");
    overlay.className = "wg-choice-backdrop wg-root";
    overlay.dataset.promptPaletteGlobal = "true";
    const scope = document.activeElement?.closest?.(".wg-root, .wg-node, .pp-node, .ppwc-surface");
    if (scope) copyPromptPaletteThemeScope(scope, overlay);
    const cleanupKeyboardBoundary = installPromptPaletteKeyboardBoundary(overlay);
    const panel = document.createElement("div");
    panel.className = "wg-choice-dialog";
    panel.setAttribute("role", "alertdialog");
    panel.setAttribute("aria-modal", "true");
    const heading = document.createElement("strong");
    heading.textContent = title;
    const copy = document.createElement("p");
    copy.textContent = message;
    const actions = document.createElement("div");
    actions.className = "wg-choice-actions";
    const finish = (value) => {
      if (finished) return;
      finished = true;
      activeChoiceDialogs.delete(finish);
      document.removeEventListener("keydown", onKeyDown, true);
      cleanupKeyboardBoundary();
      overlay.remove();
      openDialogCount--;
      resolve(value);
    };
    const onKeyDown = (event) => {
      if (event.key === "Escape") { event.preventDefault(); finish(null); }
    };
    choices.forEach((choice) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `wg-button${choice.primary ? " primary" : ""}${choice.danger ? " danger-quiet" : ""}`;
      button.textContent = choice.label;
      button.addEventListener("click", () => finish(choice.value));
      actions.appendChild(button);
    });
    panel.append(heading, copy, actions);
    overlay.appendChild(panel);
    overlay.addEventListener("click", (event) => { if (event.target === overlay) finish(null); });
    document.addEventListener("keydown", onKeyDown, true);
    activeChoiceDialogs.add(finish);
    document.body.appendChild(overlay);
    actions.querySelector("button")?.focus();
  });
}


export function cleanupDialogOverlays() {
  for (const finish of [...activeChoiceDialogs]) finish(null);
}

export { dialogPrompt, dialogConfirm, dialogChoice, isDialogOpen };
