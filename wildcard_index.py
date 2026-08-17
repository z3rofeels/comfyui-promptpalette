from __future__ import annotations

import asyncio
import fnmatch
import json
import logging
import os
import re
import shutil
import tempfile
import threading
import time
from typing import Any

try:
    import yaml

    HAS_YAML = True
except ImportError:
    HAS_YAML = False

try:
    import folder_paths

    HAS_FOLDER_PATHS = True
except Exception:
    folder_paths = None
    HAS_FOLDER_PATHS = False

logger = logging.getLogger(__name__)

FOLDER_PATHS_KEY = "wildcards"
_NODE_DIR = os.path.dirname(os.path.abspath(__file__))
_LEGACY_LOCAL_CONFIG_PATH = os.path.join(_NODE_DIR, "wildcards_config.json")
_RAW_PATH_RE = re.compile(r'"wildcards_path"\s*:\s*"(.+?)"\s*[,}]', re.DOTALL)
MAX_SOURCE_FILE_BYTES = 32 * 1024 * 1024
_SOURCE_EXTENSIONS = (".txt", ".yaml", ".yml", ".json")
_WINDOWS_RESERVED_NAMES = {
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}


def _config_directory() -> str:
    if HAS_FOLDER_PATHS:
        get_user_directory = getattr(folder_paths, "get_user_directory", None)
        if callable(get_user_directory):
            try:
                return os.path.join(os.path.abspath(get_user_directory()), "prompt_palette")
            except Exception:
                logger.debug("Could not resolve ComfyUI's user directory", exc_info=True)
    return _NODE_DIR


_CONFIG_DIR = _config_directory()
_LOCAL_CONFIG_PATH = os.path.join(_CONFIG_DIR, "wildcards_config.json")
_LOCAL_CONFIG_EXAMPLE_PATH = os.path.join(_CONFIG_DIR, "wildcards_config.example.json")


def _atomic_write_text(path: str, text: str) -> None:
    """Replace a text file atomically; the temp file stays on the same volume."""
    directory = os.path.dirname(path) or "."
    os.makedirs(directory, exist_ok=True)
    fd, temp_path = tempfile.mkstemp(prefix=f".{os.path.basename(path)}.", suffix=".tmp", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, path)
    except Exception:
        try:
            os.unlink(temp_path)
        except OSError:
            pass
        raise


def _atomic_write_json(path: str, payload: dict[str, Any]) -> None:
    _atomic_write_text(path, json.dumps(payload, indent=2, ensure_ascii=False) + "\n")


def _write_example_config() -> None:
    if os.path.exists(_LOCAL_CONFIG_EXAMPLE_PATH):
        return
    try:
        _atomic_write_json(
            _LOCAL_CONFIG_EXAMPLE_PATH,
            {
                "_comment": (
                    "Change your path here, then rename this file to wildcards_config.json. "
                    "You can paste your folder path straight from File Explorer."
                ),
                "wildcards_path": "C:/ComfyUI/my_wildcards",
            },
        )
    except OSError:
        # Example creation is optional and must never prevent the node from loading.
        pass


_PROMPT_PALETTE_REGISTERED_PATHS: set[str] = set()


def _normalise_abs_path(path: str) -> str:
    return os.path.normcase(os.path.abspath(path))


def _path_from_extra_model_paths() -> str | None:
    if not HAS_FOLDER_PATHS:
        return None
    try:
        paths = folder_paths.get_folder_paths(FOLDER_PATHS_KEY)
    except Exception:
        return None
    for path in paths:
        if _normalise_abs_path(path) not in _PROMPT_PALETTE_REGISTERED_PATHS:
            return path
    return None


def _read_config_path(config_path: str) -> str | None:
    if not os.path.isfile(config_path):
        return None
    try:
        with open(config_path, "r", encoding="utf-8") as handle:
            text = handle.read()
    except OSError as exc:
        logger.warning("Could not read %s: %s", config_path, exc)
        return None

    try:
        parsed = json.loads(text)
        raw = parsed.get("wildcards_path") if isinstance(parsed, dict) else None
    except (ValueError, AttributeError):
        # Preserve support for Windows paths pasted into hand-edited JSON without escaped slashes.
        match = _RAW_PATH_RE.search(text)
        raw = match.group(1) if match else None
        if raw is None:
            logger.warning("Could not parse %s", config_path)
            return None

    if not isinstance(raw, str) or not raw.strip() or "\x00" in raw:
        return None
    raw = os.path.expanduser(os.path.expandvars(raw.strip()))
    if not os.path.isabs(raw):
        raw = os.path.join(os.path.dirname(config_path), raw)
    return raw


