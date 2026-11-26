import { jsonObjectRanges, maskJsonObjects } from "../engine/json_literals.js";
import { LORA_RE, LORA_DOCK_HEADER_RE, dockLoraText, loraTags, standaloneLoraTags } from "../engine/lora_tags.js";
import { diffPromptText } from "./history_comparison_model.js";
import { parseWeightGroup } from "./weight_edit.js";
import { API } from "../prompt_palette_api.js";
import { copyPromptPaletteThemeScope, installPromptPaletteKeyboardBoundary, onPromptPaletteAppearanceChanged, svgIcon } from "../prompt_palette_shared.js";
import { trackDialog } from "./dialogs.js";
import { notify } from "./notifications.js";

const EMBEDDING_TOKEN_RE = /\bembedding:([^\s,()<>]+)/gi;
const WILDCARD_TOKEN_RE = /__[+\-*%~@]?[A-Za-z0-9_\-/*]+(?:\([^()]*\))?__/g;
const VARIABLE_TOKEN_RE = /\$\{[^{}]*\}/g;
const CONDITIONAL_TOKEN_RE = /\[(?:if|elif|else|\/if|switch|case|default|\/switch)(?:\s+[^\]]+)?\]/gi;
const INLINE_WEIGHT_GROUP_RE = /(?<!\\)\(([^():\r\n]+):([+-]?(?:\d+(?:\.\d*)?|\.\d+))(?<!\\)\)/g;
const SCORE_TAG_RE = /\bscore_\d+(?:_up|_down)?\b/gi;
const LEGACY_BUZZWORD_RE = /\b(?:masterpiece|best[ _]quality|ultra[- _]?detailed|absurdres|highres|8k[ _]uhd|4k[ _]uhd|trending[ _]on[ _]artstation)\b/gi;
const BREAK_WORD_RE = /\bBREAK\b/g;
const BOORU_UNDERSCORE_WORD_RE = /(?<![A-Za-z0-9_])([A-Za-z0-9]+(?:_[A-Za-z0-9]+)+)(?![A-Za-z0-9_])/g;
const ANIMA_ARTIST_RE = /(?:^|(?<=[\s,]))artist:([A-Za-z0-9_\-]+)/gi;

export const MODEL_HYGIENE_PROFILES = Object.freeze([
  {
    id: "flux",
    label: "FLUX · Natural Prose",
    kind: "prose",
    summary: "Unwraps (phrase:1.x) weights, removes BREAK & score_9 tags, and converts Booru underscores to spaces.",
  },
  {
    id: "krea2",
    label: "Krea 2 · Clean Descriptive Prose",
    kind: "prose",
    stripBuzzwords: true,
    summary: "Strips numerical weights, BREAK, score tags, and legacy quality buzzwords (masterpiece, 8k, absurdres); converts underscores to spaces.",
  },
  {
    id: "qwen",
    label: "Qwen / Wan / Z-Image · Prose",
    kind: "prose",
    stripBuzzwords: true,
    summary: "Adapts tag-heavy prompts into clean natural phrasing for LLM/VLM text encoders.",
  },
  {
    id: "sdxl",
    label: "SDXL / Illustrious / Pony · Tags",
    kind: "tags",
    summary: "Normalizes comma spacing and collapses redundant separators while keeping (weights:1.x) and score tags intact.",
  },
  {
    id: "booru",
    label: "Booru · Canonical Tag List",
    kind: "tags",
    stripTrailingPeriods: true,
    summary: "Normalizes comma-separated tag formatting, removes stray trailing periods on tags, and deduplicates clauses.",
  },
  {
    id: "anima",
    label: "Anima · @Artist & Tag Format",
    kind: "tags",
    animaArtists: true,
    summary: "Converts artist:name prefixes into @Artist Name with spaces and normalizes tag separators.",
  },
]);

function maskNonClauseRegions(source) {
  const text = String(source ?? "");
  if (!text) return "";
  const ranges = jsonObjectRanges(text);
  let masked = maskJsonObjects(text, ranges);
  masked = masked
    .split("\n")
    .map((line) => (/^\s*#/.test(line) ? " ".repeat(line.length) : line))
    .join("\n");
  masked = masked.replace(LORA_RE, (m) => " ".repeat(m.length));
  return masked;
}

export function hasDynamicClauseSyntax(clause) {
  const s = String(clause ?? "");
  WILDCARD_TOKEN_RE.lastIndex = 0;
  VARIABLE_TOKEN_RE.lastIndex = 0;
  CONDITIONAL_TOKEN_RE.lastIndex = 0;
  return (
    WILDCARD_TOKEN_RE.test(s) ||
    VARIABLE_TOKEN_RE.test(s) ||
    CONDITIONAL_TOKEN_RE.test(s) ||
    (s.includes("{") && s.includes("}"))
  );
}

export function normalizeClauseKey(clause) {
  let trimmed = String(clause ?? "").trim();
  const parsedWeight = parseWeightGroup(trimmed);
  if (parsedWeight && typeof parsedWeight.inner === "string") {
    trimmed = parsedWeight.inner.trim();
  }
  return trimmed
    .replace(/\\([()])/g, "$1")
    .replace(/[\s_]+/g, " ")
    .replace(/^[.;:]+|[.;:]+$/g, "")
    .trim()
    .toLowerCase();
}

export function splitTopLevelClauses(text) {
  const source = String(text ?? "");
  if (!source) return [];
  const dockMatch = LORA_DOCK_HEADER_RE.exec(source);
  const bodyLimit = dockMatch ? dockMatch.index : source.length;
  const body = source.slice(0, bodyLimit);
  const masked = maskNonClauseRegions(body);
  const clauses = [];
  let depth = 0;
  let segStart = 0;
  let lineIndex = 0;

  for (let i = 0; i <= masked.length; i += 1) {
    const ch = i < masked.length ? masked[i] : ",";
    if (i < masked.length && ch === "\\") {
      i += 1;
      continue;
    }
    if (i < masked.length && (ch === "(" || ch === "{" || ch === "[")) {
      depth += 1;
    } else if (i < masked.length && (ch === ")" || ch === "}" || ch === "]") && depth > 0) {
      depth -= 1;
    } else if (i === masked.length || (depth === 0 && (ch === "," || ch === "\n"))) {
      let s = segStart;
      let e = i;
      while (s < e && /\s/.test(masked[s])) s += 1;
      while (e > s && /\s/.test(masked[e - 1])) e -= 1;
      if (e > s) {
        clauses.push({
          start: s,
          end: e,
          raw: source.slice(s, e),
          lineIndex,
        });
      }
      if (ch === "\n") lineIndex += 1;
      segStart = i + 1;
    }
  }
  return clauses;
}

export function findDuplicateClauses(text) {
  const clauses = splitTopLevelClauses(text);
  const seen = new Map();
  const duplicates = [];
  for (const item of clauses) {
    if (hasDynamicClauseSyntax(item.raw)) continue;
    const norm = normalizeClauseKey(item.raw);
    if (norm.length < 2 || norm === "break" || norm === "and" || norm === "the" || norm === "a" || norm === "an") {
      continue;
    }
    const first = seen.get(norm);
    if (first) {
      duplicates.push({
        clause: item.raw,
        normalized: norm,
        start: item.start,
        end: item.end,
        firstStart: first.start,
        firstEnd: first.end,
        firstClause: first.raw,
      });
    } else {
      seen.set(norm, item);
    }
  }
  return duplicates;
}

export function extractLocalEmbeddings(text) {
  const masked = maskNonClauseRegions(text);
  const names = [];
  const seen = new Set();
  for (const match of masked.matchAll(EMBEDDING_TOKEN_RE)) {
    const name = String(match[1] || "").trim();
    const key = name.toLowerCase();
    if (name && !seen.has(key)) {
      seen.add(key);
      names.push({ name, start: match.index ?? 0, end: (match.index ?? 0) + match[0].length });
    }
  }
  return names;
}

function splitPreservingLoraDock(source) {
  const text = String(source ?? "").replace(/\r\n?/g, "\n");
  const match = LORA_DOCK_HEADER_RE.exec(text);
  if (!match) return { body: text, dockSuffix: "" };
  const rawBody = text.slice(0, match.index).replace(/[ \t]+$/gm, "").replace(/\n+$/, "");
  const dockRaw = text.slice(match.index).replace(/^\n+/, "");
  return { body: rawBody, dockSuffix: dockRaw };
}

function rejoinLoraDock(body, dockSuffix) {
  const cleanBody = String(body ?? "").replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
  const cleanDock = String(dockSuffix ?? "").trim();
  if (!cleanDock) return cleanBody;
  return cleanBody ? `${cleanBody}\n\n${cleanDock}` : cleanDock;
}

function protectSyntaxTokens(text) {
  const saved = [];
  const put = (raw) => {
    const token = `\uE000PP${saved.length}\uE001`;
    saved.push(raw);
    return token;
  };
  let out = String(text ?? "");
  const jsonRanges = jsonObjectRanges(out);
  for (let i = jsonRanges.length - 1; i >= 0; i -= 1) {
    const { start, end } = jsonRanges[i];
    out = out.slice(0, start) + put(out.slice(start, end)) + out.slice(end);
  }
  out = out.replace(LORA_RE, put);
  out = out.replace(EMBEDDING_TOKEN_RE, put);
  out = out.replace(WILDCARD_TOKEN_RE, put);
  out = out.replace(VARIABLE_TOKEN_RE, put);
  out = out.replace(CONDITIONAL_TOKEN_RE, put);
  return {
    masked: out,
    restore(str) {
      return String(str ?? "").replace(/\uE000PP(\d+)\uE001/g, (_, idx) => saved[Number(idx)] ?? "");
    },
  };
}

function tidySingleLine(line) {
  if (/^\s*#/.test(line)) return line.trimEnd();
  const guard = protectSyntaxTokens(line);
  let s = guard.masked;
  s = s.replace(/[ \t]+/g, " ");
  s = s.replace(/\s*,\s*(?:,\s*)+/g, ", ");
  s = s.replace(/\s+([,.;!?])/g, "$1");
  s = s.replace(/,([^\s,])/g, ", $1");
  s = s.replace(/^[ \t,]+|[ \t,]+$/g, "");
  return guard.restore(s).trim();
}

export function dedupPromptTags(sourceText) {
  const normalizedSource = String(sourceText ?? "").replace(/\r\n?/g, "\n");
  const { body, dockSuffix } = splitPreservingLoraDock(normalizedSource);
  const duplicates = findDuplicateClauses(body);
  if (!duplicates.length) {
    return {
      text: normalizedSource,
      removedCount: 0,
      removedClauses: [],
      changed: false,
      diff: diffPromptText(normalizedSource, normalizedSource),
    };
  }

  let edited = body;
  const sorted = [...duplicates].sort((a, b) => b.start - a.start);
  for (const dup of sorted) {
    let removeStart = dup.start;
    let removeEnd = dup.end;
    const before = edited.slice(0, removeStart);
    const after = edited.slice(removeEnd);
    if (/,[ \t]*$/.test(before)) {
      removeStart = before.replace(/,[ \t]*$/, "").length;
    } else if (/^[ \t]*,[ \t]*/.test(after)) {
      const m = /^[ \t]*,[ \t]*/.exec(after);
      removeEnd += m[0].length;
    }
    edited = edited.slice(0, removeStart) + edited.slice(removeEnd);
  }

  const lines = edited
    .split("\n")
    .map((line) => (/^\s*#/.test(line) ? line.trimEnd() : tidySingleLine(line)));
  const finalBody = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  const nextText = rejoinLoraDock(finalBody, dockSuffix);
  return {
    text: nextText,
    removedCount: duplicates.length,
    removedClauses: duplicates.map((d) => d.clause),
    changed: nextText !== normalizedSource,
    diff: diffPromptText(normalizedSource, nextText),
  };
}

export function tidyPromptText(sourceText, { dedup = true, dockLoras = false } = {}) {
  const normalizedSource = String(sourceText ?? "").replace(/\r\n?/g, "\n");
  let working = normalizedSource;
  let dockedCount = 0;
  if (dockLoras) {
    const { body: preDockBody } = splitPreservingLoraDock(working);
    const loose = standaloneLoraTags(preDockBody);
    if (loose.length > 0) {
      dockedCount = loose.length;
      working = dockLoraText(working);
    }
  }

  let removedDuplicates = 0;
  let removedClauses = [];
  if (dedup) {
    const dedupResult = dedupPromptTags(working);
    working = dedupResult.text;
    removedDuplicates = dedupResult.removedCount;
    removedClauses = dedupResult.removedClauses;
  }

  const { body, dockSuffix } = splitPreservingLoraDock(working);
  const tidiedLines = body.split("\n").map((line) => tidySingleLine(line));
  const cleanBody = tidiedLines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  const nextText = rejoinLoraDock(cleanBody, dockSuffix);

  const notes = [];
  if (removedDuplicates > 0) {
    notes.push(`${removedDuplicates} duplicate tag${removedDuplicates === 1 ? "" : "s"} removed`);
  }
  if (dockedCount > 0) {
    notes.push(`${dockedCount} LoRA tag${dockedCount === 1 ? "" : "s"} docked`);
  }
  if (nextText !== normalizedSource && notes.length === 0) {
    notes.push("Collapsed extra commas and whitespace");
  }

  return {
    text: nextText,
    changed: nextText !== normalizedSource,
    removedDuplicates,
    removedClauses,
    dockedCount,
    notes,
    diff: diffPromptText(normalizedSource, nextText),
  };
}

export function adaptPromptForModel(sourceText, profileId = "flux", { dedup = true } = {}) {
  const normalizedSource = String(sourceText ?? "").replace(/\r\n?/g, "\n");
  const profile = MODEL_HYGIENE_PROFILES.find((p) => p.id === profileId) || MODEL_HYGIENE_PROFILES[0];
  const { body, dockSuffix } = splitPreservingLoraDock(normalizedSource);
  const notes = [];
  let unwrappedWeights = 0;
  let strippedBreaks = 0;
  let strippedBuzzwords = 0;
  let convertedUnderscores = 0;
  let convertedArtists = 0;

  const transformedLines = body.split("\n").map((line) => {
    if (/^\s*#/.test(line)) return line.trimEnd();
    const guard = protectSyntaxTokens(line);
    let s = guard.masked;

    if (profile.kind === "prose") {
      let prev;
      do {
        prev = s;
        s = s.replace(INLINE_WEIGHT_GROUP_RE, (_, inner) => {
          unwrappedWeights += 1;
          return inner.trim();
        });
      } while (s !== prev);

      s = s.replace(BREAK_WORD_RE, () => {
        strippedBreaks += 1;
        return ",";
      });

      s = s.replace(SCORE_TAG_RE, () => {
        strippedBuzzwords += 1;
        return "";
      });

      if (profile.stripBuzzwords) {
        s = s.replace(LEGACY_BUZZWORD_RE, () => {
          strippedBuzzwords += 1;
          return "";
        });
      }

      s = s.replace(BOORU_UNDERSCORE_WORD_RE, (whole) => {
        if (/^\uE000PP\d+\uE001$/.test(whole)) return whole;
        convertedUnderscores += 1;
        return whole.replace(/_/g, " ");
      });
    } else if (profile.kind === "tags") {
      if (profile.animaArtists) {
        s = s.replace(ANIMA_ARTIST_RE, (_, name) => {
          convertedArtists += 1;
          return `@${String(name || "").replace(/_/g, " ").trim()}`;
        });
      }
      if (profile.stripTrailingPeriods) {
        s = s.replace(/\.+(?=\s*(?:,|$))/g, "");
      }
    }

    return tidySingleLine(guard.restore(s));
  });

  const adaptedBody = rejoinLoraDock(transformedLines.join("\n"), dockSuffix);
  const tidied = tidyPromptText(adaptedBody, { dedup });
  const nextText = tidied.text;

  if (unwrappedWeights > 0) notes.push(`${unwrappedWeights} weight group${unwrappedWeights === 1 ? "" : "s"} unwrapped`);
  if (strippedBreaks > 0) notes.push(`${strippedBreaks} BREAK token${strippedBreaks === 1 ? "" : "s"} removed`);
  if (strippedBuzzwords > 0) notes.push(`${strippedBuzzwords} score/quality buzzword${strippedBuzzwords === 1 ? "" : "s"} removed`);
  if (convertedUnderscores > 0) notes.push(`${convertedUnderscores} underscore tag${convertedUnderscores === 1 ? "" : "s"} converted to spaces`);
  if (convertedArtists > 0) notes.push(`${convertedArtists} artist tag${convertedArtists === 1 ? "" : "s"} formatted as @Artist`);
  if (tidied.removedDuplicates > 0) notes.push(`${tidied.removedDuplicates} duplicate${tidied.removedDuplicates === 1 ? "" : "s"} removed`);
  if (nextText !== normalizedSource && !notes.length) notes.push("Normalized spacing and comma separators");

  return {
    text: nextText,
    profile: profile.id,
    profileLabel: profile.label,
    changed: nextText !== normalizedSource,
    notes,
    diff: diffPromptText(normalizedSource, nextText),
  };
}

let activeHygieneDialog = null;

function make(tag, className = "", text = "") {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text) el.textContent = text;
  return el;
}

export function renderDiffElements(container, diffResult) {
  container.replaceChildren();
  if (!diffResult || diffResult.identical) {
    const clean = make("p", "pp-hygiene-clean", "No changes needed — this prompt is already clean for the selected options.");
    container.append(clean);
    return;
  }
  const pre = make("pre", "pp-hygiene-diff-pre");
  for (const part of diffResult.parts || []) {
    if (part.type === "equal") {
      pre.append(document.createTextNode(part.text));
    } else if (part.type === "remove") {
      const del = make("del", "pp-diff-remove", part.text);
      pre.append(del);
    } else if (part.type === "add") {
      const ins = make("ins", "pp-diff-add", part.text);
      pre.append(ins);
    }
  }
  container.append(pre);
}

export function closePromptHygieneModal() {
  activeHygieneDialog?.close();
}

export function openPromptHygieneModal(editor, { mode = "tidy", initialProfile = "flux", applyEdit = null } = {}) {
  activeHygieneDialog?.close();
  if (!editor?.isConnected) return null;
  if (editor.readOnly || editor.disabled || editor.getAttribute("aria-readonly") === "true") {
    notify("info", "Read-only prompt", "Switch to an editable prompt or workspace field first.");
    return null;
  }

  const snapshot = {
    source: editor.value || "",
    start: editor.selectionStart ?? 0,
    end: editor.selectionEnd ?? 0,
    direction: editor.selectionDirection || "none",
  };
  let activeTab = mode === "adapt" ? "adapt" : "tidy";
  let dedupChecked = true;
  const hasLooseLoras = standaloneLoraTags(splitPreservingLoraDock(snapshot.source).body).length > 0;
  let dockLorasChecked = hasLooseLoras;
  let selectedProfile = MODEL_HYGIENE_PROFILES.some((p) => p.id === initialProfile) ? initialProfile : "flux";
  let currentResult = null;
  let closed = false;

  const dialog = make("dialog", "pp-prompt-tools pp-hygiene-dialog wg-root");
  dialog.dataset.promptPaletteGlobal = "true";
  dialog.setAttribute("aria-label", "Prompt hygiene and model adaptation");

  const scope = editor.closest(".wg-root, .wg-node, .pp-node, .ppwc-surface");
  const syncTheme = () => {
    if (scope) copyPromptPaletteThemeScope(scope, dialog);
    dialog.classList.toggle("wg-high-contrast", !!scope?.classList?.contains("wg-high-contrast"));
  };
  syncTheme();

  const header = make("header", "pp-tool-header");
  const titleWrap = make("div", "pp-tool-title");
  titleWrap.append(
    make("span", "pp-tool-eyebrow", "PROMPT HYGIENE"),
    make("h2", "", activeTab === "adapt" ? "Adapt for Model" : "Tidy & Deduplicate Prompt")
  );
  const closeBtn = make("button", "pp-tool-close", "×");
  closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", "Close hygiene preview (Esc)");
  closeBtn.title = "Close (Esc)";
  header.append(titleWrap, closeBtn);

  const tabs = make("div", "pp-tool-tabs");
  tabs.setAttribute("role", "tablist");
  const tidyTab = make("button", "", "Tidy & Deduplicate");
  tidyTab.type = "button";
  tidyTab.setAttribute("role", "tab");
  const adaptTab = make("button", "", "Adapt for Model");
  adaptTab.type = "button";
  adaptTab.setAttribute("role", "tab");
  tabs.append(tidyTab, adaptTab);

  const body = make("div", "pp-tool-body pp-hygiene-body");
  const controlsBox = make("div", "pp-hygiene-controls");
  const profileRow = make("label", "pp-tool-field");
  profileRow.append(make("span", "", "Target model family"));
  const profileSelect = make("select");
  profileSelect.setAttribute("aria-label", "Target model family");
  for (const prof of MODEL_HYGIENE_PROFILES) {
    const opt = make("option", "", prof.label);
    opt.value = prof.id;
    profileSelect.append(opt);
  }
  profileSelect.value = selectedProfile;
  const profileHelp = make("small", "pp-hygiene-profile-note");
  profileRow.append(profileSelect, profileHelp);

  const checksRow = make("div", "pp-hygiene-checks");
  const dedupLabel = make("label", "pp-tool-check");
  const dedupInput = make("input");
  dedupInput.type = "checkbox";
  dedupInput.checked = dedupChecked;
  dedupLabel.append(dedupInput, make("span", "", "Remove duplicate comma-separated tags (case & underscore normalized)"));

  const dockLabel = make("label", "pp-tool-check");
  const dockInput = make("input");
  dockInput.type = "checkbox";
  dockInput.checked = dockLorasChecked;
  dockLabel.append(dockInput, make("span", "", "Dock standalone <lora:…> tags into trailing # --- LoRAs --- section"));
  checksRow.append(dedupLabel, dockLabel);

  controlsBox.append(profileRow, checksRow);

  const summaryBar = make("div", "pp-hygiene-summary");
  const diffHost = make("div", "pp-hygiene-diff-box");
  diffHost.setAttribute("aria-live", "polite");

  const actions = make("div", "pp-tool-actions");
  const cancelBtn = make("button", "wg-button", "Cancel");
  cancelBtn.type = "button";
  const applyBtn = make("button", "wg-button pp-tool-primary");
  applyBtn.type = "button";
  applyBtn.innerHTML = `${svgIcon("check", 13)} <span>Apply changes</span>`;
  actions.append(cancelBtn, applyBtn);

  const status = make("div", "pp-tool-status", "Previewing non-destructive diff. Applying records a single Undo step (Ctrl/Cmd+Z).");
  status.setAttribute("role", "status");

  body.append(controlsBox, summaryBar, diffHost, actions);
  dialog.append(header, tabs, body, status);
  document.body.append(dialog);

  const cleanupKeys = installPromptPaletteKeyboardBoundary(dialog);
  const cleanupTheme = onPromptPaletteAppearanceChanged(syncTheme);
  let releaseDialog = null;

  function renderPreview() {
    const isAdapt = activeTab === "adapt";
    tidyTab.setAttribute("aria-selected", String(!isAdapt));
    adaptTab.setAttribute("aria-selected", String(isAdapt));
    titleWrap.querySelector("h2").textContent = isAdapt ? "Adapt for Model" : "Tidy & Deduplicate Prompt";
    profileRow.hidden = !isAdapt;
    dockLabel.hidden = isAdapt;

    if (isAdapt) {
      const prof = MODEL_HYGIENE_PROFILES.find((p) => p.id === selectedProfile) || MODEL_HYGIENE_PROFILES[0];
      profileHelp.textContent = prof.summary;
      currentResult = adaptPromptForModel(snapshot.source, selectedProfile, { dedup: dedupChecked });
    } else {
      currentResult = tidyPromptText(snapshot.source, { dedup: dedupChecked, dockLoras: dockLorasChecked });
    }

    summaryBar.replaceChildren();
    if (currentResult.notes?.length) {
      for (const note of currentResult.notes) {
        summaryBar.append(make("span", "pp-hygiene-pill", note));
      }
    } else {
      summaryBar.append(make("span", "pp-hygiene-pill is-clean", "Already clean"));
    }

    renderDiffElements(diffHost, currentResult.diff);
    applyBtn.disabled = !currentResult.changed;
  }

  function close() {
    if (closed) return;
    closed = true;
    releaseDialog?.();
    cleanupKeys();
    cleanupTheme();
    dialog.close();
    dialog.remove();
    if (activeHygieneDialog?.dialog === dialog) activeHygieneDialog = null;
    if (editor.isConnected) {
      editor.focus({ preventScroll: true });
      if (editor.value === snapshot.source) {
        editor.setSelectionRange?.(snapshot.start, snapshot.end, snapshot.direction);
      }
    }
  }

  function apply() {
    if (!currentResult?.changed) return;
    if (!editor.isConnected || editor.value !== snapshot.source) {
      status.textContent = "Prompt changed while previewing. Reopen hygiene tools to apply safely.";
      status.classList.add("is-error");
      applyBtn.disabled = true;
      return;
    }
    const next = currentResult.text;
    const summaryText = currentResult.notes?.join(" · ") || "Prompt tidied";
    close();
    const customApply = applyEdit || editor.__ppPromptTools?.apply;
    if (typeof customApply === "function") {
      customApply(next, next.length, next.length);
    } else {
      editor.value = next;
      editor.setSelectionRange?.(next.length, next.length);
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    }
    notify("success", activeTab === "adapt" ? "Adapted prompt" : "Prompt tidied", `${summaryText}. Press Ctrl/Cmd+Z to undo.`);
  }

  tidyTab.addEventListener("click", () => { activeTab = "tidy"; renderPreview(); });
  adaptTab.addEventListener("click", () => { activeTab = "adapt"; renderPreview(); });
  profileSelect.addEventListener("change", () => { selectedProfile = profileSelect.value; renderPreview(); });
  dedupInput.addEventListener("change", () => { dedupChecked = dedupInput.checked; renderPreview(); });
  dockInput.addEventListener("change", () => { dockLorasChecked = dockInput.checked; renderPreview(); });
  closeBtn.addEventListener("click", close);
  cancelBtn.addEventListener("click", close);
  applyBtn.addEventListener("click", apply);
  dialog.addEventListener("cancel", (e) => { e.preventDefault(); close(); });
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) {
      const r = dialog.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) close();
    }
  });

  releaseDialog = trackDialog(close);
  activeHygieneDialog = { dialog, close };
  renderPreview();
  dialog.showModal();
  (currentResult?.changed ? applyBtn : closeBtn).focus();
  return activeHygieneDialog;
}

