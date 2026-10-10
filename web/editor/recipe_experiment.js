import { fieldVariationSource, hasVariationSyntax } from "./recipe_variation_source.js";
// Scope planning and mapping only. All prompt resolution uses the existing API.
import { cloneWorkspaceData, compileWorkspace, validateWorkspaceRecipe, fieldId } from "./recipe_workspace_model.js";

export const WORKSPACE_SCOPES = [
  ["selection", "Selection"], ["current", "Current Field"], ["vary", "Vary Fields"],
  ["unlocked", "All Unlocked Fields"], ["workspace", "Entire Workspace"],
];
export function primaryExperimentTargets(recipe, scope, currentId) {
  const valid = validateWorkspaceRecipe(recipe);
  if (!["current", "vary", "unlocked", "workspace"].includes(scope)) throw new Error("Choose a workspace variation scope.");
  if (scope === "current" && !valid.fields.some(f => f.id === currentId)) throw new Error("Focus a field or use its Vary field action first.");
  if (scope === "current" && valid.fields.find(f => f.id === currentId).experimentState === "lock") throw new Error("This field is locked. Change its experiment state before varying it.");
  const spans = compileWorkspace(valid).spans;
  const targets = valid.fields.filter(f => spans[f.id] && f.experimentState !== "lock" &&
    (scope === "current" ? f.id === currentId : scope === "vary" ? f.experimentState === "vary" : true));
  if (!targets.length) throw new Error(scope === "vary" ? "Mark at least one enabled, nonempty field Vary." : "This scope has no enabled, nonempty unlocked fields.");
  return targets.map(f => f.id);
}
export function dependentTargets(recipe, initial, changedIds = null) {
  const active = compileWorkspace(recipe).spans, selected = new Set(initial), changed = new Set(changedIds || initial);
  let progress = true;
  while (progress) {
    progress = false;
    for (const f of recipe.fields) if (active[f.id] && f.experimentState === "follow" && !selected.has(f.id) && f.dependsOn.some(id => changed.has(id))) {
      selected.add(f.id); changed.add(f.id); progress = true;
    }
  }
  return recipe.fields.filter(f => selected.has(f.id)).map(f => f.id);
}
export function experimentTargets(recipe, scope, currentId) {
  const valid = validateWorkspaceRecipe(recipe);
  return dependentTargets(valid, primaryExperimentTargets(valid, scope, currentId));
}
export function createExperimentPlan(recipe, scope, currentId, { preview = false } = {}) {
  const valid = validateWorkspaceRecipe(cloneWorkspaceData(recipe));
  const primaryTargets = preview ? [] : primaryExperimentTargets(valid, scope, currentId);
  const targets = preview ? [] : dependentTargets(valid, primaryTargets), compiled = compileWorkspace(valid);
  if (valid.fields.some(f => compiled.spans[f.id] && /^\s*#/m.test(f.value))) throw new Error("Comment lines cannot be safely mapped to workspace fields. Use Selection on an active phrase instead.");
  if (valid.fields.some(f => targets.includes(f.id) && /\$\{[A-Za-z_][A-Za-z0-9_]*\s*=/.test(fieldVariationSource(f)))) throw new Error("Variable assignments do not produce a field result. Use Selection on a variable reference or active phrase instead.");
  const exploring = cloneWorkspaceData(valid);
  for (const f of exploring.fields) if (targets.includes(f.id)) f.value = fieldVariationSource(f);
  const exploration = compileWorkspace(exploring);
  if (exploring.fields.some(f => exploration.spans[f.id] && /^\s*#/m.test(f.value))) throw new Error("Comment lines cannot be safely mapped to workspace fields. Use Selection on an active phrase instead.");
  const nonce = `PPFIELD${fieldId().replace(/[^a-z0-9]/gi, "")}X`;
  const markers = Object.entries(exploration.spans).map(([id, span], index) => ({ id, ...span, left: `${nonce}${index}BEGIN`, right: `${nonce}${index}END` }));
  const sources = {};
  for (const channel of ["positive", "negative"]) {
    let text = exploration[channel];
    for (const m of markers.filter(m => m.channel === channel).sort((a, b) => b.start - a.start))
      text = text.slice(0, m.start) + m.left + text.slice(m.start, m.end) + m.right + text.slice(m.end);
    sources[channel] = text;
  }
  return { recipe: valid, fingerprint: JSON.stringify(valid), scope, primaryTargets, targets, markers, nonce, sources, compiled };
}
const unresolved = /__[+\-*%~@]?[A-Za-z0-9_\-/*]+(?:\([^\n]*?\))?__/;
export function readResolved(plan, text, channel, { allowUnresolved = false } = {}) {
  if (typeof text !== "string" || !allowUnresolved && unresolved.test(text)) throw new Error("Resolve missing wildcard lists before previewing workspace variations.");
  const fields = {}, spans = [];
  for (const m of plan.markers.filter(m => m.channel === channel)) {
    const start = text.indexOf(m.left), end = text.indexOf(m.right);
    if (start < 0 || end < start + m.left.length || text.indexOf(m.left, start + 1) >= 0 || text.indexOf(m.right, end + 1) >= 0)
      throw new Error("A field crosses a comment, assignment or inactive conditional boundary. Use Selection on an active phrase instead.");
    fields[m.id] = text.slice(start + m.left.length, end);
    spans.push({ ...m, start, end: end + m.right.length });
  }
  spans.sort((a, b) => a.start - b.start);
  if (spans.some((m, i) => i && m.start < spans[i - 1].end)) throw new Error("Resolved field boundaries overlap. Use Selection instead.");
  return { text, fields, spans };
}
function project(plan, baseline, values) {
  let text = baseline.text;
  for (const span of [...baseline.spans].reverse()) text = text.slice(0, span.start) + (values[span.id] ?? baseline.fields[span.id]) + text.slice(span.end);
  if (text.includes(plan.nonce)) throw new Error("Could not safely map this prompt back to its fields.");
  return text.trim();
}
export function projectExperiment(plan, baseline, values) {
  return { positive: project(plan, baseline[0], values), negative: project(plan, baseline[1], values) };
}
export async function resolveExperiment(plan, seed, mode, count, resolveVariations, { signal } = {}) {
  // Resolve complete channel context, so variables and conditional syntax keep
  // using the existing resolver. Markers never enter saved data or generation.
  const responses = await Promise.all(["positive", "negative"].map(channel =>
    plan.sources[channel] ? resolveVariations(plan.sources[channel], seed, mode, count, { signal }) :
      Array.from({ length: count }, () => ({ resolved: "", seed, wildcards: [] }))));
  if (signal?.aborted) throw new DOMException("Preview cancelled", "AbortError");
  if (responses.some(items => items.length !== count)) throw new Error("The resolver returned an incomplete workspace preview.");
  const baseline = responses.map((items, i) => readResolved(plan, items[0].resolved, i ? "negative" : "positive"));
  // Previously applied literals are the current comparison/held values. Their
  // saved alternatives are explored only for this plan's target fields.
  for (const f of plan.recipe.fields) if (f.variationTemplate && !hasVariationSyntax(f.value)) {
    const channel = f.channel === "negative" ? 1 : 0;
    if (Object.hasOwn(baseline[channel].fields, f.id)) baseline[channel].fields[f.id] = f.value;
  }
  return Array.from({ length: count }, (_, index) => {
    const values = {}, changes = [];
    const resolvedChannels = responses.map((items, i) => readResolved(plan, items[index].resolved, i ? "negative" : "positive"));
    resolvedChannels.forEach(resolved => {
      for (const id of plan.targets) if (Object.hasOwn(resolved.fields, id)) values[id] = resolved.fields[id];
    });
    // A Follow field activates only when one of its sources actually changed
    // from the captured resolved baseline, including transitive dependencies.
    const allBaseline = { ...baseline[0].fields, ...baseline[1].fields };
    const selected = new Set(plan.primaryTargets), changed = new Set(plan.primaryTargets.filter(id => values[id] !== allBaseline[id]));
    let progress = true;
    while (progress) {
      progress = false;
      for (const f of plan.recipe.fields) if (plan.targets.includes(f.id) && !selected.has(f.id) && f.experimentState === "follow" && f.dependsOn.some(id => changed.has(id))) {
        selected.add(f.id); if (values[f.id] !== allBaseline[f.id]) changed.add(f.id); progress = true;
      }
    }
    for (const id of Object.keys(values)) if (!selected.has(id)) delete values[id];
    for (const f of plan.recipe.fields) if (Object.hasOwn(values, f.id)) changes.push({ id: f.id, label: f.label, before: f.value, after: values[f.id], resolvedBefore: allBaseline[f.id], changed: values[f.id] !== allBaseline[f.id], channel: f.channel });
    // Entire Workspace also explores static compiled context, as the original
    // full-prompt lab does. Locked field results still come from the baseline.
    const projection = plan.scope === "workspace" ? resolvedChannels : baseline;
    const previewValues = { ...baseline[0].fields, ...baseline[1].fields, ...values };
    return { seed: responses[0][index].seed ?? responses[1][index].seed, values, changes, baseline,
      resolved: project(plan, projection[0], previewValues), negative: project(plan, projection[1], previewValues),
      wildcards: [...new Set(responses.flatMap(items => items[index].wildcards || []))] };
  });
}
export function applyExperiment(recipe, plan, values) {
  const valid = validateWorkspaceRecipe(recipe);
  if (JSON.stringify(valid) !== plan.fingerprint) throw new Error("The workspace changed. Refresh variations before applying or sending a batch.");
  for (const [id, value] of Object.entries(values)) {
    const f = valid.fields.find(f => f.id === id);
    if (!f || !plan.targets.includes(id) || !f.enabled || f.experimentState === "lock" || typeof value !== "string") throw new Error("This variation cannot change a locked or out-of-scope field.");
    if (!f.variationTemplate && hasVariationSyntax(f.value)) f.variationTemplate = f.value;
    f.value = value;
  }
  return validateWorkspaceRecipe(valid);
}
