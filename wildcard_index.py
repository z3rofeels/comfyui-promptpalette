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
"""

import os
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
    COMFY_ROOT = os.path.dirname(os.path.abspath(folder_paths.__file__))
except Exception:
    COMFY_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))

WILDCARD_DIR = os.path.join(COMFY_ROOT, "wildcards")


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
        self.root_dir = root_dir or WILDCARD_DIR
        os.makedirs(self.root_dir, exist_ok=True)
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


_shared_index = None


def get_index():
    global _shared_index
    if _shared_index is None:
        _shared_index = WildcardIndex()
        _shared_index.rescan()
    return _shared_index
