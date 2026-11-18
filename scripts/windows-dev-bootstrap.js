const fs = require('fs');
const path = require('path');

async function run() {
  const { loadSource } = require('./scripts/runtime-source');
  await loadSource({
    app: require('electron').app,
    sourceRoot: process.env.AGENT_TERM_DEV_SOURCE_WIN,
    runnerRoot: __dirname,
    claimOther: () => claimUnusedGenerations(__dirname),
  });
}

// Each dependency change installs a new generation beside the old ones
// (scripts/start-windows-from-wsl.ps1), some 500 MB and nearly all of it
// Electron, and the launcher never removes one, because a running AgentTerm
// may still be using it. Every process stages its source under its
// generation's stage/<pid> and removes that on exit, so a generation is in
// use while one of those pids is alive; a crashed window leaves a pid that is
// not. Once none is, the generation is renamed aside, which Windows refuses
// while a program inside it is still running, and from then on nothing can
// launch from a half-deleted tree. The delete itself runs on a worker thread,
// well after startup: it is thousands of files, and seconds of disk work.
const PRUNE_PREFIX = '.delete-';
const INSTALL_STAMP = '.dependency-stamp';
// A generation without its stamp is an install another launch is still
// running, or one that failed. A day separates the two.
const INSTALL_GRACE_MS = 24 * 60 * 60 * 1000;

function isAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (err) { return err.code === 'EPERM'; }
}

function generationInUse(generation, alive, fsApi) {
  let staged;
  try { staged = fsApi.readdirSync(path.join(generation, 'stage')); } catch { return false; }
  return staged.some((name) => /^\d+$/.test(name) && alive(Number(name)));
}

// Returns the renamed-aside generations to delete, including any an earlier
// cleanup claimed and did not finish.
function claimUnusedGenerations(runnerRoot, { fsApi = fs, alive = isAlive, now = Date.now() } = {}) {
  const runtime = path.dirname(runnerRoot);
  // Anywhere else, the siblings would be other checkouts' caches.
  if (path.basename(runtime) !== 'runtime') return [];
  const current = path.basename(runnerRoot);
  const claimed = [];
  for (const entry of fsApi.readdirSync(runtime, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === current) continue;
    const generation = path.join(runtime, entry.name);
    if (entry.name.startsWith(PRUNE_PREFIX)) {
      claimed.push(generation);
      continue;
    }
    if (!fsApi.existsSync(path.join(generation, INSTALL_STAMP))
      && now - fsApi.statSync(generation).mtimeMs < INSTALL_GRACE_MS) continue;
    if (generationInUse(generation, alive, fsApi)) continue;
    const aside = path.join(runtime, PRUNE_PREFIX + entry.name);
    try { fsApi.renameSync(generation, aside); } catch { continue; }
    claimed.push(aside);
  }
  return claimed;
}

function shouldRun(processApi = process) {
  return Boolean(
    processApi.versions &&
    processApi.versions.electron &&
    processApi.env &&
    processApi.env.AGENT_TERM_DEV_SOURCE_WIN
  );
}

// The taskbar Jump List task ("Start or resume session") starts this bootstrap
// with no environment of ours; the running app wrote the launcher's
// environment to a file and the task names it here. Variables already set win,
// as a Ctrl+Shift+N child carries fresher ones. The argument name is shared
// with src/windows-launch-env.js by contract.
const LAUNCH_ENV_ARG = '--agent-term-launch-env=';

function applyLaunchEnv(argv, env, fsApi = fs) {
  const arg = (argv || []).find((a) => typeof a === 'string' && a.startsWith(LAUNCH_ENV_ARG));
  if (!arg) return null;
  const file = arg.slice(LAUNCH_ENV_ARG.length);
  const values = JSON.parse(fsApi.readFileSync(file, 'utf8'));
  for (const [key, value] of Object.entries(values)) {
    if (env[key] === undefined) env[key] = value;
  }
  return file;
}

applyLaunchEnv(process.argv, process.env);
if (shouldRun()) run().catch((error) => {
  const { app, dialog } = require('electron');
  dialog.showErrorBox('AgentTerm source launch failed', error.stack || error.message);
  app.exit(1);
});

module.exports = {
  LAUNCH_ENV_ARG, applyLaunchEnv, claimUnusedGenerations, shouldRun,
};
