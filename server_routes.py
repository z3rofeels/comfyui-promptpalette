from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import tempfile
from typing import Any

from aiohttp import web
from server import PromptServer

from .clip_tokenizer import count_clip_tokens
from .wildcard_index import get_index
from .wildcard_resolver import WildcardResolver

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


def _error(message: str, status: int = 400, *, ok: bool | None = None) -> web.Response:
    payload: dict[str, Any] = {"error": message}
    if ok is not None:
        payload["ok"] = ok
    return web.json_response(payload, status=status)


async def _read_json_object(request: web.Request) -> dict[str, Any]:
    content_length = request.content_length
    if content_length is not None and content_length > MAX_JSON_BYTES:
        raise ValueError("request body is too large")
    raw = bytearray()
    async for chunk in request.content.iter_chunked(64 * 1024):
        raw.extend(chunk)
        if len(raw) > MAX_JSON_BYTES:
            raise ValueError("request body is too large")
    try:
        data = json.loads(bytes(raw).decode("utf-8")) if raw else {}
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("invalid JSON body") from exc
    if not isinstance(data, dict):
        raise ValueError("JSON body must be an object")
    return data


def _bounded_text(value: Any, field: str, limit: int = MAX_TEXT_CHARS) -> str:
    if value is None:
        return ""
    if not isinstance(value, str):
        raise ValueError(f"{field} must be a string")
    if len(value) > limit:
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


@routes.post("/prompt_palette/set_path")
async def set_path(request):
    index = get_index()
    try:
        data = await _read_json_object(request)
        path = _bounded_text(data.get("path"), "path", MAX_PATH_CHARS)
        if path.strip():
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
        data = await _read_json_object(request)
        text = _bounded_text(data.get("text"), "text")
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
        data = await _read_json_object(request)
        text = _bounded_text(data.get("text"), "text")
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
        data = await _read_json_object(request)
        text = _bounded_text(data.get("text"), "text")
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
        data = await _read_json_object(request)
        text = _bounded_text(data.get("text"), "text")
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
