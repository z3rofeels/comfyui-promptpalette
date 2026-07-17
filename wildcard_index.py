"""
Scans the ComfyUI wildcards/ folder (both flat .txt files and nested .yaml/.yml files),
builds a unified name -> lines registry, and a folder tree for the picker UI.

YAML files are flattened: nested keys become slash-separated wildcard names.
  characters:
    female:
      - "a woman"
      - "a girl"
  becomes wildcard name "characters/female" -> ["a woman", "a girl"]

Performance notes (this file supports libraries with many thousands of wildcards):
  - A full filesystem rescan is O(n) in file count and is only done when the cache is
    stale (see _scan_interval) or explicitly forced (manual refresh button).
  - Routes call `ensure_fresh_async()` which offloads a due rescan onto a worker thread
    via run_in_executor, so a big library never freezes the whole aiohttp event loop
    (and therefore the rest of the ComfyUI UI) while it scans.
  - Saving/deleting a single .txt wildcard updates the in-memory registry directly
    instead of re-walking the entire wildcards/ folder, so editing stays fast no
    matter how large the library is.
  - A leaf-name index (basename -> [full paths]) is maintained alongside the main
    registry so "does this bare name match something, and is it ambiguous" lookups
    (used for __basename__ style refs and for click-to-edit) are O(1)/O(k) instead of
    scanning every entry.

Where the wildcards/ folder actually lives (see resolve_wildcard_root() below):
  1. An extra_model_paths.yaml `wildcards:` entry, if the user added one - this is
     ComfyUI's own native multi-drive/multi-location config mechanism, so we don't
     parse the YAML ourselves; we just read back what ComfyUI already registered.
  2. A `wildcards_path` in wildcards_config.json next to this file, for anyone who'd
     rather not touch YAML.
  3. <ComfyUI base_path>/wildcards - folder_paths.base_path is ComfyUI's own resolved
     install root (correct regardless of which drive ComfyUI or this node happen to
     sit on), so this stays correct even for portable/multi-drive installs.
"""

import os
import re
import json
import time
import asyncio
import threading

try:
    import yaml
    HAS_YAML = True
except ImportError:
    HAS_YAML = False

try:
    import folder_paths
    HAS_FOLDER_PATHS = True
except Exception:
    HAS_FOLDER_PATHS = False

# The folder_paths "type name" this node's wildcards folder is registered under.
# Registering it (see WildcardIndex.__init__) means:
#   - a user can point at a custom location natively, by adding a `wildcards:`
#     entry under any profile in their extra_model_paths.yaml, the same way they
#     would for `checkpoints:` or `loras:` - no code changes needed on our end.
#   - other tools/nodes that introspect folder_paths.folder_names_and_paths can
#     discover where this node keeps its wildcards.
FOLDER_PATHS_KEY = "wildcards"

_NODE_DIR = os.path.dirname(os.path.abspath(__file__))

# Simple JSON override for anyone who'd rather not touch extra_model_paths.yaml.
# Not created automatically - see _write_example_config() for the example file
# that *is* dropped alongside it so the option is discoverable. wildcards_path
# accepts a raw path pasted straight from File Explorer (backslashes and all) -
# see _path_from_local_config()'s fallback for why that doesn't need escaping.
_LOCAL_CONFIG_PATH = os.path.join(_NODE_DIR, "wildcards_config.json")
_LOCAL_CONFIG_EXAMPLE_PATH = os.path.join(_NODE_DIR, "wildcards_config.example.json")


def _write_example_config():
    """Drops a wildcards_config.example.json next to this file (if not already
    present) purely so the custom-path option is discoverable without reading
    source code. Never overwrites/reads back from this file - only from
    wildcards_config.json itself."""
    if os.path.exists(_LOCAL_CONFIG_EXAMPLE_PATH):
        return
    try:
        with open(_LOCAL_CONFIG_EXAMPLE_PATH, "w", encoding="utf-8") as f:
            json.dump(
                {
                    "_comment": "Change your path here, then rename this file to "
                                "wildcards_config.json. You can paste your folder "
                                "path straight from File Explorer - no changes needed.",
                    "wildcards_path": "C:/ComfyUI/my_wildcards",
                },
                f,
                indent=2,
            )
    except OSError:
        pass  # best-effort only; e.g. a read-only install


