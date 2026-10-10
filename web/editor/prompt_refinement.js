import { validateWorkspaceRecipe, compileWorkspace } from "./recipe_workspace_model.js";
// Pure operations shared by both prompt editors. No model-specific formatting.
export const RECIPE_HEADER = "# Prompt Palette adjustable recipe v1 ";
export const RECIPE_SCHEMA = "prompt-palette.adjustable-recipe.v1";
export const BATCH_SCHEMA = "prompt-palette.prepared-batch.v1";

export function preciseReplacement(selected, replacement) {
  const text = String(selected ?? "");
  const match = text.match(/^(\s*)\(([^\n]*):([+-]?(?:\d+(?:\.\d*)?|\.\d+))\)(\s*)$/);
  const next = String(replacement ?? "");
  // A replacement that supplies its own explicit weight takes precedence.
  if (!match) {
    const boundary = text.match(/^(\s*)([\s\S]*?\S)(\s*)$/);
    if (!boundary) return next;
    return (boundary[1] && !/^\s/.test(next) ? boundary[1] : "") + next + (boundary[3] && !/\s$/.test(next) ? boundary[3] : "");
  }
  if (/^\s*\(.+:[+-]?(?:\d+(?:\.\d*)?|\.\d+)\)\s*$/.test(next)) return next;
  return `${match[1]}(${next}:${match[3]})${match[4]}`;
}

export function replaceRange(source, start, end, replacement, preserveWeight = true) {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > source.length) throw new Error("The selection is no longer valid.");
  const value = preserveWeight ? preciseReplacement(source.slice(start, end), replacement) : String(replacement);
  return { text: source.slice(0, start) + value + source.slice(end), start, end: start + value.length };
}

export function makeAlternatives(snapshot, text) {
  const seen = new Set();
  const values = String(text).split(/\r?\n/).map(v => v.trim()).filter(Boolean);
  if (values.length > 256) throw new Error("Use at most 256 alternatives at a time.");
  return values.map(value => preciseReplacement(snapshot.selected, value)).filter(value => {
    if (seen.has(value)) return false;
    seen.add(value); return true;
  }).map(value => ({ value, prompt: snapshot.prefix + value + snapshot.suffix }));
}

export function validateRecipe(recipe) {
  if (recipe?.schema === "prompt-palette.adjustable-recipe.v2") return validateWorkspaceRecipe(recipe);
  if (!recipe || recipe.schema !== RECIPE_SCHEMA || typeof recipe.source !== "string" || recipe.source.length > 1_000_000) throw new Error("This is not a supported adjustable recipe.");
  if (!Array.isArray(recipe.fields) || !recipe.fields.length || recipe.fields.length > 32) throw new Error("A recipe needs 1–32 adjustable fields.");
  const names = new Set(); let end = 0;
  const fields = recipe.fields.map(field => ({ ...field })).sort((a, b) => a.start - b.start);
  for (const field of fields) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(field.name) || names.has(field.name)) throw new Error("Field names must be unique; use letters, numbers and underscores.");
    if (!Number.isInteger(field.start) || !Number.isInteger(field.end) || field.start < end || field.end <= field.start || field.end > recipe.source.length) throw new Error("Recipe fields must be separate, valid selections.");
    for (const match of recipe.source.matchAll(/__[+\-*%~@]?[A-Za-z0-9_\-/]+(?:\([^\n]*?\))?__/g)) {
      if ((match.index < field.start && field.start < match.index + match[0].length) || (match.index < field.end && field.end < match.index + match[0].length)) throw new Error("Select a complete wildcard when making a recipe field.");
    }
    for (const offset of [field.start, field.end]) {
      const code = recipe.source.charCodeAt(offset);
      if (code >= 0xDC00 && code <= 0xDFFF) throw new Error("Recipe fields cannot split a Unicode character.");
    }
    const outside = recipe.source.slice(0, field.start) + recipe.source.slice(field.end);
    if (new RegExp("\\$\\{" + field.name + "(?:[=:}])").test(outside)) throw new Error("A field name conflicts with an existing prompt variable.");
    if (typeof field.default !== "string" || field.default.length > 100_000) throw new Error("Invalid field default.");
    names.add(field.name); end = field.end;
  }
  if (recipe.negative != null && (typeof recipe.negative !== "string" || recipe.negative.length > 1_000_000)) throw new Error("Invalid negative prompt.");
  return { ...recipe, schema: RECIPE_SCHEMA, source: recipe.source, negative: recipe.negative || "", fields };
}

export function fillRecipe(recipe, values = {}) {
  const valid = validateRecipe(recipe);
  if (valid.schema.endsWith(".v2")) return compileWorkspace(valid, values);
  let text = valid.source;
  for (const field of [...valid.fields].reverse()) {
    const value = Object.hasOwn(values, field.name) ? String(values[field.name]) : field.default;
    text = replaceRange(text, field.start, field.end, value).text;
  }
  return { positive: text, negative: valid.negative };
}

