const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  INSTALLED_RELAUNCHER_PREFIX,
  chooseSuccessorStartCwd,
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

test('established session successor uses the agent session cwd', () => {
  assert.strictEqual(
    chooseSuccessorStartCwd({
      hasCapturedPrompt: true,
      sessionCwd: '/home/me/session-repo',
      launchCwd: '/home/me/launcher-repo',
    }),
    '/home/me/session-repo',
  );
});

test('pre-session successor keeps the AgentTerm launch cwd', () => {
  assert.strictEqual(
    chooseSuccessorStartCwd({
      hasCapturedPrompt: false,
      sessionCwd: '/home/me/manually-cd-here',
      launchCwd: '/home/me/launcher-repo',
    }),
    '/home/me/launcher-repo',
  );
});

test('old session without a recorded cwd falls back to its window launch cwd', () => {
  assert.strictEqual(
    chooseSuccessorStartCwd({
      hasCapturedPrompt: true,
      sessionCwd: null,
      launchCwd: '/home/me/launcher-repo',
    }),
    '/home/me/launcher-repo',
  );
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

test('new-instance spawn is detached and passes the app arguments through', () => {
  const calls = [];
  const fakeChild = { unref() { calls.push(['unref']); } };
  const spawn = (execPath, args, options) => {
    calls.push(['spawn', execPath, args, options]);
    return fakeChild;
  };

  spawnNewInstance(
    ['/path/to/electron', '/path/to/app', '--user-data-dir=/tmp/ud'],
    '/path/to/electron',
    { spawn },
  );

  assert.deepStrictEqual(calls, [
    ['spawn', '/path/to/electron', ['/path/to/app', '--user-data-dir=/tmp/ud'], {
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
    ['C:\\Temp\\extract\\AgentTerm.exe'],
    'D:\\Tools\\AgentTerm.exe',
    { spawn, cwd: 'D:\\Tools' },
  );

  assert.deepStrictEqual(calls, [['D:\\Tools\\AgentTerm.exe', [], 'D:\\Tools']]);
});

test('new-instance spawn carries the selected successor start dir', () => {
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
  const installer = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'installer', 'installer.nsh'), 'utf8');
  const launcher = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'installer', 'launcher.nsi'), 'utf8');
  assert.ok(installer.includes(`/oname=${INSTALLED_RELAUNCHER_PREFIX}$3.exe`));
  assert.ok(installer.includes('MoveFileEx'));
  assert.ok(installer.includes('.installing'));
  assert.ok(launcher.includes('.installing'));
});

test('a successor writes its console to the file it is given, not to nowhere', () => {
  // A window opened from inside the app inherits no terminal. Redirecting the
  // descriptors is what keeps Node's warnings and uncaught traces, which
  // `stdio: 'ignore'` threw away.
  const opened = [];
  const closed = [];
  let spawned = null;
  const fakeFs = {
    openSync(file, flags) { opened.push([file, flags]); return 7; },
    closeSync(fd) { closed.push(fd); },
  };
  spawnNewInstance(['/e', '/app'], '/e', {
    spawn: (cmd, args, options) => { spawned = options; return { unref() {} }; },
    fs: fakeFs,
    consoleLog: '/logs/console-1.log',
    env: { EXISTING: '1' },
  });

  assert.deepStrictEqual(opened, [['/logs/console-1.log', 'a']]);
  assert.deepStrictEqual(spawned.stdio, ['ignore', 7, 7], 'stdout and stderr go to the file');
  assert.strictEqual(spawned.env.AGENT_TERM_CONSOLE_LOG, '/logs/console-1.log',
    'the child is told where its own output went');
  assert.strictEqual(spawned.env.EXISTING, '1', 'the caller\'s env survives');
  assert.deepStrictEqual(closed, [7], 'the parent keeps no handle open');
});

test('a console file that cannot be opened costs no window', () => {
  // Losing the output is what happened before this existed; losing the launch
  // would be new damage.
  let spawned = null;
  spawnNewInstance(['/e', '/app'], '/e', {
    spawn: (cmd, args, options) => { spawned = options; return { unref() {} }; },
    fs: { openSync() { throw new Error('EACCES'); }, closeSync() {} },
    consoleLog: '/logs/console-1.log',
  });
  assert.strictEqual(spawned.stdio, 'ignore', 'falls back to the old behaviour');
  assert.ok(!spawned.env || !spawned.env.AGENT_TERM_CONSOLE_LOG,
    'and never claims a file it does not have');
});

test('without a console file the successor behaves exactly as before', () => {
  let spawned = null;
  spawnNewInstance(['/e', '/app'], '/e', {
    spawn: (cmd, args, options) => { spawned = options; return { unref() {} }; },
  });
  assert.strictEqual(spawned.stdio, 'ignore');
});

console.log(`\n${testsPassed} passed, ${testsFailed} failed`);
process.exit(testsFailed > 0 ? 1 : 0);
