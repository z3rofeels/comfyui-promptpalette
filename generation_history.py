"""Conservative generation indexing: host history is evidence, never editor state.

Single-source host metadata can identify a resolved prompt. Batch row-to-image
ordering is not inferred. Multi-user capture is fail-closed because host
history has no authenticated owner field.
"""
from __future__ import annotations
import hashlib
import json
import math
import time
from pathlib import Path, PurePosixPath
from threading import Lock

if __package__:
    from .lora_previews import read_image_dimensions
else:
    from lora_previews import read_image_dimensions

PP_TYPES = frozenset(('PromptPaletteEditor', 'PromptPaletteCombinatorial'))
DEFAULT_SETTINGS = {'enabled': False, 'capture_prompts': False, 'max_entries': 10000, 'enabled_since': 0}
_IMAGE_DIMENSIONS_CACHE = {}
_KNOWN_IMAGE_PATHS = {}
_DIMENSIONS_LOCK = Lock()


def _positive_int(value):
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else None


def _image_dimensions(path):
    """Read and cache (width, height) from an image file header, honoring EXIF rotation."""
    if not path:
        return None
    p = Path(path)
    try:
        st = p.stat()
    except OSError:
        return None
    key = (str(p), st.st_mtime_ns, st.st_size)
    with _DIMENSIONS_LOCK:
        if key in _IMAGE_DIMENSIONS_CACHE:
            dims = _IMAGE_DIMENSIONS_CACHE.pop(key)
            _IMAGE_DIMENSIONS_CACHE[key] = dims
            return dims
    dims = read_image_dimensions(p)
    with _DIMENSIONS_LOCK:
        if key in _IMAGE_DIMENSIONS_CACHE:
            _IMAGE_DIMENSIONS_CACHE.pop(key)
        elif len(_IMAGE_DIMENSIONS_CACHE) >= 2048:
            _IMAGE_DIMENSIONS_CACHE.pop(next(iter(_IMAGE_DIMENSIONS_CACHE)))
        _IMAGE_DIMENSIONS_CACHE[key] = dims
    return dims


def _descriptor_key(image):
    if not isinstance(image, dict):
        return None
    img_type = image.get('type', 'output')
    subfolder = image.get('subfolder', '')
    filename = image.get('filename', '')
    if not isinstance(img_type, str) or not isinstance(subfolder, str) or not isinstance(filename, str) or not filename:
        return None
    return (img_type, subfolder, filename)


def public_record(record, *, roots=None):
    """Keep decimal seed text exact across JSON's browser-number boundary.

    Numeric fields and persisted records remain compatible with older clients.
    The text fields are read-only projections, not a second source of truth.
    """
    result = dict(record)
    seed = _seed(record.get('effective_seed'))
    result['effective_seed_text'] = str(seed) if seed is not None else None
    result['contexts'] = []
    contexts = record.get('contexts')
    for context in contexts if isinstance(contexts, list) else []:
        if not isinstance(context, dict): continue
        item = dict(context)
        seed = _seed(context.get('seed'))
        item['seed_text'] = str(seed) if seed is not None else None
        result['contexts'].append(item)
    width = _positive_int(result.get('width'))
    height = _positive_int(result.get('height'))
    if width is not None and height is not None:
        result['width'], result['height'] = width, height
    elif not result.get('missing'):
        image = result.get('image')
        path = _resolve_image_path(image, roots) if roots else None
        if path is None and roots is None:
            key = _descriptor_key(image)
            if key is not None:
                with _DIMENSIONS_LOCK:
                    path = _KNOWN_IMAGE_PATHS.get(key)
                    if path is not None:
                        _KNOWN_IMAGE_PATHS[key] = _KNOWN_IMAGE_PATHS.pop(key)
        dims = _image_dimensions(path) if path else None
        if dims:
            result['width'], result['height'] = dims
    return result

