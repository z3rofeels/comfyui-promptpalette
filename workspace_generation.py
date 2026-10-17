"""Generation policies for the existing Fields workspace, using WildcardResolver.

The frontend supplies a bounded projection of its canonical fields and spans.
Preview uses cloned counters/held choices; it cannot consume generation state.
"""
from collections import OrderedDict
import hashlib
import json
import random
import re
import threading

from .wildcard_resolver import WildcardResolver, WILDCARD_RE, BRACE_RE, WEIGHT_RE

SCHEMA = 'prompt-palette.workspace-generation.v1'
_GUARD = threading.RLock()
_HELD = OrderedDict()
_MAX_HELD = 2048


def read_runtime(value, text=None):
    if not value: return None
    if isinstance(value, str):
        if len(value) > 4_000_000: raise ValueError('Workspace generation data is too large.')
        value = json.loads(value)
    if not isinstance(value, dict) or value.get('schema') != SCHEMA: raise ValueError('Invalid workspace generation data.')
    if not isinstance(value.get('fields'), list) or len(value['fields']) > 32: raise ValueError('Invalid generation fields.')
    for channel in ('positive', 'negative'):
        source = value.get(channel)
        if not isinstance(source, str) or len(source) > 1_000_000: raise ValueError('Invalid generation source.')
    # A connected text input or manual compiled edit wins over a stale projection.
    if text is not None and value['positive'] != text: return None
    ids, ends = set(), {'positive': 0, 'negative': 0}
    for field in value['fields']:
        ident, channel = field.get('id'), field.get('channel')
        if not isinstance(ident, str) or not ident or len(ident) > 160 or ident in ids: raise ValueError('Invalid generation field identity.')
        ids.add(ident)
        if channel not in ends: raise ValueError('Invalid generation channel.')
        start, end = field.get('start'), field.get('end')
        if type(start) is not int or type(end) is not int or not ends[channel] <= start < end <= len(value[channel]): raise ValueError('Invalid generation field span.')
        ends[channel] = end
        if field.get('state') not in (None, 'lock', 'vary', 'follow'): raise ValueError('Invalid generation field mode.')
        if field.get('variation', 'cycle') not in ('cycle', 'shuffle', 'seed', 'syntax'): raise ValueError('Invalid generation variation method.')
        if not isinstance(field.get('source'), str) or len(field['source']) > 100_000: raise ValueError('Invalid generation choices.')
        if not isinstance(field.get('dependsOn', []), list) or len(field.get('dependsOn', [])) > 32: raise ValueError('Invalid Follow sources.')
    lookup = {f['id']: f for f in value['fields']}
    visiting, visited = set(), set()
    def visit(ident):
        if ident in visiting: raise ValueError('Follow sources cannot form a cycle.')
        if ident in visited: return
        visiting.add(ident)
        for dep in lookup[ident].get('dependsOn', []):
            if not isinstance(dep, str) or dep not in ids or dep == ident: raise ValueError('Enable every chosen Follow source.')
            visit(dep)
        visiting.remove(ident); visited.add(ident)
    for ident in ids: visit(ident)
    return value


def active_runtime(value, text=None):
    runtime = read_runtime(value, text)
    if not runtime: return None
    dynamic = re.compile(r'__[+\-*%~@]?[A-Za-z0-9_\-/*]+|\$\{|\{[^{}]*\||\[(?:if|elif|switch)\b', re.I)
    return runtime if any(f['state'] in ('vary', 'follow') or f['state'] == 'lock' and dynamic.search(f['source']) for f in runtime['fields']) else None


def runtime_changes(value, text=None):
    runtime = read_runtime(value, text)
    return bool(runtime and any(f['state'] == 'follow' or f['state'] == 'vary' and f.get('variation', 'cycle') != 'seed' for f in runtime['fields']))


