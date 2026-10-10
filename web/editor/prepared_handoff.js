import { app } from "../../../scripts/app.js";
import { installPromptStateGuard, installNegativePromptState } from "../prompt_palette_compat.js";
import { preparedBatch, installPreparedBatchState } from "./prompt_refinement.js";

// One handoff for selection exploration and workspace scopes. It never queues.
export function sendPreparedPrompts({ node, source, prompts, seed, session = {}, negative = "" }) {
  const factory = globalThis.LiteGraph?.createNode;
  if (typeof factory !== "function" || !app.graph) throw new Error("ComfyUI could not create a Combinatorial node. Copy a version instead.");
  const target = factory.call(globalThis.LiteGraph, "PromptPaletteCombinatorial");
  if (!target) throw new Error("The Combinatorial node type is not registered.");
  const text = target.widgets?.find(w => w.name === "text"), batch = target.widgets?.find(w => w.name === "prepared_batch");
  if (!text || !batch) throw new Error("Restart ComfyUI to load the updated Combinatorial node schema.");
  const serialized = preparedBatch(source, prompts, { ...session, source });
  installPromptStateGuard(target, text).commit(source);
  installPreparedBatchState(target, batch).commit(serialized);
  installNegativePromptState(target).commit(negative);
  target._wgRefreshFromHidden?.();
  target.pos = [(node.pos?.[0] || 0) + (node.size?.[0] || 400) + 60, node.pos?.[1] || 0];
  const seedWidget = target.widgets.find(w => w.name === "seed"); if (seedWidget) seedWidget.value = seed;
  app.graph.add(target); app.graph.setDirtyCanvas?.(true, true);
  return target;
}
