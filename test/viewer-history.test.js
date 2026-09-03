const assert = require('assert');
const {
  ViewerHistory,
  ViewerStreamAccumulator,
  ViewerValidationMemory,
  analyzeRendererWrappedDocument,
  collectBufferViewerCandidates,
  collectBufferViewerMatchRows,
  extractViewerCandidateMatches,
  extractViewerCandidates,
  stripTerminalSequences,
  viewerFileUrlToPath,
} = require('../src/viewer-history');

let passed = 0;
let failed = 0;
const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

function keys(entries) {
  return entries.map((entry) => `${entry.kind}:${entry.key}`);
}

function fakeBuffer(lines) {
  return {
    length: lines.length,
    getLine(index) {
      const line = lines[index];
      return line && {
        isWrapped: !!line.wrapped,
        translateToString: () => line.text,
      };
    },
  };
}

async function run() {
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`✓ ${name}`);
      passed++;
    } catch (error) {
      console.log(`✗ ${name}`);
      console.log(`  ${error.stack || error.message}`);
      failed++;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

test('extracts every URL and bare markdown path in text order', () => {
  assert.deepStrictEqual(
    keys(extractViewerCandidates('See README.md, https://one.example/page and docs/guide.markdown.')),
    ['md:README.md', 'url:https://one.example/page', 'md:docs/guide.markdown']
  );
});

test('does not duplicate markdown paths inside URL candidates', () => {
  assert.deepStrictEqual(
    keys(extractViewerCandidates('review:///tmp/report.md file:///tmp/notes.md')),
    ['review:review:///tmp/report.md', 'url:file:///tmp/notes.md']
  );
});

test('a review link printed with a space before its path is one canonical candidate', () => {
  assert.deepStrictEqual(
    keys(extractViewerCandidates('review:// /home/me/.git/review/work/work.md')),
    ['review:review:///home/me/.git/review/work/work.md']
  );
});

test('reconstructs a review package hard-wrapped by a terminal renderer', () => {
  const expected = 'review:///home/me/.git/review/work-long-name/work-long-name.md';
  const rendered = 'review:///home/me/.git/review/work-long-name/work-long-na    \r\n  me.md.\r\n';
  assert.deepStrictEqual(keys(extractViewerCandidates(rendered)), [`review:${expected}`]);
});

test('reconstructs a hard-wrapped explicit markdown path', () => {
  assert.deepStrictEqual(
    keys(extractViewerCandidates('/home/me/docs/architecture-not  \n  es.md\n')),
    ['md:/home/me/docs/architecture-notes.md']
  );
});

test('a continuation gutter is sufficient without trailing row padding', () => {
  const rendered = 'review:///tmp/work-na\n  me.md\n';
  assert.deepStrictEqual(
    keys(extractViewerCandidates(rendered)),
    ['review:review:///tmp/work-name.md']
  );
  assert.strictEqual(extractViewerCandidateMatches(rendered)[0].rendererWrapped, true);
});

test('does not join a hard newline without a continuation gutter', () => {
  assert.deepStrictEqual(
    keys(extractViewerCandidates('review:///tmp/work-na\nme.md\n')),
    ['review:review:///tmp/work-na', 'md:me.md']
  );
});

test('reconstructs a padded review link following a short label', () => {
  assert.deepStrictEqual(
    keys(extractViewerCandidates('Open review:///tmp/work-na  \n  me.md\n')),
    ['review:review:///tmp/work-name.md']
  );
});

test('reconstructs a review when the md suffix straddles the hard wrap', () => {
  assert.deepStrictEqual(
    keys(extractViewerCandidates('review:///tmp/work-name.m  \n  d\n')),
    ['review:review:///tmp/work-name.md']
  );
  assert.deepStrictEqual(
    keys(extractViewerCandidates('review:///tmp/work-name.  \n  md\n')),
    ['review:review:///tmp/work-name.md']
  );
});

test('recognizes Cursor vertical gutters as renderer wrap geometry', () => {
  assert.deepStrictEqual(
    keys(extractViewerCandidates('│ review:///tmp/work-na │\n│ me.md │\n')),
    ['review:review:///tmp/work-name.md']
  );
});

test('does not guess across a hard newline in a web URL', () => {
  assert.deepStrictEqual(
    keys(extractViewerCandidates('https://example.test/long-pa\n  th\n')),
    ['url:https://example.test/long-pa']
  );
});

test('does not join an already-complete review with the next indented document', () => {
  assert.deepStrictEqual(
    keys(extractViewerCandidates('review:///tmp/complete.md\n  notes.md\n')),
    ['review:review:///tmp/complete.md', 'md:notes.md']
  );
});

test('the same package printed both ways is one entry', () => {
  const stream = new ViewerStreamAccumulator();
  assert.deepStrictEqual(
    keys(stream.push('review:// /tmp/pkg.md\r\nreview:///tmp/pkg.md\r\n')),
    ['review:review:///tmp/pkg.md']
  );
  assert.deepStrictEqual(keys(stream.entries()), ['review:review:///tmp/pkg.md']);
});

test('prose about the scheme is not a package', () => {
  assert.deepStrictEqual(
    keys(extractViewerCandidates('Click the review:// link the agent printed.')),
    []
  );
});

test('file URL paths map local and WSL-hosted documents to POSIX paths', () => {
  assert.strictEqual(viewerFileUrlToPath('file:///tmp/report.html'), '/tmp/report.html');
  assert.strictEqual(
    viewerFileUrlToPath('file://wsl.localhost/Ubuntu/home/me/report.html'),
    '/home/me/report.html'
  );
});

test('extracts line-anchored and WSL UNC markdown paths', () => {
  assert.deepStrictEqual(
    keys(extractViewerCandidates('README.mdown:42 \\\\wsl.localhost\\Ubuntu\\home\\me\\plan.md')),
    ['md:README.mdown', 'md:/home/me/plan.md']
  );
});

test('strips OSC and CSI controls while preserving rendered text', () => {
  const styled = '\x1b]7;file://host/tmp\x07\x1b[34mUpdate(\x1b[1mplan.md\x1b[0m)';
  assert.strictEqual(stripTerminalSequences(styled), 'Update(plan.md)');
});

test('stream accumulator joins candidates split across chunks', () => {
  const stream = new ViewerStreamAccumulator();
  assert.deepStrictEqual(stream.push('open https://exa'), []);
  assert.deepStrictEqual(keys(stream.push('mple.test/report\r\n')), ['url:https://example.test/report']);
  assert.deepStrictEqual(keys(stream.entries()), ['url:https://example.test/report']);
});

test('stream accumulator waits for a hard-wrapped review continuation', () => {
  const stream = new ViewerStreamAccumulator();
  const head = 'review:///home/me/.git/review/work-long-name/work-long-na';
  assert.deepStrictEqual(stream.push(`${head}\r\n`), []);
  for (const character of '  me.md') assert.deepStrictEqual(stream.push(character), []);
  assert.deepStrictEqual(keys(stream.push('\r\n')), [
    'review:review:///home/me/.git/review/work-long-name/work-long-name.md',
  ]);
  assert.deepStrictEqual(
    keys(stream.entries()),
    ['review:review:///home/me/.git/review/work-long-name/work-long-name.md']
  );
});

test('stream accumulator commits a boundary candidate when its delimiter arrives', () => {
  const stream = new ViewerStreamAccumulator();
  assert.deepStrictEqual(stream.push('https://whole.example/path'), []);
  assert.deepStrictEqual(keys(stream.push('\r\n')), ['url:https://whole.example/path']);
  assert.deepStrictEqual(keys(stream.entries()), ['url:https://whole.example/path']);
});

test('per-keystroke echo records no truncated ghost candidates', () => {
  const stream = new ViewerStreamAccumulator();
  // Interactive typing: every character is its own PTY chunk. The dots after
  // "code" and "example" used to commit "https://code" and
  // "https://code.example" as ghosts (the regex trims trailing punctuation,
  // so those matches looked delimiter-terminated).
  for (const ch of 'echo https://code.example.com/c/agent-term/+/42') {
    assert.deepStrictEqual(stream.push(ch), []);
  }
  assert.deepStrictEqual(
    keys(stream.push('\r\n')),
    ['url:https://code.example.com/c/agent-term/+/42']
  );
  assert.deepStrictEqual(keys(stream.entries()), ['url:https://code.example.com/c/agent-term/+/42']);
});

test('sentence-final punctuation inside one chunk still commits immediately', () => {
  const stream = new ViewerStreamAccumulator();
  assert.deepStrictEqual(
    keys(stream.push('see https://a.example/doc.\r\n')),
    ['url:https://a.example/doc']
  );
});

test('a candidate deferred behind trailing punctuation commits on its delimiter', () => {
  const stream = new ViewerStreamAccumulator();
  assert.deepStrictEqual(stream.push('see https://a.example/doc.'), []);
  assert.deepStrictEqual(keys(stream.push('\r\n')), ['url:https://a.example/doc']);
});

test('a markdown path typed per-keystroke commits once, whole', () => {
  const stream = new ViewerStreamAccumulator();
  for (const ch of 'cat docs/august.plan.md') {
    assert.deepStrictEqual(stream.push(ch), []);
  }
  assert.deepStrictEqual(keys(stream.push('\r\n')), ['md:docs/august.plan.md']);
});

test('stream accumulator joins a URL across a chunk-split ANSI sequence', () => {
  const stream = new ViewerStreamAccumulator();
  assert.deepStrictEqual(stream.push('open https://exa\x1b[3'), []);
  stream.push('1mmple.test/report\x1b[0m\r\n');
  assert.deepStrictEqual(keys(stream.entries()), ['url:https://example.test/report']);
});

test('stream accumulator extracts ANSI-styled bare markdown paths', () => {
  const stream = new ViewerStreamAccumulator();
  stream.push('\x1b[36mEdit(\x1b[1mdocs/plan.md\x1b[0m)\r\n');
  assert.deepStrictEqual(keys(stream.entries()), ['md:docs/plan.md']);
});

test('stream accumulator retains OSC 8 URL targets from alt-screen output', () => {
  const stream = new ViewerStreamAccumulator();
  stream.push('\x1b]8;;https://hidden.example/review\x07open review\x1b]8;;\x07');
  assert.deepStrictEqual(keys(stream.entries()), ['url:https://hidden.example/review']);
});

test('alt-screen repaint controls terminate the preceding candidate', () => {
  const stream = new ViewerStreamAccumulator();
  stream.push('https://before-repaint.example/page\x1b[2Jreplacement frame');
  assert.deepStrictEqual(keys(stream.entries()), ['url:https://before-repaint.example/page']);
});

test('stream accumulator retains all same-kind entries newest first', () => {
  const stream = new ViewerStreamAccumulator();
  stream.push('https://one.example/a\r\n');
  stream.push('https://two.example/b\r\n');
  stream.push('https://three.example/c\r\n');
  assert.deepStrictEqual(keys(stream.entries()), [
    'url:https://three.example/c',
    'url:https://two.example/b',
    'url:https://one.example/a',
  ]);
});

test('buffer collector rebuilds soft wraps and returns newest/rightmost first', () => {
  const buffer = fakeBuffer([
    { text: 'old https://old.example/page' },
    { text: 'new docs/plan.md https://new.exam' },
    { text: 'ple/page', wrapped: true },
  ]);
  assert.deepStrictEqual(keys(collectBufferViewerCandidates(buffer)), [
    'url:https://new.example/page',
    'md:docs/plan.md',
    'url:https://old.example/page',
  ]);
});

test('buffer collector reconstructs hard-wrapped local document targets', () => {
  const buffer = fakeBuffer([
    { text: 'review:///home/me/.git/review/work-long-name/work-long-na' },
    { text: '  me.md' },
    { text: '/home/me/docs/architecture-not' },
    { text: '  es.md' },
  ]);
  assert.deepStrictEqual(keys(collectBufferViewerCandidates(buffer)), [
    'md:/home/me/docs/architecture-notes.md',
    'review:review:///home/me/.git/review/work-long-name/work-long-name.md',
  ]);
  assert.deepStrictEqual(
    collectBufferViewerCandidates(buffer).map((entry) => entry.rendererWrapped),
    [true, true]
  );
});

test('renderer-wrapped analysis maps a resize-soft-wrapped head to physical rows', () => {
  const buffer = fakeBuffer([
    { text: 'review:///home/me/.git/review/work-long-' },
    { text: 'name/work-long-na  ', wrapped: true },
    { text: '  me.md    ' },
  ]);

  const analysis = analyzeRendererWrappedDocument(buffer, 0);
  assert(analysis);
  assert.strictEqual(
    analysis.entry.key,
    'review:///home/me/.git/review/work-long-name/work-long-name.md'
  );
  assert.strictEqual(analysis.tailRow, 2);
  assert.deepStrictEqual(analysis.segments.map((segment) => segment.row), [0, 1, 2]);
  assert.strictEqual(
    analysis.segments.map((segment) => segment.text).join(''),
    analysis.entry.key
  );
});

test('history keeps every individual entry rather than one per kind', () => {
  const history = new ViewerHistory();
  history.merge([
    { kind: 'url', key: 'A' },
    { kind: 'url', key: 'B' },
    { kind: 'md', key: 'C.md' },
  ]);
  assert.deepStrictEqual(keys(history.entries()), ['url:A', 'url:B', 'md:C.md']);
});

test('back walks A B C one by one and wraps without reordering', () => {
  const history = new ViewerHistory();
  history.merge([
    { kind: 'url', key: 'A' },
    { kind: 'url', key: 'B' },
    { kind: 'url', key: 'C' },
  ]);
  const visited = [];
  for (let index = 0; index < 4; index++) {
    const next = history.traverse('back')[0];
    visited.push(next.key);
    history.select(next);
  }
  assert.deepStrictEqual(visited, ['A', 'B', 'C', 'A']);
  assert.deepStrictEqual(keys(history.entries()), ['url:A', 'url:B', 'url:C']);
});

test('forward exactly reverses back traversal', () => {
  const history = new ViewerHistory();
  history.merge([
    { kind: 'url', key: 'A' },
    { kind: 'url', key: 'B' },
    { kind: 'url', key: 'C' },
  ]);
  history.select({ kind: 'url', key: 'A' });
  const visited = ['A'];
  for (let index = 0; index < 3; index++) {
    const next = history.traverse('forward')[0];
    visited.push(next.key);
    history.select(next);
  }
  assert.deepStrictEqual(visited, ['A', 'C', 'B', 'A']);
});

test('removing an invalid traversal candidate leaves the cursor anchored', () => {
  const history = new ViewerHistory();
  history.merge([
    { kind: 'md', key: 'missing.md' },
    { kind: 'url', key: 'valid' },
  ]);
  const invalid = history.traverse('back')[0];
  history.remove(invalid);
  const valid = history.traverse('back')[0];
  assert.deepStrictEqual(valid, { kind: 'url', key: 'valid' });
});

test('negative validation stays rejected until a fresh stream sighting', () => {
  const memory = new ViewerValidationMemory();
  const missing = { kind: 'md', key: 'missing.md' };
  const other = { kind: 'md', key: 'other.md' };

  memory.reject(missing);
  assert.strictEqual(memory.isRejected(missing), true);
  assert.strictEqual(memory.isRejected(other), false);

  memory.observe(missing);
  assert.strictEqual(memory.isRejected(missing), false);
});

test('explicit opens become newest while source merge preserves current identity', () => {
  const history = new ViewerHistory();
  history.merge([{ kind: 'url', key: 'A' }, { kind: 'url', key: 'B' }]);
  history.select({ kind: 'url', key: 'B' });
  history.record({ kind: 'md', key: 'C.md' });
  history.merge([{ kind: 'url', key: 'A' }, { kind: 'url', key: 'B' }]);
  assert.deepStrictEqual(history.current, { kind: 'md', key: 'C.md' });
  assert.deepStrictEqual(keys(history.entries()), ['url:A', 'url:B', 'md:C.md']);
});

test('match rows list every copy of a link with the row it starts on', () => {
  const link = 'review:///repo/.git/review/main/main.md';
  const rows = (buffer, startRow) => collectBufferViewerMatchRows(buffer, startRow)
    .filter(({ entry }) => entry.kind === 'review' && entry.key === link)
    .map(({ row }) => row);
  assert.deepStrictEqual(rows(fakeBuffer([])), []);
  assert.deepStrictEqual(rows(fakeBuffer([
    { text: `Review: ${link}` },
    { text: 'other output' },
    { text: `Updated the review: ${link}` },
    { text: `${link} and ${link}` },
  ])), [0, 2, 3, 3]);
});

test('a soft-wrapped copy and the tolerated spaced form are one match each on their head row', () => {
  const link = 'review:///repo/.git/review/feature/feature.md';
  const buffer = fakeBuffer([
    { text: 'noise' },
    { text: 'Review: review:///repo/.git/review/' },
    { text: 'feature/feature.md', wrapped: true },
    { text: 'Again: review:// /repo/.git/review/feature/feature.md' },
  ]);
  assert.deepStrictEqual(collectBufferViewerMatchRows(buffer), [
    { entry: { kind: 'review', key: link }, row: 1 },
    { entry: { kind: 'review', key: link }, row: 3 },
  ]);
});

test('a renderer hard-wrapped copy is one match on its head row', () => {
  const buffer = fakeBuffer([
    { text: 'Review: review:///repo/.git/review/feature/' },
    { text: '  feature.md' },
  ]);
  assert.deepStrictEqual(collectBufferViewerMatchRows(buffer), [
    { entry: { kind: 'review', key: 'review:///repo/.git/review/feature/feature.md', rendererWrapped: true }, row: 0 },
  ]);
});

test('a window start inside a wrapped line widens to the line start', () => {
  const link = 'review:///repo/.git/review/main/main.md';
  const buffer = fakeBuffer([
    { text: `old: ${link}` },
    { text: 'Review: review:///repo/.git/review/' },
    { text: 'main/main.md', wrapped: true },
    { text: 'tail' },
  ]);
  const keys = (startRow) => collectBufferViewerMatchRows(buffer, startRow).map(({ entry, row }) => `${row}:${entry.key}`);
  assert.deepStrictEqual(keys(2), [`1:${link}`]);
  assert.deepStrictEqual(keys(3), []);
  assert.deepStrictEqual(keys(0), [`0:${link}`, `1:${link}`]);
});

run();
