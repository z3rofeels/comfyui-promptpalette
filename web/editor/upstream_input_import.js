import { API } from "../prompt_palette_api.js";
import { socketConnected } from "../renderer/base_renderer_adapter.js";

const MAX_SUBGRAPH_NODES = 64;

function getGraphLink(graph, linkId) {
  if (!graph?.links || linkId == null) return null;
  if (typeof graph.links.get === "function") return graph.links.get(linkId) || null;
  return graph.links[linkId] || null;
}

function getGraphNode(graph, nodeId) {
  if (!graph || nodeId == null) return null;
  if (typeof graph.getNodeById === "function") return graph.getNodeById(nodeId) || null;
  return (graph._nodes || []).find(n => String(n?.id) === String(nodeId)) || null;
}

function resolveUpstreamOrigin(graph, startLink) {
  let link = startLink;
  const seen = new Set();
  while (link) {
    const originNode = getGraphNode(graph, link.origin_id);
    if (!originNode) return { node: null, slotIndex: 0 };
    if (originNode.type !== "Reroute") {
      return { node: originNode, slotIndex: Number(link.origin_slot) || 0 };
    }
    const key = String(originNode.id);
    if (seen.has(key)) return { node: null, slotIndex: 0 };
    seen.add(key);
    const inSlot = originNode.inputs?.[0];
    const nextLink = typeof originNode.getInputLink === "function"
      ? originNode.getInputLink(0)
      : getGraphLink(graph, inSlot?.link);
    link = nextLink || null;
  }
  return { node: null, slotIndex: 0 };
}

export function findFieldInputConnection(node, fieldId) {
  const inputName = `field_in_${fieldId}`;
  const inputs = Array.isArray(node?.inputs) ? node.inputs : [];
  const slotIndex = inputs.findIndex(slot => slot?.name === inputName);
  const slot = slotIndex >= 0 ? inputs[slotIndex] : null;
  const connected = !!slot && socketConnected("input", slot, node);
  if (!connected) {
    return { connected: false, slotIndex, slot, sourceNode: null, sourceSlotIndex: 0, sourceLabel: "" };
  }
  const graph = node?.graph;
  const link = (typeof node?.getInputLink === "function" ? node.getInputLink(slotIndex) : null)
    || getGraphLink(graph, slot?.link);
  const { node: sourceNode, slotIndex: sourceSlotIndex } = resolveUpstreamOrigin(graph, link);
  const sourceLabel = String(sourceNode?.title || sourceNode?.comfyClass || sourceNode?.type || "connected input");
  return { connected: true, slotIndex, slot, sourceNode, sourceSlotIndex, sourceLabel };
}

export function prunePromptSubgraph(outputGraph, targetNodeId) {
  if (!outputGraph || typeof outputGraph !== "object") return {};
  const pruned = {};
  const queue = [String(targetNodeId)];
  while (queue.length) {
    const id = queue.shift();
    if (Object.hasOwn(pruned, id)) continue;
    const spec = outputGraph[id];
    if (!spec || typeof spec !== "object") continue;
    if (Object.keys(pruned).length >= MAX_SUBGRAPH_NODES) {
      throw new Error(`Upstream chain exceeds ${MAX_SUBGRAPH_NODES} nodes.`);
    }
    pruned[id] = spec;
    const inputs = spec.inputs || {};
    for (const value of Object.values(inputs)) {
      if (Array.isArray(value) && value.length >= 2 && (typeof value[0] === "string" || typeof value[0] === "number")) {
        const upId = String(value[0]);
        if (!Object.hasOwn(pruned, upId)) queue.push(upId);
      }
    }
  }
  return pruned;
}

