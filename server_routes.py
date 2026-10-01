from __future__ import annotations

import asyncio
import hashlib
import ipaddress
import json
import logging
import os
import re
import tempfile
import threading
from typing import Any

from aiohttp import web
from server import PromptServer

from .clip_tokenizer import count_clip_tokens
from .wildcard_index import get_index
from .wildcard_resolver import WildcardResolver
from .booru_database import active_db_path, normalize_lookup, normalize_tag

logger = logging.getLogger(__name__)
routes = PromptServer.instance.routes

MAX_JSON_BYTES = 2 * 1024 * 1024
MAX_TEXT_CHARS = 1_000_000
MAX_NAME_CHARS = 1024
MAX_PATH_CHARS = 4096
MAX_THUMB_BYTES = 8 * 1024 * 1024
COUNT_ONLY_LIMIT = 20_000
THUMB_EXTS = (".jpg", ".jpeg", ".png")
UINT64_MAX = 0xFFFFFFFFFFFFFFFF

_CUSTOM_WORD_TEXT_CACHE: dict[str, Any] = {"signature": None, "text": ""}

_BOORU_CATEGORY_NAMES = ("general", "artist", "copyright", "character", "meta")
_BOORU_CATEGORY_ALIASES = {
    "0": "general", "1": "artist", "3": "copyright", "4": "character", "5": "meta",
    "series": "copyright", "franchise": "copyright", "char": "character",
}


def _booru_category(raw: str) -> str:
    key = str(raw or "").strip().casefold()
    key = _BOORU_CATEGORY_ALIASES.get(key, key)
    return key if key in _BOORU_CATEGORY_NAMES else "general"


def _bundled_booru_db_path() -> str:
    return active_db_path()


def _booru_query_tokens(query: str) -> list[str]:
    """Split a typed fragment into order-independent search terms.

    "dark_saber" and "saber_dark" both become ["dark", "saber"]; every term
    must appear somewhere in a tag, in any order.
    """
    seen: list[str] = []
    for part in normalize_lookup(query).split("_"):
        if part and part not in seen:
            seen.append(part)
    return seen[:6]


def _booru_bundle_search(query: str, limit: int = 48) -> list[dict[str, Any]]:
    """Substring search of the bundled SQLite index, ranked by popularity.

    Every term of the query must appear anywhere in the tag (or in one of its
    aliases), so "sab" also finds "disposable_cup" and "dark_saber". Rows are
    ordered by post count before the limit is applied, so the most popular
    matches are never crowded out by an alphabetical prefix scan.
    """
    db_path = _bundled_booru_db_path()
    if not os.path.isfile(db_path):
        return []

    q = normalize_lookup(query)
    if len(q) < 1:
        return []
    tokens = _booru_query_tokens(q)
    if not tokens:
        return []

    fetch = max(limit * 4, 96)
    tag_where = " AND ".join("instr(tag_lc, ?) > 0" for _ in tokens)
    alias_where = " AND ".join("instr(a.alias_lc, ?) > 0" for _ in tokens)

    candidates: dict[tuple[str, str], tuple[tuple[Any, ...], dict[str, Any]]] = {}
    try:
        import sqlite3
        with sqlite3.connect(db_path) as conn:
            conn.row_factory = sqlite3.Row
            selects = [
                (
                    "SELECT tag, post_count, category, aliases, NULL AS matched_alias "
                    f"FROM tags WHERE {tag_where} ORDER BY post_count DESC LIMIT ?",
                    (*tokens, fetch),
                    False,
                ),
                (
                    "SELECT t.tag, t.post_count, t.category, t.aliases, a.alias AS matched_alias "
                    "FROM tag_aliases a JOIN tags t ON t.tag = a.tag "
                    f"WHERE {alias_where} ORDER BY t.post_count DESC LIMIT ?",
                    (*tokens, fetch),
                    True,
                ),
            ]

            for sql, params, alias_match in selects:
                for row in conn.execute(sql, params):
                    canonical = normalize_tag(row["tag"])
                    canonical_lc = canonical.casefold()
                    row_aliases = [
                        normalize_tag(a)
                        for a in str(row["aliases"] or "").split(",")
                        if a.strip()
                    ]
                    matched_alias = normalize_tag(row["matched_alias"]) if row["matched_alias"] else ""
                    labels = (
                        [(matched_alias, True), (canonical, False)]
                        if alias_match and matched_alias
                        else [(canonical, False)]
                    )

                    for label, is_alias in labels:
                        label_lc = label.casefold()
                        # The typed text itself is never suggested back, and every
                        # term has to be present in the label being shown.
                        if label_lc == q or not all(t in label_lc for t in tokens):
                            continue
                        key = (label_lc, canonical_lc)
                        score = (
                            -int(row["post_count"] or 0),
                            0 if label_lc.startswith(tokens[0]) else 1,
                            1 if is_alias else 0,
                            len(label),
                            label_lc,
                        )
                        item = {
                            "value": canonical,
                            "label": label,
                            "group": "Booru Tags",
                            "kind": "booru",
                            "category": _booru_category(str(row["category"] or "general")),
                            "count": int(row["post_count"] or 0),
                            "alias": canonical if is_alias else (row_aliases[0] if row_aliases else ""),
                        }
                        old = candidates.get(key)
                        if old is None or score < old[0]:
                            candidates[key] = (score, item)
    except Exception:
        logger.exception("Could not search canonical SQLite booru database")
        return []

    result = sorted(candidates.values(), key=lambda pair: pair[0])
    return [item for _, item in result[:limit]]


def _custom_word_sources() -> list[str]:
    sources: list[str] = []
    try:
        import folder_paths
        get_user_directory = getattr(folder_paths, "get_user_directory", None)
        if callable(get_user_directory):
            user_dir = get_user_directory()
            sources.append(os.path.join(user_dir, "prompt_palette", "autocomplete.txt"))
    except Exception:
        pass
    custom_nodes_root = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
    sources.append(os.path.join(custom_nodes_root, "ComfyUI-Custom-Scripts", "user", "autocomplete.txt"))
    if not sources[0].endswith(os.path.join("prompt_palette", "autocomplete.txt")):
        # ComfyUI without a user directory: keep Prompt Palette's own list next to the node.
        sources.insert(0, _fallback_custom_word_path())
    return list(dict.fromkeys(sources))


def _legacy_fallback_custom_word_path() -> str:
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "user", "autocomplete.txt")


def _fallback_custom_word_path() -> str:
    """Used only when ComfyUI has no user directory.

    Kept outside the node folder so updating or reinstalling the node cannot wipe
    the list. A list saved by an older release next to the node is copied over once.
    """
    path = os.path.join(os.path.expanduser("~"), ".prompt_palette", "autocomplete.txt")
    legacy = _legacy_fallback_custom_word_path()
    try:
        if not os.path.isfile(path) and os.path.isfile(legacy):
            os.makedirs(os.path.dirname(path), exist_ok=True)
            import shutil
            shutil.copy2(legacy, path)
    except OSError:
        logger.debug("Could not migrate the legacy custom-word list", exc_info=True)
    return path


