// review:// is printed by an agent, not typed into a browser: no parser on the
// emitting side ever checks it, so the host is the only place a malformed link
// can be caught. The one slip a model actually makes is a space between the
// scheme and the path — the launch instruction shows `review://<path>`, and a
// model writing that from memory sometimes separates the placeholder. Admit it,
// but only ahead of an absolute path: prose about "the review:// link" can then
// never be read as a package.
const REVIEW_URL_SOURCE = String.raw`review:\/\/[ \t]*\/[^\s<>"'\x60\x00-\x1f]*[^\s<>"'\x60\x00-\x1f.,;:!?\)\]}>]`;
const VIEWER_URL_SOURCE = String.raw`(?:${REVIEW_URL_SOURCE}|(?:https?|file|review):\/\/[^\s<>"'\x60\x00-\x1f]+[^\s<>"'\x60\x00-\x1f.,;:!?\)\]}>])`;
const MARKDOWN_PATH_SOURCE = String.raw`(?:[a-zA-Z]:)?(?:[.\/\\~\u2026]|[a-zA-Z0-9_])[a-zA-Z0-9_.+$~\/\\\u2026-]*\.(?:markdown|mdown|md)\b`;
// One character that could still extend a candidate of each kind. The match
// regexes trim trailing punctuation ("https://a.com." matches "https://a.com"),
// so match.end alone cannot tell a finished candidate from one bisected by a
// chunk boundary: per-keystroke echo puts the boundary right after a typed "."
// and the trimmed match looks complete while the token is still growing.
const URL_CONTINUATION_RE = /[^\s<>"'\x60\x00-\x1f]/;
const MARKDOWN_CONTINUATION_RE = /[a-zA-Z0-9_.+$~\/\\\u2026-]/;

// End of the maximal run of continuation characters after a match: the point
// where the surrounding token is provably over.
function viewerTokenEnd(source, end, continuationRe) {
  let index = end;
  while (index < source.length && continuationRe.test(source[index])) index++;
  return index;
}
const OSC_8_URL_RE = /\x1b\]8;[^;]*;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
const DEFAULT_HISTORY_LIMIT = 100;
const STREAM_TAIL_CHARS = 2048;

function sameViewer(a, b) {
  return !!a && !!b && a.kind === b.kind && a.key === b.key;
}

