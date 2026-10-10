import { API } from "../prompt_palette_api.js";
import { copyPromptPaletteThemeScope, installPromptPaletteKeyboardBoundary, onPromptPaletteAppearanceChanged } from "../prompt_palette_shared.js";
import { trackDialog } from "./dialogs.js";
import { notify } from "./notifications.js";

let activeImport = null;
const element = (tag, className = "", text = "") => { const el = document.createElement(tag); el.className = className; el.textContent = text; return el; };

export function attachImageImport({ node, root, getState, apply }) {
  const input = element("input"); input.type = "file"; input.accept = "image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp";
  input.hidden = true; root.append(input);
  let disposed = false, closePanel = null;
  const pick = () => { if (!disposed) { input.value = ""; input.click(); } };
  function open(file) {
    if (disposed || !root.isConnected) return;
    activeImport?.();
    const snapshot = getState();
    const request = new AbortController();
    const panel = element("dialog", "pp-prompt-tools pp-image-import wg-root"); panel.dataset.promptPaletteGlobal = "true";
    panel.setAttribute("aria-label", "Import prompt from image");
    const header = element("header", "pp-tool-header");
    const title = element("div", "pp-tool-title"); title.append(element("span", "pp-tool-eyebrow", "PROMPT PALETTE"), element("h2", "", "Import prompt from image")); header.append(title);
    const closeButton = element("button", "wg-button", "Close"); closeButton.type = "button"; header.append(closeButton);
    const fileName = element("p", "pp-tool-note", file.name);
    const status = element("p", "pp-tool-status", "Reading prompt metadata…"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
    const controls = element("div", "pp-tool-grid");
    const recordSelect = element("select"), resultSelect = element("select"), mode = element("select");
    const field = (label, control) => { const el = element("label", "pp-tool-field"); control.setAttribute("aria-label", label); el.append(element("span", "", label), control); controls.append(el); return el; };
    const recordField = field("Prompt record", recordSelect), resultField = field("Batch result", resultSelect);
    field("Prompt version", mode);
    const negativeToggle = element("input"); negativeToggle.type = "checkbox"; negativeToggle.checked = true;
    const negativeLabel = element("label", "pp-image-negative"); negativeLabel.append(negativeToggle, document.createTextNode(" Import negative prompt"));
    const positive = element("pre", "pp-image-preview"), negative = element("pre", "pp-image-preview");
    positive.setAttribute("aria-label", "Recovered positive prompt"); negative.setAttribute("aria-label", "Recovered negative prompt");
    const actions = element("div", "pp-tool-actions pp-tool-footer"), importButton = element("button", "wg-button pp-tool-primary", "Replace prompts"), choose = element("button", "wg-button", "Choose image");
    importButton.type = choose.type = "button"; importButton.disabled = true;
    actions.append(choose, importButton);
    const body = element("div", "pp-tool-body");
    body.append(fileName, controls, element("strong", "", "Positive"), positive, negativeLabel, negative,
      element("p", "pp-tool-note", "Preview first. Import replaces editor text in one undo step. Your current seed, prefixes, suffixes and connected inputs stay active."));
    panel.append(header, body, status, actions);
    const updateTheme = () => copyPromptPaletteThemeScope(root, panel);
    updateTheme(); const offTheme = onPromptPaletteAppearanceChanged(updateTheme), offKeys = installPromptPaletteKeyboardBoundary(panel);
    let closed = false, records = [], selectedPair = null;
    const release = trackDialog(close);
    function close() {
      if (closed) return;
      closed = true; request.abort(); offTheme(); offKeys(); release(); panel.close(); panel.remove();
      button?.classList.remove("active"); button?.setAttribute("aria-expanded", "false");
      if (activeImport === close) activeImport = null;
      if (closePanel === close) closePanel = null;
    }
    activeImport = closePanel = close;
    function option(select, value, label) { const el = element("option", "", label); el.value = String(value); select.append(el); return el; }
    function paint() {
      const record = records[Number(recordSelect.value)];
      const result = resultSelect.value === "" ? null : record?.results?.[Number(resultSelect.value)];
      selectedPair = mode.value === "authored" ? result?.authored || record?.authored : result;
      const available = !!selectedPair;
      positive.textContent = selectedPair?.positive ?? "Choose a batch result to preview.";
      negative.textContent = selectedPair?.has_negative ? selectedPair.negative : "No negative metadata — your existing negative stays unchanged.";
      negativeToggle.disabled = !selectedPair?.has_negative;
      importButton.disabled = !available;
      importButton.textContent = selectedPair?.has_negative && negativeToggle.checked ? "Replace both prompts" : "Replace positive prompt";
      status.textContent = `${record?.source || ""}${record?.truncated ? " · The saved metadata contains only part of the batch." : ""}`;
      status.classList.remove("is-error");
    }
    function chooseRecord() {
      const record = records[Number(recordSelect.value)];
      resultSelect.replaceChildren(); mode.replaceChildren();
      if (record.results.length > 1) option(resultSelect, "", "Choose a batch result");
      record.results.forEach((result, index) => option(resultSelect, index, result.label));
      // Empty is a placeholder, not result zero.
      if (record.results.length > 1) resultSelect.selectedIndex = 0;
      resultField.hidden = record.results.length < 2;
      if (record.authored || record.results.some(result => result.authored)) option(mode, "authored", "Authored template");
      if (record.results.length) option(mode, "resolved", "Resolved prompt");
      paint();
    }
    recordSelect.addEventListener("change", chooseRecord); resultSelect.addEventListener("change", paint); mode.addEventListener("change", paint); negativeToggle.addEventListener("change", paint);
    closeButton.addEventListener("click", close); choose.addEventListener("click", pick);
    panel.addEventListener("cancel", event => { event.preventDefault(); close(); });
    importButton.addEventListener("click", () => {
      if (!selectedPair || closed) return;
      if (disposed || !root.isConnected || getState() !== snapshot) { status.textContent = "The prompt or workspace changed. Choose the image again to import into the current draft."; status.classList.add("is-error"); importButton.disabled = true; return; }
      try { apply({ positive: selectedPair.positive, negative: selectedPair.negative, hasNegative: selectedPair.has_negative && negativeToggle.checked }); close(); queueMicrotask(() => { if (!disposed) node._ppRecipeWorkspace?.focusEditingSurface(); }); }
      catch (error) { status.textContent = error?.message || String(error); status.classList.add("is-error"); }
    });
    document.body.append(panel); panel.showModal();
    button?.classList.add("active"); button?.setAttribute("aria-expanded", "true");
    API.importImagePrompts(file, { signal: request.signal }).then(data => {
      if (closed || disposed || !root.isConnected) return;
      records = data.records || [];
      if (!records.length) throw new Error("No prompt records were found.");
      records.forEach((record, index) => option(recordSelect, index, record.label));
      recordField.hidden = records.length < 2; chooseRecord();
    }).catch(error => { if (!closed && error.name !== "AbortError") { status.textContent = error?.message || String(error); status.classList.add("is-error"); } });
  }
  input.addEventListener("change", () => { if (input.files?.[0]) open(input.files[0]); });
  const dropTarget = event => {
    const editor = event.target.closest?.('[data-pp-editor-surface], textarea[data-el="textarea"], .pp-recipe-workspace textarea.wg-textarea');
    return editor && !editor.readOnly && !editor.disabled && editor.contentEditable !== "false";
  };
  const imageDrop = event => {
    if (!dropTarget(event)) return false;
    return Array.from(event.dataTransfer?.files || []).some(file => /^image\/(png|jpeg|webp)$/i.test(file.type) || /\.(png|jpe?g|webp)$/i.test(file.name));
  };
  const dragover = event => {
    if (dropTarget(event) && Array.from(event.dataTransfer?.types || []).includes("Files")) { event.preventDefault(); event.stopPropagation(); }
  };
  const drop = event => {
    if (!imageDrop(event)) return;
    event.preventDefault(); event.stopPropagation();
    const files = Array.from(event.dataTransfer.files);
    if (files.length !== 1) { notify("info", "Import prompt", "Choose one image to import."); return; }
    open(files[0]);
  };
  const button = root.querySelector('[data-act="importImage"]'); button?.addEventListener("click", pick);
  root.addEventListener("dragover", dragover, true); root.addEventListener("drop", drop, true);
  node._ppOpenImageImport = pick;
  return () => { disposed = true; closePanel?.(); input.remove(); button?.removeEventListener("click", pick); root.removeEventListener("dragover", dragover, true); root.removeEventListener("drop", drop, true); delete node._ppOpenImageImport; };
}
