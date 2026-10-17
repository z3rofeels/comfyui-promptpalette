import { compileWorkspace, validateWorkspaceRecipe } from './recipe_workspace_model.js';
import { fieldVariationSource } from './recipe_variation_source.js';
import { hideNativeWidget } from '../prompt_palette_compat.js';

export function workspaceGeneration(recipe, { namespace = "" } = {}) {
  const valid = validateWorkspaceRecipe(recipe), compiled = compileWorkspace(valid);
  const fields = Object.entries(compiled.spans).map(([id, span]) => {
    const field = valid.fields.find(f => f.id === id);
    // Backend spans use Unicode code points, rather than JavaScript UTF-16 units.
    return { id, channel: span.channel, start: Array.from(compiled[span.channel].slice(0, span.start)).length,
      end: Array.from(compiled[span.channel].slice(0, span.end)).length,
      source: field.experimentState === 'lock' ? field.value : fieldVariationSource(field),
      state: field.experimentState, variation: field.variationMode || 'cycle', dependsOn: field.experimentState === "follow" ? field.dependsOn || [] : [] };
  });
  return { schema: 'prompt-palette.workspace-generation.v1', namespace: String(namespace), positive: compiled.positive, negative: compiled.negative, fields };
}
export function syncWorkspaceGeneration(node, recipe) {
  const widget = node.widgets?.find(w => w.name === 'workspace_runtime');
  if (!widget) return;
  widget.__ppOwnerNode = node; hideNativeWidget(widget);
  const value = recipe ? JSON.stringify(workspaceGeneration(recipe, { namespace: node.id })) : '';
  // Native renderer defaults cannot erase this derived execution projection.
  const projection = widget.__ppWorkspaceRuntimeProjection ||= { value: '' };
  projection.value = value;
  const descriptor = Object.getOwnPropertyDescriptor(widget, 'value');
  if (descriptor?.configurable !== false) Object.defineProperty(widget, 'value', {
    configurable: true, enumerable: true, get: () => projection.value, set: () => {},
  });
  else widget.value = value;
  widget.serializeValue = () => projection.value;
}

// Reuse Variation Lab's existing marker/projection contract with resolved runtime spans.
export function markedWorkspaceResult(plan, item, channel) {
  const points = Array.from(item[channel]);
  for (const marker of plan.markers.filter(m => m.channel === channel).sort((a, b) => item.spans[b.id].start - item.spans[a.id].start)) {
    const span = item.spans[marker.id];
    points.splice(span.end, 0, marker.right); points.splice(span.start, 0, marker.left);
  }
  return points.join('');
}