def _seed(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if isinstance(value, float) and (not math.isfinite(value) or not value.is_integer()):
        return None
    return int(value) if 0 <= value <= 0xFFFFFFFFFFFFFFFF else None

def _wildcards(value):
    return [item for item in value if isinstance(item, str)] if isinstance(value, list) else []


def _selection_evidence(value, capture_prompts=False):
    if not isinstance(value, list):
        return []
    items = []
    for raw_item in value[:256]:
        if not isinstance(raw_item, dict):
            continue
        kind = raw_item.get('kind')
        if kind == 'wildcard':
            name = raw_item.get('name')
            chosen = raw_item.get('chosen')
            if not isinstance(name, str) or not name:
                continue
            entry = {
                'kind': 'wildcard',
                'name': name[:256],
                'mode': str(raw_item.get('mode') or '')[:8],
            }
            if isinstance(chosen, str):
                entry['chosen'] = chosen[:2000]
            items.append(entry)
        elif kind == 'brace':
            chosen = raw_item.get('chosen')
            entry = {'kind': 'brace'}
            if isinstance(chosen, str):
                entry['chosen'] = chosen[:2000]
            chosen_opts = raw_item.get('chosen_options')
            if isinstance(chosen_opts, list):
                entry['chosen_options'] = [str(opt)[:500] for opt in chosen_opts[:16]]
            chosen_idx = raw_item.get('chosen_indices')
            if isinstance(chosen_idx, list):
                entry['chosen_indices'] = [
                    idx for idx in chosen_idx[:16]
                    if isinstance(idx, int) and not isinstance(idx, bool)
                ]
            if capture_prompts:
                if isinstance(raw_item.get('raw'), str):
                    entry['raw'] = raw_item['raw'][:2000]
                opts = raw_item.get('options')
                if isinstance(opts, list):
                    entry['options'] = [str(opt)[:500] for opt in opts[:64]]
            if len(entry) > 1:
                items.append(entry)
        elif kind == 'conditional':
            entry = {'kind': 'conditional'}
            for key in ('block', 'chosen_tag'):
                if isinstance(raw_item.get(key), str):
                    entry[key] = raw_item[key][:32]
            chosen_index = raw_item.get('chosen_index')
            if isinstance(chosen_index, int) and not isinstance(chosen_index, bool):
                entry['chosen_index'] = chosen_index
            if capture_prompts:
                for key in ('open_expr', 'chosen_expr'):
                    if isinstance(raw_item.get(key), str):
                        entry[key] = raw_item[key][:500]
            if len(entry) > 1:
                items.append(entry)
    return items

def _refinement_context(meta, workflow_node, inputs, capture_prompts, role):
    """Retain execution evidence in the existing record, never read live editors.

    Fields are authored context. The client also checks their execution projection
    before offering restoration. Batch rows are deliberately not mapped to images.
    """
    result = {'schema_version': 1, 'verified_channels': [], 'batch': bool(meta.get('batch')),
              'seed_source': 'execution' if _seed(meta.get('seed')) is not None else 'literal-input'}
    if not meta:
        return result
    if not meta.get('batch'):
        result['verified_channels'] = [c for c in ('positive', 'negative') if role in (c, 'both') and isinstance(meta.get(c + '_prompt'), str)]
        for key in ('positive_prompt', 'negative_prompt', 'encoded_prompt', 'encoded_negative_prompt'):
            if isinstance(meta.get(key), str) and len(meta[key]) <= 100000:
                result[key] = meta[key]
        loras = meta.get('loras')
        if isinstance(loras, list) and len(loras) <= 256:
            result['loras'] = []
            for item in loras:
                if not isinstance(item, dict): continue
                sm, sc = item.get('model_strength'), item.get('clip_strength')
                if not isinstance(item.get('name'), str) or any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in (sm, sc)): continue
                result['loras'].append({k: item[k] for k in ('name', 'filename', 'model_strength', 'clip_strength', 'effective_model_strength', 'effective_clip_strength', 'source', 'status') if k in item})
        if meta.get('lora_mode') in ('auto', 'external', 'strip', 'bypass'):
            result['lora_mode'] = meta['lora_mode']
        selections = _selection_evidence(meta.get('branch_selections'), capture_prompts)
        if selections:
            result['branch_selections'] = selections
        for key in ('processing_mode',):
            if isinstance(meta.get(key), str) and meta[key]:
                result[key] = meta[key][:64]
        for key in ('used_enhancer', 'positive_antonyms'):
            if isinstance(meta.get(key), bool):
                result[key] = meta[key]
        count = meta.get('clip_token_count')
        if isinstance(count, int) and not isinstance(count, bool) and count >= 0:
            result['clip_token_count'] = count
    if capture_prompts:
        for key in ('source_text', 'source_negative_text', 'source_prompt', 'source_negative_prompt',
                    'workspace_runtime', 'workspace_fields',
                    'prompt_prefix', 'prompt_suffix', 'negative_prefix', 'negative_suffix', 'variables'):
            value = meta.get(key)
            if isinstance(value, (str, dict)) and len(json.dumps(value, ensure_ascii=False)) <= 400000:
                result[key] = value
        properties = workflow_node.get('properties', {}) if isinstance(workflow_node, dict) else {}
        snapshot = properties.get('prompt_palette_recipe_workspace_v2') if isinstance(properties, dict) else None
        # A connected runtime/body or stale workflow cannot establish Fields ownership.
        if (isinstance(snapshot, dict) and isinstance(meta.get('workspace_runtime'), str)
                and meta.get('workspace_runtime') == inputs.get('workspace_runtime')
                and meta.get('source_text') == inputs.get('text')
                and meta.get('source_negative_text') == inputs.get('negative_text', '')
                and len(json.dumps(snapshot, ensure_ascii=False)) <= 400000):
            result['workspace'] = snapshot
    return result

