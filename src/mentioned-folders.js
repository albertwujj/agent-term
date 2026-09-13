// Folders the terminal has already printed, for resolving a clicked bare name.
//
// An agent working outside the repo prints where it works before it prints
// what it made: a tool header or a command carries the absolute path of a
// scratch directory, and a few lines later the text names a file in it by
// bare name ("mock.png") or by a short tail ("scratchpad/mock.png"). The
// click's own search (main.js resolveClickedPath, resolveMarkdownChoices)
// covers the repo, its neighbours and home, and a scratch directory is under
// none of them, so the printed folder is the one lead the click has.
//
// The renderer collects those folders at click time from the scrollback
// around the click (mentionedFoldersAround in renderer.js) and hands them to
// the resolver, nearest mention above the click first: the folder printed
// just before a name is the likeliest home for it. No state accumulates; a
// resumed session reprints its transcript slice and the same scan finds the
// same folders. The resolver tries the clicked name directly inside each
// folder with one shell round trip (mentionedFolderCandidates below) before
// any tree search, after the one thing that outranks it: an exact hit under
// the shell cwd.

const MENTIONED_FOLDERS_MAX = 40;
const MENTIONED_CANDIDATES_MAX = 80;
// Rows scanned around the click. A folder the agent works in recurs in every
// tool header that touches it, so the nearest mention is the useful one and a
// bounded window keeps the scan a click's worth of work.
const MENTIONED_SCAN_ROWS_ABOVE = 20000;
const MENTIONED_SCAN_ROWS_BELOW = 1000;

// One printed path. POSIX absolute or ~-relative; a Windows drive path; a WSL
// UNC path. Not the path part of a URL (the `:` ahead of `//`), not a relative
// path (`./x`, `../x`, `a/b`), not a token that continues one (`\w` ahead).
const PATH_CHARS = String.raw`[^\s"'\x60<>|()\[\]{}]`;
const POSIX_PATH_RE = new RegExp(String.raw`(?<![\w:/.\\~-])(?:~\/|\/)${PATH_CHARS}*`, 'g');
const WINDOWS_DRIVE_RE = new RegExp(String.raw`(?<![\w:/.\\-])[A-Za-z]:[\\/]${PATH_CHARS}*`, 'g');
const WSL_UNC_RE = new RegExp(String.raw`\\\\wsl(?:\.localhost|\$)\\[^\\\s]+\\${PATH_CHARS}*`, 'g');
const TRAILING_LINE_REF_RE = /:\d+(?::\d+)?$/;
const TRAILING_PUNCTUATION_RE = /[.,;:!?]+$/;
// An abbreviated path names no folder the shell can test.
const ELLIPSIZED_RE = /(?:^|\/)(?:\.\.\.|\u2026)(?:\/|$)|\u2026/;

function windowsToPosix(token) {
  const unc = token.match(/^\\\\wsl(?:\.localhost|\$)\\[^\\]+/i);
  if (unc) return token.slice(unc[0].length).replace(/\\/g, '/');
  const drive = token.match(/^([A-Za-z]):[\\/]/);
  if (drive) return `/mnt/${drive[1].toLowerCase()}/` + token.slice(3).replace(/\\/g, '/');
  return token;
}

// The folders one printed path stands for: its parent, and the path itself
// when its last segment looks like a directory rather than a file. Empty when
// the token says nothing usable.
function foldersOfToken(raw) {
  let token = String(raw || '')
    .replace(TRAILING_LINE_REF_RE, '')
    .replace(TRAILING_PUNCTUATION_RE, '')
    .replace(/[\\/]+$/, '');
  // `//` opens a comment or a protocol-relative URL, never a path.
  if (!token || token.startsWith('//') || ELLIPSIZED_RE.test(token)) return [];
  token = windowsToPosix(token);
  if (!token.startsWith('/') && !token.startsWith('~/')) return [];
  const segments = token.split('/').filter(Boolean);
  const prefix = token.startsWith('~/') ? '~' : '';
  const body = prefix ? segments.slice(1) : segments;
  if (body.length === 0) return [];
  const join = (segs) => (segs.length === 0 ? null : `${prefix}/${segs.join('/')}`);
  const last = body[body.length - 1];
  const fileLike = /\.[^.]+$/.test(last);
  const out = [];
  if (!fileLike) out.push(join(body));
  const parent = join(body.slice(0, -1));
  if (parent) out.push(parent);
  return out.filter(Boolean);
}

