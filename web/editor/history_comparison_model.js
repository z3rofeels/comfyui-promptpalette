// Read-only projections of existing history records. Never resolve wildcards or
// infer image-specific prompts from participating node context.
export function comparisonSources(record) {
  const sources = [];
  const add = (id, label, text, kind, channel, scope) => {
    if (typeof text === "string") sources.push({ id, label, text, kind, channel, scope });
  };
  if (record?.provenance === "verified") {
    add("verified:positive", "Verified · positive prompt", record.resolved_positive, "resolved", "positive", "verified");
    add("verified:negative", "Verified · negative prompt", record.resolved_negative, "resolved", "negative", "verified");
  }
  for (const [index, context] of (Array.isArray(record?.contexts) ? record.contexts : []).entries()) {
    if (!context || typeof context !== "object") continue;
    const key = `${context.node_id ?? index}:${index}`;
    const name = context.title || `Node #${context.node_id ?? index + 1}`;
    const data = context.refinement?.schema_version === 1 ? context.refinement : {};
    // Channel roles describe conditioning paths, not the channel of stored text.
    // A node's positive text remains positive even on a negative conditioning path.
    add(`${key}:authored:positive`, `${name} · authored positive context`, data.source_text ?? context.authored_positive, "authored", "positive", "context");
    add(`${key}:authored:negative`, `${name} · authored negative context`, data.source_negative_text ?? context.authored_negative, "authored", "negative", "context");
    const verified = !data.batch && record.provenance !== "imported-unlinked" && Array.isArray(data.verified_channels) ? data.verified_channels : [];
    for (const channel of ["positive", "negative"]) {
      const text = data[`${channel}_prompt`] ?? (channel === "positive" ? context.resolved_prompt : null);
      const scope = verified.includes(channel) ? "verified" : "context";
      add(`${key}:resolved:${channel}`, `${name} · ${scope === "verified" ? "verified Palette" : "resolved node context"} · ${channel}${data.batch ? " (batch; image mapping unproven)" : ""}`, text, "resolved", channel, scope);
    }
  }
  return sources;
}

export function matchingComparisonSource(sources, reference) {
  return sources.find(source => source.id === reference?.id && source.kind === reference?.kind && source.channel === reference?.channel && source.scope === reference?.scope)
    || sources.find(source => source.kind === reference?.kind && source.channel === reference?.channel && source.scope === reference?.scope)
    || sources.find(source => source.kind === reference?.kind && source.channel === reference?.channel)
    || sources[0] || null;
}

function append(parts, type, text) {
  if (!text) return;
  if (parts.at(-1)?.type === type) parts.at(-1).text += text;
  else parts.push({ type, text });
}

// Exact reconstruction is preserved even when large, unrelated passages need a
// coarse replacement. The DP budget bounds work on the editor's main thread.
export function diffPromptText(before, after, maxCells = 250000) {
  before = String(before ?? ""); after = String(after ?? "");
  if (before === after) return { parts: before ? [{ type: "equal", text: before }] : [], identical: true, coarse: false, additions: 0, removals: 0 };
  const tokenize = text => text.match(/\s+|[\p{L}\p{N}\p{M}_]+|[^\s]/gu) || [];
  const left = tokenize(before), right = tokenize(after), parts = [];
  let start = 0, endLeft = left.length, endRight = right.length;
  while (start < endLeft && start < endRight && left[start] === right[start]) start++;
  while (endLeft > start && endRight > start && left[endLeft - 1] === right[endRight - 1]) { endLeft--; endRight--; }
  append(parts, "equal", left.slice(0, start).join(""));
  const n = endLeft - start, m = endRight - start;
  const coarse = n > 0 && m > 0 && (n + 1) * (m + 1) > Math.max(0, maxCells);
  if (!n || !m || coarse) {
    append(parts, "remove", left.slice(start, endLeft).join(""));
    append(parts, "add", right.slice(start, endRight).join(""));
  } else {
    const width = m + 1;
    const table = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] = left[start + i] === right[start + j]
        ? 1 + table[(i + 1) * width + j + 1]
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && left[start + i] === right[start + j]) {
        append(parts, "equal", left[start + i]); i++; j++;
      } else if (i < n && (j === m || table[(i + 1) * width + j] >= table[i * width + j + 1])) {
        append(parts, "remove", left[start + i++]);
      } else append(parts, "add", right[start + j++]);
    }
  }
  append(parts, "equal", left.slice(endLeft).join(""));
  return { parts, identical: false, coarse,
    additions: parts.filter(part => part.type === "add").length,
    removals: parts.filter(part => part.type === "remove").length };
}

export function recordedPaletteSeed(record) {
  if (record?.provenance !== "verified") return null;
  const exact = record.effective_seed_text ?? record.effective_seed;
  if (typeof exact === "string" && /^\d+$/.test(exact)) return exact;
  // Older servers may only expose an unsafe JS number. Do not claim equality
  // for two different uint64 seeds that rounded to the same browser number.
  return Number.isSafeInteger(exact) && exact >= 0 ? String(exact) : null;
}

export function comparisonMetadata(reference, candidate) {
  const a = recordedPaletteSeed(reference), b = recordedPaletteSeed(candidate);
  return [
    { label: "Palette seed", reference: a ?? "Unknown", candidate: b ?? "Unknown", same: a !== null && b !== null ? a === b : null },
    { label: "Run", reference: reference?.prompt_id || "Unknown", candidate: candidate?.prompt_id || "Unknown", same: reference?.prompt_id && candidate?.prompt_id ? reference.prompt_id === candidate.prompt_id : null },
    { label: "Output node", reference: reference?.output_node_id || "Unknown", candidate: candidate?.output_node_id || "Unknown", same: null },
  ];
}
