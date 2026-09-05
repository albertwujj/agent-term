'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const test = require('node:test');
const {
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

test('enforces command timeouts inside the helper', async (t) => {
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
