const changes = new EventTarget();
const changed = () => changes.dispatchEvent(new Event("change"));

const targets = new Map();
let activeId = null;
let sequence = 0;
const nodeIds = new WeakMap();

function targetId(node) {
  if (!nodeIds.has(node)) nodeIds.set(node, `pp-${++sequence}`);
  return nodeIds.get(node);
}

export function registerPromptPaletteCommandTarget(node, handlers = {}) {
  const id = targetId(node);
  targets.set(id, { node, handlers, touchedAt: Date.now() });
  activeId = id;
  changed();
  return {
    id,
    activate() {
      const target = targets.get(id);
      if (!target) return;
      target.touchedAt = Date.now();
      activeId = id;
      changed();
    },
    cleanup() {
      targets.delete(id);
      if (activeId === id) {
        activeId = [...targets.entries()].sort((a, b) => b[1].touchedAt - a[1].touchedAt)[0]?.[0] || null;
      }
      changed();
    },
  };
}

function currentTarget() {
  const direct = activeId && targets.get(activeId);
  if (direct) return direct;
  return [...targets.values()].sort((a, b) => b.touchedAt - a.touchedAt)[0] || null;
}

export function invokePromptPaletteCommand(command, ...args) {
  const target = currentTarget();
  const fn = target?.handlers?.[command];
  if (typeof fn !== "function") return false;
  target.touchedAt = Date.now();
  fn(...args);
  return true;
}

export function promptPaletteCommandTargetCount() {
  return targets.size;
}

// Use node identity at the boundary: node ids can repeat in different workflows.
export function listPromptPaletteCommandTargets(graph) {
  return [...targets.values()].filter(t => t.node.graph === graph && !t.node._ppLifecycle?.signal.aborted);
}
export function onPromptPaletteCommandTargetsChanged(fn) {
  changes.addEventListener("change", fn);
  return () => changes.removeEventListener("change", fn);
}
