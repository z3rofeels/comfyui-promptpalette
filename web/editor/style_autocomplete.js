import { loadTheme } from "./preferences.js";
import { createPromptUsageStore } from "../prompt_quickness.js";
import { loadStyleCatalog, getStyleCatalogSync, resolveStyleModelTarget, scoreAndFilterStyles } from "./style_catalog.js";
import { formatStyleEntry, scanPromptForStyles } from "./style_prompt_engine.js";

export const STYLE_FACET_COLORS = Object.freeze({
  style: "#bb8ee8",
  medium: "#d49a52",
  camera: "#75b7e8",
  lens: "#5cc6d0",
  angle: "#6fc3df",
  framing: "#82c6a2",
  pose: "#79b98b",
  expression: "#a2d478",
  lighting: "#eab965",
  atmosphere: "#8fa8e8",
  composition: "#e2829c",
  syntax: "#5fb49c",
});

export const STYLE_FACET_SHORT = Object.freeze({
  style: "Style",
  medium: "Medium",
  camera: "Camera",
  lens: "Lens",
  angle: "Angle",
  framing: "Framing",
  pose: "Pose",
  expression: "Expr",
  lighting: "Light",
  atmosphere: "Atmo",
  composition: "Comp",
  syntax: "Syntax",
});

const PREFIX_MAP = Object.freeze({
  style: { facet: "style" },
  styles: { facet: "all" },
  st: { facet: "all" },
  medium: { facet: "medium" },
  med: { facet: "medium" },
  cam: { facet: "camera" },
  camera: { facet: "camera" },
  lens: { facet: "lens" },
  angle: { facet: "angle" },
  framing: { facet: "framing" },
  frame: { facet: "framing" },
  pose: { facet: "pose" },
  expr: { facet: "expression" },
  expression: { facet: "expression" },
  light: { facet: "lighting" },
  lighting: { facet: "lighting" },
  atmo: { facet: "atmosphere" },
  atmosphere: { facet: "atmosphere" },
  comp: { facet: "composition" },
  composition: { facet: "composition" },
  syntax: { facet: "syntax" },
  krea: { model: "krea2" },
  krea2: { model: "krea2" },
  moss: { model: "moss" },
});

let styleUsageStore = null;
function usage() {
  if (!styleUsageStore) styleUsageStore = createPromptUsageStore();
  return styleUsageStore;
}

export function styleAutocompleteSettings() {
  const theme = loadTheme();
  let enabled = theme.styleAutocompleteEnabled === true;
  let mode = ["auto", "onDemand", "off"].includes(theme.styleAutocompleteMode)
    ? theme.styleAutocompleteMode
    : (enabled ? "auto" : "off");
  if (!enabled) mode = "off";
  if (mode === "off") enabled = false;
  return {
    enabled,
    mode,
    minChars: 2,
    modelFilter: ["auto", "both", "krea2", "moss"].includes(theme.styleModelFilter) ? theme.styleModelFilter : "auto",
    mossDialect: ["caption", "tags", "layout"].includes(theme.styleMossDialect) ? theme.styleMossDialect : "caption",
  };
}

export function parseStyleAutocompleteQuery(rawQuery) {
  const raw = String(rawQuery || "").trim();
  const match = raw.match(/^([a-z0-9]+):(.*)$/i);
  if (match) {
    const spec = PREFIX_MAP[match[1].toLowerCase()];
    if (spec) {
      return {
        explicit: true,
        facet: spec.facet || "all",
        model: spec.model || "",
        query: match[2].trim(),
      };
    }
  }
  return { explicit: false, facet: "all", model: "", query: raw };
}

export function shouldOpenStyleAutocomplete(fragment, { onDemand = false } = {}) {
  if (!fragment || fragment.kind !== "booru") return false;
  const settings = styleAutocompleteSettings();
  if (!settings.enabled || settings.mode === "off") return false;
  if (settings.mode === "onDemand" && !onDemand) return false;
  const parsed = parseStyleAutocompleteQuery(fragment.query);
  if (parsed.explicit) return true;
  return parsed.query.length >= settings.minChars;
}

