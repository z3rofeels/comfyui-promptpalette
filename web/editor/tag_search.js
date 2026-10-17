// Search controls only. Recognized prefixes are removed with the query when a
// canonical tag is picked; wildcard/variable syntax retains its own parser.
const categories = { artist: "artist", art: "artist", character: "character", char: "character",
  copyright: "copyright", copy: "copyright", series: "copyright", general: "general", gen: "general", meta: "meta" };
export function tagSearch(query) {
  const raw = String(query || "").trim();
  if (/^@(?!@)/.test(raw)) return { query: raw.slice(1).trim(), category: "artist", anima: true };
  const prefix = raw.match(/^([a-z]+):(.*)$/i);
  const category = prefix ? categories[prefix[1].toLowerCase()] || "" : "";
  return { query: category ? prefix[2].trim() : raw, category };
}

// Insertion only: category metadata, never a display label or a typed prefix,
// determines artist formatting. Custom words and library wildcards stay literal.
export function formatArtistInsertion(item, value, enabled = false) {
  const text = String(value ?? "");
  if (!enabled || item?.kind === "custom" || item?.insertMode === "library" || String(item?.category).toLowerCase() !== "artist") return text;
  const name = text.trim().replace(/^(?:artist|art):\s*/i, "").replace(/^@+/, "").replace(/_/g, " ");
  return name ? `@${name}` : text;
}