def _path_from_extra_model_paths():
    """Picks up a `wildcards:` entry from extra_model_paths.yaml. ComfyUI parses
    that file itself at startup and calls
    folder_paths.add_model_folder_path("wildcards", <resolved path>) for every
    such entry, so we just read back whatever landed in the registry - no YAML
    parsing of our own, and it keeps working if ComfyUI changes that format."""
    if not HAS_FOLDER_PATHS:
        return None
    try:
        paths = folder_paths.get_folder_paths(FOLDER_PATHS_KEY)
    except Exception:
        return None
    return paths[0] if paths else None


# Matches "wildcards_path": "<value>" even when <value> isn't valid JSON - e.g. a
# raw Windows path pasted straight from File Explorer, whose single backslashes
# strict JSON would otherwise reject. Used only as a fallback below, so it never
# has to interpret backslashes as escapes at all - it just grabs the literal text
# between the quotes.
_RAW_PATH_RE = re.compile(r'"wildcards_path"\s*:\s*"(.+?)"\s*[,}]', re.DOTALL)


def _path_from_local_config():
    if not os.path.isfile(_LOCAL_CONFIG_PATH):
        return None
    try:
        with open(_LOCAL_CONFIG_PATH, "r", encoding="utf-8") as f:
            text = f.read()
    except OSError as e:
        print(f"[prompt-palette] warning: couldn't read {_LOCAL_CONFIG_PATH}: {e}")
        return None

    try:
        raw = json.loads(text).get("wildcards_path")
    except (ValueError, AttributeError):
        # Not valid JSON - almost always a raw Windows path pasted in without
        # doubling the backslashes JSON requires. Pull the value out directly
        # instead of making the user think about escaping at all.
        match = _RAW_PATH_RE.search(text)
        raw = match.group(1) if match else None
        if raw is None:
            print(f"[prompt-palette] warning: couldn't read {_LOCAL_CONFIG_PATH} - "
                  f"make sure your path is wrapped in quotes")
            return None

    if not raw:
        return None
    raw = os.path.expanduser(os.path.expandvars(raw))
    if not os.path.isabs(raw):
        raw = os.path.join(_NODE_DIR, raw)
    return raw


def _default_wildcards_dir():
    """Default when nothing above was configured: <ComfyUI base_path>/wildcards.
    folder_paths.base_path is ComfyUI's own canonical install root - it's correct
    even with --base-directory, portable builds, or an installation that spans
    drives, unlike deriving a root from this file's own on-disk location."""
    base = getattr(folder_paths, "base_path", None) if HAS_FOLDER_PATHS else None
    if base:
        return os.path.join(base, "wildcards")
    # Last-resort fallback if folder_paths itself is unusable (e.g. this file is
    # being imported outside a real ComfyUI process, such as in a unit test):
    # keep wildcards inside this custom node's own folder, which is always a
    # valid, writable location regardless of where ComfyUI itself lives.
    return os.path.join(_NODE_DIR, "wildcards")


def resolve_wildcard_root():
    """First match wins: extra_model_paths.yaml -> local config -> drive-agnostic
    default. Never assumes a drive letter or a fixed relative nesting depth
    between this node's folder and ComfyUI's install root."""
    _write_example_config()
    for candidate in (_path_from_extra_model_paths(), _path_from_local_config()):
        if candidate:
            return os.path.abspath(candidate)
    return os.path.abspath(_default_wildcards_dir())


def _clean_lines(raw_lines):
    out = []
    for line in raw_lines:
        line = line.rstrip("\n").rstrip("\r")
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        out.append(line)
    return out


