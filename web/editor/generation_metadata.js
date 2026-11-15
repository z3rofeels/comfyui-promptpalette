// Read-only metadata extraction and workflow component projection for Recent Generations.
// Reuses existing Prompt Palette generation records and ComfyUI history/image metadata.

const SAMPLER_CLASSES = new Set([
  "KSampler", "KSamplerAdvanced", "SamplerCustom", "SamplerCustomAdvanced",
  "KSamplerSelect", "BasicScheduler", "SDTurboScheduler", "BetaSamplingScheduler",
  "AlignYourStepsScheduler", "KarrasScheduler", "ExponentialScheduler",
  "PolyexponentialScheduler", "VPScheduler", "CFGGuider", "BasicGuider",
  "DualCFGGuider", "RandomNoise", "FluxGuidance", "ModelSamplingFlux",
  "ModelSamplingSD3", "ModelSamplingAuraFlow",
]);

const MODEL_LOADER_CLASSES = new Set([
  "CheckpointLoaderSimple", "CheckpointLoader", "ImageOnlyCheckpointLoader",
  "unCLIPCheckpointLoader", "UNETLoader", "DiffusionModelLoader", "UnetLoaderGGUF",
  "CLIPLoader", "DualCLIPLoader", "TripleCLIPLoader", "CLIPLoaderGGUF",
  "VAELoader", "LoraLoader", "LoraLoaderModelOnly",
]);

const PROMPT_CLASSES = new Set([
  "PromptPaletteEditor", "PromptPaletteCombinatorial",
  "CLIPTextEncode", "CLIPTextEncodeSDXL", "CLIPTextEncodeSDXLRefiner", "CLIPTextEncodeFlux",
]);

function isScalar(value) {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value)) || typeof value === "boolean";
}

function isLink(value) {
  return Array.isArray(value) && value.length === 2 && (typeof value[0] === "string" || typeof value[0] === "number");
}

function cleanString(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? value : null;
}

function cleanScalarText(value) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  return null;
}

function resolveInputValue(graph, inputs, keys, depth = 0) {
  if (!inputs || typeof inputs !== "object" || depth > 4) return null;
  const keyList = Array.isArray(keys) ? keys : [keys];
  for (const key of keyList) {
    const raw = inputs[key];
    if (isScalar(raw)) {
      const text = cleanScalarText(raw);
      if (text !== null) return raw;
    }
    if (isLink(raw) && graph && typeof graph === "object") {
      const upstream = graph[String(raw[0])];
      if (upstream && typeof upstream.inputs === "object") {
        const linked = resolveInputValue(
          graph,
          upstream.inputs,
          [...keyList, "value", "seed", "noise_seed", "sampler_name", "scheduler", "steps", "cfg", "guidance", "denoise", "int", "float", "text"],
          depth + 1
        );
        if (linked !== null) return linked;
      }
    }
  }
  return null;
}

function collectOrderedGraphNodes(graph, startNodeId) {
  if (!graph || typeof graph !== "object") return { upstreamIds: [], allIds: [] };
  const allIds = Object.keys(graph).filter(id => graph[id] && typeof graph[id] === "object");
  const upstreamIds = [];
  const visited = new Set();
  const start = startNodeId != null ? String(startNodeId) : "";
  if (start && graph[start]) {
    const queue = [start];
    while (queue.length) {
      const nid = queue.shift();
      if (visited.has(nid)) continue;
      visited.add(nid);
      const node = graph[nid];
      if (!node || typeof node !== "object") continue;
      upstreamIds.push(nid);
      const inputs = node.inputs;
      if (inputs && typeof inputs === "object") {
        for (const val of Object.values(inputs)) {
          if (isLink(val)) {
            const targetId = String(val[0]);
            if (!visited.has(targetId) && graph[targetId]) queue.push(targetId);
          }
        }
      }
    }
  }
  const restIds = allIds.filter(id => !visited.has(id));
  return { upstreamIds, allIds: [...upstreamIds, ...restIds] };
}

