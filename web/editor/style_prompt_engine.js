import { escapeHtml } from "./text_utils.js";

export const MOSS_TAG_TIER_ORDER = Object.freeze([
  "quality",
  "score",
  "meta",
  "year",
  "character",
  "series",
  "artist",
  "general",
  "rating",
]);

const SUBJECT_FIRST_ORDER = Object.freeze([
  "subject",
  "pose",
  "expression",
  "framing",
  "composition",
  "camera",
  "lens",
  "angle",
  "lighting",
  "atmosphere",
  "medium",
  "style",
  "typography",
  "prefix",
]);

const SCENE_FIRST_ORDER = Object.freeze([
  "medium",
  "style",
  "framing",
  "composition",
  "angle",
  "camera",
  "lens",
  "subject",
  "pose",
  "expression",
  "lighting",
  "atmosphere",
  "typography",
  "prefix",
]);

const KREA2_BUZZWORD_RE = /\b(masterpiece|best quality|high quality|ultra[- ]?detailed|ultra[- ]?realistic|8k uhd|8k|4k uhd|absurdres|highres|trending on artstation|score_9|score_8_up|score_7_up)\b/gi;
const WEIGHT_BRACKET_RE = /\(([^():\n]+):([0-9]+(?:\.[0-9]+)?)\)/g;

