import { cloneWorkspaceData, compileWorkspace, newField, validateWorkspaceRecipe, WORKSPACE_KEY, WORKSPACE_SCHEMA } from './recipe_workspace_model.js';
import { fieldVariationSource } from './recipe_variation_source.js';
import { hideNativeWidget, queueSocketRailLayout } from '../prompt_palette_compat.js';
import { setSocketLabel, socketConnected, socketDisplayLabel } from '../renderer/base_renderer_adapter.js';

export function hasOccupiedWorkspaceFields(workspace) {
  const fields = workspace?.recipe?.fields;
  if (!Array.isArray(fields) || !fields.length) return false;
  if (fields.length > 1) return true;
  const f = fields[0];
  return !!(
    String(f.value || '').trim() ||
    f.hasInput ||
    f.hasOutput ||
    f.experimentState ||
    f.channel === 'negative' ||
    (f.fieldType && f.fieldType !== 'text') ||
    (f.label && f.label !== 'Prompt' && f.label !== 'Field 1')
  );
}

function parseWorkspaceRuntimeFromSource(node, info = null) {
  const candidates = [];
  if (info?.widgets_values_named && typeof info.widgets_values_named === 'object') {
    candidates.push(info.widgets_values_named.workspace_runtime);
  }
  if (Array.isArray(info?.widgets_values)) {
    for (const entry of info.widgets_values) {
      if (typeof entry === 'string' && entry.includes('"prompt-palette.workspace-generation.v1"')) {
        candidates.push(entry);
      }
    }
  }
  const widget = node?.widgets?.find?.(w => w.name === 'workspace_runtime');
  if (widget) {
    candidates.push(widget.serializeValue?.(), widget.value, widget.__ppWorkspaceRuntimeProjection?.value);
  }
  for (const raw of candidates) {
    if (!raw || typeof raw !== 'string') continue;
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.schema === 'prompt-palette.workspace-generation.v1' && Array.isArray(parsed.fields) && parsed.fields.length) {
        return parsed;
      }
    } catch {}
  }
  return null;
}

// Field ids are generated (UUIDs / f_<time>_<random>). They are identifiers, never names a person typed,
// so they must never surface as a field label, including after separators were swapped for spaces.
const GENERATED_ID_RE = /^(?:[0-9a-f]{8}[-_ ][0-9a-f]{4}[-_ ][0-9a-f]{4}[-_ ][0-9a-f]{4}[-_ ][0-9a-f]{12}|f[-_ ][0-9a-z]{6,}[-_ ][0-9a-z]{6,}|[0-9a-f]{16,})$/i;
const cleanLabelText = value => typeof value === 'string' ? value.replace(/\u200b/g, '').trim() : '';
const isGeneratedLabel = value => GENERATED_ID_RE.test(cleanLabelText(value));
const usableLabel = value => {
  const cleaned = cleanLabelText(value);
  return cleaned && !isGeneratedLabel(cleaned) ? cleaned : '';
};
const rawSlotLabel = slot => cleanLabelText(slot?.__ppSocketRailState?.label ?? slot?.label);

// The saved recipe is the source of truth for names. Even when it cannot be fully restored (for example a
// newer or older experiments block fails validation), its field labels are still the user's own words.
function savedFieldLabels(node, info = null) {
  const labels = new Map();
  const slots = info?.properties?.prompt_palette_slots_v1 ?? node?.properties?.prompt_palette_slots_v1;
  const sources = [info?.properties?.[WORKSPACE_KEY], node?._ppConfiguredWorkspace, node?.properties?.[WORKSPACE_KEY], slots?.slots?.[slots?.active]?.workspace];
  for (const source of sources) {
    const fields = source?.recipe?.fields;
    if (!Array.isArray(fields)) continue;
    for (const f of fields) {
      const label = usableLabel(f?.label) || usableLabel(f?.name);
      if (typeof f?.id === 'string' && label && !labels.has(f.id)) labels.set(f.id, label);
    }
  }
  return labels;
}

