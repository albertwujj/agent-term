'use strict';

const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const {
  HELPER_STALL_KILL_MS,
  WslCommandRunner,
  helperBootstrap,
  transportBackoffMs,
} = require('../src/wsl-command-runner');

function localRunner(t, onStart = () => {}) {
  const runner = new WslCommandRunner({
    spawn(command, args, options) {
      onStart();
      return spawn(command, args, options);
    },
    // The bootstrap production uses, not the bare script: passing the script
    // as an argument leaves stdin free, which is the one thing the real launch
    // has to get right and once did not.
    command: 'bash',
    args: ['-lc', helperBootstrap()],
  });
  t.after(() => runner.close());
  return runner;
}

// The helper enforces a timeout with GNU `timeout`, behind its own
// `command -v timeout` guard, so where the binary is absent it runs the
// command unbounded and only the JS-side backstop fires, two seconds late.
// That is the real dependency, not the platform: a stock macOS has no
// timeout(1) and a WSL distro always does. Mirror the guard the helper uses
// rather than testing process.platform, so the test skips on exactly the
// machines where the behaviour it asserts does not exist.
function helperCanEnforceTimeouts() {
  try {
    execFileSync('bash', ['-lc', 'command -v timeout'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test('reuses one helper and preserves command results', async (t) => {
  let starts = 0;
  const runner = localRunner(t, () => { starts += 1; });

  const first = await runner.run("printf 'hello\\n'");
  const second = await runner.run("printf 'problem\\n' >&2; exit 7");

  assert.deepEqual(first, { code: 0, stdout: 'hello\n', stderr: '' });
  assert.deepEqual(second, { code: 7, stdout: '', stderr: 'problem\n' });
  assert.equal(starts, 1);
});

test('matches concurrent requests with their responses', async (t) => {
  const runner = localRunner(t);
  const [first, second] = await Promise.all([
    runner.run("sleep 0.05; printf 'first'"),
    runner.run("printf 'second'"),
  ]);

  assert.equal(first.stdout, 'first');
  assert.equal(second.stdout, 'second');
  assert.equal(first.code, 0);
  assert.equal(second.code, 0);
});

test('enforces command timeouts inside the helper', {
  skip: helperCanEnforceTimeouts() ? false : 'no timeout(1) on PATH, so the helper cannot enforce one',
}, async (t) => {
  const runner = localRunner(t);
  const started = Date.now();
  const result = await runner.run('sleep 1', { timeout: 50 });

  assert.notEqual(result.code, 0);
  assert.ok(Date.now() - started < 1000, 'command should be stopped well before one second');
});

test('starts a timeout when a queued command begins, not while it waits', async (t) => {
  const runner = localRunner(t);
  const [slow, timed] = await Promise.all([
    runner.run('sleep 0.2; printf slow'),
    runner.run('sleep 0.01; printf timed', { timeout: 100 }),
  ]);

  assert.equal(slow.stdout, 'slow');
  assert.deepEqual(timed, { code: 0, stdout: 'timed', stderr: '' });
});

test('backs off repeated helper starts', () => {
  assert.equal(transportBackoffMs(1), 60_000);
  assert.equal(transportBackoffMs(2), 120_000);
  assert.equal(transportBackoffMs(3), 240_000);
  assert.equal(transportBackoffMs(4), 300_000);
  assert.equal(transportBackoffMs(20), 300_000);
});

test('does not retry a failed helper start on every poll', async () => {
  let starts = 0;
  let now = 1_000;
  const runner = new WslCommandRunner({
    spawn() {
      starts += 1;
      throw new Error('transport unavailable');
    },
    command: 'wsl',
    now: () => now,
  });

  const first = await runner.run('true');
  const second = await runner.run('true');
  assert.equal(first.code, 1);
  assert.match(second.stderr, /retry in 60s/);
  assert.equal(starts, 1);

  now += 60_000;
  await runner.run('true');
  assert.equal(starts, 2);
});

// A helper whose output the test writes by hand, to play a slow or failing
// transport that a real bash cannot.
function fakeHelper() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => { child.killed = true; };
  return child;
}

function fakeRunner(options = {}) {
  const children = [];
  const diagnostics = [];
  const runner = new WslCommandRunner({
    spawn() {
      const child = fakeHelper();
      children.push(child);
      return child;
    },
    command: 'wsl',
    onDiagnostic: (message) => diagnostics.push(message),
    ...options,
  });
  return { runner, children, diagnostics };
}

const flush = () => new Promise(setImmediate);
const answer = (id, stdout) =>
  `${id}\t0\t${Buffer.from(stdout).toString('base64')}\t\n`;

test('answers a late request at its deadline and keeps the helper', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { runner, children } = fakeRunner();
  t.after(() => runner.close());

  const late = runner.run('slow', { timeout: 1000 });
  children[0].stdout.write('1\tstart\n');
  await flush();
  t.mock.timers.tick(3000);
  assert.match((await late).stderr, /did not answer within 3000ms/);
  assert.equal(children[0].killed, false);

  // The answer that comes after the deadline settles nothing, and the same
  // helper serves the next request.
  children[0].stdout.write(answer(1, 'stale'));
  const next = runner.run('quick', { timeout: 1000 });
  children[0].stdout.write(`2\tstart\n${answer(2, 'fresh')}`);
  assert.equal((await next).stdout, 'fresh');
  assert.equal(children.length, 1);

  // Nothing is left armed to kill it.
  t.mock.timers.tick(HELPER_STALL_KILL_MS);
  assert.equal(children[0].killed, false);
});

test('replaces a helper that stays silent well past the deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { runner, children, diagnostics } = fakeRunner();
  t.after(() => runner.close());

  const stuck = runner.run('stuck', { timeout: 1000 });
  children[0].stdout.write('1\tstart\n');
  await flush();
  const queued = runner.run('queued');
  t.mock.timers.tick(3000);
  await stuck;
  assert.equal(children[0].killed, false);

  t.mock.timers.tick(HELPER_STALL_KILL_MS);
  assert.equal(children[0].killed, true);
  assert.match((await queued).stderr, /did not answer within 33000ms/);
  assert.match(diagnostics.at(-1), /next start in 60s/);
});

test('holds a new helper while main says to', async () => {
  let holdMs = 45_000;
  const { runner, children } = fakeRunner({ startHoldMs: () => holdMs });

  const held = await runner.run('true');
  assert.match(held.stderr, /retry in 45s/);
  assert.equal(children.length, 0);

  holdMs = 0;
  runner.run('true');
  assert.equal(children.length, 1);
  runner.close();
});

test('reads the error code wsl.exe prints instead of starting', async () => {
  const codes = [];
  const { runner, children, diagnostics } = fakeRunner({
    onWslError: (code) => codes.push(code),
  });

  const result = runner.run('true');
  // wsl.exe writes UTF-16 to the pipe whatever the console code page.
  children[0].stdout.write(Buffer.from(
    'Catastrophic failure \r\nError code: Wsl/Service/E_UNEXPECTED\r\n', 'utf16le'));
  await flush();
  children[0].emit('exit', 4294967295, null);

  assert.equal((await result).code, 1);
  assert.deepEqual(codes, ['Wsl/Service/E_UNEXPECTED']);
  assert.ok(diagnostics.includes(
    'Ignoring unexpected WSL helper output: Error code: Wsl/Service/E_UNEXPECTED'));
  assert.ok(diagnostics.includes('Ignoring unexpected WSL helper output: Catastrophic failure'));
  runner.close();
});
