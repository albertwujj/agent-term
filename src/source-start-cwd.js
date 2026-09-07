const fs = require('fs');
const path = require('path');

const START_HINT = 'Run npm from the intended workspace, using --prefix to select the AgentTerm checkout when needed.';

function requireSourceStartCwd(platform = process.platform, env = process.env, fsApi = fs) {
  const explicit = typeof env.AGENT_TERM_START_CWD === 'string'
    ? env.AGENT_TERM_START_CWD
    : null;
  const cwd = explicit !== null
    ? explicit
    : (typeof env.INIT_CWD === 'string' ? env.INIT_CWD : '');
  if (!cwd) {
    throw new Error(`AgentTerm source launch has no startup directory. ${START_HINT}`);
  }

  const pathApi = platform === 'win32' ? path.posix : path;
  if (!pathApi.isAbsolute(cwd)) {
    throw new Error(`AgentTerm source launch directory is not absolute: ${cwd}`);
  }

  // Windows receives a WSL path that Win32 fs APIs cannot stat directly. The
  // WSL-side launcher validates it before crossing into the Windows process.
  if (platform !== 'win32') {
    let stat;
    try {
      stat = fsApi.statSync(cwd);
    } catch {
      throw new Error(`AgentTerm source launch directory does not exist: ${cwd}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`AgentTerm source launch path is not a directory: ${cwd}`);
    }
  }

  return cwd;
}

// The environment a source launch hands its Electron child.
//
// npm sets INIT_CWD to the directory it was invoked from, which is the
// workspace the user picked. An inherited AGENT_TERM_START_CWD is ambient: it
// arrives from the AgentTerm window whose shell ran the command, and being
// preferred above would open the new window on that session's directory
// instead, whatever npm was told. An explicit launch is the deliberate one, so
// it wins. The WSL launcher already resolves it this way in
// scripts/source-start-cwd.sh, so this is parity rather than a new rule.
//
// With no INIT_CWD nothing is overridden: `node scripts/start.js` run by hand
// keeps whatever it inherited, and main falls back as it always has.
function sourceLaunchEnv(env = process.env, platform = process.platform, fsApi = fs) {
  if (typeof env.INIT_CWD !== 'string' || !env.INIT_CWD) return env;
  return { ...env, AGENT_TERM_START_CWD: requireSourceStartCwd(platform, { INIT_CWD: env.INIT_CWD }, fsApi) };
}

module.exports = { requireSourceStartCwd, sourceLaunchEnv };
