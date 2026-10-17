// Pure helpers for editing prompt token weights. The selection panel and the Ctrl/Cmd+Up/Down
// shortcut share them, so both behave the same with or without a text selection.

const WEIGHT_AT_END = /^([\s\S]*):([+-]?(?:\d+(?:\.\d*)?|\.\d+))$/;
const TIME_LIKE = /(?:^|\s)\d{1,2}:\d{2}$/;

function balancedGroups(text) {
  const stack = [], groups = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") { i++; continue; }
    if (ch === "(") stack.push(i);
    else if (ch === ")" && stack.length) groups.push({ start: stack.pop(), end: i + 1 });
  }
  return groups;
}

// "(inner:1.2)" -> { inner, weight: 1.2 }; "(inner)" -> { inner, weight: null }; anything else -> null.
export function parseWeightGroup(slice) {
  if (slice[0] !== "(" || slice.at(-1) !== ")") return null;
  if (!balancedGroups(slice).some(g => g.start === 0 && g.end === slice.length)) return null;
  const inner = slice.slice(1, -1), m = TIME_LIKE.test(inner) ? null : inner.match(WEIGHT_AT_END);
  return m ? { inner: m[1], weight: Number(m[2]) } : { inner, weight: null };
}

function trimRange(text, start, end) {
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;
  return start < end ? { start, end } : null;
}

// Comma/newline separated tag containing the caret. Commas inside (...) and {...} do not split.
function segmentAt(text, caret) {
  let depth = 0, from = 0;
  for (let i = 0; i <= text.length; i++) {
    const ch = text[i];
    if (i < text.length && ch === "\\") { i++; continue; }
    if (ch === "(" || ch === "{") depth++;
    else if ((ch === ")" || ch === "}") && depth) depth--;
    if (i === text.length || (depth === 0 && (ch === "," || ch === "\n"))) {
      if (caret >= from && caret <= i) return trimRange(text, from, i);
      from = i + 1;
    }
  }
  return null;
}

// Range a weight change applies to, or null when there is nothing sensible to weight.
//  - a selection that is a whole (tag:1.2) group, or exactly its inside, targets the group
//  - any other selection is used as selected (surrounding spaces trimmed)
//  - with only a caret: the innermost enclosing (...) group, otherwise the tag under the caret
// <lora:...> style angle tags are never wrapped, because "(<lora:x:1>:1.1)" would break them.
export function locateWeightTarget(text, start, end) {
  if (start > end) [start, end] = [end, start];
  const groups = balancedGroups(text);
  let range = null;
  if (end > start) {
    range = groups.find(g => g.start === start && g.end === end) || null;
    if (!range) for (const g of groups) {
      const parsed = parseWeightGroup(text.slice(g.start, g.end));
      if (parsed && start === g.start + 1 && (end === g.end - 1 || end === g.start + 1 + parsed.inner.length)) { range = g; break; }
    }
    range ||= trimRange(text, start, end);
  } else {
    const enclosing = groups.filter(g => g.start < start && start < g.end).sort((a, b) => (a.end - a.start) - (b.end - b.start));
    range = enclosing[0] || segmentAt(text, start);
  }
  if (!range) return null;
  const slice = text.slice(range.start, range.end);
  return /^<[\s\S]*>$/.test(slice) ? null : { start: range.start, end: range.end };
}

function formatWeight(value) { return String(Number(value.toFixed(2))); }

// Adds `delta` to the weight of text[range]. A weight of exactly 1 is written as the plain text.
export function applyWeightDelta(text, range, delta) {
  const slice = text.slice(range.start, range.end), group = parseWeightGroup(slice);
  const inner = group ? group.inner : slice, next = Math.round(((group?.weight ?? 1) + delta) * 100) / 100;
  const replacement = Math.abs(next - 1) < 1e-9 ? inner : `(${inner}:${formatWeight(next)})`;
  return { text: text.slice(0, range.start) + replacement + text.slice(range.end), start: range.start, end: range.start + replacement.length };
}
