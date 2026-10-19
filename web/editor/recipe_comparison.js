// Controlled trials reuse the workspace resolver and exact-batch handoff.
// Only one captured field value changes; Follow and static context stay held.
import { createExperimentPlan, resolveExperiment, projectExperiment } from './recipe_experiment.js';
import { resolveWorkspacePreview } from './recipe_insights.js';
import { fieldVariationSource, hasVariationSyntax } from './recipe_variation_source.js';
import { cloneWorkspaceData } from './recipe_workspace_model.js';

export async function resolveFieldComparisons(plan, seed, mode, count, resolveVariations, { signal } = {}) {
  const lookup = new Map(plan.recipe.fields.map(f => [f.id, f]));
  const fields = plan.recipe.segments.filter(s => s.type === 'field').map(s => lookup.get(s.id))
    .filter(f => plan.primaryTargets.includes(f.id) && hasVariationSyntax(fieldVariationSource(f)));
  if (!fields.length) throw new Error('Set choices or insert a wildcard in a selected field before comparing. Plain text has no alternatives.');
  const samples = Math.min(Math.max(1, Math.min(16, Math.floor(count) || 4)), Math.floor(255 / fields.length));
  const captured = await resolveWorkspacePreview(plan.recipe, seed, mode, resolveVariations, { signal, namespace: plan.runtimeNamespace });
  const check = () => { if (signal?.aborted) throw new DOMException('Comparison cancelled', 'AbortError'); };
  check();
  const held = captured.fields;
  const base = { seed, resolved: captured.positive, negative: captured.negative, baseline: captured.baseline,
    values: {}, changes: [], wildcards: captured.wildcards || [], trial: { kind: 'baseline', label: 'Baseline' } };
  const groups = new Array(fields.length);
  let next = 0, failed = false;
  // Bound requests and output size even for a 32-field workspace. Each resolver
  // request owns a preview index, so this cannot advance generation counters.
  async function worker() {
    while (!failed && next < fields.length) {
      check();
      const at = next++, field = fields[at];
      const recipe = cloneWorkspaceData(plan.recipe);
      for (const f of recipe.fields) {
        if (f.id === field.id) f.experimentState = 'vary';
        else if (Object.hasOwn(held, f.id)) { f.value = held[f.id]; delete f.variationTemplate; f.experimentState = 'lock'; }
      }
      const isolated = createExperimentPlan(recipe, 'current', field.id);
      isolated.runtimeNamespace = plan.runtimeNamespace;
      const candidates = await resolveExperiment(isolated, seed, mode, samples, resolveVariations, { signal });
      check();
      const seen = new Set([held[field.id]]);
      groups[at] = candidates.flatMap(candidate => {
        const after = candidate.values[field.id];
        if (typeof after !== 'string' || seen.has(after)) return [];
        seen.add(after);
        const projected = projectExperiment(captured.plan, captured.baseline, { ...held, [field.id]: after });
        if (projected.positive === base.resolved && projected.negative === base.negative) return [];
        return [{ ...base, resolved: projected.positive, negative: projected.negative, values: { [field.id]: after },
          changes: [{ id: field.id, label: field.label, before: field.value, after, resolvedBefore: held[field.id], changed: true, channel: field.channel }],
          wildcards: [...new Set([...base.wildcards, ...(candidate.wildcards || [])])],
          trial: { kind: 'field', fieldId: field.id, label: field.label } }];
      });
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, fields.length) }, () => worker().catch(error => { failed = true; throw error; })));
  check();
  return { items: [base, ...groups.flat()], samples, testedFields: fields.length,
    unchanged: fields.filter((_, at) => !groups[at].length).map(f => f.label) };
}
