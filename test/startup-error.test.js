const assert = require('assert');
const { startupErrorHtml } = require('../src/startup-error');

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

console.log('startup-error');

test('carries the heading, the detail, and the command to run', () => {
  const html = startupErrorHtml({
    heading: 'The build failed, so AgentTerm did not start',
    output: 'src/renderer.js:12:3: ERROR: Expected ")" but found "}"',
    command: 'npm run start',
  });
  assert.ok(html.includes('The build failed, so AgentTerm did not start'));
  assert.ok(html.includes('Expected &quot;)&quot; but found &quot;}&quot;'));
  assert.ok(html.includes('npm run start'));
});

test('loads no script and no generated bundle', () => {
  // The case this page exists for is the bundles being absent: the build
  // removes every artifact before compiling, so a page that needed one would
  // be blank exactly when it is needed.
  const html = startupErrorHtml({ heading: 'h', detail: 'd', command: 'c' });
  assert.ok(!/<script/i.test(html), 'no script tag');
  assert.ok(!html.includes('dist/'), 'no generated bundle');
});

test('tool output keeps its own block, prose does not', () => {
  const compiler = startupErrorHtml({ heading: 'h', output: 'a:1:2 ERROR', command: 'c' });
  assert.ok(compiler.includes('<pre>a:1:2 ERROR</pre>'), 'output is preformatted');
  const prose = startupErrorHtml({ heading: 'h', detail: 'A sentence.', command: 'c' });
  assert.ok(prose.includes('<p>A sentence.</p>'), 'prose is a paragraph');
  assert.ok(!prose.includes('<pre>'), 'prose gets no monospace block');
});

test('escapes a build error that contains markup', () => {
  const html = startupErrorHtml({
    heading: 'h',
    output: '<img src=x onerror="boom()">',
    command: 'c',
  });
  assert.ok(!html.includes('<img'), 'the error text is not markup');
  assert.ok(html.includes('&lt;img src=x onerror=&quot;boom()&quot;&gt;'));
});

console.log(`\n${testsPassed} passed, ${testsFailed} failed`);
process.exit(testsFailed > 0 ? 1 : 0);