export function parsePngTextChunks(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer || 0);
  if (bytes.length < 8) return {};
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) if (bytes[i] !== sig[i]) return {};
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const latin1 = new TextDecoder("iso-8859-1");
  const out = {};
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
    const type = latin1.decode(bytes.subarray(offset + 4, offset + 8));
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.length) break;
    if (type === "IHDR" && length >= 8) {
      const w = ((bytes[dataStart] << 24) | (bytes[dataStart + 1] << 16) | (bytes[dataStart + 2] << 8) | bytes[dataStart + 3]) >>> 0;
      const h = ((bytes[dataStart + 4] << 24) | (bytes[dataStart + 5] << 16) | (bytes[dataStart + 6] << 8) | bytes[dataStart + 7]) >>> 0;
      if (w > 0 && h > 0) {
        out.width = w;
        out.height = h;
      }
    } else if (type === "tEXt") {
      const chunk = bytes.subarray(dataStart, dataEnd);
      const nul = chunk.indexOf(0);
      if (nul > 0) {
        const key = latin1.decode(chunk.subarray(0, nul));
        const text = decoder.decode(chunk.subarray(nul + 1));
        out[key] = text;
      }
    } else if (type === "iTXt") {
      const chunk = bytes.subarray(dataStart, dataEnd);
      const nul = chunk.indexOf(0);
      if (nul > 0 && nul + 3 <= chunk.length) {
        const key = latin1.decode(chunk.subarray(0, nul));
        const compFlag = chunk[nul + 1];
        let pos = nul + 3;
        const langEnd = chunk.indexOf(0, pos);
        if (langEnd >= 0) {
          pos = langEnd + 1;
          const transEnd = chunk.indexOf(0, pos);
          if (transEnd >= 0 && compFlag === 0) {
            out[key] = decoder.decode(chunk.subarray(transEnd + 1));
          }
        }
      }
    } else if (type === "IDAT" || type === "IEND") {
      break;
    }
    offset = dataEnd + 4;
  }
  const parsed = {};
  for (const [key, value] of Object.entries(out)) {
    if (["prompt", "workflow", "prompt_palette", "prompt_palette_metadata"].includes(key)) {
      try { parsed[key] = JSON.parse(value); } catch { parsed[key] = value; }
    } else {
      parsed[key] = value;
    }
  }
  return parsed;
}

function parseA1111Parameters(text) {
  if (typeof text !== "string" || !text.trim()) return {};
  const lines = text.trim().split(/\r?\n/);
  const result = {};
  let paramLineIndex = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/\b(Steps|Sampler|CFG scale|Seed|Model|Size):/i.test(lines[i])) {
      paramLineIndex = i;
      break;
    }
  }
  if (paramLineIndex >= 0) {
    const paramLine = lines.slice(paramLineIndex).join(" ");
    const pairs = paramLine.split(/,\s*(?=[A-Za-z0-9 _-]+:\s)/);
    for (const pair of pairs) {
      const idx = pair.indexOf(":");
      if (idx <= 0) continue;
      const k = pair.slice(0, idx).trim().toLowerCase();
      const v = pair.slice(idx + 1).trim();
      if (!v) continue;
      if (k === "steps") result.steps = Number(v) || v;
      else if (k === "sampler") result.sampler = v;
      else if (k === "schedule type" || k === "scheduler") result.scheduler = v;
      else if (k === "cfg scale" || k === "cfg") result.cfg = Number(v) || v;
      else if (k === "seed") result.samplerSeed = v;
      else if (k === "model") result.model = v;
      else if (k === "size") result.resolution = v.replace(/x/i, "×");
      else if (k === "denoising strength" || k === "denoise") result.denoise = Number(v) || v;
    }
    const promptLines = lines.slice(0, paramLineIndex).join("\n");
    const negIdx = promptLines.indexOf("\nNegative prompt:");
    if (negIdx >= 0) {
      result.positive = cleanString(promptLines.slice(0, negIdx));
      result.negative = cleanString(promptLines.slice(negIdx + "\nNegative prompt:".length).trim());
    } else if (promptLines.startsWith("Negative prompt:")) {
      result.negative = cleanString(promptLines.slice("Negative prompt:".length).trim());
    } else {
      result.positive = cleanString(promptLines);
    }
  }
  return result;
}