export function formatPreflightBadgeState({ missingEmbeddings = 0, missingLoras = 0, duplicateCount = 0 } = {}) {
  const parts = [];
  if (missingLoras > 0) parts.push(`${missingLoras} missing LoRA${missingLoras === 1 ? "" : "s"}`);
  if (missingEmbeddings > 0) parts.push(`${missingEmbeddings} missing emb`);
  if (duplicateCount > 0) parts.push(`${duplicateCount} dupe${duplicateCount === 1 ? "" : "s"}`);
  if (!parts.length) return { visible: false, text: "", shortText: "", severity: "clean", title: "" };
  const hasMissing = missingLoras > 0 || missingEmbeddings > 0;
  const severity = hasMissing ? "error" : "warning";
  const shortParts = [];
  if (missingLoras + missingEmbeddings > 0) shortParts.push(`!${missingLoras + missingEmbeddings} asset${missingLoras + missingEmbeddings === 1 ? "" : "s"}`);
  if (duplicateCount > 0) shortParts.push(`${duplicateCount} dup`);
  return {
    visible: true,
    text: parts.join(" · "),
    shortText: shortParts.join(" · "),
    severity,
    hasMissing,
    title: hasMissing
      ? `${parts.join(" · ")} — Click to inspect missing pre-flight assets before queueing`
      : `${parts.join(" · ")} — Click to preview Tidy & Deduplicate diff`,
  };
}

