"""Bounded, local-only LoRA artwork and sidecar discovery."""
import io
import json
from functools import lru_cache
from threading import BoundedSemaphore, Lock
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
_DIMENSIONS_CACHE = {}
_POSTER_DIMS = {}
_CACHE_LOCK = Lock()
_POSTER_SLOTS = BoundedSemaphore(2)
_ROTATED_ORIENTATIONS = frozenset((5, 6, 7, 8))


def clear_preview_cache():
    with _CACHE_LOCK:
        _DIRECTORIES.clear()
        _JSON_CACHE.clear()
        _DIMENSIONS_CACHE.clear()
        _POSTER_DIMS.clear()
    _poster_bytes.cache_clear()


def preview_type(path):
    return 'video' if path and Path(path).suffix.lower() in VIDEO_TYPES else 'image'


# A trailing counter such as "_2", ".1" or " (3)", optionally preceded by a preview label.
_NUMBER_TAIL = re.compile(r'(?:[._-]\d+| \(\d+\))$')
_LABEL_TAIL = re.compile(r'[._-](?:preview|thumb|thumbnail)$', re.I)


class _Directory:
    """One directory listing plus everything the lookups derive from it.

    Preview and sidecar discovery runs once per LoRA. Counting model files and scanning every
    entry for numbered previews inside each lookup made a flat folder of N models cost
    O(N x files); the listing is immutable, so derive that once per listing instead.
    """
    __slots__ = ('entries', 'ordered', 'single_model', '_numbered', '_irregular')

    def __init__(self, entries):
        self.entries = entries
        self.ordered = sorted(entries.values(), key=lambda p: p.name.casefold())
        self.single_model = sum(p.suffix.lower() in _MODEL_EXTS for p in entries.values()) == 1
        self._numbered = None
        self._irregular = ()

    def _build_numbered(self):
        index, irregular = {}, []
        for position, candidate in enumerate(self.ordered):
            stem = candidate.stem
            if not stem.isascii():
                # Regex case-folding rules differ for non-ASCII text: always test these exactly.
                irregular.append(position)
                continue
            tail = _NUMBER_TAIL.search(stem)
            if not tail:
                continue
            base = stem[:tail.start()]
            index.setdefault(base.lower(), []).append(position)
            label = _LABEL_TAIL.search(base)
            if label:
                index.setdefault(base[:label.start()].lower(), []).append(position)
        self._numbered, self._irregular = index, tuple(irregular)

    def numbered_candidates(self, stems):
        """Entries that could be numbered previews of these stems, in name order.

        A superset of the matches: the caller still applies the exact pattern. Names the index
        cannot judge safely (non-ASCII on either side) are always included.
        """
        if any(not stem.isascii() for stem in stems):
            return self.ordered
        if self._numbered is None:
            self._build_numbered()
        positions = set(self._irregular)
        for stem in stems:
            positions.update(self._numbered.get(stem, ()))
        return [self.ordered[position] for position in sorted(positions)]


def _directory(parent):
    stamp, now = parent.stat().st_mtime_ns, monotonic()
    with _CACHE_LOCK:
        cached = _DIRECTORIES.get(parent)
        if cached and cached[0] == stamp and now - cached[1] < 2:
            _DIRECTORIES[parent] = _DIRECTORIES.pop(parent)
            return cached[2]
    directory = _Directory({p.name.casefold(): p for p in sorted(parent.iterdir(), key=lambda p: p.name)})
    with _CACHE_LOCK:
        if parent in _DIRECTORIES:
            _DIRECTORIES.pop(parent)
        elif len(_DIRECTORIES) >= 512:
            _DIRECTORIES.pop(next(iter(_DIRECTORIES)))
        _DIRECTORIES[parent] = (stamp, now, directory)
    return directory


