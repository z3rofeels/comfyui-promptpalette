import { API } from "../prompt_palette_api.js";

let customWordsPromise = null;
let customWordsGeneration = 0;

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < String(text || "").length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field.length === 0) {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field);
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    if (row.some((value) => value.length > 0)) rows.push(row);
  }
  return rows;
}

// Plain decimals only (same rule as the server): no hex, exponents, or "Infinity".
function numeric(value) {
  const text = String(value ?? "").trim();
  return /^[+-]?\d+(?:\.\d+)?$/.test(text) ? Number(text) : null;
}

// Danbooru / a1111-tagcomplete category ids, plus the names Prompt Palette accepts.
const CATEGORY_BY_ID = { 0: "general", 1: "artist", 3: "copyright", 4: "character", 5: "meta" };
const CATEGORY_NAMES = new Set(Object.values(CATEGORY_BY_ID));
const CATEGORY_SYNONYMS = { series: "copyright", franchise: "copyright", char: "character", artists: "artist" };

function parseCategory(raw) {
  const key = String(raw ?? "").trim().toLocaleLowerCase();
  if (!key || key === "null") return "";
  if (/^\d+$/.test(key)) return CATEGORY_BY_ID[Number(key)] || "";
  const name = CATEGORY_SYNONYMS[key] || key;
  return CATEGORY_NAMES.has(name) ? name : "";
}

const HEADER_FIRST = new Set(["tag", "word", "value", "name"]);
const HEADER_SECOND = new Set(["category", "type", "alias", "aliases", "shortcut", "trigger", "count", "priority", "posts"]);

function isHeaderRow(fields) {
  return fields.length >= 2
    && HEADER_FIRST.has(String(fields[0]).trim().toLocaleLowerCase())
    && HEADER_SECOND.has(String(fields[1]).trim().toLocaleLowerCase());
}

function splitAliases(values, word) {
  const seen = new Set();
  const aliases = [];
  for (const value of values) {
    for (const part of String(value ?? "").split(/[,\n]/)) {
      const alias = part.trim();
      const key = alias.toLocaleLowerCase();
      if (!alias || key === word.toLocaleLowerCase() || key === "null" || seen.has(key)) continue;
      seen.add(key);
      aliases.push(alias);
    }
  }
  return aliases;
}

/**
 * What one CSV row means. Mirror of _describe_custom_row() in server_routes.py.
 *
 *   layout "tag":    tag[,category[,count[,aliases...]]]  a1111 tagcomplete form. The category is a
 *                    Danbooru id (0 general, 1 artist, 3 copyright, 4 character, 5 meta) or a name;
 *                    aliases may be one quoted comma list or several plain columns.
 *   layout "simple": word[,shortcut[,priority]]           the pythongosssss custom-words form.
 */
function parseCustomRow(fields) {
  const f = fields.map((part) => String(part ?? "").trim());
  const n = f.length;
  if (!n || !f[0]) return null;
  const word = f[0];
  const tag = (category, countText, aliasFields) => {
    const priority = numeric(countText) ?? 0;
    return { layout: "tag", word, category, priority, count: priority > 0 ? priority : 0, aliases: splitAliases(aliasFields, word) };
  };
  const simple = (shortcut, priorityText = "") => ({
    layout: "simple", word, category: "", priority: numeric(priorityText) ?? 0, count: 0, aliases: shortcut ? [shortcut] : [],
  });
  if (n === 1) return simple("");
  if (n === 2) {
    if (!f[1]) return simple("");
    if (numeric(f[1]) != null) return simple("", f[1]); // a bare priority
    const category = parseCategory(f[1]);
    return category ? tag(category, "", []) : simple(f[1]);
  }
  const category = parseCategory(f[1]);
  if (n === 3) {
    if ((category || !f[1]) && (!f[2] || numeric(f[2]) != null)) return tag(category, f[2], []);
    return simple(f[1], f[2]);
  }
  if (n === 4 || category || !f[1] || numeric(f[1]) != null) return tag(category, f[2], f.slice(3));
  return simple(f[1], f[2]);
}

function parseCustomWords(text) {
  const words = [];
  const add = (label, value, row) => {
    const entry = { text: label, value, priority: row.priority };
    if (row.category) entry.category = row.category;
    if (row.count > 0) entry.count = row.count;
    words.push(entry);
  };
  let first = true;
  for (const fields of parseCsv(text)) {
    if (!fields.length || !fields[0]?.trim()) continue;
    if (first && isHeaderRow(fields)) { first = false; continue; }
    first = false;
    const row = parseCustomRow(fields);
    if (!row) continue;
    // A tag row is searchable by the tag itself and by every alias, each inserting the tag.
    // A simple row with a shortcut is only reachable through that shortcut.
    if (row.layout === "tag" || !row.aliases.length) add(row.word, row.word, row);
    for (const alias of row.aliases) add(alias, row.word, row);
  }
  return words;
}

