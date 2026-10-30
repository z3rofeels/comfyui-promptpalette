import { textColorForLora } from "./lora_colors.js";
import { readEditorPreference } from "../prompt_palette_state.js";
import { escapeHtml } from "./text_utils.js";
import { UnifiedWildcardEngine } from "../engine/wildcard_engine.js";
import { maskJsonObjects } from "../engine/json_literals.js";

export class PromptSyntaxCache extends UnifiedWildcardEngine {
  constructor(limit = 768) { super({ lineCacheLimit: limit }); }
  parse(text) { return super.parse(text); }
  stats() { return super.stats(); }
}

const CONDITIONAL_TAG_SCAN_RE = /\[(if|elif|else|\/if|switch|case|default|\/switch)(?:\s+([^\]]+))?\]/gi;
const WEIGHT_PREFIX_RE = /^\s*(\d+)::\s*([\s\S]*)$/;
const MULTI_SELECT_PREFIX_RE = /^(\d+(?:-\d+)?\$\$[\s\S]*?\$\$)([\s\S]*)$/;

function splitOptionsWithOffsets(inner, baseOffset) {
  const options = [];
  let depth = 0;
  let optStart = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    else if (ch === "|" && depth === 0) {
      options.push({
        raw: inner.slice(optStart, i),
        start: baseOffset + optStart,
        end: baseOffset + i,
      });
      optStart = i + 1;
    }
  }
  options.push({
    raw: inner.slice(optStart),
    start: baseOffset + optStart,
    end: baseOffset + inner.length,
  });
  return options.map((opt, index) => {
    const wm = WEIGHT_PREFIX_RE.exec(opt.raw);
    let valOffset = 0;
    let body = opt.raw;
    if (wm) {
      valOffset = opt.raw.length - wm[2].length;
      body = wm[2];
    }
    const leadTrim = body.length - body.trimStart().length;
    const trailTrim = body.length - body.trimEnd().length;
    const valStart = opt.start + valOffset + leadTrim;
    const valEnd = Math.max(valStart, opt.end - trailTrim);
    return {
      index,
      start: opt.start,
      end: opt.end,
      valStart,
      valEnd,
      cleanText: body.trim(),
    };
  });
}

