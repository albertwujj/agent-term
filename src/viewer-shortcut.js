function getModifier(input, electronField, domField) {
  return !!(input[electronField] || input[domField]);
}

function getViewerShortcutAction(input, _platform) {
  if (!input) return null;

  if (input.type != null && input.type !== 'keyDown' && input.type !== 'keydown') {
    return null;
  }

  const key = typeof input.key === 'string' ? input.key.toLowerCase() : '';
  const control = getModifier(input, 'control', 'ctrlKey');
  const meta = getModifier(input, 'meta', 'metaKey');
  const shift = getModifier(input, 'shift', 'shiftKey');
  const alt = getModifier(input, 'alt', 'altKey');

  if (!shift || alt) return null;

  // Preserve the app's existing Ctrl-or-Cmd behavior on every platform while
  // rejecting a mixed chord that may belong to a terminal/application action.
  const hasPrimaryModifier = control !== meta;

  if (!hasPrimaryModifier) return null;
  // The U/I/O cluster, left to right: U picks the viewer, then I and O step it
  // down and up the size ladder (bar handle / reading height / full screen). The
  // steps clamp at each end, so holding the modifier and tapping O runs the band
  // out to full and leaves it there.
  // (I and O once held a back / forward history cycle; the selector reaches any
  // entry directly, so the cycle retired.)
  if (key === 'u') return 'selector';
  if (key === 'i') return 'shrink';
  if (key === 'o') return 'expand';
  return null;
}

module.exports = {
  getViewerShortcutAction,
};
