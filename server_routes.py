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
