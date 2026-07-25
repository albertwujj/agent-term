const assert = require('assert');
const {
  navigationNeedsModifier,
  hasNavigationModifier,
  matchForPress,
} = require('../src/terminal-nav-destination');

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`PASS ${name}`);
}

const m = (patternName, text) => ({ patternName, text });

// The IDE-bound surface: the widest patterns, and the ones a double-click lands
// on when you are selecting a word to comment on it.
check('symbols wait for a modifier', () => {
  assert.strictEqual(navigationNeedsModifier(m('camel_pascal_symbol', 'refreshActivityTimestamps')), true);
  assert.strictEqual(navigationNeedsModifier(m('underscore_symbol', 'gc_active_files')), true);
  assert.strictEqual(navigationNeedsModifier(m('qualified_symbol', 'Session.isActive')), true);
});

check('file:line and its variants wait for a modifier', () => {
  assert.strictEqual(navigationNeedsModifier(m('file_line', 'src/sessions-log.js:213')), true);
  assert.strictEqual(navigationNeedsModifier(m('file_line_col', 'src/renderer.js:42:15')), true);
  assert.strictEqual(navigationNeedsModifier(m('paren_line', 'src/main.js(42)')), true);
  assert.strictEqual(navigationNeedsModifier(m('github_line', 'src/main.js#L42')), true);
  assert.strictEqual(navigationNeedsModifier(m('line_ref', 'line 1384')), true);
  assert.strictEqual(navigationNeedsModifier(m('comment_line_ref', '# :344')), true);
  assert.strictEqual(navigationNeedsModifier(m('python_traceback', 'File "app/run.py", line 42')), true);
});

check('source and diff lines wait for a modifier', () => {
  assert.strictEqual(navigationNeedsModifier(m('source_line', '    return bar')), true);
  assert.strictEqual(navigationNeedsModifier(m('diff_line', '+  const x = 1')), true);
  assert.strictEqual(navigationNeedsModifier(m('diff_block', '│ some prose line')), true);
});

// The in-app surface keeps the plain click: the terminal stays where it was and
// Esc puts the band away.
check('urls, doc paths and resources act on a plain click', () => {
  assert.strictEqual(navigationNeedsModifier(m('url', 'https://example.com/x')), false);
  assert.strictEqual(navigationNeedsModifier(m('plain_file', 'src/renderer.js')), false);
  assert.strictEqual(navigationNeedsModifier(m('resource_file', 'shot.png')), false);
  assert.strictEqual(navigationNeedsModifier(m('wsl_unc_path', '\\\\wsl.localhost\\Ubuntu\\home\\a')), false);
});

// navigateToFileLine routes .md and .html to the in-app viewers before it ever
// reaches the IDE, so these are in-app destinations wearing a file:line shape.
check('a document target keeps the plain click through a line reference', () => {
  assert.strictEqual(navigationNeedsModifier(m('file_line', 'README.md:42')), false);
  assert.strictEqual(navigationNeedsModifier(m('file_line', 'docs/spec.markdown:7')), false);
  assert.strictEqual(navigationNeedsModifier(m('github_line', 'docs/a.md#L4')), false);
  assert.strictEqual(navigationNeedsModifier(m('paren_line', 'notes.html(12)')), false);
  assert.strictEqual(navigationNeedsModifier(m('file_line_col', 'page.htm:3:1')), false);
});

check('a source file that merely contains md in its name still needs the modifier', () => {
  assert.strictEqual(navigationNeedsModifier(m('file_line', 'src/markdown-viewer.js:88')), true);
  assert.strictEqual(navigationNeedsModifier(m('file_line', 'src/md-link-target.js:12')), true);
  assert.strictEqual(navigationNeedsModifier(m('file_line', 'notes.mdx:4')), true);
});

check('an unknown pattern is left alone', () => {
  assert.strictEqual(navigationNeedsModifier(m('image_attachment', '/tmp/a.png')), false);
  assert.strictEqual(navigationNeedsModifier(null), false);
});

// Ctrl or Cmd. Alt already means "choose among all matches" on paths, and
// ctrl/cmd+alt is the debug-copy chord.
check('ctrl and cmd escalate, alt and shift do not', () => {
  assert.strictEqual(hasNavigationModifier({ ctrlKey: true }), true);
  assert.strictEqual(hasNavigationModifier({ metaKey: true }), true);
  assert.strictEqual(hasNavigationModifier({ altKey: true }), false);
  assert.strictEqual(hasNavigationModifier({ shiftKey: true }), false);
  assert.strictEqual(hasNavigationModifier({}), false);
  assert.strictEqual(hasNavigationModifier(undefined), false);
});

// Returning null is the whole point: with nothing armed, the first press of a
// double-click navigates nowhere and there is no double-click interval to wait
// out before the word select lands.
check('a plain press on an IDE match arms nothing', () => {
  const symbol = m('camel_pascal_symbol', 'isSessionActive');
  assert.strictEqual(matchForPress(symbol, {}), null);
  assert.strictEqual(matchForPress(symbol, { shiftKey: true }), null);
  assert.strictEqual(matchForPress(symbol, { ctrlKey: true }), symbol);
  assert.strictEqual(matchForPress(symbol, { metaKey: true }), symbol);
});

check('the debug chord still reaches an IDE match', () => {
  const line = m('file_line', 'src/main.js:9');
  assert.strictEqual(matchForPress(line, { metaKey: true, altKey: true }), line);
  assert.strictEqual(matchForPress(line, { altKey: true }), null);
});

check('a plain press on an in-app match arms it', () => {
  const url = m('url', 'https://example.com');
  assert.strictEqual(matchForPress(url, {}), url);
  const doc = m('file_line', 'README.md:42');
  assert.strictEqual(matchForPress(doc, {}), doc);
  assert.strictEqual(matchForPress(null, {}), null);
});

console.log(`\n${passed} passed, 0 failed`);
console.log('terminal-nav-destination tests passed');
