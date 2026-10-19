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
    const attributes = ["label", "titleHidden", "accent", "enabled", "channel", "separator", "experimentState", "variationMode", "dependsOn", "fieldType", "default", "variationTemplate"];
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
  ["anima", "Anima Structure", ["Environment / Scene Prose", "Character 1 Tags", "Character 2 Tags"]],
  ["photo", "Realistic photo", ["Subject", "Action", "Environment", "Lighting", "Camera", "Style"]],
  ["negative", "Negative prompt set", ["Prompt", "Quality exclusions", "Anatomy exclusions", "Style exclusions"]],
].map(([id, name, labels]) => {
  const fields = labels.map((label, i) => ({ ...newField(label), id: `preset_${id}_${i}`, fieldType: label.toLowerCase(), channel: id === "negative" && i ? "negative" : "positive" }));
  // Field separators precede the field in the existing compiler. Nothing is
  // appended after the final field, including when a field is empty or disabled.
  if (id === "anima") fields.forEach((field, i) => {
    field.separator = ["", "\n\n", "\n"][i];
    field.fieldType = i ? "character" : "environment";
  });
  return { id, name, recipe: { schema: "prompt-palette.adjustable-recipe.v2", name, separator: ", ", fields, segments: fields.map(f => ({ type: "field", id: f.id, join: true })), negative: "" } };
});
// Concise starter choices use ordinary prompt vocabulary. No model-specific quality prefixes.
const STYLE_STARTERS = {
  'Realistic photo': ['editorial photography with natural detail', 'photography'],
  'Anime image': ['clean linework and a restrained color palette', 'lineart, limited_palette'],
  'Character sheet': ['consistent character proportions and clear design details', 'character_design'],
  Scene: ['a cohesive scene with detailed surroundings', 'detailed_background'],
};
const STARTERS = {
  character: ['an original adult character', 'original_adult_character'], subject: ['an original adult subject', 'original_adult_subject'],
  outfit: ['{tailored jacket|casual sweater|linen shirt}', '{jacket|sweater|shirt}'],
  pose: ['{standing with relaxed posture|sitting upright|walking naturally}', '{standing|sitting|walking}'],
  expression: ['{gentle smile|thoughtful expression|calm expression}', '{smile|thoughtful|calm_expression}'],
  action: ['{walking along a path|reading a book|looking toward the horizon}', '{walking|reading|looking_away}'],
  environment: ['{a quiet garden|a modern studio|a sunlit courtyard}', '{garden|studio|courtyard}'],
  background: ['{a quiet garden|a clean studio backdrop|a sunlit courtyard}', '{garden|simple_background|courtyard}'],
  lighting: ['{soft daylight|warm side lighting|diffused studio lighting}', '{daylight|warm_lighting|soft_lighting}'],
  camera: ['{a wide shot|a medium shot|a close-up}', '{wide_shot|medium_shot|close-up}'],
  composition: ['{a balanced centered composition|an off-center composition|a symmetrical composition}', '{centered_composition|off-center|symmetry}'],
  style: ['clean, detailed visual presentation', 'detailed'],
  product: ['a ceramic tea set', 'ceramic_tea_set'], materials: ['{glazed ceramic|matte ceramic|polished porcelain}', '{glazed_ceramic|matte_ceramic|porcelain}'],
  surface: ['{a wooden tabletop|a stone countertop|a neutral display plinth}', '{wooden_table|stone_surface|display_plinth}'],
};
export function starterPreset(recipe, language = 'natural', { includeValues = true } = {}) {
  const next = presetRecipe(recipe);
  if (!includeValues) return next;
  if (next.mossFormat) {
    for (const f of next.fields) {
      f.value = f.default = MOSS_STARTERS[next.mossFormat]?.[f.fieldType] || '';
      f.experimentState = next.mossFormat === 'layout' ? null : f.value.includes('|') ? 'vary' : f.value ? 'lock' : null;
      f.variationMode = 'cycle';
    }
    return validateWorkspaceRecipe(next);
  }
  const tagged = language === 'tags' || language === 'anima';
  for (const f of next.fields) {
    const type = f.fieldType;
    if (next.fields.some(x => /Environment \/ Scene Prose/.test(x.label))) {
      f.value = type === 'environment' ? 'A quiet sunlit courtyard with soft natural light.' : 'original_adult_character, standing, jacket, calm_expression';
      if (/Character 2/.test(f.label)) { f.value = 'another_original_adult_character, sitting, sweater'; f.enabled = false; }
    } else if (f.channel === 'negative') { f.value = ''; }
    else f.value = (STARTERS[type] || STARTERS[f.label.toLowerCase()] || ['', ''])[tagged ? 1 : 0];
    if (f.fieldType === 'style' && STYLE_STARTERS[recipe.name]) f.value = STYLE_STARTERS[recipe.name][tagged ? 1 : 0];
    f.default = f.value;
    f.experimentState = f.value.includes('|') ? 'vary' : f.value ? 'lock' : null;
    f.variationMode = 'cycle';
  }
  const trigger = next.fields.find(f => ['pose', 'action', 'camera'].includes(f.fieldType) && f.experimentState === 'vary');
  const lighting = next.fields.find(f => f.fieldType === 'lighting' && f.experimentState === 'vary');
  if (lighting && trigger) { lighting.experimentState = 'follow'; lighting.dependsOn = [trigger.id]; }
  return validateWorkspaceRecipe(next);
}

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