def metadata_files(full_path):
    full = Path(full_path).resolve()
    try:
        directory = _directory(full.parent)
    except OSError:
        return []
    entries = directory.entries
    candidates = []
    for suffix in ('.civitai.info', '.json', '.metadata.json', '.info.json', '.user.info', '.rgthree-info.json', '.info'):
        for stem in (full.stem.casefold(), full.name.casefold()):
            candidate = entries.get(stem + suffix)
            if candidate and candidate not in candidates:
                candidates.append(candidate)
    # A generic file belongs to a model only in an unambiguous model folder.
    if directory.single_model:
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
        with _CACHE_LOCK:
            cached = _JSON_CACHE.get(path)
            if cached and cached[0] == signature:
                return cached[1]
        data = json.loads(path.read_text(encoding='utf-8-sig', errors='replace'))
        with _CACHE_LOCK:
            if path in _JSON_CACHE:
                _JSON_CACHE.pop(path)
            elif len(_JSON_CACHE) >= 2048:
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
        directory = _directory(parent)
    except OSError:
        return []
    entries = directory.entries
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
    for candidate in directory.numbered_candidates(stems):
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
    if directory.single_model:
        for label in ('preview', 'thumbnail', 'thumb', 'cover', 'image', 'video'):
            for ext in MEDIA_TYPES:
                add(entries.get(label + ext))
        for candidate in directory.ordered:
            add(candidate)
    return found


def find_preview(full_path, max_bytes=None):
    return next(iter(find_previews(full_path, max_bytes)), None)


def _read_header_bytes(path_or_bytes, max_bytes=65536):
    if isinstance(path_or_bytes, (bytes, bytearray)):
        return bytes(path_or_bytes[:max_bytes])
    try:
        with open(path_or_bytes, 'rb') as f:
            return f.read(max_bytes)
    except OSError:
        return b''


def _parse_exif_orientation(tiff):
    import struct
    if len(tiff) < 8:
        return None
    endian = '<' if tiff[:2] == b'II' else ('>' if tiff[:2] == b'MM' else None)
    if not endian:
        return None
    magic, offset = struct.unpack(endian + 'HI', tiff[2:8])
    if magic != 42 or offset + 2 > len(tiff):
        return None
    count = struct.unpack(endian + 'H', tiff[offset:offset + 2])[0]
    pos = offset + 2
    for _ in range(min(count, 64)):
        if pos + 12 > len(tiff):
            break
        tag, dtype, num = struct.unpack(endian + 'HHI', tiff[pos:pos + 8])
        if tag == 0x0112 and dtype == 3 and num >= 1:
            return struct.unpack(endian + 'H', tiff[pos + 8:pos + 10])[0]
        pos += 12
    return None


def _fallback_image_dimensions(path_or_bytes):
    import struct
    data = _read_header_bytes(path_or_bytes, 65536)
    if len(data) < 10:
        return None
    if data.startswith(b'\x89PNG\r\n\x1a\n') and len(data) >= 24 and data[12:16] == b'IHDR':
        w, h = struct.unpack('>II', data[16:24])
        return (int(w), int(h)) if w > 0 and h > 0 else None
    if data[:6] in (b'GIF87a', b'GIF89a'):
        w, h = struct.unpack('<HH', data[6:10])
        return (int(w), int(h)) if w > 0 and h > 0 else None
    if data[:2] == b'BM' and len(data) >= 26:
        dib_size = struct.unpack('<I', data[14:18])[0]
        if dib_size >= 40:
            w, h = struct.unpack('<ii', data[18:26])
            h = abs(h)
            return (int(w), int(h)) if w > 0 and h > 0 else None
    if data[:4] == b'RIFF' and len(data) >= 30 and data[8:12] == b'WEBP':
        chunk = data[12:16]
        if chunk == b'VP8 ' and data[23:26] == b'\x9d\x01\x2a':
            w, h = struct.unpack('<HH', data[26:30])
            w, h = w & 0x3FFF, h & 0x3FFF
            return (int(w), int(h)) if w > 0 and h > 0 else None
        if chunk == b'VP8L' and data[20] == 0x2F:
            bits = struct.unpack('<I', data[21:25])[0]
            w = (bits & 0x3FFF) + 1
            h = ((bits >> 14) & 0x3FFF) + 1
            return (int(w), int(h)) if w > 0 and h > 0 else None
        if chunk == b'VP8X':
            w = int.from_bytes(data[24:27], 'little') + 1
            h = int.from_bytes(data[27:30], 'little') + 1
            return (int(w), int(h)) if w > 0 and h > 0 else None
    if data.startswith(b'\xff\xd8'):
        pos = 2
        orientation = None
        while pos + 4 <= len(data):
            if data[pos] != 0xFF:
                pos += 1
                continue
            while pos < len(data) and data[pos] == 0xFF:
                pos += 1
            if pos >= len(data):
                break
            marker = data[pos]
            pos += 1
            if marker in (0xD8, 0xD9) or 0xD0 <= marker <= 0xD7:
                continue
            if pos + 2 > len(data):
                break
            seg_len = struct.unpack('>H', data[pos:pos + 2])[0]
            if seg_len < 2:
                break
            seg_data = data[pos + 2:pos + seg_len]
            if marker == 0xE1 and seg_data.startswith(b'Exif\x00\x00'):
                orientation = _parse_exif_orientation(seg_data[6:])
            elif 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC) and len(seg_data) >= 5:
                h, w = struct.unpack('>HH', seg_data[1:5])
                if w > 0 and h > 0:
                    if orientation in _ROTATED_ORIENTATIONS:
                        w, h = h, w
                    return (int(w), int(h))
            pos += seg_len
    return None


