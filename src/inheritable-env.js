// What a shell we spawn inherits from the environment this process started in.
//
// That environment belongs to whoever launched AgentTerm, and increasingly that
// is an agent: the README's setup prompt has Codex or Claude Code run
// `npm --prefix ~/agent-term run start` from its own exec tool. A tool shell is
// arranged for a program reading a pipe. It turns color off (NO_COLOR=1, an
// emptied COLORTERM), replaces pagers with cat, tells git to never prompt or
// open an editor, pins a locale, and marks the session so nested tools know
// whose child they are; npm adds its run-script variables and puts every
// node_modules/.bin first on PATH. Electron inherits all of it, keeps it across
// every relaunch and Ctrl/Cmd+Shift+N window, and createPty handed it to every
// shell in every window. On 2026-09-07 that was a day of windows without
// color, from one launch out of a Codex session.
//
// Removal is by name, of what a launcher is known to set. What the user's own
// profile exports comes back when the shell reads the profile, which on macOS
// is why the shell is a login shell (shellArgs in main.js). The terminal's own
// identity, TERM, TERM_PROGRAM and COLORTERM, is set by createPty over
// whatever came in.

// Switches a tool shell flips to get plain output.
const PLAIN_OUTPUT = [
  'NO_COLOR', 'FORCE_COLOR', 'CLICOLOR', 'CLICOLOR_FORCE',
  'COLOR',                // npm's own color verdict, reached with NO_COLOR in view
  'PAGER', 'GIT_PAGER',   // Codex: cat
  'LC_ALL',               // Codex: C.UTF-8, a locale macOS does not have
  'GIT_EDITOR',           // Claude Code: true, so a commit never waits on an editor
  'GIT_TERMINAL_PROMPT', 'GIT_ASKPASS', 'GCM_INTERACTIVE', 'GIT_CONFIG_PARAMETERS',
];

// `npm run start`: what npm adds for the script, besides every npm_* name.
const NPM_RUN_SCRIPT = ['INIT_CWD', 'NODE'];

// Session markers seen in the tool shells of Claude Code 2.1.263 and Codex
// 0.153. CLAUDE_CODE_NO_FLICKER and CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN are
// absent on purpose: those are the user's choice (cli-renderer-env.js).
const AGENT_SESSION = [
  'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_EXECPATH', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'AI_AGENT',
  'CODEX_CI', 'CODEX_SANDBOX_NETWORK_DISABLED', 'CODEX_PERMISSION_PROFILE',
  'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CODEX_MANAGED_BY_NPM',
  'CODEX_MANAGED_PACKAGE_ROOT',
];

const REMOVED = new Set([...PLAIN_OUTPUT, ...NPM_RUN_SCRIPT, ...AGENT_SESSION]);

// PATH entries a launcher prepends for its own tools. Apple's system cryptex
// is also named codex (/var/run/com.apple.security.cryptexd/codex.system/...)
// and matches neither pattern.
const LAUNCHER_PATH_ENTRY = [
  /[\\/]node_modules[\\/]\.bin$/,                          // npm, one per ancestor directory
  /[\\/]@npmcli[\\/]run-script[\\/]lib[\\/]node-gyp-bin$/, // npm
  /[\\/]\.codex[\\/]tmp[\\/]arg0[\\/]/,                    // Codex: a temp dir, gone with its session
  /[\\/]codex-path$/,                                      // Codex: its vendored shims
];

function inheritableEnv(env = process.env, platform = process.platform) {
  const out = {};
  for (const [name, value] of Object.entries(env)) {
    if (REMOVED.has(name) || name.startsWith('npm_')) continue;
    out[name] = value;
  }
  // Windows names the variable Path and keeps names case-insensitive.
  const pathName = platform === 'win32'
    ? Object.keys(out).find(name => name.toUpperCase() === 'PATH')
    : (Object.prototype.hasOwnProperty.call(out, 'PATH') ? 'PATH' : undefined);
  if (pathName !== undefined && typeof out[pathName] === 'string') {
    const delimiter = platform === 'win32' ? ';' : ':';
    out[pathName] = out[pathName]
      .split(delimiter)
      .filter(entry => !LAUNCHER_PATH_ENTRY.some(pattern => pattern.test(entry)))
      .join(delimiter);
  }
  return out;
}

module.exports = { inheritableEnv };