def settings(store):
    return {**DEFAULT_SETTINGS, **(store.get('settings', 'generation-history') or {})}

def validate_image(value):
    if not isinstance(value, dict) or value.get('type', 'output') not in ('output', 'temp'):
        raise ValueError('Unsupported image descriptor')
    filename, subfolder = value.get('filename'), value.get('subfolder', '')
    if not isinstance(filename, str) or not isinstance(subfolder, str) or not filename or len(filename) > 255 or len(subfolder) > 1024:
        raise ValueError('Invalid image descriptor')
    for part in (filename, subfolder):
        if '\\' in part or '\x00' in part or ':' in part or part.startswith('/') or '..' in PurePosixPath(part).parts:
            raise ValueError('Unsafe image descriptor')
    if '/' in filename or filename in ('.', '..'):
        raise ValueError('Invalid image filename')
    return {'type': value.get('type', 'output'), 'subfolder': subfolder, 'filename': filename}

def _resolve_image_path(image, roots):
    if not roots:
        return None
    try:
        image = validate_image(image)
        root = Path(roots[image['type']]).resolve()
        path = (root / image['subfolder'] / image['filename']).resolve()
        path.relative_to(root)
        return path if path.is_file() else None
    except (KeyError, ValueError, OSError, TypeError):
        return None


def media_exists(image, roots):
    try:
        validated = validate_image(image)
    except ValueError:
        return False
    path = _resolve_image_path(validated, roots)
    key = _descriptor_key(validated)
    if path is not None:
        if key is not None:
            with _DIMENSIONS_LOCK:
                if key in _KNOWN_IMAGE_PATHS:
                    _KNOWN_IMAGE_PATHS.pop(key)
                elif len(_KNOWN_IMAGE_PATHS) >= 2048:
                    _KNOWN_IMAGE_PATHS.pop(next(iter(_KNOWN_IMAGE_PATHS)))
                _KNOWN_IMAGE_PATHS[key] = path
        return True
    if key is not None:
        with _DIMENSIONS_LOCK:
            _KNOWN_IMAGE_PATHS.pop(key, None)
    return False

