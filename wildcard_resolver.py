

import re
import random
import itertools

WILDCARD_RE = re.compile(r"__([+\-*%~@]?)([A-Za-z0-9_\-\/*]+)__")
PARAM_WILDCARD_RE = re.compile(r"__([A-Za-z0-9_\-\/]+)\(([^()]*)\)__")
BRACE_RE = re.compile(r"\{([^{}]*)\}")
QUANT_RE = re.compile(r"^(\d+)#(.+)$")
WEIGHT_RE = re.compile(r"^\s*(\d+)::\s*(.*)$", re.DOTALL)
VAR_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

COMBO_SCAN_RE = re.compile(r"(__%[A-Za-z0-9_\-\/]+__)|(\{%[^{}]*\})")

SINGLE_PICK_MODES = ("+", "-", "*", "~", "@", "%")

_ZW = "\u2060"

MAX_PASSES = 25
MAX_RESOLVED_CHARS = 1_000_000
MAX_QUANTIFIER_REPEAT = 10_000
MAX_COMBINATORIAL_DEPTH = 512
MAX_NESTED_RESOLUTION_DEPTH = 128
MAX_COMBINATORIAL_TOTAL_CHARS = 16_000_000
MAX_WEIGHT_VALUE = 1_000_000_000
MAX_NUMERIC_TOKEN_DIGITS = 12