def _path_from_local_config(*, include_managed_override: bool = True) -> str | None:
    paths: list[str] = []
    if include_managed_override:
        paths.append(_LOCAL_CONFIG_PATH)
    if os.path.abspath(_LEGACY_LOCAL_CONFIG_PATH) != os.path.abspath(_LOCAL_CONFIG_PATH):
        paths.append(_LEGACY_LOCAL_CONFIG_PATH)
    for config_path in paths:
        configured = _read_config_path(config_path)
        if configured:
            return configured
    return None


def _default_wildcards_dir() -> str:
    base = getattr(folder_paths, "base_path", None) if HAS_FOLDER_PATHS else None
    return os.path.join(base, "wildcards") if base else os.path.join(_NODE_DIR, "wildcards")


def resolve_wildcard_root(*, include_managed_override: bool = True) -> str:
    _write_example_config()
    for candidate in (
        _path_from_local_config(include_managed_override=include_managed_override),
        _path_from_extra_model_paths(),
    ):
        if candidate:
            return os.path.abspath(candidate)
    return os.path.abspath(_default_wildcards_dir())


def _clean_lines(raw_lines) -> list[str]:
    output: list[str] = []
    for line in raw_lines:
        line = str(line).rstrip("\n").rstrip("\r")
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        output.append(line)
    return output


def _flatten_yaml(
    node,
    prefix: str = "",
    *,
    depth: int = 0,
    active_ids: set[int] | None = None,
) -> dict[str, list[str]]:
    if depth > 64:
        raise ValueError("wildcard YAML/JSON nesting is too deep")
    active_ids = active_ids if active_ids is not None else set()
    results: dict[str, list[str]] = {}

    if isinstance(node, (list, dict)):
        node_id = id(node)
        if node_id in active_ids:
            raise ValueError("wildcard YAML/JSON contains a recursive alias")
        active_ids.add(node_id)
        try:
            if isinstance(node, list):
                if prefix:
                    values: list[str] = []
                    for value in node:
                        if isinstance(value, (dict, list)):
                            raise ValueError("wildcard lists must contain scalar values")
                        values.append(str(value))
                    results[prefix] = values
                return results

            for key, value in node.items():
                safe_key = str(key).strip().replace("\\", "/").strip("/")
                if not safe_key or any(part in {"", ".", ".."} for part in safe_key.split("/")):
                    raise ValueError("wildcard YAML/JSON contains an invalid key")
                sub_prefix = f"{prefix}/{safe_key}" if prefix else safe_key
                results.update(
                    _flatten_yaml(value, sub_prefix, depth=depth + 1, active_ids=active_ids)
                )
            return results
        finally:
            active_ids.remove(node_id)

    if node is not None and prefix:
        results[prefix] = [str(node)]
    return results


def _normalise_wildcard_name(name: str) -> str:
    if not isinstance(name, str) or "\x00" in name:
        raise ValueError("invalid wildcard name")
    raw_name = name.strip()
    if not raw_name or raw_name.startswith(("/", "\\")) or re.match(r"^[A-Za-z]:", raw_name):
        raise ValueError("invalid wildcard name")
    safe_name = raw_name.replace("\\", "/").strip("/")
    parts = [part.strip() for part in safe_name.split("/")]
    if not parts or any(not part or part in {".", ".."} for part in parts):
        raise ValueError("invalid wildcard name")
    for part in parts:
        if re.search(r'[<>:"|?*]', part) or part.endswith((".", " ")):
            raise ValueError("wildcard names must be valid Windows filenames")
        stem = part.split(".", 1)[0].upper()
        if stem in _WINDOWS_RESERVED_NAMES:
            raise ValueError("wildcard name uses a reserved Windows filename")
    return "/".join(parts)


def _copy_entry(entry: dict[str, Any] | None) -> dict[str, Any] | None:
    if entry is None:
        return None
    return {
        "lines": list(entry.get("lines", [])),
        "type": entry.get("type", "txt"),
        "abs_path": entry.get("abs_path", ""),
    }


