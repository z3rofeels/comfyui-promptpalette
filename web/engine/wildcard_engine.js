const WILDCARD_RE = /__([+\-*%~@]?)([A-Za-z0-9_\-/*]+)(?:\(([^()]*)\))?__/g;
const SIMPLE_TOKEN_RE = /(__[+\-*%~@]?[A-Za-z0-9_\-/*]+(?:\([^()]*\))?__|\$\{[^{}]*\}|\d+::|\d+(?:-\d+)?\$\$[^$]*\$\$|\d+#|[{}|])/g;
const LORA_RE = /<lora:([^:>]+):([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)>/gi;
const CACHE_LIMIT = 768;

function normalize(value) { return String(value ?? "").replace(/\r\n?/g, "\n"); }

function parseArgs(raw) {
  const args = {};
  const source = String(raw || "").trim();
  if (!source) return args;
  for (const part of source.split(/\s*,\s*/)) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    if (key) args[key] = part.slice(idx + 1).trim();
  }
  return args;
}

function parseLine(raw) {
  if (raw.startsWith("#")) return { raw, segments: [{ type: "comment", text: raw, start: 0, end: raw.length }], wildcards: [], variables: [], choices: [] };
  const segments = [];
  const wildcards = [];
  const variables = [];
  const choices = [];
  let last = 0;
  SIMPLE_TOKEN_RE.lastIndex = 0;
  let match;
  while ((match = SIMPLE_TOKEN_RE.exec(raw))) {
    if (match.index > last) segments.push({ type: "text", text: raw.slice(last, match.index), start: last, end: match.index });
    const token = match[0];
    const wildcardMatch = token.match(/^__([+\-*%~@]?)([A-Za-z0-9_\-/*]+)(?:\(([^()]*)\))?__$/);
    let segment;
    if (wildcardMatch) {
      segment = {
        type: "wildcard", text: token, mode: wildcardMatch[1] || "", name: wildcardMatch[2] || "",
        argsRaw: wildcardMatch[3] || "", args: parseArgs(wildcardMatch[3]), start: match.index, end: match.index + token.length,
      };
      wildcards.push(segment);
    } else if (token.startsWith("${")) {
      const inner = token.slice(2, -1);
      const assign = inner.indexOf("=");
      const fallback = inner.indexOf(":");
      const split = assign >= 0 ? assign : fallback;
      segment = { type: "variable", text: token, name: (split >= 0 ? inner.slice(0, split) : inner).trim(), operator: assign >= 0 ? "=" : fallback >= 0 ? ":" : "", value: split >= 0 ? inner.slice(split + 1).trim() : "", start: match.index, end: match.index + token.length };
      variables.push(segment);
    } else if (/^\d+::$/.test(token)) segment = { type: "weight", text: token, start: match.index, end: match.index + token.length };
    else if (/^(?:\d+(?:-\d+)?\$\$|\d+#)/.test(token)) segment = { type: "modifier", text: token, start: match.index, end: match.index + token.length };
    else if (token === "{" || token === "}") {
      segment = { type: "bracket", text: token, start: match.index, end: match.index + 1 };
      choices.push(segment);
    } else if (token === "|") segment = { type: "pipe", text: token, start: match.index, end: match.index + 1 };
    else segment = { type: "text", text: token, start: match.index, end: match.index + token.length };
    segments.push(segment);
    last = match.index + token.length;
  }
  if (last < raw.length) segments.push({ type: "text", text: raw.slice(last), start: last, end: raw.length });
  return { raw, segments, wildcards, variables, choices };
}

function diagnosticSummary(issues) {
  const counts = { error: 0, warning: 0, info: 0 };
  for (const issue of issues) counts[issue.severity] = (counts[issue.severity] || 0) + 1;
  return { issues, counts, status: counts.error ? "error" : counts.warning ? "warning" : counts.info ? "info" : "clean" };
}

export class UnifiedWildcardEngine {
  constructor({ lineCacheLimit = CACHE_LIMIT } = {}) {
    this.lineCacheLimit = Math.max(64, Number(lineCacheLimit) || CACHE_LIMIT);
    this.lineCache = new Map();
    this.lastSource = null;
    this.lastAnalysis = null;
  }
  clear() { this.lineCache.clear(); this.lastSource = null; this.lastAnalysis = null; }
  _parseLine(raw) {
    const hit = this.lineCache.get(raw);
    if (hit) { this.lineCache.delete(raw); this.lineCache.set(raw, hit); return hit; }
    const parsed = parseLine(raw);
    this.lineCache.set(raw, parsed);
    if (this.lineCache.size > this.lineCacheLimit) this.lineCache.delete(this.lineCache.keys().next().value);
    return parsed;
  }
  parse(sourceText) {
    const source = normalize(sourceText);
    if (source === this.lastSource && this.lastAnalysis) return this.lastAnalysis;
    const lines = source.split("\n");
    const ast = [];
    const wildcards = [];
    const variables = [];
    const names = new Set();
    let offset = 0;
    for (let index = 0; index < lines.length; index++) {
      const raw = lines[index];
      const parsed = this._parseLine(raw);
      const line = { raw, offset, index, parsed };
      ast.push(line);
      for (const token of parsed.wildcards) {
        const full = { ...token, start: offset + token.start, end: offset + token.end, line: index };
        wildcards.push(full); names.add(token.name);
      }
      for (const token of parsed.variables) variables.push({ ...token, start: offset + token.start, end: offset + token.end, line: index });
      offset += raw.length + (index < lines.length - 1 ? 1 : 0);
    }
    const result = { source, ast, lines: ast, wildcards, variables, names: Array.from(names), chars: source.length };
    this.lastSource = source; this.lastAnalysis = result;
    return result;
  }
  validate(parsedOrText, { libraryEntries = [], tokenCount = null } = {}) {
    const parsed = typeof parsedOrText === "string" ? this.parse(parsedOrText) : parsedOrText;
    const source = parsed?.source || "";
    const entryMap = new Map((libraryEntries || []).map((entry) => [String(entry?.path || ""), entry]));
    const known = new Set(entryMap.keys());
    const issues = [];
    const add = (severity, code, title, detail, extra = {}) => issues.push({ severity, code, title, detail, ...extra });

    const underscores = (source.match(/__/g) || []).length;
    if (underscores % 2) add("error", "unclosed-wildcard", "Unclosed wildcard token", "A double-underscore wildcard delimiter is missing its closing pair.");

    const duplicateWildcards = new Map();
    for (const token of parsed?.wildcards || []) {
      const glob = token.name.includes("*");
      const plainName = token.name.replace(/\*+$/g, "");
      if (!glob && !known.has(token.name)) add("error", "missing-wildcard", "Missing library entry", `“${token.name}” is not in My Library.`, { token });
      else if (!glob && Number(entryMap.get(token.name)?.count) === 0) add("warning", "empty-wildcard", "Empty library entry", `“${token.name}” has no usable lines.`, { token });
      else if (glob && !plainName) add("warning", "broad-glob", "Very broad wildcard pattern", `“${token.name}” may match more of the library than intended.`, { token });
      const key = `${token.mode}|${token.name}|${token.argsRaw || ""}`;
      duplicateWildcards.set(key, (duplicateWildcards.get(key) || 0) + 1);
      if (token.argsRaw && !Object.keys(token.args).length) add("warning", "invalid-parameter-wildcard", "Parameter wildcard arguments look invalid", `“${token.text}” does not contain any name=value arguments.`, { token });
      if (token.argsRaw && token.mode) add("error", "parameter-modifier-conflict", "Conflicting wildcard syntax", `“${token.text}” combines a wildcard mode with parameter arguments. Parameter wildcards must use the plain __Name(key=value)__ form.`, { token });
    }
    for (const [key, count] of duplicateWildcards) if (count > 2) add("info", "repeated-wildcard", "Repeated wildcard expression", `The same wildcard expression appears ${count} times (${key.split("|")[1]}).`);

    let braceDepth = 0;
    let variableDepth = 0;
    for (let index = 0; index < source.length; index++) {
      if (source.startsWith("${", index)) { variableDepth += 1; index += 1; continue; }
      if (source[index] === "{" && (index === 0 || source[index - 1] !== "$")) braceDepth += 1;
      if (source[index] === "}") {
        if (variableDepth > 0) variableDepth -= 1; else braceDepth -= 1;
        if (braceDepth < 0) { add("error", "extra-brace", "Extra closing brace", "A closing brace appears without a matching opening brace."); braceDepth = 0; }
      }
    }
    if (braceDepth > 0 || variableDepth > 0) add("error", "unclosed-brace", "Unclosed choice or variable", "One or more brace expressions do not have a closing brace.");

    const assigned = new Set();
    for (const variable of parsed?.variables || []) {
      if (variable.operator === "=") assigned.add(variable.name);
      else if (!assigned.has(variable.name) && variable.operator !== ":") add("warning", "unreachable-variable", "Variable may be undefined", `“${variable.name}” is referenced before Prompt Palette sees an assignment or fallback.`, { token: variable });
    }

    const seenLoras = new Map();
    for (const match of source.matchAll(LORA_RE)) {
      const key = String(match[1] || "").trim().toLowerCase();
      if (!key) continue;
      if (seenLoras.has(key)) add("warning", "duplicate-lora", "Duplicate LoRA tag", `“${match[1].trim()}” appears more than once.`, { index: match.index ?? 0 });
      else seenLoras.set(key, match.index ?? 0);
    }
    if (/,{2,}/.test(source) || /,\s*,/.test(source)) add("info", "double-comma", "Repeated comma", "The prompt contains consecutive commas that may be accidental.");
    if (/\s+[,.!?;:]/.test(source)) add("info", "space-before-punctuation", "Spacing before punctuation", "There is whitespace directly before punctuation.");
    if (Number.isFinite(Number(tokenCount)) && Number(tokenCount) > 77) add("info", "clip-token-length", "Long CLIP prompt", `${Number(tokenCount)} CLIP-L tokens are present. Some CLIP workflows chunk long prompts; verify that this is intentional.`);
    const rank = { error: 0, warning: 1, info: 2 };
    issues.sort((a, b) => rank[a.severity] - rank[b.severity] || a.code.localeCompare(b.code));
    return diagnosticSummary(issues);
  }
  autocompleteContext(sourceText, caret) {
    const source = normalize(sourceText);
    const before = source.slice(0, Math.max(0, Number(caret) || 0));
    const match = before.match(/__([+\-*%~@]?)([A-Za-z0-9_\-/]*)$/);
    if (!match) return null;
    const start = match.index;
    const priorPairs = (before.slice(0, start).match(/__/g) || []).length;
    if (priorPairs % 2 !== 0) return null;
    return { query: match[2] || "", modifier: match[1] || "", start, end: before.length };
  }
  stats() { return { cachedLines: this.lineCache.size, lastChars: this.lastSource?.length || 0 }; }
}

const sharedEngine = new UnifiedWildcardEngine();
export function getSharedWildcardEngine() { return sharedEngine; }
export function parsePrompt(text) { return sharedEngine.parse(text); }
export function validatePrompt(parsedOrText, options) { return sharedEngine.validate(parsedOrText, options); }
export function extractPromptTokens(text) { return sharedEngine.parse(text).wildcards.map((token) => ({ raw: token.text, mode: token.mode, name: token.name, args: token.argsRaw, start: token.start, end: token.end })); }