export async function buildLiteGraphSubgraph(graph, targetNode) {
  const prompt = {};
  const queue = [targetNode];
  const visited = new Set();

  while (queue.length) {
    const current = queue.shift();
    if (!current) continue;
    const id = String(current.id);
    if (visited.has(id)) continue;
    visited.add(id);
    if (Object.keys(prompt).length >= MAX_SUBGRAPH_NODES) {
      throw new Error(`Upstream chain exceeds ${MAX_SUBGRAPH_NODES} nodes.`);
    }

    const inputs = {};
    const widgetList = Array.isArray(current.widgets) ? current.widgets : [];
    for (let i = 0; i < widgetList.length; i++) {
      const w = widgetList[i];
      if (!w?.name || w.options?.serialize === false) continue;
      inputs[w.name] = typeof w.serializeValue === "function"
        ? await w.serializeValue(current, i)
        : w.value;
    }

    const slotList = Array.isArray(current.inputs) ? current.inputs : [];
    for (let i = 0; i < slotList.length; i++) {
      const slot = slotList[i];
      if (!slot?.name || slot.link == null) continue;
      const link = (typeof current.getInputLink === "function" ? current.getInputLink(i) : null)
        || getGraphLink(graph, slot.link);
      const { node: origin, slotIndex } = resolveUpstreamOrigin(graph, link);
      if (!origin) continue;
      if (origin.type === "PrimitiveNode") {
        inputs[slot.name] = origin.widgets?.[0]?.value ?? "";
      } else {
        inputs[slot.name] = [String(origin.id), slotIndex];
        if (!visited.has(String(origin.id))) queue.push(origin);
      }
    }

    prompt[id] = {
      class_type: current.comfyClass || current.type || "",
      inputs,
    };
  }

  return prompt;
}

export async function resolveFieldInputText({ node, fieldId, app = null, evalInput = API.evalInput } = {}) {
  const conn = findFieldInputConnection(node, fieldId);
  if (!conn.connected) {
    throw new Error("Connect an upstream node to this field's input socket first.");
  }

  const inputName = `field_in_${fieldId}`;
  if (typeof app?.graphToPrompt === "function") {
    try {
      const promptData = await app.graphToPrompt();
      const entry = promptData?.output?.[String(node.id)];
      if (entry?.inputs && Object.hasOwn(entry.inputs, inputName)) {
        const ref = entry.inputs[inputName];
        if (!Array.isArray(ref)) {
          return { text: ref == null ? "" : String(ref), sourceLabel: conn.sourceLabel };
        }
        const targetId = String(ref[0]);
        const outputIndex = Number(ref[1]) || 0;
        const pruned = prunePromptSubgraph(promptData.output, targetId);
        if (Object.hasOwn(pruned, targetId)) {
          const data = await evalInput({ prompt: pruned, targetNode: targetId, outputIndex });
          return { text: String(data?.text ?? ""), sourceLabel: conn.sourceLabel };
        }
      }
    } catch (error) {
      if (!conn.sourceNode) throw error;
    }
  }

  if (!conn.sourceNode) {
    throw new Error("Could not find the connected upstream node.");
  }
  if (conn.sourceNode.type === "PrimitiveNode") {
    const value = conn.sourceNode.widgets?.[0]?.value;
    return { text: value == null ? "" : String(value), sourceLabel: conn.sourceLabel };
  }
  const subgraph = await buildLiteGraphSubgraph(node.graph, conn.sourceNode);
  const data = await evalInput({
    prompt: subgraph,
    targetNode: String(conn.sourceNode.id),
    outputIndex: conn.sourceSlotIndex,
  });
  return { text: String(data?.text ?? ""), sourceLabel: conn.sourceLabel };
}

export function disconnectFieldInput(node, fieldId) {
  const conn = findFieldInputConnection(node, fieldId);
  if (!conn.connected || conn.slotIndex < 0) return false;
  if (typeof node?.disconnectInput === "function") {
    node.disconnectInput(conn.slotIndex);
  } else if (conn.slot) {
    const linkId = conn.slot.link;
    conn.slot.link = null;
    if (linkId != null && typeof node?.graph?.removeLink === "function") {
      node.graph.removeLink(linkId);
    }
  }
  node?.setDirtyCanvas?.(true, true);
  node?._ppRecipeWorkspace?.contextChanged?.();
  return true;
}
