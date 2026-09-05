// Which renderer an AI CLI starts in, expressed as environment.
//
// Claude Code's fullscreen renderer draws the conversation on the alternate
// screen. That is a good trade in a terminal where redraw throughput is the
// bottleneck, and a poor one here: AgentTerm draws through xterm's WebGL
// renderer and does not flicker, while the alternate screen puts the
// conversation somewhere selecting-to-comment, Ctrl/Cmd+F over the session,
// and the comment marks on the scrollbar cannot reach — the features this
// terminal exists for. So a shell we spawn asks for the classic renderer.
//
// NO_FLICKER=0 rather than DISABLE_ALTERNATE_SCREEN=1, deliberately: both
// outrank a saved `tui` setting, but /tui clears NO_FLICKER from the session
// it relaunches, so `/tui fullscreen` still works and the user keeps the last
// word. DISABLE_ALTERNATE_SCREEN would survive the relaunch and leave that
// command looking broken.
//
// A CLAUDE_CODE_* variable already in the environment is the user speaking to
// the CLI directly, so we add nothing over it — both because we have nothing
// to add, and because silently overwriting a variable someone set is a bug.
// It doubles as the way out: export CLAUDE_CODE_NO_FLICKER=1 for fullscreen.
const CLASSIC_RENDERER = { CLAUDE_CODE_NO_FLICKER: '0' };

const USER_OWNED = ['CLAUDE_CODE_NO_FLICKER', 'CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN'];

// The variables to add to a spawned shell's environment, or {} when the user
// has already chosen. Keys are also the names WSLENV must carry on Windows,
// so an empty result adds nothing there either.
function aiCliRendererEnv(parentEnv = {}) {
  for (const key of USER_OWNED) {
    if (parentEnv[key] !== undefined && parentEnv[key] !== '') return {};
  }
  return { ...CLASSIC_RENDERER };
}

module.exports = { aiCliRendererEnv };
