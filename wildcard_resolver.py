"""
Wildcard prompt resolver.

Supports:
  __name__                 -> random line from wildcards/name.txt (or yaml leaf), seeded
  __*name__ / __~name__    -> random line, always unseeded (varies every run)
  __+name__                -> sequential line, increments one step per call
  __-name__                -> sequential line, decrements one step per call
  __@name__                -> cyclical line, increments one step per call (dynamicprompts-
                               spec alias of __+name__; kept as a separate mode char so
                               prompts copied in from other tools work unmodified)
  __%name__                -> combinatorial: joint Cartesian product across every
                               %-group in the same resolve() call (see below)
  __colours*__             -> glob: pool together every wildcard whose name matches
                               (fnmatch rules), e.g. colours-warm.txt + colours-cold.txt
  __artists/**__           -> recursive glob: every wildcard anywhere under artists/
  __name(var=val, ...)__   -> parameterized template: resolves name's file as a single
                               template string (not a line-pick) with var/val bound as
                               ${var} substitutions for this call only
  {a|b|c}                  -> random choice, seeded
  {*a|b|c} / {~a|b|c}      -> random choice, unseeded
  {+a|b|c}                 -> sequential choice, increments one step per call
  {-a|b|c}                 -> sequential choice, decrements one step per call
  {@a|b|c}                 -> cyclical choice (spec alias of {+a|b|c})
  {%a|b|c}                 -> combinatorial choice (see below)
  {N::a|M::b|c}             -> weighted choice
  {n$$sep$$a|b|c}           -> select n items joined by sep
  {n-m$$sep$$a|b|c}         -> select between n and m items joined by sep
  {n#__wc__}                -> repeat wildcard n times (expands before multi-select)
  ${name=value}             -> variable assignment; re-evaluated on every ${name} read
  ${name=!value}            -> variable assignment, evaluated once immediately
  ${name} / ${name:default} -> variable read, with optional fallback if unset
  # comment                -> ignored (line-leading only)

Nesting is resolved innermost-first over several passes.

Combinatorial (%) mode
-----------------------
+/- already let a single group step through its own list once per call, and
that's enough to reproduce "all N combinations in one click" for a *single*
{a|b|c} — set batch count to N (or a multiple) with an incrementing seed/
queue, click Run once, done. It falls short as soon as a prompt has two or
more independent placeholders: each +/- counter advances on its own, so two
same-length lists move in lockstep forever and most pairings are never
reached (only coprime-length lists happen to cover everything, and only by
coincidence).

% fixes that by treating every %-marked group *in the same resolve() call*
as one joint draw: on each call, WildcardResolver._prepare_combinatorial()
scans the raw text left-to-right for every __%name__ / {%a|b|c}, sizes each
one, and pulls a single shared index from WildcardIndex.next_combinatorial_
index() (a counter completely separate from the +/- one). That index is
decomposed via mixed-radix (last group cycles fastest, same convention as
itertools.product / nested for-loops), so `size_1 * size_2 * ... * size_n`
consecutive calls visit every combination of every %-group exactly once,
then repeats. A single %-group behaves identically to +, as a special case.

This is a "step one combination per node execution" model, matching how a
ComfyUI queue naturally works. It's the resolve()-time equivalent of the
upstream dynamicprompts CombinatorialPromptGenerator's *default sampler*,
just spread across many queued runs instead of returned as one batch.

generate_combinatorial() (full-set mode)
-----------------------------------------
For callers that want the *entire* combination set back in a single call —
matching CombinatorialPromptGenerator.generate() from the upstream library —
use generate_combinatorial() instead of resolve(). Unlike the % mode above,
this expands *every* unmarked group in the text: {a|b|c}, __wildcard__,
multi-select ({n$$sep$$a|b|c} expands into every n-of-k subset, per upstream's
own combinatorial handling of multi-select), variables (a non-immediate
${name} is re-evaluated -- and so re-branches -- at every read site, while an
immediate ${name=!expr} branches once at the assignment and stays locked to
that value for every read within the branch), and parameterized templates
(__name(var=val)__'s body is expanded as its own sub-problem, with `var`
scoped to that one call so it can't leak into the surrounding text). A group
explicitly marked +/-/*/~/@/% opts out of expansion and is instead resolved
with a single pick per output prompt, per "you can also explicitly specify
which sampler to use for certain parts" in the upstream docs.

Known limits of this implementation: nested braces only combinatorialize at
whichever level a pass first resolves them, same as the existing
innermost-first nesting behavior used elsewhere; two textually identical
%-groups in resolve()'s (not generate_combinatorial()'s) joint-sweep mode
resolve to the same picked value, matched by literal text rather than
occurrence position -- this is specific to %, this project's own extension,
and doesn't affect the Combinatorial node.
"""

