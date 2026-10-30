"""Read-only library relationships and validated virtual collection queries."""
from __future__ import annotations
import hashlib
import fnmatch
import json
import threading
import time
from pathlib import Path
from .json_literals import json_object_spans
from .wildcard_resolver import WILDCARD_RE

FIELDS = {'path','type','tag','favorite','thumbnail','recent','recipe','run','missing','circular','compatible'}
BOOLEANS = {'favorite','thumbnail','recent','recipe','run','missing','circular','compatible'}

def validate_collection(data):
    if not isinstance(data,dict): raise ValueError('Collection must be an object')
    name=data.get('name','')
    if not isinstance(name,str) or not name.strip() or len(name)>120: raise ValueError('Collection name must contain 1–120 characters')
    groups=data.get('groups',[])
    if not isinstance(groups,list) or len(groups)>12: raise ValueError('At most 12 filter groups are allowed')
    clean=[]
    for group in groups:
        if not isinstance(group,list) or not 1<=len(group)<=12: raise ValueError('Each group needs 1–12 filters')
        terms=[]
        for term in group:
            if not isinstance(term,dict) or term.get('field') not in FIELDS: raise ValueError('Unknown collection filter')
            field,value=term['field'],term.get('value')
            if field in BOOLEANS:
                if not isinstance(value,bool):raise ValueError('Boolean filter required')
            elif not isinstance(value,str) or not value or len(value)>1024:raise ValueError('Invalid text filter')
            terms.append({'field':field,'value':value})
        clean.append(terms)
    view=data.get('view','list');sort=data.get('sort','default')
    if view not in ('list','gallery','grid','tiles','contact','masonry','filmstrip'):raise ValueError('Invalid collection view')
    if sort not in ('default','az','za'):raise ValueError('Invalid collection sort')
    return {**data,'name':name.strip(),'groups':clean,'view':view,'sort':sort}

def references(text):
    """Use canonical token grammar, excluding JSON literals, comments and escapes."""
    spans=json_object_spans(text)
    protected=list(text)
    for start,end in spans: protected[start:end]=' '*(end-start)
    text=''.join(protected)
    result=[]
    offset=0
    for line in text.splitlines(keepends=True):
        if not line.lstrip().startswith('#'):
            for match in WILDCARD_RE.finditer(line):
                at=match.start();slashes=0
                while at>0 and line[at-1]=='\\':slashes+=1;at-=1
                if slashes%2:continue
                result.append({'target':match.group(2),'offset':offset+match.start()})
        offset+=len(line)
    return result

def extract_recipe_references(data):
    """Recursively extract references from structured recipe JSON (v1, v2, pack, and workspaces)."""
    if not isinstance(data, dict):
        return []
    refs = []

    # Recipe pack v1
    if data.get('schema') == 'prompt-palette.recipe-pack.v1' or 'recipe' in data:
        if isinstance(data.get('recipe'), dict):
            refs.extend(extract_recipe_references(data['recipe']))
        if isinstance(data.get('dependencies'), dict):
            for dep_text in data['dependencies'].values():
                if isinstance(dep_text, str):
                    refs.extend(references(dep_text))
        return refs

    # String fields in recipe
    for key in ('source', 'positive', 'negative'):
        val = data.get(key)
        if isinstance(val, str) and val.strip():
            for ref in references(val):
                refs.append({**ref, 'channel': key if key in ('positive', 'negative') else 'positive'})

    # Fields array (v1 and v2)
    fields = data.get('fields')
    if isinstance(fields, list):
        for field in fields:
            if not isinstance(field, dict):
                continue
            field_id = field.get('id', '')
            field_name = field.get('name', '')
            channel = field.get('channel', 'positive')
            for prop in ('value', 'default', 'variationTemplate'):
                val = field.get(prop)
                if isinstance(val, str) and val.strip():
                    for ref in references(val):
                        refs.append({**ref, 'field_id': field_id, 'field_name': field_name, 'channel': channel, 'prop': prop})

    # Segments array (v2 static segments)
    segments = data.get('segments')
    if isinstance(segments, list):
        for seg in segments:
            if isinstance(seg, dict) and seg.get('type') == 'static':
                text = seg.get('text', '')
                if isinstance(text, str) and text.strip():
                    channel = seg.get('channel', 'positive')
                    for ref in references(text):
                        refs.append({**ref, 'segment_id': seg.get('id', ''), 'channel': channel})

    # Experiments (base, snapshots, variants)
    experiments = data.get('experiments')
    if isinstance(experiments, dict):
        base = experiments.get('base')
        if isinstance(base, dict):
            refs.extend(extract_recipe_references(base))
        snapshots = experiments.get('snapshots')
        if isinstance(snapshots, list):
            for snap in snapshots:
                if isinstance(snap, dict) and isinstance(snap.get('recipe'), dict):
                    refs.extend(extract_recipe_references(snap['recipe']))
        variants = experiments.get('variants')
        if isinstance(variants, list):
            for variant in variants:
                if isinstance(variant, dict):
                    patch = variant.get('patch')
                    if isinstance(patch, dict):
                        patch_fields = patch.get('fields')
                        if isinstance(patch_fields, list):
                            for pf in patch_fields:
                                if isinstance(pf, dict):
                                    for prop in ('value', 'default', 'variationTemplate'):
                                        val = pf.get(prop)
                                        if isinstance(val, str) and val.strip():
                                            refs.extend(references(val))
                        props = patch.get('properties')
                        if isinstance(props, dict):
                            neg = props.get('negative')
                            if isinstance(neg, str) and neg.strip():
                                refs.extend(references(neg))
                        patch_segs = patch.get('segments')
                        if isinstance(patch_segs, list):
                            for ps in patch_segs:
                                if isinstance(ps, dict) and isinstance(ps.get('text'), str):
                                    refs.extend(references(ps['text']))

    return refs

