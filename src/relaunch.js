const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const RELAUNCHED_ARG = '--relaunched';
const INSTALLED_RELAUNCHER_PREFIX = '.agent-term-launcher-';

// Electron expects relaunch args without argv[0] (the executable). Always
// remove inherited markers first, then add exactly one marker for the fresh
// process. Both automatic and shortcut-driven relaunches use this path.
// Nothing reads the marker at runtime; it exists so a successor is
// identifiable in Task Manager's command line when debugging respawns.
function buildRelaunchArgs(argv) {
  const args = (Array.isArray(argv) ? argv : [])
    .slice(1)
    .filter((arg) => arg !== RELAUNCHED_ARG);
  args.push(RELAUNCHED_ARG);
  return args;
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

// app.quit() is graceful and can leave a windowless predecessor alive while
// asynchronous PTY teardown drains. Once a replacement is scheduled, exit the
// old app immediately so relaunch predecessors cannot accumulate. The automatic
// user-close caller reaches this only after the window's `closed` cleanup.
function relaunchAndExit(app, argv, options = {}) {
  const relaunchOptions = { args: buildRelaunchArgs(argv) };
  if (options.execPath) relaunchOptions.execPath = options.execPath;
  app.relaunch(relaunchOptions);
  app.exit(0);
}

// The stock portable wrapper waits for its inner app, then deletes the inner
// extraction. Start a new OUTER wrapper directly and let the old wrapper clean
// its own unique directory after app.exit(). This avoids an Electron relauncher
// process locking old code in that directory.
function relaunchPortableAndExit(app, argv, execPath, dependencies = {}) {
  const spawnImpl = dependencies.spawn || spawn;
  const pathApi = dependencies.path || path;
  const child = spawnImpl(execPath, buildRelaunchArgs(argv), {
    cwd: pathApi.dirname(execPath),
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  app.exit(0);
}

// Start a fresh AgentTerm alongside the running one (Cmd/Ctrl+Shift+N). The
// child is a new launch, not a successor, so the relaunch marker is dropped
// rather than added. Detached spawn keeps its lifetime independent of ours.
function spawnNewInstance(argv, execPath, dependencies = {}) {
  const spawnImpl = dependencies.spawn || spawn;
  const options = {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  };
  if (dependencies.cwd) options.cwd = dependencies.cwd;
  const args = (Array.isArray(argv) ? argv : [])
    .slice(1)
    .filter((arg) => arg !== RELAUNCHED_ARG);
  const child = spawnImpl(execPath, args, options);
  child.unref();
}

module.exports = {
  INSTALLED_RELAUNCHER_PREFIX,
  RELAUNCHED_ARG,
  buildRelaunchArgs,
  relaunchAndExit,
  relaunchPortableAndExit,
  resolveLatestRelaunchTarget,
  spawnNewInstance,
};
