const assert = require('assert');
const { JSDOM } = require('jsdom');

const {
  renderHintMarkup,
  recordSubmit,
  recordInterceptOff,
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

test('a distinct title is the chip, with no prompt alternate and no prompt text', () => {
  const html = renderHintMarkup({
    prompt: 'Fix auth retry handling',
    title: 'Auth retry work',
  });
  const doc = fragment(html);

  assert.strictEqual(doc.querySelector('.at-resume-hint-tail.at-resume-hint-chip').textContent, 'Auth retry work');
  assert.strictEqual(doc.querySelector('.at-resume-hint-lead'), null);
  assert.ok(!/prompt above/.test(html), 'strict fallback: no alternate when a title exists');
  assert.ok(!html.includes('Fix auth retry handling'));
});

test('falls back to the prompt above when the title is just the prompt', () => {
  const html = renderHintMarkup({
    prompt: 'Fix auth retry handling',
    title: 'Fix auth retry handling',
  });
  const doc = fragment(html);

  assert.strictEqual(doc.querySelector('.at-resume-hint-tail.at-resume-hint-lead').textContent, 'the prompt above');
  assert.strictEqual(doc.querySelector('.at-resume-hint-chip'), null);
  assert.ok(!html.includes('Fix auth retry handling'));
});

test('falls back to the prompt above when the branded title cleans to the prompt', () => {
  const html = renderHintMarkup({
    cli: 'claude',
    prompt: 'Fix auth retry handling',
    title: '\u2733 Claude Code \u00b7 Fix auth retry handling',
  });
  const doc = fragment(html);

  assert.strictEqual(doc.querySelector('.at-resume-hint-tail.at-resume-hint-lead').textContent, 'the prompt above');
  assert.strictEqual(doc.querySelector('.at-resume-hint-chip'), null);
  assert.ok(!html.includes('Fix auth retry handling'));
});

test('cleaned branded title is the chip when it is distinct from the prompt', () => {
  const html = renderHintMarkup({
    cli: 'claude',
    prompt: 'Fix auth retry handling',
    title: '\u2733 Claude Code \u00b7 Auth retry investigation',
  });
  const doc = fragment(html);

  assert.strictEqual(doc.querySelector('.at-resume-hint-chip').textContent, 'Auth retry investigation');
  assert.strictEqual(doc.querySelector('.at-resume-hint-lead'), null);
  assert.ok(!html.includes('Claude Code'));
  assert.ok(!html.includes('\u2733'));
});

test('title-only callers get the chip', () => {
  const doc = fragment(renderHintMarkup('Auth retry work'));
  assert.strictEqual(doc.querySelector('.at-resume-hint-chip').textContent, 'Auth retry work');
  assert.strictEqual(doc.querySelector('.at-resume-hint-lead'), null);
});

test('no title and no prompt names the session itself', () => {
  const doc = fragment(renderHintMarkup({}));
  assert.strictEqual(doc.querySelector('.at-resume-hint-tail.at-resume-hint-lead').textContent, 'this session');
  assert.strictEqual(doc.querySelector('.at-resume-hint-chip'), null);
});

test('pre-Enter wording says when to press and leaves the filter to later states', () => {
  const doc = fragment(renderHintMarkup({ prompt: 'Fix auth retry handling', title: 'Auth retry work' }));
  const pre = doc.querySelector('.at-resume-hint-pre').textContent;
  assert.ok(pre.startsWith('Wait for the input box'), pre);
  assert.ok(/Enter sends \/resume$/.test(pre), pre);
  assert.ok(!/filter/i.test(pre), 'pre-Enter copy should not mention the filter');
  assert.ok(doc.querySelector('.at-resume-hint-tail'), 'filter tail is present for later states');
  assert.ok(/^Type \/resume once the input box is up·then filter for$/.test(
    doc.querySelector('.at-resume-hint-manual').textContent));
  assert.strictEqual(doc.querySelector('.at-resume-hint-label').textContent, 'Filter for');
});

test('intercept-off switches to manual wording and holds it across submits', () => {
  installDom();
  show({ prompt: 'Fix auth retry handling', title: 'Auth retry work' });
  const root = document.querySelector('.at-resume-hint');

  recordInterceptOff();
  assert.ok(root.classList.contains('intercept-off'));

  recordSubmit();
  assert.ok(!root.classList.contains('post-enter'), 'a submit after cancel is not the /resume submit');
  assert.strictEqual(document.querySelector('.at-resume-hint'), root);

  recordSubmit();
  recordSubmit();
  assert.strictEqual(document.querySelector('.at-resume-hint'), null, 'third submit still dismisses');

  destroy({ cancelIntercept: false });
  delete global.window;
  delete global.document;
});

test('intercept-off after the first submit is ignored', () => {
  installDom();
  show({ prompt: 'Fix auth retry handling', title: 'Auth retry work' });
  const root = document.querySelector('.at-resume-hint');
  recordSubmit();
  recordInterceptOff();
  assert.ok(root.classList.contains('post-enter'));
  assert.ok(!root.classList.contains('intercept-off'));
  destroy({ cancelIntercept: false });
  delete global.window;
  delete global.document;
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
