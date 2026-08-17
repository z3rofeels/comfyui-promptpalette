import { escapeHtml } from "./text_utils.js";
import { UnifiedWildcardEngine } from "../engine/wildcard_engine.js";

export class PromptSyntaxCache extends UnifiedWildcardEngine {
  constructor(limit = 768) { super({ lineCacheLimit: limit }); }
  parse(text) { return super.parse(text); }
  stats() { return super.stats(); }
}

export function renderPromptSyntax(parsed, {
  isKnown,
  categoryOf,
  buildCategoryColorMap,
  colorForToken,
}) {
  const names = parsed.names || [];
  const categoriesInUse = Array.from(new Set(names.map(categoryOf)));
  const categoryHueMap = buildCategoryColorMap(categoriesInUse);
  const knownByName = new Map(names.map((name) => [name, !!isKnown(name)]));
  const ranges = [];
  const decorations = [];
  const htmlLines = [];

  for (const line of parsed.lines || []) {
    const parts = [];
    for (const segment of line.parsed?.segments || []) {
      const text = segment.text || "";
      if (segment.type === "wildcard") {
        const known = knownByName.get(segment.name) === true;
        if (known) {
          const color = colorForToken(segment.name, categoryHueMap);
          parts.push(`<span class="wg-token" style="color:${color}; text-shadow:0 0 0.35px currentColor;">${escapeHtml(text)}</span>`);
          decorations.push({ start: line.offset + segment.start, end: line.offset + segment.end, kind: "wildcard", color });
        } else {
          parts.push(`<span class="wg-tok-error">${escapeHtml(text)}</span>`);
          decorations.push({ start: line.offset + segment.start, end: line.offset + segment.end, kind: "error" });
        }
        ranges.push({ start: line.offset + segment.start, end: line.offset + segment.end, name: segment.name, known, mode: segment.mode || "", args: segment.args || {} });
      } else if (segment.type === "weight") { parts.push(`<span class="wg-tok-weight">${escapeHtml(text)}</span>`); decorations.push({ start: line.offset + segment.start, end: line.offset + segment.end, kind: "weight" }); }
      else if (segment.type === "modifier") { parts.push(`<span class="wg-tok-mod">${escapeHtml(text)}</span>`); decorations.push({ start: line.offset + segment.start, end: line.offset + segment.end, kind: "modifier" }); }
      else if (segment.type === "bracket" || segment.type === "variable") { parts.push(`<span class="wg-tok-bracket">${escapeHtml(text)}</span>`); decorations.push({ start: line.offset + segment.start, end: line.offset + segment.end, kind: "bracket" }); }
      else if (segment.type === "pipe") { parts.push('<span class="wg-tok-pipe">|</span>'); decorations.push({ start: line.offset + segment.start, end: line.offset + segment.end, kind: "pipe" }); }
      else if (segment.type === "comment") { parts.push(`<span class="wg-tok-comment">${escapeHtml(text)}</span>`); decorations.push({ start: line.offset + segment.start, end: line.offset + segment.end, kind: "comment" }); }
      else parts.push(escapeHtml(text));
    }
    htmlLines.push(parts.join(""));
  }

  return { html: htmlLines.join("\n"), lineHtml: htmlLines, names, categoriesInUse, categoryHueMap, ranges, decorations, parsed };
}