// Workflows saved after this bug already carry a mangled id as the label. The original text is gone, so use
// the socket label when the field has one, and a plain ordinal otherwise, rather than showing hex.
function repairGeneratedLabels(recipe, node, info = null) {
  const slots = [...(info?.inputs || node?.inputs || []), ...(info?.outputs || node?.outputs || [])];
  recipe.fields.forEach((f, index) => {
    if (!isGeneratedLabel(f.label)) return;
    const slot = slots.find(s => s?.name === 'field_in_' + f.id || s?.name === 'field_out_' + f.id);
    const label = usableLabel(rawSlotLabel(slot).replace(/^(In|Out):\s*/i, '')) || `Field ${index + 1}`;
    f.label = label;
    if (isGeneratedLabel(f.name)) f.name = label;
  });
  return recipe;
}

function workspaceFromRuntimePayload(runtime, node, info = null) {
  if (!runtime || !Array.isArray(runtime.fields) || !runtime.fields.length) return null;
  const inputSlots = info?.inputs || node?.inputs || [];
  const outputSlots = info?.outputs || node?.outputs || [];
  const savedLabels = savedFieldLabels(node, info);
  const fields = runtime.fields.map((f, index) => {
    const channel = f.channel === 'negative' ? 'negative' : 'positive';
    const points = Array.from(String(runtime[channel] || ''));
    const sliced = Number.isInteger(f.start) && Number.isInteger(f.end) && f.end >= f.start
      ? points.slice(f.start, f.end).join('')
      : '';
    const value = sliced || (typeof f.source === 'string' ? f.source : '');
    const inSlot = inputSlots.find(s => s?.name === 'field_in_' + f.id);
    const outSlot = outputSlots.find(s => s?.name === 'field_out_' + f.id);
    const slotLabel = (rawSlotLabel(inSlot) || rawSlotLabel(outSlot)).replace(/^(In|Out):\s*/i, '').trim();
    // A readable id (for example "field_style") may be prettified; a generated one never is.
    const idLabel = GENERATED_ID_RE.test(String(f.id || '')) ? '' : String(f.id || '').replace(/^field[_-]*/i, '').replace(/[_-]+/g, ' ').trim();
    const label = savedLabels.get(f.id) || usableLabel(slotLabel)
      || (idLabel ? idLabel.charAt(0).toUpperCase() + idLabel.slice(1) : `Field ${index + 1}`);
    const base = newField(label);
    return {
      ...base,
      id: f.id,
      name: label,
      label,
      value,
      default: value,
      channel,
      separator: f.separator ?? runtime.layout?.separators?.[f.id] ?? null,
      experimentState: f.state || null,
      variationMode: f.variation || 'cycle',
      dependsOn: Array.isArray(f.dependsOn) ? [...f.dependsOn] : [],
      hasInput: !!f.hasInput,
      inputPlacement: f.inputPlacement || 'before',
      hasOutput: !!f.hasOutput,
    };
  });
  const recipe = validateWorkspaceRecipe({
    schema: WORKSPACE_SCHEMA,
    name: 'Adjustable recipe',
    description: '',
    separator: runtime.layout?.separator ?? ', ',
    overrideBoundaries: !!runtime.layout?.overrideBoundaries,
    negative: String(runtime.layout?.negative ?? runtime.negative ?? ''),
    fields,
    segments: Array.isArray(runtime.layout?.segments) && runtime.layout.segments.length
      ? runtime.layout.segments
      : fields.map(f => ({ type: 'field', id: f.id })),
  });
  return { recipe, view: 'workspace', path: '', baseline: JSON.stringify(recipe) };
}

