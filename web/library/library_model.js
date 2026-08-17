import { normalizeSearchRow, scoreSearchRow } from "./search_score.js";

const SEARCH_CACHE_LIMIT = 64;

function uniqueNgrams(value, width) {
  const text = String(value || "");
  if (text.length < width) return [];
  const grams = new Set();
  for (let index = 0; index <= text.length - width; index += 1) grams.add(text.slice(index, index + width));
  return Array.from(grams);
}

function appendPosting(map, gram, ordinal) {
  let list = map.get(gram);
  if (!list) map.set(gram, (list = []));
  list.push(ordinal);
}

function intersectPostings(lists) {
  if (!lists.length) return null;
  const ordered = [...lists].sort((a, b) => a.length - b.length);
  if (!ordered[0]?.length) return [];
  let active = new Set(ordered[0]);
  for (let index = 1; index < ordered.length && active.size; index += 1) {
    const next = new Set(ordered[index]);
    for (const ordinal of active) if (!next.has(ordinal)) active.delete(ordinal);
  }
  return Array.from(active);
}

function unionPostings(lists) {
  if (!lists.length) return null;
  const active = new Set();
  for (const list of lists) for (const ordinal of list) active.add(ordinal);
  return Array.from(active);
}

export class PromptLibraryModel {
  constructor() {
    this.items = [];
    this.rows = [];
    this.byPath = new Map();
    this.byCategory = new Map();
    this.searchCache = new Map();
    this.tokenIndex = new Map();
    this.ngrams2 = new Map();
    this.ngrams3 = new Map();
  }

  rebuild(items, { buildSearchIndex = true } = {}) {
    this.items = Array.isArray(items) ? items : [];
    this.rows = this.items.map((item, ordinal) => normalizeSearchRow(item, ordinal));
    this.byPath = new Map();
    this.byCategory = new Map();
    this.searchCache.clear();
    this.tokenIndex.clear();
    this.ngrams2.clear();
    this.ngrams3.clear();

    for (const row of this.rows) {
      this.byPath.set(row.path, row.item);
      let categoryItems = this.byCategory.get(row.category);
      if (!categoryItems) this.byCategory.set(row.category, (categoryItems = []));
      categoryItems.push(row.item);
      if (buildSearchIndex) {
        let previousToken = "";
        const tokens = row.lower.split(/[^a-z0-9]+/);
        for (const token of tokens) {
          if (!token || token === previousToken) continue;
          previousToken = token;
          appendPosting(this.tokenIndex, token, row.ordinal);
        }
        if (buildSearchIndex === true || buildSearchIndex === "full") {
          for (const gram of uniqueNgrams(row.lower, 2)) appendPosting(this.ngrams2, gram, row.ordinal);
          for (const gram of uniqueNgrams(row.lower, 3)) appendPosting(this.ngrams3, gram, row.ordinal);
        }
      }
    }
  }

  get(path) { return this.byPath.get(String(path || "")) || null; }
  categories() { return Array.from(this.byCategory.keys()); }
  categoryItems(category) { return this.byCategory.get(category) || []; }

  _tokenCandidatesForTerm(value) {
    const parts = String(value || "").split(/[^a-z0-9]+/).filter(Boolean);
    if (!parts.length || !this.tokenIndex.size) return null;
    let active = null;
    for (const part of parts) {
      let postings = this.tokenIndex.get(part) || null;
      if (!postings) {
        const related = [];
        for (const [token, rows] of this.tokenIndex) {
          if (token.startsWith(part) || token.includes(part)) related.push(rows);
        }
        postings = unionPostings(related);
      }
      if (!postings?.length) return null;
      if (active == null) active = new Set(postings);
      else {
        const next = new Set(postings);
        for (const ordinal of active) if (!next.has(ordinal)) active.delete(ordinal);
      }
      if (!active.size) return [];
    }
    return active == null ? null : Array.from(active);
  }