def _parse_mp4_tkhd(buf):
    import struct
    idx = 0
    while True:
        found = buf.find(b'tkhd', idx)
        if found < 4:
            if found < 0:
                break
            idx = found + 4
            continue
        box_size = struct.unpack('>I', buf[found - 4:found])[0]
        body_start = found + 4
        if box_size >= 92 and body_start + 84 <= len(buf):
            version = buf[body_start]
            if version == 0 and body_start + 84 <= len(buf):
                w_fixed, h_fixed = struct.unpack('>II', buf[body_start + 76:body_start + 84])
                w, h = w_fixed >> 16, h_fixed >> 16
                if w > 0 and h > 0:
                    return (int(w), int(h))
            elif version == 1 and body_start + 96 <= len(buf):
                w_fixed, h_fixed = struct.unpack('>II', buf[body_start + 88:body_start + 96])
                w, h = w_fixed >> 16, h_fixed >> 16
                if w > 0 and h > 0:
                    return (int(w), int(h))
        idx = found + 4
    return None


def _read_ebml_vint(buf, pos, keep_marker=False):
    if pos >= len(buf):
        return None, pos
    first = buf[pos]
    if first == 0:
        return None, pos + 1
    mask = 0x80
    length = 1
    while length <= 8 and not (first & mask):
        mask >>= 1
        length += 1
    if length > 8 or pos + length > len(buf):
        return None, len(buf)
    val = first if keep_marker else (first & (mask - 1))
    for i in range(1, length):
        val = (val << 8) | buf[pos + i]
    return val, pos + length


def _parse_webm_dimensions(buf):
    if not buf.startswith(b'\x1a\x45\xdf\xa3'):
        return None
    # Scan for Video Track element (0xE0) containing PixelWidth (0xB0) and PixelHeight (0xBA)
    idx = 0
    while idx < len(buf) - 6:
        pos = buf.find(b'\xe0', idx)
        if pos < 0:
            break
        size, cur = _read_ebml_vint(buf, pos + 1, keep_marker=False)
        if size is not None and 4 <= size <= 256 and cur + size <= len(buf):
            end = cur + size
            w = h = None
            while cur < end:
                elem_id, cur = _read_ebml_vint(buf, cur, keep_marker=True)
                if elem_id is None or cur >= end:
                    break
                elem_size, cur = _read_ebml_vint(buf, cur, keep_marker=False)
                if elem_size is None or cur + elem_size > end:
                    break
                if elem_id == 0xB0 and 1 <= elem_size <= 4:
                    w = int.from_bytes(buf[cur:cur + elem_size], 'big')
                elif elem_id == 0xBA and 1 <= elem_size <= 4:
                    h = int.from_bytes(buf[cur:cur + elem_size], 'big')
                cur += elem_size
            if w and h and w > 0 and h > 0:
                return (int(w), int(h))
        idx = pos + 1
    return None