function repairConsolidatedFields(saved, node, info = null) {
  const fields = saved?.recipe?.fields;
  if (!Array.isArray(fields) || fields.length < 2) return saved;
  const posFields = fields.filter(f => f.enabled !== false && f.channel !== 'negative');
  if (posFields.length < 2 || !posFields[0].value || posFields.slice(1).some(f => f.value)) return saved;
  const consolidated = posFields[0].value;
  const runtime = parseWorkspaceRuntimeFromSource(node, info);
  if (runtime && runtime.positive === consolidated && Array.isArray(runtime.fields)) {
    const points = Array.from(consolidated);
    const runtimeById = new Map(runtime.fields.map(rf => [rf.id, rf]));
    const hasSplit = posFields.slice(1).some(f => {
      const rf = runtimeById.get(f.id);
      return rf && ((Number.isInteger(rf.start) && Number.isInteger(rf.end) && rf.end > rf.start) || rf.source);
    });
    if (hasSplit) {
      for (const f of posFields) {
        const rf = runtimeById.get(f.id);
        if (!rf) continue;
        const sliced = Number.isInteger(rf.start) && Number.isInteger(rf.end) && rf.end >= rf.start
          ? points.slice(rf.start, rf.end).join('')
          : '';
        f.value = sliced || (typeof rf.source === 'string' ? rf.source : '');
      }
      return saved;
    }
  }
  if (typeof saved.baseline === 'string' && saved.baseline.startsWith('{')) {
    try {
      const baseRecipe = validateWorkspaceRecipe(JSON.parse(saved.baseline));
      if (compileWorkspace(baseRecipe).positive === consolidated) {
        const baseById = new Map(baseRecipe.fields.map(bf => [bf.id, bf]));
        if (posFields.slice(1).some(f => baseById.get(f.id)?.value)) {
          for (const f of posFields) {
            if (baseById.has(f.id)) f.value = baseById.get(f.id).value;
          }
        }
      }
    } catch {}
  }
  return saved;
}

// Checkpoint / variant history is validated strictly but is optional. If only that history is invalid, keep the
// fields (names, categories, accents, sockets, order) instead of discarding the whole workspace with it.
function validateSavedRecipe(recipe) {
  try {
    return validateWorkspaceRecipe(recipe);
  } catch (error) {
    if (recipe?.experiments == null) throw error;
    const core = validateWorkspaceRecipe(recipe, { coreOnly: true });
    console.warn('[Prompt Palette] Saved checkpoint history is invalid and was skipped; fields were restored.', error);
    return core;
  }
}

export function recoverWorkspaceFromNode(node, info = null) {
  const tryNormalize = candidate => {
    if (!candidate?.recipe) return null;
    try {
      const cloned = cloneWorkspaceData(candidate);
      cloned.recipe = repairGeneratedLabels(validateSavedRecipe(cloned.recipe), node, info);
      return repairConsolidatedFields(cloned, node, info);
    } catch (error) {
      // Not silent: this is the step that sends recovery to the generation payload, which carries no labels.
      console.warn('[Prompt Palette] Saved workspace could not be restored; recovering from workflow data instead.', error);
      return null;
    }
  };
  let saved = tryNormalize(info?.properties?.[WORKSPACE_KEY])
    || tryNormalize(node?._ppConfiguredWorkspace)
    || tryNormalize(node?.properties?.[WORKSPACE_KEY]);
  if (!saved) {
    const slotsRaw = info?.properties?.prompt_palette_slots_v1 ?? node?.properties?.prompt_palette_slots_v1;
    if (slotsRaw && typeof slotsRaw === 'object') {
      const activeKey = ['A', 'B', 'C', 'D'].includes(slotsRaw.active) ? slotsRaw.active : 'A';
      saved = tryNormalize(slotsRaw.slots?.[activeKey]?.workspace);
    }
  }
  if (!saved) {
    try {
      saved = workspaceFromRuntimePayload(parseWorkspaceRuntimeFromSource(node, info), node, info);
    } catch {
      saved = null;
    }
  }
  if (saved && info && hasOccupiedWorkspaceFields(saved)) {
    saved.view = 'workspace';
  }
  return saved;
}

// Native configure consumes slot arrays before onConfigure/connection callbacks.
// Fill missing declarations before that boundary, retaining every saved index/link.
export function prepareWorkspaceFieldSockets(node, info) {
  if (!info || typeof info !== 'object') return info;
  const recovered = recoverWorkspaceFromNode(node, info);
  const recipe = recovered?.recipe;
  if (!recipe) return info;
  let fields;
  try { fields = validateWorkspaceRecipe(recipe).fields; } catch { return info; }
  const data = { ...info, properties: { ...(info.properties || {}), [WORKSPACE_KEY]: recovered } };
  if (node) node._ppConfiguredWorkspace = cloneWorkspaceData(recovered);
  for (const [kind, prefix, flag] of [['inputs', 'field_in_', 'hasInput'], ['outputs', 'field_out_', 'hasOutput']]) {
    data[kind] = [...(info[kind] || node?.[kind] || [])];
    for (const field of fields.filter(f => f[flag])) {
      const name = prefix + field.id;
      if (!data[kind].some(slot => slot?.name === name)) data[kind].push({ name, type: 'STRING',
        label: `${kind === 'inputs' ? 'In' : 'Out'}: ${field.label}`, ...(kind === 'inputs' ? { link: null } : { links: [] }) });
    }
  }
  return data;
}

