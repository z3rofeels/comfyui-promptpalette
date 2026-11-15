"""User-scoped history API; reads host history, never client-supplied provenance."""
import asyncio
import sqlite3
import time
from aiohttp import web
from server import PromptServer
from .feature_store import user_store, read_json, require_same_origin, FeatureConflict
from .generation_history import settings, index_history, media_exists, validate_image, public_record

PREFIX = '/zf-prompt-palette/api/v1/generations'

def _single_user():
    from comfy.cli_args import args
    if getattr(args, 'multi_user', False):
        raise web.HTTPConflict(text='History capture is unavailable in multi-user mode: this host does not expose authenticated run ownership.')

def _roots():
    import folder_paths
    return {'output': folder_paths.get_output_directory(), 'temp': folder_paths.get_temp_directory()}

def register_generation_history_routes(routes):
    original_routes = routes
    class GuardedRoutes:
        def __getattr__(self, method):
            def decorate(path):
                def wrap(handler):
                    async def guarded(request):
                        try: return await handler(request)
                        except sqlite3.DatabaseError: raise web.HTTPServiceUnavailable(text='Feature metadata is unavailable; existing data was retained') from None
                        except FeatureConflict as exc: raise web.HTTPConflict(text=str(exc)) from None
                        except (ValueError, TypeError, KeyError) as exc: raise web.HTTPBadRequest(text='Invalid history request') from None
                    return getattr(original_routes, method)(path)(guarded)
                return wrap
            return decorate
    routes = GuardedRoutes()
    @routes.get(PREFIX + '/settings')
    async def get_settings(request):
        prefs = await asyncio.to_thread(settings, user_store(request))
        try:
            _single_user(); prefs['capture_available'] = True
        except web.HTTPConflict:
            prefs['capture_available'] = False
        return web.json_response(prefs)

    @routes.put(PREFIX + '/settings')
    async def put_settings(request):
        require_same_origin(request)
        data = await read_json(request)
        store = user_store(request)
        old = settings(store)
        enabled = data.get('enabled', old['enabled'])
        capture = data.get('capture_prompts', old['capture_prompts'])
        maximum = data.get('max_entries', old['max_entries'])
        if not isinstance(enabled, bool) or not isinstance(capture, bool) or isinstance(maximum, bool) or not isinstance(maximum, int) or not 100 <= maximum <= 10000:
            raise web.HTTPBadRequest(text='Invalid history settings')
        if enabled:
            _single_user()
        since = old['enabled_since'] if old['enabled'] else int(time.time() * 1000)
        record = await asyncio.to_thread(store.put, 'settings', 'generation-history',
            {'enabled': enabled, 'capture_prompts': capture, 'max_entries': maximum, 'enabled_since': since},
            expected_revision=data.get('revision', 0))
        return web.json_response(record)

    @routes.post(PREFIX + '/sync')
    async def sync(request):
        require_same_origin(request); _single_user()
        data = await read_json(request)
        store = user_store(request)
        explicit = data.get('import_existing') is True
        prefs = await asyncio.to_thread(settings, store)
        if not prefs['enabled'] and not explicit:
            return web.json_response({'added': 0, 'disabled': True})
        prompt_id = data.get('prompt_id')
        if prompt_id is not None and (not isinstance(prompt_id, str) or len(prompt_id) > 128):
            raise web.HTTPBadRequest(text='Invalid run ID')
        offset = data.get('offset', -1)
        if isinstance(offset, bool) or not isinstance(offset, int) or offset < -1 or offset > 100000:
            raise web.HTTPBadRequest(text='Invalid history offset')
        queue = PromptServer.instance.prompt_queue
        history = await asyncio.to_thread(queue.get_history, prompt_id=prompt_id, max_items=100, offset=offset)
        result = await asyncio.to_thread(index_history, store, history, explicit=explicit, roots=_roots())
        result['scanned'] = len(history)
        result['next_offset'] = offset + len(history) if explicit and offset >= 0 and len(history) == 100 else None
        return web.json_response(result)

    @routes.get(PREFIX)
    async def list_generations(request):
        store = user_store(request)
        cursor = request.query.get('cursor', '')
        query = request.query.get('q', '').strip().casefold()[:256]
        favorites = request.query.get('favorite') == 'true'
        missing_only = request.query.get('missing') == 'true'
        provenance = request.query.get('provenance', '').strip()
        try:
            since = max(0, int(request.query.get('since', '0')))
        except ValueError:
            raise web.HTTPBadRequest(text='Invalid date filter')
        roots = _roots()
        def read():
            page = store.list('generations', cursor=cursor, limit=100)
            rows = []
            for record in page['items']:
                record['missing'] = not media_exists(record['image'], roots)
                text = ' '.join([
                    record.get('notes', ''),
                    record['image']['filename'],
                    record.get('prompt_id', ''),
                    record.get('provenance', ''),
                    record.get('resolved_positive', '') or '',
                    record.get('resolved_negative', '') or '',
                    *record.get('tags', []),
                    *[c.get('authored_positive', '') + ' ' + c.get('authored_negative', '') for c in record.get('contexts', [])],
                ])
                if query and query not in text.casefold(): continue
                if favorites and not record.get('favorite'): continue
                if missing_only and not record['missing']: continue
                if provenance and record.get('provenance') != provenance: continue
                if since and record.get('completed_at', 0) < since: continue
                rows.append(public_record(record))
            return {**page, 'items': rows}
        return web.json_response(await asyncio.to_thread(read))

    @routes.get(PREFIX + '/{media_id}')
    async def detail(request):
        record = await asyncio.to_thread(user_store(request).get, 'generations', request.match_info['media_id'])
        if not record: raise web.HTTPNotFound(text='Generation not found')
        record['missing'] = not media_exists(record['image'], _roots())
        return web.json_response(public_record(record))

    @routes.patch(PREFIX + '/{media_id}')
    async def annotate(request):
        require_same_origin(request)
        data = await read_json(request); store = user_store(request)
        record = await asyncio.to_thread(store.get, 'generations', request.match_info['media_id'])
        if not record: raise web.HTTPNotFound(text='Generation not found')
        if 'favorite' in data:
            if not isinstance(data['favorite'], bool): raise web.HTTPBadRequest(text='Invalid favorite')
            record['favorite'] = data['favorite']
        if 'notes' in data:
            if not isinstance(data['notes'], str) or len(data['notes']) > 10000: raise web.HTTPBadRequest(text='Invalid notes')
            record['notes'] = data['notes']
        if 'tags' in data:
            if not isinstance(data['tags'], list) or len(data['tags']) > 100 or any(not isinstance(tag, str) or len(tag)>100 for tag in data['tags']): raise web.HTTPBadRequest(text='Invalid tags')
            record['tags'] = list(dict.fromkeys(data['tags']))
        if 'image' in data:
            try: image = validate_image(data['image'])
            except ValueError as exc: raise web.HTTPBadRequest(text=str(exc))
            if not media_exists(image, _roots()): raise web.HTTPBadRequest(text='Relink target does not exist inside ComfyUI output/temp')
            record['image'] = image
            record['provenance'] = 'imported-unlinked'
        saved = await asyncio.to_thread(store.put, 'generations', record['id'], record, expected_revision=data.get('revision'))
        return web.json_response(public_record(saved))

    @routes.delete(PREFIX + '/{media_id}')
    async def remove(request):
        require_same_origin(request); data = await read_json(request); store = user_store(request)
        media_id = request.match_info['media_id']
        # A tombstone prevents the automatic recovery scan re-adding removals.
        record = await asyncio.to_thread(store.get, 'generations', media_id)
        if not record: raise web.HTTPNotFound(text='Generation not found')
        if data.get('revision') != record['revision']: raise web.HTTPConflict(text='Generation changed; refresh first')
        if not store.get('generation_tombstones', media_id):
            await asyncio.to_thread(store.put, 'generation_tombstones', media_id, {'removed_at': int(time.time()*1000)}, expected_revision=0)
        await asyncio.to_thread(store.delete, 'generations', media_id, expected_revision=record['revision'])
        return web.json_response({'ok': True})
