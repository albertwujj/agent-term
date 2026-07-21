const assert = require('assert');
const { JSDOM } = require('jsdom');

const {
  renderHintMarkup,
  recordSubmit,
  show,
  destroy,
} = require('../src/resume-hint');

let testsPassed = 0;
let testsFailed = 0;

function fragment(html) {
  return new JSDOM(`<div id="root">${html}</div>`).window.document;
}

function installDom() {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>');
  global.window = dom.window;
  global.document = dom.window.document;
  window.pty = { cancelResumeIntercept: () => {} };
  return dom;
}

function test(name, fn) {
  try { fn(); testsPassed++; console.log(`  ✓ ${name}`); }
  catch (err) {
    testsFailed++;
    console.log(`  ✗ ${name}`);
    console.log(`      ${err.message}`);
  }
}

console.log('resume-hint');

test('points to the prompt above without repeating prompt text', () => {
  const html = renderHintMarkup({
    prompt: 'Fix auth retry handling',
    title: 'Auth retry work',
  });
  const doc = fragment(html);

  assert.strictEqual(doc.querySelector('.at-resume-hint-primary').textContent, 'the prompt above');
  assert.strictEqual(doc.querySelector('.at-resume-hint-extra').textContent, ', or try');
  assert.strictEqual(doc.querySelector('.at-resume-hint-title').textContent, 'Auth retry work');
  assert.ok(!html.includes('Fix auth retry handling'));
});

test('omits title alternative when it matches the prompt', () => {
  const html = renderHintMarkup({
    prompt: 'Fix auth retry handling',
    title: 'Fix auth retry handling',
  });
  const doc = fragment(html);

  assert.strictEqual(doc.querySelector('.at-resume-hint-primary').textContent, 'the prompt above');
  assert.strictEqual(doc.querySelector('.at-resume-hint-extra'), null);
  assert.strictEqual(doc.querySelector('.at-resume-hint-title'), null);
  assert.ok(!html.includes('Fix auth retry handling'));
});

test('omits branded title alternative when it cleans to the prompt', () => {
  const html = renderHintMarkup({
    cli: 'claude',
    prompt: 'Fix auth retry handling',
    title: '\u2733 Claude Code \u00b7 Fix auth retry handling',
  });
  const doc = fragment(html);

  assert.strictEqual(doc.querySelector('.at-resume-hint-primary').textContent, 'the prompt above');
  assert.strictEqual(doc.querySelector('.at-resume-hint-extra'), null);
  assert.strictEqual(doc.querySelector('.at-resume-hint-title'), null);
  assert.ok(!html.includes('Fix auth retry handling'));
});

test('shows cleaned branded title when it is distinct from the prompt', () => {
  const html = renderHintMarkup({
    cli: 'claude',
    prompt: 'Fix auth retry handling',
    title: '\u2733 Claude Code \u00b7 Auth retry investigation',
  });
  const doc = fragment(html);

  assert.strictEqual(doc.querySelector('.at-resume-hint-primary').textContent, 'the prompt above');
  assert.strictEqual(doc.querySelector('.at-resume-hint-extra').textContent, ', or try');
  assert.strictEqual(doc.querySelector('.at-resume-hint-title').textContent, 'Auth retry investigation');
  assert.ok(!html.includes('Claude Code'));
  assert.ok(!html.includes('\u2733'));
});

test('keeps title-only fallback for callers without prompt context', () => {
  const html = renderHintMarkup('Auth retry work');
  const doc = fragment(html);

  assert.strictEqual(doc.querySelector('.at-resume-hint-primary'), null);
  assert.strictEqual(doc.querySelector('.at-resume-hint-title').textContent, 'Auth retry work');
});

test('submit notifications transition then auto-dismiss the mounted hint', () => {
  installDom();
  show({
    prompt: 'Fix auth retry handling',
    title: 'Auth retry work',
  });

  const root = document.querySelector('.at-resume-hint');
  assert.ok(root, 'hint should mount');
  assert.ok(!root.classList.contains('post-enter'));

  recordSubmit();
  assert.ok(root.classList.contains('post-enter'), 'first submit should switch to post-enter copy');
  assert.strictEqual(document.querySelector('.at-resume-hint'), root);

  recordSubmit();
  assert.strictEqual(document.querySelector('.at-resume-hint'), root);

  recordSubmit();
  assert.strictEqual(document.querySelector('.at-resume-hint'), null, 'third submit should dismiss');

  destroy({ cancelIntercept: false });
  delete global.window;
  delete global.document;
});

if (testsFailed > 0) {
  console.error(`${testsFailed} resume-hint test(s) failed`);
  process.exit(1);
}
console.log(`${testsPassed} resume-hint tests passed`);
