import { workspaceGeneration, markedWorkspaceResult } from "./workspace_generation.js";
import { fieldVariationSource } from "./recipe_variation_source.js";
import { compileWorkspace, validateWorkspaceRecipe } from "./recipe_workspace_model.js";
import { createExperimentPlan, readResolved, projectExperiment, experimentTargets } from "./recipe_experiment.js";
import { analyzePromptSource } from "../prompt_palette_power_tools.js";
import { hasVariationSyntax as hasDynamicSyntax } from "./recipe_variation_source.js";
export { hasDynamicSyntax };
export async function resolveWorkspacePreview(recipe, seed, mode, resolveVariations, { signal, namespace = "" } = {}) {
  if (resolveVariations.workspace) {
    const [item] = await resolveVariations.workspace(workspaceGeneration(recipe, { namespace }), seed, mode, 1, { signal });
    const plan = createExperimentPlan(recipe, "workspace", null, { preview: true });
    return { plan, fields: item.fields, positive: item.positive, negative: item.negative, baseline: ["positive", "negative"].map(channel => ({ ...readResolved(plan, markedWorkspaceResult(plan, item, channel), channel) })) };
  }
  const plan = createExperimentPlan(recipe, "workspace", null, { preview: true });
  const responses = await Promise.all(["positive", "negative"].map(channel => plan.sources[channel] ? resolveVariations(plan.sources[channel], seed, mode, 1, { signal }) : [{ resolved: "" }]));
  if (signal?.aborted) throw new DOMException("Preview cancelled", "AbortError");
  const baseline = responses.map((items, i) => readResolved(plan, items[0]?.resolved, i ? "negative" : "positive"));
  return { plan, baseline, fields: { ...baseline[0].fields, ...baseline[1].fields }, ...projectExperiment(plan, baseline, {}) };
}
export async function estimateWorkspaceCombinations(recipe, scope, currentId, seed, mode, services, { signal, captured } = {}) {
  const valid = validateWorkspaceRecipe(recipe);
  let targets;
  try { targets = experimentTargets(valid, scope, currentId); }
  catch (error) { return { count: 1, lowerBound: false, fields: [], notice: error.message, targets: [] }; }
  const preview = captured || await resolveWorkspacePreview(valid, seed, mode, services.resolveVariations, { signal });
  const values = Object.fromEntries(targets.map(id => [id, fieldVariationSource(valid.fields.find(f => f.id === id))]));
  const projection = scope === "workspace" ? ["positive", "negative"].map(channel => readResolved(preview.plan, preview.plan.sources[channel], channel, { allowUnresolved: true })) : preview.baseline;
  const context = projectExperiment(preview.plan, projection, { ...preview.fields, ...values });
  // Reuse the canonical count route, never enumerate candidates in the UI.
  // Fields are reported as independent estimates; totals use channel context.
  const count = text => text.trim() ? services.countCombinatorial(text, seed, 5000, { signal }) : Promise.resolve({ count: 1, truncated: false });
  const results = await Promise.all([count(context.positive), count(context.negative)]);
  const fields = [];
  for (const id of targets) {
    if (signal?.aborted) throw new DOMException("Preview cancelled", "AbortError");
    const f = valid.fields.find(f => f.id === id);
    const result = hasDynamicSyntax(fieldVariationSource(f)) ? await count(fieldVariationSource(f)) : { count: 1, truncated: false };
    fields.push({ id, label: f.label, count: result.count, lowerBound: result.truncated });
  }
  const total = results.reduce((n, r) => n * Math.max(1, r.count), 1);
  const coupled = targets.some(id => /\$\{|\[(?:if|elif|switch)\b|__[A-Za-z0-9_\-/]+\(/i.test(values[id]));
  return { count: total, lowerBound: results.some(r => r.truncated), fields, targets,
    warning: total >= 1000 || results.some(r => r.truncated),
    notice: coupled ? "Estimate: variables, parameters and conditionals can couple fields. Verify the intended batch in Combinatorial." : "Estimate for this scope. Held fields use captured results; Follow fields count as possible targets. Fixed-pick modifiers contribute one choice." };
}
function summarize(issues) {
  const counts = { error: 0, warning: 0, info: 0 }; issues.forEach(i => counts[i.severity]++);
  issues.sort((a, b) => ["error", "warning", "info"].indexOf(a.severity) - ["error", "warning", "info"].indexOf(b.severity));
  return { issues, counts, status: counts.error ? "error" : counts.warning ? "warning" : counts.info ? "info" : "clean" };
}
export function analyzeWorkspace(recipe, { libraryEntries = [], compiledPreview = null } = {}) {
  const valid = validateWorkspaceRecipe(recipe), compiled = compileWorkspace(valid), issues = [], seen = new Map();
  const active = valid.fields.filter(f => compiled.spans[f.id]);
  const totalLength = active.reduce((n, f) => n + f.value.length, 0);
  const add = (severity, code, title, detail, fieldIds) => issues.push({ severity, code, title, detail, fieldIds });
  for (const f of active) {
    const analysis = analyzePromptSource({ text: f.value, libraryEntries });
    analysis.issues.filter(issue => !["unreachable-variable", "unclosed-conditional", "orphan-conditional", "unclosed-brace", "extra-brace"].includes(issue.code)).forEach(issue => issues.push({ ...issue, title: `${f.label}: ${issue.title}`, fieldIds: [f.id], fieldToken: issue.token, token: undefined }));
    if (f.experimentState === "lock" && hasDynamicSyntax(f.value)) add("info", "locked-dynamic", `${f.label}: locked syntax still resolves`, "This older workspace stores dynamic text under Lock. Generation holds its first resolved value for this session; choose Freeze current value to save the literal choice across restarts.", [f.id]);
    if (f.value.length > 2000 || f.value.length > 400 && f.value.length > totalLength * .55) add("warning", "dominant-field", `${f.label}: long field`, `${f.value.length.toLocaleString()} characters may dominate this workspace. Review repetition and priority.`, [f.id]);
    if (f.experimentState === "follow" && !f.dependsOn.length) add("info", "follow-without-source", `${f.label}: choose Follow sources`, "This field joins broad scopes. Set its dependencies to follow a specific source in Current Field or Vary Fields.", [f.id]);
    for (const term of f.value.split(/[,\n]/).map(t => t.trim().toLowerCase().replace(/_/g, " ")).filter(t => t && !hasDynamicSyntax(t) && t.length < 160)) {
      const key = `${f.channel}:${term}`, previous = seen.get(key);
      if (previous && previous.id !== f.id) add("info", "cross-field-repeat", `Repeated term: ${term}`, `Appears in ${previous.label} and ${f.label} (${f.channel}). Repetition may be deliberate.`, [previous.id, f.id]);
      else seen.set(key, f);
    }
    const type = (f.fieldType && f.fieldType !== "text" ? f.fieldType : f.label).toLowerCase();
    if (/^lighting$/.test(type) && /\b(?:dress|shirt|pants|skirt)\b/i.test(f.value)) add("info", "field-placement", `${f.label}: check field placement`, "Clothing terms may be easier to vary in an Outfit field. This is a suggestion; your prompt is unchanged.", [f.id]);
  }
  for (const channel of ["positive", "negative"]) for (const [a, b] of [["daytime", "nighttime"], ["indoors", "outdoors"], ["standing", "sitting"], ["close up", "wide shot"], ["monochrome", "full color"]]) {
    const left = seen.get(`${channel}:${a}`), right = seen.get(`${channel}:${b}`);
    if (left && right && left.id !== right.id) add("info", "cross-field-conflict", `Check ${a} / ${b}`, `${left.label} and ${right.label} may give conflicting instructions in the ${channel} prompt. Multiple subjects or exclusions can make this intentional.`, [left.id, right.id]);
  }
  if (compiledPreview) for (const channel of ["positive", "negative"]) if (compiledPreview[channel] !== compiled[channel]) add("error", "workspace-projection", `${channel}: preview differs from workspace`, "Refresh the preview; it does not match the canonical enabled-field compilation.", []);
  for (const f of valid.fields.filter(f => !f.enabled)) if (compiled.spans[f.id]) add("error", "disabled-field-leak", `${f.label}: disabled field included`, "A disabled field has an active span. Refresh the workspace before generating.", [f.id]);
  // Validate static text and negative preamble with their full variable context.
  const full = analyzePromptSource({ text: compiled.positive + (compiled.negative ? `\n${compiled.negative}` : ""), libraryEntries });
  for (const issue of full.issues) if (!issues.some(i => i.code === issue.code && i.detail === issue.detail)) issues.push({ ...issue, token: undefined, fieldIds: [] });
  return summarize(issues);
}
