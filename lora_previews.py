"""Bounded, local-only LoRA artwork and sidecar discovery."""
import json
from functools import lru_cache
from threading import BoundedSemaphore
import re
from pathlib import Path
from time import monotonic
from urllib.parse import unquote, urlsplit

IMAGE_TYPES = {'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
               '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif', '.bmp': 'image/bmp'}
VIDEO_TYPES = {'.mp4': 'video/mp4', '.webm': 'video/webm', '.m4v': 'video/mp4'}
MEDIA_TYPES = {**IMAGE_TYPES, **VIDEO_TYPES}
_MODEL_EXTS = frozenset(('.safetensors', '.ckpt', '.pt', '.pth', '.bin', '.sft'))
_DIRECTORIES = {}
_JSON_CACHE = {}
_POSTER_SLOTS = BoundedSemaphore(2)


def clear_preview_cache():
    _DIRECTORIES.clear()
    _JSON_CACHE.clear()
    _poster_bytes.cache_clear()


def preview_type(path):
    return 'video' if path and Path(path).suffix.lower() in VIDEO_TYPES else 'image'


def _entries(parent):
    stamp, now = parent.stat().st_mtime_ns, monotonic()
    cached = _DIRECTORIES.get(parent)
    if cached and cached[0] == stamp and now - cached[1] < 2:
        return cached[2]
    entries = {p.name.casefold(): p for p in sorted(parent.iterdir(), key=lambda p: p.name)}
    if len(_DIRECTORIES) >= 128:
        _DIRECTORIES.pop(next(iter(_DIRECTORIES)))
    _DIRECTORIES[parent] = (stamp, now, entries)
    return entries


def _single_model(entries):
    return sum(p.suffix.lower() in _MODEL_EXTS for p in entries.values()) == 1


def metadata_files(full_path):
    full = Path(full_path).resolve()
    try:
        entries = _entries(full.parent)
    except OSError:
        return []
    candidates = []
    for suffix in ('.civitai.info', '.json', '.metadata.json', '.info.json', '.user.info', '.rgthree-info.json', '.info'):
        for stem in (full.stem.casefold(), full.name.casefold()):
            candidate = entries.get(stem + suffix)
            if candidate and candidate not in candidates:
                candidates.append(candidate)
    # A generic file belongs to a model only in an unambiguous model folder.
    if _single_model(entries):
        for name in ('metadata.json', 'civitai.info', 'model.json', 'info.json'):
            candidate = entries.get(name)
            if candidate and candidate not in candidates:
                candidates.append(candidate)
    return [p for p in candidates if p.resolve().parent == full.parent]


def _read_json(path):
    try:
        st = path.stat()
        if st.st_size > 2 * 1024 * 1024:
            return None
        signature = (st.st_mtime_ns, st.st_size)
        cached = _JSON_CACHE.get(path)
        if cached and cached[0] == signature:
            return cached[1]
        data = json.loads(path.read_text(encoding='utf-8-sig', errors='replace'))
        if len(_JSON_CACHE) >= 2048:
            _JSON_CACHE.pop(next(iter(_JSON_CACHE)))
        _JSON_CACHE[path] = (signature, data)
        return data
    except (OSError, ValueError, RecursionError):
        return None