def _custom_word_write_path() -> str:
    """Prompt Palette's own writable list (never ComfyUI-Custom-Scripts' file)."""
    return _custom_word_sources()[0]


def _load_custom_word_text() -> str:
    paths = [path for path in _custom_word_sources() if os.path.isfile(path)]
    signature = tuple((path, os.path.getmtime(path), os.path.getsize(path)) for path in paths)
    if _CUSTOM_WORD_TEXT_CACHE["signature"] == signature:
        return str(_CUSTOM_WORD_TEXT_CACHE["text"])
    chunks: list[str] = []
    for path in paths:
        try:
            with open(path, "r", encoding="utf-8", errors="replace", newline="") as handle:
                content = handle.read()
            chunks.append(content)
        except OSError:
            logger.debug("Could not read custom word source %s", path, exc_info=True)
    text = "\n".join(chunks)
    _CUSTOM_WORD_TEXT_CACHE["signature"] = signature
    _CUSTOM_WORD_TEXT_CACHE["text"] = text
    return text


def _error(message: str, status: int = 400, *, ok: bool | None = None) -> web.Response:
    payload: dict[str, Any] = {"error": message}
    if ok is not None:
        payload["ok"] = ok
    return web.json_response(payload, status=status)


async def _read_json_object(request: web.Request, limit: int | None = MAX_JSON_BYTES) -> dict[str, Any]:
    content_length = request.content_length
    if limit is not None and content_length is not None and content_length > limit:
        raise ValueError("request body is too large")
    raw = bytearray()
    async for chunk in request.content.iter_chunked(64 * 1024):
        raw.extend(chunk)
        if limit is not None and len(raw) > limit:
            raise ValueError("request body is too large")
    try:
        data = json.loads(bytes(raw).decode("utf-8")) if raw else {}
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("invalid JSON body") from exc
    if not isinstance(data, dict):
        raise ValueError("JSON body must be an object")
    return data


def _bounded_text(value: Any, field: str, limit: int | None = MAX_TEXT_CHARS) -> str:
    if value is None:
        return ""
    if not isinstance(value, str):
        raise ValueError(f"{field} must be a string")
    if limit is not None and len(value) > limit:
        raise ValueError(f"{field} is too long")
    return value


def _bounded_int(value: Any, field: str, *, minimum: int = 0, maximum: int = UINT64_MAX) -> int:
    if value is None or value == "":
        parsed = 0
    elif isinstance(value, bool):
        raise ValueError(f"{field} must be an integer")
    elif isinstance(value, int):
        parsed = value
    elif isinstance(value, float):
        if not value.is_integer():
            raise ValueError(f"{field} must be an integer")
        parsed = int(value)
    elif isinstance(value, str) and re.fullmatch(r"[+-]?\d+", value.strip()):
        parsed = int(value.strip())
    else:
        raise ValueError(f"{field} must be an integer")
    if parsed < minimum or parsed > maximum:
        raise ValueError(f"{field} must be between {minimum} and {maximum}")
    return parsed


def _read_text_file(path: str) -> str:
    with open(path, "r", encoding="utf-8", errors="replace", newline="") as handle:
        content = handle.read(MAX_TEXT_CHARS + 1)
    if len(content) > MAX_TEXT_CHARS:
        raise ValueError("wildcard file is too large to edit in the browser")
    return content


async def _get_fresh_index():
    index = get_index()
    await index.ensure_fresh_async()
    return index


@routes.get("/prompt_palette/booru_tags")
async def search_booru_tags(request):
    query = str(request.rel_url.query.get("q", ""))[:128].strip()
    if len(query) < 1:
        return web.json_response({"items": []})
    try:
        items = _booru_bundle_search(query, 60)
        for item in items:
            item["meta"] = (
                f'{int(item.get("count", 0)):,} posts'
                if int(item.get("count", 0))
                else "local tag"
            )
        return web.json_response({"items": items})
    except Exception:
        logger.exception("Could not search booru tags")
        return _error("couldn't search booru tags", 500)


MAX_BOORU_LOOKUP_TAGS = 400
MAX_BOORU_LOOKUP_TAG_CHARS = 160


def _booru_lookup_categories(tags: list[str]) -> dict[str, str]:
    """Exact-match category lookup for already-typed prompt tags.

    Unlike _booru_bundle_search this never does substring matching: a prompt tag is
    only colored when it *is* a database tag (or one of its aliases), so half-typed
    words and ordinary prose stay uncolored. Tags come back keyed by their lookup
    form (underscores, casefolded); unknown tags are simply omitted.
    """
    db_path = _bundled_booru_db_path()
    if not tags or not os.path.isfile(db_path):
        return {}
    import sqlite3
    found: dict[str, str] = {}
    try:
        with sqlite3.connect(db_path) as conn:
            for start in range(0, len(tags), 200):
                chunk = tags[start:start + 200]
                marks = ",".join("?" for _ in chunk)
                # Canonical tags first ...
                for tag_lc, category in conn.execute(
                    f"SELECT tag_lc, category FROM tags WHERE tag_lc IN ({marks})", chunk
                ):
                    found[str(tag_lc)] = _booru_category(str(category or "general"))
                # ... then aliases, resolved to the category of the tag they point at.
                rest = [tag for tag in chunk if tag not in found]
                if not rest:
                    continue
                alias_marks = ",".join("?" for _ in rest)
                for alias_lc, category, _count in conn.execute(
                    "SELECT a.alias_lc, t.category, t.post_count FROM tag_aliases a "
                    f"JOIN tags t ON t.tag = a.tag WHERE a.alias_lc IN ({alias_marks}) "
                    "ORDER BY t.post_count DESC",
                    rest,
                ):
                    found.setdefault(str(alias_lc), _booru_category(str(category or "general")))
    except Exception:
        logger.exception("Could not look up booru tag categories")
        return {}
    return found


@routes.post("/prompt_palette/booru_lookup")
async def lookup_booru_tags(request):
    try:
        data = await _read_json_object(request)
        raw = data.get("tags")
        if not isinstance(raw, list):
            raise ValueError("tags must be a list")
        seen: dict[str, None] = {}
        for item in raw[:MAX_BOORU_LOOKUP_TAGS]:
            if not isinstance(item, str) or len(item) > MAX_BOORU_LOOKUP_TAG_CHARS:
                continue
            key = normalize_lookup(item)
            if key:
                seen[key] = None
        categories = await asyncio.to_thread(_booru_lookup_categories, list(seen))
    except ValueError as exc:
        return _error(str(exc))
    except Exception:
        logger.exception("Could not look up booru tags")
        return _error("couldn't look up booru tags", 500)
    return web.json_response({"categories": categories})


_CUSTOM_WORD_LOCK = threading.Lock()
MAX_CUSTOM_WORD_CHARS = 500
MAX_CUSTOM_WORD_ALIAS_CHARS = 2000
MAX_CUSTOM_WORD_FIELDS = 64
MAX_CUSTOM_WORD_ROWS = 50_000


