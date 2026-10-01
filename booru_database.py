from __future__ import annotations

import csv
import hashlib
import json
import logging
import os
import sqlite3
import tempfile
from datetime import datetime, timezone
from typing import Any, Iterable

logger = logging.getLogger(__name__)

SCHEMA_VERSION = 4
SOURCE_NAME = "PYU224/tagdb-updater"
SOURCE_URL = "https://raw.githubusercontent.com/PYU224/tagdb-updater/main/dist/danbooru.csv"

CATEGORY_NAMES = {
    0: "general",
    1: "artist",
    3: "copyright",
    4: "character",
    5: "meta",
}

_PACKAGE_DIR = os.path.dirname(os.path.abspath(__file__))
_BUNDLE_DIR = os.path.join(_PACKAGE_DIR, "assets", "booru")
_BUNDLED_CSV = os.path.join(_BUNDLE_DIR, "danbooru.csv")
_BUNDLED_DB = os.path.join(_BUNDLE_DIR, "danbooru.sqlite3")
_BUNDLED_METADATA = os.path.join(_BUNDLE_DIR, "metadata.json")


def bundled_csv_path() -> str:
    return _BUNDLED_CSV


def bundled_db_path() -> str:
    return _BUNDLED_DB


def bundled_metadata_path() -> str:
    return _BUNDLED_METADATA


def normalize_tag(value: Any) -> str:
    # Danbooru uses underscores for whitespace in prompt tags.
    return str(value or "").strip().replace(" ", "_")


def normalize_lookup(value: Any) -> str:
    return normalize_tag(value).casefold()


def category_name(value: Any) -> str:
    try:
        numeric = int(str(value).strip())
    except (TypeError, ValueError):
        return "general"
    return CATEGORY_NAMES.get(numeric, "general")


def aliases(value: Any) -> list[str]:
    if value is None:
        return []
    result: list[str] = []
    for raw in str(value).split(","):
        item = normalize_tag(raw)
        if item:
            result.append(item)
    return result