function normalizeHistoryEntry(rawHistory, promptId) {
  if (!rawHistory || typeof rawHistory !== "object") return null;
  if (promptId && rawHistory[promptId] && typeof rawHistory[promptId] === "object") {
    return rawHistory[promptId];
  }
  if (Array.isArray(rawHistory.prompt) || rawHistory.outputs || rawHistory.status) {
    return rawHistory;
  }
  const keys = Object.keys(rawHistory);
  if (keys.length === 1 && rawHistory[keys[0]] && typeof rawHistory[keys[0]] === "object") {
    const candidate = rawHistory[keys[0]];
    if (Array.isArray(candidate.prompt) || candidate.outputs) return candidate;
  }
  return null;
}

function classifyNodeCategory(classType) {
  const name = String(classType || "");
  if (PROMPT_CLASSES.has(name) || /Prompt|Conditioning|TextEncode/i.test(name)) return "prompt";
  if (SAMPLER_CLASSES.has(name) || /Sampler|Scheduler|Guider|Noise|Guidance/i.test(name)) return "sampler";
  if (MODEL_LOADER_CLASSES.has(name) || /Loader|Checkpoint|UNET|CLIP|VAE|Lora/i.test(name)) return "model";
  return "other";
}

function summarizeNodeInputs(inputs) {
  if (!inputs || typeof inputs !== "object") return "";
  const parts = [];
  const priorityKeys = [
    "ckpt_name", "unet_name", "model_name", "lora_name", "clip_name", "clip_name1", "vae_name",
    "sampler_name", "scheduler", "steps", "cfg", "guidance", "denoise", "seed", "noise_seed",
    "width", "height", "text",
  ];
  for (const key of priorityKeys) {
    if (!(key in inputs)) continue;
    const val = inputs[key];
    if (!isScalar(val)) continue;
    const str = String(val).trim();
    if (!str) continue;
    const shortVal = str.length > 42 ? `${str.slice(0, 39)}…` : str;
    parts.push(`${key}: ${shortVal}`);
    if (parts.length >= 4) break;
  }
  return parts.join(" · ");
}

