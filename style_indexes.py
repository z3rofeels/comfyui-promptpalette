"""Local style catalogs. No network clients, remote images, or runtime downloads."""
from __future__ import annotations

import base64
import io
import hashlib
import json
import os
import re
import tempfile
import threading
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path

BUNDLE = Path(__file__).resolve().parent / "assets" / "styles"
MAX_INDEX_BYTES = 32 * 1024 * 1024
_lock = threading.RLock()


def user_directory():
    try:
        import folder_paths
        root = Path(folder_paths.get_user_directory()) / "prompt_palette"
    except (ImportError, AttributeError, TypeError):
        root = Path.home() / ".prompt_palette"
    return root / "styles"


def _text(value, limit=500):
    if not isinstance(value, str) or len(value) > limit or "\x00" in value:
        raise ValueError(f"Expected text up to {limit} characters.")
    return value.strip()


def _words(value):
    if isinstance(value, str):
        value = value.split(",")
    if not isinstance(value, list) or len(value) > 64:
        raise ValueError("Tags and aliases must be lists of at most 64 strings.")
    return list(dict.fromkeys(_text(v, 100) for v in value if v))


def _thumbnail(value):
    if not value:
        return ""
    if not isinstance(value, str) or len(value) > 360_000:
        raise ValueError("Preview must be an embedded PNG, JPEG or WebP under 256 KB.")
    match = re.fullmatch(r"data:image/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)", value)
    if not match:
        raise ValueError("Only embedded raster previews are accepted; online URLs are not loaded.")
    try:
        from PIL import Image
        raw = base64.b64decode(match[2], validate=True)
        if len(raw) > 262144:
            raise ValueError()
        with Image.open(io.BytesIO(raw)) as image:
            expected = {"png": "PNG", "jpeg": "JPEG", "webp": "WEBP"}[match[1]]
            if image.format != expected or image.width * image.height > 16_000_000:
                raise ValueError()
            image.verify()
    except Exception as error:
        raise ValueError("Invalid or oversized embedded raster preview.") from error
    return value


FACETS = ("medium", "treatment", "design", "color", "mood", "subject", "discipline")
CATEGORIES = ("artist", "general", "character", "copyright", "meta")
ASSETS = Path(__file__).resolve().parent / "web" / "assets" / "styles"


def _provenance(data, kind, thumbnail, tag, bundled_reference=False):
    if not isinstance(data, dict):
        raise ValueError("Preview provenance must be an object.")
    data = dict(data)
    if type(data.get("seed")) is int:
        data["seed"] = str(data["seed"])
    if isinstance(data.get("settings"), dict):
        data["settings"] = json.dumps(data["settings"], ensure_ascii=False, allow_nan=False)
    result = {key: _text(data.get(key, ""), limit) for key, limit in
              (("source", 1000), ("author", 300), ("license", 300), ("title", 500),
               ("date", 200), ("institution", 300), ("rightsURL", 1000), ("referenceNote", 2000), ("model", 300),
               ("checkpoint", 300), ("prompt", 8000), ("subjectPrompt", 2000),
               ("seed", 100), ("settings", 4000), ("styleText", 2000), ("tag", 300), ("recordedAt", 100))}
    if kind == "model_sample":
        if not thumbnail or data.get("confirmed") is not True or result["tag"] != tag or any(
                not result[key] for key in ("source", "model", "prompt", "seed", "settings", "styleText")):
            raise ValueError("Model samples need an actual image, exact tag, prompt, model, seed, settings, source and explicit confirmation.")
        if result["styleText"] not in result["prompt"]:
            raise ValueError("The recorded render prompt must contain the exact style text used.")
        result["confirmed"] = True
        result["recordedAt"] = result["recordedAt"] or datetime.now(timezone.utc).isoformat()
    elif kind == "reference" and (not (thumbnail or bundled_reference) or any(not result[key] for key in ("source", "author", "license"))):
        raise ValueError("Reference artworks need an image, source, creator and redistribution license.")
    if thumbnail:
        result["imageSha256"] = hashlib.sha256(base64.b64decode(thumbnail.split(",", 1)[1])).hexdigest()
    return {key: value for key, value in result.items() if value != ""}


