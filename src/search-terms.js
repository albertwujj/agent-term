function normalizeSearchText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function parseSearchTerms(query) {
  const normalized = normalizeSearchText(query).toLowerCase();
  if (!normalized) return [];
  const seen = new Set();
  const terms = [];
  for (const term of normalized.split(' ')) {
    if (!term || seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
  }
  return terms;
}

function textMatchesSearchTerms(text, terms) {
  if (!Array.isArray(terms) || terms.length === 0) return true;
  const lower = String(text || '').toLowerCase();
  return terms.every(term => lower.includes(term));
}

function findAllTermRanges(text, terms) {
  if (!Array.isArray(terms) || terms.length === 0) return [];
  const raw = String(text || '');
  const lower = raw.toLowerCase();
  const ranges = [];
  for (const term of terms) {
    if (!term) continue;
    let from = 0;
    while (from <= lower.length) {
      const start = lower.indexOf(term, from);
      if (start === -1) break;
      ranges.push({ start, end: start + term.length });
      from = start + Math.max(term.length, 1);
    }
  }
  if (ranges.length <= 1) return ranges;

  ranges.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (!last || range.start > last.end) {
      merged.push({ ...range });
    } else if (range.end > last.end) {
      last.end = range.end;
    }
  }
  return merged;
}

module.exports = {
  normalizeSearchText,
  parseSearchTerms,
  textMatchesSearchTerms,
  findAllTermRanges,
};
