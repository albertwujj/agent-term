const assert = require('assert');
const { classifyMarkdownLink } = require('../src/md-link-target');

const DOC = '/home/andy/notes/guide/setup.md';

function run() {
  // Web links stay web links.
  assert.deepStrictEqual(classifyMarkdownLink('https://example.com/x', DOC),
    { kind: 'external', url: 'https://example.com/x' });
  assert.deepStrictEqual(classifyMarkdownLink('http://example.com', DOC),
    { kind: 'external', url: 'http://example.com' });

  // In-doc anchors.
  assert.deepStrictEqual(classifyMarkdownLink('#install', DOC), { kind: 'fragment', fragment: 'install' });

  // Relative paths resolve against the doc's own directory.
  assert.deepStrictEqual(classifyMarkdownLink('./other.md', DOC),
    { kind: 'path', path: '/home/andy/notes/guide/other.md' });
  assert.deepStrictEqual(classifyMarkdownLink('other.md', DOC),
    { kind: 'path', path: '/home/andy/notes/guide/other.md' });
  assert.deepStrictEqual(classifyMarkdownLink('../README.md', DOC),
    { kind: 'path', path: '/home/andy/notes/README.md' });
  assert.deepStrictEqual(classifyMarkdownLink('../../top.md', DOC),
    { kind: 'path', path: '/home/andy/top.md' });
  assert.deepStrictEqual(classifyMarkdownLink('sub/deep.md', DOC),
    { kind: 'path', path: '/home/andy/notes/guide/sub/deep.md' });

  // Absolute paths are taken as written.
  assert.deepStrictEqual(classifyMarkdownLink('/etc/hosts', DOC), { kind: 'path', path: '/etc/hosts' });
  assert.deepStrictEqual(classifyMarkdownLink('/a/../b/./c.md', DOC), { kind: 'path', path: '/b/c.md' });

  // The destination's fragment/query belong to that doc, not to its file name.
  assert.deepStrictEqual(classifyMarkdownLink('./other.md#section', DOC),
    { kind: 'path', path: '/home/andy/notes/guide/other.md' });
  assert.deepStrictEqual(classifyMarkdownLink('./other.md?v=2', DOC),
    { kind: 'path', path: '/home/andy/notes/guide/other.md' });

  // markdown-it percent-encodes destinations.
  assert.deepStrictEqual(classifyMarkdownLink('./my%20notes.md', DOC),
    { kind: 'path', path: '/home/andy/notes/guide/my notes.md' });
  assert.deepStrictEqual(classifyMarkdownLink('./100%.md', DOC),
    { kind: 'path', path: '/home/andy/notes/guide/100%.md' }); // malformed escape keeps the raw text

  // Other schemes are named, not opened. A drive letter is a path, not a scheme.
  assert.deepStrictEqual(classifyMarkdownLink('mailto:a@b.com', DOC), { kind: 'unsupported', href: 'mailto:a@b.com' });
  assert.deepStrictEqual(classifyMarkdownLink('file:///tmp/x.md', DOC), { kind: 'unsupported', href: 'file:///tmp/x.md' });
  assert.strictEqual(classifyMarkdownLink('C:/docs/x.md', DOC).kind, 'path');

  // Nothing to go on.
  assert.deepStrictEqual(classifyMarkdownLink('', DOC), { kind: 'none' });
  assert.deepStrictEqual(classifyMarkdownLink(null, DOC), { kind: 'none' });
  assert.deepStrictEqual(classifyMarkdownLink('./other.md', 'setup.md'), { kind: 'none' });
}

run();
console.log('md-link-target tests passed');
