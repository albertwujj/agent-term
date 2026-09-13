const assert = require('assert');

const {
  MENTIONED_FOLDERS_MAX,
  extractMentionedFolders,
  foldersOfToken,
  mentionedFolderCandidates,
  sanitizeMentionedFolders,
} = require('../src/mentioned-folders');

let testsPassed = 0;
let testsFailed = 0;

function test(name, fn) {
  try { fn(); testsPassed++; console.log(`  ✓ ${name}`); }
  catch (err) {
    testsFailed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n    ') : err}`);
  }
}

const SCRATCH = '/private/tmp/claude-502/-Users-me-repo/0349-uuid/scratchpad';

console.log('mentioned-folders: foldersOfToken');

test('a file path stands for its parent', () => {
  assert.deepStrictEqual(foldersOfToken(`${SCRATCH}/scan.py`), [SCRATCH]);
});

test('a directory-looking path stands for itself and its parent', () => {
  assert.deepStrictEqual(foldersOfToken('/tmp/work/out'), ['/tmp/work/out', '/tmp/work']);
  assert.deepStrictEqual(foldersOfToken('/tmp'), ['/tmp']);
});

test('trailing line refs, punctuation and slashes come off', () => {
  assert.deepStrictEqual(foldersOfToken('/tmp/a/b.py:12:3'), ['/tmp/a']);
  assert.deepStrictEqual(foldersOfToken('/tmp/a/b.py,'), ['/tmp/a']);
  assert.deepStrictEqual(foldersOfToken('/tmp/work/out/'), ['/tmp/work/out', '/tmp/work']);
});

test('an abbreviated path names nothing', () => {
  assert.deepStrictEqual(foldersOfToken('…/scratchpad/mock.png'), []);
  assert.deepStrictEqual(foldersOfToken('/private/tmp/…/scratchpad/mock.png'), []);
  assert.deepStrictEqual(foldersOfToken('/private/tmp/.../scratchpad/mock.png'), []);
});

test('the root alone names nothing', () => {
  assert.deepStrictEqual(foldersOfToken('/'), []);
  assert.deepStrictEqual(foldersOfToken('~/'), []);
});

test('~ paths keep their prefix', () => {
  assert.deepStrictEqual(foldersOfToken('~/agent-term/docs/setup.md'), ['~/agent-term/docs']);
  assert.deepStrictEqual(foldersOfToken('~/launch'), ['~/launch']);
});

test('Windows drive and WSL UNC paths become their POSIX forms', () => {
  assert.deepStrictEqual(foldersOfToken('C:\\Temp\\out\\shot.png'), ['/mnt/c/Temp/out']);
  assert.deepStrictEqual(foldersOfToken('D:/work/out'), ['/mnt/d/work/out', '/mnt/d/work']);
  assert.deepStrictEqual(foldersOfToken('\\\\wsl.localhost\\Ubuntu\\home\\me\\notes.md'), ['/home/me']);
});

console.log('mentioned-folders: extractMentionedFolders');

test('a tool header above the click yields the folder it wrote to', () => {
  const lines = [
    { row: 3, text: `⏺ Write(${SCRATCH}/mock.png)` },
    { row: 4, text: '  ⎿  Wrote 1 line' },
    { row: 8, text: 'The mock is at `mock.png`, take a look.' },
  ];
  assert.deepStrictEqual(extractMentionedFolders(lines, 8), [SCRATCH]);
});

test('nearest mention above the click comes first, then further up, then below', () => {
  const lines = [
    { row: 2, text: 'cp /a/one.png /a/two.png' },
    { row: 10, text: 'python3 /b/render.py' },
    { row: 12, text: 'saved sheet.png' },
    { row: 20, text: 'see /c/three.png' },
  ];
  assert.deepStrictEqual(extractMentionedFolders(lines, 12), ['/b', '/a', '/c']);
});

test('a mention on the clicked row counts as above it', () => {
  const lines = [
    { row: 1, text: 'ls /old/dir' },
    { row: 5, text: `Write(${SCRATCH}/a.png) ... a.png` },
  ];
  assert.deepStrictEqual(extractMentionedFolders(lines, 5), [SCRATCH, '/old/dir', '/old']);
});

test('URL paths and relative paths are not folders', () => {
  const lines = [
    { row: 1, text: 'see https://example.com/docs/guide.md and file:///srv/x/y.md' },
    { row: 2, text: 'edit ./src/foo.js and ../sibling/out/x.png and src/a/b.js' },
    { row: 3, text: 'a/b/c.txt 12/09/2026 //comment' },
  ];
  assert.deepStrictEqual(extractMentionedFolders(lines, 3), []);
});

