"""Prompt LoRAs: resolve text first, then use ComfyUI's native patching path."""
import html
import inspect
import json
import logging
import math
import re
from pathlib import Path, PurePosixPath
from threading import Lock
from urllib.parse import unquote

import comfy.sd
import comfy.utils
import folder_paths

from .json_literals import JsonLiterals
from .lora_previews import (
    find_preview, find_previews, preview_type, metadata_files,
    clear_preview_cache, preview_poster, media_dimensions,
)

logger = logging.getLogger(__name__)
NUMBER = r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?"
LORA_RE = re.compile(r"<lora:([^:<>\r\n]+)(?::(" + NUMBER + r")(?::(" + NUMBER + r"))?)?>", re.I)
MODES = ("auto", "external", "strip", "bypass")


def extract(text, source="positive"):
    literals = JsonLiterals()
    protected = literals.protect(text or "")
    records = []

    def capture(match):
        sm = float(match[2]) if match[2] is not None else 1.0
        sc = float(match[3]) if match[3] is not None else sm
        # An invalid number is authored text, never silently turned into weight 1.
        if not math.isfinite(sm) or not math.isfinite(sc) or not match[1].strip():
            return match[0]
        records.append(dict(name=match[1].strip(), weight=sm, model_strength=sm,
                            clip_strength=sc, source=source, status="pending"))
        return ""

    clean = LORA_RE.sub(capture, protected)
    # Do not normalize whitespace, lines, JSON, or ordinary prompt punctuation.
    return literals.restore(clean), records


def catalog():
    return list(folder_paths.get_filename_list("loras"))


_METADATA_CACHE = {}
_METADATA_LOCK = Lock()


def clear_metadata_cache():
    with _METADATA_LOCK:
        _METADATA_CACHE.clear()


def catalog_folders(names=None):
    if names is None:
        names = catalog()
    folders = set()
    for name in names:
        parts = name.replace("\\", "/").split("/")
        if len(parts) > 1:
            for i in range(1, len(parts)):
                folders.add("/".join(parts[:i]))
    return sorted(folders, key=lambda s: s.lower())


def read_safetensors_header(path):
    try:
        with open(path, "rb") as f:
            header_bytes = f.read(8)
            if len(header_bytes) < 8:
                return {}
            header_len = int.from_bytes(header_bytes, "little")
            if header_len <= 0 or header_len > 10 * 1024 * 1024:
                return {}
            header_json = f.read(header_len).decode("utf-8", errors="replace")
            data = json.loads(header_json)
            if not isinstance(data, dict):
                return {}
            meta = data.get("__metadata__", {})
            return meta if isinstance(meta, dict) else {}
    except Exception:
        return {}


def _clean_text(val, max_len=600):
    if not val or not isinstance(val, str):
        return ""
    text = re.sub(r"<[^>]+>", " ", val)
    text = html.unescape(text)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:max_len]