export function estimateTokensQuick(text) {
  const s = String(text || "").trim();
  if (!s) return 0;
  const words = s.split(/\s+/).filter(Boolean).length;
  const punctuation = (s.match(/[,\.\[\]\{\}":;()]/g) || []).length;
  return Math.max(1, Math.round(words * 1.15 + punctuation * 0.35));
}

export function normalizeQuotedText(raw) {
  const clean = String(raw || "").trim().replace(/^["']+|["']+$/g, "");
  return clean ? `"${clean}"` : "";
}

export function orderMossTags(entries = [], { includeSafeAnchor = true, useSpaces = false } = {}) {
  const buckets = new Map(MOSS_TAG_TIER_ORDER.map((tier) => [tier, []]));
  const seen = new Set();

  const pushTag = (rawTag, tier = "general") => {
    let t = String(rawTag || "").trim();
    if (!t) return;
    if (tier === "artist") {
      t = t.replace(/^(?:artist:|@)+/i, "").replace(/_/g, " ").trim();
      if (!t) return;
      t = `@${t}`;
    } else if (useSpaces && tier !== "score" && !t.startsWith("rating:")) {
      t = t.replace(/_/g, " ");
    }
    const key = t.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    const targetTier = buckets.has(tier) ? tier : "general";
    buckets.get(targetTier).push(t);
  };

  for (const entry of entries) {
    const tags = Array.isArray(entry?.mossTags) ? entry.mossTags : [];
    for (const item of tags) {
      if (typeof item === "string") pushTag(item, "general");
      else if (item && item.tag) pushTag(item.tag, item.tier || "general");
    }
  }

  if (includeSafeAnchor && !buckets.get("rating").length && seen.size > 0) {
    pushTag("rating:general", "rating");
  }

  const orderedItems = [];
  for (const tier of MOSS_TAG_TIER_ORDER) {
    for (const tag of buckets.get(tier)) {
      orderedItems.push({ tag, tier });
    }
  }
  return {
    items: orderedItems,
    text: orderedItems.map((x) => x.tag).join(", "),
  };
}

export function formatStyleEntry(entry, { model = "krea2", mossDialect = "caption", weightMode = "" } = {}) {
  if (!entry) return "";
  const isMoss = model === "moss";

  if (weightMode) {
    const wm = String(weightMode);
    if (wm.includes("Anima")) {
      const artistTag = (entry.mossTags || []).find((t) => (typeof t === "object" ? t.tier === "artist" : false));
      if (artistTag?.tag) {
        const clean = String(artistTag.tag).replace(/^(?:artist:|@)+/i, "").replace(/_/g, " ");
        return `@${clean}`;
      }
    }
  }

  if (isMoss) {
    if (mossDialect === "tags") {
      const { text } = orderMossTags([entry], { includeSafeAnchor: false });
      return text || entry.mossCaption || entry.krea2Phrase || entry.name;
    }
    if (mossDialect === "layout") {
      if (entry.mossLayoutHint && typeof entry.mossLayoutHint === "object") {
        return JSON.stringify(entry.mossLayoutHint, null, 2);
      }
      return entry.mossCaption || entry.krea2Phrase || entry.name;
    }
    return entry.mossCaption || entry.krea2Phrase || orderMossTags([entry], { includeSafeAnchor: false }).text || entry.name;
  }

  return entry.krea2Phrase || entry.mossCaption || entry.name;
}

export function buildMossLayoutDocument(entries = [], { width = 1024, height = 1024, quotedText = "" } = {}) {
  const safeW = Math.max(256, Math.round(Number(width || 1024) / 16) * 16);
  const safeH = Math.max(256, Math.round(Number(height || 1024) / 16) * 16);
  const halfW = Math.floor(safeW / 2);
  const halfH = Math.floor(safeH / 2);

  // Use explicit layout entry if staged, else build a valid 1024-scaled abs_centralized yxyx scaffold.
  const layoutEntries = entries.filter((e) => e?.mossLayoutHint && typeof e.mossLayoutHint === "object");
  const proseParts = [];
  for (const e of entries) {
    if (!e?.mossLayoutHint && e?.mossCaption) proseParts.push(e.mossCaption);
  }
  const summaryCaption = proseParts.length
    ? proseParts.join(", ")
    : (layoutEntries[0]?.mossLayoutHint?.caption || "A balanced high-craft studio composition with crisp spatial placement and clear hierarchy.");

  const items = [];
  const headline = String(quotedText || "").trim();
  const titleOffsetTop = -Math.round(halfH * 0.84);
  const titleOffsetBottom = -Math.round(halfH * 0.50);
  const subjectTop = headline ? -Math.round(halfH * 0.40) : -Math.round(halfH * 0.68);
  const subjectBottom = Math.round(halfH * 0.72);
  const spanX = Math.round(halfW * 0.78);

  if (headline) {
    items.push({
      label: "text",
      caption: "Crisp editorial headline typography centered near the upper canvas margin.",
      text: headline.replace(/\\n/g, "\n"),
      bbox: [titleOffsetTop, -spanX, titleOffsetBottom, spanX],
    });
  }

  const subjectDesc = entries
    .filter((e) => !e?.mossLayoutHint && ["pose", "expression", "style", "medium", "subject"].includes(e?.facet))
    .map((e) => e.mossCaption)
    .filter(Boolean)
    .join(", ");

  items.push({
    label: "object",
    caption: subjectDesc || layoutEntries[0]?.mossLayoutHint?.objectCaption || "Primary focal subject cleanly lit and framed within the central region.",
    bbox: [subjectTop, -Math.round(halfW * 0.66), subjectBottom, Math.round(halfW * 0.66)],
  });

  for (const le of layoutEntries) {
    const hint = le.mossLayoutHint;
    if (Array.isArray(hint.items)) {
      for (const it of hint.items) {
        if (items.length < 6) items.push(it);
      }
    }
  }

  return {
    summary: {
      meta: [entries.some((e) => e?.facet === "style" && /poster|graphic/i.test(e?.name || "")) ? "poster" : "composition"],
      canvas: "single",
      caption: summaryCaption,
    },
    items,
    bbox_coord_space: "abs_centralized",
    bbox_format: "yxyx",
  };
}

export function composeStyleMix(entries = [], {
  model = "krea2",
  mossDialect = "caption",
  focusOrder = "subject",
  quotedText = "",
  combinatorial = false,
  includeSafeAnchor = true,
  canvasWidth = 1024,
  canvasHeight = 1024,
} = {}) {
  const list = Array.isArray(entries) ? entries.filter(Boolean) : [];
  if (!list.length && !String(quotedText || "").trim()) {
    return { text: "", orderedTags: [], dialect: model === "moss" ? mossDialect : "prose" };
  }

  if (combinatorial && list.length >= 2) {
    const formatted = [...new Set(list.map((e) => formatStyleEntry(e, { model, mossDialect })).filter(Boolean))];
    return {
      text: formatted.length >= 2 ? `{%${formatted.join("|")}}` : (formatted[0] || ""),
      orderedTags: [],
      dialect: "combinatorial",
    };
  }

  if (model === "moss" && mossDialect === "tags") {
    const ordered = orderMossTags(list, { includeSafeAnchor });
    const q = normalizeQuotedText(quotedText);
    const final = q ? (ordered.text ? `${ordered.text}, text ${q}` : `text ${q}`) : ordered.text;
    return {
      text: final,
      orderedTags: ordered.items,
      dialect: "tags",
    };
  }

  if (model === "moss" && mossDialect === "layout") {
    const doc = buildMossLayoutDocument(list, { width: canvasWidth, height: canvasHeight, quotedText });
    return {
      text: JSON.stringify(doc, null, 2),
      orderedTags: [],
      dialect: "layout",
    };
  }

  const orderList = focusOrder === "scene" ? SCENE_FIRST_ORDER : SUBJECT_FIRST_ORDER;
  const sorted = [...list].sort((a, b) => {
    const ai = orderList.indexOf(a.promptPlacement || a.facet || "style");
    const bi = orderList.indexOf(b.promptPlacement || b.facet || "style");
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });

  const parts = [];
  const seen = new Set();
  for (const entry of sorted) {
    const phrase = String(formatStyleEntry(entry, { model, mossDialect: "caption" }) || "").trim();
    if (!phrase) continue;
    const key = phrase.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(phrase.replace(/[.\s]+$/, ""));
  }

  const quoted = String(quotedText || "").trim();
  if (quoted) {
    const cleanQ = quoted.replace(/^["']+|["']+$/g, "");
    parts.push(`visible lettering reading "${cleanQ}"`);
  }

  let prose = parts.join(", ");
  if (prose) {
    prose = prose.charAt(0).toUpperCase() + prose.slice(1);
    if (!/[.!?"]$/.test(prose)) prose += ".";
  }

  return {
    text: prose,
    orderedTags: [],
    dialect: model === "moss" ? "caption" : "prose",
  };
}

export function scanPromptForStyles(promptText, catalogEntries = []) {
  const source = String(promptText || "");
  if (!source.trim() || !catalogEntries?.length) return [];
  const lower = source.toLowerCase();
  const hits = [];
  const usedRanges = [];

  // Prefer longer exact matches first so specific sub-phrases win cleanly.
  const candidates = [];
  for (const entry of catalogEntries) {
    const phrases = [entry.krea2Phrase, entry.mossCaption]
      .map((p) => String(p || "").trim())
      .filter((p) => p.length >= 10);
    for (const phrase of [...new Set(phrases)]) {
      candidates.push({ entry, phrase, lowerPhrase: phrase.toLowerCase() });
    }
  }
  candidates.sort((a, b) => b.lowerPhrase.length - a.lowerPhrase.length);

  const overlaps = (start, end) => usedRanges.some(([s, e]) => start < e && end > s);
  const seenEntryIds = new Set();

  for (const cand of candidates) {
    if (seenEntryIds.has(cand.entry.id)) continue;
    const idx = lower.indexOf(cand.lowerPhrase);
    if (idx === -1) continue;
    const end = idx + cand.lowerPhrase.length;
    if (overlaps(idx, end)) continue;
    seenEntryIds.add(cand.entry.id);
    usedRanges.push([idx, end]);
    hits.push({
      entry: cand.entry,
      start: idx,
      end,
      matchedText: source.slice(idx, end),
    });
  }

  hits.sort((a, b) => a.start - b.start);
  return hits;
}

export function removeStyleSpan(promptText, start, end) {
  const text = String(promptText || "");
  const s = Math.max(0, Math.min(text.length, Number(start) || 0));
  const e = Math.max(s, Math.min(text.length, Number(end) || 0));
  if (s === e) return text;
  let before = text.slice(0, s);
  let after = text.slice(e);
  before = before.replace(/[\s,;]+$/, "");
  after = after.replace(/^[\s,;]+/, "");
  if (!before && !after) return "";
  if (!before) return after.replace(/^[.\s]+/, "");
  if (!after) return before;
  return `${before}, ${after}`;
}

export function cleanPromptForKrea2(promptText) {
  let out = String(promptText || "");
  out = out.replace(WEIGHT_BRACKET_RE, (_, inner) => inner.trim());
  out = out.replace(KREA2_BUZZWORD_RE, "");
  out = out
    .replace(/\s*,\s*,+/g, ", ")
    .replace(/^[\s,]+|[\s,]+$/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.;!?])/g, "$1");
  return out;
}

export function detectStyleConflicts({ stagedEntries = [], activeHits = [], promptText = "", model = "krea2", mossDialect = "caption" } = {}) {
  const warnings = [];
  const combined = [...stagedEntries, ...activeHits.map((h) => h.entry)].filter(Boolean);
  const byGroup = new Map();

  for (const entry of combined) {
    const g = String(entry?.conflictGroup || "").trim();
    if (!g) continue;
    if (!byGroup.has(g)) byGroup.set(g, new Map());
    byGroup.get(g).set(entry.id, entry);
  }

  for (const [group, entryMap] of byGroup.entries()) {
    if (entryMap.size < 2) continue;
    const list = [...entryMap.values()];
    warnings.push({
      kind: "conflict",
      severity: "warn",
      group,
      entries: list,
      title: `Conflicting ${group.replace(/_/g, " ")}: ${list.map((e) => e.name).join(" vs ")}`,
      detail: list[0]?.conflictReason || "Competing directions in this group fight the model's spatial attention.",
    });
  }

  const text = String(promptText || "");
  if (model === "krea2" && text.trim()) {
    WEIGHT_BRACKET_RE.lastIndex = 0;
    const hasWeights = WEIGHT_BRACKET_RE.test(text);
    KREA2_BUZZWORD_RE.lastIndex = 0;
    const hasBuzz = KREA2_BUZZWORD_RE.test(text);
    if (hasWeights || hasBuzz) {
      warnings.push({
        kind: "krea2-lint",
        severity: "warn",
        fixable: true,
        title: hasWeights && hasBuzz
          ? "Krea 2 grammar: numerical weights & buzzwords detected"
          : hasWeights
          ? "Krea 2 grammar: (weight:1.x) brackets read literally by Qwen3-VL"
          : "Krea 2 grammar: legacy buzzwords (8k / masterpiece) add noise",
        detail: "Krea 2 docs recommend flowing descriptive prose without SD/SDXL weights or CLIP quality tags.",
      });
    }
  }

  if (model === "moss" && mossDialect === "layout" && text.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(text);
      if (parsed?.bbox_coord_space && parsed.bbox_coord_space !== "abs_centralized") {
        warnings.push({
          kind: "moss-layout",
          severity: "warn",
          title: `MOSS Layout: coord space '${parsed.bbox_coord_space}' instead of 'abs_centralized'`,
          detail: "ComfyUI MOSS SFT expects compiled abs_centralized yxyx boxes centered around (0,0).",
        });
      }
    } catch {
      warnings.push({
        kind: "moss-layout-json",
        severity: "warn",
        title: "MOSS Layout: active editor text is not valid JSON yet",
        detail: "Use 'Apply to Editor' or validate brackets before queueing a Spatial JSON Layout workflow.",
      });
    }
  }

  return warnings;
}

export function buildStyleSpecimenSvg(entry) {
  const facet = String(entry?.facet || "style").toLowerCase();
  const colors = Array.isArray(entry?.specimen?.colors) && entry.specimen.colors.length
    ? entry.specimen.colors
    : Array.isArray(entry?.specimen?.palette) && entry.specimen.palette.length
    ? entry.specimen.palette
    : ["#d49a52", "#75b7e8"];
  const c1 = escapeHtml(colors[0] || "#d49a52");
  const c2 = escapeHtml(colors[1] || "#75b7e8");
  const badge = escapeHtml(String(entry?.specimen?.badge || entry?.specimen?.hint || facet.slice(0, 5)).slice(0, 7));

  let shape = "";
  if (facet === "lens" || facet === "camera") {
    const wide = /24mm|fisheye|wide|180/i.test(entry?.name || "");
    const macro = /100mm|macro|90mm|tilt/i.test(entry?.name || "");
    shape = wide
      ? `<polygon points="8,24 44,7 44,41" fill="${c1}" fill-opacity=".22" stroke="${c1}" stroke-width="1.5"/><rect x="4" y="20" width="8" height="8" rx="2" fill="${c2}"/>`
      : macro
      ? `<circle cx="28" cy="24" r="12" fill="none" stroke="${c1}" stroke-width="1.6" stroke-dasharray="3 2"/><circle cx="28" cy="24" r="5" fill="${c2}" fill-opacity=".55" stroke="${c2}" stroke-width="1.2"/>`
      : `<polygon points="8,24 44,14 44,34" fill="${c1}" fill-opacity=".24" stroke="${c1}" stroke-width="1.5"/><circle cx="40" cy="24" r="4" fill="${c2}" fill-opacity=".6"/>`;
  } else if (facet === "angle" || facet === "framing") {
    const dutch = /dutch|tilt/i.test(entry?.name || "");
    const overhead = /overhead|top-down|flat/i.test(entry?.name || "");
    shape = overhead
      ? `<rect x="14" y="10" width="24" height="28" rx="3" fill="none" stroke="${c1}" stroke-width="1.5"/><circle cx="26" cy="24" r="5" fill="${c2}" fill-opacity=".55"/><path d="M26 6v6M26 36v6" stroke="${c1}" stroke-width="1.2"/>`
      : dutch
      ? `<g transform="rotate(-14 26 24)"><rect x="10" y="12" width="32" height="24" rx="2" fill="${c1}" fill-opacity=".14" stroke="${c1}" stroke-width="1.5"/><line x1="12" y1="26" x2="40" y2="26" stroke="${c2}" stroke-width="1.4"/></g>`
      : `<path d="M10 38 L26 12 L42 38 Z" fill="${c1}" fill-opacity=".2" stroke="${c1}" stroke-width="1.5"/><circle cx="26" cy="18" r="3.5" fill="${c2}"/>`;
  } else if (facet === "lighting" || facet === "atmosphere") {
    shape = `<circle cx="14" cy="12" r="5" fill="${c1}"/><path d="M18 15 L44 26 L36 42 L15 20 Z" fill="${c1}" fill-opacity=".22"/><circle cx="32" cy="29" r="7" fill="${c2}" fill-opacity=".42" stroke="${c2}" stroke-width="1.3"/>`;
  } else if (facet === "pose" || facet === "expression") {
    shape = `<circle cx="26" cy="12" r="4.5" fill="${c1}"/><path d="M26 17 L25 29 M17 21 L26 20 L35 24 M25 29 L19 41 M25 29 L33 40" stroke="${c2}" stroke-width="2" stroke-linecap="round" fill="none"/>`;
  } else if (facet === "composition" || facet === "syntax") {
    shape = `<rect x="8" y="8" width="16" height="14" rx="2" fill="${c1}" fill-opacity=".35" stroke="${c1}" stroke-width="1.2"/><rect x="28" y="8" width="16" height="22" rx="2" fill="${c2}" fill-opacity=".28" stroke="${c2}" stroke-width="1.2"/><rect x="8" y="26" width="16" height="14" rx="2" fill="none" stroke="${c1}" stroke-width="1.1" stroke-dasharray="2 2"/>`;
  } else {
    shape = `<rect x="8" y="10" width="36" height="28" rx="4" fill="${c1}" fill-opacity=".2" stroke="${c1}" stroke-width="1.4"/><circle cx="21" cy="24" r="7" fill="${c1}" fill-opacity=".65"/><circle cx="33" cy="24" r="7" fill="${c2}" fill-opacity=".65"/>`;
  }

  return `<svg viewBox="0 0 52 48" width="52" height="48" aria-hidden="true" class="pp-style-specimen-svg">
    ${shape}
    <rect x="3" y="34" width="46" height="12" rx="3" fill="rgba(0,0,0,.46)"/>
    <text x="26" y="42.5" text-anchor="middle" font-size="6.8" font-weight="700" font-family="ui-monospace,monospace" fill="#f1eee8">${badge}</text>
  </svg>`;
}
