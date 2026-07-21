const assert = require('assert');
const {
  orderedRunbookCandidates,
  repoRunbookRoots,
} = require('../src/runbook-resolution');

let testsPassed = 0, testsFailed = 0;

function test(name, fn) {
  try {
    fn();
    testsPassed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    testsFailed++;
    console.log(`  ✗ ${name}`);
    console.log(`      ${err.message}`);
  }
}

function firstExisting(options, existing) {
  const present = new Set(existing);
  return orderedRunbookCandidates(options).find((candidate) => present.has(candidate)) || null;
}

console.log('runbook-resolution');

test('arbitrary runbooks resolve up the governing tree closest-first', () => {
  const options = {
    referenceFile: '/work/repo/docs/guide.md',
    relativeRunbookPath: 'kit/run.md',
    fallbackRoots: ['/opt/agent-kits', '/home/me'],
  };
  assert.deepStrictEqual(orderedRunbookCandidates(options), [
    '/work/repo/docs/kit/run.md',
    '/work/repo/kit/run.md',
    '/work/kit/run.md',
    '/kit/run.md',
    '/opt/agent-kits/kit/run.md',
    '/home/me/kit/run.md',
  ]);
  assert.strictEqual(firstExisting(options, [
    '/work/repo/kit/run.md',
    '/work/kit/run.md',
    '/opt/agent-kits/kit/run.md',
  ]), '/work/repo/kit/run.md');
});

test('resolution does not scan siblings or descendants', () => {
  const candidates = orderedRunbookCandidates({
    referenceFile: '/work/repo/docs/guide.md',
    relativeRunbookPath: 'kit/run.md',
  });
  assert.strictEqual(candidates.includes('/work/repo/sibling/kit/run.md'), false);
  assert.strictEqual(candidates.includes('/work/repo/docs/child/kit/run.md'), false);
});

test('the exact current-repo fallbacks win before HOME', () => {
  const options = {
    referenceFile: '/unrelated/repo/doc.md',
    relativeRunbookPath: 'kit/run.md',
    fallbackRoots: [...repoRunbookRoots('/opt/product'), '/home/me'],
  };
  assert.strictEqual(firstExisting(options, [
    '/home/me/kit/run.md',
    '/opt/kit/run.md',
  ]), '/opt/kit/run.md');
  assert.strictEqual(firstExisting(options, ['/home/me/kit/run.md']), '/home/me/kit/run.md');
  assert.strictEqual(firstExisting(options, []), null);
});

test('stable deduplication preserves a fallback found naturally nearer', () => {
  const candidates = orderedRunbookCandidates({
    referenceFile: '/home/me/project/doc.md',
    relativeRunbookPath: 'kit/run.md',
    fallbackRoots: [...repoRunbookRoots('/home/me/project'), '/home/me'],
  });
  assert.strictEqual(candidates.filter((candidate) => candidate === '/home/me/project/kit/run.md').length, 1);
  assert.strictEqual(candidates.filter((candidate) => candidate === '/home/me/kit/run.md').length, 1);
  assert.ok(candidates.indexOf('/home/me/kit/run.md') < candidates.indexOf('/kit/run.md'));
});

test('the md runbook prefers current-repo vendoring, then its sibling layout', () => {
  const options = {
    referenceFile: '/unrelated/project/notes.md',
    relativeRunbookPath: 'agent-threads/md/user-intent.md',
    fallbackRoots: [...repoRunbookRoots('/tools/agent-term'), '/home/me'],
  };
  assert.strictEqual(firstExisting(options, [
    '/tools/agent-threads/md/user-intent.md',
    '/tools/agent-term/agent-threads/md/user-intent.md',
  ]), '/tools/agent-term/agent-threads/md/user-intent.md');
  assert.strictEqual(firstExisting(options, [
    '/tools/agent-threads/md/user-intent.md',
  ]), '/tools/agent-threads/md/user-intent.md');
});

test('repo roots walk the anchor\'s full ancestor chain, closest-first', () => {
  assert.deepStrictEqual(repoRunbookRoots('/a/b/c'), ['/a/b/c', '/a/b', '/a', '/']);
  assert.deepStrictEqual(repoRunbookRoots('/'), ['/']);
});

test('a runbook above the repo\'s immediate parent still resolves', () => {
  const options = {
    referenceFile: '/unrelated/doc.md',
    relativeRunbookPath: 'agent-threads/md/user-intent.md',
    fallbackRoots: [...repoRunbookRoots('/home/me/work/projects/app'), '/home/me'],
  };
  // agent-threads sits beside `projects`, two levels above the repo — reachable
  // only by walking the anchor's ancestors past its immediate parent.
  assert.strictEqual(firstExisting(options, [
    '/home/me/work/agent-threads/md/user-intent.md',
  ]), '/home/me/work/agent-threads/md/user-intent.md');
});

test('candidate inputs reject ambiguous or escaping paths', () => {
  assert.throws(() => orderedRunbookCandidates({
    referenceFile: 'relative/doc.md',
    relativeRunbookPath: 'kit/run.md',
  }), /absolute POSIX/);
  assert.throws(() => orderedRunbookCandidates({
    referenceFile: '/work/doc.md',
    relativeRunbookPath: '../run.md',
  }), /normalized relative POSIX/);
  assert.throws(() => orderedRunbookCandidates({
    referenceFile: '/work/doc.md',
    relativeRunbookPath: '/kit/run.md',
  }), /normalized relative POSIX/);
});

test('repo roots run vendored, then sibling/beside, then up the tree', () => {
  assert.deepStrictEqual(repoRunbookRoots('/work/product'), ['/work/product', '/work', '/']);
  assert.throws(() => repoRunbookRoots('work/product'), /absolute POSIX/);
});

console.log(`\n${testsPassed} passed, ${testsFailed} failed`);
process.exit(testsFailed > 0 ? 1 : 0);
