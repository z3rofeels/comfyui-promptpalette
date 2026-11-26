import { LORA_DOCK_HEADER, LORA_DOCK_HEADER_RE, dockLoraText, splitLoraDock, standaloneLoraTags } from "../engine/lora_tags.js";
import { WORKSPACE_SCHEMA, newField, validateWorkspaceRecipe } from "./recipe_workspace_model.js";
import { splitTopLevelClauses } from "./prompt_hygiene.js";
import { svgIcon } from "../prompt_palette_shared.js";
import { notify } from "./notifications.js";

const QUICK_MARKER_RE = /(?:^|\n)\s*Negative prompt:\s*|(?:^|\n)\s*(?:Steps|Sampler|CFG scale|Guidance|Seed|Model):\s*[^\n]+|<lora:[^:<>\r\n]+/i;
const KNOWN_PARAM_KEYS = new Set([
  "steps", "sampler", "schedule type", "scheduler", "cfg scale", "cfg", "guidance",
  "distilled cfg scale", "seed", "size", "model", "model hash", "vae", "vae hash",
  "denoising strength", "clip skip", "ensd", "version", "hashes", "lora hashes",
  "ti hashes", "rng", "hires upscale", "hires steps", "hires upscaler",
]);

export function shouldOfferSmartPaste(text) {
  if (typeof text !== "string" || text.length <= 40) return false;
  return QUICK_MARKER_RE.test(text);
}

function splitParamPairs(line) {
  const pairs = [];
  let depth = 0;
  let inQuotes = false;
  let start = 0;
  for (let i = 0; i <= line.length; i += 1) {
    const ch = i < line.length ? line[i] : ",";
    if (ch === '"' && line[i - 1] !== "\\") inQuotes = !inQuotes;
    else if (!inQuotes) {
      if (ch === "{" || ch === "[" || ch === "(") depth += 1;
      else if ((ch === "}" || ch === "]" || ch === ")") && depth > 0) depth -= 1;
      else if (i === line.length || (ch === "," && depth === 0)) {
        const chunk = line.slice(start, i).trim();
        const colonIdx = chunk.indexOf(":");
        if (colonIdx > 0) {
          const key = chunk.slice(0, colonIdx).trim();
          const val = chunk.slice(colonIdx + 1).trim();
          if (key && val) pairs.push([key, val]);
        }
        start = i + 1;
      }
    }
  }
  return pairs;
}

function isParameterLine(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed) return false;
  if (/^Steps:\s*\d+\b/i.test(trimmed)) return true;
  const pairs = splitParamPairs(trimmed);
  if (!pairs.length) return false;
  const matchedKnown = pairs.filter(([k]) => KNOWN_PARAM_KEYS.has(k.toLowerCase()));
  if (matchedKnown.length >= 2) return true;
  if (pairs.length === 1 && KNOWN_PARAM_KEYS.has(pairs[0][0].toLowerCase()) && /^(?:Steps|Sampler|CFG scale|Seed|Size|Model)$/i.test(pairs[0][0])) {
    return true;
  }
  return false;
}

