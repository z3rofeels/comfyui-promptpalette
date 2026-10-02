import { readQuicknessPreference, writeQuicknessPreference, readEditorPreference } from "./prompt_palette_state.js";

function readJson(key, fallback) {
  const value = readQuicknessPreference(key, fallback);
  return value == null ? fallback : value;
}

function writeJson(key, value) {
  writeQuicknessPreference(key, value);
}

function normalizedText(value) {
  return String(value ?? "").replace(/\r\n?/g, "\n");
}

function compactLabel(value, limit = 72) {
  const oneLine = normalizedText(value).replace(/\s+/g, " ").trim();
  return oneLine.length > limit ? `${oneLine.slice(0, limit - 1)}…` : oneLine;
}

function makeId(prefix = "item") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createPromptUsageStore() {
  let libraryRecent = readJson("library-recent", []);
  let autocompleteRecent = readJson("autocomplete-recent", []);
  let starterRecent = readJson("starter-recent", []);
  let usage = readJson("usage", {});
  let starterFavorites = new Set(readJson("starter-favorites", []));
  let autocompleteFavorites = readJson("autocomplete-favorites", []);

  const TAG_CATEGORIES = ["general", "artist", "copyright", "character", "meta", "custom"];
  const normalizeTagFavorite = (item) => {
    if (!item || typeof item !== "object") return null;
    const kind = String(item.kind) === "custom" ? "custom" : String(item.kind) === "booru" ? "booru" : "";
    const value = String(item.value || "").trim();
    if (!kind || !value) return null;
    const category = TAG_CATEGORIES.includes(String(item.category)) ? String(item.category) : kind === "custom" ? "custom" : "general";
    return { kind, value, category };
  };

  const refresh = () => {
    const nextLibraryRecent = readJson("library-recent", []);
    const nextAutocompleteRecent = readJson("autocomplete-recent", []);
    const nextStarterRecent = readJson("starter-recent", []);
    const nextUsage = readJson("usage", {});
    const nextFavorites = readJson("starter-favorites", []);
    libraryRecent = Array.isArray(nextLibraryRecent) ? nextLibraryRecent.filter((item) => typeof item === "string" && item) : [];
    autocompleteRecent = Array.isArray(nextAutocompleteRecent)
      ? nextAutocompleteRecent.filter((item) => item && typeof item === "object" && ["library", "booru", "custom"].includes(String(item.kind)) && String(item.value || "").trim())
      : [];
    starterRecent = Array.isArray(nextStarterRecent) ? nextStarterRecent.filter((item) => item && typeof item === "object" && typeof item.id === "string") : [];
    usage = nextUsage && typeof nextUsage === "object" && !Array.isArray(nextUsage) ? nextUsage : {};
    starterFavorites = new Set(Array.isArray(nextFavorites) ? nextFavorites.map(String).filter(Boolean) : []);
    const nextTagFavorites = readJson("autocomplete-favorites", []);
    autocompleteFavorites = Array.isArray(nextTagFavorites) ? nextTagFavorites.map(normalizeTagFavorite).filter(Boolean) : [];
  };

  const persist = () => {
    writeJson("library-recent", libraryRecent.slice(0, 24));
    writeJson("autocomplete-recent", autocompleteRecent.slice(0, 32));
    writeJson("starter-recent", starterRecent.slice(0, 24));
    writeJson("usage", usage);
    writeJson("starter-favorites", [...starterFavorites]);
    writeJson("autocomplete-favorites", autocompleteFavorites.slice(0, 200));
  };

  return {
    recordLibrary(path) {
      refresh();
      const key = String(path || "").trim();
      if (!key) return;
      libraryRecent = [key, ...libraryRecent.filter((item) => item !== key)].slice(0, 24);
      autocompleteRecent = [
        { kind: "library", value: key, insertMode: "library", usedAt: Date.now() },
        ...autocompleteRecent.filter((item) => !(String(item?.kind) === "library" && String(item?.value) === key)),
      ].slice(0, 32);
      usage[`library:${key}`] = (Number(usage[`library:${key}`]) || 0) + 1;
      persist();
    },
    recordTag(value, kind = "booru", category = "") {
      refresh();
      const tag = String(value || "").trim();
      const source = kind === "custom" ? "custom" : "booru";
      if (!tag) return;
      const validCategory = ["general", "artist", "copyright", "character", "meta", "custom"].includes(String(category))
        ? String(category)
        : source === "custom" ? "custom" : "general";
      const key = `${source}:${tag}`;
      autocompleteRecent = [
        { kind: source, value: tag, category: validCategory, insertMode: "plain", usedAt: Date.now() },
        ...autocompleteRecent.filter((item) => `${String(item?.kind)}:${String(item?.value || "")}` !== key),
      ].slice(0, 32);
      usage[`tag:${key}`] = (Number(usage[`tag:${key}`]) || 0) + 1;
      persist();
    },
    recordStarter(entry) {
      refresh();
      const id = String(entry?.id || "").trim();
      if (!id) return;
      const stored = {
        id,
        modelId: String(entry.modelId || ""),
        modelName: String(entry.modelName || ""),
        categoryId: String(entry.categoryId || ""),
        categoryName: String(entry.categoryName || ""),
        title: String(entry.title || id),
        prompt: normalizedText(entry.prompt),
        visual: String(entry.visual || "concept"),
        accent: String(entry.accent || "#d49a52"),
        usedAt: Date.now(),
      };
      starterRecent = [stored, ...starterRecent.filter((item) => item.id !== id)].slice(0, 24);
      usage[`starter:${id}`] = (Number(usage[`starter:${id}`]) || 0) + 1;
      persist();
    },
    libraryRecent(limit = 12) { refresh(); return libraryRecent.slice(0, Math.max(0, limit)); },
    recentEntries(limit = 12) {
      refresh();
      const seen = new Set();
      const out = [];
      for (const item of autocompleteRecent) {
        const key = `${String(item?.kind)}:${String(item?.value || "")}`;
        if (!key.endsWith(":")) { seen.add(key); out.push({ ...item }); }
      }
      // Older installs only have the legacy library-recent list. Keep those entries visible
      // without rewriting the stored format until the user uses them again.
      for (const path of libraryRecent) {
        const key = `library:${path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ kind: "library", value: path, insertMode: "library", usedAt: 0 });
      }
      out.sort((a, b) => Number(b?.usedAt || 0) - Number(a?.usedAt || 0));
      return out.slice(0, Math.max(0, limit));
    },
    starterRecent(limit = 12) { refresh(); return starterRecent.slice(0, Math.max(0, limit)); },
    libraryUsage(path) { refresh(); return Number(usage[`library:${path}`]) || 0; },
    starterUsage(id) { refresh(); return Number(usage[`starter:${id}`]) || 0; },
    mostUsedLibrary(paths, limit = 10) {
      refresh();
      return [...paths]
        .map((path) => ({ path, count: Number(usage[`library:${path}`]) || 0 }))
        .filter((entry) => entry.count > 0)
        .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path))
        .slice(0, limit)
        .map((entry) => entry.path);
    },
    isStarterFavorite(id) { refresh(); return starterFavorites.has(String(id)); },
    toggleStarterFavorite(id) {
      refresh();
      const key = String(id || "");
      if (!key) return false;
      if (starterFavorites.has(key)) starterFavorites.delete(key);
      else starterFavorites.add(key);
      persist();
      return starterFavorites.has(key);
    },
    starterFavoriteIds() { refresh(); return [...starterFavorites]; },
    clearRecent() {
      refresh();
      libraryRecent = [];
      autocompleteRecent = [];
      starterRecent = [];
      persist();
    },
    // Autocomplete-only controls. Starter-pack history is left alone; library entries are cleared
    // from the shared library-recent list too, because recentEntries() merges that list back in.
    clearAutocompleteRecent() {
      refresh();
      libraryRecent = [];
      autocompleteRecent = [];
      persist();
    },
    removeRecent(kind, value) {
      refresh();
      const source = String(kind) === "custom" ? "custom" : String(kind) === "booru" ? "booru" : "library";
      const key = String(value || "").trim();
      if (!key) return;
      autocompleteRecent = autocompleteRecent.filter((item) => !(String(item?.kind) === source && String(item?.value || "") === key));
      if (source === "library") libraryRecent = libraryRecent.filter((item) => item !== key);
      persist();
    },
    // Starred booru tags / custom words. Library favorites are the existing pinned set.
    tagFavorites() { refresh(); return autocompleteFavorites.map((item) => ({ ...item })); },
    isTagFavorite(kind, value) {
      refresh();
      const source = String(kind) === "custom" ? "custom" : "booru";
      const key = String(value || "").trim();
      return autocompleteFavorites.some((item) => item.kind === source && item.value === key);
    },
    toggleTagFavorite(kind, value, category = "") {
      refresh();
      const source = String(kind) === "custom" ? "custom" : "booru";
      const key = String(value || "").trim();
      if (!key) return false;
      const exists = autocompleteFavorites.some((item) => item.kind === source && item.value === key);
      if (exists) {
        autocompleteFavorites = autocompleteFavorites.filter((item) => !(item.kind === source && item.value === key));
      } else {
        const entry = normalizeTagFavorite({ kind: source, value: key, category });
        if (entry) autocompleteFavorites = [entry, ...autocompleteFavorites];
      }
      persist();
      return !exists;
    },
  };
}

export function createPromptHistoryStore({ limit = 40 } = {}) {
  const asEntries = (value) => Array.isArray(value)
    ? value.filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry))
    : [];
  let entries = asEntries(readJson("history", []));
  const migrated = readJson("history-migrated-stash", false);
  if (!migrated) {
    try {
      const stash = readEditorPreference("stash", []);
      for (const item of Array.isArray(stash) ? stash.reverse() : []) {
        if (!String(item?.text || "").trim()) continue;
        entries.unshift({
          id: makeId("legacy"),
          source: normalizedText(item.text),
          resolved: "",
          seed: null,
          reason: "Saved checkpoint",
          savedAt: Number(item.savedAt) || Date.now(),
          pinned: true,
        });
      }
    } catch {}
    writeJson("history-migrated-stash", true);
  }

  const refresh = () => {
    entries = asEntries(readJson("history", []));
  };

  const persist = () => {
    const pinned = entries
      .filter((entry) => entry.pinned)
      .sort((a, b) => Number(b.savedAt) - Number(a.savedAt));
    const normal = entries
      .filter((entry) => !entry.pinned)
      .sort((a, b) => Number(b.savedAt) - Number(a.savedAt))
      .slice(0, limit);
    // Pinned checkpoints are never trimmed, even when there are more than the automatic-history limit.
    entries = [...pinned, ...normal].sort((a, b) => Number(b.savedAt) - Number(a.savedAt));
    writeJson("history", entries);
  };
  persist();

  return {
    list() {
      refresh();
      return entries.map((entry) => ({ ...entry }));
    },
    add({ source, resolved = "", seed = null, reason = "Prompt edit", pinned = false } = {}) {
      refresh();
      const sourceText = normalizedText(source);
      const resolvedText = normalizedText(resolved);
      if (!sourceText.trim() && !resolvedText.trim()) return null;
      const newest = entries[0];
      if (newest && newest.source === sourceText && newest.resolved === resolvedText && newest.reason === reason) {
        newest.savedAt = Date.now();
        newest.seed = seed ?? newest.seed;
        newest.pinned = newest.pinned || pinned;
        persist();
        return { ...newest };
      }
      const entry = {
        id: makeId("history"),
        source: sourceText,
        resolved: resolvedText,
        seed: Number.isFinite(Number(seed)) ? Number(seed) : null,
        reason: String(reason || "Prompt edit"),
        savedAt: Date.now(),
        pinned: !!pinned,
      };
      entries.unshift(entry);
      persist();
      return { ...entry };
    },
    remove(id) {
      refresh();
      entries = entries.filter((entry) => entry.id !== id);
      persist();
    },
    togglePin(id) {
      refresh();
      const entry = entries.find((item) => item.id === id);
      if (!entry) return false;
      entry.pinned = !entry.pinned;
      persist();
      return entry.pinned;
    },
    clearUnpinned() {
      refresh();
      entries = entries.filter((entry) => entry.pinned);
      persist();
    },
  };
}

export function levenshteinDistance(a, b) {
  const left = String(a || "").toLowerCase();
  const right = String(b || "").toLowerCase();
  if (!left.length) return right.length;
  if (!right.length) return left.length;
  const prev = Array.from({ length: right.length + 1 }, (_, index) => index);
  const next = new Array(right.length + 1);
  for (let i = 1; i <= left.length; i += 1) {
    next[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      next[j] = Math.min(next[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= right.length; j += 1) prev[j] = next[j];
  }
  return prev[right.length];
}

export function closestPromptEntries(query, candidates, limit = 3) {
  const needle = String(query || "").toLowerCase();
  if (!needle) return [];
  return [...candidates]
    .map((value) => {
      const text = String(value || "");
      const leaf = text.split("/").pop() || text;
      const distance = Math.min(levenshteinDistance(needle, text.toLowerCase()), levenshteinDistance(needle, leaf.toLowerCase()));
      const contains = text.toLowerCase().includes(needle) ? -3 : 0;
      return { value: text, score: distance + contains };
    })
    .sort((a, b) => a.score - b.score || a.value.localeCompare(b.value))
    .slice(0, Math.max(0, limit))
    .map((entry) => entry.value);
}

const MODEL_ALIASES = [
  ["krea-2", ["krea2", "krea 2", "krea-2", "krea_2"]],
  ["minimax-h3", ["minimax h3", "minimax_h3", "minimax-h3", "h3 fl2va", "h3 t2va", "h3 i2va"]],
  ["ltx-2-3", ["ltx 2.3", "ltx-2.3", "ltx_2.3", "ltx2.3", "ltxvideo"]],
  ["qwen-image", ["qwen image", "qwen-image", "qwen_image", "qwen edit", "qwen-image-edit"]],
  ["z-image-turbo", ["z-image-turbo", "z image turbo", "z_image_turbo", "zimage turbo", "z-image", "z image", "z_image"]],
  ["anima", ["anima"]],
  ["illustrious", ["illustrious"]],
  ["pony", ["pony"]],
  ["sdxl", ["sdxl", "stable diffusion xl"]],
];

function collectNodeWords(startNode, maxDepth = 4) {
  const queue = [{ node: startNode, depth: 0 }];
  const seen = new Set();
  const words = [];
  while (queue.length) {
    const current = queue.shift();
    const item = current?.node;
    if (!item || seen.has(item) || current.depth > maxDepth) continue;
    seen.add(item);
    words.push(item.comfyClass, item.type, item.title);
    for (const widget of item.widgets || []) {
      if (/model|ckpt|checkpoint|unet|diffusion|name/i.test(String(widget?.name || ""))) words.push(widget?.value);
    }
    if (current.depth >= maxDepth || typeof item.getInputNode !== "function") continue;
    for (let index = 0; index < (item.inputs || []).length; index += 1) {
      try {
        const upstream = item.getInputNode(index);
        if (upstream) queue.push({ node: upstream, depth: current.depth + 1 });
      } catch {}
    }
  }
  return words.filter((value) => value != null).join(" ").toLowerCase();
}

export function detectPromptModelProfile(node, availableModelIds = []) {
  const haystack = collectNodeWords(node);
  const allowed = new Set(availableModelIds || []);
  for (const [id, aliases] of MODEL_ALIASES) {
    if (allowed.size && !allowed.has(id)) continue;
    if (aliases.some((alias) => haystack.includes(alias))) {
      return { id, confidence: "connected", detail: compactLabel(haystack.match(new RegExp(`[^ ]*${aliases[0].split(" ")[0]}[^ ]*`, "i"))?.[0] || "connected model") };
    }
  }
  return { id: null, confidence: "unknown", detail: "No supported model name was detected upstream" };
}

export const PROMPT_PALETTE_HELP = [
  {
    id: "quick-insert",
    title: "Insert a library entry while typing",
    keywords: "autocomplete quick insert wildcard double underscore keyboard",
    body: "Type two underscores, then part of an entry name. Use ↑ and ↓ to choose, Enter or Tab to insert, and Escape to close. Favorites and recent entries appear first.",
  },
  {
    id: "final-prompt",
    title: "See the exact final prompt",
    keywords: "resolved expanded final output actual prompt last run preview",
    body: "Use Preview result in the existing top toolbar. The source editor stays intact, while the preview shows the resolved prompt for the current seed; saved execution metadata retains the exact last-run prompt.",
  },
  {
    id: "save-selection",
    title: "Save selected text to My Library",
    keywords: "create wildcard save selection right click shortcut",
    body: "Select text in the prompt, right-click it, and choose Save selection to My Library. Use a path such as poses/standing/confident to create organized folders.",
  },
  {
    id: "recipes",
    title: "Build a RECIPES entry",
    keywords: "recipe combinatorial category combine selections",
    body: "Open Library → My Library, use the palette selection control, pick entries, then Add to RECIPES. Existing recipe folders remain compatible.",
  },
  {
    id: "history",
    title: "Recover an earlier prompt",
    keywords: "lost prompt restore undo workflow tabs history stash checkpoint",
    body: "Open Prompt Stash → History for automatic local recovery checkpoints. Pin anything important so Clear unpinned never removes it; Saved drafts remain the deliberate long-term shelf. Automatic history can be disabled under Settings → Toolbar.",
  },
  {
    id: "missing-wildcard",
    title: "Fix a missing wildcard",
    keywords: "red underline typo not found missing file suggestion",
    body: "Hover the underlined entry or click the missing count. Prompt Palette shows the closest matching library paths so a typo can be replaced without reopening the full library.",
  },
  {
    id: "model-profile",
    title: "Use model-aware Starter Packs",
    keywords: "auto detect model krea minimax ltx qwen anima pony sdxl",
    body: "Starter Packs default to Auto. Prompt Palette checks connected upstream model widgets when available and suggests a profile. The profile only changes recommendations; it never rewrites your prompt silently.",
  },
  {
    id: "starter-filters",
    title: "Keep favorite Starter Packs close",
    keywords: "starter pack favorite recent filter star card model",
    body: "Star any Starter Pack card, then use All, Favorites, or Recent above the categories. Filters stay model-specific so a large catalog remains quick to browse.",
  },
  {
    id: "themes",
    title: "Choose or build an interface theme",
    keywords: "theme colors gallery day night duplicate contrast custom export import",
    body: "Settings → Look & text includes a visual theme gallery, day/night pairing, and live contrast feedback. Duplicate a built-in theme to unlock every color, then export the full pack from Backup.",
  },
  {
    id: "metadata",
    title: "Prompt metadata in saved assets",
    keywords: "image metadata asset manager final raw wildcard source seed",
    body: "The resolved final prompt is stored as the primary prompt, while the original wildcard source, seed, wildcards, LoRAs, and structured Prompt Palette metadata remain alongside it for reproduction.",
  },
  {
    id: "io",
    title: "Show or hide sockets",
    keywords: "io inputs outputs labels compact rail socket",
    body: "Open I/O to show socket names and choose what is visible. Close it to return to the compact top rail. Connected sockets stay visible so links are never lost.",
  },
];

export function searchPromptPaletteHelp(query) {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) return PROMPT_PALETTE_HELP;
  const terms = needle.split(/\s+/).filter(Boolean);
  return PROMPT_PALETTE_HELP.filter((item) => {
    const haystack = `${item.title} ${item.keywords} ${item.body}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}
