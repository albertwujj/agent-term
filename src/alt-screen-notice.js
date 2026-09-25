// docs/dev/cli-rendering.md is the background for all of this.
//
// A fullscreen CLI has taken the conversation onto the alternate screen,
// where this terminal's reach ends: selecting output to comment on it,
// Ctrl/Cmd+F across the session, and the marks those comments leave on the
// scrollbar all work on a scrollback, and the alternate screen has none.
//
// A shell we spawn already asks Claude Code for its classic renderer
// (cli-renderer-env.js), and picker launches ask Codex to stay inline
// (ai-title.js). This fires when those requests did not reach the CLI, or the
// user started it manually with its fullscreen default.
//
// Detection is the state, never the command. `/tui fullscreen` is one way in
// among several, and reading what the user typed is not something this
// terminal does.

// A quick `vim` or `less` inside the session also lands on the alternate
// screen. Both are usually brief; a renderer is not. Waiting distinguishes
// them without having to guess at what is running.
const NOTICE_DWELL_MS = 8000;

// These two CLIs have a concrete way back to scrollback. The other CLIs do
// not, so a notice for them would be a nag.
function shouldNoticeAltScreen({ cli, bufferType, alreadyNoticed } = {}) {
  if (alreadyNoticed) return false;
  if (cli !== 'claude' && cli !== 'codex') return false;
  return bufferType === 'alternate';
}

function altScreenNotice(cli) {
  const subject = cli === 'codex' ? 'Codex' : 'Claude Code';
  const remedy = cli === 'codex'
    ? 'Next time, run codex --no-alt-screen to keep the conversation in this terminal.'
    : 'Run /tui default to put it back in this terminal.';
  return subject + ' is drawing on the alternate screen, so commenting, '
    + 'Ctrl/Cmd+F and the scrollbar marks cannot reach the conversation.\n'
    + remedy;
}

module.exports = { NOTICE_DWELL_MS, shouldNoticeAltScreen, altScreenNotice };