function extractTrailingParams(text) {
  const lines = text.split("\n");
  // Standard A1111/Civitai block starts on a line with `Steps: N,`
  let paramStartLine = lines.findIndex((ln) => /^\s*Steps:\s*\d+\s*(?:,|$)/i.test(ln));
  if (paramStartLine < 0) {
    // Also support trailing multi-line key: value metadata blocks (e.g. Discord/Civitai cards)
    let idx = lines.length - 1;
    while (idx >= 0 && !lines[idx].trim()) idx -= 1;
    let count = 0;
    while (idx >= 0 && isParameterLine(lines[idx])) {
      count += 1;
      paramStartLine = idx;
      idx -= 1;
    }
    if (count < 2) paramStartLine = -1;
  }

  if (paramStartLine < 0) {
    return { bodyText: text, params: null, rawParamBlock: "" };
  }

  const bodyText = lines.slice(0, paramStartLine).join("\n").replace(/\s+$/, "");
  const rawParamBlock = lines.slice(paramStartLine).join("\n").trim();
  const rawMap = {};
  for (const ln of lines.slice(paramStartLine)) {
    for (const [key, val] of splitParamPairs(ln)) {
      rawMap[key.toLowerCase()] = val.replace(/^"(.*)"$/, "$1");
    }
  }

  const parsedSeed = rawMap.seed && /^\d+$/.test(rawMap.seed) ? rawMap.seed : null;
  const params = {
    steps: rawMap.steps || null,
    sampler: rawMap.sampler || null,
    scheduler: rawMap["schedule type"] || rawMap.scheduler || null,
    cfgScale: rawMap["cfg scale"] || rawMap.cfg || rawMap.guidance || null,
    seed: parsedSeed,
    size: rawMap.size || null,
    model: rawMap.model || null,
    clipSkip: rawMap["clip skip"] || null,
    raw: rawMap,
    rawText: rawParamBlock,
  };
  return { bodyText, params, rawParamBlock };
}

export function parseGenerationPaste(inputText) {
  const normalized = String(inputText ?? "").replace(/\r\n?/g, "\n");
  if (!shouldOfferSmartPaste(normalized)) {
    return {
      positive: normalized,
      dockedPositive: normalized,
      negative: "",
      hasNegative: false,
      loras: [],
      hasUndockedLoras: false,
      params: null,
      hasParams: false,
      isStructured: false,
      summaryLabel: "",
    };
  }

  const { bodyText, params } = extractTrailingParams(normalized);
  const hasParams = Boolean(params && Object.keys(params.raw || {}).length > 0);

  let rawPositive = bodyText;
  let negative = "";
  let hasNegative = false;

  const negMatch = /(?:^|\n)[ \t]*Negative prompt:[ \t]*/i.exec(bodyText);
  if (negMatch) {
    hasNegative = true;
    rawPositive = bodyText.slice(0, negMatch.index).trim();
    negative = bodyText.slice(negMatch.index + negMatch[0].length).trim();
  }

  const dockMatch = LORA_DOCK_HEADER_RE.exec(rawPositive);
  const preDockPart = dockMatch ? rawPositive.slice(0, dockMatch.index) : rawPositive;
  const looseLoras = standaloneLoraTags(preDockPart);
  const hasUndockedLoras = looseLoras.length > 0;
  const dockedPositive = hasUndockedLoras ? dockLoraText(rawPositive) : rawPositive.trim();

  const isStructured = Boolean(
    hasNegative ||
    hasParams ||
    (hasUndockedLoras && dockedPositive !== normalized.trim())
  );

  const actionsDesc = [];
  if (hasNegative) actionsDesc.push("Split Positive/Negative");
  else if (hasParams) actionsDesc.push("Strip generation params");
  if (hasUndockedLoras) actionsDesc.push(`Dock ${looseLoras.length} LoRA${looseLoras.length === 1 ? "" : "s"}`);

  const originLabel = hasNegative || hasParams ? "Civitai / A1111 prompt detected" : "Inline LoRA tags detected";
  const summaryLabel = actionsDesc.length ? `${originLabel} — ${actionsDesc.join(" & ")}?` : originLabel;

  return {
    positive: rawPositive.trim(),
    dockedPositive,
    negative,
    hasNegative,
    loras: looseLoras,
    hasUndockedLoras,
    params,
    hasParams,
    isStructured,
    summaryLabel,
  };
}

const LIGHTING_CAMERA_RE = /\b(?:lighting|backlit|rim light|volumetric|sunlight|golden hour|neon|cinematic light|shadows|bokeh|depth of field|dof|mm\b|f\/\d|wide shot|close[- ]up|medium shot|low angle|high angle|overhead|camera|lens|framing)\b/i;
const STYLE_QUALITY_RE = /\b(?:masterpiece|best quality|high quality|score_\d|absurdres|highres|8k|4k|photorealistic|illustration|anime|oil painting|watercolor|3d render|octane|concept art|editorial|film grain|analog|aesthetic|by @?[A-Za-z0-9_]+|artist:)\b/i;