def trace_upstream_palette_nodes(graph: dict, start_node_id: str) -> set[str]:
    """Find all Prompt Palette nodes that feed into start_node_id in graph."""
    pp_nodes = set()
    visited = set()
    stack = [str(start_node_id)]
    while stack:
        nid = stack.pop()
        if nid in visited:
            continue
        visited.add(nid)
        node = graph.get(nid)
        if not isinstance(node, dict):
            continue
        if nid != str(start_node_id) and node.get('class_type') in PP_TYPES:
            pp_nodes.add(nid)
            continue
        inputs = node.get('inputs')
        if isinstance(inputs, dict):
            for val in inputs.values():
                if isinstance(val, (list, tuple)) and len(val) == 2 and isinstance(val[0], (str, int)):
                    stack.append(str(val[0]))
    return pp_nodes


_CONDITIONING_PASSTHROUGH_TYPES = frozenset((
    'FluxGuidance', 'ConditioningSetArea', 'ConditioningSetAreaPercentage', 'ConditioningSetAreaStrength',
    'ConditioningSetMask', 'ConditioningSetTimestepRange', 'ConditioningCombine', 'ConditioningConcat',
    'ConditioningAverage', 'ControlNetApply', 'ControlNetApplyAdvanced', 'ReferenceLatent',
    'InpaintModelConditioning', 'InstructPixToPixConditioning',
))


def detect_node_channel_roles(graph: dict, start_node_id: str, *, strict=False) -> dict[str, str]:
    """Inspect upstream sampler/guider nodes feeding start_node_id and determine if each PP node feeds positive or negative conditioning."""
    roles = {}
    visited = set()
    stack = [str(start_node_id)]
    sampler_nodes = []
    while stack:
        nid = stack.pop()
        if nid in visited:
            continue
        visited.add(nid)
        node = graph.get(nid)
        if not isinstance(node, dict):
            continue
        inputs = node.get('inputs')
        if not isinstance(inputs, dict):
            continue
        node_type = str(node.get('class_type') or '')
        if ('positive' in inputs and 'negative' in inputs) or (
            node_type == 'BasicGuider' and 'conditioning' in inputs
        ) or (
            node_type == 'DualCFGGuider' and 'cond1' in inputs and 'cond2' in inputs
        ):
            sampler_nodes.append(nid)
            continue
        for val in inputs.values():
            if isinstance(val, (list, tuple)) and len(val) == 2 and isinstance(val[0], (str, int)):
                stack.append(str(val[0]))

    def trace_feed(val, role):
        if not (isinstance(val, (list, tuple)) and len(val) == 2 and isinstance(val[0], (str, int))):
            return
        c_visited = set()
        c_stack = [(str(val[0]), val[1])]
        while c_stack:
            cid, output_slot = c_stack.pop()
            key = (cid, output_slot)
            if key in c_visited:
                continue
            c_visited.add(key)
            c_node = graph.get(cid)
            if not isinstance(c_node, dict):
                continue
            node_type = str(c_node.get('class_type') or '')
            if node_type in PP_TYPES:
                slots = ({'positive': {2, 4}, 'negative': {3, 5}} if node_type == 'PromptPaletteEditor'
                         else {'positive': {2, 3, 9, 11}, 'negative': {10, 12, 21, 22}})
                # A model, CLIP, seed or raw-source socket is not evidence that
                # the resolved prompt conditioned this image.
                if output_slot not in (slots[role] if strict else slots['positive'] | slots['negative']):
                    continue
                if cid not in roles:
                    roles[cid] = role
                elif roles[cid] != role:
                    roles[cid] = 'both'
                continue
            c_inputs = c_node.get('inputs')
            if not isinstance(c_inputs, dict) or node_type == 'ConditioningZeroOut':
                continue
            if node_type.startswith(('CLIPTextEncode', 'TextEncode')):
                for name in ('text', 'text_g', 'text_l', 'clip_l', 't5xxl', 'prompt', 'llama'):
                    c_val = c_inputs.get(name)
                    if isinstance(c_val, (list, tuple)) and len(c_val) == 2 and isinstance(c_val[0], (str, int)):
                        c_stack.append((str(c_val[0]), c_val[1]))
            elif node_type in _CONDITIONING_PASSTHROUGH_TYPES:
                for name in ('conditioning', 'conditioning_1', 'conditioning_2', 'conditioning_to', 'conditioning_from', role):
                    c_val = c_inputs.get(name)
                    if isinstance(c_val, (list, tuple)) and len(c_val) == 2 and isinstance(c_val[0], (str, int)):
                        c_stack.append((str(c_val[0]), c_val[1]))

    for sid in sampler_nodes:
        s_node = graph.get(sid, {})
        s_inputs = s_node.get('inputs', {})
        if 'positive' in s_inputs or 'negative' in s_inputs:
            trace_feed(s_inputs.get('positive'), 'positive')
            trace_feed(s_inputs.get('negative'), 'negative')
        elif s_node.get('class_type') == 'BasicGuider':
            trace_feed(s_inputs.get('conditioning'), 'positive')
        elif s_node.get('class_type') == 'DualCFGGuider':
            trace_feed(s_inputs.get('cond1'), 'positive')
            trace_feed(s_inputs.get('cond2'), 'negative')

    return roles

