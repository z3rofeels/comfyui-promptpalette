// Ordered Adjustable Recipe state. Compiled text is a projection, never a second model.
export const WORKSPACE_SCHEMA = "prompt-palette.adjustable-recipe.v2";
export const WORKSPACE_KEY = "prompt_palette_recipe_workspace_v2";
// ComfyUI can wrap workflow properties in reactive Proxies when tabs remount.
// Native structuredClone rejects those wrappers. Copy enumerable saved data
// through property access so every persistence/history boundary gets plain data.
export function cloneWorkspaceData(value) {
  const copies = new WeakMap(), active = new WeakSet();
  function copy(input) {
    if (input === null || input === undefined || ["string", "boolean", "number"].includes(typeof input)) return input;
    if (typeof input !== "object" || (!Array.isArray(input) && Object.prototype.toString.call(input) !== "[object Object]")) throw new Error("Workspace contains unsupported saved data.");
    if (active.has(input)) throw new Error("Workspace saved data cannot contain circular references.");
    if (copies.has(input)) return copies.get(input);
    const output = Array.isArray(input) ? new Array(input.length) : {};
    copies.set(input, output); active.add(input);
    for (const key of Object.keys(input)) Object.defineProperty(output, key, { value: copy(input[key]), enumerable: true, writable: true, configurable: true });
    active.delete(input); return output;
  }
  return copy(value);
}
export const separators = { comma: ", ", newline: "\n", space: " ", none: "" };
export function fieldId() { return globalThis.crypto?.randomUUID?.() || `f_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`; }
export const EXPERIMENT_STATES = ["lock", "vary", "follow"];
export function newField(label = "Section") { return { id: fieldId(), name: label, label, value: "", default: "", enabled: true, collapsed: false, channel: "positive", fieldType: "text", separator: null, experimentState: null, dependsOn: [] }; }
export function validateWorkspaceRecipe(recipe, { coreOnly = false } = {}) {
  if (recipe?.schema !== WORKSPACE_SCHEMA || !Array.isArray(recipe.fields) || recipe.fields.length > 32 || !Array.isArray(recipe.segments) || recipe.segments.length > 256) throw new Error("Invalid workspace recipe.");
  const ids = new Set();
  const fields = recipe.fields.map(f => {
    if (typeof f.id !== "string" || !f.id || ids.has(f.id)) throw new Error("Workspace field IDs must be unique.");
    ids.add(f.id);
    if (typeof f.value !== "string" || f.value.length > 100_000 || (f.default != null && typeof f.default !== "string")) throw new Error("Invalid workspace field text.");
    if (f.variationTemplate != null && (typeof f.variationTemplate !== "string" || f.variationTemplate.length > 100_000)) throw new Error("Invalid retained variation choices.");
    if (f.separator != null && (typeof f.separator !== "string" || f.separator.length > 1024)) throw new Error("Invalid field separator.");
    if (f.channel != null && !["positive", "negative"].includes(f.channel)) throw new Error("Invalid prompt channel.");
    if (f.experimentState != null && !EXPERIMENT_STATES.includes(f.experimentState)) throw new Error("Invalid field experiment state.");
    if (f.fieldType != null && (typeof f.fieldType !== "string" || f.fieldType.length > 80)) throw new Error("Invalid field type.");
    if (f.dependsOn != null && (!Array.isArray(f.dependsOn) || f.dependsOn.length > 32 || f.dependsOn.some(id => typeof id !== "string"))) throw new Error("Invalid Follow dependencies.");
    return { ...f, dependsOn: [...new Set(f.dependsOn || [])], label: String(f.label ?? f.name ?? "Section"), default: f.default ?? f.value, enabled: f.enabled !== false, collapsed: !!f.collapsed, channel: f.channel || "positive", experimentState: f.experimentState ?? null };
  });
  for (const f of fields) if (f.dependsOn.some(id => id === f.id || !ids.has(id))) throw new Error("Follow dependencies must reference other existing fields.");
  const referenced = new Set();
  const segments = recipe.segments.map(s => {
    if (s.type === "field") {
      if (!ids.has(s.id) || referenced.has(s.id)) throw new Error("Invalid workspace field reference.");
      referenced.add(s.id);
    } else if (s.type !== "static" || typeof s.text !== "string" || s.text.length > 1_000_000) throw new Error("Unsupported workspace segment; original recipe has not been changed.");
    if (s.channel != null && !["positive", "negative"].includes(s.channel)) throw new Error("Invalid static prompt channel.");
    return { ...s };
  });
  if (referenced.size !== ids.size) throw new Error("Every field must have a segment.");
  if (recipe.separator != null && (typeof recipe.separator !== "string" || recipe.separator.length > 1024)) throw new Error("Invalid recipe separator.");
  if (recipe.negative != null && (typeof recipe.negative !== "string" || recipe.negative.length > 1_000_000)) throw new Error("Invalid negative prompt.");
  const result = { ...recipe, fields, segments, separator: recipe.separator ?? ", ", negative: recipe.negative || "" };
  delete result.experiments;
  if (!coreOnly && recipe.experiments != null) result.experiments = validateExperiments(recipe.experiments);
  return result;
}
export function workspaceFromRecipe(recipe) {
  if (recipe.schema === WORKSPACE_SCHEMA) return validateWorkspaceRecipe(cloneWorkspaceData(recipe));
  let offset = 0;
  const fields = [], segments = [];
  for (const f of recipe.fields) {
    if (f.start > offset) segments.push({ type: "static", text: recipe.source.slice(offset, f.start), boundary: /^[,\s]*$/.test(recipe.source.slice(offset, f.start)) });
    const field = { ...newField(f.label || f.name), ...f, id: f.id || fieldId(), label: f.label || f.name, value: f.value ?? f.default, default: f.default, sourceAssociation: { start: f.start, end: f.end } };
    // Keep weighting around an explicitly selected weighted phrase.
    const original = recipe.source.slice(f.start, f.end), m = original.match(/^(\s*)\(([^\n]*):([+-]?(?:\d+(?:\.\d*)?|\.\d+))\)(\s*)$/);
    if (m && !/^\s*\(.+:[+-]?(?:\d+(?:\.\d*)?|\.\d+)\)\s*$/.test(field.value)) { field.value = `${m[1]}(${field.value}:${m[3]})${m[4]}`; field.default = `${m[1]}(${field.default}:${m[3]})${m[4]}`; }
    fields.push(field); segments.push({ type: "field", id: field.id, join: false }); offset = f.end;
  }
  if (offset < recipe.source.length) segments.push({ type: "static", text: recipe.source.slice(offset), boundary: /^[,\s]*$/.test(recipe.source.slice(offset)) });
  return validateWorkspaceRecipe({ ...recipe, schema: WORKSPACE_SCHEMA, fields, segments, separator: ", " });
}
function joinBoundary(left, separator, right) {
  if (!left || !right) return "";
  if (separator === ", ") return /,\s*$/.test(left) || /^\s*,/.test(right) ? " " : ", ";
  if (separator === " " && (/\s$/.test(left) || /^\s/.test(right))) return "";
  if (separator === "\n" && (/\n$/.test(left) || /^\n/.test(right))) return "";
  return separator;
}
export function compileWorkspace(recipe, values = {}) {
  const valid = validateWorkspaceRecipe(recipe), lookup = new Map(valid.fields.map(f => [f.id, f]));
  const spans = {}, outputs = {};
  for (const channel of ["positive", "negative"]) {
    let text = "", pending = "", hasPending = false;
    const channelFields = valid.segments.filter(s => s.type === "field" && lookup.get(s.id).channel === channel).map(s => lookup.get(s.id));
    const active = f => f && f.enabled && String(Object.hasOwn(values, f.id) ? values[f.id] : Object.hasOwn(values, f.name) ? values[f.name] : f.value).trim();
    const preservePrefix = active(channelFields[0]), preserveSuffix = active(channelFields.at(-1));
    for (const s of valid.segments) {
      if (s.type === "static") {
        if ((s.channel || "positive") !== channel) continue;
        if (s.boundary) { if (!hasPending) pending = s.text; hasPending = true; continue; }
        // Literal static text is never rewritten or trimmed.
        text += pending + s.text; pending = ""; hasPending = false; continue;
      }
      const f = lookup.get(s.id);
      if (f.channel !== channel || !f.enabled) continue;
      const value = Object.hasOwn(values, f.id) ? String(values[f.id]) : Object.hasOwn(values, f.name) ? String(values[f.name]) : f.value;
      if (!value.trim()) continue;
      const separator = f.separator ?? (hasPending ? valid.overrideBoundaries ? valid.separator : pending : s.join || channel === "negative" ? valid.separator : "");
      text += !text && hasPending && preservePrefix ? pending : joinBoundary(text, separator, value);
      spans[f.id] = { start: text.length, end: text.length + value.length, channel };
      text += value; pending = ""; hasPending = false;
    }
    if (hasPending && preserveSuffix) text += pending;
    outputs[channel] = text;
  }
  const negativeOffset = valid.negative ? valid.negative.length + (outputs.negative ? 1 : 0) : 0;
  for (const span of Object.values(spans)) if (span.channel === "negative") { span.start += negativeOffset; span.end += negativeOffset; }
  outputs.negative = [valid.negative, outputs.negative].filter(Boolean).join("\n");
  if (outputs.positive.length > 1_000_000 || outputs.negative.length > 1_000_000) throw new Error("Compiled workspace is too large.");
  return { ...outputs, spans };
}
export function blankWorkspace(source = "") {
  const f = newField("Prompt"); f.value = f.default = source;
  return { schema: WORKSPACE_SCHEMA, name: "Prompt workspace", separator: ", ", negative: "", fields: [f], segments: [{ type: "field", id: f.id, join: true }] };
}
export function reorderField(recipe, id, direction) {
  const positions = recipe.segments.map((s, i) => s.type === "field" ? i : -1).filter(i => i >= 0);
  const index = positions.findIndex(i => recipe.segments[i].id === id), other = index + direction;
  if (index < 0 || other < 0 || other >= positions.length) return;
  const a = positions[index], b = positions[other];
  [recipe.segments[a], recipe.segments[b]] = [recipe.segments[b], recipe.segments[a]];
}

