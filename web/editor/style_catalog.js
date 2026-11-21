import { detectPromptModelProfile } from "../prompt_quickness.js";

const CATALOG_URL = new URL("../data/krea2_moss_styles.json", import.meta.url).href;

let catalogData = null;
let catalogPromise = null;
let entryById = new Map();
let searchIndex = [];

function normalizeModelId(raw) {
  const s = String(raw || "").toLowerCase();
  if (s === "krea-2" || s === "krea2" || s.includes("krea")) return "krea2";
  if (s === "moss" || s.includes("moss")) return "moss";
  return "";
}

function buildSearchIndex(data) {
  entryById = new Map();
  searchIndex = [];
  const list = Array.isArray(data?.styles) ? data.styles : [];
  for (const raw of list) {
    if (!raw || !raw.id) continue;
    entryById.set(raw.id, raw);
    const haystack = [
      raw.name,
      raw.id,
      raw.facet,
      raw.subcategory,
      raw.model,
      raw.krea2Phrase,
      raw.mossCaption,
      raw.description,
      raw.whenToUse,
      ...(Array.isArray(raw.variants) ? raw.variants : []),
      ...(Array.isArray(raw.tags) ? raw.tags : []),
      ...(Array.isArray(raw.mossTags) ? raw.mossTags.map((t) => (typeof t === "string" ? t : t?.tag || "")) : []),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    const matchPhrases = [
      raw.krea2Phrase,
      raw.mossCaption,
      ...(Array.isArray(raw.mossTags) && raw.mossTags.length ? [raw.mossTags.map((t) => t?.tag || t).filter(Boolean).join(", ")] : []),
    ]
      .map((s) => String(s || "").trim())
      .filter((s) => s.length >= 6);
    searchIndex.push({
      id: raw.id,
      entry: raw,
      nameLower: String(raw.name || "").toLowerCase(),
      facetLower: String(raw.facet || "").toLowerCase(),
      modelLower: String(raw.model || "").toLowerCase(),
      tagsLower: (Array.isArray(raw.tags) ? raw.tags : []).map((t) => String(t).toLowerCase()),
      haystack,
      matchPhrasesLower: [...new Set(matchPhrases.map((p) => p.toLowerCase()))],
    });
  }
}

export async function loadStyleCatalog() {
  if (catalogData) return catalogData;
  if (!catalogPromise) {
    catalogPromise = fetch(CATALOG_URL, { cache: "no-cache" })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => {
        catalogData = data;
        buildSearchIndex(data);
        return data;
      })
      .catch((err) => {
        catalogPromise = null;
        throw err;
      });
  }
  return catalogPromise;
}

/** Used by offline Node tests or already-loaded callers to seed or read synchronously. */
export function setStyleCatalogData(data) {
  catalogData = data;
  buildSearchIndex(data);
  return catalogData;
}

export function getStyleCatalogSync() {
  return catalogData;
}

export function getStyleEntryById(id) {
  return entryById.get(id) || null;
}

export function getStyleSearchIndex() {
  return searchIndex;
}

export function entryMatchesModel(entry, modelFilter = "both") {
  if (!modelFilter || modelFilter === "both" || modelFilter === "all") return true;
  const target = normalizeModelId(modelFilter);
  if (!target) return true;
  return entry.model === "both" || entry.model === target;
}

export function resolveStyleModelTarget(node, preference = "auto") {
  const pref = String(preference || "auto").toLowerCase();
  if (pref === "krea2" || pref === "krea-2") {
    return { model: "krea2", confidence: "manual", detail: "Krea 2 (selected)" };
  }
  if (pref === "moss") {
    return { model: "moss", confidence: "manual", detail: "MOSS-Image (selected)" };
  }
  if (pref === "both") {
    return { model: "both", confidence: "manual", detail: "All curated Krea 2 & MOSS models" };
  }
  if (node) {
    const detected = detectPromptModelProfile(node, ["krea-2", "moss"]);
    const mapped = normalizeModelId(detected?.id);
    if (mapped) {
      return {
        model: mapped,
        confidence: "connected",
        detail: `${mapped === "krea2" ? "Krea 2" : "MOSS-Image"} (${detected.detail || "connected"})`,
      };
    }
  }
  return { model: "krea2", confidence: "default", detail: "Krea 2 & MOSS ready (no upstream Krea2/MOSS checkpoint detected)" };
}

export function scoreAndFilterStyles({
  query = "",
  facet = "all",
  model = "both",
  favoriteIds = null,
  recentIds = null,
  filterMode = "all",
  limit = 200,
} = {}) {
  const q = String(query || "").trim().toLowerCase();
  const terms = q ? q.split(/\s+/).filter(Boolean) : [];
  const normalizedFacet = String(facet || "all").toLowerCase();
  const favSet = favoriteIds instanceof Set ? favoriteIds : new Set(favoriteIds || []);
  const recList = Array.isArray(recentIds) ? recentIds : [];
  const recRank = new Map(recList.map((id, i) => [String(id), i]));

  const scored = [];
  for (const row of searchIndex) {
    const entry = row.entry;
    if (normalizedFacet !== "all" && row.facetLower !== normalizedFacet) continue;
    if (!entryMatchesModel(entry, model)) continue;
    if (filterMode === "favorites" && !favSet.has(entry.id)) continue;
    if (filterMode === "recent" && !recRank.has(entry.id)) continue;

    let score = 0;
    if (terms.length) {
      let allMatch = true;
      for (const term of terms) {
        if (!row.haystack.includes(term)) {
          allMatch = false;
          break;
        }
        if (row.nameLower === term) score += 120;
        else if (row.nameLower.startsWith(term)) score += 70;
        else if (row.nameLower.includes(term)) score += 45;
        else if (row.facetLower === term || row.tagsLower.some((t) => t === term)) score += 35;
        else if (row.tagsLower.some((t) => t.startsWith(term))) score += 22;
        else score += 10;
      }
      if (!allMatch) continue;
    }
    if (favSet.has(entry.id)) score += 12;
    if (recRank.has(entry.id)) score += Math.max(1, 10 - recRank.get(entry.id));
    scored.push({ entry, score, recOrder: recRank.get(entry.id) ?? 9999 });
  }

  scored.sort((a, b) => {
    if (filterMode === "recent") return a.recOrder - b.recOrder || a.entry.name.localeCompare(b.entry.name);
    if (b.score !== a.score) return b.score - a.score;
    return a.entry.name.localeCompare(b.entry.name);
  });

  return scored.slice(0, limit).map((item) => item.entry);
}