export function computeBranchInspectionSpans(parsed, branchSelections = []) {
  if (!parsed || !Array.isArray(branchSelections) || !branchSelections.length) {
    return [];
  }
  const source = String(parsed.source || "");
  if (!source) return [];

  const masked = maskJsonObjects(source, parsed.literalRanges)
    .split("\n")
    .map((line) => (/^\s*#/.test(line) ? " ".repeat(line.length) : line))
    .join("\n");

  const bracePool = branchSelections
    .filter((b) => b && b.kind === "brace")
    .map((b, idx) => ({ ...b, _used: false, _idx: idx }));
  const condPool = branchSelections
    .filter((b) => b && b.kind === "conditional")
    .map((b, idx) => ({ ...b, _used: false, _idx: idx }));

  const spans = [];
  let groupCounter = 0;

  // 1. Scan brace choice groups {a|b|c}
  const braceRe = /\{([^{}]*)\}/g;
  for (const match of masked.matchAll(braceRe)) {
    const start = match.index ?? 0;
    if (start > 0 && masked[start - 1] === "$") continue;
    const whole = source.slice(start, start + match[0].length);
    let inner = whole.slice(1, -1);
    let innerOffset = start + 1;
    if (inner.length > 0 && "*~+-@%".includes(inner[0])) {
      inner = inner.slice(1);
      innerOffset += 1;
    }
    const multiMatch = MULTI_SELECT_PREFIX_RE.exec(inner);
    if (multiMatch) {
      innerOffset += multiMatch[1].length;
      inner = multiMatch[2];
    }
    const options = splitOptionsWithOffsets(inner, innerOffset);
    if (options.length < 2) continue;

    let matched = bracePool.find((item) => !item._used && item.raw === whole);
    if (!matched) {
      matched = bracePool.find((item) => !item._used && Array.isArray(item.options) && item.options.length === options.length);
    }
    if (!matched) {
      matched = bracePool.find((item) => !item._used);
    }
    if (!matched) continue;
    matched._used = true;

    const chosenIdxSet = new Set(
      Array.isArray(matched.chosen_indices)
        ? matched.chosen_indices.map((n) => Number(n)).filter((n) => Number.isInteger(n))
        : []
    );
    const chosenTextSet = new Set(
      Array.isArray(matched.chosen_options) && matched.chosen_options.length
        ? matched.chosen_options.map((s) => String(s || "").trim())
        : typeof matched.chosen === "string"
        ? [matched.chosen.trim()]
        : []
    );

    const palette = groupCounter % 4;
    groupCounter += 1;

    for (const opt of options) {
      const isSelected =
        chosenIdxSet.has(opt.index) ||
        (!chosenIdxSet.size && opt.cleanText && chosenTextSet.has(opt.cleanText));
      if (isSelected) {
        if (opt.valEnd > opt.valStart) {
          spans.push({
            start: opt.valStart,
            end: opt.valEnd,
            kind: "branch-selected",
            branchPalette: palette,
            groupIndex: groupCounter - 1,
            priority: 2,
          });
        }
      } else if (opt.end > opt.start) {
        spans.push({
          start: opt.start,
          end: opt.end,
          kind: "branch-unselected",
          branchPalette: palette,
          groupIndex: groupCounter - 1,
          priority: 1,
        });
      }
    }
  }

  // 2. Scan [if]/[elif]/[else]/[/if] and [switch]/[case]/[default]/[/switch] blocks
  if (condPool.length > 0) {
    const stack = [];
    for (const match of masked.matchAll(CONDITIONAL_TAG_SCAN_RE)) {
      const tagStart = match.index ?? 0;
      const tagEnd = tagStart + match[0].length;
      const kind = String(match[1] || "").toLowerCase();
      const expr = String(match[2] || "").trim();
      if (kind === "if" || kind === "switch") {
        stack.push({
          block: kind,
          openExpr: expr,
          branches: kind === "if" ? [{ index: 0, tag: kind, expr, bodyStart: tagEnd, bodyEnd: tagEnd }] : [],
        });
      } else if (["elif", "else", "case", "default"].includes(kind)) {
        const frame = stack[stack.length - 1];
        if (!frame) continue;
        if (frame.branches.length > 0) {
          frame.branches[frame.branches.length - 1].bodyEnd = tagStart;
        }
        frame.branches.push({
          index: frame.branches.length,
          tag: kind,
          expr,
          bodyStart: tagEnd,
          bodyEnd: tagEnd,
        });
      } else if (kind === "/if" || kind === "/switch") {
        const frame = stack.pop();
        if (!frame || !frame.branches.length) continue;
        frame.branches[frame.branches.length - 1].bodyEnd = tagStart;

        let matched = condPool.find(
          (item) => !item._used && item.block === frame.block && String(item.open_expr || "").trim() === frame.openExpr
        );
        if (!matched) {
          matched = condPool.find((item) => !item._used && item.block === frame.block);
        }
        if (!matched) continue;
        matched._used = true;

        const chosenIdx = Number.isInteger(matched.chosen_index) ? matched.chosen_index : -1;
        const palette = groupCounter % 4;
        groupCounter += 1;

        for (const br of frame.branches) {
          const rawSlice = source.slice(br.bodyStart, br.bodyEnd);
          const lead = rawSlice.length - rawSlice.trimStart().length;
          const trail = rawSlice.length - rawSlice.trimEnd().length;
          const bStart = br.bodyStart + lead;
          const bEnd = Math.max(bStart, br.bodyEnd - trail);
          if (bEnd <= bStart) continue;
          if (br.index === chosenIdx) {
            spans.push({
              start: bStart,
              end: bEnd,
              kind: "branch-selected",
              branchPalette: palette,
              groupIndex: groupCounter - 1,
              priority: 2,
            });
          } else {
            spans.push({
              start: bStart,
              end: bEnd,
              kind: "branch-unselected",
              branchPalette: palette,
              groupIndex: groupCounter - 1,
              priority: 1,
            });
          }
        }
      }
    }
  }

  return spans;
}

function wrapTextWithInspectionAndFind(text, absStart, inspectionSpans, extraDecorations, innerHtmlFn = escapeHtml) {
  const absEnd = absStart + text.length;
  const activeSpans = [];
  for (const s of inspectionSpans) {
    if (s.end > absStart && s.start < absEnd) activeSpans.push(s);
  }
  for (const d of extraDecorations) {
    if ((d.kind === "find-match" || d.kind === "find-current") && d.end > absStart && d.start < absEnd) {
      activeSpans.push(d);
    }
  }
  if (!activeSpans.length) return innerHtmlFn(text);

  const cuts = new Set([0, text.length]);
  for (const s of activeSpans) {
    cuts.add(Math.max(0, Math.min(text.length, s.start - absStart)));
    cuts.add(Math.max(0, Math.min(text.length, s.end - absStart)));
  }
  const sortedCuts = Array.from(cuts).sort((a, b) => a - b);
  const pieces = [];
  for (let i = 0; i < sortedCuts.length - 1; i++) {
    const relFrom = sortedCuts[i];
    const relTo = sortedCuts[i + 1];
    if (relTo <= relFrom) continue;
    const chunk = text.slice(relFrom, relTo);
    const chunkAbsStart = absStart + relFrom;
    const chunkAbsEnd = absStart + relTo;
    const classes = [];
    for (const s of activeSpans) {
      if (s.start <= chunkAbsStart && s.end >= chunkAbsEnd) {
        if (s.kind === "branch-selected") {
          classes.push("wg-tok-branch-selected", `wg-tok-branch-c${Number(s.branchPalette) || 0}`);
        } else if (s.kind === "branch-unselected") {
          classes.push("wg-tok-branch-unselected");
        } else if (s.kind === "find-current") {
          classes.push("wg-tok-find-current");
        } else if (s.kind === "find-match") {
          classes.push("wg-tok-find-match");
        }
      }
    }
    const rendered = innerHtmlFn(chunk);
    if (classes.length) {
      pieces.push(`<span class="${Array.from(new Set(classes)).join(" ")}">${rendered}</span>`);
    } else {
      pieces.push(rendered);
    }
  }
  return pieces.join("");
}

export function renderPromptSyntax(parsed, {
  isKnown,
  categoryOf,
  buildCategoryColorMap,
  colorForToken,
  tagPainter = null,
  branchSelections = null,
  extraDecorations = null,
}) {
  const names = parsed.names || [];
  const categoriesInUse = Array.from(new Set(names.map(categoryOf)));
  const categoryHueMap = buildCategoryColorMap(categoriesInUse);
  const knownByName = new Map(names.map((name) => [name, !!isKnown(name)]));
  const ranges = [];
  const decorations = [];
  const loraTheme = readEditorPreference("theme", {}), highlightLoras = loraTheme?.highlightLoras === true;
  const htmlLines = [];
  const branchSpans = Array.isArray(branchSelections) && branchSelections.length
    ? computeBranchInspectionSpans(parsed, branchSelections)
    : [];
  const findSpans = Array.isArray(extraDecorations) ? extraDecorations : [];

  for (const line of parsed.lines || []) {
    const parts = [];
    for (const segment of line.parsed?.segments || []) {
      const text = segment.text || "";
      const segAbsStart = line.offset + segment.start;
      const wrappedText = (raw, offset = segAbsStart) =>
        wrapTextWithInspectionAndFind(raw, offset, branchSpans, findSpans, escapeHtml);

      if (segment.type === "wildcard") {
        const known = knownByName.get(segment.name) === true;
        if (known) {
          const color = colorForToken(segment.name, categoryHueMap);
          parts.push(`<span class="wg-token" style="color:${color}; text-shadow:0 0 0.35px currentColor;">${wrappedText(text)}</span>`);
          decorations.push({ start: line.offset + segment.start, end: line.offset + segment.end, kind: "wildcard", color });
        } else {
          parts.push(`<span class="wg-tok-error">${wrappedText(text)}</span>`);
          decorations.push({ start: line.offset + segment.start, end: line.offset + segment.end, kind: "error" });
        }
        ranges.push({ start: line.offset + segment.start, end: line.offset + segment.end, name: segment.name, known, mode: segment.mode || "", args: segment.args || {} });
      } else if (segment.type === "lora") { parts.push(highlightLoras ? `<span class="wg-tok-lora" style="color:${textColorForLora(text.slice(6).split(":")[0], loraTheme)}">${wrappedText(text)}</span>` : wrappedText(text)); if (highlightLoras) decorations.push({ start: line.offset + segment.start, end: line.offset + segment.end, kind: "lora", color: textColorForLora(text.slice(6).split(":")[0], loraTheme) }); }
      else if (segment.type === "conditional") { parts.push(`<span class="wg-tok-conditional">${wrappedText(text)}</span>`); decorations.push({ start: line.offset + segment.start, end: line.offset + segment.end, kind: "conditional" }); }
      else if (segment.type === "weight") { parts.push(`<span class="wg-tok-weight">${wrappedText(text)}</span>`); decorations.push({ start: line.offset + segment.start, end: line.offset + segment.end, kind: "weight" }); }
      else if (segment.type === "modifier") { parts.push(`<span class="wg-tok-mod">${wrappedText(text)}</span>`); decorations.push({ start: line.offset + segment.start, end: line.offset + segment.end, kind: "modifier" }); }
      else if (segment.type === "bracket" || segment.type === "variable") { parts.push(`<span class="wg-tok-bracket">${wrappedText(text)}</span>`); decorations.push({ start: line.offset + segment.start, end: line.offset + segment.end, kind: "bracket" }); }
      else if (segment.type === "pipe") { parts.push('<span class="wg-tok-pipe">|</span>'); decorations.push({ start: line.offset + segment.start, end: line.offset + segment.end, kind: "pipe" }); }
      else if (segment.type === "comment") { parts.push(`<span class="wg-tok-comment">${wrappedText(text)}</span>`); decorations.push({ start: line.offset + segment.start, end: line.offset + segment.end, kind: "comment" }); }
      else if (tagPainter && segment.type === "text" && text) {
        // Plain text is where booru / custom-word tags live. Known tags keep their category
        // color in the prompt, exactly like wildcards keep theirs.
        const base = line.offset + segment.start;
        let cursor = 0;
        for (const hit of tagPainter.paint(text, base)) {
          const from = hit.start - base;
          const to = hit.end - base;
          if (from > cursor) parts.push(wrappedText(text.slice(cursor, from), base + cursor));
          parts.push(`<span class="wg-token wg-token-booru" data-tag-category="${hit.category}" style="color:${hit.color}; text-shadow:0 0 0.35px currentColor;">${wrappedText(text.slice(from, to), hit.start)}</span>`);
          decorations.push({ start: hit.start, end: hit.end, kind: "booru", color: hit.color });
          cursor = to;
        }
        if (cursor < text.length) parts.push(wrappedText(text.slice(cursor), base + cursor));
      }
      else parts.push(wrappedText(text));
    }
    htmlLines.push(parts.join(""));
  }

  for (const span of branchSpans) {
    decorations.push(span);
  }
  for (const span of findSpans) {
    decorations.push(span);
  }

  const tagCategoriesInUse = tagPainter ? Array.from(tagPainter.used) : [];
  return { html: htmlLines.join("\n"), lineHtml: htmlLines, names, categoriesInUse, categoryHueMap, ranges, decorations, branchSpans, parsed, tagCategoriesInUse, tagPalette: tagPainter?.palette || null };
}
