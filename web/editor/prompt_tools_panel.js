import { openLoraSidecar } from "./lora_sidecar.js";
import { API } from "../prompt_palette_api.js";
import { copyPromptPaletteThemeScope, installPromptPaletteKeyboardBoundary, onPromptPaletteAppearanceChanged } from "../prompt_palette_shared.js";
import { compilePromptRule, promptRuleAt, choiceLiteral } from "./prompt_rules.js";
import { syntaxCodeHtml } from "./syntax_presentation.js";
import { analyzePromptSource } from "../prompt_palette_power_tools.js";
import { locateWeightTarget, parseWeightGroup, applyWeightDelta } from "./weight_edit.js";
import { splitTopLevelClauses, openPromptHygieneModal } from "./prompt_hygiene.js";
import { estimateTokensQuick } from "./style_prompt_engine.js";
import { loraTags } from "../engine/lora_tags.js";
import { PresentationScope } from "./sidebar_presentation.js";

const SHARE_PALETTE = [
  "var(--wg-accent, #e5a653)",
  "var(--wg-success, #5ec992)",
  "#5cb8f6",
  "#c389f5",
  "#f08c69",
  "#63cbb8",
];

let activePanel = null;
let panelSequence = 0;
const make = (tag, className = "", text = "") => { const el = document.createElement(tag); if (className) el.className = className; if (text) el.textContent = text; return el; };
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

function readActivePositiveFields(node) {
  const ws = node?._ppRecipeWorkspace;
  if (!ws?.isActive?.()) return null;
  const snap = ws.snapshot?.();
  const fields = snap?.recipe?.fields;
  if (!Array.isArray(fields)) return null;
  return fields
    .filter(f => f && f.enabled !== false && (f.channel || "positive") === "positive")
    .map((f, idx) => ({
      id: f.id,
      label: f.label || f.name || `Field ${idx + 1}`,
      text: String(f.value || ""),
      accent: typeof f.accent === "string" && /^#[0-9a-f]{6}$/i.test(f.accent) ? f.accent : null,
    }));
}