export function installPromptPreflightBadge({
  root,
  textarea,
  getNegative = () => "",
  applyEdit = null,
  onInspect = null,
  onPreflightResult = null,
} = {}) {
  const chip = root?.querySelector('[data-el="hygieneChip"]');
  if (!chip || !textarea) {
    return { schedule() {}, refreshNow() {}, getLastResult: () => null, cleanup() {} };
  }

  let disposed = false;
  let timer = null;
  let abortCtrl = null;
  let reqSeq = 0;
  let lastState = { missingEmbeddings: [], missingLoras: [], duplicates: [] };

  function updateChipUI(counts) {
    if (disposed) return;
    const summary = formatPreflightBadgeState(counts);
    chip.hidden = !summary.visible;
    chip.disabled = !summary.visible;
    chip.dataset.severity = summary.severity;
    chip.dataset.shortLabel = summary.shortText;
    if (chip.textContent !== summary.text) chip.textContent = summary.text;
    if (chip.title !== summary.title) chip.title = summary.title;
    chip.setAttribute("aria-label", summary.title || "Prompt hygiene");
  }

  async function runCheck() {
    if (disposed) return;
    const pos = String(textarea.value || "");
    const neg = String(getNegative?.() || "");
    const duplicates = findDuplicateClauses(pos);
    const hasEmbOrLora = /\bembedding:[^\s,()<>]+/i.test(pos) || /\bembedding:[^\s,()<>]+/i.test(neg) || loraTags(pos).length > 0 || loraTags(neg).length > 0;

    if (!hasEmbOrLora) {
      abortCtrl?.abort();
      abortCtrl = null;
      lastState = { missingEmbeddings: [], missingLoras: [], duplicates };
      updateChipUI({ missingEmbeddings: 0, missingLoras: 0, duplicateCount: duplicates.length });
      onPreflightResult?.(lastState);
      return;
    }

    // Immediate local duplicate update while pre-flight resolves
    updateChipUI({
      missingEmbeddings: lastState.missingEmbeddings.length,
      missingLoras: lastState.missingLoras.length,
      duplicateCount: duplicates.length,
    });

    abortCtrl?.abort();
    const ctrl = new AbortController();
    abortCtrl = ctrl;
    const seq = ++reqSeq;
    try {
      const res = await API.diagnostics(pos, { negativeText: neg, signal: ctrl.signal });
      if (disposed || seq !== reqSeq || ctrl.signal.aborted) return;
      const missingEmbeddings = Array.isArray(res?.embeddings) ? res.embeddings.filter((e) => e.status === "missing") : [];
      const missingLoras = Array.isArray(res?.missing_loras) ? res.missing_loras : [];
      const liveDupes = findDuplicateClauses(textarea.value || "");
      lastState = { missingEmbeddings, missingLoras, duplicates: liveDupes };
      updateChipUI({
        missingEmbeddings: missingEmbeddings.length,
        missingLoras: missingLoras.length,
        duplicateCount: liveDupes.length,
      });
      onPreflightResult?.(lastState);
    } catch (err) {
      if (disposed || err?.name === "AbortError") return;
      const liveDupes = findDuplicateClauses(textarea.value || "");
      lastState = { missingEmbeddings: [], missingLoras: [], duplicates: liveDupes };
      updateChipUI({ missingEmbeddings: 0, missingLoras: 0, duplicateCount: liveDupes.length });
      onPreflightResult?.(lastState);
    } finally {
      if (abortCtrl === ctrl) abortCtrl = null;
    }
  }

  function schedule(delayMs = 340) {
    if (disposed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      runCheck();
    }, delayMs);
  }

  const onClick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (lastState.missingEmbeddings.length > 0 || lastState.missingLoras.length > 0) {
      if (typeof onInspect === "function") {
        onInspect();
        return;
      }
    }
    openPromptHygieneModal(textarea, { mode: "tidy", applyEdit });
  };
  chip.addEventListener("click", onClick);

  return {
    schedule,
    refreshNow: () => runCheck(),
    getLastResult: () => lastState,
    applyResolvedPreflight({ embeddings = [], missingLoras = [], duplicates = null } = {}) {
      if (disposed) return;
      const missingEmbeddings = Array.isArray(embeddings) ? embeddings.filter((e) => e.status === "missing") : [];
      const missLoras = Array.isArray(missingLoras) ? missingLoras : [];
      const liveDupes = Array.isArray(duplicates) ? duplicates : findDuplicateClauses(textarea.value || "");
      lastState = { missingEmbeddings, missingLoras: missLoras, duplicates: liveDupes };
      updateChipUI({
        missingEmbeddings: missingEmbeddings.length,
        missingLoras: missLoras.length,
        duplicateCount: liveDupes.length,
      });
      onPreflightResult?.(lastState);
    },
    cleanup() {
      disposed = true;
      if (timer) clearTimeout(timer);
      abortCtrl?.abort();
      chip.removeEventListener("click", onClick);
    },
  };
}
