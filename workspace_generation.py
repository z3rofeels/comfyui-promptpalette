"""Generation policies for the existing Fields workspace, using WildcardResolver.

The frontend supplies a bounded projection of its canonical fields and spans.
Preview uses cloned counters/held choices; it cannot consume generation state.
"""
from collections import OrderedDict
from copy import deepcopy
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


def join_boundary(left, separator, right):
    if not left or not right:
        return ""
    if separator == ", ":
        return " " if re.search(r",\s*$", left) or re.search(r"^\s*,", right) else ", "
    if separator == ". ":
        return " " if re.search(r"\.\s*$", left) or re.search(r"^\s*\.", right) else ". "
    if separator == " " and (re.search(r"\s$", left) or re.search(r"^\s", right)):
        return ""
    if separator == "\n" and (re.search(r"\n$", left) or re.search(r"^\n", right)):
        return ""
    return separator


def combine_field_input(widget_val, incoming_val, placement="before", separator=", "):
    w = (widget_val or "").strip()
    inc = (incoming_val or "").strip()
    if not inc:
        return w
    if not w:
        return inc
    sep = ", " if separator is None else separator
    if placement == "after":
        return w + join_boundary(w, sep, inc) + inc
    return inc + join_boundary(inc, sep, w) + w


def read_runtime(value, text=None, has_field_io=False):
    if not value: return None
    if isinstance(value, str):
        if len(value) > 4_000_000: raise ValueError('Workspace generation data is too large.')
        value = json.loads(value)
    if not isinstance(value, dict) or value.get('schema') != SCHEMA: raise ValueError('Invalid workspace generation data.')
    if not isinstance(value.get('fields'), list) or len(value['fields']) > 32: raise ValueError('Invalid generation fields.')
    for channel in ('positive', 'negative'):
        source = value.get(channel)
        if not isinstance(source, str) or len(source) > 1_000_000: raise ValueError('Invalid generation source.')
    # A connected text input or manual compiled edit wins over a stale projection unless field I/O is active.
    if text is not None and not has_field_io and value['positive'] != text: return None
    ids, ends = set(), {'positive': 0, 'negative': 0}
    for field in value['fields']:
        if not isinstance(field, dict): raise ValueError('Invalid generation field.')
        ident, channel = field.get('id'), field.get('channel')
        if not isinstance(ident, str) or not ident or len(ident) > 160 or ident in ids: raise ValueError('Invalid generation field identity.')
        ids.add(ident)
        if channel not in ends: raise ValueError('Invalid generation channel.')
        start, end = field.get('start'), field.get('end')
        if type(start) is not int or type(end) is not int or not ends[channel] <= start <= end <= len(value[channel]): raise ValueError('Invalid generation field span.')
        if start == end and not (field.get('hasInput') or field.get('hasOutput')): raise ValueError('Empty spans require a field socket.')
        ends[channel] = end
        if field.get('state') not in (None, 'lock', 'vary', 'follow'): raise ValueError('Invalid generation field mode.')
        if field.get('variation', 'cycle') not in ('cycle', 'shuffle', 'seed', 'syntax'): raise ValueError('Invalid generation variation method.')
        if not isinstance(field.get('source'), str) or len(field['source']) > 100_000: raise ValueError('Invalid generation choices.')
        if not isinstance(field.get('dependsOn', []), list) or len(field.get('dependsOn', [])) > 32: raise ValueError('Invalid Follow sources.')
        if field.get('hasInput') is not None and not isinstance(field.get('hasInput'), bool): raise ValueError('Invalid field input setting.')
        if field.get('hasOutput') is not None and not isinstance(field.get('hasOutput'), bool): raise ValueError('Invalid field output setting.')
        if field.get('inputPlacement') is not None and field.get('inputPlacement') not in ('before', 'after'): raise ValueError('Invalid field input placement.')
        if field.get('separator') is not None and (not isinstance(field['separator'], str) or len(field['separator']) > 1024): raise ValueError('Invalid field input separator.')
    layout = value.get('layout')
    if layout is not None:
        if not isinstance(layout, dict) or not isinstance(layout.get('segments'), list) or len(layout['segments']) > 256: raise ValueError('Invalid generation layout.')
        if not isinstance(layout.get('separator'), str) or len(layout['separator']) > 1024: raise ValueError('Invalid layout separator.')
        if not isinstance(layout.get('negative'), str) or len(layout['negative']) > 1_000_000: raise ValueError('Invalid layout negative text.')
        if not isinstance(layout.get('separators'), dict) or len(layout['separators']) > 32: raise ValueError('Invalid field separators.')
        if any(sep is not None and (not isinstance(sep, str) or len(sep) > 1024) for sep in layout['separators'].values()): raise ValueError('Invalid field separator.')
        edges = layout.get('edges', {})
        if not isinstance(edges, dict): raise ValueError('Invalid layout edges.')
        for channel, pair in edges.items():
            if channel not in ('positive', 'negative') or not isinstance(pair, list) or len(pair) != 2 or any(ident is not None and not isinstance(ident, str) for ident in pair): raise ValueError('Invalid layout edge.')
        referenced = set()
        for segment in layout['segments']:
            if not isinstance(segment, dict): raise ValueError('Invalid layout segment.')
            if segment.get('type') == 'field':
                ident = segment.get('id')
                if not isinstance(ident, str) or ident in referenced: raise ValueError('Invalid layout field.')
                referenced.add(ident)
            elif segment.get('type') != 'static' or not isinstance(segment.get('text'), str) or len(segment['text']) > 1_000_000: raise ValueError('Invalid layout text.')
        if not ids.issubset(referenced): raise ValueError('Missing layout field.')
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


