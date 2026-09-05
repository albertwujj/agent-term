// A fullscreen CLI has taken the conversation onto the alternate screen,
// where this terminal's reach ends: selecting output to comment on it,
// Ctrl/Cmd+F across the session, and the marks those comments leave on the
// scrollbar all work on a scrollback, and the alternate screen has none.
//
// A shell we spawn already asks Claude Code for its classic renderer
// (cli-renderer-env.js), so this only fires when that request lost: the user
// chose fullscreen themselves, or the environment never arrived — over SSH,
// inside a container, through a shell that reset it. Those are exactly the
// cases the environment cannot cover, which is why the notice exists at all.
//
// Detection is the state, never the command. `/tui fullscreen` is one way in
// among several, and reading what the user typed is not something this
// terminal does.

// A quick `vim` or `less` inside the session also lands on the alternate
// screen. Both are usually brief; a renderer is not. Waiting distinguishes
// them without having to guess at what is running.
const NOTICE_DWELL_MS = 8000;

// Only Claude Code, because only it has somewhere to send the user. The
// other CLIs lose the same reach, but a notice you cannot act on is a nag.
function shouldNoticeAltScreen({ cli, bufferType, alreadyNoticed } = {}) {
  if (alreadyNoticed) return false;
  if (cli !== 'claude') return false;
  return bufferType === 'alternate';
}

function altScreenNotice() {
  return 'Claude Code is drawing on the alternate screen, so commenting, '
    + 'Ctrl/Cmd+F and the scrollbar marks cannot reach the conversation.\n'
    + 'Run /tui default to put it back in this terminal.';
}

module.exports = { NOTICE_DWELL_MS, shouldNoticeAltScreen, altScreenNotice };
