const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  INSTALLED_RELAUNCHER_PREFIX,
  RELAUNCHED_ARG,
  buildRelaunchArgs,
  relaunchAndExit,
  relaunchPortableAndExit,
  resolveLatestRelaunchTarget,
  spawnNewInstance,
} = require('../src/relaunch');

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

console.log('relaunch');

test('relaunch adds one marker', () => {
  assert.deepStrictEqual(
    buildRelaunchArgs(['/path/to/electron', '/path/to/app']),
    ['/path/to/app', RELAUNCHED_ARG],
  );
});

test('relaunch heals a stack of inherited markers', () => {
  const argv = [
    '/path/to/electron',
    '/path/to/app',
    RELAUNCHED_ARG,
    '--inspect=9229',
    RELAUNCHED_ARG,
    'session-name',
    RELAUNCHED_ARG,
  ];
  const original = argv.slice();

  assert.deepStrictEqual(
    buildRelaunchArgs(argv),
    ['/path/to/app', '--inspect=9229', 'session-name', RELAUNCHED_ARG],
  );
  assert.deepStrictEqual(argv, original);
});

test('relaunch preserves unrelated marker-like and separator arguments', () => {
  assert.deepStrictEqual(
    buildRelaunchArgs([
      '/path/to/electron',
      '/path/to/app',
      '--relaunched=later',
      '--',
      'session-name',
    ]),
    ['/path/to/app', '--relaunched=later', '--', 'session-name', RELAUNCHED_ARG],
  );
});

test('relaunch stays bounded to one marker across generations', () => {
  let argv = ['/path/to/electron', '/path/to/app'];
  for (let generation = 0; generation < 25; generation++) {
    argv = ['/path/to/electron', ...buildRelaunchArgs(argv)];
    assert.strictEqual(argv.filter((arg) => arg === RELAUNCHED_ARG).length, 1);
  }
});

test('installed relaunch routes through the stable latest-version selector', () => {
  const winPath = path.win32;
  const installDir = 'C:\\Program Files\\AgentTerm';
  const oldExe = winPath.join(installDir, 'app-0.1.13-2', 'AgentTerm.exe');
  const launcher = winPath.join(
    installDir,
    `${INSTALLED_RELAUNCHER_PREFIX}app-0.1.13-2.exe`,
  );
  const currentFile = winPath.join(installDir, '.current');
  const existing = new Set([launcher, currentFile]);
  const fakeFs = {
    existsSync(file) { return existing.has(file); },
  };

  assert.deepStrictEqual(
    resolveLatestRelaunchTarget(oldExe, {
      fs: fakeFs,
      path: winPath,
      env: { PORTABLE_EXECUTABLE_FILE: 'D:\\Unrelated\\AgentTerm.exe' },
      version: '0.1.13',
    }),
    { mode: 'electron', execPath: launcher },
  );
});

test('portable relaunch routes through its outer wrapper', () => {
  const winPath = path.win32;
  const wrapper = 'D:\\Tools\\AgentTerm.exe';
  const fakeFs = { existsSync(file) { return file === wrapper; } };
  assert.deepStrictEqual(
    resolveLatestRelaunchTarget(
      'C:\\Temp\\portable-extract\\AgentTerm.exe',
      {
        fs: fakeFs,
        path: winPath,
        env: { PORTABLE_EXECUTABLE_FILE: wrapper },
        version: '0.1.13',
      },
    ),
    { mode: 'portable-spawn', execPath: wrapper },
  );
});

test('standalone relaunch keeps the current executable', () => {
  assert.deepStrictEqual(
    resolveLatestRelaunchTarget(
      'C:\\Standalone\\AgentTerm.exe',
      { path: path.win32, env: {}, version: '0.1.13' },
    ),
    { mode: 'electron', execPath: null },
  );
});

test('an unrelated app-prefixed directory is not mistaken for an install', () => {
  assert.deepStrictEqual(
    resolveLatestRelaunchTarget(
      'C:\\Tools\\app-local\\AgentTerm.exe',
      { path: path.win32, env: {}, version: '0.1.13' },
    ),
    { mode: 'electron', execPath: null },
  );
});

test('installed relaunch refuses to fall back when the latest-version route is missing', () => {
  const winPath = path.win32;
  const oldExe = 'C:\\Program Files\\AgentTerm\\app-0.1.13\\AgentTerm.exe';
  const fakeFs = { existsSync() { return false; } };
  assert.throws(
    () => resolveLatestRelaunchTarget(oldExe, {
      fs: fakeFs,
      path: winPath,
      env: {},
      version: '0.1.13',
    }),
    /version pointer is missing/,
  );
});

