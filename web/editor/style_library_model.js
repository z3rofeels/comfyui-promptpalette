import { formatArtistInsertion } from "./tag_search.js";

export const normalizeStyleText = text => String(text || "").toLowerCase().replace(/[_\\]/g, " ").replace(/\s+/g, " ").trim();
export const FACET_GROUPS = [
  ["discipline", "Discipline", "A creative field or workflow"], ["medium", "Medium", "What the image is made with"],
  ["treatment", "Treatment", "How edges, marks and shading look"], ["design", "Design", "Composition and visual structure"],
  ["color", "Color", "Palette relationships"], ["mood", "Mood / light", "Atmosphere and illumination"],
  ["subject", "Subject", "A useful starting subject; not a restriction"],
];
export const PREVIEW_LABELS = { model_sample: "Model sample · user attested", reference: "Reference artwork", illustration: "Illustrative preview", user: "User preview", none: "No preview" };
export const BENCHMARKS = {
  landscape: "a quiet valley with a winding river, distant hills and a single tree",
  architecture: "a small courtyard building with an arched doorway and three windows",
  object: "a ceramic teapot beside a pear on a plain table",
  botanical: "a leafy branch with two blossoms on a plain background",
  character: "a fictional adult traveler in a plain coat, standing in a neutral pose",
};

export function styleOutput(row, format = "raw", prefix = "") {
  let text = row.tag || "";
  if (row.insertion?.tags || row.insertion?.natural) {
    text = format === "natural" ? row.insertion.natural || row.insertion.tags || text : row.insertion.tags || text;
  } else if (row.category === "artist" && row.insertKind !== "custom") {
    if (format === "anima") text = formatArtistInsertion({ category: "artist" }, text, true);
    else if (format === "natural") text = `by artist ${text.replace(/^@+/, "").replace(/_/g, " ").replace(/\\([()])/g, "$1")}`;
  } else if (format === "natural" && row.insertKind !== "custom") text = text.replace(/_/g, " ").replace(/\\([()])/g, "$1");
  // Quality tokens are literal, explicit user choices. No global rewrite.
  return [prefix.trim().replace(/[,\s]+$/, ""), text].filter(Boolean).join(", ");
}

export function decorateStyle(row, override = {}) {
  const item = { ...row, ...override };
  // An override with an empty thumbnail means intentional removal. Reset deletes
  // the key, allowing the read-only default to show on the next update.
  item.asset = Object.hasOwn(override, "thumbnail") ? "" : row.asset || "";
  item.previewKind = item.thumbnail ? (override.previewKind || (Object.hasOwn(override, "thumbnail") ? "user" : row.previewKind) || "user") : item.asset ? row.previewKind || "reference" : "none";
  item.compatibility = row.compatibility || "Checkpoint support unknown";
  item.facetTags = [...new Set([...(item.tags || []), ...Object.values(item.facets || {}).flat()].map(normalizeStyleText))];
  item.search = normalizeStyleText([item.tag, item.name, item.description, ...(item.aliases || []), ...item.facetTags].join(" "));
  return item;
}

export function filterStyles(rows, { query = "", tags = [], facets = {}, minCount = 0, favorites = false, previews = false, sort = "source" } = {}) {
  const terms = normalizeStyleText(query).split(" ").filter(Boolean), labels = tags.map(normalizeStyleText);
  const selected = Object.entries(facets).filter(([, value]) => value).map(([key, value]) => [key, normalizeStyleText(value)]);
  const result = rows.filter(row => (!favorites || row.favorite) && (!previews || row.thumbnail || row.asset)
    && (!minCount || (row.count != null && row.count >= minCount))
    && terms.every(term => row.search.includes(term)) && labels.every(tag => (row.facetTags || []).includes(tag))
    && selected.every(([key, value]) => key === "compatibility"
      ? (row.kind === "curated_style" ? "vocabulary" : "unknown") === value
      : (row.facets?.[key] || []).some(v => normalizeStyleText(v) === value)));
  if (sort === "name") result.sort((a, b) => a.name.localeCompare(b.name));
  if (sort === "count") result.sort((a, b) => (b.count ?? -1) - (a.count ?? -1));
  return result;
}

export function comparisonPrompt(row, benchmark = "object", format = "raw", prefix = "") {
  return [BENCHMARKS[benchmark] || BENCHMARKS.object, styleOutput(row, format, prefix)].filter(Boolean).join(", ");
}

// Only bundled basename assets and backend-validated raster data ever reach <img>.
export function stylePreviewUrl(row) {
  if (/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(row.thumbnail || "")) return row.thumbnail;
  if (/^[a-z0-9-]+\.(svg|webp|jpg|png)$/.test(row.asset || "")) return new URL(`../assets/styles/${row.asset}`, import.meta.url).href;
  return "";
}

// Punctuation at the captured editor range is authoritative. Do not rewrite
// authored text or use wildcards for literal style vocabulary.
export function styleInsertionAtSelection(text, selection) {
  const before = selection.source.slice(0, selection.start), after = selection.source.slice(selection.end);
  const leading = before && !/[,;\n]\s*$/.test(before) && !/[([{]\s*$/.test(before) ? ", " : before && !/\s$/.test(before) && !/[([{]$/.test(before) ? " " : "";
  const trailing = after && !/^\s*[,;\n)\]}]/.test(after) ? ", " : "";
  return leading + text + trailing;
}