import re
import random
import itertools

WILDCARD_RE = re.compile(r"__([+\-*%~@]?)([A-Za-z0-9_\-\/*]+)__")
PARAM_WILDCARD_RE = re.compile(r"__([A-Za-z0-9_\-\/]+)\(([^()]*)\)__")
BRACE_RE = re.compile(r"\{([^{}]*)\}")
QUANT_RE = re.compile(r"^(\d+)#(.+)$")
WEIGHT_RE = re.compile(r"^\s*(\d+)::\s*(.*)$", re.DOTALL)
VAR_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
# Pre-scan pass used only by _prepare_combinatorial(), to find every %-group
# in the *original* text, left-to-right, before any resolution has mutated
# it. Kept in sync with WILDCARD_RE / BRACE_RE's character classes.
COMBO_SCAN_RE = re.compile(r"(__%[A-Za-z0-9_\-\/]+__)|(\{%[^{}]*\})")
# Modes that pick a single value rather than expanding (used by both resolve()
# and generate_combinatorial()). "" (no marker) is the only expanding mode.
SINGLE_PICK_MODES = ("+", "-", "*", "~", "@", "%")
# Zero-width marker used to neutralize an unresolvable __name__ reference
# during generate_combinatorial() so it can't be re-matched by WILDCARD_RE
# (which would otherwise loop forever trying to "expand" it). Stripped back
# out of every finished prompt at the very end.
_ZW = "\u2060"

MAX_PASSES = 25


