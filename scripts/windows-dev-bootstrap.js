const fs = require('fs');
const path = require('path');

const RUNTIME_ENTRIES = ['src', 'tools'];

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

if (shouldRun()) run();

module.exports = { RUNTIME_ENTRIES, shouldRun, stageSource };
