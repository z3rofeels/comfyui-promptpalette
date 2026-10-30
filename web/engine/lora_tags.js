import { maskJsonObjects } from "./json_literals.js";

const NUMBER = "[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?";
export const LORA_RE = new RegExp(`<lora:([^:<>\\r\\n]+):(${NUMBER})(?::(${NUMBER}))?>`, "gi");
export function loraTags(text) {
  const masked = maskJsonObjects(String(text).split("\n").map(line => /^\s*#/.test(line) ? " ".repeat(line.length) : line).join("\n"));
  return [...masked.matchAll(LORA_RE)].filter(m => m[1].trim() && Number.isFinite(Number(m[2])) && Number.isFinite(Number(m[3] ?? m[2])))
    .map(m => ({ start: m.index, end: m.index + m[0].length, name: m[1].trim(), model: Number(m[2]), clip: Number(m[3] ?? m[2]), text: m[0] }));
}
export function loraAt(text, position) { return loraTags(text).find(tag => tag.start <= position && position < tag.end) || null; }
// Only top-level tags can move without changing a choice, variable, or rule.
export function standaloneLoraTags(text) {
  const source = maskJsonObjects(String(text).split("\n").map(line => /^\s*#/.test(line) ? " ".repeat(line.length) : line).join("\n"));
  const tokens = new RegExp(`${LORA_RE.source}|__[A-Za-z0-9_\\-/]+\\(|\\)__|[{}]|\\[(?:if|/if|switch|/switch)(?:\\s+[^\\]]+)?\\]`, "gi");
  const safe = new Set();
  let braces = 0, rules = 0, parameters = 0;
  for (const match of source.matchAll(tokens)) {
    const token = match[0];
    if (/^<lora:/i.test(token)) {
      if (!braces && !rules && !parameters && !/__|[{}$\[\]]/.test(match[1])) safe.add(match.index);
    } else if (token === "{") braces++;
    else if (token === "}") braces = Math.max(0, braces - 1);
    else if (token.startsWith("__")) parameters++;
    else if (token === ")__") parameters = Math.max(0, parameters - 1);
    else if (token.startsWith("[/")) rules = Math.max(0, rules - 1);
    else rules++;
  }
  return loraTags(text).filter(tag => safe.has(tag.start));
}
export function loraTagName(name) {
  const normalized = name.replace(/\\/g, "/");
  if (/[\r\n]/.test(normalized)) throw new Error("LoRA filenames cannot contain line breaks in prompt tags.");
  if (/[:<>{}|$%]|__|\[(?:if|elif|else|\/if|switch|case|default|\/switch)\b/i.test(normalized)) return normalized.split("/").map(part => encodeURIComponent(part).replace(/_/g, "%5F")).join("/");
  return normalized;
}
export function buildLoraExpression({ names, model = 1, clip = model, linked = true, strengths = [], mode = "stack", off = false }) {
  if (!names.length) throw new Error("Choose at least one local LoRA.");
  if (names.some(name => !name)) throw new Error("Choose a named LoRA file.");
  if (![model, clip, ...strengths].every(value => Number.isFinite(value) && Math.abs(value) <= 100)) throw new Error("Use finite strengths between −100 and 100.");
  if (mode === "stack" && strengths.length) throw new Error("Choose a variation mode to use a strength sweep.");
  const values = strengths.length ? strengths : [model];
  if (names.length * values.length > 256) throw new Error("Use at most 256 LoRA/strength alternatives.");
  const tag = (name, sm, sc) => `<lora:${name}:${sm}${sm === sc ? "" : `:${sc}`}>`;
  const options = names.flatMap(name => values.map(sm => tag(loraTagName(name), sm, linked ? sm : clip)));
  if (off) {
    const baseline = tag(loraTagName(names[0]), 0, 0);
    if (!options.includes(baseline)) options.push(baseline);
  }
  if (mode === "stack") return options.join(" ");
  const prefix = { seeded: "", cycle: "+", previous: "-", random: "*", cartesian: "%", batch: "" }[mode];
  if (prefix === undefined) throw new Error("Unknown LoRA variation mode.");
  return `{${prefix}${options.join("|")}}`;
}

export function formatLoraTag(tag, model = tag.model, clip = tag.clip) {
  const number = value => Number(Math.max(-100, Math.min(100, value)).toFixed(4));
  model = number(model); clip = number(clip);
  return `<lora:${tag.name}:${model}${model === clip ? "" : `:${clip}`}>`;
}

// A mode action may replace a pure LoRA choice, never a surrounding prompt rule.
export function loraChoiceAt(text, position) {
  const tag = loraAt(text, position);
  if (!tag) return null;
  const stack = [], groups = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{") stack.push(i);
    else if (text[i] === "}" && stack.length) {
      const start = stack.pop();
      if (start < tag.start && i >= tag.end && text[start - 1] !== "$") groups.push({ start, end: i + 1 });
    }
  }
  for (const group of groups) {
    let inner = text.slice(group.start + 1, group.end - 1), mode = "";
    if (/^[+\-*~@%]/.test(inner)) { mode = inner[0]; inner = inner.slice(1); }
    const options = inner.split("|").map(value => value.trim());
    if (options.length > 1 && options.every(value => { const tags = loraTags(value); return tags.length === 1 && tags[0].text === value; })) return { ...group, mode, options, tag };
  }
  return { ...tag, mode: "", options: [tag.text], tag };
}

export function loraModeExpression(expression, mode) {
  const options = expression.options.length > 1 ? expression.options : [0.4, 0.7, 1].map(strength => formatLoraTag(expression.tag, strength, expression.tag.model === expression.tag.clip ? strength : expression.tag.clip));
  const prefix = { seeded: "", cycle: "+", previous: "-", random: "*", cartesian: "%", batch: "" }[mode];
  if (prefix === undefined) throw new Error("Unknown LoRA variation mode.");
  return `{${prefix}${options.join("|")}}`;
}
