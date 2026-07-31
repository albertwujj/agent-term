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
  // The U/I/O cluster: U picks the viewer, O toggles it shown/hidden (the
  // everyday tab switch, same as the bar tap), I toggles the open size
  // golden⇄full (same as the bar double-click; from hidden it reveals at full,
  // so each open size is one press from the handle). O and I with no viewer at
  // all fall through to the selector.
  // (I and O once stepped a collapsed/golden/full size ladder, and before that
  // held a back / forward history cycle; hide/show became a one-press mode
  // switch, so the ladder retired.)
  if (key === 'u') return 'selector';
  if (key === 'i') return 'size';
  if (key === 'o') return 'toggle';
  return null;
}

module.exports = {
  getViewerShortcutAction,
};