export function openPromptTools(editor, { tab = "rules", range = null } = {}) {
  activePanel?.close();
  if (!editor?.isConnected) return;
  if (tab === "loras") { openLoraSidecar(editor, { range }); return; }
  const context = readContext(editor), canResolve = context.canResolve !== false;
  const canBuild = canBuildPromptRules(editor);
  const canEditWeights = !editor.readOnly && !editor.disabled && editor.getAttribute("aria-readonly") !== "true" && !(editor.dataset.ppEditorSurface === "single" && editor.contentEditable === "false");
  if (!canBuild) tab = "inspect";
  const snapshot = { source: editor.value, start: range?.start ?? editor.selectionStart, end: range?.end ?? editor.selectionEnd, direction: editor.selectionDirection };
  const existing = promptRuleAt(snapshot.source, snapshot.start, snapshot.end);
  const target = existing || snapshot;
  const project = value => context.project?.(value) ?? value;
  let contextSource = project(snapshot.source);
  const sourceOutside = project(snapshot.source.slice(0, target.start) + snapshot.source.slice(target.end));
  let name = "genre", number = 2;
  while (sourceOutside.includes("${" + name + "=")) name = `genre_${number++}`;
  const selectedText = snapshot.source.slice(snapshot.start, snapshot.end).trim();
  let first = "cyberpunk";
  if (selectedText) { try { choiceLiteral(selectedText); first = selectedText; } catch { /* mixed syntax stays selected, never silently rewritten */ } }
  let draft = existing?.draft || { name, mode: "fixed", selected: first, choices: [first, first === "fantasy" ? "cyberpunk" : "fantasy"],
    outputs: { [first]: selectedText ? "" : "neon lighting", fantasy: "soft pastel lighting" }, emit: true, fallback: "" };
  draft.outputs = Object.assign(Object.create(null), draft.outputs);
  let code = "", request = null, version = 0, closed = false, internalEdit = false, scrubInspectTimer = null, lastInspectResult = null;
  const panel = make("dialog", "pp-prompt-tools wg-root"); panel.dataset.promptPaletteGlobal = "true";
  panel.setAttribute("aria-label", "Prompt tools");
  const presentation = new PresentationScope(panel, { scopeAttr: "data-pp-tools-scope", layoutAttr: "data-pp-tools-layout" });
  const scope = editor.closest(".wg-root, .wg-node, .pp-node, .ppwc-surface");
  const updateTheme = () => { if (scope) copyPromptPaletteThemeScope(scope, panel, presentation.declaration(panel, { portal: true })); };
  updateTheme();
  const header = make("header", "pp-tool-header");
  const title = make("div", "pp-tool-title"); title.append(make("span", "pp-tool-eyebrow", "PROMPT PALETTE"), make("h2", "", "Choices & rules"));
  header.append(title, button("×", () => close(), "pp-tool-close")); header.lastChild.setAttribute("aria-label", "Close prompt tools");
  const tabs = make("div", "pp-tool-tabs"); tabs.setAttribute("role", "tablist");
  const rulesTab = button("Choices & rules", () => switchTab("rules")); rulesTab.setAttribute("role", "tab"); rulesTab.hidden = !canBuild;
  const inspectTab = button("Inspector", () => switchTab("inspect")); inspectTab.setAttribute("role", "tab");
  const lorasTab = button("LoRAs", () => { close(); openLoraSidecar(editor, { range }); }); lorasTab.className = "wg-button"; lorasTab.title = "Browse LoRAs beside the editor"; lorasTab.hidden = !canBuild;
  tabs.append(rulesTab, inspectTab); header.insertBefore(lorasTab, header.lastChild);
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
  const inspectIntro = make("p", "pp-tool-intro", (context.project ? "Inspect the compiled prompt channel containing this field. " : "Inspect the visible prompt, token budget share, and clause weights. ") + "Weights describe your instructions; they do not predict the generated image.");
  const encoder = make("div", "pp-tool-encoder");
  encoder.append(make("strong", "", context.weightingMode ? `Formatting: ${context.weightingMode}` : context.clipConnected ? "CLIP input connected · encoder identity unverified" : "No CLIP input connected"));
  encoder.append(make("small", "", context.weightingMode ? "Formatting mode is a user setting, not detection of the connected encoder." : "The connected encoder and workflow determine weighting, embedding support and token limits."));
  const inspectToolbar = make("div", "pp-inspect-toolbar");
  const refresh = button(canResolve ? "Resolve & inspect" : "Inspect text", () => inspect(false), "wg-button pp-tool-primary"); refresh.dataset.toolInspect = "true";
  const tidyShortcutBtn = button("Fix / Tidy prompt…", () => { close(); openPromptHygieneModal(editor, { mode: "tidy" }); });
  tidyShortcutBtn.hidden = !canEditWeights;
  const adaptShortcutBtn = button("Adapt for model…", () => { close(); openPromptHygieneModal(editor, { mode: "adapt" }); });
  adaptShortcutBtn.hidden = !canEditWeights;
  inspectToolbar.append(refresh, tidyShortcutBtn, adaptShortcutBtn);
  const breakdownHost = make("section", "pp-inspect-section pp-breakdown-section");
  const diagnostics = make("div", "pp-tool-diagnostics");
  inspector.append(inspectIntro, encoder, inspectToolbar, breakdownHost, diagnostics);
  body.append(rules, inspector); panel.append(header, tabs, body, status);
  document.body.append(panel);
  const cleanupKeys = installPromptPaletteKeyboardBoundary(panel);
  const unsubscribeTheme = onPromptPaletteAppearanceChanged(updateTheme);
  const observer = new MutationObserver(() => { if (!editor.isConnected) close(); }); observer.observe(document.body, { childList: true, subtree: true });
  const changed = () => {
    if (internalEdit) return;
    if (editor.value !== snapshot.source) {
      abort();
      preview.hidden = true;
      applyButton.disabled = true;
      message("The prompt changed externally. Close this panel and reopen it at the new selection.", true);
    }
  };
  editor.addEventListener("input", changed);
  function message(text, error = false) { status.textContent = text; status.classList.toggle("is-error", error); }
  function abort() { version++; request?.abort(); request = null; refresh.disabled = false; if (scrubInspectTimer) { clearTimeout(scrubInspectTimer); scrubInspectTimer = null; } }
  function close() {
    if (closed) return;
    closed = true; abort(); observer.disconnect(); cleanupKeys(); unsubscribeTheme(); presentation.cleanup(); editor.removeEventListener("input", changed);
    panel.close(); panel.remove(); if (activePanel?.panel === panel) activePanel = null;
    if (editor.isConnected && editor.value === snapshot.source) { editor.focus({ preventScroll: true }); editor.setSelectionRange(snapshot.start, snapshot.end, snapshot.direction); }
  }
  function guard() { if (!editor.isConnected || editor.value !== snapshot.source || project(snapshot.source) !== contextSource) throw new Error("The prompt or workspace changed. Reopen prompt tools to keep your edits safe."); }
  function nextSource() { return snapshot.source.slice(0, target.start) + code + snapshot.source.slice(target.end); }

  function applyClauseScrub(nextText, selStart, selEnd) {
    if (!canEditWeights || !editor.isConnected) return;
    internalEdit = true;
    try {
      if (context.apply) context.apply(nextText, selStart, selEnd);
      else {
        editor.value = nextText;
        editor.setSelectionRange(selStart, selEnd);
        editor.dispatchEvent(new Event("input", { bubbles: true }));
      }
      snapshot.source = editor.value;
      snapshot.start = selStart;
      snapshot.end = selEnd;
      contextSource = project(snapshot.source);
    } finally {
      internalEdit = false;
    }
    renderBreakdownSection(lastInspectResult);
    message("Updated clause weight (Ctrl/Cmd+Z to undo). Refreshing token preview…");
    if (scrubInspectTimer) clearTimeout(scrubInspectTimer);
    scrubInspectTimer = setTimeout(() => {
      scrubInspectTimer = null;
      if (!closed && tab === "inspect") inspect(false);
    }, 180);
  }

  function renderBreakdownSection(result = null) {
    for (const oldStyled of breakdownHost.querySelectorAll("[data-pp-tools-layout]")) {
      presentation.release(oldStyled);
    }
    breakdownHost.replaceChildren();
    breakdownHost.append(
      make("h3", "", "Token & weight breakdown"),
      make("p", "pp-tool-note", "Token share across Fields or clauses (75 CLIP-L tokens per chunk). Step weights in ±0.05 increments without manual parentheses.")
    );

    const activeFields = !context.project ? readActivePositiveFields(context.node) : null;
    const serverFieldTokens = new Map((result?.field_tokens || []).map(f => [f.id, f.tokens]));
    const serverClauseTokens = Array.isArray(result?.clause_tokens) ? result.clause_tokens : [];
    const lorasInPrompt = loraTags(project(snapshot.source));

    const shareItems = [];
    if (activeFields?.length) {
      activeFields.forEach((f, idx) => {
        const exact = serverFieldTokens.get(f.id);
        const count = Number.isFinite(exact) ? exact : estimateTokensQuick(f.text);
        shareItems.push({
          label: `Field ${idx + 1}: ${f.label}`,
          tokens: count,
          estimated: !Number.isFinite(exact),
          color: f.accent || SHARE_PALETTE[idx % SHARE_PALETTE.length],
          onClick: () => {
            close();
            context.node?._ppRecipeWorkspace?.focusField?.(f.id);
          },
        });
      });
    } else {
      const clauses = splitTopLevelClauses(snapshot.source);
      clauses.slice(0, 16).forEach((clause, idx) => {
        const matched = serverClauseTokens.find(c => c.start === clause.start && c.end === clause.end) || serverClauseTokens[idx];
        const count = Number.isFinite(matched?.tokens) ? matched.tokens : estimateTokensQuick(clause.raw);
        const shortLabel = clause.raw.length > 26 ? `${clause.raw.slice(0, 25)}…` : clause.raw;
        shareItems.push({
          label: shortLabel,
          tokens: count,
          estimated: !Number.isFinite(matched?.tokens),
          color: SHARE_PALETTE[idx % SHARE_PALETTE.length],
          onClick: () => {
            close();
            editor.focus({ preventScroll: true });
            editor.setSelectionRange(clause.start, clause.end);
          },
        });
      });
    }

    if (lorasInPrompt.length > 0) {
      shareItems.push({
        label: `LoRAs (${lorasInPrompt.length})`,
        tokens: 0,
        estimated: false,
        isZeroToken: true,
        color: "var(--wg-text-faint, #8f887e)",
      });
    }

    if (shareItems.length > 0) {
      const totalSharedTokens = shareItems.reduce((sum, item) => sum + (item.tokens || 0), 0);
      const barWrap = make("div", "pp-token-share-wrap");
      if (totalSharedTokens > 0) {
        const bar = make("div", "pp-token-share-bar");
        bar.setAttribute("role", "list");
        bar.setAttribute("aria-label", "Token budget share");
        for (const item of shareItems) {
          if (item.tokens <= 0) continue;
          const seg = make("button", "pp-token-share-seg");
          seg.type = "button";
          seg.setAttribute("role", "listitem");
          const pct = Math.round((item.tokens / Math.max(1, totalSharedTokens)) * 100);
          seg.title = `${item.label}: ${item.estimated ? "~" : ""}${item.tokens} tokens (${pct}%)`;
          seg.setAttribute("aria-label", seg.title);
          presentation.set(seg, {
            "--pp-share-grow": String(Math.max(1, item.tokens)),
            "--pp-share-color": item.color,
          });
          if (item.onClick) seg.addEventListener("click", item.onClick);
          bar.append(seg);
        }
        barWrap.append(bar);
      }

      const legend = make("div", "pp-token-share-legend");
      for (const item of shareItems) {
        const pill = make(item.onClick ? "button" : "span", "pp-token-share-pill");
        if (item.onClick) pill.type = "button";
        const dot = make("span", "pp-token-share-dot");
        presentation.set(dot, { "--pp-share-color": item.color });
        const txt = make("span", "pp-token-share-text", `${item.label} ${item.estimated ? "~" : ""}${item.tokens}t`);
        pill.append(dot, txt);
        if (item.onClick) pill.addEventListener("click", item.onClick);
        legend.append(pill);
      }
      barWrap.append(legend);
      breakdownHost.append(barWrap);
    }

    const clauses = splitTopLevelClauses(snapshot.source);
    if (!clauses.length) {
      breakdownHost.append(make("p", "pp-tool-empty", "Type comma-separated clauses or phrases to scrub weights and inspect per-clause tokens."));
      return;
    }

    const scrubberList = make("div", "pp-clause-scrubber-list");
    let runningTokens = 0;
    clauses.slice(0, 48).forEach((clause, idx) => {
      const matched = serverClauseTokens.find(c => c.start === clause.start && c.end === clause.end) || serverClauseTokens[idx];
      const tokCount = Number.isFinite(matched?.tokens) ? matched.tokens : estimateTokensQuick(clause.raw);
      const isEstimated = !Number.isFinite(matched?.tokens);
      runningTokens += tokCount;
      const chunkNum = Math.max(1, Math.ceil(Math.max(1, runningTokens) / 75));

      const rangeTarget = locateWeightTarget(snapshot.source, clause.start, clause.end) || { start: clause.start, end: clause.end };
      const currentSlice = snapshot.source.slice(rangeTarget.start, rangeTarget.end);
      const parsedGroup = parseWeightGroup(currentSlice);
      const currentWeight = parsedGroup?.weight ?? 1;
      const displayPhrase = parsedGroup ? parsedGroup.inner : clause.raw;

      const row = make("div", "pp-clause-row");
      row.dataset.weighted = String(Math.abs(currentWeight - 1) > 1e-6);

      const jumpBtn = make("button", "pp-clause-label", displayPhrase);
      jumpBtn.type = "button";
      jumpBtn.title = "Select this clause in editor";
      jumpBtn.addEventListener("click", () => {
        close();
        editor.focus({ preventScroll: true });
        editor.setSelectionRange(rangeTarget.start, rangeTarget.end);
      });

      const meta = make("div", "pp-clause-meta");
      const tokBadge = make("span", "pp-clause-tokens", `${isEstimated ? "~" : ""}${tokCount}t`);
      tokBadge.title = `Chunk ${chunkNum} · ${isEstimated ? "Estimated" : "CLIP-L"} tokens`;
      const chunkBadge = make("span", `pp-clause-chunk${chunkNum > 1 ? " is-multi" : ""}`, `C${chunkNum}`);
      meta.append(tokBadge, chunkBadge);

      if (canEditWeights && locateWeightTarget(snapshot.source, clause.start, clause.end)) {
        const stepper = make("div", "pp-clause-stepper");
        stepper.setAttribute("role", "group");
        stepper.setAttribute("aria-label", `Weight controls for ${displayPhrase.slice(0, 32)}`);

        const decBtn = button("−", () => {
          const edited = applyWeightDelta(snapshot.source, rangeTarget, -0.05);
          applyClauseScrub(edited.text, edited.start, edited.end);
        }, "pp-weight-step-btn");
        decBtn.title = "Decrease weight by 0.05";
        decBtn.setAttribute("aria-label", "Decrease clause weight by 0.05");

        const resetBtn = button(`${currentWeight.toFixed(2)}×`, () => {
          if (Math.abs(currentWeight - 1) < 1e-6) return;
          const edited = applyWeightDelta(snapshot.source, rangeTarget, 1 - currentWeight);
          applyClauseScrub(edited.text, edited.start, edited.end);
        }, "pp-weight-reset-btn");
        resetBtn.title = Math.abs(currentWeight - 1) < 1e-6 ? "Default weight (1.0)" : "Click to reset clause weight to 1.0";

        const incBtn = button("+", () => {
          const edited = applyWeightDelta(snapshot.source, rangeTarget, 0.05);
          applyClauseScrub(edited.text, edited.start, edited.end);
        }, "pp-weight-step-btn");
        incBtn.title = "Increase weight by 0.05";
        incBtn.setAttribute("aria-label", "Increase clause weight by 0.05");

        stepper.append(decBtn, resetBtn, incBtn);
        meta.append(stepper);
      } else {
        meta.append(make("strong", "pp-weight-value", `${currentWeight.toFixed(2)}×`));
      }

      row.append(jumpBtn, meta);
      scrubberList.append(row);
    });
    breakdownHost.append(scrubberList);
  }

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
      const activeFields = !rulePreview && !context.project ? readActivePositiveFields(context.node) : null;
      previewButton.disabled = refresh.disabled = true; message("Inspecting…");
      const result = await API.inspect(source, current.seed, current.mode, {
        signal: controller.signal,
        resolve: canResolve,
        fields: activeFields,
      });
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
      } else {
        lastInspectResult = result;
        renderBreakdownSection(result);
        renderDiagnostics(result);
      }
      message(current.connectedSeed ? "Preview uses the editor seed. A connected seed is supplied during execution." : canResolve ? "Read-only preview complete. Your prompt and wildcard cursors are unchanged." : "Text inspection complete. Weight Controller formatting and clamping may change its output.");
    } catch (error) { if (!closed && id === version && error.name !== "AbortError") message(error.message || "Inspection failed.", true); }
    finally { if (!closed && id === version) { request = null; previewButton.disabled = !code; refresh.disabled = false; } }
  }
  function renderDiagnostics(result) {
    diagnostics.replaceChildren();
    const section = (title, note = "") => { const box = make("section", "pp-inspect-section"); box.append(make("h3", "", title)); if (note) box.append(make("p", "pp-tool-note", note)); diagnostics.append(box); return box; };
    section(canResolve ? "Resolved prompt" : "Visible text").append(make("pre", "pp-tool-preview", result.resolved));
    if (result.duplicates?.length) {
      const dupSection = section("Duplicate clauses detected", "Case and underscore-normalized duplicates across clauses.");
      for (const dup of result.duplicates) {
        const row = make("div", "pp-inspect-row");
        row.dataset.embeddingStatus = "missing";
        row.append(make("code", "", dup.clause), make("span", "pp-embedding-status", dup.reason || "Duplicate"));
        dupSection.append(row);
      }
      if (canEditWeights) {
        const fixDupBtn = button("Preview Deduplicate & Tidy…", () => { close(); openPromptHygieneModal(editor, { mode: "tidy" }); }, "wg-button");
        dupSection.append(fixDupBtn);
      }
    }
    const weights = section("Explicit numeric weights", result.weight_note || "Authored weights, not measured attention.");
    if (!result.weights?.length) weights.append(make("p", "pp-tool-empty", "No explicit numeric phrase weights."));
    else for (const item of result.weights) { const row = make("div", "pp-inspect-row"); row.append(make("span", "pp-inspect-term", item.text), make("strong", "pp-weight-value", `×${Number(item.weight).toLocaleString(undefined, { maximumFractionDigits: 4 })}`)); weights.append(row); }
    if (result.loras?.length) {
      const loraSection = section("Resolved LoRA tags (pre-flight)", "Availability checked against ComfyUI's loras folder. Auto/Bypass applies these during execution.");
      for (const item of result.loras) {
        const row = make("div", "pp-inspect-row");
        row.dataset.embeddingStatus = item.status === "found" ? "found" : "missing";
        const statusLabel = item.status === "found" ? "File found" : item.status === "ambiguous" ? "Ambiguous name" : "Missing file";
        row.append(make("code", "", `${item.name} · model ${item.model_strength} / CLIP ${item.clip_strength}`), make("span", "pp-embedding-status", statusLabel));
        loraSection.append(row);
      }
    }
    const embeddings = section("Textual inversion embeddings (pre-flight)", "File availability checked against ComfyUI's embeddings folder.");
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
    if (next === "rules") refreshDraft();
    else {
      renderBreakdownSection(lastInspectResult);
      if (!lastInspectResult) inspect(false);
      else message("Ready to inspect the visible prompt.");
    }
  }
  tabs.addEventListener("keydown", event => {
    if (!canBuild || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? "rules" : event.key === "End" ? "inspect" : tab === "rules" ? "inspect" : "rules";
    switchTab(next); (next === "rules" ? rulesTab : inspectTab).focus();
  });
  panel.addEventListener("cancel", event => { event.preventDefault(); close(); });
  panel.addEventListener("click", event => { if (event.target === panel) { const rect = panel.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close(); } });
  activePanel = { editor, panel, close };
  renderMappings(); switchTab(tab); panel.showModal();
  if (tab === "inspect") refresh.focus(); else pickerField.hidden ? nameInput.focus() : picker.focus();
}
