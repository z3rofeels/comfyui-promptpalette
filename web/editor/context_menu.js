import { escapeHtml } from "./text_utils.js";
import { copyPromptPaletteThemeScope } from "../prompt_palette_shared.js";

let ctxMenu = null;
let ctxMenuOpen = false;
function handleContextDocumentMouseDown(event) {
  if (ctxMenuOpen && !ctxMenu?.contains(event.target)) closeCtxMenu();
}

function ensureCtxMenu() {
  if (ctxMenu) return ctxMenu;
  ctxMenu = document.createElement("div");
  ctxMenu.className = "wg-ctx-menu wg-root";
  ctxMenu.dataset.promptPaletteGlobal = "true";
  document.body.appendChild(ctxMenu);

  document.addEventListener("mousedown", handleContextDocumentMouseDown);
  return ctxMenu;
}

function openCtxMenu(x, y, actions) {
  const menu = ensureCtxMenu();
  const hit = document.elementFromPoint?.(x, y);
  const scope = hit?.closest?.(".wg-root, .wg-node, .pp-node, .ppwc-surface") || document.activeElement?.closest?.(".wg-root, .wg-node, .pp-node, .ppwc-surface");
  if (scope) copyPromptPaletteThemeScope(scope, menu);
  menu.innerHTML = actions.map((a, i) =>
    `<div class="wg-ctx-item" data-index="${i}">${escapeHtml(a.label)}</div>`).join("");
  Array.from(menu.children).forEach((row, i) => {
    row.addEventListener("click", (event) => {
      // The menu lives under document.body rather than inside the node. Keep this
      // click inside Prompt Palette so node-level actions (notably Recipe Builder)
      // are not immediately closed again by the editor's outside-click handler.
      event.preventDefault();
      event.stopPropagation();
      closeCtxMenu();
      actions[i].onSelect();
    });
  });
  menu.style.display = "block";
  ctxMenuOpen = true;

  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  const vw = window.innerWidth, vh = window.innerHeight;
  menu.style.left = Math.max(8, Math.min(x, vw - mw - 8)) + "px";
  menu.style.top = Math.max(8, Math.min(y, vh - mh - 8)) + "px";
}

function closeCtxMenu() {
  if (!ctxMenu) return;
  ctxMenu.style.display = "none";
  ctxMenuOpen = false;
}



export function cleanupContextMenu() {
  closeCtxMenu();
  document.removeEventListener("mousedown", handleContextDocumentMouseDown);
  ctxMenu?.remove();
  ctxMenu = null;
}

export { openCtxMenu, closeCtxMenu, ctxMenuOpen };