export function preloadStyleAutocompleteCatalog() {
  if (!styleAutocompleteSettings().enabled) return;
  loadStyleCatalog().catch(() => {});
}

export async function getStyleAutocompleteMatches(query, { textarea = null, activeNode = null, limit = 18 } = {}) {
  const settings = styleAutocompleteSettings();
  if (!settings.enabled) return [];

  const parsed = parseStyleAutocompleteQuery(query);
  if (!parsed.explicit && parsed.query.length < settings.minChars) return [];

  let catalog = getStyleCatalogSync();
  if (!catalog) {
    try {
      catalog = await loadStyleCatalog();
    } catch {
      return [];
    }
  }
  const allEntries = Array.isArray(catalog?.styles) ? catalog.styles : [];
  if (!allEntries.length) return [];

  const resolvedTarget = resolveStyleModelTarget(activeNode, settings.modelFilter);
  const modelForFilter = parsed.model || (settings.modelFilter === "both" ? "both" : resolvedTarget.model);
  const formatModel = parsed.model || (resolvedTarget.model === "moss" ? "moss" : "krea2");

  const store = usage();
  const favoriteIds = new Set(store.styleFavoriteIds?.() || []);
  const recentIds = store.styleRecentIds?.(12) || [];

  const matches = scoreAndFilterStyles({
    query: parsed.query,
    facet: parsed.facet,
    model: modelForFilter,
    favoriteIds,
    recentIds,
    limit,
  });
  if (!matches.length) return [];

  // Single O(prompt) scan for conflict detection across matches.
  const promptText = String(textarea?.value || "");
  const activeHits = promptText ? scanPromptForStyles(promptText, allEntries) : [];
  const activeConflictGroups = new Map();
  for (const hit of activeHits) {
    const cg = String(hit.entry?.conflictGroup || "").trim();
    if (cg) activeConflictGroups.set(cg, hit.entry);
  }

  const recentSet = new Set(recentIds);
  const weightSurface = textarea?.closest?.(".ppwc-surface");
  const weightMode = weightSurface?.querySelector?.('[data-el="modeSelect"], select')?.value || "";

  return matches.map((entry, idx) => {
    const phrase = formatStyleEntry(entry, {
      model: entry.model === "moss" ? "moss" : entry.model === "krea2" ? "krea2" : formatModel,
      mossDialect: settings.mossDialect,
      weightMode,
    });
    const cg = String(entry.conflictGroup || "").trim();
    const conflictTarget = cg ? activeConflictGroups.get(cg) : null;
    const conflict = !!conflictTarget && conflictTarget.id !== entry.id;
    const modelBadge = entry.model === "both" ? "KREA2+MOSS" : entry.model === "moss" ? "MOSS" : "KREA2";
    const facetShort = STYLE_FACET_SHORT[entry.facet] || entry.facet || "Style";
    const snippet = phrase.length > 76 ? `${phrase.slice(0, 75)}…` : phrase;
    const favorite = favoriteIds.has(entry.id);
    const recent = recentSet.has(entry.id);

    return {
      kind: "style",
      value: entry.id,
      label: entry.name,
      group: favorite ? "Favorite Styles" : "Krea 2 & MOSS Styles",
      section: favorite ? "Favorite Styles" : "Krea 2 & MOSS Styles",
      category: entry.facet || "style",
      facet: entry.facet || "style",
      facetLabel: facetShort,
      modelBadge,
      meta: conflict
        ? `⚠ Conflicts with ${conflictTarget.name} · ${snippet}`
        : `${facetShort} · ${snippet}`,
      alias: modelBadge,
      insertMode: "plain",
      insertText: phrase,
      swatch: STYLE_FACET_COLORS[entry.facet] || "#d49a52",
      favorite,
      recent,
      conflict,
      conflictReason: conflict ? (entry.conflictReason || `Conflicts with ${conflictTarget.name}`) : "",
      priority: favorite ? 3 : Math.max(0, 2 - Math.floor(idx / 6)),
      styleId: entry.id,
      negativeHint: entry.model === "moss" ? "worst quality, bad anatomy, watermark, jpeg artifact" : "",
    };
  });
}