def normalize_index(data, trusted=False):
    if isinstance(data, list):
        data = {"name": "Imported styles", "entries": data}
    if not isinstance(data, dict):
        raise ValueError("Choose a JSON object with name and entries, or a list of artists.")
    entries = data.get("entries", data.get("artists"))
    if not isinstance(entries, list) or not 1 <= len(entries) <= 150000:
        raise ValueError("An index needs 1–150,000 entries.")
    result, seen, ids = [], set(), set()
    for row in entries:
        if isinstance(row, str):
            row = {"tag": row}
        if not isinstance(row, dict):
            raise ValueError("Each entry must be a string or an object.")
        tag = _text(row.get("tag", row.get("name", "")), 300)
        if not tag:
            raise ValueError("Each entry needs a tag or name.")
        category = row.get("category", "artist")
        if category not in CATEGORIES:
            raise ValueError("Unknown style entry category.")
        key = category + ":" + tag.casefold()
        if key in seen:
            continue
        seen.add(key)
        entry_id = _text(row.get("id", tag), 300)
        if not entry_id or entry_id in ids:
            raise ValueError("Entry IDs must be non-empty and unique.")
        ids.add(entry_id)
        count = row.get("count", row.get("post_count"))
        if count is not None and (type(count) is not int or not 0 <= count <= 10**12):
            raise ValueError("Post count must be a non-negative integer, or null when unknown.")
        facets = row.get("facets", {})
        insertion = row.get("insertion", {})
        if not isinstance(facets, dict) or not isinstance(insertion, dict):
            raise ValueError("Facets and insertion must be objects.")
        thumbnail = _thumbnail(row.get("thumbnail", ""))
        # Client-supplied SVGs/URLs/paths are never trusted or rendered.
        asset = _text(row.get("asset", ""), 100) if trusted else ""
        if asset and not re.fullmatch(r"[a-z0-9-]+\.(?:svg|webp|jpg|png)", asset):
            raise ValueError("Invalid bundled preview path.")
        if asset and not (ASSETS / asset).is_file():
            asset = ""  # One missing illustration must not disable its catalog.
        kind = row.get("previewKind", "user") if thumbnail else row.get("previewKind", "reference" if not asset.endswith(".svg") else "illustration") if asset else "none"
        if kind not in ("user", "reference", "model_sample", "illustration", "none") or (thumbnail and kind in ("none", "illustration")):
            raise ValueError("Invalid preview kind.")
        provenance = _provenance(row.get("provenance", {}), kind, thumbnail, tag, bundled_reference=trusted and bool(asset))
        if asset:
            provenance["imageSha256"] = hashlib.sha256((ASSETS / asset).read_bytes()).hexdigest()
        result.append({"id": entry_id, "kind": "curated_style" if row.get("kind") == "curated_style" else "artist" if category == "artist" else "tag",
                       "tag": tag, "name": _text(row.get("name", tag), 300), "category": category,
                       "count": count, "tags": _words(row.get("tags", [])), "aliases": _words(row.get("aliases", [])),
                       "facets": {key: _words(facets[key]) for key in FACETS if facets.get(key)},
                       "insertion": {key: _text(insertion[key], 2000) for key in ("tags", "natural") if insertion.get(key)},
                       "compatibility": "Technique vocabulary · checkpoint support unknown" if row.get("kind") == "curated_style" else "Artist / tag support unknown",
                       "description": _text(row.get("description", ""), 2000), "thumbnail": thumbnail,
                       "asset": asset, "previewKind": kind, "provenance": provenance})
    return {"version": 2, "name": _text(data.get("name", "Imported styles"), 120),
            "description": _text(data.get("description", ""), 2000),
            "source": _text(data.get("source", "User supplied local index"), 1000), "entries": result}

def _paths():
    paths = {"builtin:" + p.stem: p for p in BUNDLE.glob("*.json")}
    paths.update({"user:" + p.stem: p for p in user_directory().glob("*.json")})
    return paths


@lru_cache(maxsize=8)
def _read(path, mtime, size):
    if size > MAX_INDEX_BYTES:
        raise ValueError("Index exceeds the 32 MB limit.")
    return normalize_index(json.loads(Path(path).read_text(encoding="utf-8-sig")), trusted=Path(path).parent == BUNDLE)


