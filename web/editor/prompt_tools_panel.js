import { API } from "../prompt_palette_api.js";
import { copyPromptPaletteThemeScope, installPromptPaletteKeyboardBoundary, onPromptPaletteAppearanceChanged } from "../prompt_palette_shared.js";
import { compilePromptRule, promptRuleAt, choiceLiteral } from "./prompt_rules.js";
import { syntaxCodeHtml } from "./syntax_presentation.js";
import { analyzePromptSource } from "../prompt_palette_power_tools.js";

let activePanel = null;
let panelSequence = 0;
const make = (tag, className = "", text = "") => { const el = document.createElement(tag); el.className = className; el.textContent = text; return el; };
function button(text, fn, className = "wg-button") { const el = make("button", className, text); el.type = "button"; el.addEventListener("click", fn); return el; }
function field(label, input, help = "") {
  const el = make("label", "pp-tool-field"); el.append(make("span", "", label), input);
  if (help) el.append(make("small", "", help));
  return el;
}
function select(label, options, value) {
  const el = make("select"); el.setAttribute("aria-label", label);
  for (const [key, text] of options) { const opt = make("option", "", text); opt.value = key; el.append(opt); }
  el.value = value; return el;
}
function readContext(editor) {
  const context = editor.__ppPromptTools || {};
  const node = context.node;
  return { ...context, seed: context.getSeed?.() ?? node?.widgets?.find(w => w.name === "seed")?.value ?? 0,
    mode: context.getMode?.() ?? node?.widgets?.find(w => w.name === "processing_mode")?.value ?? "entire text as one",
    connectedSeed: !!node?.inputs?.some(input => ["seed", "external_seed"].includes(input.name) && input.link != null),
    weightingMode: node?.widgets?.find(w => w.name === "weighting_mode")?.value,
    clipConnected: !!node?.inputs?.some(input => input.name === "clip" && input.link != null) };
}
export function closePromptToolsFor(editor) { if (activePanel?.editor === editor) activePanel.close(); }
export function canBuildPromptRules(editor) {
  return editor.__ppPromptTools?.canResolve !== false && !editor.readOnly && !editor.disabled && editor.getAttribute("aria-readonly") !== "true" && !(editor.dataset.ppEditorSurface === "single" && editor.contentEditable === "false");
}

