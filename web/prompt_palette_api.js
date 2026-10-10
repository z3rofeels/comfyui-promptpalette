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
    libraryEvents.dispatchEvent(new CustomEvent("change", { detail: result }));
    try { getLibraryChannel()?.postMessage({ type: "library-changed", version: 1 }); }
    catch { /* A channel failure must not turn a successful server write into an error. */ }
  }
  return result;
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

const API = {
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
    return promptPaletteUrl(`/prompt_palette/thumb?file=${encodeURIComponent(file)}${suffix}`);
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
    return await fetchApiResult("/prompt_palette/set_thumbnail", { method: "POST", body: form });
  },
  async removeThumbnail(name) {
    return await fetchApiResult("/prompt_palette/remove_thumbnail", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
  },
  async resolve(text, seed, mode, { signal } = {}) {
    const data = await readApiJson(await api.fetchApi("/prompt_palette/resolve", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, seed, mode }),
      ...(signal ? { signal } : {}),
    }));
    return { resolved: data.resolved || "", tokenStats: data.token_stats || null };
  },
  async inspect(text, seed, mode, { signal, resolve = true } = {}) {
    return await readApiJson(await api.fetchApi("/prompt_palette/inspect", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, seed, mode, resolve }), ...(signal ? { signal } : {}),
    }));
  },
  async captureSelection(text, start, end, seed, mode, { signal } = {}) {
    return await readApiJson(await api.fetchApi("/prompt_palette/capture_selection", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, start, end, seed, mode }), ...(signal ? { signal } : {}),
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
    return publishLibraryChange(await fetchApiResult("/prompt_palette/library_action", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, source, target }),
    }));
  },
  async libraryBatch(action, sources = [], destination = "") {
    return publishLibraryChange(await fetchApiResult("/prompt_palette/library_batch", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, sources, destination }),
    }));
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
  async countCombinatorial(text, seed, maxPrompts, { signal } = {}) {
    const data = await readApiJson(await api.fetchApi("/prompt_palette/count_combinatorial", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, seed, max_prompts: maxPrompts }),
      ...(signal ? { signal } : {}),
    }));
    return { count: data.count || 0, truncated: !!data.truncated, cap: data.cap || 5000 };
  },
};

export { API };