@lru_cache(maxsize=2)
def _booru_index(path, mtime, artists):
    import sqlite3
    with sqlite3.connect(path) as connection:
        rows = connection.execute("SELECT tag, category, post_count, aliases FROM tags WHERE category " +
                                  ("='artist'" if artists else "!='artist'") + " ORDER BY post_count DESC").fetchall()
    return {"version": 2, "name": "Artists · local Booru directory" if artists else "Tags · local Booru directory",
            "description": "Literal tags from the existing local Booru database. Frequency is not model support. Artists without evidence have no inferred style labels or previews.",
            "source": "Existing bundled Danbooru CSV · PYU224/tagdb-updater", "entries": [
                {"tag": tag, "name": tag.replace("_", " "), "kind": "artist" if category == "artist" else "tag",
                 "category": category, "count": count, "aliases": aliases.split(",") if aliases else [],
                 "tags": [], "facets": {}, "description": "", "thumbnail": "", "previewKind": "none"}
                for tag, category, count, aliases in rows]}


def get_index(index_id):
    if index_id in ("favorites", "previews"):
        return personal_collection(index_id)
    if index_id in ("booru", "tags"):
        from .booru_database import active_db_path
        path = Path(active_db_path())
        return _booru_index(str(path), path.stat().st_mtime_ns, index_id != "tags")
    path = _paths().get(index_id)
    if path is None:
        raise ValueError("Unknown local style index.")
    stat = path.stat()
    return _read(str(path), stat.st_mtime_ns, stat.st_size)


@lru_cache(maxsize=4)
def _snapshot_info(path, mtime, size):
    if size > MAX_INDEX_BYTES:
        raise ValueError("Snapshot exceeds the 32 MB limit.")
    data = json.loads(Path(path).read_text(encoding="utf-8-sig"))
    return _text(data.get("name", "Anima artist snapshot"), 120), len(data.get("entries", []))


def list_indexes():
    # Count using the existing SQLite index, without loading 187k record objects
    # just to open the 96-preset landing view.
    from .booru_database import active_db_path
    import sqlite3
    with sqlite3.connect(active_db_path()) as connection:
        counts = dict(connection.execute("SELECT category, COUNT(*) FROM tags GROUP BY category"))
    result = [{"id": "booru", "name": "Artists · local Booru directory", "count": counts.get("artist", 0)},
              {"id": "tags", "name": "Tags · local Booru directory", "count": sum(v for k, v in counts.items() if k != "artist")}]
    for key in sorted(_paths()):
        try:
            if key == "builtin:anima":
                path = _paths()[key]; stat = path.stat()
                name, count = _snapshot_info(str(path), stat.st_mtime_ns, stat.st_size)
                result.append({"id": key, "name": name, "count": count})
            else:
                data = get_index(key)
                result.append({"id": key, "name": data["name"], "count": len(data["entries"])})
        except (ValueError, OSError):
            result.append({"id": key, "name": key + " (unreadable)", "count": 0})
    return result


def _write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    raw = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    if len(raw.encode("utf-8")) > MAX_INDEX_BYTES:
        raise ValueError("Index exceeds the 32 MB limit; use fewer or smaller previews.")
    fd, tmp = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(raw)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def import_index(data):
    normalized = normalize_index(data)
    digest = hashlib.sha256(json.dumps(normalized, sort_keys=True).encode()).hexdigest()[:24]
    _write(user_directory() / (digest + ".json"), normalized)
    return "user:" + digest


def _annotation_path(index_id):
    # IDs are opaque: they can never become a filesystem path supplied by a client.
    digest = hashlib.sha256(_text(index_id, 200).encode()).hexdigest()
    return user_directory() / "annotations" / (digest + ".json")


@lru_cache(maxsize=32)
def _read_annotations(path, mtime, size):
    if size > MAX_INDEX_BYTES:
        raise ValueError("Annotations exceed the 32 MB limit.")
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("Invalid saved annotations.")
    result = {}
    for tag, row in data.items():
        if not isinstance(row, dict):
            continue
        _text(tag, 300)
        item = {"version": 2}
        if "tags" in row:
            item["tags"] = _words(row["tags"])
        if "description" in row:
            item["description"] = _text(row["description"], 2000)
        if "favorite" in row:
            item["favorite"] = row["favorite"] is True
        if "thumbnail" in row:
            # Damaged legacy files fall back honestly without making the entire
            # explorer unavailable. A save still validates new images strictly.
            try:
                item["thumbnail"] = _thumbnail(row["thumbnail"])
                kind = row.get("previewKind", "user") if item["thumbnail"] else "none"
                if kind not in ("user", "reference", "model_sample", "none") or (item["thumbnail"] and kind == "none"):
                    kind = "user" if item["thumbnail"] else "none"
                item["provenance"] = _provenance(row.get("provenance", {}), kind, item["thumbnail"], tag)
                item["previewKind"] = kind
            except ValueError:
                item["thumbnail"], item["previewKind"] = "", "none"
        result[tag] = item
    return result