def _flatten_yaml(node, prefix=""):
    """yields (name, lines) pairs from a nested yaml structure"""
    results = {}
    if isinstance(node, list):
        results[prefix] = [str(x) for x in node]
        return results
    if isinstance(node, dict):
        for key, val in node.items():
            sub_prefix = f"{prefix}/{key}" if prefix else str(key)
            results.update(_flatten_yaml(val, sub_prefix))
        return results
    if isinstance(node, str) and prefix:
        results[prefix] = [node]
    return results


class WildcardIndex:
    def __init__(self, root_dir=None):
        self.root_dir = os.path.abspath(root_dir) if root_dir else resolve_wildcard_root()
        os.makedirs(self.root_dir, exist_ok=True)
        # Register with ComfyUI's own folder registry so this location shows up
        # anywhere folder_paths.folder_names_and_paths is introspected, and so a
        # `wildcards:` entry in extra_model_paths.yaml (which only ever *adds*
        # paths, never overrides silently) still resolves back to this same
        # directory as its first/primary entry on the next run.
        if HAS_FOLDER_PATHS:
            try:
                folder_paths.add_model_folder_path(FOLDER_PATHS_KEY, self.root_dir)
            except Exception:
                pass
        print(f"[prompt-palette] wildcards folder: {self.root_dir}")
        self._registry = {}    # name -> {"lines": [...], "type": "txt"/"yaml", "abs_path": str}
        self._leaf_index = {}  # leaf (basename) -> [full names]  -- kept in sync with _registry
        self._tree = []        # nested folder structure for the picker
        self._last_scan = 0
        # 30s is cheap even for tens of thousands of files, and saves/deletes update the
        # in-memory registry directly rather than waiting on this interval.
        self._scan_interval = 30
        self._scan_lock = threading.Lock()
        # Persistent state for sequential (+/-) wildcard and brace selectors. Lives on
        # this singleton (not on WildcardResolver) so __+name__/{+a|b} etc. actually
        # advance from one node execution / resolve call to the next, instead of
        # resetting every time a fresh WildcardResolver is constructed.
        self._seq_counters = {}
        self._seq_lock = threading.Lock()

    def next_sequential_index(self, key, length, step=1):
        """Return the next index to use for a sequential selector identified by `key`
        (a wildcard name, or a synthetic key for a brace group), then advance the
        persistent counter by `step` (1 = increment, -1 = decrement), wrapping via
        modulo so it cycles indefinitely in either direction. Thread-safe."""
        if length <= 0:
            return 0
        with self._seq_lock:
            i = self._seq_counters.get(key, 0) % length
            self._seq_counters[key] = i + step
        return i

    # ---- internal registry helpers ----
    def _rebuild_leaf_index(self):
        leaf_index = {}
        for full_name in self._registry:
            leaf = full_name.split("/")[-1]
            leaf_index.setdefault(leaf, []).append(full_name)
        self._leaf_index = leaf_index

    def _index_one(self, full_name, entry):
        self._registry[full_name] = entry
        leaf = full_name.split("/")[-1]
        self._leaf_index.setdefault(leaf, [])
        if full_name not in self._leaf_index[leaf]:
            self._leaf_index[leaf].append(full_name)

    def _unindex_one(self, full_name):
        self._registry.pop(full_name, None)
        leaf = full_name.split("/")[-1]
        if leaf in self._leaf_index:
            self._leaf_index[leaf] = [n for n in self._leaf_index[leaf] if n != full_name]
            if not self._leaf_index[leaf]:
                del self._leaf_index[leaf]

    # ---- freshness ----
    def _ensure_fresh(self, force=False):
        """Synchronous freshness check. Safe to call from non-async contexts
        (e.g. the node's process() method, which runs on a worker thread, not
        the web server's event loop)."""
        now = time.time()
        if not (force or (now - self._last_scan) > self._scan_interval):
            return
        if force:
            self.rescan()
            return
        # best-effort: if another rescan is already running, just use current data
        if self._scan_lock.acquire(blocking=False):
            try:
                self.rescan()
            finally:
                self._scan_lock.release()

    async def ensure_fresh_async(self):
        """Used by aiohttp routes. Offloads a due rescan onto a worker thread so a
        large wildcards/ folder never blocks the event loop (and therefore the rest
        of the running ComfyUI server/UI) while it scans."""
        now = time.time()
        if (now - self._last_scan) <= self._scan_interval:
            return
        if not self._scan_lock.acquire(blocking=False):
            return  # a rescan is already in flight elsewhere; use current data
        try:
            loop = asyncio.get_event_loop()
            await loop.run_in_executor(None, self.rescan)
        finally:
            self._scan_lock.release()

    def rescan(self):
        registry = {}
        tree_map = {}  # folder path -> list of entries

        for dirpath, _dirnames, filenames in os.walk(self.root_dir):
            rel_dir = os.path.relpath(dirpath, self.root_dir)
            rel_dir = "" if rel_dir == "." else rel_dir.replace(os.sep, "/")

            for fname in sorted(filenames):
                lower = fname.lower()
                abs_path = os.path.join(dirpath, fname)

                if lower.endswith(".txt"):
                    name = fname[:-4]
                    full_name = f"{rel_dir}/{name}" if rel_dir else name
                    try:
                        with open(abs_path, "r", encoding="utf-8", errors="ignore") as f:
                            lines = _clean_lines(f.readlines())
                    except OSError:
                        continue
                    registry[full_name] = {"lines": lines, "type": "txt", "abs_path": abs_path}
                    tree_map.setdefault(rel_dir, []).append({"path": full_name, "type": "txt"})

                elif (lower.endswith(".yaml") or lower.endswith(".yml")) and HAS_YAML:
                    base = fname.rsplit(".", 1)[0]
                    yaml_prefix = f"{rel_dir}/{base}" if rel_dir else base
                    try:
                        with open(abs_path, "r", encoding="utf-8", errors="ignore") as f:
                            data = yaml.safe_load(f) or {}
                    except Exception:
                        continue
                    flattened = _flatten_yaml(data, yaml_prefix)
                    for full_name, lines in flattened.items():
                        registry[full_name] = {
                            "lines": _clean_lines(lines),
                            "type": "yaml",
                            "abs_path": abs_path,
                        }
                        folder = "/".join(full_name.split("/")[:-1])
                        tree_map.setdefault(folder, []).append({"path": full_name, "type": "yaml"})

        self._registry = registry
        self._tree = tree_map
        self._rebuild_leaf_index()
        self._last_scan = time.time()

    def get_lines(self, name):
        self._ensure_fresh()
        entry = self._registry.get(name)
        if entry:
            return entry["lines"]
        # allow lookup by leaf name if unambiguous (helps with __basename__ style refs)
        candidates = self._leaf_index.get(name)
        if candidates and len(candidates) == 1:
            return self._registry[candidates[0]]["lines"]
        return None

    def get_entry(self, name):
        self._ensure_fresh()
        return self._registry.get(name)

    def leaf_candidates(self, name):
        """full paths whose basename equals `name` (used to disambiguate clicks
        on a bare wildcard reference that matches more than one file)."""
        self._ensure_fresh()
        return list(self._leaf_index.get(name, []))

    def all_names(self):
        self._ensure_fresh()
        return sorted(self._registry.keys())

    def search(self, query, limit=200):
        self._ensure_fresh()
        q = query.lower()
        names = [n for n in self._registry.keys() if q in n.lower()]
        names.sort()
        return names[:limit]

    def flat_list(self):
        self._ensure_fresh()
        return [
            {"path": name, "type": entry["type"], "count": len(entry["lines"])}
            for name, entry in sorted(self._registry.items())
        ]

    def preview(self, name, max_lines=4):
        lines = self.get_lines(name)
        if lines is None:
            return None
        return lines[:max_lines]

    def save_txt(self, name, content_text):
        """create or overwrite a .txt wildcard. name is a slash-path without extension.
        Updates the in-memory registry directly (no full rescan) so this stays fast
        even with a very large wildcards/ folder.

        Path safety: rather than blocklisting ".." substrings (which misses
        Windows drive-letter segments like "C:/foo" and UNC segments like
        "\\\\host\\share\\foo", both of which make os.path.join discard
        root_dir entirely), we resolve the final absolute path and verify it
        is actually contained within root_dir before touching the filesystem.
        """
        safe_name = name.strip("/")
        if not safe_name:
            raise ValueError("invalid wildcard name")

        root = os.path.realpath(self.root_dir)
        candidate = os.path.join(root, *safe_name.split("/")) + ".txt"
        abs_path = os.path.realpath(candidate)

        if os.path.commonpath([root, abs_path]) != root:
            raise ValueError("invalid wildcard name")

        os.makedirs(os.path.dirname(abs_path), exist_ok=True)
        with open(abs_path, "w", encoding="utf-8") as f:
            f.write(content_text)
        lines = _clean_lines(content_text.split("\n"))
        self._index_one(safe_name, {"lines": lines, "type": "txt", "abs_path": abs_path})
        return abs_path

    def delete(self, name):
        entry = self.get_entry(name)
        if not entry:
            raise FileNotFoundError(name)
        if entry["type"] != "txt":
            raise ValueError("only .txt wildcards can be deleted individually; edit the source .yaml file directly")
        os.remove(entry["abs_path"])
        self._unindex_one(name)

    def set_root(self, path):
        """Point this index at a different wildcards folder - e.g. from the
        in-app "Wildcards folder path" setting - and persist the choice to
        wildcards_config.json, the same JSON-config tier _path_from_local_config()
        reads on startup, so it sticks across restarts and is still just a
        plain text file old-school users can open and edit by hand (a
        ComfyUI restart picks up manual edits there, same as it always has).
        Only that tier is touched: an extra_model_paths.yaml `wildcards:`
        entry, if the user has one, still wins on the next restart per
        resolve_wildcard_root()'s precedence order, exactly as it does today.

        Raises ValueError if path is empty, or exists but isn't a directory,
        or can't be created - callers (e.g. the /set_path route) can turn
        that straight into a 400.
        """
        if not path or not path.strip():
            raise ValueError("path is required")

        raw = os.path.expanduser(os.path.expandvars(path.strip()))
        abs_path = os.path.abspath(raw)

        if abs_path == self.root_dir:
            return  # already pointed here - nothing to validate, write, or rescan

        if os.path.exists(abs_path):
            if not os.path.isdir(abs_path):
                raise ValueError(f"{abs_path} exists but is not a directory")
        else:
            try:
                os.makedirs(abs_path, exist_ok=True)
            except OSError as e:
                raise ValueError(f"couldn't create {abs_path}: {e}")

        try:
            with open(_LOCAL_CONFIG_PATH, "w", encoding="utf-8") as f:
                json.dump(
                    {
                        "_comment": "Managed by Prompt Palette's in-app path picker "
                                    "(ComfyUI Settings > Prompt Palette > Wildcards "
                                    "Library > Folder path). You can also edit "
                                    "wildcards_path below by hand - restart ComfyUI "
                                    "to pick up manual edits, same as always.",
                        "wildcards_path": abs_path,
                    },
                    f,
                    indent=2,
                )
        except OSError as e:
            raise ValueError(f"couldn't save {_LOCAL_CONFIG_PATH}: {e}")

        self.root_dir = abs_path
        self.rescan()


_shared_index = None


def get_index():
    global _shared_index
    if _shared_index is None:
        _shared_index = WildcardIndex()
        _shared_index.rescan()
    return _shared_index