export function installWorkspaceConfigureHook(node) {
  if (!node || node.__ppWorkspaceConfigureHookInstalled) return;
  node.__ppWorkspaceConfigureHookInstalled = true;
  const nativeConfigure = node.configure;
  if (typeof nativeConfigure === 'function') {
    node.configure = function(info, ...args) {
      const prepared = prepareWorkspaceFieldSockets(this, info);
      const result = nativeConfigure.call(this, prepared, ...args);
      if (prepared?.properties?.[WORKSPACE_KEY]) {
        this.properties ||= {};
        this.properties[WORKSPACE_KEY] = cloneWorkspaceData(prepared.properties[WORKSPACE_KEY]);
      }
      return result;
    };
  }
}

// Unicode code points in text.slice(0, offset) for each requested offset, in one pass over the
// text. Equivalent to Array.from(text.slice(0, offset)).length (a surrogate pair cut in half by
// an offset still counts once), but O(text + offsets) instead of O(text) per offset, which made
// every Fields keystroke cost fields x prompt length.
function codePointPrefixLengths(text, offsets) {
  const result = new Map();
  const wanted = [];
  for (const offset of offsets) {
    if (result.has(offset)) continue;
    // Anything slice() would treat specially (negative, fractional, non-numeric) keeps the exact original path.
    if (!Number.isInteger(offset) || offset < 0) result.set(offset, Array.from(text.slice(0, offset)).length);
    else { result.set(offset, 0); wanted.push(offset); }
  }
  if (!wanted.length) return result;
  wanted.sort((a, b) => a - b);
  const length = text.length;
  let count = 0, position = 0;
  for (const offset of wanted) {
    const limit = offset < length ? offset : length;
    while (position < limit) {
      const unit = text.charCodeAt(position);
      if (unit >= 0xD800 && unit <= 0xDBFF && position + 1 < length) {
        const next = text.charCodeAt(position + 1);
        if (next >= 0xDC00 && next <= 0xDFFF) { count++; position += 2; continue; }
      }
      count++; position++;
    }
    result.set(offset, count);
  }
  return result;
}

export function workspaceGeneration(recipe, { namespace = "" } = {}) {
  const valid = validateWorkspaceRecipe(recipe), compiled = compileWorkspace(valid, {}, { includeEmptySockets: true });
  const spanEntries = Object.entries(compiled.spans);
  const offsetsByChannel = new Map();
  for (const [, span] of spanEntries) {
    let offsets = offsetsByChannel.get(span.channel);
    if (!offsets) offsetsByChannel.set(span.channel, (offsets = []));
    offsets.push(span.start, span.end);
  }
  const codePointOffsets = new Map();
  for (const [channel, offsets] of offsetsByChannel) codePointOffsets.set(channel, codePointPrefixLengths(String(compiled[channel] ?? ""), offsets));
  const fields = spanEntries.map(([id, span]) => {
    const field = valid.fields.find(f => f.id === id);
    // Backend spans use Unicode code points, rather than JavaScript UTF-16 units.
    const offsets = codePointOffsets.get(span.channel);
    return {
      id, channel: span.channel,
      start: offsets.get(span.start),
      end: offsets.get(span.end),
      source: field.experimentState === 'lock' ? field.value : fieldVariationSource(field),
      state: field.experimentState,
      variation: field.variationMode || 'cycle',
      dependsOn: field.experimentState === "follow" ? field.dependsOn || [] : [],
      hasInput: !!field.hasInput,
      inputPlacement: field.inputPlacement || "before",
      hasOutput: !!field.hasOutput,
      separator: field.separator ?? valid.separator ?? ", ",
    };
  });
  const output_fields = valid.fields.filter(f => f.hasOutput).map(f => f.id);
  // Keep literal/boundary segments so incoming text can populate empty fields
  // without losing their position or inventing leading/trailing separators.
  const layout = { segments: valid.segments, separator: valid.separator, negative: valid.negative, overrideBoundaries: !!valid.overrideBoundaries,
    separators: Object.fromEntries(valid.fields.map(f => [f.id, f.separator ?? null])),
    edges: Object.fromEntries(['positive', 'negative'].map(channel => {
      const ordered = valid.segments.filter(s => s.type === 'field' && valid.fields.find(f => f.id === s.id).channel === channel);
      return [channel, [ordered[0]?.id ?? null, ordered.at(-1)?.id ?? null]];
    })) };
  return { schema: 'prompt-palette.workspace-generation.v1', namespace: String(namespace), positive: compiled.positive, negative: compiled.negative, fields, output_fields, layout };
}