export function openPromptTools(editor, { tab = "rules", range = null } = {}) {
  activePanel?.close();
  if (!editor?.isConnected) return;
  const context = readContext(editor), canResolve = context.canResolve !== false;
  const canBuild = canBuildPromptRules(editor);
  if (!canBuild) tab = "inspect";
  const snapshot = { source: editor.value, start: range?.start ?? editor.selectionStart, end: range?.end ?? editor.selectionEnd, direction: editor.selectionDirection };
  const existing = promptRuleAt(snapshot.source, snapshot.start, snapshot.end);
  const target = existing || snapshot;
  const project = value => context.project?.(value) ?? value;
  const contextSource = project(snapshot.source);
  const sourceOutside = project(snapshot.source.slice(0, target.start) + snapshot.source.slice(target.end));
  let name = "genre", number = 2;
  while (sourceOutside.includes("${" + name + "=")) name = `genre_${number++}`;
  const selectedText = snapshot.source.slice(snapshot.start, snapshot.end).trim();
  let first = "cyberpunk";
  if (selectedText) { try { choiceLiteral(selectedText); first = selectedText; } catch { /* mixed syntax stays selected, never silently rewritten */ } }
  let draft = existing?.draft || { name, mode: "fixed", selected: first, choices: [first, first === "fantasy" ? "cyberpunk" : "fantasy"],
    outputs: { [first]: selectedText ? "" : "neon lighting", fantasy: "soft pastel lighting" }, emit: true, fallback: "" };
  draft.outputs = Object.assign(Object.create(null), draft.outputs);
  let code = "", request = null, version = 0, closed = false;
  const panel = make("dialog", "pp-prompt-tools wg-root"); panel.dataset.promptPaletteGlobal = "true";
  panel.setAttribute("aria-label", "Prompt tools");
  const scope = editor.closest(".wg-root, .wg-node, .pp-node, .ppwc-surface");
  const updateTheme = () => copyPromptPaletteThemeScope(scope, panel);
  updateTheme();
  const header = make("header", "pp-tool-header");
  const title = make("div", "pp-tool-title"); title.append(make("span", "pp-tool-eyebrow", "PROMPT PALETTE"), make("h2", "", "Choices & rules"));
  header.append(title, button("×", () => close(), "pp-tool-close")); header.lastChild.setAttribute("aria-label", "Close prompt tools");
  const tabs = make("div", "pp-tool-tabs"); tabs.setAttribute("role", "tablist");
  const rulesTab = button("Choices & rules", () => switchTab("rules")); rulesTab.setAttribute("role", "tab"); rulesTab.hidden = !canBuild;
  const inspectTab = button("Inspector", () => switchTab("inspect")); inspectTab.setAttribute("role", "tab");
  tabs.append(rulesTab, inspectTab);
  const body = make("div", "pp-tool-body"), rules = make("section", "pp-rule-builder"), inspector = make("section", "pp-prompt-inspector");
  rules.setAttribute("role", "tabpanel"); inspector.setAttribute("role", "tabpanel");
  const id = `pp-prompt-tools-${++panelSequence}`;
  rules.id = `${id}-rules`; inspector.id = `${id}-inspect`;
  rulesTab.id = `${id}-rules-tab`; inspectTab.id = `${id}-inspect-tab`;
  rulesTab.setAttribute("aria-controls", rules.id); inspectTab.setAttribute("aria-controls", inspector.id);
  rules.setAttribute("aria-labelledby", rulesTab.id); inspector.setAttribute("aria-labelledby", inspectTab.id);
  const status = make("div", "pp-tool-status"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
  const intro = make("p", "pp-tool-intro", "Choose a value, then give each choice its matching prompt. Your rule is saved as editable prompt syntax.");
  const controls = make("div", "pp-tool-grid");
  const nameInput = make("input"); nameInput.value = draft.name; nameInput.setAttribute("aria-label", "Rule variable name"); nameInput.autocomplete = "off";
  const modeInput = select("Choice mode", [["fixed", "Choose here"], ["random", "Seeded choice"], ["existing", "Rules for an existing variable"]], draft.mode);
  const picker = select("Chosen value", draft.choices.map(value => [value, value]), draft.selected);
  const pickerField = field("Chosen value", picker);
  controls.append(field("Variable name", nameInput), field("Choice mode", modeInput), pickerField);
  const choices = make("textarea"); choices.value = draft.choices.join("\n"); choices.rows = 3; choices.setAttribute("aria-label", "Choices, one per line");
  const editChoices = make("details", "pp-tool-details"); editChoices.open = !existing;
  editChoices.append(make("summary", "", "Edit choices"), field("One choice per line", choices, "Plain names here. Wildcards and other prompt syntax belong in the matching output."));
  const mappings = make("div", "pp-rule-mappings");
  const emit = make("input"); emit.type = "checkbox"; emit.checked = draft.emit; emit.setAttribute("aria-label", "Include chosen value in prompt");
  const emitField = make("label", "pp-tool-check"); emitField.append(emit, make("span", "", "Include the chosen value in the prompt"));
  const fallback = make("input"); fallback.value = draft.fallback; fallback.setAttribute("aria-label", "Otherwise output");
  const fallbackField = field("Otherwise", fallback, "Used when the existing variable matches none of these choices.");
  const modeNote = make("p", "pp-tool-note");
  const syntax = make("details", "pp-tool-details"); syntax.append(make("summary", "", "Generated syntax"));
  const sourceCode = make("code", "pp-tool-code"); syntax.append(sourceCode);
  const preview = make("section", "pp-rule-preview"); preview.hidden = true;
  const previewLabel = make("strong"), previewText = make("pre", "pp-tool-preview"); preview.append(previewLabel, previewText);
  const actions = make("div", "pp-tool-actions");
  const previewButton = button("Preview rule", () => inspect(true)); previewButton.dataset.toolPreview = "true";
  const applyButton = button(existing ? "Update rule" : target.end > target.start ? "Replace selection with rule" : "Insert rule", apply, "wg-button pp-tool-primary"); applyButton.dataset.toolApply = "true";
  actions.append(previewButton, applyButton);
  rules.append(intro, controls, editChoices, make("h3", "pp-tool-subtitle", "Matching output"), mappings, fallbackField, emitField, modeNote, syntax, preview, actions);
  const inspectIntro = make("p", "pp-tool-intro", (context.project ? "Inspect the compiled prompt channel containing this field. " : "Inspect the visible prompt without changing it. ") + "Weights describe your instructions; they do not predict the generated image.");
  const encoder = make("div", "pp-tool-encoder");
  encoder.append(make("strong", "", context.weightingMode ? `Formatting: ${context.weightingMode}` : context.clipConnected ? "CLIP input connected · encoder identity unverified" : "No CLIP input connected"));
  encoder.append(make("small", "", context.weightingMode ? "Formatting mode is a user setting, not detection of the connected encoder." : "The connected encoder and workflow determine weighting, embedding support and token limits."));
  const diagnostics = make("div", "pp-tool-diagnostics");
  const refresh = button(canResolve ? "Resolve & inspect" : "Inspect text", () => inspect(false)); refresh.dataset.toolInspect = "true";
  inspector.append(inspectIntro, encoder, refresh, diagnostics);
  body.append(rules, inspector); panel.append(header, tabs, body, status);
  document.body.append(panel);
  const cleanupKeys = installPromptPaletteKeyboardBoundary(panel);
  const unsubscribeTheme = onPromptPaletteAppearanceChanged(updateTheme);
  const observer = new MutationObserver(() => { if (!editor.isConnected) close(); }); observer.observe(document.body, { childList: true, subtree: true });
  const changed = () => { if (editor.value !== snapshot.source) { abort(); preview.hidden = true; applyButton.disabled = true; message("The prompt changed. Close this panel and reopen it at the new selection.", true); } };
  editor.addEventListener("input", changed);
  function message(text, error = false) { status.textContent = text; status.classList.toggle("is-error", error); }
  function abort() { version++; request?.abort(); request = null; refresh.disabled = false; }
  function close() {
    if (closed) return;
    closed = true; abort(); observer.disconnect(); cleanupKeys(); unsubscribeTheme(); editor.removeEventListener("input", changed);
    panel.close(); panel.remove(); if (activePanel?.panel === panel) activePanel = null;
    if (editor.isConnected && editor.value === snapshot.source) { editor.focus({ preventScroll: true }); editor.setSelectionRange(snapshot.start, snapshot.end, snapshot.direction); }
  }
  function guard() { if (!editor.isConnected || editor.value !== snapshot.source || project(snapshot.source) !== contextSource) throw new Error("The prompt or workspace changed. Reopen prompt tools to keep your edits safe."); }
  function nextSource() { return snapshot.source.slice(0, target.start) + code + snapshot.source.slice(target.end); }
  function refreshDraft() {
    abort(); preview.hidden = true; code = "";
    pickerField.hidden = draft.mode !== "fixed"; fallbackField.hidden = draft.mode !== "existing";
    modeNote.textContent = draft.mode === "random" ? "Resolve once, then reuse the same choice. The same seed keeps the result stable; Combinatorial can enumerate the choices."
      : draft.mode === "existing" ? "Assign this variable earlier in the same resolved block. In line-by-line mode, it must be on the same line."
      : "Your chosen value stays fixed until you edit this rule. Other choices stay available when you reopen it.";
    try {
      guard(); code = compilePromptRule(draft);
      if (!canBuildPromptRules(editor)) throw new Error("This is a linked, read-only preview. Edit its recipe fields instead.");
      if (draft.mode !== "existing" && sourceOutside.includes("${" + draft.name.trim() + "=")) throw new Error("That variable is assigned elsewhere. Choose a unique name or use Rules for an existing variable.");
      const invalid = analyzePromptSource({ text: code }).issues.find(issue => issue.severity === "error" && !["missing-wildcard", "unreachable-variable"].includes(issue.code));
      if (invalid) throw new Error(invalid.detail);
      sourceCode.innerHTML = syntaxCodeHtml(code); previewButton.disabled = applyButton.disabled = false;
      message(existing ? "Editing this rule only. Surrounding text stays in place." : target.end > target.start ? `${target.end - target.start} selected characters will be replaced.` : "Insert at the saved cursor position.");
    } catch (error) { sourceCode.textContent = ""; previewButton.disabled = applyButton.disabled = true; message(error.message, true); }
  }
  function renderMappings() {
    mappings.replaceChildren();
    for (const [index, choice] of draft.choices.entries()) {
      const row = make("label", "pp-rule-row");
      const key = make("span", "pp-rule-key"); key.append(make("small", "", index ? "or" : "when"), make("strong", "", choice));
      const input = make("input"); input.value = draft.outputs[choice] || ""; input.placeholder = "No extra text"; input.setAttribute("aria-label", `Output for ${choice}`);
      input.addEventListener("input", () => { draft.outputs[choice] = input.value; refreshDraft(); });
      row.append(key, make("span", "pp-rule-arrow", "→"), input); mappings.append(row);
    }
  }
  choices.addEventListener("input", () => {
    draft.choices = choices.value.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
    if (!draft.choices.includes(draft.selected)) draft.selected = draft.choices[0] || "";
    picker.replaceChildren(); draft.choices.forEach(value => { const opt = make("option", "", value); opt.value = value; picker.append(opt); }); picker.value = draft.selected;
    if (draft.choices.length <= 32) renderMappings(); else mappings.replaceChildren();
    refreshDraft();
  });
  nameInput.addEventListener("input", () => { draft.name = nameInput.value; refreshDraft(); });
  modeInput.addEventListener("change", () => { draft.mode = modeInput.value; refreshDraft(); });
  picker.addEventListener("change", () => { draft.selected = picker.value; refreshDraft(); });
  emit.addEventListener("change", () => { draft.emit = emit.checked; refreshDraft(); });
  fallback.addEventListener("input", () => { draft.fallback = fallback.value; refreshDraft(); });
  async function inspect(rulePreview) {
    abort(); const id = version;
    try {
      guard();
      const current = readContext(editor), controller = request = new AbortController();
      const source = project(rulePreview ? nextSource() : snapshot.source);
      previewButton.disabled = refresh.disabled = true; message("Inspecting…");
      const result = await API.inspect(source, current.seed, current.mode, { signal: controller.signal, resolve: canResolve });
      if (closed || id !== version) return;
      guard();
      const latest = readContext(editor);
      if (latest.seed !== current.seed || latest.mode !== current.mode || latest.connectedSeed !== current.connectedSeed) throw new Error("The seed or processing mode changed. Preview again.");
      if (rulePreview) {
        preview.hidden = false; previewLabel.textContent = current.connectedSeed ? "Editor-seed preview · connected seed may differ" : `Resolved preview · seed ${current.seed}`;
        if (current.mode !== "line by line") {
          const chosen = result.variables?.find(variable => variable.name === draft.name)?.value;
          if (chosen !== undefined) previewLabel.textContent += ` · ${chosen}`;
        }
        previewText.textContent = result.resolved;
      } else renderDiagnostics(result);
      message(current.connectedSeed ? "Preview uses the editor seed. A connected seed is supplied during execution." : canResolve ? "Read-only preview complete. Your prompt and wildcard cursors are unchanged." : "Text inspection complete. Weight Controller formatting and clamping may change its output.");
    } catch (error) { if (!closed && id === version && error.name !== "AbortError") message(error.message || "Inspection failed.", true); }
    finally { if (!closed && id === version) { request = null; previewButton.disabled = !code; refresh.disabled = false; } }
  }
  function renderDiagnostics(result) {
    diagnostics.replaceChildren();
    const section = (title, note = "") => { const box = make("section", "pp-inspect-section"); box.append(make("h3", "", title)); if (note) box.append(make("p", "pp-tool-note", note)); diagnostics.append(box); return box; };
    section(canResolve ? "Resolved prompt" : "Visible text").append(make("pre", "pp-tool-preview", result.resolved));
    const weights = section("Explicit numeric weights", result.weight_note || "Authored weights, not measured attention.");
    if (!result.weights?.length) weights.append(make("p", "pp-tool-empty", "No explicit numeric phrase weights."));
    else for (const item of result.weights) { const row = make("div", "pp-inspect-row"); row.append(make("span", "pp-inspect-term", item.text), make("strong", "pp-weight-value", `×${Number(item.weight).toLocaleString(undefined, { maximumFractionDigits: 4 })}`)); weights.append(row); }
    const embeddings = section("Textual inversion embeddings", "File availability only. Learned vectors are not hidden sentences; encoder compatibility is unverified here.");
    if (!result.embeddings?.length) embeddings.append(make("p", "pp-tool-empty", "No embedding references."));
    else for (const item of result.embeddings) { const row = make("div", "pp-inspect-row"); row.dataset.embeddingStatus = item.status; row.append(make("code", "", item.name), make("span", "pp-embedding-status", item.status === "found" ? "File found" : item.status === "missing" ? "Missing file" : "Availability unknown")); embeddings.append(row); }
    const tokens = section("CLIP-L reference tokens", result.token_note || "Reference tokenizer only; connected encoder identity is not verified.");
    const stats = result.token_stats;
    if (!stats || !Number.isFinite(stats.tokens)) { tokens.append(make("p", "pp-tool-empty", "Reference tokenizer unavailable. Editing and generation still work.")); return; }
    const chunks = make("div", "pp-token-chunks");
    (stats.per_chunk || []).slice(0, 64).forEach((count, index) => { const chip = make("span", "pp-token-chunk", `Chunk ${index + 1} · ${count}/${stats.limit_per_chunk}`); chunks.append(chip); });
    if (stats.per_chunk?.length > 64) chunks.append(make("span", "pp-tool-note", `${stats.per_chunk.length - 64} more chunks.`));
    tokens.append(make("strong", "", `${stats.tokens} text tokens · ${stats.chunks} chunk${stats.chunks === 1 ? "" : "s"}`), chunks, make("p", "pp-tool-note", "A chunk boundary is not a universal prompt cutoff or an importance score."));
    const layout = make("details", "pp-tool-details"); layout.append(make("summary", "", "Token layout"));
    const grid = make("div", "pp-token-layout");
    for (const token of stats.layout || []) { const chip = make("span", "pp-token", token.text); chip.title = `Chunk ${token.chunk} · authored weight ${token.weight}`; chip.dataset.weighted = String(token.weight !== 1); grid.append(chip); }
    if (stats.layout_omitted) grid.append(make("span", "pp-tool-note", `${stats.layout_omitted} more tokens omitted from this display.`));
    layout.append(grid); tokens.append(layout);
  }
  function apply() {
    try {
      guard(); if (!code || applyButton.disabled) return;
      if (!canBuildPromptRules(editor)) throw new Error("This editor is now read-only. Edit its recipe fields instead.");
      const text = nextSource(), end = target.start + code.length;
      close(); editor.focus({ preventScroll: true });
      if (context.apply) context.apply(text, target.start, end);
      else { editor.value = text; editor.setSelectionRange(target.start, end); editor.dispatchEvent(new Event("input", { bubbles: true })); }
    } catch (error) { message(error.message, true); }
  }
  function switchTab(next) {
    abort(); tab = next; rules.hidden = next !== "rules"; inspector.hidden = next !== "inspect";
    rulesTab.setAttribute("aria-selected", String(next === "rules")); inspectTab.setAttribute("aria-selected", String(next === "inspect"));
    rulesTab.tabIndex = next === "rules" ? 0 : -1; inspectTab.tabIndex = next === "inspect" ? 0 : -1;
    title.querySelector("h2").textContent = next === "rules" ? "Choices & rules" : "Prompt inspector";
    if (next === "rules") refreshDraft(); else message("Ready to inspect the visible prompt.");
  }
  tabs.addEventListener("keydown", event => {
    if (!canBuild || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault(); const next = event.key === "Home" ? "rules" : event.key === "End" ? "inspect" : tab === "rules" ? "inspect" : "rules";
    switchTab(next); (next === "rules" ? rulesTab : inspectTab).focus();
  });
  panel.addEventListener("cancel", event => { event.preventDefault(); close(); });
  panel.addEventListener("click", event => { if (event.target === panel) { const rect = panel.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close(); } });
  activePanel = { editor, panel, close };
  renderMappings(); switchTab(tab); panel.showModal();
  if (tab === "inspect") refresh.focus(); else pickerField.hidden ? nameInput.focus() : picker.focus();
}
