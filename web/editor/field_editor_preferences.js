// Shared by Settings, theme import/export and the existing Fields controller.
// These options change presentation only; recipes retain their authored state.
export const FIELD_EDITOR_TOGGLES = [
  ['showFieldLabels', 'Field titles', 'Keep the collapse arrow available when titles are hidden.', 'Field headers', true],
  ['showFieldCounts', 'Per-field character counts', 'The main status bar still shows the selected field and total count.', 'Field headers', false],
  ['showFieldStates', 'Vary / Lock / Follow badges', 'Variation modes remain editable in Field settings.', 'Field headers', true],
  ['showFieldInheritance', 'Inheritance badges', 'Show whether a field is inherited or overridden in a variant.', 'Field headers', false],
  ['showFieldChannels', 'Positive / negative indicators', 'Show the prompt channel beside each field.', 'Field headers', true],
  ['showFieldSwitches', 'Include-field switches', 'Include or exclude fields here; also available in Field settings.', 'Field headers', true],
  ['showFieldHeight', 'Quick Auto height button', 'Height controls remain available in Field settings.', 'Field headers', false],
  ['showFieldReview', 'Quick Review button', 'Review stays in Field settings when Prompt Doctor is enabled.', 'Field headers', false],
  ['showFieldResize', 'Resize handles', 'Drag to pin a height; double-click restores the grid cell height.', 'Layout and help', true],
  ['workspaceSnapGrid', 'Snap manual resize to 8px', 'Applies to dragging and keyboard resizing. Hold Shift to snap temporarily.', 'Layout and help', true],
  ['showFieldHelp', 'Explanatory notes', 'Show field guidance and generation help. Errors and warnings remain visible.', 'Layout and help', true],
  ['showWorkspaceName', 'Workspace name and edited status', 'Show the recipe name in the Fields bar.', 'Workspace bar', true],
  ['showFieldAdd', 'Add field shortcut', 'Add field stays available under Workspace settings.', 'Workspace bar', true],
  ['showFieldSave', 'Save shortcut', 'Save stays available under Workspace settings.', 'Workspace bar', true],
  ['showFieldVariation', 'Variation Lab shortcut', 'Variation Lab stays available under Workspace settings.', 'Workspace bar', false],
  ['showLayoutsShortcut', 'Starter layouts shortcut', 'Starter layouts stay available under Workspace settings.', 'Workspace bar', true],
  ['showFieldUnlink', 'Unlink fields shortcut', 'Unlink stays available under Workspace settings and asks for confirmation.', 'Workspace bar', false],
];
export const FIELD_EDITOR_DEFAULTS = Object.freeze({
  ...Object.fromEntries(FIELD_EDITOR_TOGGLES.map(([key, , , , value]) => [key, value])),
  fieldEditorColumns: '1', fieldEditorMinHeight: 96,
});
export function normalizeFieldEditorPreferences(value = {}) {
  return {
    ...Object.fromEntries(FIELD_EDITOR_TOGGLES.map(([key, , , , fallback]) => [key, typeof value[key] === 'boolean' ? value[key] : fallback])),
    fieldEditorColumns: ['1', '2', '3', 'auto'].includes(String(value.fieldEditorColumns)) ? String(value.fieldEditorColumns) : '1',
    fieldEditorMinHeight: [80, 96, 128, 160].includes(Number(value.fieldEditorMinHeight)) ? Number(value.fieldEditorMinHeight) : 96,
  };
}
export function fieldEditorSettingsMarkup() {
  const groups = ['Layout and help', 'Field headers', 'Workspace bar'];
  return `<div class="wg-section-divider"></div><div class="wg-panel-title"><div><h3>Fields editor</h3><p>Choose the grid and the controls you want to see. Field settings and workspace actions always remain available.</p></div></div>
    <div class="wg-toggle-grid">
      <label class="wg-toggle-card"><div><strong>Grid columns</strong><small>Equal columns that fit the node. Narrow nodes automatically use fewer columns.</small></div><select data-field-preference="fieldEditorColumns" aria-label="Fields grid columns"><option value="1">1 column</option><option value="2">Up to 2 columns</option><option value="3">Up to 3 columns</option><option value="auto">Auto-fit columns</option></select></label>
      <label class="wg-toggle-card"><div><strong>Minimum field height</strong><small>Grid cells share the available height evenly. Larger collections scroll when needed.</small></div><select data-field-preference="fieldEditorMinHeight" aria-label="Minimum field height"><option value="80">Compact · 80px</option><option value="96">Balanced · 96px</option><option value="128">Roomy · 128px</option><option value="160">Large · 160px</option></select></label>
    </div>${groups.map(group => `<details class="wg-help-item"${group === 'Field headers' ? ' open' : ''}><summary>${group}</summary><div class="wg-toggle-grid">${FIELD_EDITOR_TOGGLES.filter(([, , , category]) => category === group).map(([key, label, description]) => `<label class="wg-toggle-card"><div><strong>${label}</strong><small>${description}</small></div><input type="checkbox" data-field-preference="${key}"></label>`).join('')}</div></details>`).join('')}<div class="wg-button-row"><button type="button" class="wg-button" data-act="resetFieldEditorUi">Reset Fields UI</button></div>`;
}

// Static recipe text occupies a full-width row. Rows with flexible editors share
// the remaining height; collapsed, Auto and manually sized rows keep their size.
export function fieldGridRows(items, columns) {
  columns = Math.max(1, Math.floor(Number(columns) || 1));
  const rows = []; let row = [];
  const flush = () => { if (row.length) { rows.push(row.some(item => item.flexible) ? 'minmax(min-content, 1fr)' : 'max-content'); row = []; } };
  for (const item of items) {
    if (item.static) { flush(); rows.push('max-content'); }
    else { row.push(item); if (row.length === columns) flush(); }
  }
  flush(); return rows.join(' ');
}
