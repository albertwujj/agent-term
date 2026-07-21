const {
  findAnchorForLine,
  getSectionHierarchyForLine,
  renderMarkdownDocument,
} = require('../src/markdown-render');

let passed = 0;
let failed = 0;
const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

function assertEqual(actual, expected, msg = '') {
  const actualStr = JSON.stringify(actual);
  const expectedStr = JSON.stringify(expected);
  if (actualStr !== expectedStr) {
    throw new Error(`${msg}\n    Expected: ${expectedStr}\n    Actual:   ${actualStr}`);
  }
}

async function runTests() {
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`PASS ${name}`);
      passed++;
    } catch (e) {
      console.log(`FAIL ${name}`);
      console.log(`  ${e.message}`);
      failed++;
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

console.log('\n--- markdown render ---\n');

test('renders markdown HTML with anchor metadata on blocks', () => {
  const doc = renderMarkdownDocument([
    '# Title',
    '',
    'First paragraph.',
    '',
    '- item one',
  ].join('\n'));

  assert(doc.html.includes('<h1'), 'heading should render');
  assert(doc.html.includes('<p'), 'paragraph should render');
  assert(doc.html.includes('data-md-anchor-id='), 'anchors should be embedded');
  assert(doc.anchors.length >= 3, 'expected heading, paragraph, and list anchors');
});

test('findAnchorForLine prefers the closest rendered block for a source line', () => {
  const doc = renderMarkdownDocument([
    '# Title',
    '',
    'Line one of a paragraph',
    'line two of the same paragraph.',
    '',
    'Next paragraph.',
  ].join('\n'));

  const anchor = findAnchorForLine(doc.anchors, 4);
  assert(anchor, 'expected anchor');
  assertEqual(anchor.type, 'paragraph_open');
  assertEqual(anchor.startLine, 3);
  assertEqual(anchor.endLine, 4);
});

test('findAnchorForLine falls forward when the requested line is blank', () => {
  const doc = renderMarkdownDocument([
    '# Title',
    '',
    'Paragraph after blank.',
  ].join('\n'));

  const anchor = findAnchorForLine(doc.anchors, 2);
  assert(anchor, 'expected anchor');
  assertEqual(anchor.startLine, 3);
});

test('extracts section hierarchy for a target line', () => {
  const doc = renderMarkdownDocument([
    '# Top',
    '',
    'Intro.',
    '',
    '## Details',
    '',
    'Text.',
  ].join('\n'));

  assertEqual(getSectionHierarchyForLine(doc.headings, 7), ['Top', 'Details']);
  assertEqual(getSectionHierarchyForLine(doc.headings, 3), ['Top']);
});

test('renders fenced code as an anchored pre block', () => {
  const doc = renderMarkdownDocument([
    '```js',
    'const x = 1;',
    '```',
  ].join('\n'));

  const anchor = findAnchorForLine(doc.anchors, 2);
  assert(anchor, 'expected code anchor');
  assertEqual(anchor.type, 'fence');
  assert(doc.html.includes('<pre'), 'expected pre tag');
  assert(doc.html.includes('data-source-start-line="1"'), 'pre should carry line metadata');
});

test('rewrites relative image srcs against the doc directory with a version query', () => {
  const doc = renderMarkdownDocument(
    '![chart](images/chart.png)',
    { rootUrl: 'file://', docDir: '/home/andy/proj', version: 1234 },
  );

  assert(
    doc.html.includes('src="file:///home/andy/proj/images/chart.png?v=1234"'),
    `expected rewritten src, got: ${doc.html}`,
  );
});

test('rewrites absolute image srcs against the platform root URL', () => {
  const doc = renderMarkdownDocument(
    '![chart](/home/andy/out/chart.png)',
    { rootUrl: 'file://wsl.localhost/Ubuntu', docDir: '/home/andy/proj' },
  );

  assert(
    doc.html.includes('src="file://wsl.localhost/Ubuntu/home/andy/out/chart.png"'),
    `expected UNC file URL, got: ${doc.html}`,
  );
});

test('normalizes dot segments in image paths', () => {
  const doc = renderMarkdownDocument(
    '![chart](../assets/./chart.png)',
    { rootUrl: 'file://', docDir: '/home/andy/proj/docs' },
  );

  assert(
    doc.html.includes('src="file:///home/andy/proj/assets/chart.png"'),
    `expected normalized path, got: ${doc.html}`,
  );
});

test('leaves remote image srcs untouched', () => {
  const doc = renderMarkdownDocument(
    '![remote](https://example.com/pic.png)',
    { rootUrl: 'file://', docDir: '/home/andy', version: 99 },
  );

  assert(
    doc.html.includes('src="https://example.com/pic.png"'),
    `expected untouched remote src, got: ${doc.html}`,
  );
  assert(!doc.html.includes('v=99'), 'remote src should not get a version query');
});

test('leaves image srcs untouched without image options', () => {
  const doc = renderMarkdownDocument('![chart](images/chart.png)');

  assert(
    doc.html.includes('src="images/chart.png"'),
    `expected raw src, got: ${doc.html}`,
  );
});

test('does not double-encode pre-encoded image paths', () => {
  const doc = renderMarkdownDocument(
    '![shot](<my shot.png>)',
    { rootUrl: 'file://', docDir: '/home/andy' },
  );

  assert(
    doc.html.includes('src="file:///home/andy/my%20shot.png"'),
    `expected single-encoded src, got: ${doc.html}`,
  );
});

runTests();
