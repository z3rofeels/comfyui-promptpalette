// A visual projection of the existing resolver syntax. No saved second rule model.
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
export function choiceLiteral(value) {
  const text = String(value).trim();
  if (!text || text.length > 240 || /[{}|\[\]\n\r$]/.test(text) || text.includes("__") || /^[+*~%@\-#]/.test(text) || /\d+(?:::|#|\$\$)/.test(text))
    throw new Error("Use short, plain choice names. Put wildcards and other syntax in the matching output.");
  if (!text.includes('"')) return `"${text}"`;
  if (!text.includes("'")) return `'${text}'`;
  throw new Error("A choice name can use single or double quotes, but not both.");
}
export function compilePromptRule(draft) {
  const name = String(draft.name || "").trim();
  if (!NAME.test(name) || name.length > 80) throw new Error("Variable names use up to 80 letters, numbers and underscores, and cannot start with a number.");
  if (["and", "or", "not", "in"].includes(name.toLowerCase())) throw new Error("Use a variable name other than a logic keyword (and, or, not, in).");
  if (!["fixed", "random", "existing"].includes(draft.mode)) throw new Error("Choose a supported selection mode.");
  const choices = draft.choices.map(value => String(value).trim());
  if (!choices.length || choices.length > 32 || new Set(choices).size !== choices.length) throw new Error("Add 1–32 different choices, one per line.");
  choices.forEach(choiceLiteral);
  if (draft.mode === "fixed" && !choices.includes(draft.selected)) throw new Error("Choose a value from this list.");
  const output = value => {
    const text = String(value || "");
    if (/[\n\r]/.test(text) || text.length > 100_000) throw new Error("Keep each matching output on one line so it also works in line-by-line mode.");
    return text;
  };
  const bodies = choices.map(choice => output(draft.outputs && Object.hasOwn(draft.outputs, choice) ? draft.outputs[choice] : ""));
  const join = draft.emit ? ", " : "";
  const assignment = draft.mode === "existing" ? "" : "${" + name + "=!" + (draft.mode === "random" ? `{${choices.join("|")}}` : draft.selected) + "}";
  const branches = choices.map((choice, index) => `[${index ? "elif" : "if"} ${name} == ${choiceLiteral(choice)}]${bodies[index] ? join + bodies[index] : ""}`).join("");
  const fallback = draft.mode === "existing" ? output(draft.fallback) : "";
  return assignment + (draft.emit ? "${" + name + "}" : "") + branches + (fallback ? `[else]${join}${fallback}` : "") + "[/if]";
}
export function parsePromptRule(text) {
  const assignment = text.match(/^\$\{([A-Za-z_]\w*)=!(\{[^{}]*\}|[^{}]*)\}/);
  let cursor = assignment?.[0].length || 0;
  const emit = text.slice(cursor).match(/^\$\{([A-Za-z_]\w*)\}/);
  if (emit) cursor += emit[0].length;
  const tags = text.slice(cursor).matchAll(/\[(if|elif|else|\/if)(?:\s+([^\]]+))?\]/gi);
  let depth = 0, bodyStart = 0, name = assignment?.[1] || emit?.[1], current = null, fallback = "", length = 0;
  const choices = [], outputs = Object.create(null);
  let first = true;
  for (const tag of tags) {
    if (first && (tag.index !== 0 || tag[1] !== "if")) return null;
    first = false;
    const kind = tag[1].toLowerCase(), offset = cursor + tag.index;
    if (depth === 1 && ["elif", "else", "/if"].includes(kind)) {
      const body = text.slice(bodyStart, offset);
      if (current === null) fallback = body; else outputs[current] = body;
    }
    if (kind === "if") depth++;
    if ((kind === "if" && depth === 1) || (kind === "elif" && depth === 1)) {
      const match = tag[2]?.match(/^([A-Za-z_]\w*) == (["'])(.*?)\2$/);
      if (!match || (name && name !== match[1])) return null;
      name = match[1]; current = match[3]; choices.push(current); bodyStart = offset + tag[0].length;
    } else if (kind === "else" && depth === 1) { current = null; bodyStart = offset + tag[0].length; }
    if (kind === "/if" && --depth === 0) { length = offset + tag[0].length; break; }
  }
  if (!length || !choices.length || (emit && emit[1] !== name)) return null;
  const expression = assignment?.[2], mode = !assignment ? "existing" : expression.startsWith("{") ? "random" : "fixed";
  if (mode === "random" && expression !== `{${choices.join("|")}}`) return null;
  const draft = { name, mode, choices, selected: mode === "fixed" ? expression : choices[0], outputs, emit: !!emit, fallback };
  if (draft.emit) {
    for (const choice of choices) if (outputs[choice]) { if (!outputs[choice].startsWith(", ")) return null; outputs[choice] = outputs[choice].slice(2); }
    if (fallback) { if (!fallback.startsWith(", ")) return null; draft.fallback = fallback.slice(2); }
  }
  try { if (compilePromptRule(draft) !== text.slice(0, length)) return null; } catch { return null; }
  return { draft, length };
}
export function promptRuleAt(source, start, end = start) {
  const selected = end > start ? parsePromptRule(source.slice(start, end)) : null;
  if (selected?.length === end - start) return { ...selected, start, end };
  if (end > start) return null;
  for (const match of source.matchAll(/\$\{[A-Za-z_]\w*=!|\[(?:if) [A-Za-z_]\w* == /g)) {
    let offset = match.index;
    if (match[0].startsWith("[")) {
      const prefix = source.slice(0, offset).match(/\$\{[A-Za-z_]\w*\}$/);
      if (prefix) offset -= prefix[0].length;
    }
    if (offset > start) break;
    const parsed = parsePromptRule(source.slice(offset));
    if (parsed && offset <= start && start < offset + parsed.length) return { ...parsed, start: offset, end: offset + parsed.length };
  }
  return null;
}