def analyze_entry(text, path=''):
    """Analyze text for references and detect structured recipes."""
    first_line = text.split('\n', 1)[0].strip() if text else ''
    is_recipe = False
    edges = []

    prefix_v2 = '# Prompt Palette adjustable recipe v2 '
    prefix_v1 = '# Prompt Palette adjustable recipe v1 '
    if first_line.startswith((prefix_v2, prefix_v1)):
        is_recipe = True
        try:
            prefix = prefix_v2 if first_line.startswith(prefix_v2) else prefix_v1
            recipe_json = first_line[len(prefix):]
            data = json.loads(recipe_json)
            edges.extend(extract_recipe_references(data))
        except Exception:
            pass
        rest = text.split('\n', 1)[1] if '\n' in text else ''
        if rest:
            edges.extend(references(rest))
        return edges, is_recipe

    stripped = text.strip()
    if stripped.startswith('{') and stripped.endswith('}'):
        try:
            data = json.loads(stripped)
            if isinstance(data, dict) and (data.get('schema', '').startswith('prompt-palette.') or ('fields' in data and 'segments' in data) or 'recipe' in data):
                is_recipe = True
                edges = extract_recipe_references(data)
                return edges, is_recipe
        except Exception:
            pass

    edges = references(text)
    if path.lower().startswith(('recipes/', 'recipe/')):
        is_recipe = True
    return edges, is_recipe

_cache={};_results={};_lock=threading.Lock()
def dependency_index(index):
    # Existing index owns freshness and exact identities. Cache unchanged entry
    # fingerprints, and bound both input text and graph size on explicit use.
    fingerprint=index.fingerprint()
    with _lock:
        if fingerprint in _results:return _results[fingerprint]
    entries=index.flat_list()
    if len(entries)>50000:raise ValueError('Dependency inspection supports up to 50,000 entries')
    nodes={};total=0
    with _lock:
        key=str(index.get_root_dir());previous=_cache.get(key,{})
        for entry in entries:
            path=entry['path'];raw=index.get_entry(path) or {};lines=raw.get('lines',[])
            text='\n'.join(str(line) for line in lines)
            # The resolver intentionally drops comments, including the recipe
            # JSON header. Inspect bounded source text for TXT recipes instead.
            if raw.get('type') == 'txt' and raw.get('abs_path'):
                source = Path(raw['abs_path']).resolve()
                root = Path(index.get_root_dir()).resolve()
                if source.is_relative_to(root):
                    try:
                        with source.open('r', encoding='utf-8', errors='replace') as handle:
                            text = handle.read(32_000_001)
                    except OSError as exc:
                        raise ValueError('A library source changed during dependency inspection; refresh and retry') from exc
            total+=len(text)
            if total>32_000_000:raise ValueError('Dependency inspection exceeds the 32 MB work limit')
            digest=hashlib.sha256(text.encode()).hexdigest()
            old=previous.get(path)
            if old and old['digest'] == digest:
                edges = old['edges']
                is_recipe = old.get('is_recipe', False)
            else:
                edges, is_recipe = analyze_entry(text, path)

            try: modified=Path(raw.get('abs_path','')).stat().st_mtime
            except OSError: modified=0
            nodes[path]={'digest':digest,'edges':edges,'type':entry.get('type','txt'),'modified_at':modified,'is_recipe':is_recipe}
        _cache.clear();_cache[key]=nodes
    names=set(nodes);forward={name:[] for name in nodes};reverse={name:[] for name in nodes}
    leaves={}
    for name in nodes:leaves.setdefault(name.rsplit('/',1)[-1],[]).append(name)
    resolved={};edge_count=0
    for name,node in nodes.items():
        for edge in node['edges']:
            target=edge['target']
            if target not in resolved:
                if target in names:resolved[target]=[target]
                elif '*' in target:resolved[target]=fnmatch.filter(names,target)
                else:resolved[target]=leaves.get(target,[]) if len(leaves.get(target,[]))==1 else []
            targets=resolved[target];edge_count+=len(targets)
            if edge_count>100000:raise ValueError('Dependency graph exceeds 100,000 expanded references')
            for canonical in targets:forward[name].append(canonical);reverse[canonical].append(name)
    # Iterative graph walk, avoiding Python recursion limits for deep libraries.
    color={};cyclic=set()
    for start in nodes:
        if color.get(start):continue
        stack=[(start,iter(forward[start]))];active=[start];positions={start:0};color[start]=1
        while stack:
            name,children=stack[-1]
            child=next(children,None)
            if child is None:
                color[name]=2;stack.pop();positions.pop(name,None);active.pop();continue
            if color.get(child)==1:cyclic.update(active[positions[child]:])
            elif not color.get(child):
                color[child]=1;positions[child]=len(active);active.append(child);stack.append((child,iter(forward[child])))
    records={}
    for name,node in nodes.items():
        refs=node['edges'];missing=[edge['target'] for edge in refs if not resolved.get(edge['target'])]
        used_recipes = sum(1 for source in set(reverse[name]) if nodes.get(source, {}).get('is_recipe') or source.lower().startswith(('recipes/', 'recipe/')))
        records[name]={'entry':name,'references':refs,'referenced_by':sorted(set(reverse[name])), 'missing':sorted(set(missing)), 'circular':name in cyclic,'modified_at':node['modified_at'],'used_in_recipes':used_recipes,'is_recipe':bool(node.get('is_recipe'))}
    with _lock:
        _results.clear();_results[fingerprint]=records
    return records