export function buildFieldsWorkspaceFromPaste(parsed, existingNegative = "") {
  const { body, items: loraItems } = splitLoraDock(parsed.dockedPositive || parsed.positive || "");
  const clauses = splitTopLevelClauses(body).map((c) => c.raw.trim()).filter(Boolean);

  const buckets = {
    subject: [],
    scene: [],
    lighting: [],
    style: [],
  };

  clauses.forEach((clause, index) => {
    if (STYLE_QUALITY_RE.test(clause)) {
      buckets.style.push(clause);
    } else if (LIGHTING_CAMERA_RE.test(clause)) {
      buckets.lighting.push(clause);
    } else if (index < 2 || buckets.subject.length === 0) {
      buckets.subject.push(clause);
    } else {
      buckets.scene.push(clause);
    }
  });

  const fieldEntries = [
    ["Subject", buckets.subject],
    ["Details & Scene", buckets.scene],
    ["Camera & Lighting", buckets.lighting],
    ["Style & Quality", buckets.style],
  ].filter(([, list]) => list.length > 0);

  const fields = [];
  const segments = [];
  if (!fieldEntries.length) {
    const f = newField("Subject");
    f.value = f.default = body.trim();
    fields.push(f);
    segments.push({ type: "field", id: f.id, join: true });
  } else {
    for (const [label, list] of fieldEntries) {
      const f = newField(label);
      f.value = f.default = list.join(", ");
      fields.push(f);
      segments.push({ type: "field", id: f.id, join: true });
    }
  }

  const finalNegative = parsed.hasNegative
    ? (existingNegative.trim() && existingNegative.trim() !== parsed.negative.trim()
        ? `${existingNegative.trim()}, ${parsed.negative.trim()}`
        : parsed.negative.trim())
    : existingNegative;

  if (loraItems.length > 0) {
    const bodyExists = fields.some((f) => f.value.trim().length > 0);
    const dockBlock = `${LORA_DOCK_HEADER}\n${loraItems.join(" ")}`;
    segments.push({
      type: "static",
      text: bodyExists ? `\n\n${dockBlock}` : dockBlock,
      channel: "positive",
    });
  }

  return validateWorkspaceRecipe({
    schema: WORKSPACE_SCHEMA,
    name: "Imported prompt",
    separator: ", ",
    negative: finalNegative || "",
    fields,
    segments,
  });
}

export function smartPasteMarkup() {
  return `<div class="wg-smart-paste-bar" data-el="smartPasteBar" hidden inert role="region" aria-label="Smart Paste prompt splitter">
    <div class="wg-smart-paste-row">
      <span class="wg-smart-paste-icon" aria-hidden="true">${svgIcon("sparkles", 13)}</span>
      <span class="wg-smart-paste-title" data-el="smartPasteTitle"></span>
      <label class="wg-smart-paste-seed" data-el="smartPasteSeedWrap" hidden>
        <input type="checkbox" data-el="smartPasteSeedCheck" checked />
        <span data-el="smartPasteSeedLabel">Use seed</span>
      </label>
      <div class="wg-smart-paste-actions">
        <button type="button" class="wg-pill pp-smart-paste-apply" data-el="smartPasteApply">Split &amp; Dock</button>
        <button type="button" class="wg-pill" data-el="smartPasteFields" hidden>Split into Fields</button>
        <button type="button" class="wg-editor-find-close" data-el="smartPasteDismiss" title="Dismiss Smart Paste (Esc)" aria-label="Dismiss Smart Paste">×</button>
      </div>
    </div>
    <details class="wg-smart-paste-preview" data-el="smartPasteDetails">
      <summary>Preview split</summary>
      <div class="wg-smart-paste-preview-body" data-el="smartPastePreviewBody"></div>
    </details>
  </div>`;
}