function tokensInLine(text) {
  const source = String(text || '');
  const tokens = [];
  for (const re of [WSL_UNC_RE, WINDOWS_DRIVE_RE, POSIX_PATH_RE]) {
    re.lastIndex = 0;
    for (const m of source.matchAll(re)) tokens.push({ index: m.index, text: m[0] });
  }
  tokens.sort((a, b) => a.index - b.index);
  return tokens.map((t) => t.text);
}

// lines: [{ row, text }] logical lines of the scrollback in row order;
// clickRow: the buffer row of the click; without one the click is taken to be
// at the end. Returns the printed folders nearest the click first: the
// closest mention on or above it, then further up, then the ones below, each
// folder once, capped.
function extractMentionedFolders(lines, clickRow, { cap = MENTIONED_FOLDERS_MAX } = {}) {
  const rows = (Array.isArray(lines) ? lines : []).map((l) => (l && Number.isFinite(l.row) ? l.row : 0));
  const row0 = Number.isFinite(clickRow) ? clickRow : (rows.length ? Math.max(...rows) : 0);
  const above = [];
  const below = [];
  for (const line of Array.isArray(lines) ? lines : []) {
    if (!line || typeof line.text !== 'string') continue;
    const row = Number.isFinite(line.row) ? line.row : 0;
    const folders = [];
    for (const token of tokensInLine(line.text)) folders.push(...foldersOfToken(token));
    if (folders.length === 0) continue;
    if (row <= row0) above.push({ distance: row0 - row, folders });
    else below.push({ distance: row - row0, folders });
  }
  above.sort((a, b) => a.distance - b.distance);
  below.sort((a, b) => a.distance - b.distance);
  const seen = new Set();
  const out = [];
  for (const group of [...above, ...below]) {
    for (const folder of group.folders) {
      if (seen.has(folder)) continue;
      seen.add(folder);
      out.push(folder);
      if (out.length >= cap) return out;
    }
  }
  return out;
}

// The absolute paths a clicked relative name could be under the printed
// folders, in folder order. Each folder yields folder/rel, and where the
// folder's tail already spells the head of rel (folder .../scratchpad, rel
// scratchpad/mock.png) the overlap is taken once, so a printed tail resolves
// against the folder it was printed from. `~` folders need `home`; without it
// they are skipped.
function mentionedFolderCandidates(folders, rel, { home = '', cap = MENTIONED_CANDIDATES_MAX } = {}) {
  const relClean = String(rel || '').replace(/^\.\/+/, '').replace(/\/+$/, '');
  if (!relClean || relClean.startsWith('/')) return [];
  const relSegs = relClean.split('/').filter(Boolean);
  if (relSegs.length === 0 || relSegs.includes('..')) return [];
  const seen = new Set();
  const out = [];
  const push = (p) => {
    if (seen.has(p)) return;
    seen.add(p);
    out.push(p);
  };
  for (const raw of Array.isArray(folders) ? folders : []) {
    let folder = String(raw || '');
    if (folder.startsWith('~/') || folder === '~') {
      if (!home) continue;
      folder = folder === '~' ? home : `${home}/${folder.slice(2)}`;
    }
    if (!folder.startsWith('/')) continue;
    const fSegs = folder.split('/').filter(Boolean);
    const base = fSegs.length ? '/' + fSegs.join('/') : '';
    for (let k = Math.min(relSegs.length - 1, fSegs.length); k >= 0; k--) {
      if (k > 0) {
        let overlap = true;
        for (let i = 0; i < k; i++) {
          if (fSegs[fSegs.length - k + i] !== relSegs[i]) { overlap = false; break; }
        }
        if (!overlap) continue;
      }
      push(`${base}/${relSegs.slice(k).join('/')}`);
    }
    if (out.length >= cap) break;
  }
  return out.slice(0, cap);
}

// The renderer hands folders over IPC; the main process takes only a bounded
// list of plain strings from it.
function sanitizeMentionedFolders(value, { cap = MENTIONED_FOLDERS_MAX } = {}) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const folder = item.trim();
    if (!folder || folder.length > 1024 || folder.includes('\0')) continue;
    if (!folder.startsWith('/') && !folder.startsWith('~/')) continue;
    out.push(folder);
    if (out.length >= cap) break;
  }
  return out;
}

module.exports = {
  MENTIONED_FOLDERS_MAX,
  MENTIONED_CANDIDATES_MAX,
  MENTIONED_SCAN_ROWS_ABOVE,
  MENTIONED_SCAN_ROWS_BELOW,
  extractMentionedFolders,
  foldersOfToken,
  mentionedFolderCandidates,
  sanitizeMentionedFolders,
};