def _clean_custom_word_field(value: Any, field: str) -> str:
    text = _bounded_text(value, field, MAX_CUSTOM_WORD_CHARS * 4)
    text = re.sub(r"[\x00-\x1f]+", " ", text).strip()
    if len(text) > MAX_CUSTOM_WORD_CHARS:
        raise ValueError(f"{field} is too long")
    return text


_CUSTOM_WORD_CATEGORY_IDS = {"general": "0", "artist": "1", "copyright": "3", "character": "4", "meta": "5"}
_CUSTOM_WORD_CATEGORY_SYNONYMS = {"series": "copyright", "franchise": "copyright", "char": "character", "artists": "artist"}
_CUSTOM_WORD_NUMBER = re.compile(r"[+-]?\d+(?:\.\d+)?")
_CUSTOM_WORD_HEADER_FIRST = {"tag", "word", "value", "name"}
_CUSTOM_WORD_HEADER_SECOND = {"category", "type", "alias", "aliases", "shortcut", "trigger", "count", "priority", "posts"}


def _custom_word_category(raw: str) -> str:
    """Category name for a Danbooru id ("4") or a name/synonym ("character", "series"), else ""."""
    key = str(raw or "").strip().casefold()
    if not key or key == "null":
        return ""
    for name, category_id in _CUSTOM_WORD_CATEGORY_IDS.items():
        if key == category_id:
            return name
    key = _CUSTOM_WORD_CATEGORY_SYNONYMS.get(key, key)
    return key if key in _CUSTOM_WORD_CATEGORY_IDS else ""


def _is_custom_number(value: str) -> bool:
    return bool(value) and _CUSTOM_WORD_NUMBER.fullmatch(value) is not None


def _split_custom_aliases(values: list[str], word: str) -> list[str]:
    seen: set[str] = set()
    aliases: list[str] = []
    for value in values:
        for part in re.split(r"[,\n]", str(value)):
            alias = part.strip()
            key = alias.casefold()
            if not alias or key == word.casefold() or key == "null" or key in seen:
                continue
            seen.add(key)
            aliases.append(alias)
    return aliases


def _describe_custom_row(fields: list[str]) -> dict[str, Any] | None:
    """Work out what an autocomplete.txt row means. Mirror of parseCustomRow() in
    web/editor/custom_words.js, so the file is read the same way on both sides.

    layout "tag":    tag[,category[,count[,aliases...]]]  (a1111 tagcomplete form; aliases may
                     be one quoted comma list or several plain columns; category is an id or name)
    layout "simple": word[,shortcut[,priority]]           (pythongosssss custom-words form)
    """
    f = [str(part).strip() for part in fields]
    n = len(f)
    if not n or not f[0]:
        return None
    word = f[0]

    def tag(category: str, count_text: str, alias_fields: list[str]) -> dict[str, Any]:
        count = int(float(count_text)) if _is_custom_number(count_text) else 0
        return {"layout": "tag", "word": word, "category": category, "count": max(count, 0),
                "aliases": _split_custom_aliases(alias_fields, word)}

    def simple(shortcut: str) -> dict[str, Any]:
        return {"layout": "simple", "word": word, "category": "", "count": 0, "aliases": [shortcut] if shortcut else []}

    if n == 1:
        return simple("")
    if n == 2:
        if not f[1] or _is_custom_number(f[1]):
            return simple("")  # a bare priority
        category = _custom_word_category(f[1])
        return tag(category, "", []) if category else simple(f[1])
    category = _custom_word_category(f[1])
    if n == 3:
        if (category or not f[1]) and (not f[2] or _is_custom_number(f[2])):
            return tag(category, f[2], [])
        return simple(f[1])
    if n == 4 or category or not f[1] or _is_custom_number(f[1]):
        return tag(category, f[2], f[3:])
    return simple(f[1])


def _canonical_custom_row(fields: list[str]) -> list[str] | None:
    """Row as it is written to disk. Tag rows always use the four-column form with a numeric
    category id (readable by other tagcomplete tools); simple rows keep their own layout."""
    described = _describe_custom_row(fields)
    if described is None:
        return None
    if described["layout"] == "tag":
        return [described["word"], _CUSTOM_WORD_CATEGORY_IDS.get(described["category"], ""),
                str(described["count"]), ",".join(described["aliases"])]
    row = [str(part).strip() for part in fields][:3]
    while len(row) > 1 and not row[-1]:
        row.pop()
    return row


def _custom_word_key(fields: list[str]) -> tuple[str, str]:
    """(word, shortcuts) identity of a row, for duplicate detection."""
    described = _describe_custom_row(fields)
    if described is None:
        return "", ""
    return described["word"].casefold(), ",".join(sorted(alias.casefold() for alias in described["aliases"]))


def _is_custom_header(fields: list[str]) -> bool:
    return (len(fields) >= 2 and fields[0].strip().casefold() in _CUSTOM_WORD_HEADER_FIRST
            and fields[1].strip().casefold() in _CUSTOM_WORD_HEADER_SECOND)


def _custom_row_line(fields: list[str]) -> str:
    import csv
    import io

    buffer = io.StringIO()
    csv.writer(buffer, lineterminator="").writerow(fields)
    return buffer.getvalue()


def _normalize_custom_text(text: str) -> str:
    return text.replace("\x00", "").replace("\r\n", "\n").replace("\r", "\n")


def _parse_custom_records(text: str) -> list[tuple[int, int, list[str]]]:
    """Rows of a (newline-normalized) file as (first_line, end_line, fields), so single rows can
    be dropped without touching anything else in the file."""
    import csv
    import io

    reader = csv.reader(io.StringIO(text))
    records: list[tuple[int, int, list[str]]] = []
    previous = 0
    try:
        for fields in reader:
            records.append((previous, reader.line_num, fields))
            previous = reader.line_num
    except csv.Error as exc:
        raise ValueError(f"couldn't read the custom words: {exc}") from exc
    return records


def _read_own_custom_text(path: str) -> str:
    """The whole file, normalized. Never truncates: it is rewritten from this text."""
    if not os.path.isfile(path):
        return ""
    with open(path, "r", encoding="utf-8", errors="replace", newline="") as handle:
        text = handle.read()
    return _normalize_custom_text(text)


