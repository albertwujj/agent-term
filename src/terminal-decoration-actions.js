async function handleDecorationPointerAction({
  event,
  match,
}) {
  if (!event || !match || typeof match.action !== 'function') return 'ignored';

  // Right-click quote support was removed; keep decoration context menus inert
  // so a right-click does not activate navigation or copy debug payloads.
  if (event.type === 'contextmenu') return 'ignored';

  event.preventDefault();
  event.stopPropagation();

  // Forward modifier state so actions can branch (e.g. the URL action opens the
  // embedded viewer on a plain click but the system browser on Ctrl/Cmd-click).
  const modifiers = {
    ctrlKey: !!event.ctrlKey,
    metaKey: !!event.metaKey,
    altKey: !!event.altKey,
    shiftKey: !!event.shiftKey,
  };

  // Ctrl+Alt-click (Cmd+Alt on Mac) = developer debug (copy the navigation
  // JSON). Plain Ctrl used to mean this, but Ctrl/Cmd/Alt each carry an action
  // of their own now (Alt = search-everywhere chooser, any modifier on a URL =
  // system browser), so the debug chord is the deliberately obscure
  // combination. Cmd is accepted because macOS converts Ctrl+click into a
  // right-click before the app sees it — a conversion trackpad users rely on,
  // so it stays untouched (right-clicks are ignored above).
  if ((event.ctrlKey || event.metaKey) && event.altKey) {
    await match.action(match, { copyResponse: true, modifiers });
    return 'debug';
  }

  await match.action(match, { modifiers });
  return 'activate';
}

module.exports = {
  handleDecorationPointerAction,
};