def _clean_multiline(val, max_len=4000):
    """Like _clean_text, but keeps paragraph/list breaks so descriptions stay readable."""
    if not val or not isinstance(val, str):
        return ""
    text = re.sub(r"(?i)<\s*br\s*/?\s*>", "\n", val)
    text = re.sub(r"(?i)</\s*(p|div|li|h[1-6]|ul|ol|tr|blockquote)\s*>", "\n", text)
    text = re.sub(r"(?i)<\s*li[^>]*>", "\u2022 ", text)
    text = re.sub(r"<[^>]+>", "", text)
    text = html.unescape(text)
    text = re.sub(r"[ \t\f\v\u00a0]+", " ", text)
    text = re.sub(r" ?\n ?", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()[:max_len]


def _safe_count(val):
    if isinstance(val, bool) or not isinstance(val, (int, float)) or not math.isfinite(val) or val < 0:
        return None
    return int(val)


def _normalize_base_model(val):
    if not val or not isinstance(val, str):
        return ""
    v = val.strip()
    low = v.lower()
    if low in ("unknown", "none", "n/a"):
        return ""
    if "flux" in low:
        return "FLUX"
    if "pony" in low:
        return "Pony"
    if "illustrious" in low:
        return "Illustrious"
    if "sdxl" in low or "sd_xl" in low:
        return "SDXL"
    if "1.5" in low or "v1-5" in low or "sd1" in low or "sd_v1" in low:
        return "SD1.5"
    if "2.1" in low or "2.0" in low:
        return "SD2.x"
    return v[:80]


def get_lora_metadata(filename, full_path=None):
    if not full_path:
        full_path = folder_paths.get_full_path("loras", filename)
    if not full_path:
        return {
            "name": filename,
            "filename": filename,
            "folder": str(PurePosixPath(filename.replace("\\", "/")).parent) if "/" in filename.replace("\\", "/") else "",
            "triggers": [],
            "base_model": "",
            "description": "",
            "civitai_id": None,
            "tags": [],
            "size_bytes": None,
            "has_preview": False,
            "preview_width": None,
            "preview_height": None,
        }
    p = Path(full_path).resolve()
    base = p.with_suffix("")
    json_candidates = metadata_files(p)
    txt_candidates = [base.with_name(base.name + ".txt"), p.with_name(p.name + ".txt")]
    previews = find_previews(str(p))
    preview = next(iter(previews), None)
    signature = []
    for candidate in [p, *json_candidates, *txt_candidates, *previews]:
        try:
            st = candidate.stat()
            signature.append((str(candidate), st.st_mtime_ns, st.st_size))
        except OSError:
            signature.append((str(candidate), None, None))
    signature = tuple(signature)
    cache_key = (str(p), filename)
    with _METADATA_LOCK:
        cached = _METADATA_CACHE.get(cache_key)
        if cached and cached[0] == signature:
            _METADATA_CACHE[cache_key] = _METADATA_CACHE.pop(cache_key)
            return cached[1]

    folder_str = str(PurePosixPath(filename.replace("\\", "/")).parent)
    if folder_str == ".":
        folder_str = ""

    triggers = []
    base_model = ""
    description = ""
    civitai_id = None
    tags = []
    title = version = author = ""
    recommended_strength = recommended_clip_strength = None
    civitai_version_id = download_count = thumbs_up = None
    sources = []

    # 1. Check sidecar JSON files (Civitai helper, LoRA manager, etc.)
    for jf in json_candidates:
        try:
            if jf.resolve().parent == p.parent and jf.is_file() and jf.stat().st_size <= 2 * 1024 * 1024:
                data = json.loads(jf.read_text(encoding="utf-8-sig", errors="replace"))
                if not isinstance(data, dict):
                    continue
                sources.append(jf.name)
                # Managers wrap version data differently. Merge complementary local
                # sidecars; an empty JSON file must not hide a useful later one.
                nested = data.get("modelVersion") or data.get("civitai")
                model_data = data.get("model")
                layers = [data]
                for key in ("metadata", "data"):
                    if isinstance(data.get(key), dict):
                        layers.append(data[key])
                tips = data.get("usage_tips")
                if isinstance(tips, str):
                    try:
                        tips = json.loads(tips)
                    except ValueError:
                        tips = None
                if isinstance(tips, dict):
                    layers.append(tips)
                if isinstance(nested, dict):
                    layers.append(nested)
                    if isinstance(nested.get("model"), dict):
                        model_data = nested["model"]
                if isinstance(model_data, dict):
                    layers.append(model_data)
                    title = title or _clean_text(model_data.get("name"), 160)
                for layer in layers:
                    tw = (layer.get("trainedWords") or layer.get("trigger_words")
                          or layer.get("triggers") or layer.get("activation text")
                          or layer.get("activationText") or layer.get("triggerWords")
                          or layer.get("trained_words") or layer.get("trigger_word"))
                    if isinstance(tw, str):
                        tw = re.split(r"[,;\n]+", tw)
                    if isinstance(tw, list):
                        for word in tw[:64]:
                            if isinstance(word, dict):
                                # rgthree stores word/count records, including training
                                # statistics. Only explicitly authored/Civitai words count.
                                if word.get("civitai") is not True and word.get("user") is not True:
                                    continue
                                word = word.get("word")
                            if isinstance(word, str) and word.strip():
                                triggers.append(_clean_text(word, 600))
                    base_model = base_model or _normalize_base_model(layer.get("baseModel") or layer.get("base_model"))
                    description = description or _clean_multiline(layer.get("description") or layer.get("modelDescription"))
                    title = title or _clean_text(layer.get("model_name") or layer.get("modelName") or layer.get("name"), 160)
                    version = version or _clean_text(layer.get("versionName"), 100)
                    creator = layer.get("creator")
                    author = author or _clean_text(creator.get("username") if isinstance(creator, dict) else layer.get("author"), 100)
                    if not civitai_id:
                        cid = layer.get("modelId")
                        if isinstance(cid, int) and not isinstance(cid, bool):
                            civitai_id = cid
                    if isinstance(layer.get("tags"), list):
                        tags.extend(_clean_text(t, 80) for t in layer["tags"][:16] if isinstance(t, str))
                    vid = layer.get("modelVersionId")
                    if civitai_version_id is None and isinstance(vid, int) and not isinstance(vid, bool) and vid > 0:
                        civitai_version_id = vid
                    layer_stats = layer.get("stats")
                    if isinstance(layer_stats, dict):
                        if download_count is None:
                            download_count = _safe_count(layer_stats.get("downloadCount"))
                        if thumbs_up is None:
                            thumbs_up = _safe_count(layer_stats.get("thumbsUpCount", layer_stats.get("rating")))
                    strength = layer.get("preferred weight", layer.get("recommended_strength", layer.get("strength")))
                    if recommended_strength is None and isinstance(strength, (int, float)) and not isinstance(strength, bool) and math.isfinite(strength) and abs(strength) <= 100:
                        recommended_strength = strength
                    clip_strength = layer.get("clip_strength")
                    if recommended_clip_strength is None and isinstance(clip_strength, (int, float)) and not isinstance(clip_strength, bool) and math.isfinite(clip_strength) and abs(clip_strength) <= 100:
                        recommended_clip_strength = clip_strength
                if isinstance(nested, dict):
                    nested_id = nested.get("id")
                    if civitai_version_id is None and isinstance(nested_id, int) and not isinstance(nested_id, bool) and nested_id > 0:
                        civitai_version_id = nested_id
                    version = version or _clean_text(nested.get("name"), 100)
                elif isinstance(model_data, dict):
                    version = version or _clean_text(data.get("name"), 100)
        except (OSError, ValueError, TypeError, RecursionError):
            continue

    # 2. Check sidecar text files (.txt)
    for tf in txt_candidates:
        try:
            if tf.resolve().parent == p.parent and tf.is_file() and tf.stat().st_size <= 64 * 1024:
                txt_content = tf.read_text(encoding="utf-8", errors="replace").strip()
                if txt_content:
                    lines = [ln.strip() for ln in re.split(r"[\r\n,]+", txt_content) if ln.strip()]
                    for ln in lines[:16]:
                        if len(ln) < 80 and not ln.startswith("#") and ln not in triggers:
                            triggers.append(ln)
        except OSError:
            continue

    # 3. Check safetensors header metadata
    if p.suffix.lower() == ".safetensors":
        meta = read_safetensors_header(p)
        if meta:
            if not base_model:
                base_model = _normalize_base_model(meta.get("ss_base_model_version") or meta.get("modelspec.architecture"))
            if not description:
                description = _clean_multiline(meta.get("modelspec.description"))
            tp = meta.get("modelspec.trigger_phrase") or meta.get("modelspec.trigger_word")
            if tp and isinstance(tp, str):
                for t in re.split(r"[,;\n]+", tp):
                    t = t.strip()
                    if t and t not in triggers:
                        triggers.append(t)
            # Training tag frequency is not a list of activation phrases.
            title = title or _clean_text(meta.get("modelspec.title"), 160)
            author = author or _clean_text(meta.get("modelspec.author"), 100)

    # Deduplicate triggers preserving original order
    seen_triggers = set()
    deduped_triggers = []
    for t in triggers:
        norm_t = t.lower()
        if norm_t not in seen_triggers:
            seen_triggers.add(norm_t)
            deduped_triggers.append(t)

    has_preview = preview is not None
    try:
        size_bytes = p.stat().st_size
    except OSError:
        size_bytes = None
    civitai_url = ""
    if civitai_id:
        civitai_url = f"https://civitai.com/models/{civitai_id}"
        if civitai_version_id:
            civitai_url += f"?modelVersionId={civitai_version_id}"

    preview_options = []
    primary_dims = None
    for i, path in enumerate(previews):
        option = {"type": preview_type(path), "name": path.name, "index": i}
        dims = media_dimensions(path)
        if dims:
            option["width"] = dims[0]
            option["height"] = dims[1]
        if i == 0:
            primary_dims = dims
        preview_options.append(option)

    result = {
        "name": filename,
        "filename": filename,
        "folder": folder_str,
        "triggers": deduped_triggers[:24],
        "base_model": base_model,
        "description": description,
        "civitai_id": civitai_id,
        "tags": list(dict.fromkeys(t for t in tags if t))[:16],
        "title": title,
        "version": version,
        "author": author,
        "recommended_strength": recommended_strength,
        "recommended_clip_strength": recommended_clip_strength,
        "metadata_sources": sources,
        "size_bytes": size_bytes,
        "civitai_url": civitai_url,
        "download_count": download_count,
        "thumbs_up": thumbs_up,
        "has_preview": has_preview,
        "preview_type": preview_type(preview) if has_preview else None,
        "preview_name": preview.name if preview else "",
        "preview_width": primary_dims[0] if primary_dims else None,
        "preview_height": primary_dims[1] if primary_dims else None,
        "preview_options": preview_options,
    }

    with _METADATA_LOCK:
        if cache_key in _METADATA_CACHE:
            _METADATA_CACHE.pop(cache_key)
        elif len(_METADATA_CACHE) >= 2048:
            _METADATA_CACHE.pop(next(iter(_METADATA_CACHE)))
        _METADATA_CACHE[cache_key] = (signature, result)
    return result


def resolve_name(name, names):
    normalized = name.replace("\\", "/")
    exact = {value.replace("\\", "/"): value for value in names}
    # Exact filenames always win. Encoded aliases let the picker protect filenames
    # containing wildcard/choice delimiters from the prompt resolver.
    if normalized not in exact:
        normalized = unquote(normalized)
    parts = normalized.split("/")
    if normalized.startswith("/") or ":" in normalized or any(p in ("", ".", "..") for p in parts):
        return None, "invalid"
    if normalized in exact:
        return exact[normalized], "found"
    matches = [value for value in names if str(PurePosixPath(value.replace("\\", "/")).with_suffix("")) == normalized]
    if len(matches) == 1:
        return matches[0], "found"
    return None, "ambiguous" if matches else "missing"


def apply(model, clip, records, cache=None, mode="auto"):
    cache = {} if cache is None else cache
    names = None
    for record in records:
        sm = record["model_strength"] if model is not None else 0.0
        sc = record["clip_strength"] if clip is not None else 0.0
        record.update(effective_model_strength=sm, effective_clip_strength=sc)
        if mode in ("external", "strip"):
            record["status"] = "external" if mode == "external" else "stripped"
            continue
        if model is None and clip is None:
            record["status"] = "text_only"
            continue
        if sm == 0 and sc == 0:
            record["status"] = "disabled"
            continue
        if names is None:
            names = catalog()
        filename, status = resolve_name(record["name"], names)
        if filename is None:
            record["status"] = status
            logger.warning("Prompt Palette LoRA %r: %s; skipped", record["name"], status)
            continue
        path = folder_paths.get_full_path("loras", filename)
        if path is None:
            record["status"] = "missing"
            logger.warning("Prompt Palette LoRA %r disappeared; skipped", filename)
            continue
        loader = comfy.sd.load_lora_for_models
        if mode == "bypass":
            loader = getattr(comfy.sd, "load_bypass_lora_for_models", None)
            if loader is None:
                raise RuntimeError("This ComfyUI version has no native bypass LoRA loader. Choose Auto or use an external loader.")
        if path not in cache:
            if "return_metadata" in inspect.signature(comfy.utils.load_torch_file).parameters:
                data, metadata = comfy.utils.load_torch_file(path, safe_load=True, return_metadata=True)
            else:
                data, metadata = comfy.utils.load_torch_file(path, safe_load=True), None
            while len(cache) >= 4:
                cache.pop(next(iter(cache)))
            cache[path] = (data, metadata)
        data, metadata = cache[path]
        kwargs = {"lora_metadata": metadata} if "lora_metadata" in inspect.signature(loader).parameters else {}
        model, clip = loader(model, clip, data, sm, sc, **kwargs)
        record.update(status="loaded", filename=filename)
    return model, clip


def process(positive, negative, model, clip, mode="auto", cache=None):
    mode = mode if mode in MODES else "auto"
    clean, records = extract(positive)
    clean_negative, neg_records = extract(negative, "negative")
    records.extend(neg_records)
    model, clip = apply(model, clip, records, cache, mode)
    # External loaders need the resolved tags; our own encoding always uses clean text.
    preserve = mode == "external" or (mode == "auto" and model is None and clip is None)
    return (positive if preserve else clean, negative if preserve else clean_negative,
            clean, clean_negative, model, clip, records)
