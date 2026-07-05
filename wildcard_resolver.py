"""
Wildcard prompt resolver.

Supports:
  __name__                 -> random line from wildcards/name.txt (or yaml leaf), seeded
  __*name__                -> random line, always unseeded (varies every run)
  __+name__                -> sequential line, increments one step per call
  __-name__                -> sequential line, decrements one step per call
  {a|b|c}                  -> random choice, seeded
  {*a|b|c}                 -> random choice, unseeded
  {+a|b|c}                 -> sequential choice, increments one step per call
  {-a|b|c}                 -> sequential choice, decrements one step per call
  {N::a|M::b|c}             -> weighted choice
  {n$$sep$$a|b|c}           -> select n items joined by sep
  {n-m$$sep$$a|b|c}         -> select between n and m items joined by sep
  {n#__wc__}                -> repeat wildcard n times (expands before multi-select)
  # comment                -> ignored (line-leading only)

Nesting is resolved innermost-first over several passes.
"""

import re
import random

WILDCARD_RE = re.compile(r"__([+\-*]?)([A-Za-z0-9_\-\/]+)__")
BRACE_RE = re.compile(r"\{([^{}]*)\}")
QUANT_RE = re.compile(r"^(\d+)#(.+)$")
WEIGHT_RE = re.compile(r"^\s*(\d+)::\s*(.*)$", re.DOTALL)

MAX_PASSES = 25


class WildcardResolver:
    def __init__(self, index):
        """index: a WildcardIndex instance, provides .get_lines(name) -> list[str] | None.
        Sequential (+/-) state is NOT kept here — it's stored on `index`, which is a
        long-lived singleton, so it persists across the many short-lived
        WildcardResolver instances created per node execution / resolve call."""
        self.index = index
        self.used_names = []  # every known wildcard name actually picked during resolve()/resolve_lines()

    def strip_comments(self, text):
        lines = text.split("\n")
        return "\n".join(l for l in lines if not l.lstrip().startswith("#"))

    def _pick_wildcard_line(self, name, mode, rng):
        lines = self.index.get_lines(name)
        if not lines:
            return f"__{mode}{name}__"  # leave unresolved, unknown reference (preserve mode prefix)
        self.used_names.append(name)
        if mode in ("+", "-"):
            step = 1 if mode == "+" else -1
            i = self.index.next_sequential_index(name, len(lines), step)
            return lines[i]
        if mode == "*":
            return random.choice(lines)
        return rng.choice(lines)

    def _resolve_wildcards(self, text, rng):
        def repl(m):
            mode, name = m.group(1), m.group(2)
            return self._pick_wildcard_line(name, mode, rng)
        prev = None
        out = text
        for _ in range(MAX_PASSES):
            if out == prev:
                break
            prev = out
            out = WILDCARD_RE.sub(repl, out)
        return out

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

    def _resolve_braces(self, text, rng):
        def repl(m):
            inner = m.group(1)
            mode = ""
            if inner.startswith("*"):
                mode, inner = "*", inner[1:]
            elif inner.startswith("+"):
                mode, inner = "+", inner[1:]
            elif inner.startswith("-"):
                mode, inner = "-", inner[1:]

            # multi-select: n$$sep$$a|b|c  or  n-m$$sep$$a|b|c
            multi_match = re.match(r"^(\d+)(?:-(\d+))?\$\$(.*?)\$\$(.*)$", inner, re.DOTALL)
            if multi_match:
                lo = int(multi_match.group(1))
                hi = int(multi_match.group(2)) if multi_match.group(2) else lo
                joiner = multi_match.group(3)
                options = self._split_top_level(multi_match.group(4))
                options = [o for o in options]
                count = rng.randint(lo, max(lo, hi)) if mode != "*" else random.randint(lo, max(lo, hi))
                count = min(count, len(options))
                chosen = rng.sample(options, count) if mode != "*" else random.sample(options, count)
                return joiner.join(c.strip() for c in chosen)

            options = self._split_top_level(inner)
            weighted = []
            for opt in options:
                wm = WEIGHT_RE.match(opt)
                if wm:
                    weighted.append((int(wm.group(1)), wm.group(2)))
                else:
                    weighted.append((1, opt))

            key = "|".join(o for _, o in weighted)
            if mode in ("+", "-"):
                step = 1 if mode == "+" else -1
                i = self.index.next_sequential_index("__brace__" + key, len(weighted), step)
                return weighted[i][1].strip()

            picker = random if mode == "*" else rng
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
            out = BRACE_RE.sub(repl, out)
        return out

    def _expand_quantifiers(self, text):
        # {2#__colors__} -> __colors__|__colors__  (only meaningful inside multi-select braces,
        # so we just textually expand N#token into token repeated, pipe-joined)
        def repl(m):
            n = int(m.group(1))
            token = m.group(2)
            return "|".join([token] * n)
        return re.sub(r"(\d+)#([A-Za-z0-9_\-\/*+]+)", lambda m: repl(m), text)

    def resolve(self, text, seed=0):
        text = self.strip_comments(text)
        text = self._expand_quantifiers(text)
        rng = random.Random(seed)
        prev = None
        for _ in range(MAX_PASSES):
            if text == prev:
                break
            prev = text
            text = self._resolve_braces(text, rng)
            text = self._resolve_wildcards(text, rng)
        return text.strip()

    def resolve_lines(self, text, seed=0):
        """entire text as one line vs line-by-line handled by caller;
        this resolves each non-empty line independently with seed+index for variety."""
        results = []
        for i, line in enumerate(text.split("\n")):
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            results.append(self.resolve(line, seed=seed + i))
        return results
