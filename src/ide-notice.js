// What a failed IDE jump tells the user, and when.
//
// The jump reaches the IDE through the IntelliJ Navigator plugin on a local
// port. With no IDE listening, every click on a reference fails the same
// way, and a plain click on a reference is often a selection gesture from
// someone who never set an IDE up: told on every click, they would be
// nagged for a feature they did not ask for. So a plain click says it once
// per window, with the page that sets it up, and a Ctrl/Cmd-click, which is
// a deliberate jump, says it every time.
const IDE_DOC_URL = 'https://github.com/albertwujj/agent-term/blob/main/docs/ide.md';

// `result` is the navigation result from main: an unreachable IDE carries
// `unreachable: true` and the port, and no `status`. `state` is the window's
// record ({ shown }), mutated when a notice is returned. Returns the notice
// to show, or null: null for any result that is not an unreachable IDE (the
// caller keeps its own rendering for those), and for a repeat plain click.
function ideUnreachableNotice(result, { explicit = false, state } = {}) {
  if (!result || result.status || !result.unreachable) return null;
  if (!explicit && state && state.shown) return null;
  if (state) state.shown = true;
  return {
    text: `No IDE is listening on port ${result.port}. Set up the IDE jump:`,
    linkLabel: 'docs/ide.md',
    url: IDE_DOC_URL,
  };
}

module.exports = { IDE_DOC_URL, ideUnreachableNotice };
