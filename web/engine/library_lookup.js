// Mirror WildcardIndex: exact names, unique bare leaves, then full-path globs.
export function createLibraryLookup(items) {
  const entries = new Map(items.map(item => typeof item === "string" ? [item, { path: item }] : [item.path, item]));
  const leaves = new Map(), cache = new Map();
  for (const path of entries.keys()) {
    const leaf = path.split("/").pop();
    leaves.set(leaf, leaves.has(leaf) ? null : path);
  }
  return name => {
    if (cache.has(name)) return cache.get(name);
    let paths;
    if (name.includes("*")) {
      const pattern = new RegExp("^" + name.split("*").map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
      const prefix = name.endsWith("/**") ? name.slice(0, -3) : null;
      paths = [...entries.keys()].filter(path => prefix !== null ? path === prefix || path.startsWith(prefix + "/") : pattern.test(path));
    } else {
      const path = entries.has(name) ? name : !name.includes("/") ? leaves.get(name) : null;
      paths = path ? [path] : [];
    }
    const matches = paths.map(path => entries.get(path)); cache.set(name, matches); return matches;
  };
}