export function extractGenerationMetadata(record = {}, extra = {}) {
  const safeRecord = record && typeof record === "object" ? record : {};
  const historyEntry = normalizeHistoryEntry(extra.historyEntry || safeRecord.history, safeRecord.prompt_id);
  const embedded = extra.embedded && typeof extra.embedded === "object" ? extra.embedded : {};

  const promptTuple = Array.isArray(historyEntry?.prompt) ? historyEntry.prompt : null;
  const promptGraph = (
    (promptTuple && promptTuple[2] && typeof promptTuple[2] === "object" ? promptTuple[2] : null)
    || (embedded.prompt && typeof embedded.prompt === "object" ? embedded.prompt : null)
    || (safeRecord.prompt_graph && typeof safeRecord.prompt_graph === "object" ? safeRecord.prompt_graph : null)
    || (safeRecord.prompt && typeof safeRecord.prompt === "object" && !Array.isArray(safeRecord.prompt) ? safeRecord.prompt : null)
  );

  const extraData = promptTuple && promptTuple[3] && typeof promptTuple[3] === "object" ? promptTuple[3] : {};
  const extraPnginfo = extraData.extra_pnginfo && typeof extraData.extra_pnginfo === "object" ? extraData.extra_pnginfo : {};
  const workflow = (
    (extraPnginfo.workflow && typeof extraPnginfo.workflow === "object" ? extraPnginfo.workflow : null)
    || (embedded.workflow && typeof embedded.workflow === "object" ? embedded.workflow : null)
    || (safeRecord.workflow && typeof safeRecord.workflow === "object" ? safeRecord.workflow : null)
  );

  const a1111 = parseA1111Parameters(
    typeof embedded.parameters === "string" ? embedded.parameters
    : typeof safeRecord.parameters === "string" ? safeRecord.parameters : ""
  );

  const contexts = Array.isArray(safeRecord.contexts) ? safeRecord.contexts.filter(c => c && typeof c === "object") : [];

  // Prompts extraction
  let resolvedPositive = cleanString(safeRecord.resolved_positive);
  let resolvedNegative = cleanString(safeRecord.resolved_negative);
  let authoredPositive = cleanString(safeRecord.authored_positive);
  let authoredNegative = cleanString(safeRecord.authored_negative);

  for (const ctx of contexts) {
    const role = ctx.channel_role || "positive";
    const ref = ctx.refinement && typeof ctx.refinement === "object" ? ctx.refinement : {};
    if (!resolvedPositive && role !== "negative") {
      resolvedPositive = cleanString(ctx.resolved_prompt) || cleanString(ref.positive_prompt);
    }
    if (!resolvedNegative && (role === "negative" || role === "both" || safeRecord.provenance === "verified")) {
      resolvedNegative = cleanString(ref.negative_prompt) || (role === "negative" ? cleanString(ctx.resolved_prompt) : null);
    }
    if (!authoredPositive) {
      authoredPositive = cleanString(ctx.authored_positive) || cleanString(ref.source_text);
    }
    if (!authoredNegative) {
      authoredNegative = cleanString(ctx.authored_negative) || cleanString(ref.source_negative_text);
    }
  }

  // Wildcards and LoRAs from contexts and record
  const wildcardSet = new Set();
  for (const w of Array.isArray(safeRecord.wildcards_used) ? safeRecord.wildcards_used : []) {
    if (typeof w === "string" && w.trim()) wildcardSet.add(w.trim());
  }
  const loras = [];
  const seenLoras = new Set();
  const addLora = (name, modelStrength = 1, clipStrength = modelStrength, status = "applied") => {
    if (typeof name !== "string" || !name.trim()) return;
    const key = `${name.trim()}|${modelStrength}|${clipStrength}`;
    if (seenLoras.has(key)) return;
    seenLoras.add(key);
    loras.push({
      name: name.trim(),
      modelStrength: Number.isFinite(Number(modelStrength)) ? Number(modelStrength) : 1,
      clipStrength: Number.isFinite(Number(clipStrength)) ? Number(clipStrength) : 1,
      status,
    });
  };

  for (const ctx of contexts) {
    for (const w of Array.isArray(ctx.wildcards_used) ? ctx.wildcards_used : []) {
      if (typeof w === "string" && w.trim()) wildcardSet.add(w.trim());
    }
    const refLoras = ctx.refinement?.loras;
    if (Array.isArray(refLoras)) {
      for (const item of refLoras) {
        if (item && typeof item.name === "string") {
          addLora(
            item.name,
            item.effective_model_strength ?? item.model_strength ?? 1,
            item.effective_clip_strength ?? item.clip_strength ?? 1,
            item.status || "applied"
          );
        }
      }
    }
  }

  // Parameters from record / direct fields first
  const ctxWithSeed = contexts.find(c => c.seed_text != null || c.seed != null);
  const paletteSeed = cleanScalarText(
    safeRecord.effective_seed_text ?? safeRecord.effective_seed ?? ctxWithSeed?.seed_text ?? ctxWithSeed?.seed
  );

  let samplerSeed = cleanScalarText(safeRecord.sampler_seed ?? safeRecord.noise_seed ?? a1111.samplerSeed);
  let sampler = cleanScalarText(safeRecord.sampler ?? safeRecord.sampler_name ?? a1111.sampler);
  let scheduler = cleanScalarText(safeRecord.scheduler ?? a1111.scheduler);
  let cfg = cleanScalarText(safeRecord.cfg ?? safeRecord.cfg_scale ?? a1111.cfg);
  let guidance = cleanScalarText(safeRecord.guidance);
  let steps = cleanScalarText(safeRecord.steps ?? a1111.steps);
  let denoise = cleanScalarText(safeRecord.denoise ?? safeRecord.denoising_strength ?? a1111.denoise);
  let model = cleanScalarText(safeRecord.model ?? safeRecord.checkpoint ?? safeRecord.ckpt_name ?? safeRecord.unet_name ?? a1111.model);
  let clip = cleanScalarText(safeRecord.clip ?? safeRecord.clip_name);
  let vae = cleanScalarText(safeRecord.vae ?? safeRecord.vae_name);
  let width = cleanScalarText(safeRecord.width);
  let height = cleanScalarText(safeRecord.height);
  let resolution = cleanScalarText(safeRecord.resolution ?? a1111.resolution);
  let batchSize = cleanScalarText(safeRecord.batch_size);
  const extraParams = [];
  const seenExtraKeys = new Set();
  const pushExtraParam = (key, label, rawVal) => {
    const val = cleanScalarText(rawVal);
    if (val === null || seenExtraKeys.has(key)) return;
    seenExtraKeys.add(key);
    extraParams.push({ key, label, value: val, copyValue: val });
  };

  // Traverse promptGraph if available
  const { upstreamIds, allIds } = collectOrderedGraphNodes(promptGraph, safeRecord.output_node_id);
  const searchIds = upstreamIds.length ? upstreamIds : allIds;

  for (const nid of searchIds) {
    const node = promptGraph[nid];
    if (!node || typeof node !== "object") continue;
    const classType = String(node.class_type || "");
    const inputs = node.inputs && typeof node.inputs === "object" ? node.inputs : {};

    if (SAMPLER_CLASSES.has(classType) || /Sampler|Scheduler|Guider|Noise|Guidance/i.test(classType)) {
      if (!sampler) sampler = cleanScalarText(resolveInputValue(promptGraph, inputs, ["sampler_name", "sampler"]));
      if (!scheduler) scheduler = cleanScalarText(resolveInputValue(promptGraph, inputs, ["scheduler"]));
      if (!steps) steps = cleanScalarText(resolveInputValue(promptGraph, inputs, ["steps"]));
      if (!cfg) cfg = cleanScalarText(resolveInputValue(promptGraph, inputs, ["cfg", "cfg_scale"]));
      if (!guidance) guidance = cleanScalarText(resolveInputValue(promptGraph, inputs, ["guidance"]));
      if (!denoise) denoise = cleanScalarText(resolveInputValue(promptGraph, inputs, ["denoise"]));
      if (!samplerSeed) samplerSeed = cleanScalarText(resolveInputValue(promptGraph, inputs, ["seed", "noise_seed"]));
      if (inputs.start_at_step != null) pushExtraParam("start_at_step", "Start step", resolveInputValue(promptGraph, inputs, "start_at_step"));
      if (inputs.end_at_step != null) pushExtraParam("end_at_step", "End step", resolveInputValue(promptGraph, inputs, "end_at_step"));
      if (inputs.max_shift != null) pushExtraParam("max_shift", "Max shift", resolveInputValue(promptGraph, inputs, "max_shift"));
      if (inputs.base_shift != null) pushExtraParam("base_shift", "Base shift", resolveInputValue(promptGraph, inputs, "base_shift"));
    }

    if (MODEL_LOADER_CLASSES.has(classType) || /Loader|Checkpoint|UNET|DiffusionModel/i.test(classType)) {
      if (!model) {
        model = cleanScalarText(resolveInputValue(promptGraph, inputs, ["ckpt_name", "unet_name", "model_name", "diffusion_model"]));
      }
      if (!clip) {
        const c1 = cleanScalarText(resolveInputValue(promptGraph, inputs, ["clip_name", "clip_name1"]));
        const c2 = cleanScalarText(resolveInputValue(promptGraph, inputs, ["clip_name2"]));
        const c3 = cleanScalarText(resolveInputValue(promptGraph, inputs, ["clip_name3"]));
        const clips = [c1, c2, c3].filter(Boolean);
        if (clips.length) clip = clips.join(" + ");
      }
      if (!vae) {
        vae = cleanScalarText(resolveInputValue(promptGraph, inputs, ["vae_name"]));
      }
      if (/LoraLoader/i.test(classType) && isScalar(inputs.lora_name)) {
        addLora(String(inputs.lora_name), inputs.strength_model ?? 1, inputs.strength_clip ?? inputs.strength_model ?? 1, "graph");
      }
      if (inputs.weight_dtype != null && inputs.weight_dtype !== "default") {
        pushExtraParam("weight_dtype", "Weight dtype", resolveInputValue(promptGraph, inputs, "weight_dtype"));
      }
    }

    if (/Empty.*Latent/i.test(classType) || (inputs.width != null && inputs.height != null && inputs.batch_size != null)) {
      if (!width) width = cleanScalarText(resolveInputValue(promptGraph, inputs, "width"));
      if (!height) height = cleanScalarText(resolveInputValue(promptGraph, inputs, "height"));
      if (!batchSize) batchSize = cleanScalarText(resolveInputValue(promptGraph, inputs, "batch_size"));
      if (inputs.length != null) pushExtraParam("length", "Frames / length", resolveInputValue(promptGraph, inputs, "length"));
    }
  }

  // Fallback to workflow.nodes widgets_values if promptGraph was not present
  const workflowNodesById = new Map();
  if (workflow && Array.isArray(workflow.nodes)) {
    for (const wn of workflow.nodes) {
      if (!wn || typeof wn !== "object" || wn.id == null) continue;
      workflowNodesById.set(String(wn.id), wn);
      if (!promptGraph) {
        const wType = String(wn.type || "");
        const wVals = Array.isArray(wn.widgets_values) ? wn.widgets_values : [];
        if ((wType === "KSampler" || wType === "KSamplerAdvanced") && wVals.length >= 6) {
          const isAdv = wType === "KSamplerAdvanced";
          const sSeed = isAdv ? wVals[1] : wVals[0];
          const sSteps = isAdv ? wVals[3] : wVals[2];
          const sCfg = isAdv ? wVals[4] : wVals[3];
          const sSampler = isAdv ? wVals[5] : wVals[4];
          const sScheduler = isAdv ? wVals[6] : wVals[5];
          const sDenoise = isAdv ? null : wVals[6];
          if (!samplerSeed) samplerSeed = cleanScalarText(sSeed);
          if (!steps) steps = cleanScalarText(sSteps);
          if (!cfg) cfg = cleanScalarText(sCfg);
          if (!sampler) sampler = cleanScalarText(sSampler);
          if (!scheduler) scheduler = cleanScalarText(sScheduler);
          if (!denoise && sDenoise != null) denoise = cleanScalarText(sDenoise);
        } else if (/CheckpointLoader|UNETLoader/i.test(wType) && wVals.length >= 1 && !model) {
          model = cleanScalarText(wVals[0]);
        } else if (/Empty.*Latent/i.test(wType) && wVals.length >= 2) {
          if (!width) width = cleanScalarText(wVals[0]);
          if (!height) height = cleanScalarText(wVals[1]);
          if (!batchSize && wVals[2] != null) batchSize = cleanScalarText(wVals[2]);
        }
      }
    }
  }

  if (!width && (extra.dimensions?.width || embedded.width)) {
    width = cleanScalarText(extra.dimensions?.width ?? embedded.width);
  }
  if (!height && (extra.dimensions?.height || embedded.height)) {
    height = cleanScalarText(extra.dimensions?.height ?? embedded.height);
  }
  if (!resolvedPositive && a1111.positive) resolvedPositive = a1111.positive;
  if (!resolvedNegative && a1111.negative) resolvedNegative = a1111.negative;
  if (!resolution && width && height) resolution = `${width}×${height}`;

  const primarySeed = paletteSeed ?? samplerSeed;

  // Build ordered parameterEntries containing ONLY values that actually exist
  const parameterEntries = [];
  const addParam = (key, label, value, copyValue = value) => {
    const text = cleanScalarText(value);
    if (text === null) return;
    parameterEntries.push({ key, label, value: text, copyValue: cleanScalarText(copyValue) ?? text });
  };

  if (primarySeed !== null) {
    addParam("seed", paletteSeed !== null && samplerSeed !== null && paletteSeed !== samplerSeed ? "Palette seed" : "Seed", primarySeed);
  }
  if (samplerSeed !== null && paletteSeed !== null && samplerSeed !== paletteSeed) {
    addParam("sampler_seed", "Sampler seed", samplerSeed);
  }
  addParam("sampler", "Sampler", sampler);
  addParam("scheduler", "Scheduler", scheduler);
  addParam("cfg", "CFG", cfg);
  addParam("guidance", "Guidance", guidance);
  addParam("steps", "Steps", steps);
  addParam("denoise", "Denoise", denoise);
  addParam("model", "Model", model);
  addParam("clip", "CLIP", clip);
  addParam("vae", "VAE", vae);
  addParam("resolution", "Dimensions", resolution);
  if (batchSize !== null && batchSize !== "1") {
    addParam("batch_size", "Batch size", batchSize);
  }
  for (const item of extraParams) {
    addParam(item.key, item.label, item.value, item.copyValue);
  }

  // Build workflow components (participating nodes & graph/workflow nodes)
  const workflowComponents = [];
  const seenComponentIds = new Set();
  const contextById = new Map();
  for (const ctx of contexts) {
    if (ctx.node_id != null) contextById.set(String(ctx.node_id), ctx);
  }

  // 1. Add participating Prompt Palette contexts first
  for (const ctx of contexts) {
    const id = String(ctx.node_id ?? `ctx-${workflowComponents.length + 1}`);
    seenComponentIds.add(id);
    const apiNode = promptGraph?.[id] || null;
    const wfNode = workflowNodesById.get(id) || null;
    const nodeType = ctx.node_type || apiNode?.class_type || wfNode?.type || "PromptPaletteEditor";
    const title = ctx.title || wfNode?.title || apiNode?._meta?.title || `${nodeType} #${id}`;
    const summaryParts = [];
    if (ctx.channel_role) summaryParts.push(`role: ${ctx.channel_role}`);
    const cSeed = ctx.seed_text ?? ctx.seed;
    if (cSeed != null) summaryParts.push(`seed: ${cSeed}`);
    if (ctx.wildcards_used?.length) summaryParts.push(`${ctx.wildcards_used.length} wildcard(s)`);
    if (ctx.refinement?.loras?.length) summaryParts.push(`${ctx.refinement.loras.length} LoRA(s)`);
    workflowComponents.push({
      id,
      title,
      nodeType,
      category: "prompt",
      summary: summaryParts.join(" · ") || summarizeNodeInputs(apiNode?.inputs),
      context: ctx,
      apiNode,
      workflowNode: wfNode,
    });
  }

  // 2. Add executed graph nodes
  for (const nid of allIds) {
    if (seenComponentIds.has(nid)) continue;
    seenComponentIds.add(nid);
    const apiNode = promptGraph[nid];
    const wfNode = workflowNodesById.get(nid) || null;
    const nodeType = String(apiNode?.class_type || wfNode?.type || "Node");
    const title = wfNode?.title || apiNode?._meta?.title || `${nodeType} #${nid}`;
    const category = classifyNodeCategory(nodeType);
    workflowComponents.push({
      id: nid,
      title,
      nodeType,
      category,
      summary: summarizeNodeInputs(apiNode?.inputs),
      context: null,
      apiNode,
      workflowNode: wfNode,
    });
  }

  // 3. Add any remaining UI workflow nodes if promptGraph was absent
  if (!allIds.length && workflowNodesById.size) {
    for (const [nid, wfNode] of workflowNodesById.entries()) {
      if (seenComponentIds.has(nid)) continue;
      seenComponentIds.add(nid);
      const nodeType = String(wfNode.type || "Node");
      const title = wfNode.title || `${nodeType} #${nid}`;
      const category = classifyNodeCategory(nodeType);
      const wVals = Array.isArray(wfNode.widgets_values)
        ? wfNode.widgets_values.filter(isScalar).slice(0, 4).map(v => String(v)).join(" · ")
        : "";
      workflowComponents.push({
        id: nid,
        title,
        nodeType,
        category,
        summary: wVals,
        context: null,
        apiNode: null,
        workflowNode: wfNode,
      });
    }
  }

  const positivePrompt = resolvedPositive ?? authoredPositive;
  const negativePrompt = resolvedNegative ?? authoredNegative;

  return {
    id: safeRecord.id || null,
    promptId: cleanScalarText(safeRecord.prompt_id),
    filename: safeRecord.image?.filename || "",
    provenance: safeRecord.provenance || "run-associated",
    completedAt: safeRecord.completed_at || 0,
    workflowHash: cleanScalarText(safeRecord.workflow_hash),
    positivePrompt,
    resolvedPositive,
    authoredPositive,
    negativePrompt,
    resolvedNegative,
    authoredNegative,
    wildcardsUsed: [...wildcardSet],
    loras,
    seed: primarySeed,
    paletteSeed,
    samplerSeed,
    sampler,
    scheduler,
    cfg,
    guidance,
    steps,
    denoise,
    model,
    clip,
    vae,
    width,
    height,
    resolution,
    batchSize,
    parameterEntries,
    workflow,
    promptGraph,
    workflowComponents,
    hasWorkflow: Boolean(workflow || promptGraph),
    hasPrompts: Boolean(positivePrompt || negativePrompt || wildcardSet.size || loras.length),
    hasParameters: parameterEntries.length > 0,
  };
}

