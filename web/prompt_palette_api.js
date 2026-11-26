import { api } from "../../scripts/api.js";

async function readApiJson(response, { allowNotFound = false } = {}) {
  if (allowNotFound && response.status === 404) return null;
  let data = {};
  const text = await response.text();
  if (text) {
    try { data = JSON.parse(text); }
    catch {
      if (response.ok) throw new Error(`Prompt Palette received an invalid server response (${response.status})`);
    }
  }
  if (!response.ok) {
    if (response.status === 404) {
      const path = response.url ? new URL(response.url, globalThis.location?.href).pathname : "requested endpoint";
      throw new Error(`Prompt Palette server route is unavailable (${path}). Restart the ComfyUI backend after updating, then reload this page. If it persists, check the startup log for route-registration errors and duplicate Prompt Palette installations.`);
    }
    throw new Error(data?.error || data?.message || `Prompt Palette request failed (${response.status})`);
  }
  return data;
}

// One event source across independently loaded extension modules. Each editor
// owns its subscription and releases it when ComfyUI removes the node.
const libraryEventsKey = Symbol.for("comfyui.prompt-palette.library-events.v1");
const libraryEvents = globalThis[libraryEventsKey] ||= new EventTarget();
const libraryChannelKey = Symbol.for("comfyui.prompt-palette.library-channel.v1");
const previewRevisionKey = Symbol.for("comfyui.prompt-palette.preview-revision.v1");
globalThis[previewRevisionKey] ||= 0;

// Bridge the existing notifications to other tabs. Only an invalidation travels:
// each subscriber reads its own authoritative server snapshot. This keeps large
// library results out of the channel and preserves the existing stale-read guards.
function getLibraryChannel() {
  if (typeof globalThis.BroadcastChannel !== "function" || !globalThis.location?.href) return null;
  try {
    const endpoint = new URL(promptPaletteUrl("/prompt_palette/list"), globalThis.location.href).href;
    const shared = globalThis[libraryChannelKey];
    if (shared?.endpoint === endpoint) return shared.channel;
    shared?.channel.close();
    const channel = new BroadcastChannel(`comfyui.prompt-palette.library:${endpoint}`);
    channel.addEventListener("message", event => {
      if (event.data?.type !== "library-changed" || event.data.version !== 1) return;
      globalThis[previewRevisionKey] += 1;
      // Receiving a change must never publish it again: no echo between tabs.
      libraryEvents.dispatchEvent(new CustomEvent("change", { detail: { ok: true, remote: true } }));
    });
    globalThis[libraryChannelKey] = { endpoint, channel };
    return channel;
  } catch {
    // Browser policy may disable channels. Same-tab notifications still work.
    return null;
  }
}

function publishLibraryChange(result) {
  if (result && !result.error && result.ok !== false) {
    globalThis[previewRevisionKey] += 1;
    libraryEvents.dispatchEvent(new CustomEvent("change", { detail: result }));
    try { getLibraryChannel()?.postMessage({ type: "library-changed", version: 1 }); }
    catch { /* A channel failure must not turn a successful server write into an error. */ }
  }
  return result;
}

const metadataEventsKey = Symbol.for("comfyui.prompt-palette.metadata-events.v1");
const metadataEvents = globalThis[metadataEventsKey] ||= new EventTarget();
const metadataChannelKey = Symbol.for("comfyui.prompt-palette.metadata-channel.v1");

function getMetadataChannel() {
  if (typeof globalThis.BroadcastChannel !== "function" || !globalThis.location?.href) return null;
  try {
    const endpoint = new URL(promptPaletteUrl("/prompt_palette/list"), globalThis.location.href).href;
    const shared = globalThis[metadataChannelKey];
    if (shared?.endpoint === endpoint) return shared.channel;
    shared?.channel.close();
    const channel = new BroadcastChannel(`comfyui.prompt-palette.metadata:${endpoint}`);
    channel.addEventListener("message", event => {
      if (event.data?.type !== "metadata-changed" || event.data.version !== 1) return;
      if (event.data.action === "thumbnail") globalThis[previewRevisionKey] += 1;
      metadataEvents.dispatchEvent(new CustomEvent("change", { detail: { ...event.data, remote: true } }));
    });
    globalThis[metadataChannelKey] = { endpoint, channel };
    return channel;
  } catch {
    return null;
  }
}

function publishMetadataChange(detail = {}) {
  const payload = { type: "metadata-changed", version: 1, timestamp: Date.now(), ...detail };
  metadataEvents.dispatchEvent(new CustomEvent("change", { detail: payload }));
  try { getMetadataChannel()?.postMessage(payload); }
  catch { /* A channel failure must not turn a successful write into an error. */ }
  return payload;
}