test('paths inside quotes, backticks and parentheses are found', () => {
  const lines = [
    { row: 1, text: 'Saved to `/tmp/one/a.png` and "/tmp/two/b.png" (/tmp/three/c.png).' },
  ];
  assert.deepStrictEqual(extractMentionedFolders(lines, 1), ['/tmp/one', '/tmp/two', '/tmp/three']);
});

test('each folder is listed once and the list is capped', () => {
  const lines = [];
  for (let i = 0; i < 200; i++) lines.push({ row: i, text: `Write(/tmp/f${i}/x.py) Write(/tmp/f${i}/y.py)` });
  const out = extractMentionedFolders(lines, 199);
  assert.strictEqual(out.length, MENTIONED_FOLDERS_MAX);
  assert.strictEqual(out[0], '/tmp/f199');
  assert.strictEqual(new Set(out).size, out.length);
});

test('no click row means the whole scrollback in row order', () => {
  const lines = [{ row: 1, text: '/a/x.png' }, { row: 2, text: '/b/y.png' }];
  assert.deepStrictEqual(extractMentionedFolders(lines, undefined), ['/b', '/a']);
});

console.log('mentioned-folders: mentionedFolderCandidates');

test('a bare name is tried inside each folder in order', () => {
  assert.deepStrictEqual(
    mentionedFolderCandidates([SCRATCH, '/tmp/other'], 'mock.png'),
    [`${SCRATCH}/mock.png`, '/tmp/other/mock.png'],
  );
});

test('a printed tail resolves against the folder it names, overlap first', () => {
  const out = mentionedFolderCandidates([SCRATCH], 'scratchpad/mock.png');
  assert.strictEqual(out[0], `${SCRATCH}/mock.png`);
  assert.ok(out.includes(`${SCRATCH}/scratchpad/mock.png`));
});

test('a two-segment tail overlaps the folder tail', () => {
  const out = mentionedFolderCandidates(['/x/session/scratchpad'], 'session/scratchpad/a.png');
  assert.strictEqual(out[0], '/x/session/scratchpad/a.png');
});

test('~ folders expand with home and are skipped without it', () => {
  assert.deepStrictEqual(mentionedFolderCandidates(['~/launch'], 'a.png', { home: '/Users/me' }), ['/Users/me/launch/a.png']);
  assert.deepStrictEqual(mentionedFolderCandidates(['~/launch'], 'a.png'), []);
});

test('parent-relative and absolute names yield nothing', () => {
  assert.deepStrictEqual(mentionedFolderCandidates([SCRATCH], '../a.png'), []);
  assert.deepStrictEqual(mentionedFolderCandidates([SCRATCH], '/abs/a.png'), []);
  assert.deepStrictEqual(mentionedFolderCandidates([SCRATCH], ''), []);
});

test('./ and trailing slashes on the name are ignored', () => {
  assert.deepStrictEqual(mentionedFolderCandidates([SCRATCH], './out/'), [`${SCRATCH}/out`]);
});

test('candidates are unique and capped', () => {
  const folders = [];
  for (let i = 0; i < 100; i++) folders.push(`/tmp/f${i}`);
  const out = mentionedFolderCandidates(folders, 'a.png', { cap: 10 });
  assert.strictEqual(out.length, 10);
  assert.deepStrictEqual(mentionedFolderCandidates(['/a', '/a'], 'x.md'), ['/a/x.md']);
});

console.log('mentioned-folders: sanitizeMentionedFolders');

test('only bounded absolute or ~ strings survive the IPC boundary', () => {
  assert.deepStrictEqual(sanitizeMentionedFolders(null), []);
  assert.deepStrictEqual(sanitizeMentionedFolders('/tmp'), []);
  assert.deepStrictEqual(
    sanitizeMentionedFolders(['/tmp/a', 42, 'rel/x', '~/b', '', ' /tmp/c ', 'x'.repeat(2000)]),
    ['/tmp/a', '~/b', '/tmp/c'],
  );
  const many = Array.from({ length: 100 }, (_, i) => `/tmp/${i}`);
  assert.strictEqual(sanitizeMentionedFolders(many).length, MENTIONED_FOLDERS_MAX);
});

console.log(`\n${testsPassed} passed, ${testsFailed} failed`);
if (testsFailed > 0) process.exit(1);