export function formatSamplerScheduler(meta) {
  if (!meta) return "";
  if (meta.sampler && meta.scheduler) return `${meta.sampler} / ${meta.scheduler}`;
  return meta.sampler || meta.scheduler || "";
}

export function formatParametersSummary(meta) {
  if (!meta?.parameterEntries?.length) return "";
  return meta.parameterEntries.map(entry => `${entry.label}: ${entry.value}`).join(", ");
}

export function formatCompletePromptInfo(meta) {
  if (!meta) return "";
  const sections = [];
  if (meta.positivePrompt) {
    sections.push(meta.positivePrompt);
  }
  if (meta.authoredPositive && meta.resolvedPositive && meta.authoredPositive !== meta.resolvedPositive) {
    sections.push(`Authored positive: ${meta.authoredPositive}`);
  }
  if (meta.negativePrompt) {
    sections.push(`Negative prompt: ${meta.negativePrompt}`);
  }
  if (meta.authoredNegative && meta.resolvedNegative && meta.authoredNegative !== meta.resolvedNegative) {
    sections.push(`Authored negative: ${meta.authoredNegative}`);
  }
  if (meta.loras?.length) {
    const loraText = meta.loras.map(l => `<lora:${l.name}:${l.modelStrength}${l.clipStrength !== l.modelStrength ? `:${l.clipStrength}` : ""}>`).join(" ");
    sections.push(`LoRAs: ${loraText}`);
  }
  if (meta.wildcardsUsed?.length) {
    sections.push(`Wildcards: ${meta.wildcardsUsed.join(", ")}`);
  }
  const paramSummary = formatParametersSummary(meta);
  if (paramSummary) {
    sections.push(paramSummary);
  }
  return sections.join("\n");
}

