const assert = require('assert');
const { inheritableEnv } = require('../src/inheritable-env');

let testsPassed = 0, testsFailed = 0;

function test(name, fn) {
  try {
    fn();
    testsPassed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    testsFailed++;
    console.log(`  ✗ ${name}`);
    console.log(`      ${err.message}`);
  }
}

console.log('inheritable-env');

// The environment of the AgentTerm that ran without color on 2026-09-07:
// launched by `npm --prefix ~/agent-term run start` from a Codex exec tool.
const CODEX_LAUNCH = {
  HOME: '/Users/me', USER: 'me', SHELL: '/bin/zsh', LANG: 'en_US.UTF-8',
  TMPDIR: '/var/folders/x/T/', SSH_AUTH_SOCK: '/private/tmp/agent.sock',
  TERM: 'xterm-256color', TERM_PROGRAM: 'Apple_Terminal',
  NO_COLOR: '1', COLOR: '0', COLORTERM: '', LC_ALL: 'C.UTF-8',
  PAGER: 'cat', GIT_PAGER: 'cat',
  CODEX_CI: '1', CODEX_SANDBOX_NETWORK_DISABLED: '1', CODEX_PERMISSION_PROFILE: ':workspace',
  CODEX_THREAD_ID: '01a079f7', CODEX_SESSION_ID: '01a079f7',
  CODEX_MANAGED_BY_NPM: '1', CODEX_MANAGED_PACKAGE_ROOT: '/opt/homebrew/lib/node_modules/@openai/codex',
  INIT_CWD: '/Users/me/agent-plugin', NODE: '/opt/homebrew/bin/node',
  npm_command: 'run-script', npm_lifecycle_event: 'start', npm_config_prefix: '/Users/me/agent-term',
  npm_package_name: 'agent-term', npm_execpath: '/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js',
  AGENT_TERM_START_CWD: '/Users/me/agent-plugin',
};

// What Claude Code's Bash tool adds to a shell it runs.
const CLAUDE_TOOL_SHELL = {
  CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_SESSION_ID: 'e192491f',
  CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_BRIDGE_SESSION_ID: 'session_1',
  CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/cc-socks/1.sock', CLAUDE_CODE_MESSAGING_TOKEN: 'abc',
  CLAUDE_CODE_EXECPATH: '/Users/me/.local/share/claude/versions/2.1.263',
  CLAUDE_PID: '87131', CLAUDE_EFFORT: 'xhigh', AI_AGENT: 'claude-code_2-1-263_agent',
  GIT_EDITOR: 'true', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', GCM_INTERACTIVE: 'never',
  GIT_CONFIG_PARAMETERS: "'credential.interactive=false'",
};

test('the plain-output switches of a tool shell are dropped', () => {
  const out = inheritableEnv({ ...CODEX_LAUNCH, FORCE_COLOR: '3', CLICOLOR: '0', CLICOLOR_FORCE: '1' }, 'darwin');
  for (const name of ['NO_COLOR', 'COLOR', 'FORCE_COLOR', 'CLICOLOR', 'CLICOLOR_FORCE', 'PAGER', 'GIT_PAGER', 'LC_ALL']) {
    assert.ok(!(name in out), `${name} should be dropped`);
  }
});

test("npm's run-script variables are dropped", () => {
  const out = inheritableEnv(CODEX_LAUNCH, 'darwin');
  for (const name of Object.keys(CODEX_LAUNCH).filter(n => n.startsWith('npm_'))) {
    assert.ok(!(name in out), `${name} should be dropped`);
  }
  assert.ok(!('INIT_CWD' in out));
  assert.ok(!('NODE' in out));
});

test('the session markers of Codex and Claude Code are dropped', () => {
  const out = inheritableEnv({ ...CODEX_LAUNCH, ...CLAUDE_TOOL_SHELL }, 'darwin');
  for (const name of Object.keys(CODEX_LAUNCH).filter(n => n.startsWith('CODEX_'))) {
    assert.ok(!(name in out), `${name} should be dropped`);
  }
  for (const name of Object.keys(CLAUDE_TOOL_SHELL)) {
    assert.ok(!(name in out), `${name} should be dropped`);
  }
});

