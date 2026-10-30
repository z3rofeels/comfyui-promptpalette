"""Lazy, user-scoped feature metadata. Never writes into a wildcard tree."""
from __future__ import annotations
import hashlib
import json
import re
import sqlite3
from pathlib import Path
from datetime import datetime, timezone
from urllib.parse import urlsplit
from aiohttp import web

NAMESPACES = frozenset(('settings', 'collections', 'relationships', 'annotations', 'generations', 'generation_tombstones'))
MAX_RECORD_BYTES = 1024 * 1024
class FeatureConflict(ValueError): pass

def user_identity(request):
    from server import PromptServer
    manager = getattr(PromptServer.instance, 'user_manager', None)
    if not manager or not callable(getattr(manager, 'get_request_user_id', None)):
        raise web.HTTPServiceUnavailable(text='User-scoped feature storage is unavailable on this host')
    try: return str(manager.get_request_user_id(request))
    except KeyError: raise web.HTTPForbidden(text='Unknown user') from None

def user_store(request):
    from server import PromptServer
    user_identity(request)
    manager = PromptServer.instance.user_manager
    getter = getattr(manager, 'get_request_user_filepath', None)
    if not callable(getter): raise web.HTTPServiceUnavailable(text='User-scoped storage API unavailable')
    raw_root = getter(request, None, create_dir=False)
    raw_path = getter(request, 'prompt_palette/features.sqlite', create_dir=False)
    if not raw_root or not raw_path: raise web.HTTPForbidden(text='User storage unavailable')
    root, path = Path(raw_root).resolve(), Path(raw_path).resolve()
    if not path.is_relative_to(root): raise web.HTTPForbidden(text='Invalid feature storage path')
    return FeatureStore(path.parent, trusted_root=root)

def require_same_origin(request):
    origin = request.headers.get('Origin')
    if origin:
        try:
            parsed = urlsplit(origin)
        except ValueError:
            raise web.HTTPForbidden(text='Invalid request origin') from None
        if parsed.scheme not in ('http', 'https') or parsed.netloc.lower() != request.host.lower():
            raise web.HTTPForbidden(text='Cross-origin feature mutation rejected')
    if request.headers.get('Sec-Fetch-Site') == 'cross-site':
        raise web.HTTPForbidden(text='Cross-site feature mutation rejected')

async def read_json(request, limit=MAX_RECORD_BYTES):
    require_same_origin(request)
    if request.content_length and request.content_length > limit: raise web.HTTPRequestEntityTooLarge(max_size=limit, actual_size=request.content_length)
    raw = bytearray()
    async for chunk in request.content.iter_chunked(65536):
        raw.extend(chunk)
        if len(raw) > limit: raise web.HTTPRequestEntityTooLarge(max_size=limit, actual_size=len(raw))
    try: data = json.loads(raw or b'{}')
    except (ValueError, RecursionError): raise web.HTTPBadRequest(text='Invalid JSON') from None
    if not isinstance(data, dict): raise web.HTTPBadRequest(text='JSON object required')
    stack=[(data,0)]
    while stack:
        value,depth=stack.pop()
        if depth>20:raise web.HTTPBadRequest(text='JSON nesting exceeds 20 levels')
        if isinstance(value,dict):stack.extend((child,depth+1) for child in value.values())
        elif isinstance(value,list):stack.extend((child,depth+1) for child in value)
    return data