def _palette_meta_for_node(node_id, palette_nodes, output_palette_nodes, extra_pnginfo, palette_count):
    out_meta = output_palette_nodes.get(node_id) if isinstance(output_palette_nodes, dict) else None
    png_meta = palette_nodes.get(node_id) if isinstance(palette_nodes, dict) else None
    meta = {}
    if isinstance(out_meta, dict):
        meta.update(out_meta)
    if isinstance(png_meta, dict):
        meta.update(png_meta)
    if not meta and isinstance(extra_pnginfo.get('prompt_palette_metadata'), dict):
        primary = extra_pnginfo['prompt_palette_metadata']
        if str(primary.get('node_id', '')) == node_id or (not primary.get('node_id') and palette_count == 1):
            meta = dict(primary)
    return meta


def build_records(prompt_id, history, *, capture_prompts=False, roots=None):
    if not isinstance(history, dict):
        return []
    status = history.get('status', {})
    if not isinstance(status, dict):
        return []
    if status.get('status_str') != 'success' or status.get('completed') is not True:
        return []
    prompt = history.get('prompt', [])
    if not isinstance(prompt, (list, tuple)) or len(prompt) < 4 or str(prompt[1]) != str(prompt_id) or not isinstance(prompt[2], dict):
        return []
    graph = prompt[2]
    palette = [(str(key), value) for key, value in graph.items() if isinstance(value, dict) and value.get('class_type') in PP_TYPES]
    if not palette:
        return []
    serialized = json.dumps(graph, sort_keys=True, ensure_ascii=False, separators=(',', ':'))
    if len(serialized) > 2_000_000:
        raise ValueError('Workflow is too large to index')
    workflow_hash = hashlib.sha256(serialized.encode()).hexdigest()
    completed_at = 0
    for message in status.get('messages', []):
        if isinstance(message, (list, tuple)) and len(message) == 2 and message[0] == 'execution_success' and isinstance(message[1], dict):
            timestamp = message[1].get('timestamp', 0)
            if isinstance(timestamp, (int, float)) and not isinstance(timestamp, bool) and (not isinstance(timestamp, float) or math.isfinite(timestamp)):
                completed_at = max(completed_at, int(timestamp))
    # Missing completion time is explicitly unknown, never inferred from file age.
    # Extract execution metadata and workflow titles from extra_data if available
    extra_data = prompt[3] if len(prompt) > 3 and isinstance(prompt[3], dict) else {}
    extra_pnginfo = extra_data.get('extra_pnginfo', {}) if isinstance(extra_data, dict) else {}
    workflow = extra_pnginfo.get('workflow', {}) if isinstance(extra_pnginfo, dict) else {}
    workflow_titles = {}
    workflow_nodes = {}
    if isinstance(workflow, dict) and isinstance(workflow.get('nodes'), list):
        for wn in workflow['nodes']:
            if isinstance(wn, dict) and 'id' in wn:
                workflow_nodes[str(wn['id'])] = wn
            if isinstance(wn, dict) and 'id' in wn and 'title' in wn and wn['title']:
                workflow_titles[str(wn['id'])] = str(wn['title'])

    palette_container = extra_pnginfo.get('prompt_palette', {}) if isinstance(extra_pnginfo, dict) else {}
    palette_nodes = palette_container.get('nodes', {}) if isinstance(palette_container, dict) else {}

    result = []
    outputs = history.get('outputs', {})
    if not isinstance(outputs, dict): return []
    output_palette_nodes = {}
    for out_nid, out_val in outputs.items():
        if not isinstance(out_val, dict):
            continue
        pp_ui = out_val.get('prompt_palette')
        if isinstance(pp_ui, list) and len(pp_ui) == 1 and isinstance(pp_ui[0], dict):
            pp_ui = pp_ui[0]
        if isinstance(pp_ui, dict):
            output_palette_nodes[str(out_nid)] = pp_ui

    for output_id, output in outputs.items():
        if not isinstance(output, dict):
            continue
        images = output.get('images', [])
        if not isinstance(images, list): continue

        upstream_pps = trace_upstream_palette_nodes(graph, str(output_id))
        node_roles = detect_node_channel_roles(graph, str(output_id))
        source_roles = detect_node_channel_roles(graph, str(output_id), strict=True)

        contexts = []
        for node_id, node in palette:
            inputs = node.get('inputs', {}) if isinstance(node.get('inputs'), dict) else {}
            meta = _palette_meta_for_node(node_id, palette_nodes, output_palette_nodes, extra_pnginfo, len(palette))
            title = workflow_titles.get(node_id) or f"{node['class_type']} #{node_id}"
            channel_role = node_roles.get(node_id, '')
            seed = _seed(meta.get('seed'))
            if seed is None:
                seed = _seed(inputs.get('seed'))
            wildcards_used = _wildcards(meta.get('wildcards_used'))
            resolved_prompt = meta.get('positive_prompt')
            resolved_prompt = resolved_prompt if isinstance(resolved_prompt, str) else None

            context = {
                'node_id': str(node_id),
                'node_type': node['class_type'],
                'title': title,
                'channel_role': channel_role,
                'seed': seed,
                'wildcards_used': wildcards_used,
                'resolved_prompt': resolved_prompt,
                'refinement': _refinement_context(meta, workflow_nodes.get(node_id), inputs, capture_prompts,
                    source_roles.get(node_id, '') if upstream_pps == {node_id} else ''),
            }
            if capture_prompts:
                for key, target in [('text', 'authored_positive'), ('negative_text', 'authored_negative')]:
                    value = inputs.get(key)
                    if isinstance(value, str) and len(value) <= 100000:
                        context[target] = value
            contexts.append(context)

        for index, descriptor in enumerate(images[:1000]):
            try:
                image = validate_image(descriptor)
            except ValueError:
                continue
            identity = json.dumps([str(prompt_id), str(output_id), index, image], sort_keys=True)
            digest = hashlib.sha256(identity.encode()).hexdigest()

            # Attempt verified attribution if exactly one Palette node feeds this output
            provenance = 'run-associated'
            resolved_positive = None
            resolved_negative = None
            effective_seed = None
            wildcards_used = []
            matched_pp_id = None
            branch_index = None

            if len(upstream_pps) == 1:
                matched_pp_id = next(iter(upstream_pps))
                meta = _palette_meta_for_node(matched_pp_id, palette_nodes, output_palette_nodes, extra_pnginfo, len(palette)) or None

                if meta and source_roles.get(matched_pp_id) in ('positive', 'both'):
                    # Host output arrays can be reordered, split or concatenated
                    # downstream. A batch ordinal alone does not prove which
                    # Palette row produced this image; retain run context only.
                    if not meta.get('batch') and isinstance(meta.get('positive_prompt'), str):
                        resolved_positive = meta['positive_prompt']
                        resolved_negative = meta.get('negative_prompt') if source_roles.get(matched_pp_id) == 'both' else None
                        resolved_negative = resolved_negative if isinstance(resolved_negative, str) else None
                        effective_seed = _seed(meta.get('seed'))
                        wildcards_used = _wildcards(meta.get('wildcards_used'))
                        provenance = 'verified'

            record = {
                'id': f'{completed_at:016d}-{digest}', 'prompt_id': str(prompt_id),
                'output_node_id': str(output_id), 'output_index': index, 'image': image,
                'provenance': provenance, 'completed_at': completed_at,
                'workflow_hash': workflow_hash, 'contexts': contexts,
                'resolved_positive': resolved_positive, 'resolved_negative': resolved_negative,
                'effective_seed': effective_seed, 'wildcards_used': wildcards_used,
                'pp_node_id': matched_pp_id, 'branch_index': branch_index,
                'favorite': False, 'tags': [], 'notes': '', 'missing': False,
            }
            if roots:
                image_path = _resolve_image_path(image, roots)
                dims = _image_dimensions(image_path) if image_path else None
                if dims:
                    record['width'], record['height'] = dims
            # Optional context must not prevent an otherwise valid image from
            # fitting the existing store's 1 MiB record limit. Omit whole values;
            # never present a truncated prompt or recipe as recoverable state.
            if len(json.dumps(record, ensure_ascii=False).encode()) > 950000:
                for context in contexts:
                    context['refinement'] = {k: v for k, v in context['refinement'].items()
                        if k in ('schema_version', 'verified_channels', 'seed_source', 'batch', 'lora_mode', 'loras',
                                 'processing_mode', 'used_enhancer', 'positive_antonyms', 'clip_token_count')}
            result.append(record)
            if len(result) >= 1000:
                return result
    return result