def find_previews(full_path, max_bytes=None):
    if not full_path:
        return []
    full = Path(full_path).resolve()
    parent = full.parent
    try:
        entries = _entries(parent)
    except OSError:
        return []
    found, seen = [], set()

    def add(path):
        if path is None or len(found) >= 16:
            return
        try:
            resolved = path.resolve()
            if (resolved.parent != parent or path.suffix.lower() not in MEDIA_TYPES
                    or resolved in seen or not path.is_file()
                    or (max_bytes is not None and path.stat().st_size > max_bytes)):
                return
            seen.add(resolved)
            found.append(path)
        except (OSError, ValueError, RuntimeError):
            return

    stems = (full.stem.casefold(), full.name.casefold())
    for label in ('.preview', '_preview', '-preview', '', '.thumb', '.thumbnail'):
        for ext in MEDIA_TYPES:
            for stem in stems:
                add(entries.get(stem + label + ext))
    numbered = re.compile(r'^(?:' + '|'.join(re.escape(s) for s in stems)
                          + r')(?:[._-](?:preview|thumb|thumbnail))?(?:[._-]\d+| \(\d+\))$', re.I)
    for candidate in sorted(entries.values(), key=lambda p: p.name.casefold()):
        if numbered.fullmatch(candidate.stem):
            add(candidate)

    for sidecar in metadata_files(full):
        stack = [(_read_json(sidecar), 0)]
        while stack:
            item, depth = stack.pop()
            if depth > 6:
                continue
            if isinstance(item, dict):
                for key, value in item.items():
                    if key in ('images', 'previews', 'preview', 'image', 'previewImage', 'thumbnail', 'modelVersion', 'civitai', 'metadata', 'model', 'data'):
                        stack.append((value, depth + 1))
                    elif key in ('path', 'filename', 'file_name', 'url', 'local_path', 'localPath', 'image_path', 'video_path', 'preview_path', 'preview_file', 'thumbnail_url') and isinstance(value, str):
                        stack.append((value, depth + 1))
            elif isinstance(item, list):
                stack.extend((v, depth + 1) for v in reversed(item[:64]))
            elif isinstance(item, str):
                try:
                    parsed = urlsplit(item)
                    # Provider URLs are filename hints only. Never fetch one.
                    if parsed.scheme in ('http', 'https') and parsed.netloc:
                        add(entries.get(Path(unquote(parsed.path)).name.casefold()))
                        continue
                    if parsed.scheme or parsed.netloc or parsed.query or parsed.fragment:
                        continue
                    local = unquote(parsed.path).replace('\\', '/')
                    if local.startswith('/') or any(p == '..' for p in local.split('/')):
                        continue
                    candidate = parent / local
                    if candidate.parent == parent:
                        add(entries.get(candidate.name.casefold(), candidate))
                except (OSError, ValueError):
                    continue
    if _single_model(entries):
        for label in ('preview', 'thumbnail', 'thumb', 'cover', 'image', 'video'):
            for ext in MEDIA_TYPES:
                add(entries.get(label + ext))
        for candidate in sorted(entries.values(), key=lambda p: p.name.casefold()):
            add(candidate)
    return found


def find_preview(full_path, max_bytes=None):
    return next(iter(find_previews(full_path, max_bytes)), None)


def preview_poster(path):
    """Use an already installed local decoder only when a browser cannot play a clip."""
    try:
        st = path.stat()
        return _poster_bytes(str(path), st.st_mtime_ns, st.st_size)
    except OSError:
        return None


@lru_cache(maxsize=128)
def _poster_bytes(path, _mtime, _size):
    import shutil
    import subprocess
    executable = shutil.which('ffmpeg')
    if not executable:
        try:
            import imageio_ffmpeg
            executable = imageio_ffmpeg.get_ffmpeg_exe()
        except (ImportError, RuntimeError, OSError):
            return None
    try:
        with _POSTER_SLOTS:
            result = subprocess.run(
                [executable, '-nostdin', '-v', 'error', '-threads', '1', '-i', path, '-frames:v', '1',
                 '-vf', 'scale=320:320:force_original_aspect_ratio=decrease',
                 '-f', 'image2pipe', '-vcodec', 'mjpeg', '-threads', '1', 'pipe:1'],
                capture_output=True, timeout=12, check=False,
                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
            )
        data = result.stdout
        return data if result.returncode == 0 and data.startswith(b'\xff\xd8') and len(data) <= 4 * 1024 * 1024 else None
    except (OSError, subprocess.SubprocessError):
        return None
