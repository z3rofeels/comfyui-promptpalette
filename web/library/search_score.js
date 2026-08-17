export function normalizeSearchRow(item, ordinal = 0) {
  const path = String(item?.path || "");
  const firstSlash = path.indexOf("/");
  const lastSlash = path.lastIndexOf("/");
  const leaf = lastSlash >= 0 ? (path.slice(lastSlash + 1) || path) : path;
  const category = firstSlash >= 0 ? path.slice(0, firstSlash) : "General";
  return {
    item, ordinal, path, leaf, category,
    lower: path.toLowerCase(),
    leafLower: leaf.toLowerCase(),
    categoryLower: category.toLowerCase(),
  };
}

function subsequenceScore(haystack, needle) {
  let hi = 0, ni = 0, gaps = 0, last = -1;
  while (hi < haystack.length && ni < needle.length) {
    if (haystack[hi] === needle[ni]) {
      if (last >= 0) gaps += hi - last - 1;
      last = hi;
      ni += 1;
    }
    hi += 1;
  }
  return ni === needle.length ? gaps : Infinity;
}

// Small bounded Damerau-Levenshtein for typo tolerance. It only runs after
// cheaper exact/prefix/substring checks fail and stops once the configured
// distance cannot be beaten.
function boundedDamerauDistance(a, b, maxDistance = 2) {
  if (a === b) return 0;
  if (!a || !b || Math.abs(a.length - b.length) > maxDistance) return Infinity;
  const width = b.length + 1;
  let prev2 = null;
  let prev = Array.from({ length: width }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = new Array(width);
    current[0] = i;
    let rowMin = current[0];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(
        current[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] + cost,
      );
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, prev2[j - 2] + 1);
      }
      current[j] = value;
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > maxDistance) return Infinity;
    prev2 = prev;
    prev = current;
  }
  return prev[b.length] <= maxDistance ? prev[b.length] : Infinity;
}

function typoScore(row, term) {
  if (term.length < 3) return Infinity;
  const leafDistance = boundedDamerauDistance(row.leafLower, term, 2);
  if (Number.isFinite(leafDistance)) return 42 + leafDistance * 6;
  const categoryDistance = boundedDamerauDistance(row.categoryLower, term, 2);
  if (Number.isFinite(categoryDistance)) return 52 + categoryDistance * 6;
  return Infinity;
}

export function scoreSearchRow(row, terms) {
  let score = 0;
  for (const term of terms) {
    let part = Infinity;
    if (row.leafLower === term) part = 0;
    else if (row.leafLower.startsWith(term)) part = 5 + row.leafLower.length - term.length;
    else if (row.lower.startsWith(term)) part = 15;
    else if (row.lower.includes(term)) part = 25 + row.lower.indexOf(term);
    else if (row.categoryLower.includes(term)) part = 35;
    else {
      const typo = typoScore(row, term);
      if (Number.isFinite(typo)) part = typo;
      else {
        const fuzzy = subsequenceScore(row.lower, term);
        if (Number.isFinite(fuzzy)) part = 65 + fuzzy;
      }
    }
    if (!Number.isFinite(part)) return Infinity;
    score += part;
  }
  return score;
}
