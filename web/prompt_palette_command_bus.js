const targets = new Map();
let activeId = null;
let sequence = 0;

function targetId(node) {
  const id = node?.id ?? node?.graph?.getNodeId?.(node);
  return id == null ? `pp-${++sequence}` : String(id);
}

export function registerPromptPaletteCommandTarget(node, handlers = {}) {
  const id = targetId(node);
  targets.set(id, { node, handlers, touchedAt: Date.now() });
  activeId = id;
  return {
    id,
    activate() {
      const target = targets.get(id);
      if (!target) return;
      target.touchedAt = Date.now();
      activeId = id;
    },
    cleanup() {
      targets.delete(id);
      if (activeId === id) {
        activeId = [...targets.entries()].sort((a, b) => b[1].touchedAt - a[1].touchedAt)[0]?.[0] || null;
      }
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