function promptPaletteUrl(path) {
  return typeof api.apiURL === "function" ? api.apiURL(path) : path;
}

async function fetchApiResult(path, options) {
  try {
    return await readApiJson(await api.fetchApi(path, options));
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}

let booruTagsAbort = null;
let animaTagsAbort = null;

const API = {
  async loras({ signal, refresh = false } = {}) {
    const url = refresh === true ? "/prompt_palette/loras?refresh=1" : "/prompt_palette/loras";
    return readApiJson(await api.fetchApi(url, { signal }));
  },
  loraPreviewUrl(name, { source = "auto", index = 0, poster = false, v = null } = {}) {
    const rev = v ?? API.previewRevision();
    return promptPaletteUrl(`/prompt_palette/lora_preview?name=${encodeURIComponent(name)}&source=${encodeURIComponent(source)}&index=${encodeURIComponent(index)}${poster ? "&poster=1" : ""}&v=${encodeURIComponent(rev)}`);
  },
  async loraPreviewProbe(name, { signal } = {}) {
    const response = await api.fetchApi(`/prompt_palette/lora_preview?name=${encodeURIComponent(name)}`, { method: "HEAD", signal });
    if (response.status === 404) return { has_preview: false };
    if (!response.ok) throw new Error(`Preview request failed (${response.status}). Restart ComfyUI after updating.`);
    return { has_preview: true, preview_type: response.headers.get("Content-Type")?.startsWith("video/") ? "video" : "image",
      custom_preview: response.headers.get("X-PP-Preview-Source") === "custom",
      preview_options: (response.headers.get("X-PP-Preview-Types") || "").split(",").filter(type => type === "image" || type === "video").map((type, index) => ({ type, index })) };
  },
  async loraPreviewBlob(name, { signal } = {}) {
    // fetchApi carries the active comfy-user header; <img src> cannot do so.
    const response = await api.fetchApi(`/prompt_palette/lora_preview?name=${encodeURIComponent(name)}&source=custom`, { signal });
    if (!response.ok) throw new Error(`Custom thumbnail request failed (${response.status})`);
    return response.blob();
  },
  async setLoraThumbnail(name, file) {
    const form = new FormData();
    form.append("name", name); form.append("file", file);
    const result = await readApiJson(await api.fetchApi("/prompt_palette/lora_thumbnail", { method: "POST", body: form }));
    if (result && !result.error && result.ok !== false) {
      API.bumpPreviewRevision();
      publishMetadataChange({ namespace: "loras", action: "thumbnail", name });
    }
    return result;
  },
  async removeLoraThumbnail(name) {
    const result = await readApiJson(await api.fetchApi("/prompt_palette/remove_lora_thumbnail", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }),
    }));
    if (result && !result.error && result.ok !== false) {
      API.bumpPreviewRevision();
      publishMetadataChange({ namespace: "loras", action: "thumbnail", name });
    }
    return result;
  },
  async loraInfo(name, { signal } = {}) {
    return readApiJson(await api.fetchApi(`/prompt_palette/lora_info?name=${encodeURIComponent(name)}`, { signal }));
  },
  async loraBatchInfo(names, { signal } = {}) {
    return readApiJson(await api.fetchApi("/prompt_palette/lora_batch_info", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ names }), signal,
    }));
  },

  previewRevision() { return globalThis[previewRevisionKey]; },
  bumpPreviewRevision() {
    globalThis[previewRevisionKey] += 1;
    return globalThis[previewRevisionKey];
  },
  async completionPreviews(items) {
    return readApiJson(await api.fetchApi("/prompt_palette/completion_previews", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items }),
    }));
  },
  async styleIndexes(index = "") {
    return readApiJson(await api.fetchApi(`/prompt_palette/styles?index=${encodeURIComponent(index)}`));
  },
  async importStyleIndex(index) {
    return readApiJson(await api.fetchApi("/prompt_palette/styles", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ index }) }));
  },
  async styleAnnotations(index) {
    return readApiJson(await api.fetchApi(`/prompt_palette/style_annotations?index=${encodeURIComponent(index)}`));
  },
  async saveStyleAnnotation(data) {
    return publishLibraryChange(await readApiJson(await api.fetchApi("/prompt_palette/style_annotations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) })));
  },
  onLibraryChanged(listener) {
    const handle = event => {
      try {
        Promise.resolve(listener(event.detail)).catch(error => console.error("Prompt Palette: library synchronization failed", error));
      } catch (error) { console.error("Prompt Palette: library synchronization failed", error); }
    };
    libraryEvents.addEventListener("change", handle);
    getLibraryChannel();
    return () => libraryEvents.removeEventListener("change", handle);
  },
  thumbnailUrl(file, suffix = "") {
    return promptPaletteUrl(`/prompt_palette/thumb?file=${encodeURIComponent(file)}&ppv=${API.previewRevision()}${suffix}`);
  },
  async list() {
    return (await readApiJson(await api.fetchApi("/prompt_palette/list"))).items || [];
  },
  async categories() {
    return await readApiJson(await api.fetchApi("/prompt_palette/categories"));
  },
  async search(q) {
    return (await readApiJson(await api.fetchApi(`/prompt_palette/search?q=${encodeURIComponent(q)}`))).items || [];
  },
  async animaArtists(q = "") {
    animaTagsAbort?.abort();
    const controller = new AbortController(); animaTagsAbort = controller;
    try {
      return (await readApiJson(await api.fetchApi(`/prompt_palette/anima_artists?q=${encodeURIComponent(q)}`, { signal: controller.signal }))).items || [];
    } finally { if (animaTagsAbort === controller) animaTagsAbort = null; }
  },
  async booruTags(q, category = "") {
    // Latest query wins: a keystroke supersedes the previous lookup instead of queueing behind it,
    // so fast typing can never pile requests up against the browser's per-host connection limit.
    booruTagsAbort?.abort();
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    booruTagsAbort = controller;
    try {
      const response = await api.fetchApi(`/prompt_palette/booru_tags?q=${encodeURIComponent(q)}${category ? `&category=${encodeURIComponent(category)}` : ""}`, controller ? { signal: controller.signal } : undefined);
      return (await readApiJson(response)).items || [];
    } finally {
      if (booruTagsAbort === controller) booruTagsAbort = null;
    }
  },
  async booruLookup(tags) {
    const result = await fetchApiResult("/prompt_palette/booru_lookup", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tags }),
    });
    if (!result || result.error) throw new Error(result?.error || "booru lookup failed");
    return result.categories && typeof result.categories === "object" ? result.categories : {};
  },
  async customWords() {
    return String((await readApiJson(await api.fetchApi("/prompt_palette/custom_words"))).text || "");
  },
  async importImagePrompts(file, { signal } = {}) {
    const form = new FormData();
    form.append("file", file, file.name);
    return await readApiJson(await api.fetchApi("/prompt_palette/import_image_prompts", { method: "POST", body: form, ...(signal ? { signal } : {}) }));
  },
  async addCustomWord(word, trigger = "", category = "") {
    return await fetchApiResult("/prompt_palette/custom_words/add", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ word, trigger, category }),
    });
  },
  async customWordRows() {
    return await fetchApiResult("/prompt_palette/custom_words/manage");
  },
  async removeCustomWords(ids) {
    return await fetchApiResult("/prompt_palette/custom_words/remove", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    });
  },
  async importCustomWords(text, mode = "merge") {
    return await fetchApiResult("/prompt_palette/custom_words/import", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, mode }),
    });
  },
  async alternatives(name) {
    return await readApiJson(await api.fetchApi(`/prompt_palette/alternatives?name=${encodeURIComponent(name)}`));
  },
  async preview(name) {
    return await readApiJson(await api.fetchApi(`/prompt_palette/preview?name=${encodeURIComponent(name)}`));
  },
  async content(name, { fresh = false } = {}) {
    return await readApiJson(
      await api.fetchApi(`/prompt_palette/content?name=${encodeURIComponent(name)}${fresh ? "&fresh=1" : ""}`),
      { allowNotFound: true },
    );
  },
  async save(name, content) {
    return publishLibraryChange(await fetchApiResult("/prompt_palette/save", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, content }),
    }));
  },
  async del(name) {
    return publishLibraryChange(await fetchApiResult("/prompt_palette/delete", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    }));
  },
  async setThumbnail(name, file) {
    const form = new FormData();
    form.append("name", name);
    form.append("file", file, file.name);
    return publishLibraryChange(await fetchApiResult("/prompt_palette/set_thumbnail", { method: "POST", body: form }));
  },
  async removeThumbnail(name) {
    return publishLibraryChange(await fetchApiResult("/prompt_palette/remove_thumbnail", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    }));
  },
  async resolve(text, seed, mode, { signal, positiveAntonyms = false, resolve = true, workspaceRuntime = "", varsIn = "" } = {}) {
    let runtimePayload = null;
    if (resolve && workspaceRuntime) {
      const runtime = typeof workspaceRuntime === "string" ? JSON.parse(workspaceRuntime) : workspaceRuntime;
      if (runtime && runtime.positive === text) runtimePayload = runtime;
    }
    const body = { text, seed, mode, positive_antonyms: positiveAntonyms, resolve, vars_in: varsIn };
    if (runtimePayload) body.workspace_runtime = runtimePayload;
    const data = await readApiJson(await api.fetchApi("/prompt_palette/resolve", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    }));
    return {
      resolved: data.resolved || "",
      tokenStats: data.token_stats || null,
      variables: data.variables || {},
      branchSelections: Array.isArray(data.branch_selections) ? data.branch_selections : [],
      embeddings: Array.isArray(data.embeddings) ? data.embeddings : [],
      missingLoras: Array.isArray(data.missing_loras) ? data.missing_loras : [],
      duplicates: Array.isArray(data.duplicates) ? data.duplicates : [],
    };
  },
  async diagnostics(text, { negativeText = "", targetProfile = "", signal } = {}) {
    return await readApiJson(await api.fetchApi("/prompt_palette/diagnostics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, negative_text: negativeText, target_profile: targetProfile }),
      ...(signal ? { signal } : {}),
    }));
  },
  async inspect(text, seed, mode, { signal, resolve = true, targetProfile = "", fields = null } = {}) {
    const body = { text, seed, mode, resolve };
    if (targetProfile) body.target_profile = targetProfile;
    if (Array.isArray(fields) && fields.length) body.fields = fields;
    return await readApiJson(await api.fetchApi("/prompt_palette/inspect", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body), ...(signal ? { signal } : {}),
    }));
  },
  async captureSelection(text, start, end, seed, mode, { signal } = {}) {
    return await readApiJson(await api.fetchApi("/prompt_palette/capture_selection", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, start, end, seed, mode }), ...(signal ? { signal } : {}),
    }));
  },
  async resolveWorkspace(runtime, seed, mode, count = 1, { signal } = {}) {
    return readApiJson(await api.fetchApi("/prompt_palette/resolve_workspace", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runtime, seed, mode, count }),
      ...(signal ? { signal } : {}),
    }));
  },
  async resolveVariations(text, seed, mode, count = 4, { signal } = {}) {
    const data = await readApiJson(await api.fetchApi("/prompt_palette/resolve_variations", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, seed, mode, count }),
      ...(signal ? { signal } : {}),
    }));
    return Array.isArray(data.variations) ? data.variations : [];
  },
  async libraryHealth({ signal } = {}) {
    return await readApiJson(await api.fetchApi("/prompt_palette/library_health", signal ? { signal } : undefined));
  },
  async libraryAction(action, source = "", target = "") {
    const res = await fetchApiResult("/prompt_palette/library_action", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, source, target }),
    });
    if (res.ok && action === "rename") {
      publishMetadataChange({ namespace: "all", action: "relink", source, target });
    }
    return publishLibraryChange(res);
  },
  async libraryBatch(action, sources = [], destination = "") {
    const res = await fetchApiResult("/prompt_palette/library_batch", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, sources, destination }),
    });
    if (res.ok && action !== "copy_to_folder") {
      publishMetadataChange({ namespace: "all", action: "relink", sources, destination });
    }
    return publishLibraryChange(res);
  },
  publishMetadataChange(detail = {}) {
    return publishMetadataChange(detail);
  },
  onMetadataChange(fn) {
    const handler = event => fn(event.detail);
    metadataEvents.addEventListener("change", handler);
    getMetadataChannel();
    return () => metadataEvents.removeEventListener("change", handler);
  },
  async relinkMetadata(source, target) {
    const result = await fetchApiResult("/zf-prompt-palette/api/v1/library/relink", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source, target }),
    });
    if (result.ok) {
      publishMetadataChange({ namespace: "all", action: "relink", source, target });
    }
    return result;
  },
  async refreshWildcards() {
    return publishLibraryChange(await readApiJson(await api.fetchApi("/prompt_palette/refresh", { method: "POST" })));
  },
  async setPath(path) {
    return publishLibraryChange(await fetchApiResult("/prompt_palette/set_path", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    }));
  },
  async countCombinatorial(text, seed, maxPrompts, { signal, workspaceRuntime = "" } = {}) {
    let runtimePayload = null;
    if (workspaceRuntime) {
      try {
        const runtime = typeof workspaceRuntime === "string" ? JSON.parse(workspaceRuntime) : workspaceRuntime;
        if (runtime && runtime.positive === text) runtimePayload = runtime;
      } catch {}
    }
    const body = { text, seed, max_prompts: maxPrompts };
    if (runtimePayload) body.workspace_runtime = runtimePayload;
    const data = await readApiJson(await api.fetchApi("/prompt_palette/count_combinatorial", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    }));
    return { count: data.count || 0, truncated: !!data.truncated, cap: data.cap || 5000 };
  },
  async evalInput({ prompt, targetNode, outputIndex = 0, signal } = {}) {
    return readApiJson(await api.fetchApi("/prompt_palette/eval_input", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, target_node: String(targetNode ?? ""), output_index: Number(outputIndex) || 0 }),
      ...(signal ? { signal } : {}),
    }));
  },
};

API.resolveVariations.workspace = API.resolveWorkspace;

export { API };