// Checkpoints contain core recipes only: histories never recursively contain histories.
export const EXPERIMENT_SCHEMA = "prompt-palette.workspace-experiments.v1";
export function workspaceCore(recipe) { return validateWorkspaceRecipe(cloneWorkspaceData(recipe), { coreOnly: true }); }
function validateExperiments(input) {
  if (!input || input.schema !== EXPERIMENT_SCHEMA || !Array.isArray(input.snapshots) || input.snapshots.length > 100 || !Array.isArray(input.variants) || input.variants.length > 64) throw new Error("Invalid workspace experiment history.");
  const ids = new Set();
  const record = item => {
    if (!item || typeof item.id !== "string" || !item.id || ids.has(item.id) || typeof item.name !== "string" || !item.name.trim() || item.name.length > 120) throw new Error("Invalid or duplicate checkpoint identity.");
    ids.add(item.id); return { ...item };
  };
  const core = r => { if (r?.experiments != null) throw new Error("Nested checkpoint histories are not supported."); return workspaceCore(r); };
  const base = input.base ? core(input.base) : null;
  const variants = input.variants.map(v => {
    const result = record(v);
    if (!base || !v.patch || !Array.isArray(v.patch.fields) || !Array.isArray(v.patch.removed) || !v.patch.properties || typeof v.patch.properties !== "object" || Array.isArray(v.patch.properties)) throw new Error("Invalid workspace variant.");
    if (v.patch.fields.length > 32 || v.patch.removed.length > 32 || v.patch.removed.some(id => typeof id !== "string") || v.patch.fields.some(f => !f || typeof f.id !== "string")) throw new Error("Invalid variant fields.");
    const patchIds = new Set(v.patch.fields.map(f => f.id));
    if (patchIds.size !== v.patch.fields.length || v.patch.fields.some(f => v.patch.removed.includes(f.id)) || Object.hasOwn(v.patch.properties, "experiments")) throw new Error("Invalid variant overrides.");
    const merged = mergeVariantCore(base, v.patch);
    core(merged); return result;
  });
  const snapshots = input.snapshots.map(s => ({ ...record(s), recipe: core(s.recipe) }));
  if (input.activeVariantId != null && !variants.some(v => v.id === input.activeVariantId)) throw new Error("The active workspace variant is missing.");
  if (JSON.stringify(input).length > 16_000_000) throw new Error("Workspace history is too large. Export or remove older checkpoints.");
  return { ...input, base, snapshots, variants, activeVariantId: input.activeVariantId || null };
}
export function mergeVariantCore(base, patch) {
  const override = new Map(patch.fields.map(f => [f.id, f]));
  const fields = base.fields.filter(f => !patch.removed.includes(f.id)).map(f => override.get(f.id) || f);
  const baseIds = new Set(base.fields.map(f => f.id));
  fields.push(...patch.fields.filter(f => !baseIds.has(f.id)));
  const ids = new Set(fields.map(f => f.id));
  const segments = (patch.segments || base.segments).filter(s => s.type !== "field" || ids.has(s.id));
  for (const f of fields) if (!segments.some(s => s.type === "field" && s.id === f.id)) segments.push({ type: "field", id: f.id, join: true });
  const properties = { ...patch.properties }; delete properties.fields; delete properties.segments; delete properties.experiments;
  // Removing a source cleans inherited dependencies without dangling references.
  return { ...cloneWorkspaceData(base), ...properties, fields: fields.map(f => ({ ...cloneWorkspaceData(f), dependsOn: (f.dependsOn || []).filter(id => ids.has(id) && id !== f.id) })), segments: cloneWorkspaceData(segments) };
}
