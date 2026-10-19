// Keep valid JSON objects literal, with source offsets intact for editor tools.
// Mirror json_literals.py; ordinary choice/variable syntax is not valid JSON.
export function jsonObjectRanges(text) {
  const ranges = [], startPattern = /\{\s*(?:"|\})/g;
  let match;
  while ((match = startPattern.exec(text))) {
    const start = match.index;
    if (start && text[start - 1] === '$') continue;
    let depth = 0, quoted = false, escaped = false, end = -1;
    for (let at = start; at < text.length; at++) {
      const char = text[at];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === '{') depth++;
      else if (char === '}' && --depth === 0) { end = at + 1; break; }
    }
    if (end < 0) break;
    startPattern.lastIndex = end;
    try {
      const value = JSON.parse(text.slice(start, end));
      if (value && typeof value === 'object' && !Array.isArray(value)) ranges.push({ start, end });
    } catch { /* Incomplete/invalid JSON retains ordinary editor diagnostics. */ }
  }
  return ranges;
}

export function maskJsonObjects(text, ranges = jsonObjectRanges(text)) {
  let masked = '', cursor = 0;
  for (const { start, end } of ranges) {
    masked += text.slice(cursor, start) + text.slice(start, end).replace(/[^\r\n]/g, ' ');
    cursor = end;
  }
  return masked + text.slice(cursor);
}

export function isJsonObject(text) {
  const trimmed = String(text).trim(), ranges = jsonObjectRanges(trimmed);
  return ranges.length === 1 && ranges[0].start === 0 && ranges[0].end === trimmed.length;
}
