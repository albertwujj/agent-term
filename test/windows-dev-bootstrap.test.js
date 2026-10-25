const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  RUNTIME_ASSETS,
  RUNTIME_ENTRIES,
  claimUnusedGenerations,
  shouldRun,
  stageSource,
} = require('../scripts/windows-dev-bootstrap');

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

console.log('windows-dev-bootstrap');

function writeRunnerAssets(runner, contents = 'xterm-css') {
  for (const asset of RUNTIME_ASSETS) {
    const target = path.join(runner, asset);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }
}

test('stages runtime source and browser assets beneath a process-specific directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-term-win-dev-'));
  const source = path.join(root, 'source');
  const runner = path.join(root, 'runner');
  try {
    fs.mkdirSync(path.join(source, 'src'), { recursive: true });
    fs.mkdirSync(path.join(source, 'src', 'tools'), { recursive: true });
    fs.mkdirSync(path.join(source, 'node_modules', 'linux-only'), { recursive: true });
    fs.writeFileSync(path.join(source, 'src', 'main.js'), 'main-v1');
    fs.writeFileSync(path.join(source, 'src', 'tools', 'review.py'), 'review-v1');
    fs.writeFileSync(path.join(source, 'package.json'), '{"version":"1.2.3"}');
    fs.writeFileSync(path.join(source, 'node_modules', 'linux-only', 'binding.node'), 'linux');
    writeRunnerAssets(runner);

    const staged = stageSource(source, runner, 1234);
    assert.strictEqual(staged, path.join(runner, 'stage', '1234'));
    assert.strictEqual(fs.readFileSync(path.join(staged, 'src', 'main.js'), 'utf8'), 'main-v1');
    assert.strictEqual(fs.readFileSync(path.join(staged, 'src', 'tools', 'review.py'), 'utf8'), 'review-v1');
    assert.strictEqual(fs.readFileSync(path.join(staged, 'package.json'), 'utf8'), '{"version":"1.2.3"}');
    assert.strictEqual(fs.readFileSync(path.join(staged, RUNTIME_ASSETS[0]), 'utf8'), 'xterm-css');
    assert.strictEqual(fs.existsSync(path.join(staged, 'node_modules', 'linux-only')), false);
    assert.deepStrictEqual(RUNTIME_ENTRIES, ['src']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a new process snapshot reads fresh source without replacing another snapshot', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-term-win-dev-'));
  const source = path.join(root, 'source');
  const runner = path.join(root, 'runner');
  try {
    fs.mkdirSync(path.join(source, 'src'), { recursive: true });
    fs.mkdirSync(path.join(source, 'src', 'tools'), { recursive: true });
    fs.writeFileSync(path.join(source, 'src', 'main.js'), 'main-v1');
    fs.writeFileSync(path.join(source, 'src', 'tools', 'review.py'), 'review');
    fs.writeFileSync(path.join(source, 'package.json'), '{}');
    writeRunnerAssets(runner);

    const first = stageSource(source, runner, 100);
    fs.writeFileSync(path.join(source, 'src', 'main.js'), 'main-v2');
    const second = stageSource(source, runner, 200);

    assert.strictEqual(fs.readFileSync(path.join(first, 'src', 'main.js'), 'utf8'), 'main-v1');
    assert.strictEqual(fs.readFileSync(path.join(second, 'src', 'main.js'), 'utf8'), 'main-v2');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fails clearly when the staged browser stylesheet is missing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-term-win-dev-'));
  const source = path.join(root, 'source');
  const runner = path.join(root, 'runner');
  try {
    fs.mkdirSync(path.join(source, 'src'), { recursive: true });
    fs.mkdirSync(path.join(source, 'src', 'tools'), { recursive: true });
    fs.writeFileSync(path.join(source, 'package.json'), '{}');
    assert.throws(
      () => stageSource(source, runner, 42),
      /development dependency asset is missing.*xterm\.css/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fails clearly when a runtime source directory is missing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-term-win-dev-'));
  const source = path.join(root, 'source');
  try {
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'package.json'), '{}');
    assert.throws(
      () => stageSource(source, path.join(root, 'runner'), 42),
      /development source is missing src\//,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runs only as the Electron entry point with a configured source', () => {
  assert.strictEqual(shouldRun({
    versions: { electron: '43.4.1' },
    env: { AGENT_TERM_DEV_SOURCE_WIN: 'C:\\source' },
  }), true);
  assert.strictEqual(shouldRun({
    versions: { electron: '43.4.1' },
    env: {},
  }), false);
  assert.strictEqual(shouldRun({
    versions: { node: '24.19.0' },
    env: { AGENT_TERM_DEV_SOURCE_WIN: 'C:\\source' },
  }), false);
});

test('Windows dependency install refreshes Node PATH and uses system CA trust', () => {
  const launcher = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'start-windows-from-wsl.ps1'),
    'utf8',
  );

  assert.match(launcher, /Join-Path \(Split-Path -Parent \$npmPath\) 'node\.exe'/);
  assert.match(launcher, /\$env:Path = "\$nodeDirectory;\$env:Path"/);
  assert.match(launcher, /\$nodePath --help/);
  assert.match(launcher, /\$env:NODE_OPTIONS = \$originalNodeOptions/);
  assert.doesNotMatch(launcher, /strict-ssl\s*=\s*false/i);
});