function make(tag, className = "", text = "") {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text) el.textContent = text;
  return el;
}

export function attachSmartPaste({
  root,
  textarea,
  getNegative = () => "",
  applyStructuredPaste = null,
  applyFieldsPaste = null,
  canSplitIntoFields = () => false,
} = {}) {
  const bar = root?.querySelector('[data-el="smartPasteBar"]');
  if (!root || !textarea || !bar) {
    return { isOpen: () => false, dismiss: () => false, cleanup: () => {} };
  }

  const q = (sel) => bar.querySelector(`[data-el="${sel}"]`);
  const titleEl = q("smartPasteTitle");
  const seedWrap = q("smartPasteSeedWrap");
  const seedCheck = q("smartPasteSeedCheck");
  const seedLabel = q("smartPasteSeedLabel");
  const applyBtn = q("smartPasteApply");
  const fieldsBtn = q("smartPasteFields");
  const dismissBtn = q("smartPasteDismiss");
  const detailsEl = q("smartPasteDetails");
  const previewBody = q("smartPastePreviewBody");

  let activeOffer = null;
  let ignoringInput = false;
  let disposed = false;

  function dismiss() {
    if (!activeOffer && bar.hidden) return false;
    activeOffer = null;
    bar.hidden = true;
    bar.setAttribute("inert", "");
    if (detailsEl) detailsEl.open = false;
    previewBody?.replaceChildren();
    return true;
  }

  function renderPreview(offer) {
    if (!previewBody) return;
    previewBody.replaceChildren();
    const { parsed } = offer;
    const addBlock = (label, value) => {
      if (!value) return;
      const row = make("div", "wg-smart-paste-preview-item");
      row.append(make("strong", "", label), make("pre", "", value));
      previewBody.append(row);
    };
    addBlock("Positive (cleaned)", parsed.dockedPositive || "(empty)");
    if (parsed.hasNegative) {
      addBlock("Negative prompt", parsed.negative || "(empty)");
    }
    if (parsed.hasUndockedLoras) {
      addBlock("Docked LoRAs", parsed.loras.map((l) => l.text).join(" "));
    }
    if (parsed.hasParams && parsed.params?.rawText) {
      addBlock("Stripped parameters", parsed.params.rawText);
    }
  }

  function showOffer(offer) {
    if (disposed) return;
    activeOffer = offer;
    const { parsed } = offer;
    titleEl.textContent = parsed.summaryLabel;
    applyBtn.textContent = parsed.hasNegative && parsed.hasUndockedLoras
      ? "Split & Dock"
      : parsed.hasNegative
      ? "Split Positive / Negative"
      : parsed.hasParams && parsed.hasUndockedLoras
      ? "Clean & Dock LoRAs"
      : parsed.hasParams
      ? "Strip Params"
      : "Dock LoRAs";

    const hasSeed = Boolean(parsed.params?.seed && Number.isSafeInteger(Number(parsed.params.seed)));
    seedWrap.hidden = !hasSeed;
    if (hasSeed) {
      seedCheck.checked = true;
      seedLabel.textContent = `Seed ${parsed.params.seed}`;
    }

    fieldsBtn.hidden = !canSplitIntoFields();
    renderPreview(offer);
    bar.hidden = false;
    bar.removeAttribute("inert");
  }

  function buildFinalPositive(offer) {
    const current = offer.expectedEditorValue;
    const before = current.slice(0, offer.pasteStart);
    const after = current.slice(offer.pasteEnd);
    if (!before.trim() && !after.trim()) {
      return offer.parsed.dockedPositive;
    }
    const merged = before + offer.parsed.positive + after;
    return offer.parsed.hasUndockedLoras ? dockLoraText(merged) : merged;
  }

  const onApplyClick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!activeOffer) return;
    const offer = activeOffer;
    if (textarea.value !== offer.expectedEditorValue) {
      dismiss();
      notify("info", "Prompt edited", "Paste changed before splitting.");
      return;
    }
    const nextPositive = buildFinalPositive(offer);
    const existingNeg = String(getNegative?.() || "").trim();
    const nextNegative = offer.parsed.hasNegative
      ? (existingNeg && existingNeg !== offer.parsed.negative
          ? `${existingNeg}, ${offer.parsed.negative}`
          : offer.parsed.negative)
      : null;
    const nextSeed = !seedWrap.hidden && seedCheck.checked && offer.parsed.params?.seed
      ? Number(offer.parsed.params.seed)
      : null;

    dismiss();
    ignoringInput = true;
    try {
      applyStructuredPaste?.({
        positive: nextPositive,
        negative: nextNegative,
        hasNegative: offer.parsed.hasNegative,
        seed: nextSeed,
      });
    } finally {
      ignoringInput = false;
    }
    notify("success", "Smart Paste applied", "Split cleanly. Press Ctrl/Cmd+Z to revert to the raw paste.");
  };

  const onFieldsClick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!activeOffer) return;
    const offer = activeOffer;
    if (textarea.value !== offer.expectedEditorValue) {
      dismiss();
      return;
    }
    const recipe = buildFieldsWorkspaceFromPaste(offer.parsed, String(getNegative?.() || ""));
    const nextSeed = !seedWrap.hidden && seedCheck.checked && offer.parsed.params?.seed
      ? Number(offer.parsed.params.seed)
      : null;
    dismiss();
    ignoringInput = true;
    try {
      applyFieldsPaste?.({ recipe, seed: nextSeed });
    } finally {
      ignoringInput = false;
    }
    notify("success", "Split into Fields", `Created ${recipe.fields.length} workspace field${recipe.fields.length === 1 ? "" : "s"}. Press Ctrl/Cmd+Z to undo.`);
  };

  const onPaste = (event) => {
    if (disposed || textarea.readOnly || textarea.disabled) return;
    const raw = event.clipboardData?.getData("text/plain");
    if (!shouldOfferSmartPaste(raw)) {
      dismiss();
      return;
    }
    const normalizedPaste = raw.replace(/\r\n?/g, "\n");
    const parsed = parseGenerationPaste(normalizedPaste);
    if (!parsed.isStructured) {
      dismiss();
      return;
    }
    ignoringInput = true;
    queueMicrotask(() => {
      ignoringInput = false;
      if (disposed || !textarea.isConnected) return;
      const currentVal = textarea.value || "";
      const selEnd = textarea.selectionEnd ?? currentVal.length;
      const guessStart = Math.max(0, selEnd - normalizedPaste.length);
      let pasteStart = guessStart;
      let pasteEnd = selEnd;
      if (currentVal.slice(guessStart, selEnd) !== normalizedPaste) {
        const idx = currentVal.indexOf(normalizedPaste);
        if (idx < 0) return;
        pasteStart = idx;
        pasteEnd = idx + normalizedPaste.length;
      }
      showOffer({
        parsed,
        pasteStart,
        pasteEnd,
        expectedEditorValue: currentVal,
      });
    });
  };

  const onInput = () => {
    if (ignoringInput || !activeOffer) return;
    if (textarea.value !== activeOffer.expectedEditorValue) {
      dismiss();
    }
  };

  applyBtn.addEventListener("click", onApplyClick);
  fieldsBtn.addEventListener("click", onFieldsClick);
  dismissBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    dismiss();
    textarea.focus({ preventScroll: true });
  });
  textarea.addEventListener("paste", onPaste);
  textarea.addEventListener("input", onInput);

  return {
    isOpen: () => Boolean(activeOffer && !bar.hidden),
    dismiss,
    cleanup() {
      disposed = true;
      dismiss();
      applyBtn.removeEventListener("click", onApplyClick);
      fieldsBtn.removeEventListener("click", onFieldsClick);
      textarea.removeEventListener("paste", onPaste);
      textarea.removeEventListener("input", onInput);
    },
  };
}