export function serializeRecipe(recipe) {
  const valid = validateRecipe(recipe);
  if (valid.schema.endsWith(".v2")) return "# Prompt Palette adjustable recipe v2 " + JSON.stringify(valid) + "\n" + compileWorkspace(valid).positive.split(/\r?\n/).filter(line => !line.trimStart().startsWith("#")).join(" ") + "\n";
  // Native default expansion uses the existing ${name:default} grammar. Keep the
  // fallback body on one line so ordinary wildcard readers see one complete option.
  let body = valid.source;
  for (const field of [...valid.fields].reverse()) {
    if (/[{}\n\r]/.test(field.default) || field.default.includes("${")) throw new Error("Field defaults must be single phrases without brace expressions. They can be filled with expressions when recalled.");
    const fallback = preciseReplacement(valid.source.slice(field.start, field.end), field.default);
    body = replaceRange(body, field.start, field.end, `\${${field.name}:${fallback}}`, false).text;
  }
  return RECIPE_HEADER + JSON.stringify(valid) + "\n" + body.split(/\r?\n/).filter(line => !line.trimStart().startsWith("#")).join(" ") + "\n";
}

export function parseRecipe(content) {
  const line = String(content).split(/\r?\n/, 1)[0];
  if (line.startsWith("# Prompt Palette adjustable recipe v2 ")) return validateRecipe(JSON.parse(line.slice("# Prompt Palette adjustable recipe v2 ".length)));
  if (!line.startsWith(RECIPE_HEADER)) return null;
  return validateRecipe(JSON.parse(line.slice(RECIPE_HEADER.length)));
}

export function recipeDependencies(recipe) {
  const positive = (recipe.schema === "prompt-palette.adjustable-recipe.v2" || recipe.schema === RECIPE_SCHEMA && recipe.fields.length) ? fillRecipe(recipe).positive : recipe.source;
  const history = recipe.experiments;
  const archived = history ? [history.base, ...history.snapshots.map(s => s.recipe)].filter(Boolean).flatMap(r => [compileWorkspace(r).positive, compileWorkspace(r).negative, ...r.fields.flatMap(f => [f.value, f.default, f.variationTemplate])]) : [];
  if (history) for (const variant of history.variants) archived.push(...variant.patch.fields.flatMap(f => [f.value, f.default, f.variationTemplate]), variant.patch.properties.negative || "", ...(variant.patch.segments || []).filter(s => s.type === "static").map(s => s.text));
  const source = [positive, recipe.negative, ...archived, ...(recipe.schema === "prompt-palette.adjustable-recipe.v2" ? recipe.fields.flatMap(f => [f.value, f.default, f.variationTemplate]) : [])].join("\n").split(/\r?\n/).filter(line => !line.trimStart().startsWith("#")).join("\n");
  return [...new Set(Array.from(source.matchAll(/__([+\-*%~@]?)([A-Za-z0-9_\-\/]+)(?:\([^\n]*?\))?__/g), m => m[2]))];
}

export function preparedBatch(source, prompts, snapshot = {}) {
  if (!prompts.length || prompts.length > 256 || prompts.some(p => typeof p !== "string") || prompts.reduce((n, p) => n + p.length, 0) > 4_000_000) throw new Error("The prepared batch is too large or empty.");
  return JSON.stringify({ schema: BATCH_SCHEMA, source, prompts, resolution_seed: snapshot.resolution_seed, template: snapshot.source, wildcards: snapshot.wildcards || [] });
}

// Prepared data uses its own backing state: a Nodes 2 remount must not replace a
// captured batch with the schema's empty presentation default.
export function installPreparedBatchState(node, widget) {
  if (!widget) return null;
  if (widget.__ppPreparedState) return widget.__ppPreparedState;
  const key = "prompt_palette_prepared_batch_v1";
  node.properties ||= {};
  let current = typeof widget.value === "string" && widget.value ? widget.value : typeof node.properties[key] === "string" ? node.properties[key] : "";
  const descriptor = Object.getOwnPropertyDescriptor(widget, "value");
  const write = value => {
    if (typeof value !== "string") return current;
    current = value; node.properties ||= {}; node.properties[key] = current;
    if (descriptor?.set) descriptor.set.call(widget, current);
    return current;
  };
  write(current);
  if (!descriptor || descriptor.configurable !== false) {
    Object.defineProperty(widget, "value", { configurable: true, enumerable: true,
      get: () => current,
      set: value => { if (value !== "" || !current) write(value); },
    });
  }
  widget.__ppSetPreparedBatch = value => { write(value); if (descriptor?.configurable === false) widget.value = current; };
  widget.serializeValue = () => current;
  const configured = node.onConfigure;
  node.onConfigure = function (info) {
    const saved = info?.properties?.[key];
    const index = node.widgets?.indexOf(widget) ?? -1;
    const named = info?.widgets_values_named?.[widget.name];
    const raw = typeof saved === "string" ? saved : typeof named === "string" ? named : index >= 0 && typeof info?.widgets_values?.[index] === "string" ? info.widgets_values[index] : "";
    const result = configured?.apply(this, arguments); write(raw);
    return result;
  };
  widget.__ppPreparedState = { commit: widget.__ppSetPreparedBatch, current: () => current };
  return widget.__ppPreparedState;
}