export function syncWorkspaceFieldSockets(node, recipe) {
  if (!node) return;
  const valid = recipe ? validateWorkspaceRecipe(recipe) : null;
  const fields = valid ? valid.fields : [];
  const inputFields = fields.filter(f => f.hasInput);
  const outputFields = fields.filter(f => f.hasOutput);

  // 1. Maintain input sockets
  if (Array.isArray(node.inputs)) {
    const desiredInputKeys = new Set(inputFields.map(f => "field_in_" + f.id));
    for (let i = node.inputs.length - 1; i >= 0; i--) {
      const slot = node.inputs[i];
      if (slot?.name?.startsWith("field_in_") && !desiredInputKeys.has(slot.name)) {
        // Park inactive slots: even an unconnected slot can precede a live one
        // in serialized workflow indices. Never compact these arrays on edits.
        slot.ppHidden = true;
      }
    }
    for (const f of inputFields) {
      const key = "field_in_" + f.id;
      const label = `In: ${f.label || f.name || "Field"}`;
      let slot = node.inputs.find(s => s?.name === key);
      if (!slot) {
        if (typeof node.addInput === "function") {
          node.addInput(key, "STRING", { label });
          slot = node.inputs.find(s => s?.name === key);
        } else {
          slot = { name: key, type: "STRING", label, link: null };
          node.inputs.push(slot);
        }
      }
      if (slot) { setSocketLabel(slot, label); slot.ppHidden = false; }
    }
  }

  // 2. Maintain output sockets
  if (Array.isArray(node.outputs)) {
    const desiredOutputKeys = new Set(outputFields.map(f => "field_out_" + f.id));
    for (let i = node.outputs.length - 1; i >= 0; i--) {
      const slot = node.outputs[i];
      if (slot?.name?.startsWith("field_out_") && !desiredOutputKeys.has(slot.name)) {
        slot.ppHidden = true;
      }
    }
    for (const f of outputFields) {
      const key = "field_out_" + f.id;
      const label = `Out: ${f.label || f.name || "Field"}`;
      let slot = node.outputs.find(s => s?.name === key);
      if (!slot) {
        if (typeof node.addOutput === "function") {
          node.addOutput(key, "STRING", { label });
          slot = node.outputs.find(s => s?.name === key);
        } else {
          slot = { name: key, type: "STRING", label, links: [] };
          node.outputs.push(slot);
        }
      }
      if (slot) { setSocketLabel(slot, label); slot.ppHidden = false; }
    }
  }

  // 3. Update dynamic input and output definitions
  if (!node._wgBaseInputDefs && Array.isArray(node._wgInputDefs)) {
    node._wgBaseInputDefs = node._wgInputDefs.filter(d => !d.key.startsWith("field_in_"));
  }
  if (!node._wgBaseOutputDefs && Array.isArray(node._wgOutputDefs)) {
    node._wgBaseOutputDefs = node._wgOutputDefs.filter(d => !d.key.startsWith("field_out_"));
  }
  if (node._wgInputDefs && node._wgInputDefs === node._wgBaseInputDefs) {
    node._wgBaseInputDefs = [...node._wgBaseInputDefs];
  }
  if (node._wgOutputDefs && node._wgOutputDefs === node._wgBaseOutputDefs) {
    node._wgBaseOutputDefs = [...node._wgBaseOutputDefs];
  }
  const baseInputs = node._wgBaseInputDefs || [];
  const baseOutputs = node._wgBaseOutputDefs || [];

  const dynamicInputs = inputFields.map(f => ({
    key: "field_in_" + f.id,
    type: "STRING",
    label: `In: ${f.label || f.name || "Field"}`,
    default: true,
    desc: `External text for workspace field '${f.label || f.name || "Field"}' (${f.inputPlacement === "after" ? "appended after" : "prepended before"} widget text).`,
  }));

  const dynamicOutputs = outputFields.map(f => {
    const slotIndex = node.outputs?.findIndex(s => s?.name === "field_out_" + f.id);
    return {
      key: "field_out_" + f.id,
      slotIndex: slotIndex >= 0 ? slotIndex : undefined,
      type: "STRING",
      label: `Out: ${f.label || f.name || "Field"}`,
      default: true,
      desc: `Resolved prompt output from workspace field '${f.label || f.name || "Field"}'.`,
    };
  });

  const parkedDefs = (kind, prefix, active) => (node[kind === 'input' ? 'inputs' : 'outputs'] || [])
    .flatMap((slot, slotIndex) => slot?.name?.startsWith(prefix) && !active.some(def => def.key === slot.name) && socketConnected(kind, slot, node)
      ? [{ key: slot.name, ...(kind === 'output' ? { slotIndex } : {}), type: 'STRING', label: socketDisplayLabel(slot),
        default: false, desc: 'Inactive in this draft. Wire preserved; inactive outputs return empty text.' }] : []);
  const inputs = [...baseInputs, ...dynamicInputs, ...parkedDefs('input', 'field_in_', dynamicInputs)];
  const outputs = [...baseOutputs, ...dynamicOutputs, ...parkedDefs('output', 'field_out_', dynamicOutputs)];
  // The adapters retain these arrays. Update them in place so every surface
  // observes the same definitions without reinstalling renderer/lifecycle hooks.
  node._wgInputDefs ||= [];
  node._wgOutputDefs ||= [];
  node._wgInputDefs.splice(0, node._wgInputDefs.length, ...inputs);
  node._wgOutputDefs.splice(0, node._wgOutputDefs.length, ...outputs);
  node._wgRefreshIoToggles?.();
  queueSocketRailLayout(node);
}

