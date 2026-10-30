// The existing hidden runtime projection remains the only execution transport.
export function relationshipConfig(node) {
  if (!node) return null;
  const widget = node.widgets?.find(item => item.name === 'workspace_runtime');
  try { const value = widget?.serializeValue?.() ?? widget?.value; return (value ? JSON.parse(value).relationships : null) || node.properties?.promptPaletteRelationships || null; }
  catch { return node.properties?.promptPaletteRelationships || null; }
}
export function applyRelationshipConfig(node, config) {
  const widget = node.widgets?.find(item => item.name === 'workspace_runtime');
  if (!widget) throw new Error('Reload this workflow with the current Prompt Palette node to use relationships.');
  let current = {};
  const value = widget.serializeValue?.() ?? widget.value;
  if (value) current = JSON.parse(value);
  const positive = node.widgets?.find(item => item.name === 'text')?.value || '';
  const negative = node.widgets?.find(item => item.name === 'negative_text')?.value || '';
  const payload = { schema:'prompt-palette.workspace-generation.v1', positive, negative, fields:[], ...current, relationships:config };
  node.properties ||= {}; node.properties.promptPaletteRelationships = config;
  const encoded = JSON.stringify(payload);
  if (widget.__ppWorkspaceRuntimeProjection) widget.__ppWorkspaceRuntimeProjection.value = encoded;
  else { widget.value = encoded; widget.serializeValue = () => widget.value; }
  node.setDirtyCanvas?.(true,true);
}
