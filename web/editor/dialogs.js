import { app } from "../../../scripts/app.js";
import { copyPromptPaletteThemeScope, installPromptPaletteKeyboardBoundary, onPromptPaletteAppearanceChanged } from "../prompt_palette_shared.js";


let openDialogCount = 0;
const activeChoiceDialogs = new Set();
let choiceSequence = 0;
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
    const previousFocus = document.activeElement;
    const selection = Number.isInteger(previousFocus?.selectionStart)
      ? { value: previousFocus.value, start: previousFocus.selectionStart, end: previousFocus.selectionEnd, direction: previousFocus.selectionDirection } : null;
    const overlay = document.createElement("dialog");
    overlay.className = "wg-choice-backdrop wg-root";
    overlay.setAttribute("role", "alertdialog");
    overlay.dataset.promptPaletteGlobal = "true";
    const scope = previousFocus?.closest?.(".wg-root, .wg-node, .pp-node, .ppwc-surface");
    const updateTheme = () => { if (scope) copyPromptPaletteThemeScope(scope, overlay); };
    updateTheme();
    const cleanupTheme = onPromptPaletteAppearanceChanged(updateTheme);
    const cleanupKeyboardBoundary = installPromptPaletteKeyboardBoundary(overlay);
    const panel = document.createElement("div");
    panel.className = "wg-choice-dialog";
    const id = `pp-choice-${++choiceSequence}`;
    const heading = document.createElement("strong");
    heading.textContent = title;
    heading.id = `${id}-title`;
    const copy = document.createElement("p");
    copy.textContent = message;
    copy.id = `${id}-message`;
    overlay.setAttribute("aria-labelledby", heading.id);
    overlay.setAttribute("aria-describedby", copy.id);
    const actions = document.createElement("div");
    actions.className = "wg-choice-actions";
    const finish = (value) => {
      if (finished) return;
      finished = true;
      activeChoiceDialogs.delete(finish);
      cleanupKeyboardBoundary();
      cleanupTheme();
      overlay.close();
      overlay.remove();
      openDialogCount--;
      if (!openDialogCount && previousFocus?.isConnected && !previousFocus.closest?.("[inert]")) {
        previousFocus.focus?.({ preventScroll: true });
        if (selection && previousFocus.value === selection.value) previousFocus.setSelectionRange?.(selection.start, selection.end, selection.direction);
      }
      resolve(value);
    };
    overlay.addEventListener("cancel", (event) => { event.preventDefault(); finish(null); });
    overlay.addEventListener("close", () => finish(null));
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
    activeChoiceDialogs.add(finish);
    document.body.appendChild(overlay);
    overlay.showModal();
    actions.querySelector("button")?.focus();
  });
}


// For Prompt Palette modal surfaces built elsewhere: counts as an open dialog (so global
// shortcuts stay quiet) and gets closed with the rest when the editor is torn down.
// Returns a release function; `close` must be safe to call more than once.
export function trackDialog(close) {
  openDialogCount++;
  activeChoiceDialogs.add(close);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeChoiceDialogs.delete(close);
    openDialogCount--;
  };
}

export function cleanupDialogOverlays() {
  for (const finish of [...activeChoiceDialogs]) finish(null);
}

export { dialogPrompt, dialogConfirm, dialogChoice, isDialogOpen };
