const fs = require('fs');
const path = require('path');

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
  // therefore start/reload concurrently, and Ctrl+Shift+R reads fresh files
  // without either process deleting files from underneath the other.
  process.once('exit', () => {
    try { fs.rmSync(stageRoot, { recursive: true, force: true }); } catch {}
  });

  require(path.join(stageRoot, 'src', 'main.js'));
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
  LAUNCH_ENV_ARG, RUNTIME_ASSETS, RUNTIME_ENTRIES, applyLaunchEnv, shouldRun, stageSource,
};
