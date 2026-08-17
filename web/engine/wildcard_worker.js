import { UnifiedWildcardEngine } from "./wildcard_engine.js";
import { PromptLibraryModel } from "../library/library_model.js";

const engine = new UnifiedWildcardEngine({ lineCacheLimit: 2048 });
const libraryModel = new PromptLibraryModel();
let libraryEntries = [];

self.onmessage = (event) => {
  const { id, type, payload = {} } = event.data || {};
  try {
    if (type === "library") {
      libraryEntries = Array.isArray(payload.items) ? payload.items : [];
      libraryModel.rebuild(libraryEntries);
      return self.postMessage({ id, ok: true, result: libraryModel.stats() });
    }
    if (type === "parse") {
      const parsed = engine.parse(payload.text || "");
      return self.postMessage({ id, ok: true, result: { source: parsed.source, names: parsed.names, wildcards: parsed.wildcards, variables: parsed.variables, ast: parsed.ast, lines: parsed.lines, chars: parsed.chars } });
    }
    if (type === "validate") {
      const parsed = engine.parse(payload.text || "");
      return self.postMessage({ id, ok: true, result: engine.validate(parsed, { libraryEntries, tokenCount: payload.tokenCount }) });
    }
    if (type === "search") {
      const limit = Math.max(1, Number(payload.limit) || 100);
      const pinned = new Set(Array.isArray(payload.pinned) ? payload.pinned : []);
      const recent = Array.isArray(payload.recent) ? payload.recent : [];
      const result = libraryModel.search(payload.query || "", { limit, pinned, recent });
      return self.postMessage({ id, ok: true, result });
    }
    throw new Error(`Unknown worker operation: ${type}`);
  } catch (error) {
    self.postMessage({ id, ok: false, error: String(error?.message || error) });
  }
};
