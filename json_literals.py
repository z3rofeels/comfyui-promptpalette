"""Literal JSON objects embedded in prompts, including MOSS layout prompts.

Only complete, valid objects are protected. Ordinary {a|b}, variables and
wildcards keep their grammar. Scan balanced candidates once, then validate them.
"""
import json
import re
import uuid

_START = re.compile(r'\{\s*(?:"|\})')


def _invalid_constant(value):
    raise ValueError('Not JSON: ' + value)


def json_object_spans(text):
    spans, cursor = [], 0
    while match := _START.search(text, cursor):
        start = match.start()
        if start and text[start - 1] == '$':
            cursor = start + 1
            continue
        depth, quoted, escaped, end = 0, False, False, None
        for at in range(start, len(text)):
            char = text[at]
            if quoted:
                if escaped: escaped = False
                elif char == '\\': escaped = True
                elif char == '"': quoted = False
            elif char == '"': quoted = True
            elif char == '{': depth += 1
            elif char == '}':
                depth -= 1
                if depth == 0:
                    end = at + 1
                    break
        if end is None:
            break
        cursor = end
        try:
            value = json.loads(text[start:end], parse_constant=_invalid_constant)
        except (ValueError, RecursionError):
            continue
        if isinstance(value, dict): spans.append((start, end))
    return spans


class JsonLiterals:
    def __init__(self):
        self.prefix = 'PPJSON' + uuid.uuid4().hex + 'X'
        self.values = {}

    def protect(self, text):
        for start, end in reversed(json_object_spans(text)):
            token = self.prefix + str(len(self.values)) + 'END'
            self.values[token] = text[start:end]
            text = text[:start] + token + text[end:]
        return text

    def restore(self, text):
        if not self.values: return text
        pattern = re.compile(re.escape(self.prefix) + r'\d+END')
        return pattern.sub(lambda match: self.values.get(match[0], match[0]), text)
