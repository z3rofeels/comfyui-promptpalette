import { app } from "../../../scripts/app.js";
import { installPromptStateGuard, installNegativePromptState, installPositiveAntonymsState, ioState } from "../prompt_palette_compat.js";
import { preparedBatch, installPreparedBatchState } from "./prompt_refinement.js";
import { positiveAntonymsEnabled } from "./positive_antonyms.js";

// One handoff for selection exploration and workspace scopes. It never queues.
export function sendPreparedPrompts({ node, source, prompts, seed, session = {}, negative = "" }) {
  const factory = globalThis.LiteGraph?.createNode;
  if (typeof factory !== "function" || !app.graph) throw new Error("ComfyUI could not create a Combinatorial node. Copy a version instead.");
  const target = factory.call(globalThis.LiteGraph, "PromptPaletteCombinatorial");
  if (!target) throw new Error("The Combinatorial node type is not registered.");
  const text = target.widgets?.find(w => w.name === "text"), batch = target.widgets?.find(w => w.name === "prepared_batch");
  if (!text || !batch) throw new Error("Restart ComfyUI to load the updated Combinatorial node schema.");
  const serialized = preparedBatch(source, prompts, { ...session, source, ...(session.negative_prompts ? { negative_source: negative } : {}) });
  installPromptStateGuard(target, text).commit(source);
  installPreparedBatchState(target, batch).commit(serialized);
  installNegativePromptState(target).commit(negative);
  installPositiveAntonymsState(target)?.commit(positiveAntonymsEnabled(node));
  target.pos = [(node.pos?.[0] || 0) + (node.size?.[0] || 400) + 60, node.pos?.[1] || 0];
  const seedWidget = target.widgets.find(w => w.name === "seed"); if (seedWidget) seedWidget.value = seed;
  if (session.comparison === "one-field") {
    const seedMode = target.widgets.find(w => w.name === "seed_mode");
    if (seedMode) seedMode.value = "fixed";
    target.title = "Prompt Palette · Field comparison";
  }
  if (session.negative_prompts && new Set(session.negative_prompts).size > 1) {
    const outputs = ioState(target).outputs;
    outputs.negative_prompt_list = true; outputs.negative_conditioning_list = true;
  }
  app.graph.add(target); app.graph.setDirtyCanvas?.(true, true);
  target._wgRefreshFromHidden?.();
  target._wgRefreshIoToggles?.();
  return target;
}
