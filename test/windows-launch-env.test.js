const assert = require('assert');
const path = require('path');
const {
  LAUNCH_ENV_ARG, LAUNCH_ENV_FILE, TASK_TITLE, launchEnvFile, launchEnvSnapshot,
  writeLaunchEnv, taskbarTask,
} = require('../src/windows-launch-env');
const bootstrap = require('../scripts/windows-dev-bootstrap');

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

console.log('windows-launch-env');

test('the app and the bootstrap agree on the argument name', () => {
  assert.strictEqual(bootstrap.LAUNCH_ENV_ARG, LAUNCH_ENV_ARG);
});

test('snapshots the launch variables and nothing else', () => {
  const env = {
    AGENT_TERM_DEV_SOURCE_WIN: '\\\\wsl.localhost\\Ubuntu\\home\\me\\agent-term',
    AGENT_TERM_WSL_DISTRO: 'Ubuntu',
    WSL_DISTRO_NAME: 'Ubuntu',
    AGENT_TERM_START_CWD: '/home/me/project',
    PATH: 'C:\\Windows',
    USERPROFILE: 'C:\\Users\\me',
  };
  assert.deepStrictEqual(launchEnvSnapshot(env), {
    AGENT_TERM_DEV_SOURCE_WIN: '\\\\wsl.localhost\\Ubuntu\\home\\me\\agent-term',
    AGENT_TERM_WSL_DISTRO: 'Ubuntu',
    WSL_DISTRO_NAME: 'Ubuntu',
    AGENT_TERM_START_CWD: '/home/me/project',
  });
});

test('writes the snapshot as JSON to the file next to the bootstrap', () => {
  const writes = [];
  const fakeFs = { writeFileSync: (file, data) => writes.push([file, data]) };
  const file = launchEnvFile(path.join('C:', 'cache', 'AgentTermWslDev'));
  writeLaunchEnv({ fs: fakeFs, file, env: { AGENT_TERM_START_CWD: '/home/me', HOME: 'x' } });
  assert.strictEqual(file, path.join('C:', 'cache', 'AgentTermWslDev', LAUNCH_ENV_FILE));
  assert.strictEqual(writes.length, 1);
  assert.strictEqual(writes[0][0], file);
  assert.deepStrictEqual(JSON.parse(writes[0][1]), { AGENT_TERM_START_CWD: '/home/me' });
});

test('the task starts this executable on the app path with the environment file', () => {
  const task = taskbarTask({
    execPath: 'C:\\cache\\node_modules\\electron\\dist\\electron.exe',
    appPath: 'C:\\Users\\A B\\AgentTermWslDev',
    file: 'C:\\Users\\A B\\AgentTermWslDev\\launch-env.json',
  });
  assert.strictEqual(task.program, 'C:\\cache\\node_modules\\electron\\dist\\electron.exe');
  assert.strictEqual(
    task.arguments,
    '"C:\\Users\\A B\\AgentTermWslDev" --agent-term-launch-env="C:\\Users\\A B\\AgentTermWslDev\\launch-env.json"',
  );
  assert.strictEqual(task.title, TASK_TITLE);
  assert.match(task.title, /Ctrl\+Shift\+N/);
  assert.strictEqual(task.iconPath, task.program);
});

test('the bootstrap fills in only the variables the environment lacks', () => {
  const reads = [];
  const fakeFs = {
    readFileSync: (file) => {
      reads.push(file);
      return JSON.stringify({ AGENT_TERM_DEV_SOURCE_WIN: 'from-file', AGENT_TERM_START_CWD: '/stale' });
    },
  };
  const env = { AGENT_TERM_START_CWD: '/fresh' };
  const file = bootstrap.applyLaunchEnv(['electron.exe', 'C:\\runner', `${LAUNCH_ENV_ARG}C:\\runner\\launch-env.json`], env, fakeFs);
  assert.strictEqual(file, 'C:\\runner\\launch-env.json');
  assert.deepStrictEqual(reads, ['C:\\runner\\launch-env.json']);
  assert.deepStrictEqual(env, { AGENT_TERM_START_CWD: '/fresh', AGENT_TERM_DEV_SOURCE_WIN: 'from-file' });
});

test('the bootstrap leaves the environment alone without the argument', () => {
  const fakeFs = { readFileSync: () => { throw new Error('should not read'); } };
  const env = { AGENT_TERM_START_CWD: '/fresh' };
  assert.strictEqual(bootstrap.applyLaunchEnv(['electron.exe', 'C:\\runner'], env, fakeFs), null);
  assert.deepStrictEqual(env, { AGENT_TERM_START_CWD: '/fresh' });
});

console.log(`\n${testsPassed} passed, ${testsFailed} failed`);
process.exit(testsFailed > 0 ? 1 : 0);
