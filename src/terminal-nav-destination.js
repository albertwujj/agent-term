// Which navigable terminal matches act on a plain click, and which ask for a
// modifier first.
//
// A plain click is for destinations that leave the terminal intact: a URL or an
// .html path in the viewer band, an .md path in the md viewer, a resource or a
// bare path with the OS. The scrollback stays where it was and Esc puts things
// back.
//
// Everything that resolves through the IDE — symbols, file:line, source lines,
// diff lines — takes ctrl/cmd. Two reasons. It is an application switch, so it
// belongs on the escalated gesture the md viewer already uses for following a
// link. And it is the widest part of the match surface: the bare-identifier
// symbol patterns claim most technical words in ordinary agent prose, so a
// double-click meant to select a word for commenting fired an IDE jump on its
// first press.
//
// The doc exception matters more than it looks. navigateToFileLine routes .md
// and .html targets to the in-app viewers before it ever reaches the IDE, so
// README.md:42 is an in-app destination wearing a file:line shape, and it keeps
// the plain click.

const IDE_PATTERN_NAMES = new Set([
  'qualified_symbol',
  'underscore_symbol',
  'camel_pascal_symbol',
  'file_line',
  'file_line_col',
  'paren_line',
  'github_line',
  'line_ref',
  'comment_line_ref',
  'python_traceback',
  'source_line',
  'diff_line',
  'diff_block',
]);

// A document extension at the end of the path portion of a match. The lookahead
// is what lets this see past the line reference a pattern carries: README.md:42,
// docs/a.md#L4, notes.html(12) all name a document.
const DOC_TARGET = /\.(?:markdown|mdown|xhtml|html|htm|md)(?=$|[\s:(#,;)\]}'"])/i;

// True when this match should sit out a plain click and wait for ctrl/cmd.
function navigationNeedsModifier(match) {
  if (!match || !IDE_PATTERN_NAMES.has(match.patternName)) return false;
  return !DOC_TARGET.test(String(match.text || ''));
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

module.exports = {
  IDE_PATTERN_NAMES,
  DOC_TARGET,
  navigationNeedsModifier,
  hasNavigationModifier,
  matchForPress,
};
