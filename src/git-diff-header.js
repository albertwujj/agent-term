// git diff names the two sides of a file with a one-letter folder that is not
// on disk, `a/` for the old side and `b/` for the new (swapped under -R), in
// the header lines it prints above each file:
//
//   diff --git a/docs/setup.md b/docs/setup.md
//   --- a/docs/setup.md
//   +++ b/docs/setup.md
//   Binary files a/shot.png and b/shot.png differ
//
// A path in one of those slots names the file under the repo root, without
// the prefix. Anywhere else `a/` is an ordinary folder.

const SIDE_PREFIX_RE = /^[ab]\//;
// The text ahead of a side path on its line, up to the path. A CLI may print
// the line behind a gutter, so the header word need not start the row.
const SIDE_SLOT_RES = [
  /(?:^|\s)diff --git (?:\S+ )?$/,
  /(?:^|\s)(?:---|\+\+\+) $/,
  /(?:^|\s)Binary files (?:\S+ and )?$/,
];

// `token`, a path printed at `index` in `text`, with git's side prefix
// removed when it sits in a diff header slot; null otherwise. `text` may hold
// several lines: only the one the token is on is read.
function gitDiffSidePath(text, index, token) {
  const path = String(token || '');
  if (!SIDE_PREFIX_RE.test(path)) return null;
  const before = String(text || '').slice(0, index);
  const lead = before.slice(before.lastIndexOf('\n') + 1);
  if (!SIDE_SLOT_RES.some((re) => re.test(lead))) return null;
  return path.replace(SIDE_PREFIX_RE, '');
}

module.exports = { gitDiffSidePath };
