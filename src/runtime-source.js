const fs = require('fs');
const path = require('path');
const { createHash, randomUUID } = require('crypto');
const { Worker } = require('worker_threads');

const PRUNE_PREFIX = '.delete-';
const INCOMPLETE_GRACE_MS = 24 * 60 * 60 * 1000;
const RUNTIME_SOURCE = Symbol.for('agent-term.runtime-source');
const RUNTIME_ENTRIES = ['src'];
const MANIFESTS = ['package.json', 'package-lock.json'];
const SNAPSHOT_DIR = 'snapshots-v1';
const SNAPSHOT_LIMIT = 3;
// Browser file URLs do not use Node's ancestor-based module resolution.
const RUNTIME_ASSETS = [
  path.join('node_modules', '@xterm', 'xterm', 'css', 'xterm.css'),
];

function stageSource(sourceRoot, runnerRoot, pid = process.pid, dependencyRoot = runnerRoot) {
  if (!sourceRoot) throw new Error('Development source root is missing');

  const stageRoot = path.join(runnerRoot, 'stage', String(pid));
  fs.rmSync(stageRoot, { recursive: true, force: true });
  fs.mkdirSync(stageRoot, { recursive: true });

  for (const entry of RUNTIME_ENTRIES) {
    const source = path.join(sourceRoot, entry);
    if (!fs.existsSync(source)) throw new Error(`development source is missing ${entry}/`);
    fs.cpSync(source, path.join(stageRoot, entry), { recursive: true });
  }
  for (const asset of RUNTIME_ASSETS) {
    const source = path.join(dependencyRoot, asset);
    if (!fs.existsSync(source)) throw new Error(`development dependency asset is missing ${asset}`);
    const destination = path.join(stageRoot, asset);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }
  fs.copyFileSync(path.join(sourceRoot, 'package.json'), path.join(stageRoot, 'package.json'));
  return stageRoot;
}

// Both launches and hidden-window reload use the most recent modification
// time under src/ and of the manifests. Walk in parallel over the WSL share.
async function latestSourceChange(root) {
  async function newestUnder(dir) {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    const times = await Promise.all(entries.map((entry) => {
      const file = path.join(dir, entry.name);
      return entry.isDirectory() ? newestUnder(file) : fs.promises.stat(file).then((stat) => stat.mtimeMs);
    }));
    return Math.max(0, ...times);
  }
  const manifests = await Promise.all(MANIFESTS.map((file) =>
    fs.promises.stat(path.join(root, file)).then((stat) => stat.mtimeMs, (err) => {
      if (err.code !== 'ENOENT') throw err;
      return 0;
    })));
  return Math.max(await newestUnder(path.join(root, 'src')), ...manifests);
}

// All runtime files in a completed snapshot are immutable. Local hard links
// give each process its own paths, so pruning a cache entry cannot remove
// files from a live window. The application never builds into a linked tree.
function linkSnapshot(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const destination = path.join(to, entry.name);
    if (entry.isDirectory()) linkSnapshot(source, destination);
    else if (entry.isFile()) fs.linkSync(source, destination);
    else throw new Error(`Cannot cache special file ${source}`);
  }
}

async function prepareSource(sourceRoot, runnerRoot, {
  pid = process.pid, readChange = latestSourceChange, dependencyRoot = runnerRoot, dependencyStamp = '',
} = {}) {
  const changedAt = await readChange(sourceRoot).catch(() => null);
  const stageRoot = path.join(runnerRoot, 'stage', String(pid));
  const snapshot = changedAt === null ? null : path.join(runnerRoot, SNAPSHOT_DIR,
    createHash('sha256').update(String(changedAt) + '\0' + dependencyStamp).digest('hex'));
  if (snapshot && fs.existsSync(snapshot)) {
    try {
      fs.rmSync(stageRoot, { recursive: true, force: true });
      linkSnapshot(snapshot, stageRoot);
      return { stageRoot, snapshot, reused: true };
    } catch {
      // A prune can move the cache entry while we link it. Start from the
      // checkout if any of the links could not be created.
    }
  }

  stageSource(sourceRoot, runnerRoot, pid, dependencyRoot);
  try {
    // Only cache a stage if the edit time held steady across the copy.
    if (snapshot && changedAt === await readChange(sourceRoot)) return { stageRoot, snapshot };
  } catch {
    // The private stage can still launch if it cannot be cached.
  }
  return { stageRoot };
}

