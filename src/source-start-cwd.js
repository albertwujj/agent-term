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

module.exports = { requireSourceStartCwd };