// MOSS formats are explicit starter choices, never an automatic model switch.
// Captions/tags resolve as usual. Valid JSON objects travel as literal prompts.
const MOSS_LAYOUT = JSON.stringify({
  summary: { meta: ['poster'], canvas: 'single', caption: 'A restrained charcoal and sage poster featuring an adult grey Russian Blue cat, a large title above the cat, and a small footer below.' },
  items: [
    { label: 'text', caption: 'Large pale-sage uppercase sans-serif title, centered, on two lines.', text: 'PROMPT\nPALETTE', bbox: [-448, -448, -256, 448] },
    { label: 'object', caption: 'An adult grey Russian Blue cat with green eyes, sitting upright, softly lit from the left.', bbox: [-200, -320, 350, 320] },
    { label: 'text', caption: 'Small pale-sage uppercase sans-serif footer, centered.', text: 'CREATE LOCALLY', bbox: [380, -400, 460, 400] },
  ], bbox_coord_space: 'abs_centralized', bbox_format: 'yxyx',
}, null, 2);
const MOSS_STARTERS = {
  caption: {
    subject: 'An adult grey Russian Blue cat with green eyes sits on a wooden desk.',
    environment: 'The desk is in a quiet design studio with shelves in the background.',
    composition: '{The cat is centered in a medium shot.|A close-up frames the cat’s head and shoulders.}',
    lighting: '{Soft daylight enters from the left.|Warm studio light falls across the grey fur.}',
    style: 'Editorial photography with realistic fur, natural textures, and a muted charcoal and sage palette.',
    lettering: 'A small card at the bottom right reads "PROMPT PALETTE" on the first line and "CREATE LOCALLY" on the second line, in clean uppercase sans-serif letters.',
    negative: 'worst quality, bad anatomy, watermark, jpeg artifact',
  },
  tags: { general: 'cat, animal_focus, grey_fur, green_eyes, sitting, indoors, window, soft_lighting', negative: 'worst quality, bad anatomy, watermark, jpeg artifact' },
  layout: { json: MOSS_LAYOUT },
};
for (const [format, name, definitions, note] of [
  ['caption', 'MOSS · caption', [['Subject', 'subject'], ['Scene', 'environment'], ['Composition', 'composition'], ['Lighting', 'lighting'], ['Medium / Style', 'style'], ['Exact visible text', 'lettering'], ['Negative · SFT / CFG', 'negative']],
    'Describe the finished image in English. Quote printed words exactly and describe their placement and line breaks. Negatives depend on the sampler’s guidance; CFG 1 Turbo workflows may ignore them.'],
  ['tags', 'MOSS · ordered tags', [['Quality · optional', 'quality'], ['Score · optional', 'score'], ['Meta · optional', 'meta'], ['Year · optional', 'year'], ['Character · optional', 'character'], ['Series · optional', 'series'], ['Artist · optional', 'artist'], ['General tags', 'general'], ['Negative · SFT / CFG', 'negative']],
    'Order: quality → score → meta → year → character → series → artist → general. Optional fields start empty: no Pony score prefixes or artist names are invented. Existing Anima artist catalogs do not prove MOSS coverage.'],
  ['layout', 'MOSS · layout JSON (1024²)', [['Layout JSON · literal', 'json']],
    'Experimental layout starter for a 1024×1024 canvas. Boxes are [top, left, bottom, right] in pixels from the canvas center (−512…512). Match generation dimensions. Valid JSON is literal: edit captions/text directly; choices and wildcards inside it are not expanded.'],
]) {
  const id = `moss-${format}`;
  const fields = definitions.map(([label, fieldType], at) => ({ ...newField(label), id: `preset_${id}_${at}`, fieldType, channel: fieldType === 'negative' ? 'negative' : 'positive' }));
  BUILTIN_PRESETS.push({ id, name, note, recipe: { schema: 'prompt-palette.adjustable-recipe.v2', name, mossFormat: format,
    separator: format === 'tags' ? ', ' : '\n', negative: '', fields, segments: fields.map(f => ({ type: 'field', id: f.id, join: true })) } });
}
