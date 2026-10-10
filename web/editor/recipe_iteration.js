import { cloneWorkspaceData, validateWorkspaceRecipe, workspaceCore, compileWorkspace, newField, fieldId, mergeVariantCore, EXPERIMENT_SCHEMA } from "./recipe_workspace_model.js";
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sameField = (a, b) => { if (!a || !b) return a === b; const left = { ...a }, right = { ...b }; delete left.collapsed; delete right.collapsed; return same(left, right); };
const nameOf = name => { const value = String(name || "").trim(); if (!value || value.length > 120) throw new Error("Use a name with 1–120 characters."); return value; };
export function historyOf(recipe) {
  return recipe.experiments || { schema: EXPERIMENT_SCHEMA, base: null, activeVariantId: null, snapshots: [], variants: [] };
}
function editableCore(recipe) {
  const core = workspaceCore(recipe); delete core.name; delete core.presetId; return core;
}
export function variantPatch(base, current) {
  const left = editableCore(base), right = editableCore(current), lookup = new Map(left.fields.map(f => [f.id, f]));
  const properties = {};
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    if (["fields", "segments", "experiments"].includes(key)) continue;
    if (!same(left[key], right[key])) properties[key] = right[key] ?? null;
  }
  return { fields: right.fields.filter(f => !sameField(lookup.get(f.id), f)), removed: left.fields.filter(f => !right.fields.some(x => x.id === f.id)).map(f => f.id), properties,
    ...(same(left.segments, right.segments) ? {} : { segments: right.segments }) };
}
export function captureBranch(recipe) {
  const next = cloneWorkspaceData(recipe), h = next.experiments;
  if (!h?.base) return next;
  if (h.activeVariantId) h.variants.find(v => v.id === h.activeVariantId).patch = variantPatch(h.base, next);
  else h.base = workspaceCore(next);
  return validateWorkspaceRecipe(next);
}
export function branchRecipe(recipe, id = null) {
  const h = historyOf(recipe);
  if (!h.base) return workspaceCore(recipe);
  if (!id) return workspaceCore(h.base);
  const variant = h.variants.find(v => v.id === id); if (!variant) throw new Error("Variant not found.");
  return validateWorkspaceRecipe(mergeVariantCore(h.base, variant.patch));
}
export function switchBranch(recipe, id = null) {
  const next = captureBranch(recipe), h = historyOf(next);
  if (!h.base) throw new Error("Create a variant first.");
  const core = branchRecipe(next, id); h.activeVariantId = id;
  return validateWorkspaceRecipe({ ...core, name: next.name, experiments: h });
}
export function saveVariant(recipe, name, overwriteId = null) {
  const next = captureBranch(recipe), h = cloneWorkspaceData(historyOf(next)); name = nameOf(name);
  h.base ||= workspaceCore(next);
  const existing = h.variants.find(v => v.name.toLowerCase() === name.toLowerCase());
  if (existing && existing.id !== overwriteId) throw new Error("A variant with this name exists. Confirm replacement first.");
  if (!existing && h.variants.length >= 64) throw new Error("Export or remove a variant before adding another (64 per workspace).");
  const v = { id: existing?.id || fieldId(), name, patch: variantPatch(h.base, next) };
  if (existing) h.variants[h.variants.indexOf(existing)] = v; else h.variants.push(v);
  h.activeVariantId = v.id; next.experiments = h; return validateWorkspaceRecipe(next);
}
export function resetInheritedField(recipe, id) {
  const next = captureBranch(recipe), h = historyOf(next);
  if (!h.activeVariantId) throw new Error("Switch to a variant first.");
  const v = h.variants.find(v => v.id === h.activeVariantId);
  if (!h.base.fields.some(f => f.id === id)) throw new Error("This field was added in the variant and has no base value.");
  v.patch.fields = v.patch.fields.filter(f => f.id !== id); v.patch.removed = v.patch.removed.filter(x => x !== id);
  return validateWorkspaceRecipe({ ...branchRecipe(next, v.id), name: next.name, experiments: h });
}
export function saveSnapshot(recipe, name, overwriteId = null) {
  const next = captureBranch(recipe), h = cloneWorkspaceData(historyOf(next)); name = nameOf(name);
  const existing = h.snapshots.find(s => s.name.toLowerCase() === name.toLowerCase());
  if (existing && existing.id !== overwriteId) throw new Error("A snapshot with this name exists. Confirm replacement first.");
  if (!existing && h.snapshots.length >= 100) throw new Error("Export or remove a snapshot before adding another (100 per workspace).");
  const snapshot = { id: existing?.id || fieldId(), name, createdAt: new Date().toISOString(), recipe: workspaceCore(next) };
  if (existing) h.snapshots[h.snapshots.indexOf(existing)] = snapshot; else h.snapshots.push(snapshot);
  next.experiments = h; return validateWorkspaceRecipe(next);
}
export function restoreSnapshot(recipe, id) {
  const next = captureBranch(recipe), h = historyOf(next), snapshot = h.snapshots.find(s => s.id === id);
  if (!snapshot) throw new Error("Snapshot not found.");
  // Restore into the current branch while keeping every snapshot and sibling branch.
  return captureBranch({ ...workspaceCore(snapshot.recipe), name: next.name, experiments: h });
}
export function fieldInheritance(recipe, id) {
  const h = historyOf(recipe); if (!h.activeVariantId || !h.base) return null;
  const base = h.base.fields.find(f => f.id === id), current = recipe.fields.find(f => f.id === id);
  return !base ? "added" : sameField(base, current) ? "inherited" : "overridden";
}
export function diffWorkspaces(before, after) {
  const left = workspaceCore(before), right = workspaceCore(after), old = new Map(left.fields.map(f => [f.id, f])), fresh = new Map(right.fields.map(f => [f.id, f]));
  const order = recipe => recipe.segments.filter(s => s.type === "field").map(s => s.id);
  const aOrder = order(left), bOrder = order(right), changes = [];
  for (const id of new Set([...bOrder, ...aOrder])) {
    const a = old.get(id), b = fresh.get(id);
    const attributes = ["label", "enabled", "channel", "separator", "experimentState", "dependsOn", "fieldType", "default", "variationTemplate"];
    const metadata = a && b ? attributes.filter(key => !same(a[key], b[key])).map(key => ({ key, before: a[key], after: b[key] })) : [];
    if (!a || !b || a.value !== b.value || metadata.length || aOrder.indexOf(id) !== bOrder.indexOf(id)) changes.push({ id, label: b?.label || a?.label, type: !a ? "added" : !b ? "removed" : "changed", before: a?.value ?? "", after: b?.value ?? "", metadata, moved: !!a && !!b && aOrder.indexOf(id) !== bOrder.indexOf(id) });
  }
  const compiledBefore = compileWorkspace(left), compiledAfter = compileWorkspace(right);
  const properties = ["negative", "separator", "segments", "overrideBoundaries"].filter(key => !same(left[key], right[key]));
  return { changes, properties, compiledBefore, compiledAfter };
}
export const BUILTIN_PRESETS = [
  ["character-sheet", "Character sheet", ["Character", "Outfit", "Pose", "Expression", "Background", "Style"]],
  ["portrait", "Portrait", ["Subject", "Expression", "Lighting", "Background", "Camera", "Style"]],
  ["scene", "Scene", ["Character", "Action", "Environment", "Lighting", "Composition", "Style"]],
  ["product", "Product render", ["Product", "Materials", "Surface", "Environment", "Lighting", "Camera"]],
  ["anime", "Anime image", ["Character", "Outfit", "Pose", "Environment", "Lighting", "Style"]],
  ["photo", "Realistic photo", ["Subject", "Action", "Environment", "Lighting", "Camera", "Style"]],
  ["negative", "Negative prompt set", ["Prompt", "Quality exclusions", "Anatomy exclusions", "Style exclusions"]],
].map(([id, name, labels]) => {
  const fields = labels.map((label, i) => ({ ...newField(label), id: `preset_${id}_${i}`, fieldType: label.toLowerCase(), channel: id === "negative" && i ? "negative" : "positive" }));
  return { id, name, recipe: { schema: "prompt-palette.adjustable-recipe.v2", name, separator: ", ", fields, segments: fields.map(f => ({ type: "field", id: f.id, join: true })), negative: "" } };
});
export function presetRecipe(recipe, { keepText = false } = {}) {
  const next = workspaceCore(recipe); delete next.presetId;
  if (!keepText) next.fields.forEach(f => { f.value = ""; f.default = ""; delete f.variationTemplate; });
  return validateWorkspaceRecipe(next);
}
export function instantiatePreset(recipe, presetId = null) {
  const next = workspaceCore(recipe), ids = new Map(next.fields.map(f => [f.id, fieldId()]));
  next.fields.forEach(f => { f.dependsOn = f.dependsOn.map(id => ids.get(id)); f.id = ids.get(f.id); });
  next.segments.forEach(s => { if (s.type === "field") s.id = ids.get(s.id); });
  next.presetId = presetId; return validateWorkspaceRecipe(next);
}