def _is_within_root(root_dir: str, path: str) -> bool:
    root = os.path.realpath(root_dir)
    target = os.path.realpath(path)
    try:
        return os.path.commonpath([root, target]) == root
    except ValueError:
        return False


def _source_signature(root_dir: str) -> tuple[tuple[str, int, int], ...]:
    signature: list[tuple[str, int, int]] = []
    for dirpath, dirnames, filenames in os.walk(root_dir):
        dirnames[:] = sorted(
            (name for name in dirnames if name not in {".git", "__pycache__"}),
            key=str.casefold,
        )
        for filename in sorted(filenames, key=str.casefold):
            if not filename.lower().endswith(_SOURCE_EXTENSIONS):
                continue
            abs_path = os.path.join(dirpath, filename)
            if not _is_within_root(root_dir, abs_path):
                continue
            try:
                stat = os.stat(abs_path)
            except OSError:
                continue
            rel_path = os.path.relpath(abs_path, root_dir).replace(os.sep, "/")
            signature.append((rel_path, stat.st_mtime_ns, stat.st_size))
    return tuple(signature)


class WildcardIndexPreview:
    """Read-only resolution view with private sequence counters for previews."""

    def __init__(self, source: "WildcardIndex"):
        self._source = source
        with source._seq_lock:
            self._seq_counters = dict(source._seq_counters)
        with source._combo_lock:
            self._combo_counters = dict(source._combo_counters)

    def get_lines(self, name: str) -> list[str]:
        return self._source.get_lines(name)

    def get_entry(self, name: str) -> dict[str, Any] | None:
        return self._source.get_entry(name)

    def next_sequential_index(self, key: str, length: int, step: int = 1) -> int:
        if length <= 0:
            return 0
        index = self._seq_counters.get(key, 0) % length
        self._seq_counters[key] = index + step
        return index

    def next_combinatorial_index(self, key: str, total: int) -> int:
        if total <= 0:
            return 0
        index = self._combo_counters.get(key, 0) % total
        self._combo_counters[key] = index + 1
        return index


