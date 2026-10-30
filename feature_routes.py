"""Scoped metadata endpoints; source wildcard files are never mutated here."""
import asyncio
import hashlib
import sqlite3
from functools import wraps
from aiohttp import web
from .feature_store import user_store, read_json, require_same_origin, FeatureConflict
from .library_intelligence import validate_collection, dependency_index, references
from .wildcard_index import get_index
PREFIX='/zf-prompt-palette/api/v1'
def library_identity():
    return hashlib.sha256(get_index().get_root_dir().encode()).hexdigest()

def guarded(fn):
    @wraps(fn)
    async def call(request):
        try:return await fn(request)
        except sqlite3.DatabaseError:raise web.HTTPServiceUnavailable(text='Feature metadata is unavailable; existing data was retained') from None
        except FeatureConflict as exc:raise web.HTTPConflict(text=str(exc)) from None
        except (ValueError,TypeError,KeyError) as exc:raise web.HTTPBadRequest(text=str(exc)) from None
    return call

def register_feature_routes(routes):
    @routes.get(PREFIX+'/collections')
    @guarded
    async def collections(request):
        return web.json_response(await asyncio.to_thread(user_store(request).list,'collections',request.query.get('cursor',''),100))
    @routes.put(PREFIX+'/collections/{id}')
    @guarded
    async def save_collection(request):
        data=await read_json(request);record=validate_collection(data)
        return web.json_response(await asyncio.to_thread(user_store(request).put,'collections',request.match_info['id'],record,data.get('revision',0)))
    @routes.delete(PREFIX+'/collections/{id}')
    @guarded
    async def delete_collection(request):
        require_same_origin(request)
        return web.json_response({'deleted':await asyncio.to_thread(user_store(request).delete,'collections',request.match_info['id'],int(request.query.get('revision','0')))})
    @routes.get(PREFIX+'/annotations')
    @guarded
    async def annotations(request):
        return web.json_response(await asyncio.to_thread(user_store(request).list,'annotations',request.query.get('cursor',''),100))
    @routes.put(PREFIX+'/annotations/{id}')
    @guarded
    async def annotate(request):
        data=await read_json(request);entry=data.get('entry');tags=data.get('tags',[]);favorite=data.get('favorite',False)
        if not isinstance(entry,str) or len(entry)>1024 or not entry or get_index().get_entry(entry) is None:raise ValueError('Choose an existing library entry')
        library_id=library_identity()
        if data.get('library_id')!=library_id or request.match_info['id']!=hashlib.sha256((library_id+':'+entry).encode()).hexdigest():raise ValueError('Annotation identity does not match the active library')
        if not isinstance(tags,list) or len(tags)>64 or any(not isinstance(x,str) or len(x)>80 or not x.strip() for x in tags) or not isinstance(favorite,bool):raise ValueError('Invalid tags or favorite')
        return web.json_response(await asyncio.to_thread(user_store(request).put,'annotations',request.match_info['id'],{**data,'entry':entry,'tags':list(dict.fromkeys(x.strip() for x in tags)),'favorite':favorite},data.get('revision',0)))
    @routes.get(PREFIX+'/library/dependencies')
    @guarded
    async def dependencies(request):
        user_store(request) # Require the host's authenticated user boundary.
        records=await asyncio.to_thread(dependency_index,get_index());entry=request.query.get('entry')
        if entry is not None:
            if entry not in records:raise web.HTTPNotFound(text='Library entry unavailable')
            return web.json_response(records[entry])
        cursor=request.query.get('cursor','');names=sorted(name for name in records if name>cursor);page=names[:100]
        return web.json_response({'items':[records[name] for name in page],'next_cursor':page[-1] if len(names)>100 else None})

    @routes.get(PREFIX+'/library/run-usage')
    @guarded
    async def run_usage(request):
        store=user_store(request)
        def collect():
            paths=set();cursor='';size=0
            while True:
                page=store.list('generations',cursor,100)
                for record in page['items']:
                    for context in record.get('contexts',[]):
                        for field in ('authored_positive','authored_negative'):
                            text=context.get(field,'')
                            if not isinstance(text,str):continue
                            size+=len(text)
                            if size>32_000_000:raise ValueError('Run usage exceeds 32 MB work limit; narrow retained history')
                            paths.update(edge['target'] for edge in references(text))
                cursor=page.get('next_cursor')
                if not cursor:break
            return {'entries':sorted(paths),'evidence':'authored-run-context'}
        return web.json_response(await asyncio.to_thread(collect))

    @routes.post(PREFIX+'/collections/validate')
    @guarded
    async def validate_import(request):
        user_store(request)
        data=await read_json(request)
        collections=data.get('collections')
        if not isinstance(collections,list) or len(collections)>100:raise ValueError('At most 100 collections may be imported')
        return web.json_response({'collections':[validate_collection(record) for record in collections]})

    @routes.get(PREFIX+'/library/identity')
    @guarded
    async def get_library_identity(request):
        user_store(request)
        return web.json_response({'library_id':library_identity()})

    @routes.post(PREFIX+'/library/relink')
    @guarded
    async def relink_metadata(request):
        store = user_store(request)
        data = await read_json(request)
        source = data.get('source')
        target = data.get('target')
        if not isinstance(source, str) or not isinstance(target, str) or not source or not target:
            raise ValueError('Source and target paths are required')
        if len(source) > 1024 or len(target) > 1024 or '..' in source.split('/') or '..' in target.split('/') or source.startswith(('/', '\\')) or target.startswith(('/', '\\')):
            raise ValueError('Invalid library entry path')
        result = await asyncio.to_thread(store.relink_entry_metadata, source, target, library_identity())
        return web.json_response(result)
