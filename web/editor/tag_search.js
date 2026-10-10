// Search controls only. Recognized prefixes are removed with the query when a
// canonical tag is picked; wildcard/variable syntax retains its own parser.
const categories = { artist: "artist", art: "artist", character: "character", char: "character",
  copyright: "copyright", copy: "copyright", series: "copyright", general: "general", gen: "general", meta: "meta" };
export function tagSearch(query) {
  const raw = String(query || "").trim();
  const prefix = raw.match(/^([a-z]+):(.*)$/i);
  const category = prefix ? categories[prefix[1].toLowerCase()] || "" : "";
  return { query: category ? prefix[2].trim() : raw, category };
}