def _stored_annotations(index_id):
    path = _annotation_path(index_id)
    if not path.exists():
        return {}
    stat = path.stat()
    return _read_annotations(str(path), stat.st_mtime_ns, stat.st_size)


def annotations(index_id):
    # Collection identity stays separate; restoring the snapshot never overwrites
    # annotations made in the standard Booru directory.
    return dict(_stored_annotations(index_id))

def save_annotation(data):
    index_id = _text(data.get("index", ""), 200)
    tag = _text(data.get("tag", ""), 300)
    if not index_id or not tag:
        raise ValueError("Index and tag are required.")
    # Partial updates retain every other override. Favorites never freeze defaults.
    with _lock:
        values = annotations(index_id)
        item = dict(values.get(tag, {}))
        item["version"] = 2
        if "tags" in data:
            item["tags"] = _words(data["tags"])
        if "description" in data:
            item["description"] = _text(data["description"], 2000)
        if "favorite" in data:
            item["favorite"] = data["favorite"] is True
        if data.get("resetPreview") is True:
            for key in ("thumbnail", "previewKind", "provenance"):
                item.pop(key, None)
        elif "thumbnail" in data:
            item["thumbnail"] = _thumbnail(data["thumbnail"])
            kind = data.get("previewKind", "user") if item["thumbnail"] else "none"
            if kind not in ("user", "reference", "model_sample", "none") or (item["thumbnail"] and kind == "none"):
                raise ValueError("Invalid preview kind.")
            item["previewKind"] = kind
            item["provenance"] = _provenance(data.get("provenance", {}), kind, item["thumbnail"], tag)
        values[tag] = item
        _write(_annotation_path(index_id), values)
    return item

def search_artists(query, limit=60, index_id="booru"):
    tokens = query.casefold().replace("_", " ").split()[:6]
    if not tokens and index_id != "builtin:anima":
        return []
    data = get_index(index_id)
    matches = []
    for row in data["entries"]:
        if all(t in row["tag"].casefold().replace("_", " ") for t in tokens):
            matches.append({"value": row["tag"], "label": row["name"], "kind": "booru", "category": "artist", "count": row["count"] or 0, **({"source": "anima", "section": "Anima Artists", "insertMode": "plain"} if index_id == "builtin:anima" else {})})
            if len(matches) >= limit:
                break
    return matches



def personal_collection(mode):
    """Project existing annotations into a view; never create another store."""
    keys = ["booru", "tags", *_paths(), "custom"]
    entries = []
    used = set()
    for index_id in keys:
        values = annotations(index_id)
        wanted = {tag: item for tag, item in values.items() if isinstance(item, dict) and
                  (item.get("favorite") is True if mode == "favorites" else bool(item.get("thumbnail")))}
        if not wanted:
            continue
        source_rows = {r["tag"]: r for r in get_index(index_id)["entries"] if r["tag"] in wanted} if index_id != "custom" else {}
        for tag, item in wanted.items():
            key = (index_id, tag)
            if key in used:
                continue
            used.add(key)
            base = source_rows.get(tag, {"tag": tag, "name": tag, "category": "artist" if index_id in ("booru", "builtin:anima") else "general", "kind": "artist" if index_id in ("booru", "builtin:anima") else "tag", "count": None, "tags": []})
            row = {**base, **item, "originIndex": index_id}
            if "thumbnail" in item:
                row["asset"] = ""
                row["previewKind"] = item.get("previewKind", "user" if item["thumbnail"] else "none")
            if index_id == "custom":
                row["insertKind"] = "custom"
            entries.append(row)
    return {"version": 2, "name": "Favorites" if mode == "favorites" else "My previews",
            "description": "Your saved items across local collections. Originals and overrides stay separate.",
            "source": "Existing local style annotations", "entries": entries}