class WildcardResolver:

    MAX_COMBINATORIAL_PROMPTS = 5000

    @staticmethod
    def _bounded_decimal(token, label, maximum):
        token = str(token)
        if len(token) > MAX_NUMERIC_TOKEN_DIGITS:
            raise ValueError(f"{label} is too large")
        try:
            value = int(token)
        except ValueError as exc:
            raise ValueError(f"invalid {label}") from exc
        if value > maximum:
            raise ValueError(f"{label} exceeds the {maximum:,} safety limit")
        return value

    @staticmethod
    def _check_size(text):
        if len(text) > MAX_RESOLVED_CHARS:
            raise ValueError(
                f"prompt expansion exceeded the {MAX_RESOLVED_CHARS:,}-character safety limit"
            )
        return text

    @staticmethod
    def _check_depth(depth):
        if depth > MAX_COMBINATORIAL_DEPTH:
            raise ValueError(
                f"prompt expansion exceeded the {MAX_COMBINATORIAL_DEPTH}-step nesting safety limit"
            )

    def __init__(self, index):

        self.index = index
        self.used_names = []
        self.variables = {}
        self.last_generation_truncated = False
        self._param_stack = []
        self._variable_stack = []
        self._generation_chars = 0

    def strip_comments(self, text):
        lines = text.split("\n")
        return "\n".join(l for l in lines if not l.lstrip().startswith("#"))

    def _pick_wildcard_line(self, name, mode, rng):
        lines = self.index.get_lines(name)
        if not lines:
            return f"__{mode}{name}__"
        self.used_names.append(name)
        if mode in ("+", "@"):
            i = self.index.next_sequential_index(name, len(lines), 1)
            return lines[i]
        if mode == "-":
            i = self.index.next_sequential_index(name, len(lines), -1)
            return lines[i]
        if mode in ("*", "~"):
            return random.choice(lines)

        return rng.choice(lines)

    def _prepare_combinatorial(self, text):

        groups = []
        for m in COMBO_SCAN_RE.finditer(text):
            whole = m.group(0)
            if whole.startswith("__"):
                name = whole[3:-2]
                lines = self.index.get_lines(name)
                if not lines:
                    continue
                groups.append((whole, len(lines), "wc", (name, lines)))
            else:
                inner = whole[2:-1]
                if re.match(r"^\d+(?:-\d+)?\$\$", inner):
                    continue
                options = [
                    (WEIGHT_RE.match(o).group(2) if WEIGHT_RE.match(o) else o)
                    for o in self._split_top_level(inner)
                ]
                if len(options) < 2:
                    continue
                groups.append((whole, len(options), "br", options))

        if not groups:
            return {}

        sizes = [g[1] for g in groups]
        total = 1
        for s in sizes:
            total *= s

        key = "combo::" + "|".join(f"{g[0]}:{g[1]}" for g in groups)
        combo_index = self.index.next_combinatorial_index(key, total)

        idx = [0] * len(groups)
        remaining = combo_index
        for pos in range(len(groups) - 1, -1, -1):
            idx[pos] = remaining % sizes[pos]
            remaining //= sizes[pos]

        combo_map = {}
        for (whole, _size, kind, payload), i in zip(groups, idx):
            if kind == "wc":
                name, lines = payload
                combo_map[whole] = lines[i]
                self.used_names.append(name)
            else:
                combo_map[whole] = payload[i].strip()
        return combo_map

    def _resolve_wildcards(self, text, rng, combo_map=None):
        combo_map = combo_map or {}

        def repl(m):
            whole = m.group(0)
            if whole in combo_map:
                return combo_map[whole]
            mode, name = m.group(1), m.group(2)
            return self._pick_wildcard_line(name, mode, rng)
        prev = None
        out = text
        for _ in range(MAX_PASSES):
            if out == prev:
                break
            prev = out
            out = self._check_size(WILDCARD_RE.sub(repl, out))
        return out

    def _resolve_param_wildcards(self, text, rng, combo_map=None, depth=0):

        def repl(m):
            name, argstr = m.group(1), m.group(2)
            entry = self.index.get_entry(name)
            if not entry:
                return m.group(0)
            template = "\n".join(entry["lines"])

            args = {}
            for part in argstr.split(","):
                part = part.strip()
                if not part or "=" not in part:
                    continue
                k, _, v = part.partition("=")
                k = k.strip()
                if VAR_NAME_RE.match(k):
                    args[k] = v.strip()

            if name in self._param_stack:
                chain = " -> ".join([*self._param_stack, name])
                raise ValueError(f"recursive parameter wildcard: {chain}")
            saved = {k: self.variables.get(k) for k in args}
            for k, v in args.items():
                self.variables[k] = ("resolved", v)
            self._param_stack.append(name)
            try:
                resolved = self._run_passes(template, rng, combo_map, depth + 1)
            finally:
                self._param_stack.pop()
                for k, old in saved.items():
                    if old is None:
                        self.variables.pop(k, None)
                    else:
                        self.variables[k] = old
            return resolved

        prev = None
        out = text
        for _ in range(MAX_PASSES):
            if out == prev:
                break
            prev = out
            out = self._check_size(PARAM_WILDCARD_RE.sub(repl, out))
        return out

    def _find_dollar_spans(self, text):

        spans = []
        i = 0
        n = len(text)
        while i < n:
            if text[i] == "$" and i + 1 < n and text[i + 1] == "{":
                depth = 1
                j = i + 2
                while j < n and depth > 0:
                    if text[j] == "{":
                        depth += 1
                    elif text[j] == "}":
                        depth -= 1
                    j += 1
                if depth == 0:
                    spans.append((i, j, text[i + 2:j - 1]))
                    i = j
                    continue
            i += 1
        return spans

    def _split_top_level_char(self, s, ch):

        depth = 0
        for idx, c in enumerate(s):
            if c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
            elif c == ch and depth == 0:
                return idx
        return -1

    def _resolve_variables(self, text, rng, combo_map=None, depth=0):

        spans = self._find_dollar_spans(text)
        if not spans:
            return text

        out = []
        last = 0
        for start, end, inner in spans:
            out.append(text[last:end])
            last = end

            eq = self._split_top_level_char(inner, "=")
            if eq != -1 and VAR_NAME_RE.match(inner[:eq].strip()):
                name = inner[:eq].strip()
                rest = inner[eq + 1:]
                immediate = rest.startswith("!")
                expr = rest[1:] if immediate else rest
                if immediate:
                    self.variables[name] = (
                        "resolved", self._run_passes(expr, rng, combo_map, depth + 1)
                    )
                else:
                    self.variables[name] = ("raw", expr)
                out[-1] = out[-1][: -(end - start)]
                continue

            colon = self._split_top_level_char(inner, ":")
            if colon != -1:
                name, default = inner[:colon].strip(), inner[colon + 1:]
            else:
                name, default = inner.strip(), None

            if name in self.variables:
                kind, val = self.variables[name]
                if kind == "resolved":
                    value = val
                else:
                    if name in self._variable_stack:
                        chain = " -> ".join([*self._variable_stack, name])
                        raise ValueError(f"recursive prompt variable: {chain}")
                    self._variable_stack.append(name)
                    try:
                        value = self._run_passes(val, rng, combo_map, depth + 1)
                    finally:
                        self._variable_stack.pop()
            elif default is not None:
                marker = f"default:{name}"
                if marker in self._variable_stack:
                    raise ValueError(f"recursive prompt-variable default: {name}")
                self._variable_stack.append(marker)
                try:
                    value = self._run_passes(default, rng, combo_map, depth + 1)
                finally:
                    self._variable_stack.pop()
            else:
                value = text[start:end]
            out[-1] = out[-1][: -(end - start)] + value

        out.append(text[last:])
        return "".join(out)

    def _split_top_level(self, s, sep="|"):
        parts, depth, cur = [], 0, ""
        for ch in s:
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
            if ch == sep and depth == 0:
                parts.append(cur)
                cur = ""
            else:
                cur += ch
        parts.append(cur)
        return parts

    def _multiselect_combos(self, options, min_count, max_count):

        seen = set()
        for count in range(min_count, max_count + 1):
            for combo in itertools.combinations(options, count):
                if combo in seen:
                    continue
                seen.add(combo)
                yield combo

    def _resolve_braces(self, text, rng, combo_map=None):
        combo_map = combo_map or {}

        def repl(m):
            whole = m.group(0)
            if whole in combo_map:
                return combo_map[whole]
            inner = m.group(1)
            mode = ""
            if inner.startswith("*") or inner.startswith("~"):
                mode, inner = inner[0], inner[1:]
            elif inner.startswith("+"):
                mode, inner = "+", inner[1:]
            elif inner.startswith("-"):
                mode, inner = "-", inner[1:]
            elif inner.startswith("@"):
                mode, inner = "@", inner[1:]
            elif inner.startswith("%"):

                mode, inner = "%", inner[1:]

            multi_match = re.match(r"^(\d+)(?:-(\d+))?\$\$(.*?)\$\$(.*)$", inner, re.DOTALL)
            if multi_match:
                lo = self._bounded_decimal(
                    multi_match.group(1), "multi-select minimum", MAX_QUANTIFIER_REPEAT
                )
                hi = self._bounded_decimal(
                    multi_match.group(2), "multi-select maximum", MAX_QUANTIFIER_REPEAT
                ) if multi_match.group(2) else lo
                joiner = multi_match.group(3)
                options = self._split_top_level(multi_match.group(4))
                options = [o for o in options]
                always_random = mode in ("*", "~")
                count = random.randint(lo, max(lo, hi)) if always_random else rng.randint(lo, max(lo, hi))
                count = min(count, len(options))
                chosen = random.sample(options, count) if always_random else rng.sample(options, count)
                return joiner.join(c.strip() for c in chosen)

            options = self._split_top_level(inner)
            weighted = []
            for opt in options:
                wm = WEIGHT_RE.match(opt)
                if wm:
                    weighted.append((
                        self._bounded_decimal(wm.group(1), "option weight", MAX_WEIGHT_VALUE),
                        wm.group(2),
                    ))
                else:
                    weighted.append((1, opt))

            key = "|".join(o for _, o in weighted)
            if mode in ("+", "@"):
                i = self.index.next_sequential_index("__brace__" + key, len(weighted), 1)
                return weighted[i][1].strip()
            if mode == "-":
                i = self.index.next_sequential_index("__brace__" + key, len(weighted), -1)
                return weighted[i][1].strip()

            picker = random if mode in ("*", "~") else rng
            total = sum(w for w, _ in weighted)
            r = picker.uniform(0, total)
            upto = 0
            for w, opt in weighted:
                upto += w
                if r <= upto:
                    return opt.strip()
            return weighted[-1][1].strip()

        prev = None
        out = text
        for _ in range(MAX_PASSES):
            if out == prev:
                break
            prev = out
            out = self._check_size(BRACE_RE.sub(repl, out))
        return out

    def _expand_quantifiers(self, text):

        def repl(m):
            n = self._bounded_decimal(
                m.group(1), "quantifier repeat", MAX_QUANTIFIER_REPEAT
            )
            token = m.group(2)
            expanded_length = len(token) * n + max(0, n - 1)
            if expanded_length > MAX_RESOLVED_CHARS:
                raise ValueError(
                    f"prompt expansion exceeded the {MAX_RESOLVED_CHARS:,}-character safety limit"
                )
            return "|".join([token] * n)

        return self._check_size(
            re.sub(r"(\d+)#([A-Za-z0-9_\-\/*+]+)", repl, self._check_size(text))
        )

    def _run_passes(self, text, rng, combo_map=None, depth=0):

        if depth > MAX_NESTED_RESOLUTION_DEPTH:
            raise ValueError(
                f"prompt expansion exceeded the {MAX_NESTED_RESOLUTION_DEPTH}-level nesting safety limit"
            )
        text = self._check_size(text)
        prev = None
        for _ in range(MAX_PASSES):
            if text == prev:
                break
            prev = text
            text = self._check_size(self._resolve_variables(text, rng, combo_map, depth))
            text = self._check_size(self._resolve_param_wildcards(text, rng, combo_map, depth))
            text = self._check_size(self._resolve_braces(text, rng, combo_map))
            text = self._check_size(self._resolve_wildcards(text, rng, combo_map))
        return text

    def resolve(self, text, seed=0):
        self.variables = {}
        self._param_stack = []
        self._variable_stack = []
        text = self.strip_comments(text)
        text = self._expand_quantifiers(text)
        rng = random.Random(seed)

        combo_map = self._prepare_combinatorial(text)
        text = self._run_passes(text, rng, combo_map)
        return text.strip()

    def resolve_lines(self, text, seed=0):

        results = []
        for i, line in enumerate(text.split("\n")):
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            results.append(self.resolve(line, seed=seed + i))
        return results

    def generate_combinatorial(self, text, seed=0, max_prompts=None):

        limit = min(max_prompts, self.MAX_COMBINATORIAL_PROMPTS) if max_prompts else self.MAX_COMBINATORIAL_PROMPTS
        limit = max(1, limit)

        text = self.strip_comments(text)
        text = self._expand_quantifiers(text)
        rng = random.Random(seed)

        self.last_generation_truncated = False
        self._generation_chars = 0
        self.variables = {}
        self._param_stack = []
        self._variable_stack = []
        results = []
        self._expand_combinatorial(text, {}, rng, limit, results)

        return [s.replace(_ZW, "").strip() for s, _env in results[:limit]]

    def count_combinatorial(self, text, seed=0, limit=20000):

        self.variables = {}
        self._param_stack = []
        self._variable_stack = []
        text = self.strip_comments(text)
        text = self._expand_quantifiers(text)
        rng = random.Random(seed)

        limit = max(1, limit)
        counter = [0]
        truncated = self._count_combinatorial(text, {}, rng, limit, counter)
        return counter[0], truncated

    def _count_combinatorial(self, s, env, rng, limit, counter, depth=0):

        self._check_depth(depth)
        self._check_size(s)
        if counter[0] >= limit:
            return True

        found = self._leftmost_combinatorial_group(s)
        if found is None:
            counter[0] += 1
            return False

        kind, obj = found
        branches = None

        if kind == "wc":
            m = obj
            start, end = m.start(), m.end()
            mode, name = m.group(1), m.group(2)
            if mode in SINGLE_PICK_MODES:
                if mode in ("+", "-", "@"):
                    lines = self.index.get_lines(name)
                    if lines:
                        self.used_names.append(name)
                        repl = rng.choice(lines)
                    else:
                        repl = f"__{mode}{name}__"
                else:
                    repl = self._pick_wildcard_line(name, mode, rng)
                branches = [(s[:start] + repl + s[end:], env)]
            else:
                lines = self.index.get_lines(name)
                if not lines:
                    neutralized = f"_{_ZW}_{name}_{_ZW}_"
                    branches = [(s[:start] + neutralized + s[end:], env)]
                else:
                    self.used_names.append(name)
                    branches = ((s[:start] + line + s[end:], env) for line in lines)

        elif kind == "brace":
            m = obj
            start, end = m.start(), m.end()
            inner = m.group(1)
            mode = ""
            if inner[:1] in ("*", "~", "+", "-", "@", "%"):
                mode, inner = inner[0], inner[1:]

            if mode in SINGLE_PICK_MODES:
                if mode in ("+", "-", "@"):
                    options = self._split_top_level(inner)
                    weighted = []
                    for opt in options:
                        wm = WEIGHT_RE.match(opt)
                        weighted.append(wm.group(2) if wm else opt)
                    picked = rng.choice(weighted).strip() if weighted else ""
                else:
                    picked = self._resolve_braces(m.group(0), rng, {})
                branches = [(s[:start] + picked + s[end:], env)]
            else:
                multi_match = re.match(r"^(\d+)(?:-(\d+))?\$\$(.*?)\$\$(.*)$", inner, re.DOTALL)
                if multi_match:
                    lo = self._bounded_decimal(
                        multi_match.group(1), "multi-select minimum", MAX_QUANTIFIER_REPEAT
                    )
                    hi = self._bounded_decimal(
                        multi_match.group(2), "multi-select maximum", MAX_QUANTIFIER_REPEAT
                    ) if multi_match.group(2) else lo
                    joiner = multi_match.group(3)
                    options = []
                    for opt in self._split_top_level(multi_match.group(4)):
                        wm = WEIGHT_RE.match(opt)
                        options.append((wm.group(2) if wm else opt).strip())
                    max_count = min(hi, len(options))
                    min_count = max(1, min(lo, max_count)) if max_count else 1
                    if min_count > max_count:
                        picked = self._resolve_braces(m.group(0), rng, {})
                        branches = [(s[:start] + picked + s[end:], env)]
                    else:
                        branches = (
                            (s[:start] + joiner.join(combo) + s[end:], env)
                            for combo in self._multiselect_combos(options, min_count, max_count)
                        )
                else:
                    branches = []
                    seen_vals = set()
                    for opt in self._split_top_level(inner):
                        wm = WEIGHT_RE.match(opt)
                        val = (wm.group(2) if wm else opt).strip()

                        if val in seen_vals:
                            continue
                        seen_vals.add(val)
                        branches.append((s[:start] + val + s[end:], env))

        elif kind == "param":
            m = obj
            start, end = m.start(), m.end()
            name, argstr = m.group(1), m.group(2)
            entry = self.index.get_entry(name)
            if not entry:
                neutralized = f"_{_ZW}_{name}({argstr})_{_ZW}_"
                branches = [(s[:start] + neutralized + s[end:], env)]
            else:
                template = "\n".join(entry["lines"])
                args = {}
                for part in argstr.split(","):
                    part = part.strip()
                    if part and "=" in part:
                        k, _, v = part.partition("=")
                        k = k.strip()
                        if VAR_NAME_RE.match(k):
                            args[k] = v.strip()
                call_env = dict(env)
                for k, v in args.items():
                    call_env[k] = ("resolved", v)

                sub_counter = [0]
                self._count_combinatorial(template, call_env, rng, limit, sub_counter, depth + 1)
                n = max(1, sub_counter[0])
                branches = [(s[:start] + s[end:], env) for _ in range(n)]

        else:
            start, end, inner = obj
            eq = self._split_top_level_char(inner, "=")
            if eq != -1 and VAR_NAME_RE.match(inner[:eq].strip()):
                name = inner[:eq].strip()
                rest = inner[eq + 1:]
                immediate = rest.startswith("!")
                expr = rest[1:] if immediate else rest
                if immediate:

                    sub_counter = [0]
                    self._count_combinatorial(expr, dict(env), rng, limit, sub_counter, depth + 1)
                    n = max(1, sub_counter[0])
                    new_env = dict(env)
                    new_env[name] = ("resolved", "")
                    branches = [(s[:start] + s[end:], new_env) for _ in range(n)]
                else:
                    new_env = dict(env)
                    new_env[name] = ("raw", expr)
                    branches = [(s[:start] + s[end:], new_env)]
            else:
                colon = self._split_top_level_char(inner, ":")
                if colon != -1:
                    name, default = inner[:colon].strip(), inner[colon + 1:]
                else:
                    name, default = inner.strip(), None

                if name in env:
                    _kind2, val = env[name]
                    branches = [(s[:start] + val + s[end:], env)]
                elif default is not None:
                    branches = [(s[:start] + default + s[end:], env)]
                else:
                    neutralized = f"${_ZW}{{{inner}{_ZW}}}"
                    branches = [(s[:start] + neutralized + s[end:], env)]

        for new_s, new_env in branches:
            if counter[0] >= limit:
                return True
            if self._count_combinatorial(new_s, new_env, rng, limit, counter, depth + 1):
                return True
        return False

    def _leftmost_combinatorial_group(self, s):

        candidates = []
        b = BRACE_RE.search(s)
        if b:
            candidates.append((b.start(), "brace", b))
        w = WILDCARD_RE.search(s)
        if w:
            candidates.append((w.start(), "wc", w))
        p = PARAM_WILDCARD_RE.search(s)
        if p:
            candidates.append((p.start(), "param", p))
        dollar_spans = self._find_dollar_spans(s)
        if dollar_spans:
            candidates.append((dollar_spans[0][0], "var", dollar_spans[0]))
        if not candidates:
            return None
        candidates.sort(key=lambda c: c[0])
        return candidates[0][1], candidates[0][2]

    def _expand_combinatorial(self, s, env, rng, limit, results, depth=0):

        self._check_depth(depth)
        self._check_size(s)
        if len(results) >= limit:
            return
        found = self._leftmost_combinatorial_group(s)
        if found is None:
            if self._generation_chars + len(s) > MAX_COMBINATORIAL_TOTAL_CHARS:
                self.last_generation_truncated = True
                return
            results.append((s, env))
            self._generation_chars += len(s)
            return

        kind, obj = found
        branches = None

        if kind == "wc":
            m = obj
            start, end = m.start(), m.end()
            mode, name = m.group(1), m.group(2)
            if mode in SINGLE_PICK_MODES:
                repl = self._pick_wildcard_line(name, mode, rng)
                branches = [(s[:start] + repl + s[end:], env)]
            else:
                lines = self.index.get_lines(name)
                if not lines:

                    neutralized = f"_{_ZW}_{name}_{_ZW}_"
                    branches = [(s[:start] + neutralized + s[end:], env)]
                else:
                    self.used_names.append(name)
                    branches = ((s[:start] + line + s[end:], env) for line in lines)

        elif kind == "brace":
            m = obj
            start, end = m.start(), m.end()
            inner = m.group(1)
            mode = ""
            if inner[:1] in ("*", "~", "+", "-", "@", "%"):
                mode, inner = inner[0], inner[1:]

            if mode in SINGLE_PICK_MODES:
                picked = BRACE_RE.sub(lambda mm: self._resolve_braces(mm.group(0), rng, {}), m.group(0))
                branches = [(s[:start] + picked + s[end:], env)]
            else:
                multi_match = re.match(r"^(\d+)(?:-(\d+))?\$\$(.*?)\$\$(.*)$", inner, re.DOTALL)
                if multi_match:
                    lo = self._bounded_decimal(
                        multi_match.group(1), "multi-select minimum", MAX_QUANTIFIER_REPEAT
                    )
                    hi = self._bounded_decimal(
                        multi_match.group(2), "multi-select maximum", MAX_QUANTIFIER_REPEAT
                    ) if multi_match.group(2) else lo
                    joiner = multi_match.group(3)
                    options = []
                    for opt in self._split_top_level(multi_match.group(4)):
                        wm = WEIGHT_RE.match(opt)
                        options.append((wm.group(2) if wm else opt).strip())
                    max_count = min(hi, len(options))
                    min_count = max(1, min(lo, max_count)) if max_count else 1
                    if min_count > max_count:

                        picked = self._resolve_braces(m.group(0), rng, {})
                        branches = [(s[:start] + picked + s[end:], env)]
                    else:

                        branches = (
                            (s[:start] + joiner.join(combo) + s[end:], env)
                            for combo in self._multiselect_combos(options, min_count, max_count)
                        )
                else:
                    branches = []
                    seen_vals = set()
                    for opt in self._split_top_level(inner):
                        wm = WEIGHT_RE.match(opt)
                        val = (wm.group(2) if wm else opt).strip()

                        if val in seen_vals:
                            continue
                        seen_vals.add(val)
                        branches.append((s[:start] + val + s[end:], env))

        elif kind == "param":
            m = obj
            start, end = m.start(), m.end()
            name, argstr = m.group(1), m.group(2)
            entry = self.index.get_entry(name)
            if not entry:
                neutralized = f"_{_ZW}_{name}({argstr})_{_ZW}_"
                branches = [(s[:start] + neutralized + s[end:], env)]
            else:
                template = "\n".join(entry["lines"])
                args = {}
                for part in argstr.split(","):
                    part = part.strip()
                    if part and "=" in part:
                        k, _, v = part.partition("=")
                        k = k.strip()
                        if VAR_NAME_RE.match(k):
                            args[k] = v.strip()
                call_env = dict(env)
                for k, v in args.items():
                    call_env[k] = ("resolved", v)

                sub_results = []
                self._expand_combinatorial(template, call_env, rng, limit, sub_results, depth + 1)
                branches = [(s[:start] + value + s[end:], env) for value, _sub_env in sub_results]
                if not branches:
                    branches = [(s[:start] + s[end:], env)]

        else:
            start, end, inner = obj
            eq = self._split_top_level_char(inner, "=")
            if eq != -1 and VAR_NAME_RE.match(inner[:eq].strip()):
                name = inner[:eq].strip()
                rest = inner[eq + 1:]
                immediate = rest.startswith("!")
                expr = rest[1:] if immediate else rest
                if immediate:

                    sub_results = []
                    self._expand_combinatorial(expr, dict(env), rng, limit, sub_results, depth + 1)
                    branches = []
                    for value, _sub_env in sub_results:
                        new_env = dict(env)
                        new_env[name] = ("resolved", value)
                        branches.append((s[:start] + s[end:], new_env))
                    if not branches:
                        new_env = dict(env)
                        new_env[name] = ("resolved", "")
                        branches = [(s[:start] + s[end:], new_env)]
                else:

                    new_env = dict(env)
                    new_env[name] = ("raw", expr)
                    branches = [(s[:start] + s[end:], new_env)]
            else:
                colon = self._split_top_level_char(inner, ":")
                if colon != -1:
                    name, default = inner[:colon].strip(), inner[colon + 1:]
                else:
                    name, default = inner.strip(), None

                if name in env:
                    _kind2, val = env[name]
                    branches = [(s[:start] + val + s[end:], env)]
                elif default is not None:
                    branches = [(s[:start] + default + s[end:], env)]
                else:

                    neutralized = f"${_ZW}{{{inner}{_ZW}}}"
                    branches = [(s[:start] + neutralized + s[end:], env)]

        for new_s, new_env in branches:
            if len(results) >= limit or self._generation_chars >= MAX_COMBINATORIAL_TOTAL_CHARS:
                self.last_generation_truncated = True
                return
            self._expand_combinatorial(new_s, new_env, rng, limit, results, depth + 1)
            if self.last_generation_truncated and (
                len(results) >= limit or self._generation_chars >= MAX_COMBINATORIAL_TOTAL_CHARS
            ):
                return

