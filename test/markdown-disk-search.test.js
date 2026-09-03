const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  MARKDOWN_LIST_PY,
  MARKDOWN_DISK_CWD_BUDGET_S,
  MARKDOWN_DISK_SIBLING_BUDGET_S,
  MARKDOWN_DISK_HOME_BUDGET_S,
  markdownDiskTiers,
  markdownDiskLabel,
} = require('../src/markdown-disk-search');

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
// a .git that only contributes discussion/, a sibling repo, and a doc at the
// sibling root itself.
function makeTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'md-disk-'));
  const put = (rel) => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '# doc\n');
  };
  put('repo/README.md');
  put('repo/notes.MARKDOWN');
  put('repo/docs/guide.md');
  put('repo/src/a.js');
  put('repo/node_modules/pkg/README.md');
  put('repo/.cache/c.md');
  put('repo/.git/discussion/topic.md');
  put('repo/.git/objects/x.md');
  put('sib/other.md');
  put('home-only.md');
  return root;
}

function walk(top, skip, budget, cap) {
  const out = execFileSync('python3', ['-c', MARKDOWN_LIST_PY, top, skip, String(budget), String(cap)], {
    encoding: 'utf8',
  });
  return out.split('\n').map((l) => l.trim()).filter(Boolean);
}

console.log('markdown-disk-search');

const root = makeTree();
try {
  test('walks the repo breadth-first in sorted order: every md, pruned folders out, .git only via discussion', () => {
    const hits = walk(path.join(root, 'repo'), '', 0, 100).map((p) => path.relative(root, p));
    assert.deepStrictEqual(hits, [
      'repo/README.md',
      'repo/notes.MARKDOWN',
      'repo/docs/guide.md',
      'repo/.git/discussion/topic.md',
    ]);
  });

  test('skip leaves out the tier below: the sibling walk never re-lists the repo', () => {
    const hits = walk(root, path.join(root, 'repo'), 3, 100).map((p) => path.relative(root, p));
    assert.deepStrictEqual(hits, ['home-only.md', 'sib/other.md']);
  });

  test('cap stops the walk at that many paths and marks the tier partial', () => {
    const hits = walk(path.join(root, 'repo'), '', 0, 2);
    assert.deepStrictEqual(hits.map((p) => path.basename(p)), ['README.md', 'notes.MARKDOWN', '#partial']);
  });

  test('a budget in seconds is accepted; a short walk finishes inside it without the marker', () => {
    const hits = walk(path.join(root, 'repo'), '', 30, 100);
    assert.strictEqual(hits.length, 4);
    assert.ok(!hits.includes('#partial'));
  });
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

test('tiers: repo, siblings, home, each skipping the tier before it', () => {
  const tiers = markdownDiskTiers({ cwd: '/Users/u/work/repo', root: '/Users/u/work', home: '/Users/u' });
  assert.deepStrictEqual(tiers, [
    { tier: 'cwd', top: '/Users/u/work/repo', skip: '', budget: MARKDOWN_DISK_CWD_BUDGET_S },
    { tier: 'siblings', top: '/Users/u/work', skip: '/Users/u/work/repo', budget: MARKDOWN_DISK_SIBLING_BUDGET_S },
    { tier: 'home', top: '/Users/u', skip: '/Users/u/work', budget: MARKDOWN_DISK_HOME_BUDGET_S },
  ]);
});

test('tiers: the home tier is left out when the sibling root already is home', () => {
  const tiers = markdownDiskTiers({ cwd: '/Users/u/repo', root: '/Users/u', home: '/Users/u' });
  assert.deepStrictEqual(tiers.map((t) => t.tier), ['cwd', 'siblings']);
});

test('tiers: a repo with no sibling root walks itself, then home', () => {
  const tiers = markdownDiskTiers({ cwd: '/opt/repo', root: '/opt/repo', home: '/Users/u' });
  assert.deepStrictEqual(tiers.map((t) => [t.tier, t.skip]), [['cwd', ''], ['home', '/opt/repo']]);
});

test('labels: repo-relative in the repo, ~/-relative under home, absolute elsewhere', () => {
  const ctx = { cwd: '/Users/u/work/repo', home: '/Users/u' };
  assert.strictEqual(markdownDiskLabel('/Users/u/work/repo/docs/guide.md', ctx), 'docs/guide.md');
  assert.strictEqual(markdownDiskLabel('/Users/u/launch/reddit.md', ctx), '~/launch/reddit.md');
  assert.strictEqual(markdownDiskLabel('/opt/notes.md', ctx), '/opt/notes.md');
  assert.strictEqual(markdownDiskLabel('/Users/u/work/repo-two/a.md', ctx), '~/work/repo-two/a.md');
});

console.log(`\n${testsPassed} passed, ${testsFailed} failed`);
if (testsFailed > 0) process.exit(1);