async function loadSource({ app, sourceRoot, runnerRoot, dependencyRoot, dependencyStamp, claimOther = () => [] }) {
  const { stageRoot, snapshot, reused } = await prepareSource(sourceRoot, runnerRoot, {
    dependencyRoot, dependencyStamp,
  });
  process.once('exit', () => {
    try { fs.rmSync(stageRoot, { recursive: true, force: true }); } catch {}
  });
  app[RUNTIME_SOURCE] = {
    root: sourceRoot,
    build(buildBundles) {
      if (reused) {
        console.log('[dev] reused runtime snapshot');
        return;
      }
      buildBundles();
      if (!snapshot) return;
      try { publishSnapshot(stageRoot, snapshot); }
      catch (err) { console.warn(`[bootstrap] snapshot cache write failed: ${err.message}`); }
    },
  };
  require(path.join(stageRoot, 'src', 'main.js'));
  setTimeout(() => {
    try { removeInBackground([...claimUnusedSnapshots(runnerRoot), ...claimOther()]); }
    catch (err) { console.warn(`[bootstrap] runtime cache cleanup failed: ${err.message}`); }
  }, 30_000).unref();
}

function removeInBackground(targets, WorkerImpl = Worker) {
  if (!targets.length) return null;
  const worker = new WorkerImpl(`
    const fs = require('fs');
    for (const target of require('worker_threads').workerData) {
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 3 });
    }
  `, { eval: true, workerData: targets });
  worker.on('error', (err) => {
    console.warn(`[bootstrap] runtime cache cleanup stopped: ${err.message}`);
  });
  worker.unref();
  return worker;
}

function publishSnapshot(stageRoot, snapshot) {
  const parent = path.dirname(snapshot);
  fs.mkdirSync(parent, { recursive: true });
  const pending = fs.mkdtempSync(path.join(parent, '.build-'));
  try {
    linkSnapshot(stageRoot, pending);
    try { fs.renameSync(pending, snapshot); }
    catch (err) {
      // A concurrent launch may already have published the same snapshot.
      if (!fs.existsSync(snapshot)) throw err;
    }
  } finally {
    fs.rmSync(pending, { recursive: true, force: true });
  }
}

function claimUnusedSnapshots(runnerRoot, now = Date.now()) {
  const parent = path.join(runnerRoot, SNAPSHOT_DIR);
  let entries;
  try { entries = fs.readdirSync(parent, { withFileTypes: true }); }
  catch (err) { if (err.code === 'ENOENT') return []; throw err; }
  const claimed = [];
  const snapshots = [];
  const claim = (dir) => {
    const aside = path.join(parent, PRUNE_PREFIX + randomUUID());
    try { fs.renameSync(dir, aside); } catch { return; }
    claimed.push(aside);
  };

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(parent, entry.name);
    if (entry.name.startsWith(PRUNE_PREFIX)) {
      claimed.push(dir);
      continue;
    }
    const stat = fs.statSync(dir, { throwIfNoEntry: false });
    if (!stat) continue;
    if (/^[0-9a-f]{64}$/.test(entry.name)) snapshots.push({ dir, time: stat.mtimeMs });
    else if (entry.name.startsWith('.build-') && now - stat.mtimeMs > INCOMPLETE_GRACE_MS) claim(dir);
  }
  snapshots.sort((a, b) => b.time - a.time);
  for (const { dir } of snapshots.slice(SNAPSHOT_LIMIT)) claim(dir);
  return claimed;
}


module.exports = {
  RUNTIME_ASSETS, RUNTIME_ENTRIES, RUNTIME_SOURCE, claimUnusedSnapshots, loadSource,
  prepareSource, publishSnapshot, removeInBackground, latestSourceChange, stageSource,
};
