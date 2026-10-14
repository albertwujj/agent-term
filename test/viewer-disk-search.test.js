const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  DISK_LIST_PY,
  DISK_CWD_BUDGET_S,
  DISK_SIBLING_BUDGET_S,
  DISK_HOME_BUDGET_S,
  diskAge,
  diskTiers,
  diskLabel,
} = require('../src/viewer-disk-search');
const { DISK_SEARCH_EXTENSIONS } = require('../src/band-viewable');

let testsPassed = 0;
let testsFailed = 0;

function test(name, fn) {
  try { fn(); testsPassed++; console.log(`  ✓ ${name}`); }
  catch (err) {
    testsFailed++;
    console.log(`  ✗ ${name}`);
    console.log(`      ${err.message}`);
  }
}

// A neighbourhood the walk has opinions about: a repo with pruned folders and
// a .git that only contributes conversation/ and its review packages' .md (not
// the rendered page beside one), every kind the band renders plus
// an archive it does not, a sibling repo, and a doc at the sibling root.
// Every file gets an explicit mtime (T, or T plus a bump) so the order the
// walk prints is deterministic.
const T = 1700000000;
function makeTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-disk-'));
  const put = (rel, bump = 0) => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'x\n');
    fs.utimesSync(p, T + bump, T + bump);
  };
  put('repo/README.md', 100);
  put('repo/notes.MARKDOWN');
  put('repo/clip.mp4');
  put('repo/paper.pdf');
  put('repo/bundle.zip', 500);
  put('repo/docs/guide.md', 200);
  put('repo/docs/shot.PNG');
  put('repo/src/a.js', 500);
  put('repo/node_modules/pkg/README.md', 500);
  put('repo/.cache/c.md', 500);
  put('repo/.git/conversation/topic.md');
  put('repo/.git/review/work-a/work-a.md');
  put('repo/.git/review/work-a/work-a.html', 500);
  put('repo/.git/objects/x.md', 500);
  put('sib/other.md', 300);
  put('home-only.md', 50);
  return root;
}

// The walk's lines: `mtime<TAB>path` per hit, then `#partial` if cut short.
function walk(top, skip, budget, cap, exts = DISK_SEARCH_EXTENSIONS, git) {
  const args = [top, skip, String(budget), String(cap), exts.join(',')];
  if (git != null) args.push(git);
  const out = execFileSync('python3', ['-c', DISK_LIST_PY, ...args], {
    encoding: 'utf8',
  });
  return out.split('\n').map((l) => l.trim()).filter(Boolean);
}
function hits(lines) {
  return lines.filter((l) => !l.startsWith('#')).map((l) => {
    const tab = l.indexOf('\t');
    return { path: l.slice(tab + 1), modified: Number(l.slice(0, tab)) };
  });
}
function paths(lines) { return hits(lines).map((h) => h.path); }

console.log('viewer-disk-search');