def _atomic_write_text(path: str, text: str) -> None:
    directory = os.path.dirname(path)
    os.makedirs(directory, exist_ok=True)
    fd, temp_path = tempfile.mkstemp(prefix=".autocomplete-", suffix=".tmp", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as handle:
            handle.write(text)
        os.replace(temp_path, path)
    except BaseException:
        try:
            os.unlink(temp_path)
        except OSError:
            pass
        raise
    _CUSTOM_WORD_TEXT_CACHE["signature"] = None


def _usable_custom_rows(records: list[tuple[int, int, list[str]]]) -> list[tuple[int, int, list[str]]]:
    rows = []
    for index, (start, end, fields) in enumerate(records):
        stripped = [part.strip() for part in fields]
        if not stripped or not stripped[0]:
            continue
        if not rows and _is_custom_header(stripped) and all(not r[2] for r in records[:index]):
            continue
        rows.append((start, end, stripped))
    return rows


def _build_custom_word_row(word: str, trigger: str, category: str) -> list[str]:
    """Row for the "+ Custom word" form. `trigger` may hold several comma-separated shortcuts.

    Plain words stay in the simple `word[,shortcut]` form; a tag type or several shortcuts use the
    tagcomplete form `word,category_id,0,"shortcut,shortcut"`, so it is colored like a booru tag.
    """
    aliases = _split_custom_aliases([trigger], word)
    category_id = _CUSTOM_WORD_CATEGORY_IDS.get(category.casefold(), "") if category else ""
    if not category_id and not aliases:
        return [word]
    only = aliases[0] if len(aliases) == 1 else ""
    if only and not category_id and not _is_custom_number(only) and not _custom_word_category(only):
        return [word, only]
    return [word, category_id, "0", ",".join(aliases)]


def _append_custom_rows(rows: list[list[str]]) -> int:
    """Append rows that are not already in the file. Returns how many were added."""
    path = _custom_word_write_path()
    with _CUSTOM_WORD_LOCK:
        existing = _read_own_custom_text(path)
        keys = {_custom_word_key(fields) for _, _, fields in _usable_custom_rows(_parse_custom_records(existing))}
        lines: list[str] = []
        for row in rows:
            key = _custom_word_key(row)
            if key in keys:
                continue
            keys.add(key)
            lines.append(_custom_row_line(row) + "\n")
        if not lines:
            return 0
        prefix = existing if not existing or existing.endswith("\n") else existing + "\n"
        _atomic_write_text(path, prefix + "".join(lines))
    return len(lines)


def _add_custom_word(word: str, trigger: str, category: str = "") -> bool:
    """Append a row to autocomplete.txt. Returns False if the word already exists."""
    return _append_custom_rows([_build_custom_word_row(word, trigger, category)]) > 0


def _list_custom_rows() -> list[dict[str, Any]]:
    path = _custom_word_write_path()
    with _CUSTOM_WORD_LOCK:
        text = _read_own_custom_text(path)
    return [{"id": _custom_row_line(fields), "fields": fields}
            for _, _, fields in _usable_custom_rows(_parse_custom_records(text))]


def _remove_custom_rows(ids: set[str]) -> int:
    path = _custom_word_write_path()
    with _CUSTOM_WORD_LOCK:
        text = _read_own_custom_text(path)
        if not text:
            return 0
        parts = text.split("\n")
        if parts and parts[-1] == "":
            parts.pop()
        lines = [part + "\n" for part in parts]
        dropped: set[int] = set()
        removed = 0
        for start, end, fields in _usable_custom_rows(_parse_custom_records(text)):
            if _custom_row_line(fields) in ids:
                dropped.update(range(start, end))
                removed += 1
        if not removed:
            return 0
        _atomic_write_text(path, "".join(line for index, line in enumerate(lines) if index not in dropped))
    return removed


def _import_custom_rows(text: str, mode: str) -> dict[str, int]:
    incoming: list[list[str]] = []
    records = _parse_custom_records(_normalize_custom_text(text))
    # Rows that have content but no word in the first column can't be used.
    skipped = sum(1 for _, _, fields in records if fields and not fields[0].strip() and any(part.strip() for part in fields))
    for _, _, fields in _usable_custom_rows(records):
        cleaned = [re.sub(r"[\x00-\x1f]+", " ", part).strip() for part in fields]
        too_long = any(len(part) > (MAX_CUSTOM_WORD_CHARS if i == 0 else MAX_CUSTOM_WORD_ALIAS_CHARS)
                       for i, part in enumerate(cleaned))
        row = None if too_long or len(cleaned) > MAX_CUSTOM_WORD_FIELDS else _canonical_custom_row(cleaned)
        if row is None:
            skipped += 1
            continue
        incoming.append(row)
    path = _custom_word_write_path()
    with _CUSTOM_WORD_LOCK:
        existing = _read_own_custom_text(path)
        replace = mode == "replace"
        keys = set() if replace else {_custom_word_key(fields)
                                      for _, _, fields in _usable_custom_rows(_parse_custom_records(existing))}
        lines: list[str] = []
        duplicates = 0
        for row in incoming:
            key = _custom_word_key(row)
            if key in keys:
                duplicates += 1
                continue
            keys.add(key)
            lines.append(_custom_row_line(row) + "\n")
        if replace:
            if os.path.isfile(path):
                import shutil
                shutil.copy2(path, path + ".bak")  # one-step undo for a replace
            _atomic_write_text(path, "".join(lines))
        elif lines:
            prefix = existing if not existing or existing.endswith("\n") else existing + "\n"
            _atomic_write_text(path, prefix + "".join(lines))
    return {"added": len(lines), "skipped": skipped, "duplicates": duplicates}


@routes.post("/prompt_palette/custom_words/add")
async def add_custom_word(request):
    try:
        data = await _read_json_object(request)
        word = _clean_custom_word_field(data.get("word"), "word")
        trigger = _bounded_text(data.get("trigger"), "trigger", MAX_CUSTOM_WORD_ALIAS_CHARS)
        trigger = re.sub(r"[\x00-\x09\x0b-\x1f]+", " ", trigger).strip()
        category = _clean_custom_word_field(data.get("category"), "category").casefold()
        if category and category not in _CUSTOM_WORD_CATEGORY_IDS:
            raise ValueError("unknown tag type")
        if not word:
            raise ValueError("enter the word or phrase to insert")
        created = await asyncio.to_thread(_add_custom_word, word, trigger, category)
    except ValueError as exc:
        return _error(str(exc), ok=False)
    except OSError:
        logger.exception("Could not write custom autocomplete word")
        return _error("couldn't write to the custom words file", 500, ok=False)
    except Exception:
        logger.exception("Could not add custom autocomplete word")
        return _error("couldn't add custom word", 500, ok=False)
    return web.json_response({"ok": True, "created": created})


@routes.get("/prompt_palette/custom_words")
async def get_custom_words(request):
    # The frontend parses pythongosssss' autocomplete.txt grammar so the same
    # priority/alias semantics are available without installing or patching it.
    try:
        return web.json_response({"text": _load_custom_word_text()})
    except ValueError as exc:
        return _error(str(exc), 413)
    except Exception:
        logger.exception("Could not load custom autocomplete words")
        return _error("couldn't load custom autocomplete words", 500)


@routes.get("/prompt_palette/custom_words/manage")
async def manage_custom_words(request):
    """Rows of Prompt Palette's own list (the only file it ever writes), for the manager dialog
    and for export. Words that come from another extension's file load but are not listed."""
    try:
        rows = await asyncio.to_thread(_list_custom_rows)
        external = any(os.path.isfile(path) for path in _custom_word_sources()[1:])
    except ValueError as exc:
        return _error(str(exc), 413, ok=False)
    except Exception:
        logger.exception("Could not list custom autocomplete words")
        return _error("couldn't load custom words", 500, ok=False)
    return web.json_response({"ok": True, "rows": rows, "external": external})


@routes.post("/prompt_palette/custom_words/remove")
async def remove_custom_words(request):
    try:
        data = await _read_json_object(request)
        raw_ids = data.get("ids")
        if not isinstance(raw_ids, list) or len(raw_ids) > MAX_CUSTOM_WORD_ROWS:
            raise ValueError("ids must be a list of rows to remove")
        ids = {_bounded_text(item, "id", MAX_CUSTOM_WORD_ALIAS_CHARS * 2) for item in raw_ids}
        removed = await asyncio.to_thread(_remove_custom_rows, ids)
    except ValueError as exc:
        return _error(str(exc), ok=False)
    except OSError:
        logger.exception("Could not write custom words")
        return _error("couldn't write to the custom words file", 500, ok=False)
    except Exception:
        logger.exception("Could not remove custom words")
        return _error("couldn't remove custom words", 500, ok=False)
    return web.json_response({"ok": True, "removed": removed})


@routes.post("/prompt_palette/custom_words/import")
async def import_custom_words(request):
    try:
        data = await _read_json_object(request, limit=None)
        text = _bounded_text(data.get("text"), "text", limit=None)
        mode = data.get("mode", "merge")
        if mode not in ("merge", "replace"):
            raise ValueError("mode must be merge or replace")
        result = await asyncio.to_thread(_import_custom_rows, text, mode)
    except ValueError as exc:
        return _error(str(exc), ok=False)
    except OSError:
        logger.exception("Could not write custom words")
        return _error("couldn't write to the custom words file", 500, ok=False)
    except Exception:
        logger.exception("Could not import custom words")
        return _error("couldn't import custom words", 500, ok=False)
    return web.json_response({"ok": True, **result})


@routes.get("/prompt_palette/list")
async def list_wildcards(request):
    try:
        index = await _get_fresh_index()
        return web.json_response({"items": index.flat_list()})
    except Exception:
        logger.exception("Could not list wildcards")
        return _error("couldn't load wildcard library", 500)


@routes.get("/prompt_palette/search")
async def search_wildcards(request):
    query = request.rel_url.query.get("q", "")[:512]
    try:
        index = await _get_fresh_index()
        names = index.search(query) if query else index.all_names()
        items = []
        for name in names:
            entry = index.get_entry(name)
            if entry:
                items.append({"path": name, "type": entry["type"], "count": len(entry["lines"])})
        return web.json_response({"items": items})
    except Exception:
        logger.exception("Could not search wildcards")
        return _error("couldn't search wildcard library", 500)


@routes.get("/prompt_palette/preview")
async def preview_wildcard(request):
    name = request.rel_url.query.get("name", "")[:MAX_NAME_CHARS]
    try:
        index = await _get_fresh_index()
        lines = index.preview(name, max_lines=5)
        if lines is None:
            return web.json_response({"found": False, "lines": []})
        return web.json_response({"found": True, "lines": lines})
    except Exception:
        logger.exception("Could not preview wildcard")
        return _error("couldn't preview wildcard", 500)


@routes.get("/prompt_palette/content")
async def get_content(request):
    name = request.rel_url.query.get("name", "")[:MAX_NAME_CHARS]
    try:
        index = await _get_fresh_index()
        entry = index.get_entry(name)
        if not entry:
            return web.json_response({"found": False}, status=404)
        editable = entry["type"] == "txt"
        content = (
            await asyncio.to_thread(_read_text_file, entry["abs_path"])
            if editable
            else "\n".join(entry["lines"])
        )
        return web.json_response(
            {"found": True, "type": entry["type"], "content": content, "editable": editable}
        )
    except ValueError as exc:
        return _error(str(exc), 413)
    except OSError:
        logger.exception("Could not read wildcard content")
        return _error("couldn't read wildcard", 500)
    except Exception:
        logger.exception("Could not load wildcard content")
        return _error("couldn't load wildcard", 500)


@routes.post("/prompt_palette/save")
async def save_wildcard(request):
    try:
        data = await _read_json_object(request)
        name = _bounded_text(data.get("name"), "name", MAX_NAME_CHARS)
        content = _bounded_text(data.get("content"), "content")
        await asyncio.to_thread(get_index().save_txt, name, content)
    except ValueError as exc:
        return _error(str(exc), ok=False)
    except Exception:
        logger.exception("Could not save wildcard")
        return _error("couldn't save wildcard", 500, ok=False)
    return web.json_response({"ok": True})


@routes.post("/prompt_palette/delete")
async def delete_wildcard(request):
    try:
        data = await _read_json_object(request)
        name = _bounded_text(data.get("name"), "name", MAX_NAME_CHARS)
        await asyncio.to_thread(get_index().delete, name)
    except (FileNotFoundError, ValueError) as exc:
        return _error(str(exc), ok=False)
    except Exception:
        logger.exception("Could not delete wildcard")
        return _error("couldn't delete wildcard", 500, ok=False)
    return web.json_response({"ok": True})


@routes.post("/prompt_palette/refresh")
async def refresh_index(request):
    index = get_index()
    try:
        await asyncio.to_thread(index.rescan, True)
        items = index.flat_list()
    except Exception:
        logger.exception("Could not refresh wildcard index")
        return _error("couldn't refresh wildcard index", 500, ok=False)
    return web.json_response({"ok": True, "count": len(items), "items": items})


_ALLOW_REMOTE_SET_PATH_ENV = "PROMPT_PALETTE_ALLOW_REMOTE_SET_PATH"
_FORWARD_HEADERS = ("X-Forwarded-For", "Forwarded", "X-Real-IP")


def _request_is_local(request: web.Request) -> bool:
    """True for direct loopback connections; proxied requests can't be verified."""
    if any(request.headers.get(name) for name in _FORWARD_HEADERS):
        return False
    remote = (request.remote or "").split("%", 1)[0]
    try:
        address = ipaddress.ip_address(remote)
    except ValueError:
        return False
    mapped = getattr(address, "ipv4_mapped", None)
    return bool((mapped or address).is_loopback)


def _remote_set_path_allowed() -> bool:
    return os.environ.get(_ALLOW_REMOTE_SET_PATH_ENV, "").strip().lower() in {"1", "true", "yes", "on"}


@routes.post("/prompt_palette/set_path")
async def set_path(request):
    index = get_index()
    try:
        data = await _read_json_object(request)
        path = _bounded_text(data.get("path"), "path", MAX_PATH_CHARS)
        if path.strip():
            if not _request_is_local(request) and not _remote_set_path_allowed():
                return _error(
                    "changing the wildcard folder is only allowed from the machine running ComfyUI. "
                    f"Set {_ALLOW_REMOTE_SET_PATH_ENV}=1 to allow it for remote or proxied sessions, "
                    "or configure wildcards_config.json / extra_model_paths.yaml instead",
                    403,
                    ok=False,
                )
            await asyncio.to_thread(index.set_root, path)
        else:
            await asyncio.to_thread(index.reset_root)
    except ValueError as exc:
        return _error(str(exc), ok=False)
    except Exception:
        logger.exception("Could not update wildcard path")
        return _error("couldn't update wildcard path", 500, ok=False)
    return web.json_response({"ok": True, "root_dir": index.get_root_dir()})


@routes.post("/prompt_palette/resolve")
async def resolve_prompt(request):
    try:
        data = await _read_json_object(request, limit=None)
        text = _bounded_text(data.get("text"), "text", limit=None)
        seed = _bounded_int(data.get("seed", 0), "seed")
        mode = data.get("mode", "entire text as one")
        if not isinstance(mode, str) or mode not in {"entire text as one", "line by line"}:
            raise ValueError("invalid processing mode")
    except ValueError as exc:
        return _error(str(exc))

    try:
        index = await _get_fresh_index()
    except Exception:
        logger.exception("Could not load wildcard index for prompt resolution")
        return _error("couldn't load wildcard library", 500)

    def resolve_and_count():
        resolver = WildcardResolver(index.preview_view())
        resolved = (
            "\n".join(resolver.resolve_lines(text, seed=seed))
            if mode == "line by line"
            else resolver.resolve(text, seed=seed)
        )
        response: dict[str, Any] = {"resolved": resolved}
        token_stats = count_clip_tokens(resolved)
        if token_stats is not None:
            response["token_stats"] = token_stats
        return response

    try:
        response = await asyncio.to_thread(resolve_and_count)
    except ValueError as exc:
        return _error(str(exc))
    except Exception:
        logger.exception("Prompt resolution failed")
        return _error("prompt resolution failed", 500)
    return web.json_response(response)


@routes.post("/prompt_palette/resolve_variations")
async def resolve_variations(request):
    try:
        data = await _read_json_object(request, limit=None)
        text = _bounded_text(data.get("text"), "text", limit=None)
        seed = _bounded_int(data.get("seed", 0), "seed")
        count = _bounded_int(data.get("count", 4), "count", minimum=1, maximum=16)
        mode = data.get("mode", "entire text as one")
        if not isinstance(mode, str) or mode not in {"entire text as one", "line by line"}:
            raise ValueError("invalid processing mode")
    except ValueError as exc:
        return _error(str(exc))

    try:
        index = await _get_fresh_index()
    except Exception:
        logger.exception("Could not load wildcard index for variations")
        return _error("couldn't load wildcard library", 500)

    def generate():
        results = []
        preview_index = index.preview_view()
        for offset in range(count):
            current_seed = (seed + offset) & UINT64_MAX
            resolver = WildcardResolver(preview_index)
            resolved = (
                "\n".join(resolver.resolve_lines(text, seed=current_seed))
                if mode == "line by line"
                else resolver.resolve(text, seed=current_seed)
            )
            stats = count_clip_tokens(resolved)
            results.append({
                "seed": current_seed,
                "resolved": resolved,
                "wildcards": sorted(set(resolver.used_names)),
                "token_stats": stats,
            })
        return results

    try:
        results = await asyncio.to_thread(generate)
    except ValueError as exc:
        return _error(str(exc))
    except Exception:
        logger.exception("Variation generation failed")
        return _error("variation generation failed", 500)
    return web.json_response({"variations": results, "count": len(results)})


@routes.post("/prompt_palette/resolve_combinatorial")
async def resolve_combinatorial(request):
    try:
        data = await _read_json_object(request, limit=None)
        text = _bounded_text(data.get("text"), "text", limit=None)
        seed = _bounded_int(data.get("seed", 0), "seed")
        requested_max = _bounded_int(
            data.get("max_prompts", 0),
            "max_prompts",
            maximum=WildcardResolver.MAX_COMBINATORIAL_PROMPTS,
        )
    except ValueError as exc:
        return _error(str(exc))

    max_prompts = requested_max or None
    try:
        index = await _get_fresh_index()
    except Exception:
        logger.exception("Could not load wildcard index for combinatorial resolution")
        return _error("couldn't load wildcard library", 500)

    def generate():
        resolver = WildcardResolver(index)
        prompts = resolver.generate_combinatorial(text, seed=seed, max_prompts=max_prompts)
        return prompts, resolver.last_generation_truncated

    try:
        prompts, truncated = await asyncio.to_thread(generate)
    except ValueError as exc:
        return _error(str(exc))
    except Exception:
        logger.exception("Combinatorial resolution failed")
        return _error("combinatorial resolution failed", 500)
    return web.json_response({"resolved": prompts, "count": len(prompts), "truncated": truncated})


@routes.post("/prompt_palette/count_combinatorial")
async def count_combinatorial(request):
    try:
        data = await _read_json_object(request, limit=None)
        text = _bounded_text(data.get("text"), "text", limit=None)
        seed = _bounded_int(data.get("seed", 0), "seed")
        requested_max = _bounded_int(
            data.get("max_prompts", 0),
            "max_prompts",
            maximum=WildcardResolver.MAX_COMBINATORIAL_PROMPTS,
        )
    except ValueError as exc:
        return _error(str(exc))

    cap = requested_max or WildcardResolver.MAX_COMBINATORIAL_PROMPTS
    try:
        index = await _get_fresh_index()
    except Exception:
        logger.exception("Could not load wildcard index for combinatorial count")
        return _error("couldn't load wildcard library", 500)

    def count():
        resolver = WildcardResolver(index)
        return resolver.count_combinatorial(text, seed=seed, limit=min(COUNT_ONLY_LIMIT, cap))

    try:
        result_count, truncated = await asyncio.to_thread(count)
    except ValueError as exc:
        return _error(str(exc))
    except Exception:
        logger.exception("Combinatorial count failed")
        return _error("combinatorial count failed", 500)
    return web.json_response({"count": result_count, "truncated": truncated, "cap": cap})


def _resolve_within_root(root_dir: str, rel_path: str) -> str | None:
    if not isinstance(rel_path, str) or "\x00" in rel_path:
        return None
    raw_path = rel_path.strip()
    if not raw_path or raw_path.startswith(("/", "\\")) or os.path.isabs(raw_path):
        return None
    rel_path = raw_path.replace("\\", "/")
    if not rel_path or any(part in {"", ".", ".."} for part in rel_path.split("/")):
        return None
    root = os.path.realpath(root_dir)
    abs_path = os.path.realpath(os.path.join(root, *rel_path.split("/")))
    try:
        return abs_path if os.path.commonpath([root, abs_path]) == root else None
    except ValueError:
        return None


def _thumbnail_map(root: str) -> dict[str, str | None]:
    mapping: dict[str, str | None] = {}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(
            (name for name in dirnames if name not in {".git", "__pycache__"}),
            key=str.casefold,
        )
        rel_dir = os.path.relpath(dirpath, root)
        rel_dir = "" if rel_dir == "." else rel_dir.replace(os.sep, "/")
        lower_lookup = {filename.lower(): filename for filename in filenames}
        for filename in filenames:
            if not filename.lower().endswith(".txt"):
                continue
            base = filename[:-4]
            name_key = f"{rel_dir}/{base}" if rel_dir else base
            thumbnail = None
            for extension in THUMB_EXTS:
                match = lower_lookup.get((base + extension).lower())
                if match:
                    thumbnail = f"{rel_dir}/{match}" if rel_dir else match
                    break
            mapping[name_key] = thumbnail
    return mapping


_LIBRARY_TOKEN_RE = re.compile(r"__([+\-*%~@]?)([A-Za-z0-9_\-/*]+)(?:\([^()]*\))?__")


def _library_health_payload(index) -> dict[str, Any]:
    names = index.all_names()
    known = set(names)
    empty_entries: list[dict[str, Any]] = []
    digest_groups: dict[str, list[str]] = {}
    broken_recipes: list[dict[str, Any]] = []

    for name in names:
        entry = index.get_entry(name)
        if not entry:
            continue
        lines = list(entry.get("lines", []))
        if not lines:
            empty_entries.append({"path": name, "type": entry.get("type", "txt")})
        normalized = "\n".join(line.strip() for line in lines if str(line).strip())
        if normalized:
            digest = hashlib.sha256(normalized.encode("utf-8")).hexdigest()
            digest_groups.setdefault(digest, []).append(name)

        root_name = name.split("/", 1)[0].lower()
        if root_name in {"recipe", "recipes"}:
            refs = []
            for match in _LIBRARY_TOKEN_RE.finditer("\n".join(lines)):
                ref = match.group(2)
                if "*" in ref:
                    continue
                if ref not in known:
                    refs.append(ref)
            if refs:
                broken_recipes.append({"path": name, "missing": sorted(set(refs))})

    duplicate_groups = [
        {"paths": sorted(paths), "count": len(paths)}
        for paths in digest_groups.values()
        if len(paths) > 1
    ]
    duplicate_groups.sort(key=lambda item: (-item["count"], item["paths"][0].casefold()))

    root = os.path.realpath(index.get_root_dir())
    orphan_thumbnails: list[dict[str, str]] = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [name for name in dirnames if name not in {".git", "__pycache__"}]
        lower_names = {filename.lower() for filename in filenames}
        for filename in filenames:
            if not filename.lower().endswith(THUMB_EXTS):
                continue
            stem = os.path.splitext(filename)[0]
            if f"{stem}.txt".lower() in lower_names:
                continue
            abs_path = os.path.realpath(os.path.join(dirpath, filename))
            if not _resolve_within_root(root, os.path.relpath(abs_path, root).replace(os.sep, "/")):
                continue
            rel = os.path.relpath(abs_path, root).replace(os.sep, "/")
            orphan_thumbnails.append({"file": rel})

    return {
        "root_dir": root,
        "entry_count": len(names),
        "emptyEntries": sorted(empty_entries, key=lambda item: item["path"].casefold()),
        "duplicateGroups": duplicate_groups,
        "brokenRecipes": sorted(broken_recipes, key=lambda item: item["path"].casefold()),
        "orphanThumbnails": sorted(orphan_thumbnails, key=lambda item: item["file"].casefold()),
    }


@routes.get("/prompt_palette/library_health")
async def library_health(request):
    try:
        index = await _get_fresh_index()
        payload = await asyncio.to_thread(_library_health_payload, index)
        return web.json_response(payload)
    except Exception:
        logger.exception("Could not audit Prompt Palette library")
        return _error("couldn't audit Prompt Library", 500)


@routes.post("/prompt_palette/library_action")
async def library_action(request):
    try:
        data = await _read_json_object(request)
        action = _bounded_text(data.get("action"), "action", 64).strip().lower()
        source = _bounded_text(data.get("source"), "source", MAX_NAME_CHARS).strip()
        target = _bounded_text(data.get("target"), "target", MAX_NAME_CHARS).strip()
        index = await _get_fresh_index()

        if action == "rename":
            if not source or not target:
                raise ValueError("source and target are required")
            await asyncio.to_thread(index.rename_txt, source, target)
        elif action == "copy":
            if not source or not target:
                raise ValueError("source and target are required")
            await asyncio.to_thread(index.copy_txt, source, target)
        elif action == "delete":
            if not source:
                raise ValueError("source is required")
            entry = index.get_entry(source)
            base_path = os.path.splitext(entry.get("abs_path", ""))[0] if entry else ""
            await asyncio.to_thread(index.delete, source)
            if base_path:
                for extension in THUMB_EXTS:
                    thumb = base_path + extension
                    if os.path.isfile(thumb):
                        try:
                            await asyncio.to_thread(os.remove, thumb)
                        except FileNotFoundError:
                            pass
        elif action == "remove_orphan_thumbnail":
            if not source:
                raise ValueError("source is required")
            abs_path = _resolve_within_root(index.get_root_dir(), source)
            if not abs_path or not abs_path.lower().endswith(THUMB_EXTS) or not os.path.isfile(abs_path):
                raise ValueError("thumbnail was not found")
            base = os.path.splitext(abs_path)[0]
            if os.path.isfile(base + ".txt"):
                raise ValueError("thumbnail belongs to an existing wildcard")
            await asyncio.to_thread(os.remove, abs_path)
        else:
            raise ValueError("unsupported library action")

        await asyncio.to_thread(index.rescan, True)
        return web.json_response({"ok": True, "action": action})
    except (FileNotFoundError, ValueError) as exc:
        return _error(str(exc), ok=False)
    except OSError:
        logger.exception("Prompt Library action failed")
        return _error("library action failed", 500, ok=False)
    except Exception:
        logger.exception("Prompt Library action failed")
        return _error("library action failed", 500, ok=False)


@routes.post("/prompt_palette/library_batch")
async def library_batch(request):
    try:
        data = await _read_json_object(request)
        action = _bounded_text(data.get("action"), "action", 64).strip().lower()
        raw_sources = data.get("sources", [])
        if not isinstance(raw_sources, list) or not raw_sources or len(raw_sources) > 250:
            raise ValueError("sources must contain between 1 and 250 library entries")
        sources = []
        for value in raw_sources:
            source = _bounded_text(value, "source", MAX_NAME_CHARS).strip()
            if not source or source in sources:
                continue
            sources.append(source)
        if not sources:
            raise ValueError("no library entries were selected")
        destination = _bounded_text(data.get("destination"), "destination", MAX_NAME_CHARS).strip().strip("/\\")
        index = await _get_fresh_index()
        known = set(index.all_names())
        targets: list[tuple[str, str]] = []
        if action == "add_prefix" and any(char in destination for char in "\\/:*?\"<>|"):
            raise ValueError("prefix contains characters that are not valid in Windows filenames")

        for raw_source in sources:
            source = index.normalize_name(raw_source)
            entry = index.get_entry(source)
            if not entry:
                raise ValueError(f"{source} was not found")
            if entry.get("type") != "txt":
                raise ValueError(f"{source} is not a TXT-backed entry")
            parent, _, basename = source.rpartition("/")
            if action in {"move_to_folder", "copy_to_folder"}:
                if not destination:
                    raise ValueError("destination folder is required")
                target = index.normalize_name(f"{destination}/{basename}")
            elif action == "add_prefix":
                if not destination:
                    raise ValueError("prefix is required")
                target = index.normalize_name(f"{parent + '/' if parent else ''}{destination}{basename}")
            else:
                raise ValueError("unsupported batch library action")
            targets.append((source, target))

        target_names = [target for _, target in targets]
        if len(set(target_names)) != len(target_names):
            raise ValueError("the batch would create duplicate target names")
        for source, target in targets:
            if target in known:
                raise ValueError(f"{target} already exists")
            if source == target:
                raise ValueError(f"{source} is already at the requested destination")
            index.assert_txt_target_available(target)

        completed = []
        try:
            for source, target in targets:
                if action == "copy_to_folder":
                    await asyncio.to_thread(index.copy_txt, source, target)
                else:
                    await asyncio.to_thread(index.rename_txt, source, target)
                completed.append({"source": source, "target": target})
        except Exception:
            # Batch operations are all-or-nothing where the filesystem permits it.
            # Roll back earlier successful items before surfacing the original error.
            for item in reversed(completed):
                source = item["source"]
                target = item["target"]
                try:
                    if action == "copy_to_folder":
                        target_entry = index.get_entry(target)
                        base_path = os.path.splitext(target_entry.get("abs_path", ""))[0] if target_entry else ""
                        await asyncio.to_thread(index.delete, target)
                        if base_path:
                            for extension in THUMB_EXTS:
                                thumb = base_path + extension
                                if os.path.isfile(thumb):
                                    await asyncio.to_thread(os.remove, thumb)
                    else:
                        await asyncio.to_thread(index.rename_txt, target, source)
                except Exception:
                    logger.exception("Prompt Palette could not fully roll back a batch library action")
            raise
        return web.json_response({"ok": True, "action": action, "items": completed})
    except (FileNotFoundError, ValueError) as exc:
        return _error(str(exc), ok=False)
    except OSError:
        logger.exception("Prompt Library batch action failed")
        return _error("library batch action failed", 500, ok=False)
    except Exception:
        logger.exception("Prompt Library batch action failed")
        return _error("library batch action failed", 500, ok=False)


@routes.get("/prompt_palette/categories")
async def get_thumbnail_map(request):
    try:
        root = os.path.realpath(get_index().get_root_dir())
        return web.json_response(await asyncio.to_thread(_thumbnail_map, root))
    except Exception:
        logger.exception("Could not load thumbnail map")
        return _error("couldn't load thumbnail map", 500)


@routes.get("/prompt_palette/thumb")
async def get_thumbnail(request):
    rel_file = request.rel_url.query.get("file", "")[:MAX_NAME_CHARS]
    if not rel_file.lower().endswith(THUMB_EXTS):
        raise web.HTTPNotFound()
    abs_path = _resolve_within_root(get_index().get_root_dir(), rel_file)
    if not abs_path or not os.path.isfile(abs_path):
        raise web.HTTPNotFound()
    return web.FileResponse(abs_path)


def _image_extension(data: bytes) -> str | None:
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return ".png"
    if data.startswith(b"\xff\xd8\xff"):
        return ".jpg"
    return None


def _atomic_write_bytes(path: str, data: bytes) -> None:
    directory = os.path.dirname(path) or "."
    os.makedirs(directory, exist_ok=True)
    fd, temp_path = tempfile.mkstemp(prefix=f".{os.path.basename(path)}.", suffix=".tmp", dir=directory)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, path)
    except Exception:
        try:
            os.unlink(temp_path)
        except OSError:
            pass
        raise


