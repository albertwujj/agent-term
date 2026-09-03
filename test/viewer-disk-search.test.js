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
// a .git that only contributes discussion/, every kind the band renders plus
// an archive it does not, a sibling repo, and a doc at the sibling root.
function makeTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-disk-'));
  const put = (rel) => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'x\n');
  };
  put('repo/README.md');
  put('repo/notes.MARKDOWN');
  put('repo/clip.mp4');
  put('repo/paper.pdf');
  put('repo/bundle.zip');
  put('repo/docs/guide.md');
  put('repo/docs/shot.PNG');
  put('repo/src/a.js');
  put('repo/node_modules/pkg/README.md');
  put('repo/.cache/c.md');
  put('repo/.git/discussion/topic.md');
  put('repo/.git/objects/x.md');
  put('sib/other.md');
  put('home-only.md');
  return root;
}

function walk(top, skip, budget, cap, exts = DISK_SEARCH_EXTENSIONS) {
  const out = execFileSync('python3', ['-c', DISK_LIST_PY, top, skip, String(budget), String(cap), exts.join(',')], {
    encoding: 'utf8',
  });
  return out.split('\n').map((l) => l.trim()).filter(Boolean);
}

console.log('viewer-disk-search');

const root = makeTree();
try {
  test('walks the repo breadth-first in sorted order: every band-viewable file, pruned folders out, .git only via discussion', () => {
    const hits = walk(path.join(root, 'repo'), '', 0, 100).map((p) => path.relative(root, p));
    assert.deepStrictEqual(hits, [
      'repo/README.md',
      'repo/clip.mp4',
      'repo/notes.MARKDOWN',
      'repo/paper.pdf',
      'repo/docs/guide.md',
      'repo/docs/shot.PNG',
      'repo/.git/discussion/topic.md',
    ]);
  });

  test('the extension list is the walk\'s only filter: markdown alone lists the docs', () => {
    const hits = walk(path.join(root, 'repo'), '', 0, 100, ['.md']).map((p) => path.basename(p));
    assert.deepStrictEqual(hits, ['README.md', 'guide.md', 'topic.md']);
  });

  test('skip leaves out the tier below: the sibling walk never re-lists the repo', () => {
    const hits = walk(root, path.join(root, 'repo'), 3, 100).map((p) => path.relative(root, p));
    assert.deepStrictEqual(hits, ['home-only.md', 'sib/other.md']);
  });

  test('cap stops the walk at that many paths and marks the tier partial', () => {
    const hits = walk(path.join(root, 'repo'), '', 0, 2);
    assert.deepStrictEqual(hits.map((p) => path.basename(p)), ['README.md', 'clip.mp4', '#partial']);
  });

  test('a budget in seconds is accepted; a short walk finishes inside it without the marker', () => {
    const hits = walk(path.join(root, 'repo'), '', 30, 100);
    assert.strictEqual(hits.length, 7);
    assert.ok(!hits.includes('#partial'));
  });
} finally {
  fs.rmSync(root, { recursive: true, force: true });
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

test('labels: repo-relative in the repo, ~/-relative under home, absolute elsewhere', () => {
  const ctx = { cwd: '/Users/u/work/repo', home: '/Users/u' };
  assert.strictEqual(diskLabel('/Users/u/work/repo/docs/guide.md', ctx), 'docs/guide.md');
  assert.strictEqual(diskLabel('/Users/u/launch/reddit.mp4', ctx), '~/launch/reddit.mp4');
  assert.strictEqual(diskLabel('/opt/notes.md', ctx), '/opt/notes.md');
  assert.strictEqual(diskLabel('/Users/u/work/repo-two/a.md', ctx), '~/work/repo-two/a.md');
});

console.log(`\n${testsPassed} passed, ${testsFailed} failed`);
if (testsFailed > 0) process.exit(1);
