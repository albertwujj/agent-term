const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const INSTALLED_RELAUNCHER_PREFIX = '.agent-term-launcher-';

function nonEmptyCwd(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

// A successor belongs to the established agent session only after its first
// prompt has been captured. Until then the window is still a launcher/shell,
// so manual `cd` activity must not replace the directory AgentTerm itself was
// launched for. An older session may not have a recorded cwd; retain the
// launch directory rather than inventing one.
function chooseSuccessorStartCwd({ hasCapturedPrompt = false, sessionCwd, launchCwd } = {}) {
  const launch = nonEmptyCwd(launchCwd);
  if (!hasCapturedPrompt) return launch;
  return nonEmptyCwd(sessionCwd) || launch;
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Resolve how a packaged Windows successor must start to select/extract fresh
// code. Installed builds use an immutable sibling launcher that waits out an
// in-progress install, then reads the atomically-published `.current` pointer.
// Portable builds advertise their outer self-extractor in the environment and
// must be spawned directly (not through Electron's relaunch helper, which runs
// from the extraction directory that the old wrapper needs to delete).
function resolveLatestRelaunchTarget(execPath, dependencies = {}) {
  const fsApi = dependencies.fs || fs;
  const pathApi = dependencies.path || path;
  const env = dependencies.env || process.env;
  const version = String(dependencies.version || '');

  const versionDir = pathApi.dirname(execPath);
  const versionDirName = pathApi.basename(versionDir);
  const installedDirPattern = version
    ? new RegExp(`^app-${escapeRegExp(version)}(?:-\\d+)?$`)
    : null;
  if (installedDirPattern && installedDirPattern.test(versionDirName)) {
    const installDir = pathApi.dirname(versionDir);
    const currentFile = pathApi.join(installDir, '.current');
    const launcher = pathApi.join(
      installDir,
      `${INSTALLED_RELAUNCHER_PREFIX}${versionDirName}.exe`,
    );
    if (!fsApi.existsSync(currentFile)) throw new Error('installed version pointer is missing');
    if (!fsApi.existsSync(launcher)) throw new Error('installed relauncher is missing');
    return { mode: 'electron', execPath: launcher };
  }

  const portableLauncher = String(env.PORTABLE_EXECUTABLE_FILE || '').trim();
  if (portableLauncher) {
    if (!pathApi.isAbsolute(portableLauncher) || !fsApi.existsSync(portableLauncher)) {
      throw new Error('portable launcher is invalid or missing');
    }
    return { mode: 'portable-spawn', execPath: portableLauncher };
  }
  return { mode: 'electron', execPath: null };
}

// Start a fresh AgentTerm alongside the running one: Cmd/Ctrl+Shift+N, or
// the fresh window that replaces the last one closed. Detached spawn keeps
// its lifetime independent of ours.
// `env` replaces the inherited environment: the caller carries the cwd chosen
// by chooseSuccessorStartCwd across as AGENT_TERM_START_CWD. Returns the child
// so the caller can watch for boot failures (an invalid execPath surfaces as
// an async 'error', a boot crash as an early 'exit').
function spawnNewInstance(argv, execPath, dependencies = {}) {
  const spawnImpl = dependencies.spawn || spawn;
  const options = {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  };
  if (dependencies.cwd) options.cwd = dependencies.cwd;
  if (dependencies.env) options.env = dependencies.env;
  // Everything a console would have shown goes to a file instead of nowhere.
  // `npm run start` inherits a terminal and the user reads warnings there; a
  // window opened from inside the app had no such terminal and discarded them,
  // Node's warnings and uncaught traces included. Redirecting the descriptors
  // captures the bytes rather than classifying them, so nothing has to be kept
  // in step with what Node or Electron decide to print. Every window opened
  // from inside the app starts here, so this is the only place that needs it.
  //
  // A failure to open the file must never cost the user a window: fall through
  // to today's behaviour and lose the output, as before.
  const consoleLog = dependencies.consoleLog;
  let consoleFd = null;
  if (consoleLog) {
    try {
      const fsApi = dependencies.fs || fs;
      consoleFd = fsApi.openSync(consoleLog, 'a');
      options.stdio = ['ignore', consoleFd, consoleFd];
      options.env = { ...(options.env || process.env), AGENT_TERM_CONSOLE_LOG: consoleLog };
    } catch {
      consoleFd = null;
    }
  }
  const args = (Array.isArray(argv) ? argv : []).slice(1);
  const child = spawnImpl(execPath, args, options);
  // The child owns the descriptors now; this process keeps no handle open.
  if (consoleFd !== null) {
    try { (dependencies.fs || fs).closeSync(consoleFd); } catch {}
  }
  child.unref();
  return child;
}

module.exports = {
  INSTALLED_RELAUNCHER_PREFIX,
  chooseSuccessorStartCwd,
  resolveLatestRelaunchTarget,
  spawnNewInstance,
};
