import { cloneWorkspaceData, compileWorkspace, validateWorkspaceRecipe } from "./recipe_workspace_model.js";

// Apply text edits to one compiled channel without losing field identities,
// the other channel, disabled fields, defaults or iteration history.
export function editCompiledPrompt(recipe, after, { channel = "positive" } = {}) {
  if (!["positive", "negative"].includes(channel)) throw new Error("Invalid prompt channel.");
  const next = cloneWorkspaceData(recipe), compiled = compileWorkspace(next), before = compiled[channel];
  if (before === after) return next;
  if (channel === "negative") next.negative = "";
  let start = 0, end = before.length, tail = after.length;
  while (start < end && start < tail && before[start] === after[start]) start++;
  while (end > start && tail > start && before[end - 1] === after[tail - 1]) { end--; tail--; }
  const insert = after.slice(start, tail);
  const visible = Object.entries(compiled.spans).filter(([, s]) => s.channel === channel).sort((a, b) => a[1].start - b[1].start);
  const target = visible.find(([, s]) => start >= s.start && end <= s.end);
  if (target) {
    const [id, span] = target, field = next.fields.find(f => f.id === id);
    field.value = field.value.slice(0, start - span.start) + insert + field.value.slice(end - span.start);
    delete field.variationTemplate;
    // Most edits keep the automatic separators exactly as they were.
    if (compileWorkspace(next)[channel] === after) return validateWorkspaceRecipe(next);
  }
  // Separator edits and selections across fields need literal boundaries. Use
  // the original spans so the remaining text stays in its original fields.
  const original = new Map(recipe.fields.map(f => [f.id, f]));
  const runs = []; let cursor = 0;
  for (const [id, span] of visible) {
    runs.push({ start: cursor, end: span.start, text: before.slice(cursor, span.start) });
    runs.push({ id, start: span.start, end: span.end, text: original.get(id).value });
    cursor = span.end;
  }
  runs.push({ start: cursor, end: before.length, text: before.slice(cursor) });
  const owner = runs.find(r => r.id && start >= r.start && start <= r.end) || runs.find(r => start >= r.start && start <= r.end);
  for (const run of runs) {
    const left = Math.max(0, Math.min(run.text.length, start - run.start));
    const right = Math.max(left, Math.min(run.text.length, end - run.start));
    run.text = run.text.slice(0, left) + (run === owner ? insert : "") + run.text.slice(right);
    if (run.id) {
      const f = next.fields.find(f => f.id === run.id);
      if (f.value !== run.text) delete f.variationTemplate;
      f.value = run.text;
    }
  }
  // Once all visible text is deleted, the next keystroke fills the first enabled
  // field in this channel rather than creating an uneditable static-only prompt.
  if (!visible.length) {
    const first = next.segments.find(s => s.type === "field" && next.fields.some(f => f.id === s.id && f.enabled && f.channel === channel));
    if (first) { const f = next.fields.find(f => f.id === first.id); f.value = after; delete f.variationTemplate; runs[0].text = ""; }
  }
  const runByField = new Map(runs.filter(r => r.id).map(r => [r.id, r]));
  const gaps = new Map();
  for (let i = 0; i < runs.length; i++) if (runs[i].id) gaps.set(runs[i].id, runs[i - 1].text);
  const segments = [];
  for (const segment of next.segments) {
    if (segment.type === "static") { if ((segment.channel || "positive") !== channel) segments.push(segment); continue; }
    const f = next.fields.find(f => f.id === segment.id);
    if (f.channel !== channel) { segments.push(segment); continue; }
    if (runByField.has(f.id) && gaps.get(f.id)) segments.push({ type: "static", text: gaps.get(f.id), channel });
    // The compiler omits whitespace-only fields. Keep explicitly typed spaces
    // as literal layout text so deleting the last word cannot eat surrounding
    // spaces, tabs or line breaks.
    if (f.enabled && f.value && !f.value.trim()) { segments.push({ type: "static", text: f.value, channel }); f.value = ""; }
    if (f.enabled) f.separator = "";
    segments.push({ ...segment, join: false });
  }
  if (runs.at(-1).text) segments.push({ type: "static", text: runs.at(-1).text, channel });
  next.segments = segments;
  const valid = validateWorkspaceRecipe(next);
  if (compileWorkspace(valid)[channel] !== after) throw new Error("The text edit could not be mapped to workspace fields.");
  return valid;
}