async function loadCustomWords() {
  if (!customWordsPromise) {
    const loading = API.customWords()
      .then((text) => parseCustomWords(text))
      .catch(() => {
        // A temporary server failure must not cache an empty list until reload.
        // Do not invalidate a newer request started after resetCustomWords().
        if (customWordsPromise === loading) {
          customWordsPromise = null;
          customWordsGeneration += 1;
        }
        return [];
      })
      .then((words) => {
        // Keep the first definition for identical label/value pairs, matching the
        // object-key overwrite semantics of the source implementation closely.
        const seen = new Set();
        return words.filter((word) => {
          const key = `${word.text.toLocaleLowerCase()}\u0000${word.value}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      });
    customWordsPromise = loading;
  }
  return customWordsPromise;
}

function filterCustomWords(words, term, limit = 20) {
  const q = String(term || "").toLocaleLowerCase();
  if (!q) return [];
  const tokens = q.split(/[_\s]+/).filter(Boolean);
  const grouped = new Map();

  // A custom word may be indexed under several aliases, but the autocomplete table
  // should contain one canonical row. Keep whichever matching definition gives the
  // strongest result; aliases remain searchable without becoming duplicate rows.
  for (const word of words) {
    const label = String(word?.text || "").trim();
    const value = String(word?.value || "").trim();
    if (!label || !value) continue;
    const lowerLabel = label.toLocaleLowerCase();
    const lowerValue = value.toLocaleLowerCase();
    const labelMatches = tokens.every((token) => lowerLabel.includes(token));
    const valueMatches = tokens.every((token) => lowerValue.includes(token));
    if (!labelMatches && !valueMatches) continue;

    const exact = lowerLabel === q || lowerValue === q;
    let pos = lowerLabel.indexOf(q);
    if (pos === -1) pos = lowerValue.indexOf(q);
    if (pos === -1) pos = Math.max(1, lowerLabel.indexOf(tokens[0]));
    const prefix = lowerLabel.startsWith(q) || lowerValue.startsWith(q) || tokens.some((token) => lowerLabel.startsWith(token));
    const definition = {
      value,
      category: word.category || "",
      priority: Number(word.priority) || 0,
      count: Number(word.count) || 0,
      matchedAlias: label !== value ? label : "",
      exact,
      prefix,
      pos,
      labelLength: label.length,
    };
    const key = lowerValue;
    const old = grouped.get(key);
    const rank = (candidate) => [
      candidate.exact ? 0 : 1,
      candidate.prefix ? 0 : candidate.pos ? 2 : 1,
      -(candidate.priority || 0),
      candidate.labelLength,
      candidate.matchedAlias ? 1 : 0,
      candidate.matchedAlias.toLocaleLowerCase(),
    ];
    const compare = (a, b) => {
      const ar = rank(a);
      const br = rank(b);
      for (let i = 0; i < ar.length; i += 1) {
        if (ar[i] < br[i]) return -1;
        if (ar[i] > br[i]) return 1;
      }
      return 0;
    };
    if (!old || compare(definition, old) < 0) grouped.set(key, definition);
  }

  const matches = Array.from(grouped.values());
  const priorityMatches = matches.filter((item) => item.priority > 0);
  const prefixMatches = matches.filter((item) => item.priority <= 0 && item.prefix);
  const includesMatches = matches.filter((item) => item.priority <= 0 && !item.prefix);
  priorityMatches.sort((a, b) => b.priority - a.priority || a.labelLength - b.labelLength || a.value.localeCompare(b.value));
  prefixMatches.sort((a, b) => a.pos - b.pos || a.labelLength - b.labelLength || a.value.localeCompare(b.value));
  includesMatches.sort((a, b) => a.pos - b.pos || a.labelLength - b.labelLength || a.value.localeCompare(b.value));

  const ordered = priorityMatches.slice(0, Math.floor(priorityMatches.length * 0.2))
    .concat(prefixMatches, priorityMatches.slice(Math.floor(priorityMatches.length * 0.2)), includesMatches)
    .slice(0, limit);

  return ordered.map((item) => ({
    value: item.value,
    label: item.value,
    group: "Custom Words",
    kind: "custom",
    priority: item.priority,
    ...(item.category ? { category: item.category } : {}),
    ...(item.count ? { count: item.count } : {}),
    alias: "",
    matchedAlias: item.matchedAlias,
    exactCustomMatch: item.exact,
    insertText: item.value,
    selectInserted: false,
  }));
}

// Drop the cached list so words saved from the autocomplete menu show up immediately.
function resetCustomWords() {
  customWordsPromise = null;
  customWordsGeneration += 1;
}

// Bumps whenever the cached list is dropped, so callers can cheaply tell it has changed.
function getCustomWordsGeneration() {
  return customWordsGeneration;
}

export { loadCustomWords, filterCustomWords, parseCustomWords, parseCustomRow, resetCustomWords, getCustomWordsGeneration, parseCategory, CATEGORY_BY_ID };