class WorkspaceGeneration:
    def __init__(self, index, payload, namespace='', *, preview=False):
        self.index, self.payload, self.preview = index, read_runtime(payload), preview
        self.namespace = str((self.payload or {}).get('namespace') or namespace)
        self.values, self.spans, self.chosen, self.used = {}, {}, {}, set()
        with _GUARD: self.held = dict(_HELD) if preview else _HELD
        self.fields = self.payload['fields'] if self.payload else []
        self.lookup = {f['id']: f for f in self.fields}
        self.mark = 'PPGEN' + hashlib.sha256(json.dumps(self.payload, sort_keys=True).encode()).hexdigest()[:24]

    def _key(self, field):
        identity = f'{self.namespace}:{field["id"]}:{field["source"]}:{field.get("variation", "cycle")}:{field["state"]}:{field.get("dependsOn", [])}'
        return hashlib.sha256(identity.encode()).hexdigest()

    def _resolve(self, text, seed, mode, *, preview=False):
        index = self.index.preview_view() if preview and hasattr(self.index, 'preview_view') else self.index
        resolver = WildcardResolver(index)
        result = '\n'.join(resolver.resolve_lines(text, seed=seed)) if mode == 'line by line' else resolver.resolve(text, seed=seed)
        return result, resolver.used_names

    def _pick(self, field, seed, trigger=None):
        key, source = self._key(field), field['source']
        previous = self.held.get(key)
        if field['state'] == 'follow' and previous and previous[0] == trigger: return previous[1]
        if field['state'] == 'lock': return previous[1] if previous else source
        method = field.get('variation', 'cycle')
        match, wildcard = BRACE_RE.fullmatch(source.strip()), WILDCARD_RE.fullmatch(source.strip())
        choices = None
        if match:
            inner = match[1]
            if inner[:1] in '+-*~@%': inner = inner[1:]
            if not re.match(r'^\d+(?:-\d+)?\$\$', inner):
                choices = [WEIGHT_RE.sub(lambda m: m[2], option).strip() for option in WildcardResolver(self.index)._split_top_level(inner)]
        elif wildcard:
            self.used.add(wildcard[2]); choices = self.index.get_lines(wildcard[2])
        if field['state'] == 'vary' and (not choices or len(choices) < 2): return source
        if field['state'] != 'lock' and method != 'syntax' and choices and len(choices) > 1:
            if method == 'cycle':
                chosen = choices[self.index.next_sequential_index('workspace:' + key, len(choices), 1)]
            elif method == 'shuffle':
                options = [choice for choice in choices if not previous or choice != previous[1]] or choices
                chosen = random.SystemRandom().choice(options)
            else:
                # Preserve canonical weighted seed selection, instead of inventing another seeded picker.
                seed_source = '{' + inner + '}' if match else '__' + wildcard[2] + '__' if wildcard else source
                chosen, _ = self._resolve(seed_source, seed, 'entire text as one', preview=True)
        else:
            chosen, _ = self._resolve(source, seed, 'entire text as one')
        if field['state'] in ('follow', 'lock') or method == 'shuffle':
            self.held[key] = (trigger, chosen)
            if not self.preview:
                self.held.move_to_end(key)
                while len(self.held) > _MAX_HELD: self.held.popitem(last=False)
        return chosen

    def _project(self, channel, values):
        source = self.payload[channel]
        for field in sorted((f for f in self.fields if f['channel'] == channel), key=lambda f: f['start'], reverse=True):
            ident = field['id']; at = self.fields.index(field)
            value = values.get(ident, source[field['start']:field['end']])
            source = source[:field['start']] + f'{self.mark}{at}BEGIN' + value + f'{self.mark}{at}END' + source[field['end']:]
        return source

    def _read(self, channel, text):
        fields, spans, clean, cursor = {}, {}, '', 0
        markers = []
        for at, field in enumerate(self.fields):
            if field['channel'] != channel: continue
            left, right = f'{self.mark}{at}BEGIN', f'{self.mark}{at}END'
            start, end = text.find(left), text.find(right)
            if start < 0 or end < start: raise ValueError('A generation field crosses an inactive conditional or comment. Keep complete syntax within its field.')
            markers.append((start, end, left, right, field['id']))
        for start, end, left, right, ident in sorted(markers):
            clean += text[cursor:start]
            value = text[start + len(left):end]; fields[ident] = value
            spans[ident] = {'start': len(clean), 'end': len(clean) + len(value), 'channel': channel}
            clean += value; cursor = end + len(right)
        clean += text[cursor:]
        leading = len(clean) - len(clean.lstrip())
        clean = clean.strip()
        for span in spans.values():
            span['start'] = max(0, span['start'] - leading); span['end'] = min(len(clean), max(0, span['end'] - leading))
        return clean, fields, spans

    def resolve(self, text, seed, mode='entire text as one', channel='positive'):
        if not self.payload or text != self.payload[channel]: return self._resolve(text, seed, mode)
        with _GUARD:
            selected = {}
            for field in self.fields:
                if field['channel'] != channel: continue
                if field['state'] in ('vary', 'lock') and not (field['state'] == 'vary' and field.get('variation') == 'syntax'):
                    selected[field['id']] = self._pick(field, seed)
                elif field['state'] == 'follow':
                    previous = self.held.get(self._key(field))
                    selected[field['id']] = previous[1] if previous else ''
            # A cloned first pass captures resolved dependency values without advancing manual sequences.
            baseline, _ = self._resolve(self._project(channel, selected), seed, mode, preview=True)
            _, captured, _ = self._read(channel, baseline)
            captured.update({key: value for key, value in self.values.items() if key not in captured})
            for field in self.fields:
                if field['channel'] == channel and field['state'] == 'lock' and field['id'] in captured:
                    selected[field['id']] = captured[field['id']]
                    self.held[self._key(field)] = (None, captured[field['id']])
                    if not self.preview:
                        self.held.move_to_end(self._key(field))
                        while len(self.held) > _MAX_HELD: self.held.popitem(last=False)
            pending = {f['id'] for f in self.fields if f['channel'] == channel and f['state'] == 'follow'}
            while pending:
                ready = [ident for ident in pending if not pending.intersection(self.lookup[ident].get('dependsOn', []))]
                if not ready: raise ValueError('Follow sources cannot form a cycle.')
                for ident in ready:
                    field = self.lookup[ident]; deps = field.get('dependsOn', [])
                    if not deps: raise ValueError('Choose a source field for Follow.')
                    if any(dep not in captured for dep in deps): raise ValueError('Follow sources must resolve before this prompt channel; positive fields cannot follow negative fields.')
                    trigger = tuple(captured[dep] for dep in deps)
                    selected[ident] = self._pick(field, seed, trigger)
                    captured[ident], _ = self._resolve(selected[ident], seed, 'entire text as one', preview=True)
                    pending.remove(ident)
            marked, used = self._resolve(self._project(channel, selected), seed, mode)
            result, fields, spans = self._read(channel, marked)
            self.values.update(fields); self.spans.update(spans)
            return result, sorted(set(used) | self.used)
