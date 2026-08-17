export class WildcardWorkerClient {
  constructor({ enabled = true } = {}) {
    this.enabled = !!enabled && typeof Worker !== "undefined";
    this.worker = null;
    this.seq = 0;
    this.pending = new Map();
    this.librarySize = 0;
    this.libraryItems = [];
    this.libraryVersion = 0;
    this.sentLibraryVersion = -1;
    this.librarySync = null;
  }

  ensure() {
    if (!this.enabled) return null;
    if (this.worker) return this.worker;
    try {
      this.worker = new Worker(new URL("./wildcard_worker.js", import.meta.url), { type: "module", name: "Prompt Palette parser" });
      this.worker.onmessage = (event) => {
        const record = this.pending.get(event.data?.id);
        if (!record) return;
        this.pending.delete(event.data.id);
        if (event.data.ok) record.resolve(event.data.result);
        else record.reject(new Error(event.data.error || "Prompt Palette worker failed"));
      };
      this.worker.onerror = () => {
        this.enabled = false;
        for (const record of this.pending.values()) record.reject(new Error("Prompt Palette worker unavailable"));
        this.pending.clear();
        this.worker?.terminate();
        this.worker = null;
        this.librarySync = null;
        this.sentLibraryVersion = -1;
      };
    } catch {
      this.enabled = false;
      this.worker = null;
    }
    return this.worker;
  }

  _post(type, payload = {}) {
    const worker = this.worker;
    if (!worker) return Promise.reject(new Error("Worker unavailable"));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ id, type, payload });
    });
  }

  _syncLibrary() {
    if (!this.worker || this.sentLibraryVersion === this.libraryVersion) return this.librarySync || Promise.resolve(null);
    if (this.librarySync) return this.librarySync;
    this.librarySync = (async () => {
      let result = null;
      while (this.worker && this.sentLibraryVersion !== this.libraryVersion) {
        const version = this.libraryVersion;
        const items = this.libraryItems;
        result = await this._post("library", { items });
        if (this.libraryVersion === version) this.sentLibraryVersion = version;
      }
      return result;
    })().finally(() => { this.librarySync = null; });
    return this.librarySync;
  }

  async request(type, payload = {}) {
    const worker = this.ensure();
    if (!worker) throw new Error("Worker unavailable");
    if (type !== "library") await this._syncLibrary();
    return this._post(type, payload);
  }

  async setLibrary(items) {
    this.libraryItems = Array.isArray(items) ? items : [];
    this.librarySize = this.libraryItems.length;
    this.libraryVersion += 1;
    this.sentLibraryVersion = -1;
    // Library refreshes are state updates, not permission to wake background work.
    // If a Worker is already active, keep its snapshot current. Otherwise defer
    // construction until a visible feature (large-library search or huge prompt)
    // actually needs it.
    if (!this.enabled || !this.worker) return null;
    try { return await this._syncLibrary(); } catch { return null; }
  }

  async prepareLibrarySearch() {
    if (!this.shouldUseForLibrary()) return null;
    if (!this.worker) this.ensure();
    if (!this.worker) return null;
    try { return await this._syncLibrary(); } catch { return null; }
  }

  shouldUseForPrompt(text) { return this.enabled && String(text || "").length >= 24000; }
  shouldUseForLibrary() { return this.enabled && this.librarySize >= 8000; }
  parse(text) { return this.request("parse", { text }); }
  validate(text, tokenCount = null) { return this.request("validate", { text, tokenCount }); }
  search(query, limit = 100, { pinned = null, recent = null } = {}) {
    return this.request("search", { query, limit, pinned: pinned ? Array.from(pinned) : [], recent: Array.isArray(recent) ? recent : [] });
  }
  snapshot() {
    return {
      enabled: this.enabled, active: !!this.worker, pending: this.pending.size, librarySize: this.librarySize,
      libraryVersion: this.libraryVersion, sentLibraryVersion: this.sentLibraryVersion, syncingLibrary: !!this.librarySync,
    };
  }
  cleanup() {
    this.worker?.terminate();
    this.worker = null;
    this.librarySync = null;
    for (const record of this.pending.values()) record.reject(new Error("Worker closed"));
    this.pending.clear();
  }
}