test("git's prompt and editor overrides are dropped", () => {
  const out = inheritableEnv(CLAUDE_TOOL_SHELL, 'darwin');
  for (const name of ['GIT_EDITOR', 'GIT_TERMINAL_PROMPT', 'GIT_ASKPASS', 'GCM_INTERACTIVE', 'GIT_CONFIG_PARAMETERS']) {
    assert.ok(!(name in out), `${name} should be dropped`);
  }
});

test("the user's own session and configuration stay", () => {
  const own = {
    HOME: '/Users/me', USER: 'me', SHELL: '/bin/zsh', LANG: 'en_US.UTF-8', LC_CTYPE: 'UTF-8',
    TMPDIR: '/var/folders/x/T/', SSH_AUTH_SOCK: '/private/tmp/agent.sock', EDITOR: 'vi',
    HTTPS_PROXY: 'http://proxy:3128', ANTHROPIC_API_KEY: 'k', CODEX_HOME: '/Users/me/.codex',
    CLAUDE_CODE_NO_FLICKER: '1', CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '1',
    AGENT_TERM_START_CWD: '/Users/me/agent-plugin', AGENT_JOBS_DIR: '/Users/me/jobs',
  };
  assert.deepStrictEqual(inheritableEnv({ ...CODEX_LAUNCH, ...CLAUDE_TOOL_SHELL, ...own }, 'darwin'), {
    ...own, TERM: 'xterm-256color', TERM_PROGRAM: 'Apple_Terminal', COLORTERM: '',
  });
});

// COLORTERM is the terminal's own answer; createPty sets it over whatever came
// in, so an emptied one passes through here unchanged.
test("a launcher's COLORTERM is left for createPty to overwrite", () => {
  assert.deepStrictEqual(inheritableEnv({ COLORTERM: '' }, 'darwin'), { COLORTERM: '' });
});

test('the PATH entries npm and Codex prepend are removed, the rest kept in order', () => {
  const PATH = [
    '/Users/me/agent-term/node_modules/.bin',
    '/Users/me/node_modules/.bin',
    '/node_modules/.bin',
    '/opt/homebrew/lib/node_modules/npm/node_modules/@npmcli/run-script/lib/node-gyp-bin',
    '/opt/homebrew/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/codex-path',
    '/Users/me/.local/bin',
    '/opt/homebrew/bin',
    '/usr/bin',
    '/var/run/com.apple.security.cryptexd/codex.system/bootstrap/usr/bin',
    '/Users/me/.codex/tmp/arg0/codex-arg0P6VSb7',
    '/Users/me/.local/bin',
  ].join(':');
  assert.strictEqual(inheritableEnv({ PATH }, 'darwin').PATH, [
    '/Users/me/.local/bin',
    '/opt/homebrew/bin',
    '/usr/bin',
    '/var/run/com.apple.security.cryptexd/codex.system/bootstrap/usr/bin',
    '/Users/me/.local/bin',
  ].join(':'));
});

test('a PATH without launcher entries is unchanged', () => {
  const PATH = '/Users/me/.local/bin:/opt/homebrew/bin:/usr/bin:/bin';
  assert.strictEqual(inheritableEnv({ PATH }, 'linux').PATH, PATH);
  assert.deepStrictEqual(inheritableEnv({ HOME: '/home/me' }, 'linux'), { HOME: '/home/me' });
});

test('Windows: Path, with its own delimiter and separators', () => {
  const Path = 'C:\\repo\\node_modules\\.bin;C:\\Users\\me\\bin;C:\\Windows\\system32';
  assert.deepStrictEqual(inheritableEnv({ Path, NO_COLOR: '1' }, 'win32'),
    { Path: 'C:\\Users\\me\\bin;C:\\Windows\\system32' });
});

test('the parent environment is never mutated', () => {
  const env = { ...CODEX_LAUNCH };
  inheritableEnv(env, 'darwin');
  assert.deepStrictEqual(env, CODEX_LAUNCH);
});

console.log(`\n${testsPassed} passed, ${testsFailed} failed`);
process.exit(testsFailed > 0 ? 1 : 0);