async def _read_thumbnail_multipart(request: web.Request) -> tuple[str, bytes, str]:
    if request.content_length is not None and request.content_length > MAX_THUMB_BYTES + 64 * 1024:
        raise ValueError("file too large (max 8MB)")
    reader = await request.multipart()
    name = ""
    filename = ""
    image = bytearray()
    async for part in reader:
        if part.name == "name":
            raw_name = await part.read(decode=False)
            if len(raw_name) > MAX_NAME_CHARS * 4:
                raise ValueError("name is too long")
            try:
                name = raw_name.decode("utf-8").strip()
            except UnicodeDecodeError as exc:
                raise ValueError("name must be valid UTF-8") from exc
            if len(name) > MAX_NAME_CHARS:
                raise ValueError("name is too long")
        elif part.name == "file":
            filename = part.filename or ""
            while True:
                chunk = await part.read_chunk(size=64 * 1024)
                if not chunk:
                    break
                image.extend(chunk)
                if len(image) > MAX_THUMB_BYTES:
                    raise ValueError("file too large (max 8MB)")
    if not name or not image:
        raise ValueError("missing name or file")
    extension = _image_extension(bytes(image))
    if extension is None:
        raise ValueError("only valid PNG or JPEG images are supported")
    supplied_extension = os.path.splitext(filename.lower())[1]
    if supplied_extension and supplied_extension not in THUMB_EXTS:
        raise ValueError("only .jpg/.jpeg/.png supported")
    return name, bytes(image), extension


