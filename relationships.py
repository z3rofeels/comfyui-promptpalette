"""Opt-in, bounded relationship selection. Never writes wildcard source files."""
from __future__ import annotations
import hashlib
import json
import math
import random
import time
from collections import Counter

SCHEMA_VERSION = 1
MAX_EVALUATIONS = 10000
MAX_ENTRIES = 32
MAX_RULES = 1000

class RelationshipError(ValueError):
    def __init__(self, code, message, rules=None):
        self.code, self.rules = code, list(rules or [])
        super().__init__('Smart relationships: ' + message)
    def as_dict(self):
        return {'code': self.code, 'message': str(self), 'rules': self.rules}

def choice_catalog(lines):
    counts, choices = Counter(), []
    values = [str(line) for line in lines]
    for text in values:
        digest = hashlib.sha256(text.strip().encode('utf-8')).hexdigest()
        ordinal = counts[digest]; counts[digest] += 1
        choices.append({'id': digest + ':' + str(ordinal), 'text': text})
    revision = hashlib.sha256(json.dumps(values, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
    return {'revision': revision, 'choices': choices}

def catalog(index, paths):
    if not isinstance(paths, list) or len(paths) > MAX_ENTRIES:
        raise RelationshipError('limit', 'Choose at most 32 entries.')
    result = {}
    for path in paths:
        if not isinstance(path, str) or not path or len(path) > 1024 or path.startswith(('/', '\\')) or '..' in path.split('/') or '\\' in path:
            raise RelationshipError('path', 'Invalid relative library entry.')
        entry = index.get_entry(path) if hasattr(index, 'get_entry') else None
        if entry and entry.get('type') != 'txt': raise RelationshipError('type', 'Smart relationships currently support TXT entries only: ' + path)
        lines = index.get_lines(path)
        if not lines: raise RelationshipError('missing', 'Missing or empty entry: ' + path)
        if len(lines) > MAX_EVALUATIONS: raise RelationshipError('limit', 'Entry has too many relationship choices: ' + path)
        result[path] = choice_catalog(lines)
    return result

def validate_config(config, index):
    if config is None: return None
    if not isinstance(config, dict): raise RelationshipError('schema', 'Relationship configuration must be an object.')
    if config.get('enabled') is not True: return None
    if config.get('schema_version') != SCHEMA_VERSION: raise RelationshipError('schema', 'Unsupported rule version.')
    entries, rules = config.get('entries'), config.get('rules')
    if not isinstance(entries, dict) or not entries or len(entries) > MAX_ENTRIES:
        raise RelationshipError('entries', 'Choose between 1 and 32 participating entries.')
    if not isinstance(rules, list) or len(rules) > MAX_RULES: raise RelationshipError('rules', 'Too many rules.')
    current = catalog(index, list(entries))
    for path, source in entries.items():
        if not isinstance(source, dict): raise RelationshipError('stale', 'Needs review: invalid source identity for ' + path)
        tags = source.get('tags', {})
        if not isinstance(tags, dict) or len(tags) > MAX_EVALUATIONS: raise RelationshipError('tags', 'Invalid choice tags.')
        for identity, values in tags.items():
            if not isinstance(identity, str) or not isinstance(values, list) or len(values)>32 or any(not isinstance(v,str) or not v or len(v)>80 for v in values): raise RelationshipError('tags', 'Invalid choice tags.')
        if source.get('revision') != current[path]['revision']:
            choices = current[path]['choices']
            counts = Counter(choice['id'].split(':')[0] for choice in choices)
            known = {choice['id'] for choice in choices}
            for identity in source.get('tags', {}):
                if identity not in known or counts.get(identity.split(':')[0], 0) != 1: raise RelationshipError('stale', 'Needs review: changed or ambiguous tagged choice in ' + path)
            endpoints = [rule.get(side, {}) for rule in rules if isinstance(rule, dict) for side in ('source', 'target')]
            for endpoint in endpoints:
                if not isinstance(endpoint, dict): raise RelationshipError('rule', 'Invalid rule endpoint.')
                if endpoint.get('entry') == path and 'tag' not in endpoint:
                    identity = endpoint.get('choice_id', '')
                    if identity not in known or counts.get(identity.split(':')[0], 0) != 1:
                        raise RelationshipError('stale', 'Needs review: changed or ambiguous choice in ' + path)

    scope = config.get('scope', {'type':'entry','id':config.get('id','')})
    if not isinstance(scope, dict) or scope.get('type') not in ('entry','recipe','collection','global') or not isinstance(scope.get('id'), str) or not scope['id'] or len(scope['id']) > 160: raise RelationshipError('scope', 'Choose a named entry, recipe, collection or explicit global rule scope.')
    for path, source in entries.items():
        tags = source.get('tags', {})
        role = source.get('role', '')
        if not isinstance(role, str) or len(role)>80: raise RelationshipError('role', 'Invalid entry role.')
        for choice in current[path]['choices']: choice['tags'] = tags.get(choice['id'], [])
        current[path]['role'] = role
    ids = {path: {choice['id'] for choice in entry['choices']} for path, entry in current.items()}
    valid_rules = []
    seen_rules = set()
    for rule in rules:
        if not isinstance(rule, dict): raise RelationshipError('rule', 'Invalid rule record.')
        if rule.get('enabled', True) is False: continue
        ident = str(rule.get('id', ''))
        if not ident or len(ident) > 160 or ident in seen_rules: raise RelationshipError('identity', 'Each rule needs a unique identity.')
        seen_rules.add(ident)
        if rule.get('operator') not in ('requires', 'excludes', 'prefers', 'when'):
            raise RelationshipError('operator', 'Unknown relationship operator.', [ident])
        for side in ('source', 'target'):
            endpoint = rule.get(side)
            if not isinstance(endpoint, dict) or endpoint.get('entry') not in ids:
                raise RelationshipError('missing', 'Needs review: a rule entry no longer exists.', [ident])
            if 'tag' in endpoint:
                tag = endpoint['tag']
                if not isinstance(tag, str) or not tag or not any(tag in c['tags'] for c in current[endpoint['entry']]['choices']): raise RelationshipError('missing', 'Needs review: no choices have the rule tag.', [ident])
            elif endpoint.get('choice_id') not in ids[endpoint['entry']]:
                raise RelationshipError('missing', 'Needs review: a rule choice no longer exists.', [ident])
        weight = rule.get('weight', 1)
        if type(weight) not in (int, float) or not math.isfinite(weight) or not 0 < weight <= 100: raise RelationshipError('weight', 'Preference weight must be between 0 and 100.', [ident])
        valid_rules.append(rule)
    return {'id': str(config.get('id', '')), 'scope': scope, 'entries': current, 'rules': valid_rules}

def assignments(config, index, seed=0, *, limit=5001, budget_ms=100, fixed=None):
    """Stable bounded backtracking; hard constraints prune before output caps."""
    plan = validate_config(config, index)
    if plan is None: return [], {'enabled': False}
    start = time.monotonic(); evaluations = 0; rejected = 0; output = []
    names = sorted(plan['entries']); rng = random.Random(int(seed))
    options = {}
    for name in names:
        options[name] = list(plan['entries'][name]['choices'])
        rng.shuffle(options[name])
        if fixed and name in fixed: options[name] = [option for option in options[name] if option['id'] == fixed[name]]
    selected = {}
    def allowed():
        nonlocal rejected
        for rule in plan['rules']:
            src, dst = rule['source'], rule['target']
            a, b = selected.get(src['entry']), selected.get(dst['entry'])
            source_on = a is not None and (src['tag'] in a.get('tags', []) if 'tag' in src else a['id'] == src['choice_id'])
            target_on = b is not None and (dst['tag'] in b.get('tags', []) if 'tag' in dst else b['id'] == dst['choice_id'])
            if rule['operator'] == 'excludes' and source_on and target_on:
                rejected += 1; return False
            if rule['operator'] in ('requires', 'when') and source_on and b is not None and not target_on:
                rejected += 1; return False
        return True
    def visit(depth):
        nonlocal evaluations
        if len(output) >= limit: return
        if depth == len(names):
            score = sum(float(r.get('weight', 1)) for r in plan['rules'] if r['operator'] == 'prefers' and (r['source']['tag'] in selected[r['source']['entry']].get('tags',[]) if 'tag' in r['source'] else selected[r['source']['entry']]['id'] == r['source']['choice_id']) and (r['target']['tag'] in selected[r['target']['entry']].get('tags',[]) if 'tag' in r['target'] else selected[r['target']['entry']]['id'] == r['target']['choice_id']))
            output.append((dict(selected), score)); return
        name = names[depth]
        for option in options[name]:
            evaluations += 1
            if evaluations > MAX_EVALUATIONS or (time.monotonic() - start) * 1000 > budget_ms:
                raise RelationshipError('complexity', 'Rule search exceeded its work budget. Narrow the participating choices or simplify rules.')
            selected[name] = option
            if allowed(): visit(depth + 1)
            if len(output) >= limit: break
        selected.pop(name, None)
    visit(0)
    if not output: raise RelationshipError('unsatisfiable', 'No valid combination. Review the listed hard constraints.', [r.get('id', '') for r in plan['rules']])
    output.sort(key=lambda pair: -pair[1])
    return [selection for selection, _ in output], {'enabled': True, 'algorithm': 'swr_v1', 'ruleset_id': plan['id'], 'scope': plan['scope'], 'valid': len(output), 'rejected_branches': rejected, 'truncated': len(output) >= limit, 'evaluations': evaluations}

class SelectedIndex:
    def __init__(self, index, selected): self.original, self.selected = index, selected
    def get_lines(self, name):
        return [self.selected[name]['text']] if name in self.selected else self.original.get_lines(name)
    def get_entry(self, name):
        entry = self.original.get_entry(name) if hasattr(self.original, 'get_entry') else None
        if entry and name in self.selected:
            return {**entry, 'lines': [self.selected[name]['text']]}
        return entry
    def next_sequential_index(self, name, length, step=1):
        if name in self.selected:
            return 0
        return self.original.next_sequential_index(name, length, step) if hasattr(self.original, 'next_sequential_index') else 0
    def __getattr__(self, name): return getattr(self.original, name)
    def preview_view(self): return SelectedIndex(self.original.preview_view(), self.selected)

def runtime_config(raw):
    if not raw: return None
    if isinstance(raw, str) and len(raw) > 4_000_000: raise RelationshipError('limit', 'Relationship runtime data is too large.')
    try: data = json.loads(raw) if isinstance(raw, str) else raw
    except (ValueError, TypeError): return None  # canonical runtime validator owns malformed JSON
    if not isinstance(data, dict): return None
    value = data.get('relationships')
    if value is not None and not isinstance(value, dict): raise RelationshipError('schema', 'Invalid relationship configuration.')
    return value if value and value.get('enabled') is True else None

def prepare(config, index, seed, *, limit=5001, fixed=None):
    selections, diagnostics = assignments(config, index, seed, limit=limit, fixed=fixed)
    return [SelectedIndex(index, selection) for selection in selections], diagnostics

def ensure_participation(config, used):
    missing = sorted(set(config.get('entries', {})) - set(used))
    if missing:
        raise RelationshipError('scope', 'Participating entries were not resolved in this prompt: ' + ', '.join(missing) + '. Use every participating wildcard or select a narrower rule set.')

def reject_unsafe_runtime(config, runtime, prepared=False):
    if prepared: raise RelationshipError('prepared', 'Clear prepared variations before enabling a relationship rule set; literal prepared outputs cannot be reselected.')

def field_constraints(config, index, payload, seed, namespace='', initial_variables=None):
    """Resolve existing policies on isolated counters/held state, then constrain picks.

    Policy decisions take priority: relationships can select compatible neighbors,
    but never silently unlock or replace a Vary/Follow decision.
    """
    if not payload: return {}
    import re
    from .workspace_generation import WorkspaceGeneration
    preview = WorkspaceGeneration(index.preview_view(), payload, namespace, preview=True, initial_variables=initial_variables)
    for channel in ('positive', 'negative'):
        preview.resolve(payload[channel], seed + (1000 if channel == 'negative' else 0), channel=channel)
    fixed = {}
    for field in payload['fields']:
        if field.get('state') not in ('lock', 'vary', 'follow'): continue
        match = re.fullmatch(r'__[+\-*%~@]?([A-Za-z0-9_\-/]+)__', field['source'].strip())
        if not match or match[1] not in config['entries']: continue
        path = match[1]; text = preview.values.get(field['id'])
        choices = choice_catalog(index.get_lines(path))['choices']
        matching = [c['id'] for c in choices if c['text'] == text]
        if len(matching) != 1: raise RelationshipError('field-conflict', 'Field policy cannot map unambiguously to a participating choice: ' + path)
        if path in fixed and fixed[path] != matching[0]: raise RelationshipError('field-conflict', 'Fields choose conflicting values for ' + path)
        fixed[path] = matching[0]
    return fixed
