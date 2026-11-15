// Named snapshots of the existing wg_io visibility choices, never graph links
// or another active port state. Layouts travel with the owning workflow node.
export const MAX_PORT_LAYOUTS = 16;
const normalizedName = value => [...String(value ?? "").replace(/\s+/gu, " ").trim()].slice(0, 60).join("");
const nameKey = value => value.normalize("NFKC").toLowerCase();
const keys = value => Array.isArray(value) ? [...new Set(value.slice(0, 256).filter(key => typeof key === "string" && key.length && key.length <= 256))] : [];

export function readPortLayouts(raw) {
  if (!Array.isArray(raw)) return [];
  const result = [], ids = new Set(), names = new Set();
  for (const item of raw.slice(0, 64)) {
    if (!item || typeof item !== "object" || typeof item.name !== "string" || typeof item.id !== "string" || !/^[\w-]{1,80}$/.test(item.id) || !Array.isArray(item.inputs) || !Array.isArray(item.outputs)) continue;
    const name = normalizedName(item.name);
    if (!name || ids.has(item.id) || names.has(nameKey(name))) continue;
    ids.add(item.id); names.add(nameKey(name));
    result.push({ id: item.id, name, inputs: keys(item.inputs), outputs: keys(item.outputs) });
    if (result.length === MAX_PORT_LAYOUTS) break;
  }
  return result;
}

export function savePortLayout(raw, { id = "", name, inputs, outputs }) {
  const items = readPortLayouts(raw), title = normalizedName(name);
  if (!title) throw new Error("Name this port layout before saving.");
  if (items.some(item => item.id !== id && nameKey(item.name) === nameKey(title))) throw new Error("A port layout already uses that name. Choose it to update it, or enter another name.");
  const index = items.findIndex(item => item.id === id);
  if (index < 0 && items.length >= MAX_PORT_LAYOUTS) throw new Error(`Keep up to ${MAX_PORT_LAYOUTS} port layouts per node. Update or delete one before adding another.`);
  const key = index >= 0 || typeof id === "string" && /^[\w-]{1,80}$/.test(id) ? id : globalThis.crypto?.randomUUID?.() || `ports_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  const layout = { id: key, name: title, inputs: keys(inputs), outputs: keys(outputs) };
  if (index >= 0) items[index] = layout; else items.push(layout);
  return { items, layout };
}

export function matchingPortLayout(layout, current) {
  return ["inputs", "outputs"].every(kind => {
    const a = new Set(layout[kind]), b = new Set(current[kind]);
    return a.size === b.size && [...a].every(key => b.has(key));
  });
}