def _load_bundle_metadata() -> dict[str, Any]:
    try:
        with open(_BUNDLED_METADATA, "r", encoding="utf-8") as handle:
            data = json.load(handle)
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def _sha256(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _create_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        PRAGMA journal_mode = OFF;
        PRAGMA synchronous = OFF;
        PRAGMA temp_store = MEMORY;
        PRAGMA foreign_keys = ON;

        CREATE TABLE tags (
            tag TEXT PRIMARY KEY,
            tag_lc TEXT NOT NULL,
            post_count INTEGER NOT NULL DEFAULT 0,
            category TEXT NOT NULL DEFAULT 'general',
            aliases TEXT NOT NULL DEFAULT ''
        );

        CREATE TABLE tag_aliases (
            alias TEXT NOT NULL,
            alias_lc TEXT NOT NULL,
            tag TEXT NOT NULL,
            PRIMARY KEY(alias_lc, tag),
            FOREIGN KEY(tag) REFERENCES tags(tag) ON DELETE CASCADE
        );

        CREATE TABLE metadata (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        """
    )


def _create_indexes(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE INDEX idx_tags_tag_lc ON tags(tag_lc);
        CREATE INDEX idx_tags_count ON tags(post_count DESC);
        CREATE INDEX idx_tag_aliases_alias_lc ON tag_aliases(alias_lc);
        CREATE INDEX idx_tag_aliases_tag ON tag_aliases(tag);
        """
    )


def _parse_pyu_csv(handle: Iterable[str], conn: sqlite3.Connection) -> tuple[int, int, int, dict[str, int]]:
    reader = csv.reader(handle)
    batch_tags: list[tuple[str, str, int, str, str]] = []
    batch_aliases: list[tuple[str, str, str]] = []
    tag_count = 0
    alias_count = 0
    alias_values = 0
    category_counts = {name: 0 for name in CATEGORY_NAMES.values()}

    for row in reader:
        if not row or not row[0].strip() or row[0].lstrip().startswith("#"):
            continue

        tag = normalize_tag(row[0])
        if not tag:
            continue

        category = category_name(row[1] if len(row) > 1 else 0)
        try:
            count = max(0, int(str(row[2]).strip() or 0)) if len(row) > 2 else 0
        except ValueError:
            count = 0

        tag_aliases = [
            alias for alias in aliases(row[3] if len(row) > 3 else "")
            if alias.casefold() != tag.casefold()
        ]

        batch_tags.append(
            (tag, tag.casefold(), count, category, ",".join(tag_aliases))
        )
        batch_aliases.extend(
            (alias, alias.casefold(), tag) for alias in tag_aliases
        )

        tag_count += 1
        alias_values += len(tag_aliases)
        category_counts[category] += 1

        if len(batch_tags) >= 5000:
            conn.executemany(
                """
                INSERT OR REPLACE INTO tags(tag, tag_lc, post_count, category, aliases)
                VALUES (?, ?, ?, ?, ?)
                """,
                batch_tags,
            )
            if batch_aliases:
                conn.executemany(
                    """
                    INSERT OR IGNORE INTO tag_aliases(alias, alias_lc, tag)
                    VALUES (?, ?, ?)
                    """,
                    batch_aliases,
                )
            batch_tags.clear()
            batch_aliases.clear()

    if batch_tags:
        conn.executemany(
            """
            INSERT OR REPLACE INTO tags(tag, tag_lc, post_count, category, aliases)
            VALUES (?, ?, ?, ?, ?)
            """,
            batch_tags,
        )
    if batch_aliases:
        conn.executemany(
            """
            INSERT OR IGNORE INTO tag_aliases(alias, alias_lc, tag)
            VALUES (?, ?, ?)
            """,
            batch_aliases,
        )

    alias_count = int(conn.execute("SELECT COUNT(*) FROM tag_aliases").fetchone()[0])
    return tag_count, alias_count, alias_values, category_counts


def build_bundled_database(
    *,
    csv_path: str = _BUNDLED_CSV,
    db_path: str = _BUNDLED_DB,
    metadata_path: str = _BUNDLED_METADATA,
    generated_at: str | None = None,
) -> dict[str, Any]:
    os.makedirs(os.path.dirname(db_path), exist_ok=True)
    csv_hash = _sha256(csv_path)

    metadata = {
        "schema_version": SCHEMA_VERSION,
        "source": SOURCE_NAME,
        "source_url": SOURCE_URL,
        "generated_at": generated_at or "",
        "csv_sha256": csv_hash,
        "counts": {},
    }

    existing = _load_bundle_metadata() if metadata_path == _BUNDLED_METADATA else {}
    if not metadata["generated_at"]:
        metadata["generated_at"] = str(
            existing.get("generated_at")
            or datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
        )

    fd, tmp_path = tempfile.mkstemp(
        prefix=".danbooru.", suffix=".sqlite3.tmp", dir=os.path.dirname(db_path)
    )
    os.close(fd)

    try:
        with sqlite3.connect(tmp_path) as conn:
            _create_schema(conn)
            with open(csv_path, "r", encoding="utf-8-sig", errors="replace", newline="") as handle:
                tag_count, alias_count, alias_values, category_counts = _parse_pyu_csv(handle, conn)

            _create_indexes(conn)
            metadata["counts"] = {
                "tags": tag_count,
                "aliases": alias_count,
                "alias_values": alias_values,
                "categories": category_counts,
            }
            rows = {
                "schema_version": str(SCHEMA_VERSION),
                "source": SOURCE_NAME,
                "source_url": SOURCE_URL,
                "generated_at": metadata["generated_at"],
                "csv_sha256": csv_hash,
                "tag_count": str(tag_count),
                "alias_count": str(alias_count),
            }
            conn.executemany(
                "INSERT INTO metadata(key, value) VALUES (?, ?)",
                rows.items(),
            )
            conn.commit()

        os.replace(tmp_path, db_path)

        with open(metadata_path, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(metadata, handle, ensure_ascii=False, indent=2)
            handle.write("\n")

        return metadata
    finally:
        for suffix_path in (tmp_path, tmp_path + "-wal", tmp_path + "-shm"):
            try:
                os.remove(suffix_path)
            except FileNotFoundError:
                pass
            except OSError:
                logger.debug("Could not remove temporary Booru database file %s", suffix_path, exc_info=True)


def _db_matches_bundle(db_path: str, csv_hash: str) -> bool:
    if not os.path.isfile(db_path):
        return False
    try:
        with sqlite3.connect(db_path) as conn:
            rows = dict(conn.execute("SELECT key, value FROM metadata"))
        return (
            int(rows.get("schema_version", "0")) == SCHEMA_VERSION
            and rows.get("csv_sha256") == csv_hash
            and int(rows.get("tag_count", "0")) > 0
        )
    except Exception:
        return False


def ensure_bundled_database() -> str:
    """
    Ensure the derived SQLite index matches the canonical bundled CSV.

    Runtime never downloads or refreshes from a network source. The CSV is the
    single canonical bundled dataset; SQLite is only its derived local index.
    """
    if not os.path.isfile(_BUNDLED_CSV):
        raise FileNotFoundError(f"Prompt Palette Booru CSV is missing: {_BUNDLED_CSV}")

    csv_hash = _sha256(_BUNDLED_CSV)
    if _db_matches_bundle(_BUNDLED_DB, csv_hash):
        return _BUNDLED_DB

    logger.info("Building Prompt Palette Booru SQLite index from bundled CSV")
    metadata = _load_bundle_metadata()
    generated_at = str(metadata.get("generated_at") or "")
    build_bundled_database(generated_at=generated_at)
    return _BUNDLED_DB


def active_db_path(_bundle_path: str | None = None) -> str:
    # Compatibility shim: there is intentionally no per-user or remote Booru DB.
    # The bundled index is validated once when this module loads, not per search.
    return _BUNDLED_DB


def status(_bundle_path: str | None = None) -> dict[str, Any]:
    ensure_bundled_database()
    metadata = _load_bundle_metadata()
    counts = metadata.get("counts") if isinstance(metadata.get("counts"), dict) else {}
    return {
        "active": "bundled",
        "available": True,
        "fresh": True,
        "syncing": False,
        "source": metadata.get("source"),
        "source_url": metadata.get("source_url"),
        "generated_at": metadata.get("generated_at"),
        "csv_sha256": metadata.get("csv_sha256"),
        "tag_count": int(counts.get("tags", 0) or 0),
        "alias_count": int(counts.get("aliases", 0) or 0),
        "category_counts": counts.get("categories", {}),
    }


# Validate the shipped derived index once when Prompt Palette loads. No network
# access occurs here; the only canonical data source is the bundled CSV.
# The SQLite file is derived and git-ignored, so a first load builds it. A failure
# here (e.g. read-only install folder) must not stop the rest of Prompt Palette.
try:
    ensure_bundled_database()
except Exception:
    logger.exception("Prompt Palette could not prepare the Booru index; Booru autocomplete is unavailable")