def index_history(store, history, *, explicit=False, roots=None):
    prefs = settings(store)
    if not prefs['enabled'] and not explicit:
        return {'added': 0, 'disabled': True}
    added = 0
    for prompt_id, item in list(history.items())[:100]:
        for record in build_records(prompt_id, item, capture_prompts=prefs['capture_prompts'], roots=roots):
            if not explicit and (not record['completed_at'] or record['completed_at'] < prefs['enabled_since']):
                continue
            if store.get('generation_tombstones', record['id']) or store.get('generations', record['id']):
                continue
            try:
                store.put('generations', record.pop('id'), record, expected_revision=0)
                added += 1
            except Exception as exc:
                from .feature_store import FeatureConflict
                if not isinstance(exc, FeatureConflict): raise
                # Duplicate completion events are idempotent across open tabs.
    maximum = max(100, min(10000, int(prefs['max_entries'])))
    records, cursor = [], ''
    while True:
        page = store.list('generations', cursor=cursor, limit=100)
        records.extend(page['items'])
        cursor = page['next_cursor']
        if not cursor: break
    for record in records[:-maximum]:
        try: store.delete('generations', record['id'], expected_revision=record['revision'])
        except Exception as exc:
            from .feature_store import FeatureConflict
            if not isinstance(exc, FeatureConflict): raise
    return {'added': added}
