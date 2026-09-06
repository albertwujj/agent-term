// UTF-16 offsets, matching DOM Range and the viewer's text-offset helpers.
// Let Unicode sentence segmentation handle quotes, terminators and languages;
// commas/colons are not selection boundaries. Keep inline code opaque and soft
// source wraps as spaces without changing the offset space.
let segmenter;

function findSentenceRange(text, offset, protectedRanges = []) {
  if (typeof text !== 'string' || !text.trim() || !Number.isFinite(offset)
    || offset < 0 || offset > text.length || typeof Intl.Segmenter !== 'function') return null;
  let prose = text.replace(/\s/g, ' ');
  const chars = prose.split('');
  // A query's '?' is not a sentence terminator. Leave sentence punctuation
  // and closing quotes outside the URL protected range.
  const urls = Array.from(prose.matchAll(/\b(?:https?|file):\/\/[^\s<>]+/giu), (match) => ({
    start: match.index,
    end: match.index + match[0].replace(/[.!?。！？…)\]}»”"']+$/u, '').length,
  }));
  for (const range of [...protectedRanges, ...urls]) {
    for (let i = Math.max(0, range.start); i < Math.min(chars.length, range.end); i++) {
      if (/[.!?。！？…]/u.test(chars[i])) chars[i] = ',';
    }
  }
  prose = chars.join('');
  // ICU treats "Dr. Smith" as two sentences. These are unambiguous prefix
  // titles, not sentence-final abbreviations such as "etc." or "Inc.".
  prose = prose.replace(/\b(?:Mr|Mrs|Ms|Dr|Prof|Rev|Hon)\.(?=\s+\p{L})/gu,
    (title) => title.slice(0, -1) + ',');
  prose = prose.replace(/\b(?:e\.g|i\.e)\.(?=\s+\p{L})/giu,
    (abbreviation) => abbreviation.replace(/\./g, ','));
  try {
    segmenter ||= new Intl.Segmenter(undefined, { granularity: 'sentence' });
    const at = Math.min(offset, text.length - 1);
    for (const part of segmenter.segment(prose)) {
      const end = part.index + part.segment.length;
      if (at >= end) continue;
      const original = text.slice(part.index, end);
      const start = part.index + original.length - original.trimStart().length;
      const trimmedEnd = end - (original.length - original.trimEnd().length);
      return trimmedEnd > start ? { start, end: trimmedEnd } : null;
    }
  } catch {
    // Keep native selection if sentence segmentation is unavailable.
  }
  return null;
}

module.exports = { findSentenceRange };