@routes.post("/prompt_palette/set_thumbnail")
async def set_thumbnail(request):
    try:
        name, image, extension = await _read_thumbnail_multipart(request)
        index = get_index()
        entry = index.get_entry(name)
        if not entry or entry["type"] != "txt":
            raise ValueError("thumbnail target must be an existing .txt wildcard")
        target_base = os.path.splitext(entry["abs_path"])[0]

        def write_thumbnail():
            target = target_base + extension
            _atomic_write_bytes(target, image)
            for other_extension in THUMB_EXTS:
                stale = target_base + other_extension
                if stale != target and os.path.isfile(stale):
                    os.remove(stale)

        await asyncio.to_thread(write_thumbnail)
    except ValueError as exc:
        return _error(str(exc), ok=False)
    except web.HTTPException as exc:
        return _error(exc.reason or "invalid thumbnail request", 400, ok=False)
    except OSError:
        logger.exception("Could not save thumbnail")
        return _error("couldn't save thumbnail", 500, ok=False)
    except Exception:
        logger.exception("Could not process thumbnail")
        return _error("couldn't process thumbnail", 500, ok=False)
    return web.json_response({"ok": True})


@routes.post("/prompt_palette/remove_thumbnail")
async def remove_thumbnail(request):
    try:
        data = await _read_json_object(request)
        name = _bounded_text(data.get("name"), "name", MAX_NAME_CHARS).strip()
        if not name:
            raise ValueError("missing name")
        entry = get_index().get_entry(name)
        if not entry or entry["type"] != "txt":
            raise ValueError("thumbnail target must be an existing .txt wildcard")
        target_base = os.path.splitext(entry["abs_path"])[0]

        def remove_files():
            removed = False
            for extension in THUMB_EXTS:
                path = target_base + extension
                if os.path.isfile(path):
                    os.remove(path)
                    removed = True
            return removed

        removed = await asyncio.to_thread(remove_files)
    except ValueError as exc:
        return _error(str(exc), ok=False)
    except OSError:
        logger.exception("Could not remove thumbnail")
        return _error("couldn't remove thumbnail", 500, ok=False)
    except Exception:
        logger.exception("Could not process thumbnail removal")
        return _error("couldn't process thumbnail removal", 500, ok=False)
    return web.json_response({"ok": True, "removed": removed})
