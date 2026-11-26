import { readEditorPreference, writeEditorPreference } from "../prompt_palette_state.js";

export const MAX_FAVORITE_FOLDERS = 256;
export const LORA_PICKER_PREF_KEY = "lora-picker";

/**
 * Normalize a folder path into a trimmed POSIX relative path.
 * Rejects empty paths, ".", and the sentinel "all".
 */
export function normalizeFolderPath(value) {
  if (typeof value !== "string") return "";
  const clean = value
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .trim();
  if (!clean || clean === "all" || clean === ".") return "";
  return clean;
}

/**
 * Normalize, deduplicate, and bound a collection of favorite folder paths.
 */
export function normalizeFavoriteFolders(values, max = MAX_FAVORITE_FOLDERS) {
  if (!values || typeof values === "string" || typeof values[Symbol.iterator] !== "function") return [];
  const limit = Number.isFinite(max) && max >= 0 ? Math.floor(max) : MAX_FAVORITE_FOLDERS;
  const result = [];
  const seen = new Set();
  for (const raw of values) {
    if (result.length >= limit) break;
    const normalized = normalizeFolderPath(raw);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

/**
 * Extract the normalized parent folder path from a LoRA catalog name, or "" if root.
 */
export function loraFolderPath(loraName) {
  if (typeof loraName !== "string" || !loraName) return "";
  const clean = loraName
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/+/, "");
  const slash = clean.lastIndexOf("/");
  if (slash <= 0) return "";
  return clean.slice(0, slash).replace(/\/+$/g, "");
}

/**
 * Check whether a LoRA's folder matches a target folder or is nested inside it.
 */
export function folderMatchesTarget(loraFolder, targetFolder) {
  const target = normalizeFolderPath(targetFolder);
  if (!target || typeof loraFolder !== "string") return false;
  const folder = loraFolder
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .trim();
  if (!folder || folder === "all" || folder === ".") return false;
  return folder === target || folder.startsWith(`${target}/`);
}

/**
 * Check whether a LoRA belongs to any favorited folder (or subfolder thereof).
 */
export function matchesFavoriteFolders(loraName, favoriteFolders) {
  const folder = loraFolderPath(loraName);
  if (!folder || !favoriteFolders || typeof favoriteFolders[Symbol.iterator] !== "function") return false;
  for (const target of favoriteFolders) {
    if (folderMatchesTarget(folder, target)) return true;
  }
  return false;
}

/**
 * Partition saved favorite folders into existing vs missing on disk without deleting saved entries.
 */
export function reconcileFavoriteFolders(favoriteFolders, diskFolders) {
  const all = normalizeFavoriteFolders(favoriteFolders);
  const diskSet = new Set(normalizeFavoriteFolders(diskFolders, Number.MAX_SAFE_INTEGER));
  const existing = [];
  const missing = [];
  const existingSet = new Set();
  const missingSet = new Set();
  for (const folder of all) {
    if (diskSet.has(folder)) {
      existing.push(folder);
      existingSet.add(folder);
    } else {
      missing.push(folder);
      missingSet.add(folder);
    }
  }
  return { all, existing, missing, existingSet, missingSet };
}

/**
 * Toggle a folder inside a favorite folders collection, returning a normalized bounded array.
 */
export function toggleFavoriteFolder(favoriteFolders, folder, max = MAX_FAVORITE_FOLDERS) {
  const limit = Number.isFinite(max) && max >= 0 ? Math.floor(max) : MAX_FAVORITE_FOLDERS;
  const current = normalizeFavoriteFolders(favoriteFolders, limit);
  const target = normalizeFolderPath(folder);
  if (!target) return current;
  const index = current.indexOf(target);
  if (index >= 0) {
    return [...current.slice(0, index), ...current.slice(index + 1)];
  }
  if (current.length >= limit) return current;
  return [...current, target];
}

export function readFavoriteFoldersFromPreference(stored, max = MAX_FAVORITE_FOLDERS) {
  return normalizeFavoriteFolders(stored?.favoriteFolders, max);
}

export function withFavoriteFoldersPreference(prevStored, favoriteFolders, max = MAX_FAVORITE_FOLDERS) {
  const base = prevStored && typeof prevStored === "object" && !Array.isArray(prevStored) ? prevStored : {};
  return {
    ...base,
    favoriteFolders: normalizeFavoriteFolders(favoriteFolders, max),
  };
}

export function loadFavoriteFoldersPreference(max = MAX_FAVORITE_FOLDERS) {
  return readFavoriteFoldersFromPreference(readEditorPreference(LORA_PICKER_PREF_KEY, {}), max);
}

export function saveFavoriteFoldersPreference(favoriteFolders, max = MAX_FAVORITE_FOLDERS) {
  const prev = readEditorPreference(LORA_PICKER_PREF_KEY, {});
  const next = withFavoriteFoldersPreference(prev, favoriteFolders, max);
  writeEditorPreference(LORA_PICKER_PREF_KEY, next);
  return next.favoriteFolders;
}
