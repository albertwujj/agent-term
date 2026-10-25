const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');

const RUNTIME_ENTRIES = ['src'];
// Browser file URLs do not use Node's ancestor-based module resolution.
const RUNTIME_ASSETS = [
  path.join('node_modules', '@xterm', 'xterm', 'css', 'xterm.css'),
];

function stageSource(sourceRoot, runnerRoot, pid = process.pid, fsApi = fs) {
  if (!sourceRoot) throw new Error('AGENT_TERM_DEV_SOURCE_WIN is not set');

  const stageRoot = path.join(runnerRoot, 'stage', String(pid));
  fsApi.rmSync(stageRoot, { recursive: true, force: true });
  fsApi.mkdirSync(stageRoot, { recursive: true });

  for (const entry of RUNTIME_ENTRIES) {
    const source = path.join(sourceRoot, entry);
    if (!fsApi.existsSync(source)) throw new Error(`development source is missing ${entry}/`);
    fsApi.cpSync(source, path.join(stageRoot, entry), { recursive: true });
  }
  for (const asset of RUNTIME_ASSETS) {
    const source = path.join(runnerRoot, asset);
    if (!fsApi.existsSync(source)) throw new Error(`development dependency asset is missing ${asset}`);
    const destination = path.join(stageRoot, asset);
    fsApi.mkdirSync(path.dirname(destination), { recursive: true });
    fsApi.copyFileSync(source, destination);
  }
  fsApi.copyFileSync(
    path.join(sourceRoot, 'package.json'),
    path.join(stageRoot, 'package.json'),
  );
  return stageRoot;
}

function run() {
  const stageRoot = stageSource(
    process.env.AGENT_TERM_DEV_SOURCE_WIN,
    __dirname,
  );

  // Every Electron process gets its own source snapshot. Separate windows can
  // therefore start concurrently, and a successor reads fresh files without
  // either process deleting files from underneath the other.
  process.once('exit', () => {
    try { fs.rmSync(stageRoot, { recursive: true, force: true }); } catch {}
  });

  require(path.join(stageRoot, 'src', 'main.js'));

  setTimeout(() => {
    try {
      removeInBackground(claimUnusedGenerations(__dirname));
    } catch (err) {
      console.warn(`[bootstrap] dependency generation cleanup failed: ${err.message}`);
    }
  }, PRUNE_DELAY_MS).unref();
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
const PRUNE_DELAY_MS = 30 * 1000;
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

function removeInBackground(targets, WorkerImpl = Worker) {
  if (!targets.length) return null;
  console.log(`[bootstrap] removing unused dependency generations: ${targets.join(', ')}`);
  const worker = new WorkerImpl(`
    const fs = require('fs');
    for (const target of require('worker_threads').workerData) {
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 3 });
    }
  `, { eval: true, workerData: targets });
  worker.on('error', (err) => {
    console.warn(`[bootstrap] dependency generation removal stopped, the next start resumes it: ${err.message}`);
  });
  worker.unref();
  return worker;
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
if (shouldRun()) run();

module.exports = {
  LAUNCH_ENV_ARG, RUNTIME_ASSETS, RUNTIME_ENTRIES, applyLaunchEnv, claimUnusedGenerations,
  removeInBackground, shouldRun, stageSource,
};
