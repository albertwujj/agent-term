const assert = require('assert');
const {
  navigationNeedsModifier,
  hasNavigationModifier,
  matchForPress,
  markedLength,
  actsOnPlainClick,
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

check('source and diff lines over code wait for a modifier', () => {
  assert.strictEqual(navigationNeedsModifier(m('source_line', '    return bar')), true);
  assert.strictEqual(navigationNeedsModifier(m('diff_line', '+  const x = 1')), true);
  assert.strictEqual(navigationNeedsModifier(m('diff_block', '│ some prose line')), true);
});

// A content line's destination is its resolved context, never its own text.
const ctx = (patternName, text, contextPath) => ({ patternName, text, contextPath });

check('a content line reads its destination from contextPath, not its text', () => {
  // The path comes from a diff header above, not from this text: the extension
  // here is prose, and the click would land in the IDE.
  assert.strictEqual(navigationNeedsModifier(ctx('diff_line', '+ see README.md for details', 'src/renderer.js')), true);
  assert.strictEqual(navigationNeedsModifier(ctx('source_line', '    open("docs/spec.md")', 'src/main.js')), true);
  assert.strictEqual(navigationNeedsModifier(ctx('diff_block', '│ rewrote notes.html by hand', 'src/web-viewer.js')), true);
  // Unresolved context earns nothing: the click would have to guess.
  assert.strictEqual(navigationNeedsModifier(m('line_ref', 'line 12 of notes.md')), true);
  assert.strictEqual(navigationNeedsModifier(m('comment_line_ref', '# :344')), true);
  assert.strictEqual(navigationNeedsModifier(m('python_traceback', 'File "docs/a.md", line 42')), true);
});

// A content line whose enclosing file is a doc jumps in-app, so it keeps the
// plain click: with a reliable jump, commenting on a doc's diff belongs in the
// viewer itself, where the thread lives with the text.
check('a doc-context content line takes the plain click into the viewer', () => {
  assert.strictEqual(navigationNeedsModifier(ctx('diff_block', '│ ## A heading', 'launch-plan.md')), false);
  assert.strictEqual(navigationNeedsModifier(ctx('diff_block', '- **No or low cost** — same size', 'ai/coding-guide.md')), false);
  assert.strictEqual(navigationNeedsModifier(ctx('diff_line', '+ prose in a numbered diff', 'notes.markdown')), false);
  assert.strictEqual(navigationNeedsModifier(ctx('source_line', '    a code block inside a doc', 'docs/spec.md')), false);
  assert.strictEqual(navigationNeedsModifier(ctx('line_ref', 'lines 74-113', 'ai/coding-guide.md')), false);
  assert.strictEqual(navigationNeedsModifier(ctx('comment_line_ref', '# :344', 'docs/spec.md')), false);
  // A source file that merely contains "md" in its name is still code.
  assert.strictEqual(navigationNeedsModifier(ctx('diff_block', '│ prose', 'src/md-link-target.js')), true);
  assert.strictEqual(navigationNeedsModifier(ctx('diff_block', '│ prose', 'notes.mdx')), true);
});

// A built-in viewer keeps the plain click: the terminal stays where it was and
// Esc puts the band away. A web URL keeps it too, on its way to the browser.
check('a built-in viewer acts on a plain click', () => {
  assert.strictEqual(navigationNeedsModifier(m('url', 'https://example.com/x')), false);
  assert.strictEqual(navigationNeedsModifier(m('url', 'file:///tmp/page.html')), false);
  assert.strictEqual(navigationNeedsModifier(m('url', 'review://feature-branch')), false);
  assert.strictEqual(navigationNeedsModifier(m('plain_file', 'docs/launch-plan.md')), false);
  assert.strictEqual(navigationNeedsModifier(m('plain_file', 'site/index.html')), false);
  assert.strictEqual(navigationNeedsModifier(m('wsl_unc_path', '\\\\wsl.localhost\\Ubuntu\\home\\notes.md')), false);
});

check('a reconstructed markdown segment uses its full viewer target', () => {
  assert.strictEqual(navigationNeedsModifier({
    patternName: 'plain_file',
    text: 'ng.md',
    viewerTarget: '/home/me/review/work-long-name.md',
  }), false);
});

// An OS open is an application switch, the same class as the IDE, so it sits on
// the same escalated gesture.
check('a handoff to the OS waits for a modifier', () => {
  assert.strictEqual(navigationNeedsModifier(m('plain_file', 'src/renderer.js')), true);
  assert.strictEqual(navigationNeedsModifier(m('plain_file', 'src/components')), true);
  assert.strictEqual(navigationNeedsModifier(m('resource_file', 'bundle.zip')), true);
  assert.strictEqual(navigationNeedsModifier(m('resource_file', 'clip.mov')), true);
  assert.strictEqual(navigationNeedsModifier(m('wsl_unc_path', '\\\\wsl.localhost\\Ubuntu\\home\\a')), true);
});

// The band renders an image itself, so looking at one is a built-in viewer and
// keeps the plain click. A stitched attachment is classified by name, since its
// text is only one fragment of a path split across rows.
check('an image is a built-in viewer', () => {
  assert.strictEqual(navigationNeedsModifier(m('resource_file', 'shot.png')), false);
  assert.strictEqual(navigationNeedsModifier(m('resource_file', 'diagram.svg')), false);
  assert.strictEqual(navigationNeedsModifier(m('resource_file', 'photo.JPEG')), false);
  assert.strictEqual(navigationNeedsModifier(m('image_attachment', '/tmp/scree')), false);
  assert.strictEqual(navigationNeedsModifier(m('wsl_unc_path', '\\\\wsl.localhost\\Ubuntu\\home\\shot.png')), false);
});

// Video, audio and pdf render in the band too (band-viewable.js), so they keep
// the plain click; a format Chromium can't play (mov) is still a handoff.
check('media and pdf the band renders are built-in viewers', () => {
  assert.strictEqual(navigationNeedsModifier(m('resource_file', 'clip.mp4')), false);
  assert.strictEqual(navigationNeedsModifier(m('resource_file', 'take.mp3')), false);
  assert.strictEqual(navigationNeedsModifier(m('resource_file', 'report.pdf')), false);
  assert.strictEqual(navigationNeedsModifier(m('plain_file', 'assets/hero.webm')), false);
  assert.strictEqual(navigationNeedsModifier(m('resource_file', 'clip.mov')), true);
});

// Stated as what opens in-app, so anything unrecognised has to earn the plain
// click rather than taking it by default.
check('a pattern nobody classified waits for a modifier', () => {
  assert.strictEqual(navigationNeedsModifier(m('some_future_pattern', 'whatever')), true);
  assert.strictEqual(actsOnPlainClick(m('some_future_pattern', 'whatever')), false);
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

check('a missing match is not a target at all', () => {
  assert.strictEqual(navigationNeedsModifier(null), false);
  assert.strictEqual(actsOnPlainClick(null), false);
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

check('a plain press on a doc-context diff row arms it; code context still waits', () => {
  const mdRow = ctx('diff_block', '## Matching neighbours, or writing it clean', 'coding-guide.md');
  assert.strictEqual(matchForPress(mdRow, {}), mdRow);
  const codeRow = ctx('diff_block', 'a prose row of a code diff', 'src/renderer.js');
  assert.strictEqual(matchForPress(codeRow, {}), null);
  assert.strictEqual(matchForPress(codeRow, { ctrlKey: true }), codeRow);
});

const marked = (patternName, text) => text.slice(0, markedLength(m(patternName, text)));

// An IDE jump lands on the line, so the reference is the file AND the line and
// the whole span stays marked and clickable, as it always was.
check('an IDE source reference stays one whole span', () => {
  assert.strictEqual(marked('file_line', 'src/sessions-log.js:213'), 'src/sessions-log.js:213');
  assert.strictEqual(marked('file_line_col', 'src/renderer.js:42:15'), 'src/renderer.js:42:15');
  assert.strictEqual(marked('paren_line', 'src/main.js(42)'), 'src/main.js(42)');
  assert.strictEqual(marked('paren_line', 'a.py(100-200, 300-400)'), 'a.py(100-200, 300-400)');
  assert.strictEqual(marked('github_line', 'src/main.js#L42-L50'), 'src/main.js#L42-L50');
});

// The md viewer opens the document; the line adds nothing to name, so the mark
// stops at the document and the qualifier is ordinary selectable text.
check('a doc reference is marked without its line', () => {
  assert.strictEqual(marked('file_line', 'README.md:42'), 'README.md');
  assert.strictEqual(marked('file_line', 'notes.md:~10-~20'), 'notes.md');
  assert.strictEqual(marked('file_line_col', 'page.htm:3:1'), 'page.htm');
  assert.strictEqual(marked('paren_line', 'notes.html(12)'), 'notes.html');
  assert.strictEqual(marked('github_line', 'docs/a.md#L4'), 'docs/a.md');
});

check('a reference that is its own whole name is left alone', () => {
  // No path to trim down to: the reference IS the thing being named.
  assert.strictEqual(marked('line_ref', 'line 1384'), 'line 1384');
  assert.strictEqual(marked('comment_line_ref', '# :344'), '# :344');
  assert.strictEqual(marked('python_traceback', 'File "app/run.py", line 42'), 'File "app/run.py", line 42');
});

check('a match with no line reference keeps its whole mark', () => {
  assert.strictEqual(marked('url', 'https://example.com/x:8080'), 'https://example.com/x:8080');
  assert.strictEqual(marked('plain_file', 'src/renderer.js'), 'src/renderer.js');
  assert.strictEqual(marked('plain_file', 'README.md'), 'README.md');
  assert.strictEqual(marked('camel_pascal_symbol', 'isSessionActive'), 'isSessionActive');
  assert.strictEqual(markedLength(null), 0);
});

console.log(`\n${passed} passed, 0 failed`);
console.log('terminal-nav-destination tests passed');