const root = makeTree();
try {
  test('lists every band-viewable file most recently modified first, ties in walk order; pruned folders out, .git only via conversation and review packages', () => {
    const listed = paths(walk(path.join(root, 'repo'), '', 0, 100)).map((p) => path.relative(root, p));
    assert.deepStrictEqual(listed, [
      'repo/docs/guide.md',
      'repo/README.md',
      'repo/clip.mp4',
      'repo/notes.MARKDOWN',
      'repo/paper.pdf',
      'repo/docs/shot.PNG',
      'repo/.git/conversation/topic.md',
      'repo/.git/review/work-a/work-a.md',
    ]);
  });

  test('each hit carries its mtime in whole seconds', () => {
    const byName = Object.fromEntries(hits(walk(path.join(root, 'repo'), '', 0, 100))
      .map((h) => [path.basename(h.path), h.modified]));
    assert.strictEqual(byName['guide.md'], T + 200);
    assert.strictEqual(byName['README.md'], T + 100);
    assert.strictEqual(byName['clip.mp4'], T);
  });

  test('the extension list is the walk\'s only filter: markdown alone lists the docs', () => {
    const listed = paths(walk(path.join(root, 'repo'), '', 0, 100, ['.md'])).map((p) => path.basename(p));
    assert.deepStrictEqual(listed, ['guide.md', 'README.md', 'topic.md', 'work-a.md']);
  });

  test('skip leaves out the tier below: the sibling walk never re-lists the repo', () => {
    const listed = paths(walk(root, path.join(root, 'repo'), 3, 100)).map((p) => path.relative(root, p));
    assert.deepStrictEqual(listed, ['sib/other.md', 'home-only.md']);
  });

  test('cap stops the walk at that many paths, sorts what it has, and marks the tier partial', () => {
    const lines = walk(path.join(root, 'repo'), '', 0, 2);
    assert.deepStrictEqual(paths(lines).map((p) => path.basename(p)), ['README.md', 'clip.mp4']);
    assert.strictEqual(lines[lines.length - 1], '#partial');
  });

  test('a budget in seconds is accepted; a short walk finishes inside it without the marker', () => {
    const lines = walk(path.join(root, 'repo'), '', 30, 100);
    assert.strictEqual(paths(lines).length, 8);
    assert.ok(!lines.includes('#partial'));
  });
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

// A repo whose shared .git holds a review package and a conversation doc,
// reached from a linked worktree (its .git a file naming the shared one) and
// from a folder inside the repo: the walk of either never meets that .git.
const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-disk-git-'));
try {
  const put = (rel) => {
    const p = path.join(shared, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'x\n');
    fs.utimesSync(p, T, T);
  };
  put('main/.git/review/work-b/work-b.md');
  put('main/.git/review/work-b/work-b.html');
  put('main/.git/conversation/topic.md');
  put('main/.git/objects/y.md');
  put('main/sub/a.md');
  put('wt/notes.md');
  fs.writeFileSync(path.join(shared, 'wt/.git'), `gitdir: ${path.join(shared, 'main/.git/worktrees/wt')}\n`);
  const rel = (lines) => paths(lines).map((p) => path.relative(shared, p));

  test('the repo\'s shared .git is walked with a worktree: its packages and conversation docs, nothing else', () => {
    assert.deepStrictEqual(rel(walk(path.join(shared, 'wt'), '', 0, 100, DISK_SEARCH_EXTENSIONS, path.join(shared, 'main/.git'))), [
      'wt/notes.md',
      'main/.git/conversation/topic.md',
      'main/.git/review/work-b/work-b.md',
    ]);
  });

  test('git prints the shared .git relative to a folder inside the repo; the walk resolves it there', () => {
    assert.deepStrictEqual(rel(walk(path.join(shared, 'main/sub'), '', 0, 100, DISK_SEARCH_EXTENSIONS, '../.git')), [
      'main/sub/a.md',
      'main/.git/conversation/topic.md',
      'main/.git/review/work-b/work-b.md',
    ]);
  });

  test('a shared .git inside the walk is listed once; a git dir not named .git, or none, adds nothing', () => {
    const fromMain = rel(walk(path.join(shared, 'main'), '', 0, 100, DISK_SEARCH_EXTENSIONS, '.git'));
    assert.strictEqual(fromMain.filter((p) => p.endsWith('work-b.md')).length, 1);
    assert.deepStrictEqual(rel(walk(path.join(shared, 'wt'), '', 0, 100, DISK_SEARCH_EXTENSIONS, path.join(shared, 'main/.git/review'))), ['wt/notes.md']);
    assert.deepStrictEqual(rel(walk(path.join(shared, 'wt'), '', 0, 100, DISK_SEARCH_EXTENSIONS, '')), ['wt/notes.md']);
  });
} finally {
  fs.rmSync(shared, { recursive: true, force: true });
}

test('tiers: repo, siblings, home, each skipping the tier before it', () => {
  const tiers = diskTiers({ cwd: '/Users/u/work/repo', root: '/Users/u/work', home: '/Users/u' });
  assert.deepStrictEqual(tiers, [
    { tier: 'cwd', top: '/Users/u/work/repo', skip: '', budget: DISK_CWD_BUDGET_S },
    { tier: 'siblings', top: '/Users/u/work', skip: '/Users/u/work/repo', budget: DISK_SIBLING_BUDGET_S },
    { tier: 'home', top: '/Users/u', skip: '/Users/u/work', budget: DISK_HOME_BUDGET_S },
  ]);
});

test('tiers: the home tier is left out when the sibling root already is home', () => {
  const tiers = diskTiers({ cwd: '/Users/u/repo', root: '/Users/u', home: '/Users/u' });
  assert.deepStrictEqual(tiers.map((t) => t.tier), ['cwd', 'siblings']);
});

test('tiers: a repo with no sibling root walks itself, then home', () => {
  const tiers = diskTiers({ cwd: '/opt/repo', root: '/opt/repo', home: '/Users/u' });
  assert.deepStrictEqual(tiers.map((t) => [t.tier, t.skip]), [['cwd', ''], ['home', '/opt/repo']]);
});

test('age: compact, from seconds since the mtime; nothing for an unknown mtime', () => {
  const now = 1_800_000_000_000;
  const ago = (seconds) => diskAge(now / 1000 - seconds, now);
  assert.strictEqual(ago(5), 'now');
  assert.strictEqual(ago(5 * 60), '5m');
  assert.strictEqual(ago(3 * 3600), '3h');
  assert.strictEqual(ago(2 * 86400), '2d');
  assert.strictEqual(ago(75 * 86400), '2mo');
  assert.strictEqual(ago(400 * 86400), '1y');
  assert.strictEqual(diskAge(0, now), '');
});

test('labels: repo-relative in the repo, ~/-relative under home, absolute elsewhere', () => {
  const ctx = { cwd: '/Users/u/work/repo', home: '/Users/u' };
  assert.strictEqual(diskLabel('/Users/u/work/repo/docs/guide.md', ctx), 'docs/guide.md');
  assert.strictEqual(diskLabel('/Users/u/launch/reddit.mp4', ctx), '~/launch/reddit.mp4');
  assert.strictEqual(diskLabel('/opt/notes.md', ctx), '/opt/notes.md');
  assert.strictEqual(diskLabel('/Users/u/work/repo-two/a.md', ctx), '~/work/repo-two/a.md');
});

console.log(`\n${testsPassed} passed, ${testsFailed} failed`);
if (testsFailed > 0) process.exit(1);