class WildcardIndex:
    @staticmethod
    def normalize_name(name: str) -> str:
        return _normalise_wildcard_name(name)

    def preview_view(self) -> WildcardIndexPreview:
        return WildcardIndexPreview(self)

    def __init__(self, root_dir: str | None = None):
        self._registry_lock = threading.RLock()
        self._scan_lock = threading.Lock()
        self._seq_lock = threading.Lock()
        self._combo_lock = threading.Lock()

        root = os.path.abspath(root_dir) if root_dir else resolve_wildcard_root()
        os.makedirs(root, exist_ok=True)
        self.root_dir = root
        self._registry: dict[str, dict[str, Any]] = {}
        self._leaf_index: dict[str, list[str]] = {}
        self._tree: dict[str, list[dict[str, str]]] = {}
        self._last_scan = 0.0
        self._last_source_check = 0.0
        self._source_check_interval = 0.5
        self._last_known_source_check = 0.0
        self._known_source_check_interval = 0.005
        self._source_signature: tuple[tuple[str, int, int], ...] = ()
        self._revision = 0
        self._seq_counters: dict[str, int] = {}
        self._combo_counters: dict[str, int] = {}

        self._register_folder_path(root)
        logger.info("Prompt Palette wildcards folder: %s", root)

    @staticmethod
    def _build_leaf_index(registry: dict[str, dict[str, Any]]) -> dict[str, list[str]]:
        leaf_index: dict[str, list[str]] = {}
        for full_name in registry:
            leaf_index.setdefault(full_name.rsplit("/", 1)[-1], []).append(full_name)
        return leaf_index

    @staticmethod
    def _build_tree(registry: dict[str, dict[str, Any]]) -> dict[str, list[dict[str, str]]]:
        tree: dict[str, list[dict[str, str]]] = {}
        for full_name, entry in registry.items():
            folder = full_name.rpartition("/")[0]
            tree.setdefault(folder, []).append({"path": full_name, "type": entry["type"]})
        for items in tree.values():
            items.sort(key=lambda item: item["path"].casefold())
        return tree

    @staticmethod
    def _register_folder_path(path: str) -> None:
        if not HAS_FOLDER_PATHS:
            return
        try:
            normalised = _normalise_abs_path(path)
            existing = {
                _normalise_abs_path(candidate)
                for candidate in folder_paths.get_folder_paths(FOLDER_PATHS_KEY)
            }
            if normalised not in existing:
                folder_paths.add_model_folder_path(FOLDER_PATHS_KEY, path)
                _PROMPT_PALETTE_REGISTERED_PATHS.add(normalised)
        except Exception:
            logger.debug("ComfyUI did not accept the wildcard folder registration", exc_info=True)

    def get_root_dir(self) -> str:
        with self._registry_lock:
            return self.root_dir

    def fingerprint(self) -> str:
        """Stable cache key that changes when indexed wildcard content or root changes."""
        # Known files get a cheap stat pass so edits invalidate execution promptly.
        # Discovery of newly added files stays on the slower directory-walk cadence.
        if self._known_sources_changed():
            self.rescan(blocking=True)
        self._ensure_fresh()
        with self._registry_lock:
            return f"{self.root_dir}:{self._revision}"

    def _known_sources_changed(self) -> bool:
        now = time.monotonic()
        with self._registry_lock:
            if (now - self._last_known_source_check) < self._known_source_check_interval:
                return False
            root_dir = self.root_dir
            signature = self._source_signature
            self._last_known_source_check = now
        for rel_path, old_mtime_ns, old_size in signature:
            abs_path = os.path.join(root_dir, *rel_path.split("/"))
            try:
                stat = os.stat(abs_path)
            except OSError:
                return True
            if stat.st_mtime_ns != old_mtime_ns or stat.st_size != old_size:
                return True
        return False

    def next_sequential_index(self, key: str, length: int, step: int = 1) -> int:
        if length <= 0:
            return 0
        with self._seq_lock:
            index = self._seq_counters.get(key, 0) % length
            self._seq_counters[key] = index + step
        return index

    def next_combinatorial_index(self, key: str, total: int) -> int:
        if total <= 0:
            return 0
        with self._combo_lock:
            index = self._combo_counters.get(key, 0) % total
            self._combo_counters[key] = index + 1
        return index

    def _ensure_fresh(self, force_check: bool = False) -> None:
        now = time.monotonic()
        with self._registry_lock:
            due = force_check or (now - self._last_source_check) >= self._source_check_interval
            root_dir = self.root_dir
        if not due:
            return
        signature = _source_signature(root_dir)
        with self._registry_lock:
            self._last_source_check = now
            changed = signature != self._source_signature
        if changed:
            self.rescan(blocking=force_check)

    async def ensure_fresh_async(self) -> None:
        await asyncio.to_thread(self._ensure_fresh, False)

    def rescan(self, blocking: bool = True) -> bool:
        if not self._scan_lock.acquire(blocking=blocking):
            return False
        try:
            with self._registry_lock:
                root_dir = self.root_dir

            registry: dict[str, dict[str, Any]] = {}
            tree_map: dict[str, list[dict[str, str]]] = {}
            signature: list[tuple[str, int, int]] = []
            for dirpath, dirnames, filenames in os.walk(root_dir):
                dirnames[:] = sorted(
                    (name for name in dirnames if name not in {".git", "__pycache__"}),
                    key=str.casefold,
                )
                rel_dir = os.path.relpath(dirpath, root_dir)
                rel_dir = "" if rel_dir == "." else rel_dir.replace(os.sep, "/")

                for filename in sorted(filenames, key=str.casefold):
                    lower = filename.lower()
                    abs_path = os.path.join(dirpath, filename)
                    if not lower.endswith(_SOURCE_EXTENSIONS):
                        continue
                    if not _is_within_root(root_dir, abs_path):
                        logger.warning("Skipping wildcard source outside the configured root: %s", abs_path)
                        continue
                    try:
                        stat = os.stat(abs_path)
                    except OSError:
                        continue
                    rel_source = os.path.relpath(abs_path, root_dir).replace(os.sep, "/")
                    signature.append((rel_source, stat.st_mtime_ns, stat.st_size))
                    if stat.st_size > MAX_SOURCE_FILE_BYTES:
                        logger.warning(
                            "Skipping wildcard source larger than %s MB: %s",
                            MAX_SOURCE_FILE_BYTES // (1024 * 1024),
                            abs_path,
                        )
                        continue
                    if lower.endswith(".txt"):
                        name = filename[:-4]
                        full_name = f"{rel_dir}/{name}" if rel_dir else name
                        try:
                            with open(abs_path, "r", encoding="utf-8", errors="replace") as handle:
                                lines = _clean_lines(handle.readlines())
                        except OSError:
                            continue
                        registry[full_name] = {"lines": lines, "type": "txt", "abs_path": abs_path}
                        tree_map.setdefault(rel_dir, []).append({"path": full_name, "type": "txt"})
                        continue

                    if (lower.endswith(".yaml") or lower.endswith(".yml")) and HAS_YAML:
                        data_type = "yaml"
                        loader = yaml.safe_load
                    elif lower.endswith(".json"):
                        data_type = "json"
                        loader = json.load
                    else:
                        continue

                    base = filename.rsplit(".", 1)[0]
                    prefix = f"{rel_dir}/{base}" if rel_dir else base
                    try:
                        with open(abs_path, "r", encoding="utf-8", errors="replace") as handle:
                            data = loader(handle) or {}
                        flattened = _flatten_yaml(data, prefix)
                    except Exception:
                        logger.warning("Skipping invalid wildcard source %s", abs_path, exc_info=True)
                        continue
                    for full_name, lines in flattened.items():
                        registry[full_name] = {
                            "lines": _clean_lines(lines),
                            "type": data_type,
                            "abs_path": abs_path,
                        }
                        folder = full_name.rpartition("/")[0]
                        tree_map.setdefault(folder, []).append({"path": full_name, "type": data_type})

            leaf_index = self._build_leaf_index(registry)
            with self._registry_lock:
                # Publish one complete snapshot so readers never observe a half-built index.
                changed = registry != self._registry or tree_map != self._tree
                self._registry = registry
                self._leaf_index = leaf_index
                self._tree = tree_map
                self._source_signature = tuple(signature)
                if changed:
                    self._revision += 1
                now = time.monotonic()
                self._last_scan = now
                self._last_source_check = now
                self._last_known_source_check = now
            return True
        finally:
            self._scan_lock.release()

    def get_lines(self, name: str) -> list[str] | None:
        self._ensure_fresh()
        with self._registry_lock:
            if "*" in name:
                return self._get_lines_glob_locked(name)
            entry = self._registry.get(name)
            if entry:
                return list(entry["lines"])
            candidates = self._leaf_index.get(name)
            if candidates and len(candidates) == 1:
                return list(self._registry[candidates[0]]["lines"])
        return None

    def _get_lines_glob_locked(self, pattern: str) -> list[str] | None:
        if pattern.endswith("/**"):
            prefix = pattern[:-3]
            names = [name for name in self._registry if name == prefix or name.startswith(prefix + "/")]
        else:
            names = [name for name in self._registry if fnmatch.fnmatchcase(name, pattern)]
        if not names:
            return None
        pooled: list[str] = []
        for name in sorted(names):
            pooled.extend(self._registry[name]["lines"])
        return list(pooled)

    def get_entry(self, name: str) -> dict[str, Any] | None:
        self._ensure_fresh()
        with self._registry_lock:
            return _copy_entry(self._registry.get(name))

    def leaf_candidates(self, name: str) -> list[str]:
        self._ensure_fresh()
        with self._registry_lock:
            return list(self._leaf_index.get(name, []))

    def all_names(self) -> list[str]:
        self._ensure_fresh()
        with self._registry_lock:
            return sorted(self._registry)

    def search(self, query: str, limit: int = 200) -> list[str]:
        self._ensure_fresh()
        query_lower = str(query).lower()
        with self._registry_lock:
            names = [name for name in self._registry if query_lower in name.lower()]
        return sorted(names)[: max(0, int(limit))]

    def flat_list(self) -> list[dict[str, Any]]:
        self._ensure_fresh()
        with self._registry_lock:
            return [
                {"path": name, "type": entry["type"], "count": len(entry["lines"])}
                for name, entry in sorted(self._registry.items())
            ]

    def preview(self, name: str, max_lines: int = 4) -> list[str] | None:
        lines = self.get_lines(name)
        return None if lines is None else lines[: max(0, int(max_lines))]

    def save_txt(self, name: str, content_text: str) -> str:
        safe_name = _normalise_wildcard_name(name)
        if not isinstance(content_text, str):
            raise ValueError("content must be text")
        with self._registry_lock:
            root = os.path.realpath(self.root_dir)
        candidate = os.path.join(root, *safe_name.split("/")) + ".txt"
        abs_path = os.path.realpath(candidate)
        try:
            inside_root = os.path.commonpath([root, abs_path]) == root
        except ValueError:
            inside_root = False
        if not inside_root:
            raise ValueError("invalid wildcard name")

        entry = {"lines": _clean_lines(content_text.splitlines()), "type": "txt", "abs_path": abs_path}
        with self._scan_lock:
            try:
                _atomic_write_text(abs_path, content_text)
            except OSError as exc:
                raise ValueError(f"couldn't save wildcard: {exc}") from exc
            with self._registry_lock:
                registry = dict(self._registry)
                changed = registry.get(safe_name) != entry
                registry[safe_name] = entry
                self._registry = registry
                self._leaf_index = self._build_leaf_index(registry)
                self._tree = self._build_tree(registry)
                if changed:
                    self._revision += 1
                now = time.monotonic()
                self._source_signature = _source_signature(root)
                self._last_scan = now
                self._last_source_check = now
                self._last_known_source_check = now
        return abs_path

    def assert_txt_target_available(self, target: str) -> str:
        target_name = _normalise_wildcard_name(target)
        with self._registry_lock:
            target_entry = _copy_entry(self._registry.get(target_name))
            root = os.path.realpath(self.root_dir)
        if target_entry:
            raise ValueError(f"{target_name} already exists")
        target_path = os.path.realpath(os.path.join(root, *target_name.split("/")) + ".txt")
        if not _is_within_root(root, target_path):
            raise ValueError("invalid target wildcard name")
        target_base = os.path.splitext(target_path)[0]
        if os.path.exists(target_path) or any(os.path.exists(target_base + extension) for extension in (".jpg", ".jpeg", ".png")):
            raise ValueError(f"{target_name} already exists on disk")
        return target_path

    def rename_txt(self, source: str, target: str) -> str:
        source_name = _normalise_wildcard_name(source)
        target_name = _normalise_wildcard_name(target)
        if source_name == target_name:
            return self.get_entry(source_name)["abs_path"] if self.get_entry(source_name) else ""
        with self._registry_lock:
            source_entry = _copy_entry(self._registry.get(source_name))
        if not source_entry:
            raise FileNotFoundError(source_name)
        if source_entry["type"] != "txt":
            raise ValueError("only .txt wildcards can be renamed individually")
        target_path = self.assert_txt_target_available(target_name)
        target_base = os.path.splitext(target_path)[0]
        os.makedirs(os.path.dirname(target_path), exist_ok=True)
        with self._scan_lock:
            text_moved = False
            moved_thumbnails: list[tuple[str, str]] = []
            try:
                os.replace(source_entry["abs_path"], target_path)
                text_moved = True
                source_base = os.path.splitext(source_entry["abs_path"])[0]
                for extension in (".jpg", ".jpeg", ".png"):
                    old_thumb = source_base + extension
                    if os.path.isfile(old_thumb):
                        new_thumb = target_base + extension
                        os.replace(old_thumb, new_thumb)
                        moved_thumbnails.append((old_thumb, new_thumb))
            except OSError as exc:
                for old_thumb, new_thumb in reversed(moved_thumbnails):
                    try:
                        if os.path.exists(new_thumb) and not os.path.exists(old_thumb):
                            os.replace(new_thumb, old_thumb)
                    except OSError:
                        logger.exception("Prompt Palette could not roll back thumbnail rename")
                if text_moved:
                    try:
                        if os.path.exists(target_path) and not os.path.exists(source_entry["abs_path"]):
                            os.replace(target_path, source_entry["abs_path"])
                    except OSError:
                        logger.exception("Prompt Palette could not roll back wildcard rename")
                raise ValueError(f"couldn't rename wildcard: {exc}") from exc
        self.rescan(blocking=True)
        return target_path

    def copy_txt(self, source: str, target: str) -> str:
        source_name = _normalise_wildcard_name(source)
        target_name = _normalise_wildcard_name(target)
        with self._registry_lock:
            source_entry = _copy_entry(self._registry.get(source_name))
        if not source_entry:
            raise FileNotFoundError(source_name)
        if source_entry["type"] != "txt":
            raise ValueError("only .txt wildcards can be copied individually")
        target_path = self.assert_txt_target_available(target_name)
        target_base = os.path.splitext(target_path)[0]
        os.makedirs(os.path.dirname(target_path), exist_ok=True)
        created_paths: list[str] = []
        with self._scan_lock:
            try:
                shutil.copy2(source_entry["abs_path"], target_path)
                created_paths.append(target_path)
                source_base = os.path.splitext(source_entry["abs_path"])[0]
                for extension in (".jpg", ".jpeg", ".png"):
                    old_thumb = source_base + extension
                    if os.path.isfile(old_thumb):
                        new_thumb = target_base + extension
                        shutil.copy2(old_thumb, new_thumb)
                        created_paths.append(new_thumb)
                        break
            except OSError as exc:
                for created in reversed(created_paths):
                    try:
                        os.remove(created)
                    except FileNotFoundError:
                        pass
                    except OSError:
                        logger.exception("Prompt Palette could not roll back wildcard copy")
                raise ValueError(f"couldn't copy wildcard: {exc}") from exc
        self.rescan(blocking=True)
        return target_path

    def delete(self, name: str) -> None:
        safe_name = _normalise_wildcard_name(name)
        with self._scan_lock:
            with self._registry_lock:
                entry = _copy_entry(self._registry.get(safe_name))
            if not entry:
                raise FileNotFoundError(safe_name)
            if entry["type"] != "txt":
                raise ValueError("only .txt wildcards can be deleted individually; edit the source file directly")
            try:
                os.remove(entry["abs_path"])
            except FileNotFoundError:
                pass
            except OSError as exc:
                raise ValueError(f"couldn't delete wildcard: {exc}") from exc
            with self._registry_lock:
                registry = dict(self._registry)
                removed = registry.pop(safe_name, None) is not None
                self._registry = registry
                self._leaf_index = self._build_leaf_index(registry)
                self._tree = self._build_tree(registry)
                if removed:
                    self._revision += 1
                now = time.monotonic()
                root = self.root_dir
                self._source_signature = _source_signature(root)
                self._last_scan = now
                self._last_source_check = now
                self._last_known_source_check = now

    def _switch_root(self, abs_path: str) -> None:
        changed = False
        with self._scan_lock:
            with self._registry_lock:
                if abs_path != self.root_dir:
                    self.root_dir = abs_path
                    self._registry = {}
                    self._leaf_index = {}
                    self._tree = {}
                    self._last_scan = 0.0
                    self._last_source_check = 0.0
                    self._last_known_source_check = 0.0
                    self._source_signature = ()
                    self._revision += 1
                    changed = True
        if not changed:
            return
        self._register_folder_path(abs_path)
        self.rescan(blocking=True)

    def set_root(self, path: str) -> None:
        if not isinstance(path, str) or not path.strip() or "\x00" in path:
            raise ValueError("path is required")
        raw = os.path.expanduser(os.path.expandvars(path.strip()))
        abs_path = os.path.abspath(raw)
        if os.path.exists(abs_path):
            if not os.path.isdir(abs_path):
                raise ValueError(f"{abs_path} exists but is not a directory")
        else:
            try:
                os.makedirs(abs_path, exist_ok=True)
            except OSError as exc:
                raise ValueError(f"couldn't create {abs_path}: {exc}") from exc

        try:
            _atomic_write_json(
                _LOCAL_CONFIG_PATH,
                {
                    "_comment": "Managed by Prompt Palette. Clear the in-app path setting to return to automatic discovery.",
                    "wildcards_path": abs_path,
                },
            )
        except OSError as exc:
            raise ValueError(f"couldn't save {_LOCAL_CONFIG_PATH}: {exc}") from exc

        self._switch_root(abs_path)

    def reset_root(self) -> str:
        fallback = resolve_wildcard_root(include_managed_override=False)
        try:
            os.makedirs(fallback, exist_ok=True)
        except OSError as exc:
            raise ValueError(f"couldn't use fallback wildcard folder {fallback}: {exc}") from exc

        try:
            if os.path.isfile(_LOCAL_CONFIG_PATH):
                os.remove(_LOCAL_CONFIG_PATH)
        except OSError as exc:
            raise ValueError(f"couldn't clear {_LOCAL_CONFIG_PATH}: {exc}") from exc

        self._switch_root(os.path.abspath(fallback))
        return self.get_root_dir()


_shared_index: WildcardIndex | None = None
_shared_index_lock = threading.Lock()


def get_index() -> WildcardIndex:
    global _shared_index
    if _shared_index is None:
        with _shared_index_lock:
            if _shared_index is None:
                index = WildcardIndex()
                index.rescan()
                _shared_index = index
    return _shared_index