export function serializeWorkflowComponent(component) {
  if (!component) return "";
  const payload = {
    id: component.id,
    title: component.title,
    type: component.nodeType,
    category: component.category,
  };
  if (component.workflowNode) payload.workflow_node = component.workflowNode;
  if (component.apiNode) payload.api_node = component.apiNode;
  if (component.context) payload.prompt_palette_context = component.context;
  return JSON.stringify(payload, null, 2);
}

export function buildWorkflowSubset(meta, selectedIds) {
  if (!meta) return "";
  const idSet = new Set(Array.from(selectedIds || [], id => String(id)));
  const components = (meta.workflowComponents || []).filter(c => idSet.has(String(c.id)));
  if (!components.length) return "";

  if (meta.workflow && Array.isArray(meta.workflow.nodes)) {
    const nodes = meta.workflow.nodes.filter(n => n && idSet.has(String(n.id)));
    const links = Array.isArray(meta.workflow.links)
      ? meta.workflow.links.filter(link => Array.isArray(link) && idSet.has(String(link[1])) && idSet.has(String(link[3])))
      : [];
    const subset = {
      version: meta.workflow.version ?? 0.4,
      nodes,
      links,
    };
    if (meta.promptGraph) {
      const apiSubset = {};
      for (const id of idSet) {
        if (meta.promptGraph[id]) apiSubset[id] = meta.promptGraph[id];
      }
      if (Object.keys(apiSubset).length) subset.prompt = apiSubset;
    }
    return JSON.stringify(subset, null, 2);
  }

  if (meta.promptGraph) {
    const apiSubset = {};
    for (const id of idSet) {
      if (meta.promptGraph[id]) apiSubset[id] = meta.promptGraph[id];
    }
    return JSON.stringify(apiSubset, null, 2);
  }

  return JSON.stringify(
    components.map(c => c.context || { id: c.id, title: c.title, type: c.nodeType }),
    null,
    2
  );
}
