"""Authenticated relationship metadata and bounded validation endpoints."""
import asyncio
from aiohttp import web
from server import PromptServer
from .feature_store import user_store, read_json, FeatureConflict
from .feature_routes import guarded
from .wildcard_index import get_index
from .relationships import catalog, validate_config, assignments, RelationshipError
routes = PromptServer.instance.routes
BASE = '/zf-prompt-palette/api/v1/relationships'

def error(exc):
    return web.json_response(exc.as_dict() if isinstance(exc, RelationshipError) else {'error': str(exc)}, status=409 if isinstance(exc, FeatureConflict) else 400)

@routes.get(BASE)
@guarded
async def list_relationships(request):
    try: return web.json_response(await asyncio.to_thread(user_store(request).list, 'relationships', request.query.get('cursor', ''), 100))
    except ValueError as exc: return error(exc)

@routes.post(BASE + '/catalog')
@guarded
async def relationship_catalog(request):
    user_store(request)
    data = await read_json(request)
    try: return web.json_response({'entries': await asyncio.to_thread(catalog, get_index(), data.get('entries'))})
    except ValueError as exc: return error(exc)

@routes.post(BASE + '/validate')
@guarded
async def validate_relationships(request):
    user_store(request)
    data = await read_json(request)
    try:
        selections, diagnostics = await asyncio.to_thread(assignments, data.get('config'), get_index().preview_view(), data.get('seed', 0), limit=5001)
        return web.json_response({'diagnostics': diagnostics, 'examples': [{k: v['text'] for k, v in row.items()} for row in selections[:5]]})
    except (ValueError, TypeError) as exc: return error(exc)

@routes.put(BASE + '/{identifier}')
@guarded
async def put_relationship(request):
    store = user_store(request); data = await read_json(request)
    config = data.get('config')
    try:
        if not isinstance(config, dict): raise ValueError('Relationship configuration required')
        # Disabled stale drafts may be retained; enabled saves validate strictly.
        await asyncio.to_thread(validate_config, config, get_index())
        return web.json_response(await asyncio.to_thread(store.put, 'relationships', request.match_info['identifier'], config, data.get('expected_revision')))
    except ValueError as exc: return error(exc)

@routes.delete(BASE + '/{identifier}')
@guarded
async def delete_relationship(request):
    store = user_store(request); data = await read_json(request)
    try: return web.json_response({'deleted': await asyncio.to_thread(store.delete, 'relationships', request.match_info['identifier'], data.get('expected_revision'))})
    except ValueError as exc: return error(exc)
