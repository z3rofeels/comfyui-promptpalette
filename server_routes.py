import os

from aiohttp import web
from server import PromptServer
from .wildcard_index import get_index
from .wildcard_resolver import WildcardResolver

routes = PromptServer.instance.routes


@routes.get("/prompt_palette/list")
async def list_wildcards(request):
    index = get_index()
    return web.json_response({"items": index.flat_list()})


@routes.get("/prompt_palette/search")
async def search_wildcards(request):
    q = request.rel_url.query.get("q", "")
    index = get_index()
    names = index.search(q) if q else index.all_names()
    items = []
    for name in names:
        entry = index.get_entry(name)
        if entry:
            items.append({"path": name, "type": entry["type"], "count": len(entry["lines"])})
    return web.json_response({"items": items})


@routes.get("/prompt_palette/preview")
async def preview_wildcard(request):
    name = request.rel_url.query.get("name", "")
    index = get_index()
    lines = index.preview(name, max_lines=5)
    if lines is None:
        return web.json_response({"found": False, "lines": []})
    return web.json_response({"found": True, "lines": lines})


@routes.get("/prompt_palette/content")
async def get_content(request):
    name = request.rel_url.query.get("name", "")
    index = get_index()
    entry = index.get_entry(name)
    if not entry:
        return web.json_response({"found": False}, status=404)
    return web.json_response({
        "found": True,
        "type": entry["type"],
        "content": "\n".join(entry["lines"]),
        "editable": entry["type"] == "txt",
    })


@routes.post("/prompt_palette/save")
async def save_wildcard(request):
    data = await request.json()
    name = data.get("name", "")
    content = data.get("content", "")
    index = get_index()
    try:
        index.save_txt(name, content)
    except ValueError as e:
        return web.json_response({"ok": False, "error": str(e)}, status=400)
    return web.json_response({"ok": True})


@routes.post("/prompt_palette/delete")
async def delete_wildcard(request):
    data = await request.json()
    name = data.get("name", "")
    index = get_index()
    try:
        index.delete(name)
    except (FileNotFoundError, ValueError) as e:
        return web.json_response({"ok": False, "error": str(e)}, status=400)
    return web.json_response({"ok": True})


@routes.post("/prompt_palette/refresh")
async def refresh_index(request):
    """Re-scans the wildcards/ tree. Returns both ok/count (for any simple
    callers that just want confirmation) and the full flat item list (same
    shape as GET /list) so the toolbar's ↻ button can repaint the picker/
    legend/known-wildcard set in one round trip without a follow-up call."""
    index = get_index()
    index.rescan()
    items = index.flat_list()
    return web.json_response({"ok": True, "count": len(items), "items": items})


@routes.post("/prompt_palette/set_path")
async def set_path(request):
    data = await request.json()
    path = data.get("path", "")
    index = get_index()
    try:
        index.set_root(path)
    except ValueError as e:
        return web.json_response({"ok": False, "error": str(e)}, status=400)
    return web.json_response({"ok": True, "root_dir": index.root_dir})


@routes.post("/prompt_palette/resolve")
async def resolve_prompt(request):
    data = await request.json()
    text = data.get("text", "")
    seed = int(data.get("seed", 0))
    mode = data.get("mode", "entire text as one")
    resolver = WildcardResolver(get_index())
    if mode == "line by line":
        lines = resolver.resolve_lines(text, seed=seed)
        resolved = "\n".join(lines)
    else:
        resolved = resolver.resolve(text, seed=seed)
    return web.json_response({"resolved": resolved})


# ---- thumbnail gallery ------------------------------------------------
# Same-basename image lookup for wildcard .txt files (e.g. chars/anime.txt
# <-> chars/anime.jpg), used by the picker drawer's grid view. Kept
# independent of WildcardIndex's registry, which tracks resolvable line
# content, not thumbnail art, so this always reflects what's on disk without
# needing a rescan.
THUMB_EXTS = (".jpg", ".jpeg", ".png")


def _resolve_within_root(root_dir, rel_path):
    """Resolve rel_path against root_dir and confirm the result actually lands
    inside root_dir. Mirrors the traversal-safety idiom WildcardIndex.save_txt
    already uses (realpath + commonpath) rather than a ".."-blocklist, which
    misses things like Windows drive-letter segments ("C:/foo") or UNC paths
    that make os.path.join silently discard root_dir. Returns the resolved
    absolute path, or None if rel_path escapes root_dir."""
    rel_path = (rel_path or "").strip("/")
    if not rel_path:
        return None
    root = os.path.realpath(root_dir)
    candidate = os.path.join(root, *rel_path.split("/"))
    abs_path = os.path.realpath(candidate)
    if os.path.commonpath([root, abs_path]) != root:
        return None
    return abs_path


@routes.get("/prompt_palette/categories")
async def get_thumbnail_map(request):
    """Walks wildcards/ and maps each .txt wildcard's name (extension-less,
    matching the `path` convention used by /list, /search, etc.) to a same-
    basename image (.jpg/.jpeg/.png) sitting in the same subfolder, or null
    when there isn't one, e.g. {"chars/anime": "chars/anime.jpg",
    "objects": null}."""
    index = get_index()
    root = os.path.realpath(index.root_dir)
    mapping = {}
    for dirpath, _dirnames, filenames in os.walk(root):
        rel_dir = os.path.relpath(dirpath, root)
        rel_dir = "" if rel_dir == "." else rel_dir.replace(os.sep, "/")
        lower_lookup = {fname.lower(): fname for fname in filenames}
        for fname in filenames:
            if not fname.lower().endswith(".txt"):
                continue
            base = fname[:-4]
            name_key = f"{rel_dir}/{base}" if rel_dir else base
            thumb_rel = None
            for ext in THUMB_EXTS:
                match = lower_lookup.get((base + ext).lower())
                if match:
                    thumb_rel = f"{rel_dir}/{match}" if rel_dir else match
                    break
            mapping[name_key] = thumb_rel
    return web.json_response(mapping)


@routes.get("/prompt_palette/thumb")
async def get_thumbnail(request):
    """Serves a single thumbnail's raw bytes. `file` is the relative path
    returned by /categories above; resolved and bounds-checked against the
    wildcards root before anything touches the filesystem."""
    rel_file = request.rel_url.query.get("file", "")
    if not rel_file.lower().endswith(THUMB_EXTS):
        raise web.HTTPNotFound()
    index = get_index()
    abs_path = _resolve_within_root(index.root_dir, rel_file)
    if not abs_path or not os.path.isfile(abs_path):
        raise web.HTTPNotFound()
    return web.FileResponse(abs_path)