export function syncWorkspaceGeneration(node, recipe) {
  syncWorkspaceFieldSockets(node, recipe);
  const widget = node.widgets?.find(w => w.name === 'workspace_runtime');
  if (!widget) return;
  widget.__ppOwnerNode = node; hideNativeWidget(widget);
  let saved = null;
  try { saved = JSON.parse(widget.serializeValue?.() || widget.value || 'null'); } catch {}
  const relationships = node.properties?.promptPaletteRelationships ?? saved?.relationships;
  const activeOutputs = new Set(recipe ? validateWorkspaceRecipe(recipe).fields.filter(f => f.hasOutput).map(f => f.id) : []);
  const outputFields = (node.outputs || []).filter(slot => slot?.name?.startsWith('field_out_'))
    .map(slot => activeOutputs.has(slot.name.slice(10)) ? slot.name.slice(10) : null);
  const payload = recipe ? workspaceGeneration(recipe, { namespace: node.id }) : relationships || outputFields.length ? { schema:'prompt-palette.workspace-generation.v1', namespace:String(node.id), positive:String(node.widgets?.find(w => w.name === 'text')?.value || ''), negative:String(node.widgets?.find(w => w.name === 'negative_text')?.value || ''), fields:[] } : null;
  // Backend returns fields in this physical slot order. Null pads parked outputs
  // with empty text, so reorder/delete/draft switches cannot cross-route values.
  if (payload) payload.output_fields = outputFields;
  if (payload && relationships) payload.relationships = relationships;
  const value = payload ? JSON.stringify(payload) : '';
  // Native renderer defaults cannot erase this derived execution projection.
  const projection = widget.__ppWorkspaceRuntimeProjection ||= { value: '' };
  projection.value = value;
  const descriptor = Object.getOwnPropertyDescriptor(widget, 'value');
  if (descriptor?.configurable !== false) Object.defineProperty(widget, 'value', {
    configurable: true, enumerable: true, get: () => projection.value,
    set: next => { if (typeof next === 'string' && (next || !projection.value)) projection.value = next; },
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