function viewerFileUrlToPath(url) {
  try {
    const value = String(url);
    const host = (/^file:\/\/([^/]*)/i.exec(value) || [])[1] || '';
    let path = decodeURIComponent(value.replace(/^file:\/\/[^/]*/i, '').replace(/[?#].*$/, ''));
    // The POSIX seam already runs inside this WSL distro, so discard the UNC
    // share's distro segment before asking it to stat the path.
    if (/^wsl(?:\.localhost|\$)$/i.test(host)) path = path.replace(/^\/[^/]+/, '');
    return path;
  } catch {
    return '';
  }
}

function viewerIdentity(entry) {
  return entry ? `${entry.kind}\0${entry.key}` : '';
}

// The key every consumer sees, with the tolerated whitespace removed, so one
// package printed both ways is one entry in history and one sighting for
// auto-open rather than two.
function canonicalViewerUrl(url) {
  return String(url || '').replace(/^(review:\/\/)[ \t]+/i, '$1');
}

function normalizeMarkdownPath(raw) {
  let path = String(raw || '');
  const wslUnc = /^\\\\wsl(?:\.localhost|\$)\\[^\\]+/i;
  if (wslUnc.test(path)) path = path.replace(wslUnc, '').replace(/\\/g, '/');
  path = path.replace(/^(?:\.\.\.|\u2026)(?:[\\/]+|[^\\/]+[\\/]+)/, '');
  return path;
}

function extractViewerCandidateMatches(text) {
  const source = String(text || '');
  const matches = [];
  const urlSpans = [];
  const urlRe = new RegExp(VIEWER_URL_SOURCE, 'gi');
  const markdownRe = new RegExp(MARKDOWN_PATH_SOURCE, 'gi');

  for (const match of source.matchAll(urlRe)) {
    const key = canonicalViewerUrl(match[0]);
    const start = match.index;
    const end = start + match[0].length;
    const kind = /^review:\/\//i.test(key) ? 'review' : 'url';
    matches.push({ entry: { kind, key }, start, end, tokenEnd: viewerTokenEnd(source, end, URL_CONTINUATION_RE) });
    urlSpans.push({ start, end });
  }

  for (const match of source.matchAll(markdownRe)) {
    const start = match.index;
    const end = start + match[0].length;
    if (urlSpans.some((span) => start < span.end && end > span.start)) continue;
    const key = normalizeMarkdownPath(match[0]);
    if (key) matches.push({ entry: { kind: 'md', key }, start, end, tokenEnd: viewerTokenEnd(source, end, MARKDOWN_CONTINUATION_RE) });
  }

  matches.sort((a, b) => a.start - b.start || a.end - b.end);
  return matches;
}

function extractViewerCandidates(text) {
  const entries = [];
  const seen = new Set();
  for (const match of extractViewerCandidateMatches(text)) {
    const id = viewerIdentity(match.entry);
    if (seen.has(id)) continue;
    seen.add(id);
    entries.push(match.entry);
  }
  return entries;
}

function stripTerminalSequences(text) {
  return String(text || '')
    // OSC sequences, including an incomplete sequence at the end of a chunk.
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\|$)/g, '')
    // SGR styling can bisect a visible URL/path and should collapse away. Other
    // CSI controls move/erase the alt screen, so preserve them as a text boundary
    // instead of concatenating unrelated repaint regions into one fake token.
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, (sequence) => sequence.endsWith('m') ? '' : '\n')
    // Do not let a CSI split across PTY chunks terminate a partial candidate.
    .replace(/\x1b\[[0-?]*[ -/]*$/, '')
    // Short ESC controls such as charset selection.
    .replace(/\x1b[()][0-2A-Z]/g, '');
}

function parseLimit(options) {
  if (Number.isFinite(options)) return Math.max(1, Math.floor(options));
  if (options && Number.isFinite(options.limit)) return Math.max(1, Math.floor(options.limit));
  return DEFAULT_HISTORY_LIMIT;
}

class ViewerStreamAccumulator {
  constructor(options = {}) {
    this.limit = parseLimit(options);
    this._entries = [];
    this._rawTail = '';
  }

  _record(entry, captured) {
    const existing = this._entries.findIndex((candidate) => sameViewer(candidate, entry));
    if (existing !== -1) this._entries.splice(existing, 1);
    this._entries.unshift({ ...entry });
    if (this._entries.length > this.limit) this._entries.length = this.limit;

    const duplicate = captured.findIndex((candidate) => sameViewer(candidate, entry));
    if (duplicate !== -1) captured.splice(duplicate, 1);
    captured.unshift({ ...entry });
  }

  push(chunk) {
    const next = String(chunk || '');
    if (!next) return [];

    const raw = this._rawTail + next;
    const rawBoundary = this._rawTail.length;
    const cleanTail = stripTerminalSequences(this._rawTail);
    const clean = stripTerminalSequences(raw);
    const captured = [];

    for (const match of extractViewerCandidateMatches(clean)) {
      // Both checks use the surrounding token's end, not the match's: the
      // regexes trim trailing punctuation, so "https://gerrit" + "." parses as
      // a complete-looking match one character short of the boundary while the
      // user is still typing ".example.com". Only a character the candidate
      // could never contain proves the token is over.
      //
      // `<`, not `<=`: a token ending exactly at the old tail boundary was
      // deliberately deferred; capture it now when this chunk supplies a delimiter.
      if (match.tokenEnd < cleanTail.length) continue;
      // A token touching the chunk boundary may continue in the next write.
      // Wait for a delimiter instead of caching a permanently truncated URL/path.
      if (match.tokenEnd === clean.length) continue;
      this._record(match.entry, captured);
    }

    // OSC 8 targets are not rendered as text, so harvest their URI before OSC
    // stripping. This is especially important for full-screen TUI hyperlinks.
    OSC_8_URL_RE.lastIndex = 0;
    let oscMatch;
    while ((oscMatch = OSC_8_URL_RE.exec(raw)) !== null) {
      if (oscMatch.index + oscMatch[0].length <= rawBoundary) continue;
      for (const entry of extractViewerCandidates(oscMatch[1])) {
        if (entry.kind !== 'md') this._record(entry, captured);
      }
    }

    this._rawTail = raw.length > STREAM_TAIL_CHARS ? raw.slice(-STREAM_TAIL_CHARS) : raw;
    return captured;
  }

  entries() {
    return this._entries.map((entry) => ({ ...entry }));
  }

  remove(entry) {
    const index = this._entries.findIndex((candidate) => sameViewer(candidate, entry));
    if (index !== -1) this._entries.splice(index, 1);
  }

  clear() {
    this._entries.length = 0;
    this._rawTail = '';
  }
}

function collectBufferViewerCandidates(buffer) {
  if (!buffer || typeof buffer.getLine !== 'function') return [];
  const logicalLines = [];
  const length = Number.isFinite(buffer.length) ? buffer.length : 0;

  for (let row = 0; row < length; row++) {
    const line = buffer.getLine(row);
    if (!line) continue;
    const text = typeof line.translateToString === 'function' ? line.translateToString() : '';
    if (line.isWrapped && logicalLines.length) logicalLines[logicalLines.length - 1] += text;
    else logicalLines.push(text);
  }

  const entries = [];
  const seen = new Set();
  for (let row = logicalLines.length - 1; row >= 0; row--) {
    const onLine = extractViewerCandidates(logicalLines[row]);
    for (let index = onLine.length - 1; index >= 0; index--) {
      const entry = onLine[index];
      const id = viewerIdentity(entry);
      if (seen.has(id)) continue;
      seen.add(id);
      entries.push(entry);
    }
  }
  return entries;
}

function uniqueEntries(entries) {
  const result = [];
  const seen = new Set();
  for (const entry of entries || []) {
    if (!entry || !entry.kind || !entry.key) continue;
    const id = viewerIdentity(entry);
    if (seen.has(id)) continue;
    seen.add(id);
    result.push({ kind: entry.kind, key: entry.key });
  }
  return result;
}

class ViewerHistory {
  constructor(options = {}) {
    this.limit = parseLimit(options);
    this._entries = [];
    this._currentIdentity = '';
  }

  get current() {
    const entry = this._entries.find((candidate) => viewerIdentity(candidate) === this._currentIdentity);
    return entry ? { ...entry } : null;
  }

  entries() {
    return this._entries.map((entry) => ({ ...entry }));
  }

  merge(discovered) {
    const currentIdentity = this._currentIdentity;
    this._entries = uniqueEntries([...(discovered || []), ...this._entries]).slice(0, this.limit);
    this._currentIdentity = this._entries.some((entry) => viewerIdentity(entry) === currentIdentity)
      ? currentIdentity
      : '';
  }

  record(entry) {
    const normalized = uniqueEntries([entry])[0];
    if (!normalized) return;
    this._entries = [normalized, ...this._entries.filter((candidate) => !sameViewer(candidate, normalized))]
      .slice(0, this.limit);
    this._currentIdentity = viewerIdentity(normalized);
  }

  traverse(direction) {
    if (this._entries.length === 0) return [];
    const currentIndex = this._entries.findIndex(
      (entry) => viewerIdentity(entry) === this._currentIdentity
    );
    if (currentIndex === -1) {
      const entries = direction === 'forward' ? [...this._entries].reverse() : this._entries;
      return entries.map((entry) => ({ ...entry }));
    }
    if (this._entries.length === 1) return [];

    const ordered = direction === 'forward'
      ? [...this._entries.slice(0, currentIndex).reverse(), ...this._entries.slice(currentIndex + 1).reverse()]
      : [...this._entries.slice(currentIndex + 1), ...this._entries.slice(0, currentIndex)];
    return ordered.map((entry) => ({ ...entry }));
  }

  select(entry) {
    const found = this._entries.find((candidate) => sameViewer(candidate, entry));
    if (!found) return false;
    this._currentIdentity = viewerIdentity(found);
    return true;
  }

  remove(entry) {
    const removingCurrent = viewerIdentity(entry) === this._currentIdentity;
    const index = this._entries.findIndex((candidate) => sameViewer(candidate, entry));
    if (index !== -1) this._entries.splice(index, 1);
    if (removingCurrent) this._currentIdentity = '';
  }

  clear() {
    this._entries.length = 0;
    this._currentIdentity = '';
  }
}

// Negative validation is sticky for the session so a dead scrollback entry
// does not disappear from the denominator and then get re-added on every scan.
// A fresh PTY sighting calls observe(), allowing a newly created file to retry.
class ViewerValidationMemory {
  constructor() {
    this._rejected = new Set();
  }

  reject(entry) {
    const identity = viewerIdentity(entry);
    if (identity) this._rejected.add(identity);
  }

  observe(entry) {
    this._rejected.delete(viewerIdentity(entry));
  }

  isRejected(entry) {
    return this._rejected.has(viewerIdentity(entry));
  }

  clear() {
    this._rejected.clear();
  }
}

module.exports = {
  VIEWER_URL_SOURCE,
  ViewerHistory,
  ViewerStreamAccumulator,
  ViewerValidationMemory,
  canonicalViewerUrl,
  collectBufferViewerCandidates,
  extractViewerCandidates,
  sameViewer,
  stripTerminalSequences,
  viewerFileUrlToPath,
};
