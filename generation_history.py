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

PP_TYPES = frozenset(('PromptPaletteEditor', 'PromptPaletteCombinatorial'))
DEFAULT_SETTINGS = {'enabled': False, 'capture_prompts': False, 'max_entries': 10000, 'enabled_since': 0}

def _seed(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if isinstance(value, float) and (not math.isfinite(value) or not value.is_integer()):
        return None
    return int(value) if 0 <= value <= 0xFFFFFFFFFFFFFFFF else None

def _wildcards(value):
    return [item for item in value if isinstance(item, str)] if isinstance(value, list) else []

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

def media_exists(image, roots):
    try:
        image = validate_image(image)
        root = Path(roots[image['type']]).resolve()
        path = (root / image['subfolder'] / image['filename']).resolve()
        path.relative_to(root)
        return path.is_file()
    except (KeyError, ValueError, OSError):
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


def detect_node_channel_roles(graph: dict, start_node_id: str, *, strict=False) -> dict[str, str]:
    """Inspect upstream sampler nodes feeding start_node_id and determine if each PP node feeds positive or negative conditioning."""
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
        if 'positive' in inputs and 'negative' in inputs:
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
            node_type = c_node.get('class_type')
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
            # Only known text encoders preserve a direct resolved-text source.
            # Unknown conditioning transformations remain run-associated.
            if node_type in ('CLIPTextEncode', 'CLIPTextEncodeSDXL', 'CLIPTextEncodeSDXLRefiner', 'CLIPTextEncodeFlux') and isinstance(c_inputs, dict):
                for name in ('text', 'text_g', 'text_l', 'clip_l', 't5xxl'):
                    c_val = c_inputs.get(name)
                    if isinstance(c_val, (list, tuple)) and len(c_val) == 2 and isinstance(c_val[0], (str, int)):
                        c_stack.append((str(c_val[0]), c_val[1]))

    for sid in sampler_nodes:
        s_inputs = graph.get(sid, {}).get('inputs', {})
        trace_feed(s_inputs.get('positive'), 'positive')
        trace_feed(s_inputs.get('negative'), 'negative')

    return roles

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
    if isinstance(workflow, dict) and isinstance(workflow.get('nodes'), list):
        for wn in workflow['nodes']:
            if isinstance(wn, dict) and 'id' in wn and 'title' in wn and wn['title']:
                workflow_titles[str(wn['id'])] = str(wn['title'])

    palette_container = extra_pnginfo.get('prompt_palette', {}) if isinstance(extra_pnginfo, dict) else {}
    palette_nodes = palette_container.get('nodes', {}) if isinstance(palette_container, dict) else {}

    result = []
    outputs = history.get('outputs', {})
    if not isinstance(outputs, dict): return []
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
            meta = palette_nodes.get(node_id, {}) if isinstance(palette_nodes, dict) else {}
            meta = meta if isinstance(meta, dict) else {}
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
            }
            if capture_prompts:
                for key, target in [('text', 'authored_positive'), ('negative_text', 'authored_negative')]:
                    value = inputs.get(key)
                    if isinstance(value, str):
                        context[target] = value[:100000]
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
                meta = palette_nodes.get(matched_pp_id) if isinstance(palette_nodes, dict) else None
                meta = meta if isinstance(meta, dict) else None
                if not meta and isinstance(extra_pnginfo.get('prompt_palette_metadata'), dict):
                    primary = extra_pnginfo['prompt_palette_metadata']
                    if str(primary.get('node_id', '')) == matched_pp_id or len(palette) == 1:
                        meta = primary

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