class FeatureStore:
    def __init__(self, user_root, trusted_root=None):
        self.root = Path(user_root).resolve()
        self.trusted_root = Path(trusted_root).resolve() if trusted_root else self.root
        self.path = self.root / 'features.sqlite'
    def _validate(self, namespace, identifier=None):
        if namespace not in NAMESPACES: raise ValueError('Unknown metadata namespace')
        if identifier is not None and (not isinstance(identifier,str) or not re.fullmatch(r'[A-Za-z0-9_.:-]{1,160}',identifier)):
            raise ValueError('Invalid metadata identifier')
    def _connect(self, write=False):
        # Reject symlink substitution of the database and all controlled children.
        if self.root.is_symlink() or self.path.is_symlink() or not self.path.resolve().is_relative_to(self.trusted_root):
            raise ValueError('Unsafe feature storage path')
        for suffix in ('-wal','-shm','-journal'):
            if Path(str(self.path)+suffix).is_symlink(): raise ValueError('Unsafe database sidecar')
        if not write and not self.path.exists(): return None
        if write: self.root.mkdir(parents=True,exist_ok=True)
        db = sqlite3.connect(str(self.path) if write else self.path.as_uri()+'?mode=ro',uri=not write,timeout=5)
        db.row_factory=sqlite3.Row
        version=db.execute('PRAGMA user_version').fetchone()[0]
        if version not in (0,1): db.close(); raise ValueError('Feature database is newer than this extension; no changes made')
        if write and version==0:
            with db:
                db.execute('CREATE TABLE IF NOT EXISTS records (namespace TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,updated_at TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(namespace,id))')
                db.execute('PRAGMA user_version=1')
        return db
    @staticmethod
    def _record(row):
        if row is None:return None
        data=json.loads(row['data'])
        return {**data,'id':row['id'],'revision':row['revision'],'updated_at':row['updated_at'],'schema_version':1}
    def get(self,namespace,identifier):
        self._validate(namespace,identifier);db=self._connect()
        if db is None:return None
        try:return self._record(db.execute('SELECT * FROM records WHERE namespace=? AND id=?',(namespace,identifier)).fetchone())
        finally:db.close()
    def list(self,namespace,cursor='',limit=100):
        self._validate(namespace)
        if cursor:self._validate(namespace,cursor)
        limit=max(1,min(100,int(limit)));db=self._connect()
        if db is None:return {'items':[],'next_cursor':None}
        try:
            rows=db.execute('SELECT * FROM records WHERE namespace=? AND id>? ORDER BY id LIMIT ?',(namespace,cursor,limit+1)).fetchall()
            return {'items':[self._record(r) for r in rows[:limit]],'next_cursor':rows[limit-1]['id'] if len(rows)>limit else None}
        finally:db.close()
    def put(self,namespace,identifier,data,expected_revision=None):
        self._validate(namespace,identifier)
        if isinstance(expected_revision,bool) or not isinstance(expected_revision,int) or expected_revision<0:raise FeatureConflict('A current revision is required')
        if not isinstance(data,dict):raise ValueError('Metadata record must be an object')
        encoded=json.dumps(data,ensure_ascii=False,allow_nan=False,separators=(',',':'))
        if len(encoded.encode())>MAX_RECORD_BYTES:raise ValueError('Metadata record too large')
        db=self._connect(True)
        try:
            db.execute('BEGIN IMMEDIATE')
            row=db.execute('SELECT revision FROM records WHERE namespace=? AND id=?',(namespace,identifier)).fetchone()
            current=row['revision'] if row else 0
            if expected_revision != current:raise FeatureConflict('Metadata changed; reload before saving')
            now=datetime.now(timezone.utc).isoformat()
            db.execute('INSERT INTO records VALUES(?,?,?,?,?) ON CONFLICT(namespace,id) DO UPDATE SET revision=excluded.revision,updated_at=excluded.updated_at,data=excluded.data',(namespace,identifier,current+1,now,encoded))
            db.commit();return {**data,'id':identifier,'revision':current+1,'updated_at':now,'schema_version':1}
        except Exception:db.rollback();raise
        finally:db.close()
    def delete(self,namespace,identifier,expected_revision=None):
        self._validate(namespace,identifier);db=self._connect()
        if db is None:return False
        db.close();db=self._connect(True)
        try:
            db.execute('BEGIN IMMEDIATE');row=db.execute('SELECT revision FROM records WHERE namespace=? AND id=?',(namespace,identifier)).fetchone()
            if row is None:db.rollback();return False
            if expected_revision != row['revision']:raise FeatureConflict('Metadata changed; reload before deleting')
            db.execute('DELETE FROM records WHERE namespace=? AND id=?',(namespace,identifier));db.commit();return True
        except Exception:db.rollback();raise
        finally:db.close()

    def prune(self, namespace, max_records):
        """Evict oldest metadata only; no original media paths are opened."""
        self._validate(namespace)
        if isinstance(max_records, bool) or not isinstance(max_records, int) or max_records < 0:
            raise ValueError('Invalid retention limit')
        db = self._connect()
        if db is None: return 0
        db.close(); db = self._connect(True)
        try:
            with db:
                result = db.execute('DELETE FROM records WHERE namespace=? AND id IN (SELECT id FROM records WHERE namespace=? ORDER BY updated_at DESC,id DESC LIMIT -1 OFFSET ?)', (namespace, namespace, max_records))
                return result.rowcount
        finally: db.close()

    def relink_entry_metadata(self, old_entry: str, new_entry: str, library_id: str) -> dict:
        """Transactionally relink annotations, relationships, and collections when an entry is renamed."""
        if not isinstance(old_entry, str) or not isinstance(new_entry, str) or not old_entry or not new_entry or old_entry == new_entry:
            return {'ok': True, 'relinked_annotations': 0, 'relinked_relationships': 0, 'relinked_collections': 0}
        if len(old_entry) > 1024 or len(new_entry) > 1024 or '..' in old_entry.split('/') or '..' in new_entry.split('/') or old_entry.startswith('/') or new_entry.startswith('/') or any(char in path for path in (old_entry, new_entry) for char in ('\\', ':', '\x00')):
            raise ValueError('Invalid library entry path')
        db = self._connect()
        if db is None:
            return {'ok': True, 'relinked_annotations': 0, 'relinked_relationships': 0, 'relinked_collections': 0}
        db.close()
        db = self._connect(True)
        try:
            db.execute('BEGIN IMMEDIATE')
            now = datetime.now(timezone.utc).isoformat()
            relinked_annotations = 0
            relinked_relationships = 0
            relinked_collections = 0

            # 1. Relink annotations
            old_annot_id = hashlib.sha256((library_id + ':' + old_entry).encode()).hexdigest()
            new_annot_id = hashlib.sha256((library_id + ':' + new_entry).encode()).hexdigest()
            row = db.execute('SELECT * FROM records WHERE namespace="annotations" AND id=?', (old_annot_id,)).fetchone()
            if row:
                if db.execute('SELECT 1 FROM records WHERE namespace="annotations" AND id=?', (new_annot_id,)).fetchone():
                    raise FeatureConflict('The destination already has annotations; metadata was retained for both entries')
                data = json.loads(row['data'])
                data['entry'] = new_entry
                encoded = json.dumps(data, ensure_ascii=False, allow_nan=False, separators=(',', ':'))
                db.execute('DELETE FROM records WHERE namespace="annotations" AND id=?', (old_annot_id,))
                db.execute(
                    'INSERT INTO records VALUES("annotations", ?, ?, ?, ?) ON CONFLICT(namespace, id) DO UPDATE SET revision=excluded.revision, updated_at=excluded.updated_at, data=excluded.data',
                    (new_annot_id, row['revision'] + 1, now, encoded),
                )
                relinked_annotations += 1

            # 2. Relink relationships
            rel_rows = db.execute('SELECT * FROM records WHERE namespace="relationships"').fetchall()
            for r in rel_rows:
                data = json.loads(r['data'])
                changed = False
                entries = data.get('entries')
                if isinstance(entries, dict) and old_entry in entries:
                    if new_entry in entries:
                        raise FeatureConflict('A relationship already contains the destination entry; metadata was retained')
                    entries[new_entry] = entries.pop(old_entry)
                    changed = True
                rules = data.get('rules')
                if isinstance(rules, list):
                    for rule in rules:
                        if isinstance(rule, dict):
                            for side in ('source', 'target'):
                                endpoint = rule.get(side)
                                if isinstance(endpoint, dict) and endpoint.get('entry') == old_entry:
                                    endpoint['entry'] = new_entry
                                    changed = True
                if changed:
                    encoded = json.dumps(data, ensure_ascii=False, allow_nan=False, separators=(',', ':'))
                    db.execute(
                        'UPDATE records SET revision=revision+1, updated_at=?, data=? WHERE namespace="relationships" AND id=?',
                        (now, encoded, r['id']),
                    )
                    relinked_relationships += 1

            # 3. Relink collections
            coll_rows = db.execute('SELECT * FROM records WHERE namespace="collections"').fetchall()
            for c in coll_rows:
                data = json.loads(c['data'])
                changed = False
                groups = data.get('groups')
                if isinstance(groups, list):
                    for group in groups:
                        if isinstance(group, list):
                            for term in group:
                                if isinstance(term, dict) and term.get('field') == 'path' and term.get('value') == old_entry:
                                    term['value'] = new_entry
                                    changed = True
                if changed:
                    encoded = json.dumps(data, ensure_ascii=False, allow_nan=False, separators=(',', ':'))
                    db.execute(
                        'UPDATE records SET revision=revision+1, updated_at=?, data=? WHERE namespace="collections" AND id=?',
                        (now, encoded, c['id']),
                    )
                    relinked_collections += 1

            db.commit()
            return {
                'ok': True,
                'relinked_annotations': relinked_annotations,
                'relinked_relationships': relinked_relationships,
                'relinked_collections': relinked_collections,
            }
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()