def active_runtime(value, text=None, has_field_io=False):
    runtime = read_runtime(value, text, has_field_io=has_field_io)
    if not runtime: return None
    if has_field_io or any(f.get('hasInput') or f.get('hasOutput') for f in runtime.get('fields', [])):
        return runtime
    dynamic = re.compile(r'__[+\-*%~@]?[A-Za-z0-9_\-/*]+|\$\{|\{[^{}]*\||\[(?:if|elif|switch)\b', re.I)
    return runtime if any(f.get('state') in ('vary', 'follow') or f.get('state') == 'lock' and dynamic.search(f['source']) for f in runtime['fields']) else None


def runtime_changes(value, text=None):
    runtime = read_runtime(value, text)
    return bool(runtime and any(f.get('state') == 'follow' or f.get('state') == 'vary' and f.get('variation', 'cycle') != 'seed' for f in runtime['fields']))


class WorkspaceGeneration:
    def __init__(self, index, payload, namespace='', *, preview=False, initial_variables=None, field_inputs=None):
        self.index, self.payload, self.preview = index, deepcopy(read_runtime(payload)), preview
        self.original_sources = {channel: self.payload[channel] for channel in ('positive', 'negative')} if self.payload else {}
        self.namespace = str((self.payload or {}).get('namespace') or namespace)
        self.initial_variables = WildcardResolver.parse_variables_input(initial_variables)
        self.variables = dict(self.initial_variables)
        self.branch_selections = []
        self.values, self.spans, self.chosen, self.used = {}, {}, {}, set()
        with _GUARD: self.held = dict(_HELD) if preview else _HELD
        self.fields = self.payload['fields'] if self.payload else []
        # Parked wires belong to other drafts or disabled field inputs. Exclude
        # them from every projection/selection path, not only concatenation.
        self.field_inputs = {f['id']: field_inputs[f['id']] for f in self.fields
                             if f.get('hasInput') and f['id'] in (field_inputs or {})}
        authored = {f['id']: self.payload[f['channel']][f['start']:f['end']] for f in self.fields}
        if self.field_inputs and self.fields:
            for field in self.fields:
                fid = field['id']
                if fid in self.field_inputs and self.field_inputs[fid] is not None:
                    inc_val = str(self.field_inputs[fid]).strip()
                    if inc_val:
                        placement = field.get('inputPlacement', 'before')
                        sep = field.get('separator', (self.payload or {}).get('separator', ', '))
                        field['source'] = combine_field_input(field['source'], inc_val, placement=placement, separator=sep)
                        authored[fid] = field['source']
        if self.field_inputs and self.payload.get('layout'):
            self._rebuild_layout(authored)
        self.lookup = {f['id']: f for f in self.fields}
        self.mark = 'PPGEN' + hashlib.sha256(json.dumps(self.payload, sort_keys=True).encode()).hexdigest()[:24]

    def _rebuild_layout(self, values):
        """Mirror compileWorkspace's literal and separator rules for runtime inputs."""
        layout = self.payload['layout']
        lookup = {f['id']: f for f in self.fields}
        for channel in ('positive', 'negative'):
            text, pending, has_pending = '', '', False
            ordered = [lookup[s['id']] for s in layout['segments'] if s['type'] == 'field' and s['id'] in lookup and lookup[s['id']]['channel'] == channel]
            edges = layout.get('edges', {}).get(channel, [ordered[0]['id'] if ordered else None, ordered[-1]['id'] if ordered else None])
            first = bool(values.get(edges[0], '').strip())
            last = bool(values.get(edges[1], '').strip())
            for segment in layout['segments']:
                if segment['type'] == 'static':
                    if segment.get('channel', 'positive') != channel: continue
                    if segment.get('boundary'):
                        if not has_pending: pending = segment['text']
                        has_pending = True
                    else:
                        text += pending + segment['text']; pending, has_pending = '', False
                    continue
                field = lookup.get(segment['id'])
                if not field or field['channel'] != channel: continue
                value = values[field['id']]
                if value.strip():
                    separator = layout['separators'].get(field['id'])
                    if separator is None:
                        separator = (layout['separator'] if layout.get('overrideBoundaries') else pending) if has_pending else layout['separator'] if segment.get('join') or channel == 'negative' else ''
                    text += pending if not text and has_pending and first else join_boundary(text, separator, value)
                field['start'], field['end'] = len(text), len(text) + (len(value) if value.strip() else 0)
                if value.strip(): text += value; pending, has_pending = '', False
            if has_pending and last: text += pending
            if channel == 'negative' and layout['negative']:
                prefix = layout['negative'] + ('\n' if text else '')
                for field in ordered: field['start'] += len(prefix); field['end'] += len(prefix)
                text = prefix + text
            if len(text) > 1_000_000: raise ValueError('Compiled workspace is too large.')
            self.payload[channel] = text

    def _key(self, field):
        identity = f'{self.namespace}:{field["id"]}:{field["source"]}:{field.get("variation", "cycle")}:{field.get("state")}:{field.get("dependsOn", [])}'
        return hashlib.sha256(identity.encode()).hexdigest()

    def _resolve(self, text, seed, mode, *, preview=False):
        index = self.index.preview_view() if preview and hasattr(self.index, 'preview_view') else self.index
        resolver = WildcardResolver(index, initial_variables=self.variables)
        result = '\n'.join(resolver.resolve_lines(text, seed=seed)) if mode == 'line by line' else resolver.resolve(text, seed=seed)
        if not preview:
            self.variables.update(resolver.export_variables())
            self.branch_selections.extend(resolver.branch_selections)
        return result, resolver.used_names

    def _pick(self, field, seed, trigger=None):
        key, source = self._key(field), field['source']
        previous = self.held.get(key)
        if field.get('state') == 'follow' and previous and previous[0] == trigger: return previous[1]
        if field.get('state') == 'lock': return previous[1] if previous else source
        method = field.get('variation', 'cycle')
        match, wildcard = BRACE_RE.fullmatch(source.strip()), WILDCARD_RE.fullmatch(source.strip())
        choices = None
        constrained = None
        if match:
            inner = match[1]
            if inner[:1] in '+-*~@%': inner = inner[1:]
            if not re.match(r'^\d+(?:-\d+)?\$\$', inner):
                choices = [WEIGHT_RE.sub(lambda m: m[2], option).strip() for option in WildcardResolver(self.index)._split_top_level(inner)]
        elif wildcard:
            self.used.add(wildcard[2]); choices = self.index.get_lines(wildcard[2])
            selected = getattr(self.index, 'selected', {}).get(wildcard[2])
            if selected and method != 'syntax':
                # Relationships fix the chosen identity, while the original
                # field policy still advances its own counter/held state.
                constrained = selected['text']
                choices = self.index.original.get_lines(wildcard[2])
        if field.get('state') == 'vary' and (not choices or len(choices) < 2): return source
        if constrained is not None:
            if method == 'cycle' and choices and len(choices) > 1:
                self.index.next_sequential_index('workspace:' + key, len(choices), 1)
            chosen = constrained
        elif field.get('state') != 'lock' and method != 'syntax' and choices and len(choices) > 1:
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
        if field.get('state') in ('follow', 'lock') or method == 'shuffle':
            self.held[key] = (trigger, chosen)
            if not self.preview:
                self.held.move_to_end(key)
                while len(self.held) > _MAX_HELD: self.held.popitem(last=False)
        return chosen

    def _project(self, channel, values):
        source = self.payload[channel]
        for field in sorted((f for f in self.fields if f['channel'] == channel), key=lambda f: (f['start'], f['end']), reverse=True):
            ident = field['id']; at = self.fields.index(field)
            default_val = field['source'] if ident in self.field_inputs else source[field['start']:field['end']]
            value = values.get(ident, default_val)
            source = source[:field['start']] + f'{self.mark}{at}BEGIN' + value + f'{self.mark}{at}END' + source[field['end']:]
        return source

    def combinatorial_source(self, text):
        if self.payload and text == self.original_sources['positive']:
            return self._project('positive', {})
        return text

    def read_combinatorial(self, text):
        result, fields, _ = self._read('positive', text)
        return result, fields

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
        if self.payload and text == self.original_sources[channel]: text = self.payload[channel]
        if not self.payload or text != self.payload[channel]: return self._resolve(text, seed, mode)
        with _GUARD:
            selected = {}
            for field in self.fields:
                if field['channel'] != channel: continue
                if field['id'] in self.field_inputs and self.field_inputs[field['id']]:
                    selected[field['id']] = field['source']
                if field.get('state') in ('vary', 'lock') and not (field.get('state') == 'vary' and field.get('variation') == 'syntax'):
                    selected[field['id']] = self._pick(field, seed)
                elif field.get('state') == 'follow':
                    previous = self.held.get(self._key(field))
                    selected[field['id']] = previous[1] if previous else ''
            has_follow = any(f['channel'] == channel and f.get('state') == 'follow' for f in self.fields)
            has_lock = any(f['channel'] == channel and f.get('state') == 'lock' for f in self.fields)
            if has_follow or has_lock:
                # A cloned first pass captures resolved dependency values without advancing manual sequences.
                baseline, _ = self._resolve(self._project(channel, selected), seed, mode, preview=True)
                _, captured, _ = self._read(channel, baseline)
                captured.update({key: value for key, value in self.values.items() if key not in captured})
                for field in self.fields:
                    if field['channel'] == channel and field.get('state') == 'lock' and field['id'] in captured:
                        selected[field['id']] = captured[field['id']]
                        self.held[self._key(field)] = (None, captured[field['id']])
                        if not self.preview:
                            self.held.move_to_end(self._key(field))
                            while len(self.held) > _MAX_HELD: self.held.popitem(last=False)
                pending = {f['id'] for f in self.fields if f['channel'] == channel and f.get('state') == 'follow'}
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