class WildcardResolver:
    # Hard safety cap on generate_combinatorial() output, mirroring the "Max
    # Generations" guard upstream tools use to stop a runaway Cartesian
    # product (e.g. five 20-line wildcards = 3.2M prompts) from ever being
    # fully materialized in memory.
    MAX_COMBINATORIAL_PROMPTS = 5000

    def __init__(self, index):
        """index: a WildcardIndex instance, provides .get_lines(name) -> list[str] | None.
        Sequential (+/-) state is NOT kept here — it's stored on `index`, which is a
        long-lived singleton, so it persists across the many short-lived
        WildcardResolver instances created per node execution / resolve call."""
        self.index = index
        self.used_names = []  # every known wildcard name actually picked during resolve()/resolve_lines()
        self.variables = {}  # name -> ("resolved", str) | ("raw", str) -- see _resolve_variables
        self.last_generation_truncated = False  # set by generate_combinatorial() -- see there

    def strip_comments(self, text):
        lines = text.split("\n")
        return "\n".join(l for l in lines if not l.lstrip().startswith("#"))

    def _pick_wildcard_line(self, name, mode, rng):
        lines = self.index.get_lines(name)
        if not lines:
            return f"__{mode}{name}__"  # leave unresolved, unknown reference (preserve mode prefix)
        self.used_names.append(name)
        if mode in ("+", "@"):
            i = self.index.next_sequential_index(name, len(lines), 1)
            return lines[i]
        if mode == "-":
            i = self.index.next_sequential_index(name, len(lines), -1)
            return lines[i]
        if mode in ("*", "~"):
            return random.choice(lines)
        # mode == "%" also lands here as a fallback (e.g. a %-group that
        # _prepare_combinatorial() deliberately skipped, such as one nested
        # inside a multi-select). Degrades to the same seeded pick as the
        # no-mode default rather than raising.
        return rng.choice(lines)

    def _prepare_combinatorial(self, text):
        """Pre-scan pass, run once at the top of resolve(), on the original
        unresolved text. Finds every %-group (both __%name__ and {%a|b|c}),
        in left-to-right order, sizes each one, and turns a single shared
        counter — keyed to this exact ordered set of groups and sizes — into
        a full mixed-radix assignment: one specific option index per group,
        such that `total = size_1 * ... * size_n` consecutive resolve() calls
        visit every joint combination exactly once. Returns a dict mapping
        each group's exact matched literal text (e.g. "__%colors__" or
        "{%a|b|c}") to its resolved value for *this* call; empty dict if the
        text has no %-groups. Completely separate from +/- state — see
        WildcardIndex.next_combinatorial_index.
        """
        groups = []  # (matched_literal, size, kind, payload)
        for m in COMBO_SCAN_RE.finditer(text):
            whole = m.group(0)
            if whole.startswith("__"):
                name = whole[3:-2]
                lines = self.index.get_lines(name)
                if not lines:
                    continue  # unknown wildcard name -- leave for normal/unresolved handling
                groups.append((whole, len(lines), "wc", (name, lines)))
            else:
                inner = whole[2:-1]
                if re.match(r"^\d+(?:-\d+)?\$\$", inner):
                    continue  # multi-select isn't combinatorial-aware -- falls back to seeded-random
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

        # Mixed-radix decompose combo_index into one digit per group. Last
        # group cycles fastest (itertools.product / nested-loop convention):
        # with sizes [3, 4], index 0->(0,0), 1->(0,1), ... 4->(1,0), etc.
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
            out = WILDCARD_RE.sub(repl, out)
        return out

    def _resolve_param_wildcards(self, text, rng, combo_map=None):
        """__name(var=val, ...)__ -- resolves `name`'s wildcard file as a single
        multi-line template (its lines joined with "\n", not picked from at
        random the way a normal __name__ reference would) with var=val bound
        as ${var} for the duration of that one resolution. Values are taken
        literally (no nested parens/commas), matching the upstream library's
        "for now you can only pass a literal string into the template"
        limitation. Runs before the plain wildcard/brace passes so the
        template body still goes through normal resolution afterwards.
        """
        def repl(m):
            name, argstr = m.group(1), m.group(2)
            entry = self.index.get_entry(name)
            if not entry:
                return m.group(0)  # unknown template -- leave unresolved
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

            # Scope the call's args as variables, resolve the template body
            # in full (braces + wildcards + nested variable reads), then
            # restore whatever variables existed before this call so a
            # parameterized call can't leak its args into the surrounding
            # prompt or sibling calls.
            saved = {k: self.variables.get(k) for k in args}
            for k, v in args.items():
                self.variables[k] = ("resolved", v)
            try:
                resolved = self._run_passes(template, rng, combo_map)
            finally:
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
            out = PARAM_WILDCARD_RE.sub(repl, out)
        return out

    def _find_dollar_spans(self, text):
        """Finds every top-level ${...} span in text (brace-depth aware, so a
        ${name=...{a|b}...} assignment whose value itself contains braces
        still matches as one span). Returns a list of (start, end, inner)."""
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
        """First top-level occurrence of `ch` in s (not inside nested {}); -1 if none."""
        depth = 0
        for idx, c in enumerate(s):
            if c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
            elif c == ch and depth == 0:
                return idx
        return -1

    def _resolve_variables(self, text, rng, combo_map=None):
        """One pass over every ${...} span: assignments (${name=value} /
        ${name=!value}) are evaluated and removed (they emit nothing), reads
        (${name} / ${name:default}) are substituted with the variable's
        value. Non-immediate assignments store the raw expression and
        re-resolve it fresh on every read (so two reads of the same
        non-immediate variable can legitimately differ, matching the
        upstream docs' "In summer, I wear winter shirts" example); immediate
        (!) assignments resolve once, at assignment time, and store the
        fixed result.
        """
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
                    self.variables[name] = ("resolved", self._run_passes(expr, rng, combo_map))
                else:
                    self.variables[name] = ("raw", expr)
                out[-1] = out[-1][: -(end - start)]  # drop the assignment span itself -- it emits nothing
                continue

            colon = self._split_top_level_char(inner, ":")
            if colon != -1:
                name, default = inner[:colon].strip(), inner[colon + 1:]
            else:
                name, default = inner.strip(), None

            if name in self.variables:
                kind, val = self.variables[name]
                value = val if kind == "resolved" else self._run_passes(val, rng, combo_map)
            elif default is not None:
                value = self._run_passes(default, rng, combo_map)
            else:
                value = text[start:end]  # unset, no default -- leave the reference visible rather than erroring
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
        """Every n-of-k combination of `options`, for n in [min_count, max_count],
        deduplicated by *value* rather than by position -- shared by the
        combinatorial "brace" branch of both _expand_combinatorial() and
        _count_combinatorial() below.

        Without this, two options with identical text produce positionally-
        distinct but value-identical combinations, e.g. {2$$, $$3#__color__}
        first expands via _expand_quantifiers() into three copies of the
        same unresolved "__color__" token, and combinations((__color__,
        __color__, __color__), 2) yields 3 tuples that are all literally
        "(__color__, __color__)" -- three duplicate branches, each of which
        then independently re-expands the (still-unresolved) __color__
        occurrences into the same 3*3=9 combinations again, producing 27
        generated prompts (9 unique, each repeated 3x) instead of 9. Since
        selecting *which* of several textually-identical, not-yet-resolved
        copies get chosen carries no information -- every choice of "which
        slots" leads to the exact same downstream expansion -- collapsing
        to one branch per distinct combo is both correct and avoids the
        redundant work. The same collapsing is equally correct for options
        that are duplicates for a mundane reason (a user literally writing
        {2$$, $$a|a|b}): only two combinations are distinguishable by value
        ("a, a" and "a, b"), so only two should be counted/generated.

        Built lazily (a generator, not a list) so a large option list whose
        raw C(k, n) is huge still can't blow up memory before the caller's
        own `limit` cap kicks in -- same reasoning as the code this replaces.
        The `seen` set only ever holds as many entries as combos actually
        consumed, so it stays bounded by the same cap.
        """
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
                # Only reaches here if _prepare_combinatorial() didn't already
                # resolve it via combo_map above -- e.g. a multi-select group
                # marked with %, which isn't combinatorial-aware. Stripping
                # the % and falling through the normal branches below makes
                # it degrade to the same seeded-random behavior as no mode.
                mode, inner = "%", inner[1:]

            # multi-select: n$$sep$$a|b|c  or  n-m$$sep$$a|b|c
            multi_match = re.match(r"^(\d+)(?:-(\d+))?\$\$(.*?)\$\$(.*)$", inner, re.DOTALL)
            if multi_match:
                lo = int(multi_match.group(1))
                hi = int(multi_match.group(2)) if multi_match.group(2) else lo
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
                    weighted.append((int(wm.group(1)), wm.group(2)))
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

    def _run_passes(self, text, rng, combo_map=None):
        """The core fixpoint loop shared by resolve() and by anything that needs
        to fully resolve a *fragment* on the spot (immediate variable
        assignments, parameterized-template bodies): variables, then
        parameterized templates, then braces, then wildcards, repeated until
        stable or MAX_PASSES is hit."""
        prev = None
        for _ in range(MAX_PASSES):
            if text == prev:
                break
            prev = text
            text = self._resolve_variables(text, rng, combo_map)
            text = self._resolve_param_wildcards(text, rng, combo_map)
            text = self._resolve_braces(text, rng, combo_map)
            text = self._resolve_wildcards(text, rng, combo_map)
        return text

    def resolve(self, text, seed=0):
        text = self.strip_comments(text)
        text = self._expand_quantifiers(text)
        rng = random.Random(seed)
        # One pre-scan per resolve() call, on the text as given: sizes every
        # %-group and fixes this call's joint combinatorial index up front,
        # before any pass below runs. Everything else about the loop is
        # unchanged from before % existed.
        combo_map = self._prepare_combinatorial(text)
        text = self._run_passes(text, rng, combo_map)
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

    # ---- full-set combinatorial generation ----------------------------------

    def generate_combinatorial(self, text, seed=0, max_prompts=None):
        """Returns the *entire* set of resolved prompts as a list, expanding every
        unmarked {a|b|c} / __wildcard__ -- and now also unmarked multi-select
        groups, variables, and parameterized templates -- into the full
        Cartesian product, the same way upstream's CombinatorialPromptGenerator
        treats a template as one parse tree and walks every branch of it.
        This is in contrast to resolve()'s one-combination-per-call model.
        Groups explicitly marked +/-/*/~/@/% opt out of expansion and are
        resolved with a single pick per output prompt instead.

        Capped at `max_prompts` (or MAX_COMBINATORIAL_PROMPTS if not given /
        larger than it). Once the cap is hit, generation simply stops --
        matching upstream's own documented behavior for its "Max Generations"
        setting ("num_prompts acts as an upper bound"), rather than trying to
        top up the remainder with single-picked filler.
        """
        limit = min(max_prompts, self.MAX_COMBINATORIAL_PROMPTS) if max_prompts else self.MAX_COMBINATORIAL_PROMPTS
        limit = max(1, limit)

        text = self.strip_comments(text)
        text = self._expand_quantifiers(text)
        rng = random.Random(seed)

        self.last_generation_truncated = False
        results = []
        self._expand_combinatorial(text, {}, rng, limit, results)

        return [s.replace(_ZW, "").strip() for s, _env in results[:limit]]

    # ---- full-set combinatorial counting (estimate only) --------------------

    def count_combinatorial(self, text, seed=0, limit=20000):
        """Estimate-only sibling of generate_combinatorial(): walks the exact
        same expansion tree -- same group-finding order, same "+/-/*/~/@/%
        opts out of expansion" rule -- but only counts leaves instead of
        building and collecting each resolved prompt string. This is what
        backs the Combinatorial node's live "roughly how many prompts" UI
        estimate, which needs to stay cheap enough to call on every
        keystroke, well past MAX_COMBINATORIAL_PROMPTS.

        Deliberately does NOT drive self.index's persistent counters.
        +/-/@'s next_sequential_index() is stateful: each call advances a
        shared position that a *real* resolve()/generate_combinatorial() call
        is entitled to consume exactly once. Calling it from here would
        silently burn through sequential wildcards' positions every time the
        UI re-estimates while someone is still typing. Wherever
        _expand_combinatorial() would pick a specific +/-/@ index via
        next_sequential_index(), _count_combinatorial() below instead peeks a
        representative option with this same seeded `rng` -- non-stateful,
        and good enough for sizing how much *further* structure that
        branch's pick might itself expand into, which is all a count needs (a
        single-pick group always contributes exactly one branch either way;
        only its downstream nesting affects the total).

        Returns (count, truncated). `truncated` mirrors what
        last_generation_truncated means for generate_combinatorial(): True if
        the walk hit `limit` before exhausting every combination, in which
        case count == limit and the real total is >= that.
        """
        text = self.strip_comments(text)
        text = self._expand_quantifiers(text)
        rng = random.Random(seed)

        limit = max(1, limit)
        counter = [0]  # mutable box so nested calls can share/advance one running total
        truncated = self._count_combinatorial(text, {}, rng, limit, counter)
        return counter[0], truncated

    def _count_combinatorial(self, s, env, rng, limit, counter):
        """Counting-only mirror of _expand_combinatorial(): same group-finding
        and expand-vs-single-pick logic, but increments counter[0] at each
        leaf instead of appending (text, env) to a results list, and peeks
        rather than picks for +/-/@ (see count_combinatorial()'s docstring).
        Returns True once `limit` leaves have been counted, so the caller
        stops walking sibling branches -- the same short-circuit
        generate_combinatorial() itself relies on to avoid materializing a
        runaway Cartesian product.
        """
        if counter[0] >= limit:
            return True

        found = self._leftmost_combinatorial_group(s)
        if found is None:
            counter[0] += 1
            return False

        kind, obj = found
        branches = None  # list or generator of (new_s, new_env), computed below

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
                        repl = f"__{mode}{name}__"  # leave unresolved, unknown reference
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
                    branches = [(s[:start] + line + s[end:], env) for line in lines]

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
                    lo = int(multi_match.group(1))
                    hi = int(multi_match.group(2)) if multi_match.group(2) else lo
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
                        # Same dedup-by-value reasoning as _multiselect_combos
                        # above: {3#__color__} expands to three identical
                        # "__color__" options before this loop ever sees it,
                        # and a plain {a|a|b} is no different -- without this,
                        # each duplicate becomes its own branch that
                        # independently re-expands into the same downstream
                        # combinations, inflating the count by however many
                        # times the value repeats.
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
                # How many branches the template body fans out into, counted
                # into its own scratch counter rather than the outer one --
                # mirrors _expand_combinatorial()'s sub_results being a
                # separate list from the outer `results`. Each of those
                # branches is a fully-resolved leaf (no groups left in it),
                # so splicing back an empty span instead of its actual text
                # is equivalent for finding whatever groups remain elsewhere
                # in `s` -- only the *count* of branches matters here, not
                # which text each one carries.
                sub_counter = [0]
                self._count_combinatorial(template, call_env, rng, limit, sub_counter)
                n = max(1, sub_counter[0])
                branches = [(s[:start] + s[end:], env) for _ in range(n)]

        else:  # kind == "var"
            start, end, inner = obj
            eq = self._split_top_level_char(inner, "=")
            if eq != -1 and VAR_NAME_RE.match(inner[:eq].strip()):
                name = inner[:eq].strip()
                rest = inner[eq + 1:]
                immediate = rest.startswith("!")
                expr = rest[1:] if immediate else rest
                if immediate:
                    # Same reasoning as the "param" branch above: count the
                    # assignment expression's own branches into a scratch
                    # counter, then fan this call site out into that many
                    # branches, each locking in a placeholder value -- the
                    # real value's text doesn't matter downstream since every
                    # ${name} *read* just needs env[name] to exist, not to
                    # hold the real resolved string, to correctly find any
                    # further groups later in `s`.
                    sub_counter = [0]
                    self._count_combinatorial(expr, dict(env), rng, limit, sub_counter)
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
            if self._count_combinatorial(new_s, new_env, rng, limit, counter):
                return True
        return False

    def _leftmost_combinatorial_group(self, s):
        """Finds whichever of {brace}, __wildcard__, __param(...)__ , or a
        ${...} variable span starts earliest in s. Returns (kind, match_or_span)
        or None if s has nothing left to expand."""
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

    def _expand_combinatorial(self, s, env, rng, limit, results):
        """The recursive core of generate_combinatorial(). `env` is this one
        branch's variable bindings: name -> ("resolved", str) | ("raw", str),
        exactly like self.variables in the resolve()-time variable pass, just
        scoped per-branch instead of shared on the instance -- that's what
        lets an immediate (!) assignment fan out into N branches while every
        ${name} read *within* one of those branches still sees that branch's
        single locked-in value, and lets a parameterized template's args stay
        local to that one call instead of leaking into the surrounding text.

        Appends (finished_text, final_env) tuples to `results` (env is kept
        around only so nested calls -- immediate assignments, parameterized
        template bodies -- can thread it through; callers of the public
        generate_combinatorial() only ever look at the text half).
        """
        if len(results) >= limit:
            return
        found = self._leftmost_combinatorial_group(s)
        if found is None:
            results.append((s, env))
            return

        kind, obj = found
        branches = None  # list or generator of (new_s, new_env), computed below

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
                    # Unknown reference: neutralize with zero-width joiners so
                    # this exact span can't be re-matched (which would recurse
                    # forever trying to "expand" it). Stripped back out at the
                    # very end by generate_combinatorial().
                    neutralized = f"_{_ZW}_{name}_{_ZW}_"
                    branches = [(s[:start] + neutralized + s[end:], env)]
                else:
                    self.used_names.append(name)
                    branches = [(s[:start] + line + s[end:], env) for line in lines]

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
                    lo = int(multi_match.group(1))
                    hi = int(multi_match.group(2)) if multi_match.group(2) else lo
                    joiner = multi_match.group(3)
                    options = []
                    for opt in self._split_top_level(multi_match.group(4)):
                        wm = WEIGHT_RE.match(opt)
                        options.append((wm.group(2) if wm else opt).strip())
                    max_count = min(hi, len(options))
                    min_count = max(1, min(lo, max_count)) if max_count else 1
                    if min_count > max_count:
                        # Degenerate range (e.g. lo > len(options)) -- fall
                        # back to a single pick rather than producing nothing.
                        picked = self._resolve_braces(m.group(0), rng, {})
                        branches = [(s[:start] + picked + s[end:], env)]
                    else:
                        # Every *distinct* n-of-k subset, for every n in
                        # [min_count, max_count] -- e.g. {2$$, $$a|b|c} ->
                        # "a, b" / "a, c" / "b, c" (all C(3,2)=3 pairs).
                        # _multiselect_combos() dedupes by value, not
                        # position, so options with identical text (e.g.
                        # from a {n#__wc__} quantifier expansion, see its
                        # docstring) collapse to one branch instead of
                        # producing C(k,n) duplicate branches that all
                        # expand into the same combinations downstream.
                        # Built lazily: doesn't materialize eagerly, and the
                        # caller's cap check below stops consuming it as
                        # soon as `limit` is reached, so an option list
                        # large enough to make C(k,n) huge still can't blow
                        # up memory before the cap kicks in.
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
                        # Same dedup-by-value reasoning as _multiselect_combos
                        # above: {3#__color__} expands to three identical
                        # "__color__" options before this loop ever sees it,
                        # and a plain {a|a|b} is no different -- without this,
                        # each duplicate becomes its own branch that
                        # independently re-expands into the same downstream
                        # combinations, inflating the count by however many
                        # times the value repeats.
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
                # Expand the template body as its own self-contained
                # sub-problem, args bound only for this call, then splice each
                # resulting value back into the *original* env -- so the call
                # site's args can't leak into whatever comes after it in `s`.
                sub_results = []
                self._expand_combinatorial(template, call_env, rng, limit, sub_results)
                branches = [(s[:start] + value + s[end:], env) for value, _sub_env in sub_results]
                if not branches:
                    branches = [(s[:start] + s[end:], env)]

        else:  # kind == "var"
            start, end, inner = obj
            eq = self._split_top_level_char(inner, "=")
            if eq != -1 and VAR_NAME_RE.match(inner[:eq].strip()):
                name = inner[:eq].strip()
                rest = inner[eq + 1:]
                immediate = rest.startswith("!")
                expr = rest[1:] if immediate else rest
                if immediate:
                    # Assignment itself still participates in the product --
                    # each way `expr` could resolve becomes its own branch --
                    # but *within* a branch, every ${name} read below sees the
                    # one value that branch locked in, per "immediate
                    # evaluation" semantics.
                    sub_results = []
                    self._expand_combinatorial(expr, dict(env), rng, limit, sub_results)
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
                    # Non-immediate: store the raw expression. Substituting it
                    # back in verbatim at each *read* site (below) -- rather
                    # than resolving it once here -- is what makes two
                    # separate ${name} reads branch independently, matching
                    # "each reference is re-evaluated" from the upstream docs.
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
                    # Unset, no default: leave the reference visible rather
                    # than erroring, neutralized so it can't loop forever.
                    neutralized = f"${_ZW}{{{inner}{_ZW}}}"
                    branches = [(s[:start] + neutralized + s[end:], env)]

        for new_s, new_env in branches:
            if len(results) >= limit:
                self.last_generation_truncated = True
                return
            self._expand_combinatorial(new_s, new_env, rng, limit, results)