  _candidateOrdinalsForTerm(term) {
    const value = String(term || "");
    if (!value) return null;

    // The UI-thread model always keeps the lightweight token index. The rich
    // n-gram index is reserved for the Worker/full-index path so large-library
    // fallback search remains responsive without a heavy main-thread build.
    if (!this.ngrams2.size && !this.ngrams3.size) return this._tokenCandidatesForTerm(value);

    const prefersTrigrams = value.length >= 3 && this.ngrams3.size > 0;
    const width = prefersTrigrams ? 3 : value.length >= 2 ? 2 : 0;
    if (!width) return this._tokenCandidatesForTerm(value);
    const gramMap = width === 3 ? this.ngrams3 : this.ngrams2;
    const grams = uniqueNgrams(value, width);
    if (!grams.length) return this._tokenCandidatesForTerm(value);

    const present = grams.map((gram) => gramMap.get(gram)).filter(Boolean);
    if (present.length === grams.length) {
      const exact = intersectPostings(present);
      if (exact?.length) return exact;
    }

    // Typo tolerance: when there is no contiguous substring match, score only
    // rows sharing at least one n-gram. The full scorer still decides whether
    // those candidates are actually valid fuzzy/typo matches. If no n-gram is
    // shared, the lightweight token index gets a chance before the canonical
    // scorer falls back to all rows.
    return present.length ? unionPostings(present) : this._tokenCandidatesForTerm(value);
  }

  _candidateRows(terms) {
    let candidates = null;
    for (const term of terms) {
      const ordinals = this._candidateOrdinalsForTerm(term);
      if (!ordinals) continue;
      if (candidates == null) {
        candidates = new Set(ordinals);
        continue;
      }
      const next = new Set(ordinals);
      for (const ordinal of candidates) if (!next.has(ordinal)) candidates.delete(ordinal);
      if (!candidates.size) break;
    }
    if (candidates == null) return this.rows;
    return Array.from(candidates, (ordinal) => this.rows[ordinal]).filter(Boolean);
  }

  _baseMatches(q) {
    const cached = this.searchCache.get(q);
    if (cached) {
      this.searchCache.delete(q);
      this.searchCache.set(q, cached);
      return cached;
    }
    const terms = q.split(/\s+/).filter(Boolean);
    let candidates = this._candidateRows(terms);

    // An n-gram intersection can become empty when different terms are each
    // typo-like. Preserve correctness by falling back to the canonical scorer.
    if (!candidates.length && this.rows.length) candidates = this.rows;

    const matches = [];
    for (const row of candidates) {
      const score = scoreSearchRow(row, terms);
      if (Number.isFinite(score)) matches.push({ row, score });
    }
    matches.sort((a, b) => a.score - b.score || a.row.ordinal - b.row.ordinal);
    this.searchCache.set(q, matches);
    while (this.searchCache.size > SEARCH_CACHE_LIMIT) this.searchCache.delete(this.searchCache.keys().next().value);
    return matches;
  }

  search(query, options = {}) {
    if (typeof options === "number") options = { limit: options };
    const { limit = 300, pinned = null, recent = null } = options;
    const q = String(query || "").trim().toLowerCase();
    if (!q) return this.items.slice(0, limit);
    const base = this._baseMatches(q);
    const hasBoosts = !!pinned?.size || !!recent?.length;
    const recentRank = recent?.length ? new Map(recent.map((path, index) => [path, index])) : null;
    const ranked = hasBoosts ? base.map(({ row, score }) => {
      let boosted = score;
      if (pinned?.has?.(row.path)) boosted -= 8;
      const recentIndex = recentRank?.get(row.path);
      if (recentIndex != null) boosted -= Math.max(1, 6 - recentIndex * 0.25);
      return { row, score: boosted };
    }).sort((a, b) => a.score - b.score || a.row.ordinal - b.row.ordinal) : base;
    return ranked.slice(0, Math.max(0, Number(limit) || 300)).map(({ row }) => row.item);
  }

  size() { return this.rows.length; }
  stats() {
    return {
      size: this.rows.length,
      cachedQueries: this.searchCache.size,
      tokenKeys: this.tokenIndex.size,
      bigramKeys: this.ngrams2.size,
      trigramKeys: this.ngrams3.size,
      searchIndexBuilt: this.tokenIndex.size > 0 || this.ngrams2.size > 0 || this.ngrams3.size > 0,
      searchIndexMode: this.ngrams3.size > 0 ? "full" : this.tokenIndex.size > 0 ? "token" : "none",
    };
  }
}
