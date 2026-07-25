// Which navigable terminal matches act on a plain click, and which ask for a
// modifier first.
//
// One rule: a plain click opens something in a built-in viewer. A URL or an
// .html path in the web band, a review:// package in the diff viewer, an .md
// path in the md viewer. Those keep the terminal where it is — the scrollback
// is untouched and Esc puts the band away.
//
// Everything else hands you to another application, and that takes ctrl/cmd:
// the IDE for a symbol, a file:line, a source or diff line; the OS for a bare
// path, a folder, an image or an archive. An application switch is the most
// expensive thing a stray click can do, and the IDE side is also the widest
// part of the match surface — the bare-identifier symbol patterns claim most
// technical words in ordinary agent prose, so a double click meant to select a
// word for commenting used to fire a jump on its first press.
//
// Stated as what opens in-app rather than what does not, so a pattern added
// later needs an explicit decision to earn the plain click instead of taking it
// by default.

// Patterns whose destination is a built-in viewer whatever their text says.
// `url` covers http(s) and file:// in the web band, and review:// in the diff
// viewer; a modifier on those means the system browser instead.
// `image_attachment` is classified by name rather than by text: the renderer
// stitches a path split across rows, so a match's text is one fragment of it and
// the extension may live in the other. It is an image by construction anyway.
const IN_APP_PATTERN_NAMES = new Set(['url', 'image_attachment']);

// Patterns whose match text IS the path, so a document extension inside it names
// the destination. Everywhere else the path comes from context — a diff header
// above, a backward scan for the enclosing file — and an extension appearing in
// the line is just text: `+ see README.md for details` is a diff line that
// navigates to code, not a link to a document.
//
// Content lines are deliberately absent even when their file is markdown. A diff
// line, a source line and a bordered prose line are things you select and
// comment on, so they never take the plain click; the gesture belongs to
// commenting there and navigation asks for the modifier.
const PATH_IS_THE_TEXT = new Set([
  'plain_file',
  'wsl_unc_path',
  'resource_file',
  'file_line',
  'file_line_col',
  'paren_line',
  'github_line',
]);

// A document extension at the end of the path portion of a match: .md to the md
// viewer, .html to the web band. navigateToFileLine routes both to their viewer
// before it ever reaches the IDE, so README.md:42 is an in-app destination
// wearing a file:line shape. The lookahead is what lets this see past the line
// reference a pattern carries — README.md:42, docs/a.md#L4, notes.html(12).
const DOC_TARGET = /\.(?:markdown|mdown|xhtml|html|htm|md)(?=$|[\s:(#,;)\]}'"])/i;

// Images the band renders itself, so they are a built-in viewer too. Narrower
// than the resource set on purpose: pdf, archives and media stay handoffs,
// because the band has nothing better to do with them than the OS does. Keep in
// step with VIEWABLE_IMAGE_EXTENSIONS in renderer.js, which does the routing.
const IMAGE_TARGET = /\.(?:png|jpe?g|gif|svg|webp|bmp|ico)(?=$|[\s:(#,;)\]}'"])/i;

// True when a plain click on this match opens a built-in viewer.
function opensInApp(match) {
  if (!match) return false;
  if (IN_APP_PATTERN_NAMES.has(match.patternName)) return true;
  if (!PATH_IS_THE_TEXT.has(match.patternName)) return false;
  const text = String(match.text || '');
  return DOC_TARGET.test(text) || IMAGE_TARGET.test(text);
}

// True when this match should sit out a plain click and wait for ctrl/cmd.
function navigationNeedsModifier(match) {
  return !!match && !opensInApp(match);
}

// Ctrl or Cmd. Alt is excluded: it already means "choose among all matches" on
// paths, and ctrl/cmd+alt is the debug-copy chord.
function hasNavigationModifier(event) {
  return !!event && (!!event.ctrlKey || !!event.metaKey);
}

// The match a press should act on, or null when the press is a plain click on
// something that now waits for a modifier. Returning null is what keeps the
// gesture free: with nothing armed, the first press of a double-click navigates
// nowhere and there is no double-click interval to sit out.
function matchForPress(match, event) {
  if (!match) return null;
  if (navigationNeedsModifier(match) && !hasNavigationModifier(event)) return null;
  return match;
}

// How much of a match is marked and clickable.
//
// It depends on where the reference lands, because that decides whether the line
// is part of what is being pointed at.
//
// An IDE destination IS the line. Landing on it is the whole point of the jump,
// so src/renderer.js:88 is one reference and stays one span, marked and
// clickable end to end.
//
// A doc destination is the document. The md viewer opens README.md, and the :42
// adds nothing to that, so the mark names the document and the qualifier stays
// ordinary text you can select. The hit region stops there too: what is marked
// is what responds, with no invisible target hanging off the end of the
// underline. In practice an agent rarely prints a line against a doc at all.
//
// Parsing keeps the full span either way. Overlap resolution runs on
// match.start/end, so narrowing here cannot let a lower-priority pattern claim
// the qualifier.
const PATH_WITH_LINE_PATTERNS = new Set([
  'file_line',
  'file_line_col',
  'paren_line',
  'github_line',
]);

// A trailing line reference in each of the shapes those patterns admit:
// :42, :42:15, :~10-~20, (42), (42,15), (100-200, 300-400), #L42, #L42-L50.
const LINE_QUALIFIER = /(?::~?\d+(?:-~?\d+)?)+$|\(\d+(?:-\d+)?(?:,\s*\d+(?:-\d+)?)*\)$|#L\d+(?:-L\d+)?$/;

// Patterns that carry a line reference with no path of their own — "line 42",
// "# :344", a Python traceback frame — are left whole: there the reference is
// the whole thing being named, so there is nothing to trim down to.
function markedLength(match) {
  const text = String((match && match.text) || '');
  if (!match || !PATH_WITH_LINE_PATTERNS.has(match.patternName)) return text.length;
  if (!DOC_TARGET.test(text)) return text.length;
  const qualifier = LINE_QUALIFIER.exec(text);
  if (!qualifier) return text.length;
  const kept = text.length - qualifier[0].length;
  return kept > 0 ? kept : text.length;
}

module.exports = {
  IN_APP_PATTERN_NAMES,
  DOC_TARGET,
  opensInApp,
  navigationNeedsModifier,
  hasNavigationModifier,
  matchForPress,
  markedLength,
};
