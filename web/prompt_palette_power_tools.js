import { getSharedWildcardEngine, extractPromptTokens as engineExtractPromptTokens } from "./engine/wildcard_engine.js";

function normalizeText(value) { return String(value ?? "").replace(/\r\n?/g, "\n"); }

export function extractPromptTokens(text) { return engineExtractPromptTokens(text); }

export function analyzePromptSource({ text, libraryEntries = [], tokenCount = null, parsed = null } = {}) {
  const engine = getSharedWildcardEngine();
  const analysis = parsed || engine.parse(text);
  return engine.validate(analysis, { libraryEntries, tokenCount });
}

function wordTokens(value) {
  return normalizeText(value).match(/\s+|[\w’'-]+|[^\w\s]/gu) || [];
}

export function buildResolvedDiff(source, resolved, parsed = null) {
  const canonicalSource = parsed?.source ?? source;
  const left = wordTokens(canonicalSource);
  const right = wordTokens(resolved);
  const n = left.length;
  const m = right.length;
  if (n * m > 250000) return [{ type: "changed", text: normalizeText(resolved) }];

  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = left[i] === right[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const changedRight = new Set();
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (left[i] === right[j]) { i += 1; j += 1; continue; }
    if (dp[i + 1][j] >= dp[i][j + 1]) i += 1;
    else { changedRight.add(j); j += 1; }
  }
  while (j < m) changedRight.add(j++);

  const segments = [];
  for (let index = 0; index < right.length; index += 1) {
    const type = changedRight.has(index) && !/^\s+$/.test(right[index]) ? "changed" : "same";
    const previous = segments[segments.length - 1];
    if (previous?.type === type) previous.text += right[index];
    else segments.push({ type, text: right[index] });
  }
  return segments;
}

function recipeToken(path, operator = "seeded") {
  const clean = String(path || "").trim();
  const mode = { seeded: "", unseeded: "*", forward: "+", backward: "-", combinatorial: "%" }[operator] ?? "";
  return `__${mode}${clean}__`;
}

export function buildRecipeSource({ paths = [], operator = "seeded", separator = ", ", prefix = "", suffix = "" } = {}) {
  const unique = [];
  const seen = new Set();
  for (const path of paths) {
    const clean = String(path || "").trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    unique.push(clean);
  }
  const body = unique.map((path) => recipeToken(path, operator)).join(String(separator ?? ", "));
  return `${String(prefix || "")}${body}${String(suffix || "")}`;
}

export function summarizeLibraryHealth(payload = {}) {
  const groups = [
    ["emptyEntries", "Empty entries"],
    ["duplicateGroups", "Duplicate content"],
    ["brokenRecipes", "Broken recipes"],
    ["orphanThumbnails", "Orphan thumbnails"],
  ];
  return groups.map(([key, label]) => ({ key, label, count: Array.isArray(payload[key]) ? payload[key].length : 0 }));
}
