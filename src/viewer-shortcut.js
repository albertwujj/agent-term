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
  if (key === 'o') return 'back';
  if (key === 'i') return 'forward';
  // U completes the physical U/I/O key cluster: selector / forward / back.
  if (key === 'u') return 'selector';
  return null;
}

module.exports = {
  getViewerShortcutAction,
};