test('relaunch schedules the successor before exiting the predecessor immediately', () => {
  const calls = [];
  const fakeApp = {
    relaunch(options) { calls.push(['relaunch', options]); },
    exit(code) { calls.push(['exit', code]); },
    quit() { calls.push(['quit']); },
  };

  relaunchAndExit(
    fakeApp,
    ['/path/to/electron', '/path/to/app', RELAUNCHED_ARG, RELAUNCHED_ARG],
    { execPath: '/installed/AgentTerm.exe' },
  );

  assert.deepStrictEqual(calls, [
    ['relaunch', {
      args: ['/path/to/app', RELAUNCHED_ARG],
      execPath: '/installed/AgentTerm.exe',
    }],
    ['exit', 0],
  ]);
});

test('packaged relaunch with no target override passes only the normalized marker', () => {
  const calls = [];
  const fakeApp = {
    relaunch(options) { calls.push(['relaunch', options]); },
    exit(code) { calls.push(['exit', code]); },
  };

  relaunchAndExit(fakeApp, ['C:\\Standalone\\AgentTerm.exe']);

  assert.deepStrictEqual(calls, [
    ['relaunch', { args: [RELAUNCHED_ARG] }],
    ['exit', 0],
  ]);
});

test('portable relaunch starts an independent outer wrapper then exits', () => {
  const calls = [];
  const fakeApp = {
    relaunch() { calls.push(['unexpected-relaunch']); },
    exit(code) { calls.push(['exit', code]); },
  };
  const fakeChild = { unref() { calls.push(['unref']); } };
  const spawn = (execPath, args, options) => {
    calls.push(['spawn', execPath, args, options]);
    return fakeChild;
  };

  relaunchPortableAndExit(
    fakeApp,
    ['C:\\Temp\\extract\\AgentTerm.exe', RELAUNCHED_ARG, RELAUNCHED_ARG],
    'D:\\Tools\\AgentTerm.exe',
    { spawn, path: path.win32 },
  );

  assert.deepStrictEqual(calls, [
    ['spawn', 'D:\\Tools\\AgentTerm.exe', [RELAUNCHED_ARG], {
      cwd: 'D:\\Tools',
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }],
    ['unref'],
    ['exit', 0],
  ]);
});

test('new-instance spawn is detached and carries no relaunch marker', () => {
  const calls = [];
  const fakeChild = { unref() { calls.push(['unref']); } };
  const spawn = (execPath, args, options) => {
    calls.push(['spawn', execPath, args, options]);
    return fakeChild;
  };

  spawnNewInstance(
    ['/path/to/electron', '/path/to/app', RELAUNCHED_ARG],
    '/path/to/electron',
    { spawn },
  );

  assert.deepStrictEqual(calls, [
    ['spawn', '/path/to/electron', ['/path/to/app'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }],
    ['unref'],
  ]);
});

test('new-instance spawn pins cwd for packaged launcher targets', () => {
  const calls = [];
  const fakeChild = { unref() {} };
  const spawn = (execPath, args, options) => {
    calls.push([execPath, args, options.cwd]);
    return fakeChild;
  };

  spawnNewInstance(
    ['C:\\Temp\\extract\\AgentTerm.exe', RELAUNCHED_ARG],
    'D:\\Tools\\AgentTerm.exe',
    { spawn, cwd: 'D:\\Tools' },
  );

  assert.deepStrictEqual(calls, [['D:\\Tools\\AgentTerm.exe', [], 'D:\\Tools']]);
});

test('new-instance spawn carries the shell cwd as the child start dir', () => {
  const calls = [];
  const fakeChild = { unref() {} };
  const spawn = (execPath, args, options) => {
    calls.push([execPath, args, options.env]);
    return fakeChild;
  };
  const env = { PATH: '/usr/bin', AGENT_TERM_START_CWD: '/Users/dev/repo' };

  spawnNewInstance(['/path/to/electron', '/path/to/app'], '/path/to/electron', { spawn, env });

  assert.deepStrictEqual(calls, [['/path/to/electron', ['/path/to/app'], env]]);
});

test('portable package uses a per-launch extraction directory', () => {
  // app-builder-lib 26.7 omits UNPACK_DIR_NAME for boolean true, leaving the
  // template on NSIS's per-process $PLUGINSDIR. A fixed build KSUID would let
  // old/new wrappers delete or overwrite each other's extraction.
  assert.strictEqual(require('../package.json').build.portable.unpackDirName, true);
});

test('installer and app agree on the stable relaunch transaction contract', () => {
  const installer = fs.readFileSync(path.join(__dirname, '..', 'build', 'installer.nsh'), 'utf8');
  const launcher = fs.readFileSync(path.join(__dirname, '..', 'build', 'launcher.nsi'), 'utf8');
  assert.ok(installer.includes(`/oname=${INSTALLED_RELAUNCHER_PREFIX}$3.exe`));
  assert.ok(installer.includes('MoveFileEx'));
  assert.ok(installer.includes('.installing'));
  assert.ok(launcher.includes('.installing'));
});

console.log(`\n${testsPassed} passed, ${testsFailed} failed`);
process.exit(testsFailed > 0 ? 1 : 0);
