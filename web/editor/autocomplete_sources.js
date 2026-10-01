// Shared autocomplete row builders. Every editor (Prompt Palette, Combinatorial, Weight
// Controller) feeds the same menu from the same local data, so results never depend on a
// per-keystroke server round trip and look identical everywhere.
import { categoryOf, isRecipeCategory, hashStr, categoryColorFromHue } from "./text_utils.js";

function leafOf(path) {
  const parts = String(path || "").split("/");
  return parts[parts.length - 1] || "";
}

// Cheap, dependency-free ranking used when a caller has no search index of its own.
export function rankLibraryPaths(items, query, limit = 32) {
  const q = String(query || "").trim().toLowerCase();
  const paths = (items || []).map((item) => (typeof item === "string" ? item : item?.path)).filter(Boolean);
  if (!q) return paths.slice().sort((a, b) => a.localeCompare(b)).slice(0, limit);
  const words = q.split(/[\s_]+/).filter(Boolean);
  const scored = [];
  for (const path of paths) {
    const lower = path.toLowerCase();
    const leaf = leafOf(lower);
    let score;
    if (leaf === q) score = 0;
    else if (leaf.startsWith(q)) score = 1;
    else if (leaf.includes(q)) score = 2;
    else if (lower.includes(q)) score = 3;
    else if (words.length > 1 && words.every((word) => lower.includes(word))) score = 4;
    else continue;
    scored.push([score, path]);
  }
  scored.sort((a, b) => a[0] - b[0] || a[1].length - b[1].length || a[1].localeCompare(b[1]));
  return scored.slice(0, limit).map(([, path]) => path);
}

// Library rows (prompts, wildcards, recipes, favorites, recents) with the same category
// color the library sidebar and the editor use, so a card looks the same everywhere.
export function libraryAcRows(query, { rankedPaths = [], pinned = new Set(), recents = [], theme = {}, limit = 28 } = {}) {
  const q = String(query || "").trim().toLowerCase();
  const matches = (path) => !q || String(path).toLowerCase().includes(q);
  const colors = new Map();
  const colorFor = (cat) => {
    if (!colors.has(cat)) {
      const pin = theme?.categoryPins?.[cat];
      colors.set(cat, pin || categoryColorFromHue(((hashStr(cat) % 360) + (Number(theme?.hueRotate) || 0)) % 360, Number(theme?.saturation) || 58));
    }
    return colors.get(cat);
  };
  const seen = new Set();
  const rows = [];
  const push = (path, { favorite = false, recent = false, fuzzy = false } = {}) => {
    if (!path || seen.has(path) || (!fuzzy && !matches(path))) return;
    seen.add(path);
    const cat = categoryOf(path);
    const recipe = isRecipeCategory(cat);
    const leaf = leafOf(path).toLowerCase();
    const strong = !!q && (leaf === q || leaf.startsWith(q));
    rows.push({
      value: path, label: path, meta: path.split("/").slice(0, -1).join(" / "),
      kind: recipe ? "recipe" : favorite ? "favorite" : recent ? "recent" : "library",
      group: recipe ? "Recipes" : favorite ? "Favorites" : recent ? "Recents" : "My Library",
      favorite, recent, recipe, swatch: colorFor(cat), priority: strong || (favorite && q) ? 2 : 1,
    });
  };
  [...pinned].filter(matches).slice(0, 6).forEach((path) => push(path, { favorite: true }));
  (recents || []).filter(matches).slice(0, 8).forEach((path) => push(path, { recent: true }));
  (rankedPaths || []).forEach((path) => push(path, { fuzzy: true }));
  return rows.slice(0, limit);
}

// Booru/custom rows first-class, library guaranteed a slice of the list (the booru source can
// return dozens of rows and used to crowd the library out completely).
export function mergeUnifiedRows(tagRows, libraryRows, { tagLimit = 44, libraryLimit = 24 } = {}) {
  const tags = Array.isArray(tagRows) ? tagRows : [];
  const lib = Array.isArray(libraryRows) ? libraryRows : [];
  if (!lib.length) return tags.slice(0, 84);
  return [...tags.slice(0, tagLimit), ...lib.slice(0, libraryLimit)];
}