test('Windows dependency install invalidates its stamp before npm ci', () => {
  const launcher = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'start-windows-from-wsl.ps1'),
    'utf8',
  );
  const invalidateAt = launcher.indexOf('Remove-Item -Force -ErrorAction SilentlyContinue -LiteralPath $installStamp');
  const installAt = launcher.indexOf('& $npmPath ci');

  assert.ok(invalidateAt >= 0, 'dependency stamp is not invalidated');
  assert.ok(installAt >= 0, 'npm ci invocation is missing');
  assert.ok(invalidateAt < installAt, 'dependency stamp must be invalidated before npm ci');
});

test('Windows dependencies use install-specific generations safe from live Electron locks', () => {
  const launcher = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'start-windows-from-wsl.ps1'),
    'utf8',
  );
  const generationAt = launcher.indexOf('$runnerRoot = Join-Path $runnerBase "runtime\\$dependencyKey"');
  const installAt = launcher.indexOf('& $npmPath ci');

  assert.ok(generationAt >= 0, 'dependency cache generation is missing');
  assert.ok(generationAt < installAt, 'the generation must be selected before npm ci');
  assert.match(launcher, /'dependencies', 'devDependencies', 'optionalDependencies'/);
  assert.match(launcher, /'engines', 'packageManager', 'allowScripts'/);
  assert.match(launcher, /'preinstall', 'install', 'postinstall', 'prepublish'/);
  assert.doesNotMatch(launcher, /Get-FileHash[^\r\n]+\$sourcePackage/);
});

test('WSL launcher does not load the UNC PowerShell file through -File', () => {
  const launcher = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'start-windows-from-wsl.sh'),
    'utf8',
  );

  assert.match(launcher, /\[ScriptBlock\]::Create\(\$launcherSource\)/);
  assert.match(launcher, /AGENT_TERM_LAUNCHER_PS_WIN/);
  assert.doesNotMatch(launcher, /\s-File\s/);
});

test('Windows source launch passes npm invocation cwd instead of pinning the checkout', () => {
  const bashLauncher = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'start-windows-from-wsl.sh'),
    'utf8',
  );
  const powershellLauncher = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'start-windows-from-wsl.ps1'),
    'utf8',
  );

  assert.match(bashLauncher, /agent_term_require_source_start_cwd/);
  assert.match(bashLauncher, /AGENT_TERM_START_CWD/);
  assert.doesNotMatch(bashLauncher, /AGENT_TERM_SOURCE_WSL/);
  assert.doesNotMatch(powershellLauncher, /AGENT_TERM_WSL_CWD|WslSourceRoot/);
});

test('the install lifecycle runs in the tree the Windows launcher stages', () => {
  // That tree is scripts/postinstall.js and scripts/fix-pty-perms.js beside a
  // package.json and its lockfile, so anything postinstall reaches for outside
  // those two files breaks `npm ci` on every WSL development launch — before a
  // window, with a MODULE_NOT_FOUND stack as the only explanation.
  const runner = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-term-runner-'));
  const runnerScripts = path.join(runner, 'scripts');
  fs.mkdirSync(runnerScripts);
  for (const staged of ['postinstall.js', 'fix-pty-perms.js']) {
    fs.copyFileSync(
      path.join(__dirname, '..', 'scripts', staged),
      path.join(runnerScripts, staged),
    );
  }

  const entry = JSON.stringify(path.join(runnerScripts, 'postinstall.js'));
  const install = spawnSync(process.execPath, ['-e', `
    const { runPostinstall } = require(${entry});
    runPostinstall({
      spawn: () => ({ status: 0 }),
      resolve: () => 'electron-install-test.js',
      load: () => {},
    });
  `], { encoding: 'utf8' });

  assert.strictEqual(install.status, 0, install.stderr);
  assert.doesNotMatch(install.stderr, /MODULE_NOT_FOUND/);
  assert.doesNotMatch(install.stderr, /dependency stamp skipped/);
});

