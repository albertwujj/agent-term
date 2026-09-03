// On-disk search behind the viewer selector (Cmd/Ctrl+Shift+U).
//
// The selector's known list is what this session has shown: scrollback plus
// the live stream. A resumed session reprints a slice of its transcript, so a
// file mentioned before that slice is not in the list, and one never mentioned
// never was. Once the filter has a few characters the selector also walks the
// disk and lists every file the band renders (band-viewable.js: markdown,
// html, images, video, audio, pdf) whose path matches, in a second section
// under the known rows.
//
// The walk runs once per selector open and the renderer filters the result in
// memory per keystroke, so a query costs one walk (about a third of a second
// warm over a home directory of a few thousand files) and every keystroke
// after it is free. The term never reaches the walk: its cost is listing
// directories, which the term cannot shrink, and a term-bound walk would be
// stale on the next letter. The walk is tiered in the same relevance order
// the click resolver uses (resolveMarkdownChoices in main.js): the repo (shell
// cwd), then its sibling folders under a short wall-clock budget, then home
// under a longer one. Each tier lands as it finishes, so the repo's files are
// on screen within tens of milliseconds while the wider tiers are still
// walking.
//
// Python rather than find for the same reason as the bare-name sweep: the
// walk must stop on a deadline, not on pipe backpressure, and python3 is
// already a seam dependency.

// argv: top skip budget cap exts. `skip` is a directory to leave out (the tier
// below already walked it; '' for none), `budget` seconds of wall clock (0 =
// no deadline), `cap` the most paths to print, `exts` a comma-separated list
// of dotted lower-case extensions. Prune set and the .git rule (only
// .git/discussion contributes) match CLICK_SEARCH_PRUNE in main.js.
//
// Breadth-first, directories in sorted order: a tier that runs out of budget
// has listed the shallow files of every folder in it (each sibling repo's
// README and docs/) before any one folder's deep tree, and its output is
// stable. A walk stopped by the deadline or the cap ends with a `#partial`
// line; paths are absolute, so no path line starts with #.
const DISK_LIST_PY = `
import os, sys, time
from collections import deque
top, skip, budget, cap = sys.argv[1], sys.argv[2], float(sys.argv[3]), int(sys.argv[4])
exts = tuple(e for e in sys.argv[5].split(",") if e)
prune = {"node_modules", ".cache", ".npm", "Library"}
skip = os.path.normpath(skip) if skip else None
deadline = time.monotonic() + budget if budget > 0 else None
hits = []
partial = False
queue = deque([top])
while queue:
    if deadline is not None and time.monotonic() > deadline:
        partial = True
        break
    d = queue.popleft()
    if skip is not None and os.path.normpath(d) == skip:
        continue
    try:
        entries = sorted(os.scandir(d), key=lambda e: e.name)
    except OSError:
        continue
    only = "discussion" if os.path.basename(d) == ".git" else None
    for e in entries:
        try:
            is_dir = e.is_dir(follow_symlinks=False)
        except OSError:
            continue
        if is_dir:
            if only is not None:
                if e.name == only:
                    queue.append(e.path)
            elif e.name not in prune:
                queue.append(e.path)
        elif only is None and e.name.lower().endswith(exts):
            hits.append(e.path)
            if len(hits) >= cap:
                partial = True
                queue.clear()
                break
if partial:
    hits.append("#partial")
sys.stdout.write("\\n".join(hits))
`;

const DISK_TIER_CAP = 50000;
const DISK_CWD_BUDGET_S = 10;
const DISK_SIBLING_BUDGET_S = 3;
const DISK_HOME_BUDGET_S = 8;

// The tiers one search walks, in order. `root` is the sibling root the click
// resolver derives from cwd (markdownSiblingRoot): cwd itself when its parent
// is a top-level directory, otherwise the parent. A tier that would re-walk
// the tier before it is left out: siblings when root is cwd, home when root
// already is home. Every tier has a budget, the repo's a generous one: a walk
// that runs out prints what it found, where the process backstop would drop
// the tier whole.
function diskTiers({ cwd, root, home }) {
  const tiers = [{ tier: 'cwd', top: cwd, skip: '', budget: DISK_CWD_BUDGET_S }];
  if (root && root !== cwd) {
    tiers.push({ tier: 'siblings', top: root, skip: cwd, budget: DISK_SIBLING_BUDGET_S });
  }
  if (home && home !== root && home !== cwd) {
    tiers.push({ tier: 'home', top: home, skip: root || cwd, budget: DISK_HOME_BUDGET_S });
  }
  return tiers;
}

// The path as the selector shows and matches it: relative to the repo for a
// repo file, ~/-relative under home, absolute elsewhere. Short enough to scan,
// and the folder names are in it, so "launch reddit" narrows by folder too.
function diskLabel(filePath, { cwd, home } = {}) {
  const p = String(filePath || '');
  if (cwd && (p === cwd || p.startsWith(cwd + '/'))) return p.slice(cwd.length + 1) || p;
  if (home && (p === home || p.startsWith(home + '/'))) return '~/' + p.slice(home.length + 1);
  return p;
}

module.exports = {
  DISK_LIST_PY,
  DISK_TIER_CAP,
  DISK_CWD_BUDGET_S,
  DISK_SIBLING_BUDGET_S,
  DISK_HOME_BUDGET_S,
  diskTiers,
  diskLabel,
};