def read_video_dimensions(path_or_bytes):
    """Read (width, height) from MP4/M4V tkhd or WebM EBML headers without spawning ffmpeg."""
    if not path_or_bytes:
        return None
    head = _read_header_bytes(path_or_bytes, 65536)
    if not head:
        return None
    if head.startswith(b'\x1a\x45\xdf\xa3'):
        return _parse_webm_dimensions(head)
    dims = _parse_mp4_tkhd(head)
    if dims:
        return dims
    if not isinstance(path_or_bytes, (bytes, bytearray)):
        try:
            with open(path_or_bytes, 'rb') as f:
                f.seek(0, 2)
                total = f.tell()
                if total > 65536:
                    tail_size = min(131072, total)
                    f.seek(total - tail_size)
                    return _parse_mp4_tkhd(f.read(tail_size))
        except OSError:
            pass
    return None


def read_image_dimensions(path_or_bytes):
    """Read (width, height) from image headers without decoding pixels, honoring EXIF orientation."""
    if not path_or_bytes:
        return None
    try:
        from PIL import Image
        source = io.BytesIO(path_or_bytes) if isinstance(path_or_bytes, (bytes, bytearray)) else path_or_bytes
        with Image.open(source) as img:
            width, height = int(img.width), int(img.height)
            if width <= 0 or height <= 0:
                return None
            orientation = None
            try:
                exif = img.getexif() if hasattr(img, 'getexif') else None
                if exif:
                    orientation = exif.get(274)
            except Exception:
                orientation = None
            if orientation in _ROTATED_ORIENTATIONS:
                width, height = height, width
            return (width, height)
    except Exception:
        return _fallback_image_dimensions(path_or_bytes)


def media_dimensions(path):
    """Return cached (width, height) for a local preview without eagerly spawning ffmpeg."""
    if not path:
        return None
    p = Path(path)
    ext = p.suffix.lower()
    if ext not in MEDIA_TYPES:
        return None
    try:
        st = p.stat()
    except OSError:
        return None
    key = (str(p), st.st_mtime_ns, st.st_size)
    with _CACHE_LOCK:
        if key in _DIMENSIONS_CACHE:
            dims = _DIMENSIONS_CACHE.pop(key)
            _DIMENSIONS_CACHE[key] = dims
            return dims
        if ext in VIDEO_TYPES and key in _POSTER_DIMS:
            return _POSTER_DIMS[key]
    if ext in VIDEO_TYPES:
        dims = read_video_dimensions(p)
        if dims is not None:
            with _CACHE_LOCK:
                if key in _DIMENSIONS_CACHE:
                    _DIMENSIONS_CACHE.pop(key)
                elif len(_DIMENSIONS_CACHE) >= 2048:
                    _DIMENSIONS_CACHE.pop(next(iter(_DIMENSIONS_CACHE)))
                _DIMENSIONS_CACHE[key] = dims
        return dims
    if ext not in IMAGE_TYPES:
        return None
    dims = read_image_dimensions(p)
    with _CACHE_LOCK:
        if key in _DIMENSIONS_CACHE:
            _DIMENSIONS_CACHE.pop(key)
        elif len(_DIMENSIONS_CACHE) >= 2048:
            _DIMENSIONS_CACHE.pop(next(iter(_DIMENSIONS_CACHE)))
        _DIMENSIONS_CACHE[key] = dims
    return dims


def preview_poster(path):
    """Use an already installed local decoder only when a browser cannot play a clip."""
    try:
        st = path.stat()
        return _poster_bytes(str(path), st.st_mtime_ns, st.st_size)
    except OSError:
        return None


@lru_cache(maxsize=512)
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
                 '-vf', 'scale=512:512:force_original_aspect_ratio=decrease',
                 '-f', 'image2pipe', '-vcodec', 'mjpeg', '-threads', '1', 'pipe:1'],
                capture_output=True, timeout=12, check=False,
                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
            )
        data = result.stdout
        if result.returncode == 0 and data.startswith(b'\xff\xd8') and len(data) <= 4 * 1024 * 1024:
            dims = read_image_dimensions(data)
            if dims:
                key = (path, _mtime, _size)
                with _CACHE_LOCK:
                    if len(_POSTER_DIMS) >= 512:
                        _POSTER_DIMS.pop(next(iter(_POSTER_DIMS)))
                    _POSTER_DIMS[key] = dims
            return data
        return None
    except (OSError, subprocess.SubprocessError):
        return None