// runtime/<key> folders as the launcher installs them: stamped, with a stage
// folder per process that ran from them.
function makeRuntime(generations) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-term-generations-'));
  const runtime = path.join(root, 'runtime');
  for (const [name, { stamped = true, pids = [] }] of Object.entries(generations)) {
    const generation = path.join(runtime, name);
    fs.mkdirSync(path.join(generation, 'node_modules'), { recursive: true });
    if (stamped) fs.writeFileSync(path.join(generation, '.dependency-stamp'), 'stamp');
    for (const pid of pids) fs.mkdirSync(path.join(generation, 'stage', String(pid)), { recursive: true });
  }
  return { root, runtime };
}

test('an earlier generation nothing runs from is renamed aside, the current one kept', () => {
  const { root, runtime } = makeRuntime({ current: { pids: [1] }, earlier: { pids: [111] } });
  try {
    const claimed = claimUnusedGenerations(path.join(runtime, 'current'), { alive: (pid) => pid === 1 });
    assert.deepStrictEqual(claimed, [path.join(runtime, '.delete-earlier')]);
    assert.deepStrictEqual(fs.readdirSync(runtime).sort(), ['.delete-earlier', 'current']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a generation with a live process staged from it is kept', () => {
  const { root, runtime } = makeRuntime({ current: {}, earlier: { pids: [111, 222] } });
  try {
    const claimed = claimUnusedGenerations(path.join(runtime, 'current'), { alive: (pid) => pid === 222 });
    assert.deepStrictEqual(claimed, []);
    assert.ok(fs.existsSync(path.join(runtime, 'earlier')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an unstamped generation is left for a day, since its install may still be running', () => {
  const { root, runtime } = makeRuntime({ current: {}, installing: { stamped: false } });
  try {
    const runnerRoot = path.join(runtime, 'current');
    assert.deepStrictEqual(claimUnusedGenerations(runnerRoot, { alive: () => false }), []);
    const later = Date.now() + 2 * 24 * 60 * 60 * 1000;
    assert.deepStrictEqual(
      claimUnusedGenerations(runnerRoot, { alive: () => false, now: later }),
      [path.join(runtime, '.delete-installing')],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a removal an earlier start did not finish is claimed again', () => {
  const { root, runtime } = makeRuntime({ current: {}, '.delete-earlier': {} });
  try {
    const claimed = claimUnusedGenerations(path.join(runtime, 'current'), { alive: () => false });
    assert.deepStrictEqual(claimed, [path.join(runtime, '.delete-earlier')]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a generation Windows will not rename is left for a later start', () => {
  const { root, runtime } = makeRuntime({ current: {}, earlier: {} });
  try {
    const fsApi = { ...fs, renameSync: () => { throw Object.assign(new Error('busy'), { code: 'EPERM' }); } };
    const claimed = claimUnusedGenerations(path.join(runtime, 'current'), { fsApi, alive: () => false });
    assert.deepStrictEqual(claimed, []);
    assert.ok(fs.existsSync(path.join(runtime, 'earlier')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a runner outside a runtime folder never claims its siblings', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-term-generations-'));
  try {
    fs.mkdirSync(path.join(root, 'this-checkout'));
    fs.mkdirSync(path.join(root, 'other-checkout'));
    const claimed = claimUnusedGenerations(path.join(root, 'this-checkout'), { alive: () => false });
    assert.deepStrictEqual(claimed, []);
    assert.ok(fs.existsSync(path.join(root, 'other-checkout')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('claimed generations are deleted on a worker thread', () => {
  const { root, runtime } = makeRuntime({ '.delete-a': {}, '.delete-b': {} });
  try {
    const targets = JSON.stringify([path.join(runtime, '.delete-a'), path.join(runtime, '.delete-b')]);
    const bootstrap = JSON.stringify(path.join(__dirname, '..', 'scripts', 'windows-dev-bootstrap.js'));
    // The worker is unref'd so it never holds a window's process open; this
    // child holds it until the delete is done.
    const run = spawnSync(process.execPath, ['-e', `
      const worker = require(${bootstrap}).removeInBackground(${targets});
      worker.ref();
      worker.on('exit', (code) => process.exit(code));
    `], { encoding: 'utf8' });
    assert.strictEqual(run.status, 0, run.stderr);
    assert.deepStrictEqual(fs.readdirSync(runtime), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

console.log(`\n${testsPassed} passed, ${testsFailed} failed`);
process.exit(testsFailed > 0 ? 1 : 0);
