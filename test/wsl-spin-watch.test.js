const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const {
  SPIN_PROBE_MS,
  HEAL_QUIET_MS,
  spinProbeScript,
  sessionProcess,
  createSpinWatch,
  claudeSessionScript,
  parseClaudeSession,
  healPlan,
  resumeCommand,
} = require('../src/wsl-spin-watch');

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log(`PASS ${name}`);
}

const shellEscape = (s) => "'" + s.replace(/'/g, "'\\''") + "'";
// CPU in the probe's 100 ns units for `cores` busy over `ms`.
const cpuFor = (cores, ms) => Math.round(cores * ms * 1e4);

(async () => {
  await check('probe script names the pid and refuses anything else', () => {
    assert.match(spinProbeScript(43396), /ProcessId=43396 OR ParentProcessId=43396/);
    assert.throws(() => spinProbeScript('1; Stop-Computer'), /not a pid/);
    assert.throws(() => spinProbeScript(0), /not a pid/);
  });

  await check('session process: the stub\'s wsl.exe child, else the pty itself', () => {
    // Real output for a window on 2026-10-29: the stub 43396 (2 threads) and its child.
    const out = '43396 1896 2 2500000\r\n35264 43396 8 16562500\r\n';
    assert.deepStrictEqual(sessionProcess(out, 43396), { pid: 35264, parent: 43396, threads: 8, cpu: 16562500 });
    assert.deepStrictEqual(sessionProcess('43396 1896 5 900\n', 43396), { pid: 43396, parent: 1896, threads: 5, cpu: 900 });
    assert.strictEqual(sessionProcess('', 43396), null);
    assert.strictEqual(sessionProcess('WARNING: something\n7 1 2 3\n', 43396), null);
  });

  await check('spinning takes two intervals over half a core in a row', () => {
    const watch = createSpinWatch();
    let cpu = 0;
    let at = 1_000;
    const step = (cores, pid = 10) => {
      cpu += cpuFor(cores, SPIN_PROBE_MS);
      at += SPIN_PROBE_MS;
      return watch.observe({ pid, threads: 11, cpu }, at);
    };
    assert.deepStrictEqual(watch.observe({ pid: 10, threads: 8, cpu }, at),
      { spinning: false, cores: null, threads: 8, pid: 10 });
    const first = step(1);
    assert.strictEqual(first.spinning, false);
    assert.ok(Math.abs(first.cores - 1) < 1e-9, `cores ${first.cores}`);
    assert.strictEqual(step(0.9).spinning, true);
    assert.strictEqual(step(0.02).spinning, false, 'a quiet interval clears it');
    assert.strictEqual(step(3).spinning, false);
    assert.strictEqual(step(3).spinning, true);
  });

  await check('a new pid or a missing process starts over', () => {
    const watch = createSpinWatch();
    watch.observe({ pid: 10, threads: 11, cpu: 0 }, 0);
    watch.observe({ pid: 10, threads: 11, cpu: cpuFor(1, SPIN_PROBE_MS) }, SPIN_PROBE_MS);
    // The shell was replaced: the new wsl.exe's counter means nothing against the old one's.
    assert.strictEqual(watch.observe({ pid: 20, threads: 5, cpu: cpuFor(9, SPIN_PROBE_MS) }, 2 * SPIN_PROBE_MS).spinning, false);
    assert.deepStrictEqual(watch.observe(null, 3 * SPIN_PROBE_MS), { spinning: false, cores: null });
  });

  await check('claude session record: the last line, with an id that resumes', () => {
    const rec = { pid: 306459, sessionId: '9b20e5d7-ef0f-4355-84c3-7e8ca7eac191', cwd: '/home/u/repo', status: 'idle' };
    assert.deepStrictEqual(parseClaudeSession('motd line\n' + JSON.stringify(rec) + '\n'),
      { sessionId: rec.sessionId, cwd: '/home/u/repo', status: 'idle' });
    assert.deepStrictEqual(parseClaudeSession(JSON.stringify({ sessionId: 'abcdef12' })),
      { sessionId: 'abcdef12', cwd: null, status: null });
    assert.strictEqual(parseClaudeSession(JSON.stringify({ sessionId: '$(rm -rf ~)' })), null);
    assert.strictEqual(parseClaudeSession('not json'), null);
    assert.strictEqual(parseClaudeSession(''), null);
  });

  await check('heal only an idle Claude session with nothing unsent', () => {
    const idle = { sessionId: 'abcdef12', status: 'idle' };
    const quiet = HEAL_QUIET_MS;
    assert.strictEqual(healPlan({ session: null, quietMs: quiet, composing: false }), 'notice');
    assert.strictEqual(healPlan({ session: idle, quietMs: quiet, composing: false }), 'heal');
    assert.strictEqual(healPlan({ session: { ...idle, status: null }, quietMs: quiet, composing: false }), 'heal');
    assert.strictEqual(healPlan({ session: { ...idle, status: 'busy' }, quietMs: quiet, composing: false }), 'wait');
    assert.strictEqual(healPlan({ session: idle, quietMs: quiet, composing: true }), 'wait');
    assert.strictEqual(healPlan({ session: idle, quietMs: quiet - 1, composing: false }), 'wait');
  });

  await check('resume line returns to the session\'s directory first', () => {
    assert.strictEqual(resumeCommand({ sessionId: 'abcdef12', cwd: "/home/u/it's here" }, shellEscape),
      "cd '/home/u/it'\\''s here' && claude --resume 'abcdef12'");
    assert.strictEqual(resumeCommand({ sessionId: 'abcdef12', cwd: null }, shellEscape),
      "claude --resume 'abcdef12'");
  });

  if (process.platform === 'linux') {
    await check('session script finds the record of the shell\'s child', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spin-watch-'));
      fs.mkdirSync(path.join(dir, 'sessions'));
      const shell = spawn('bash', ['-c', 'sleep 30 & echo $!; wait'], { stdio: ['ignore', 'pipe', 'ignore'] });
      try {
        const child = await new Promise((resolve) => shell.stdout.once('data', (d) => resolve(String(d).trim())));
        const pidFile = path.join(dir, 'pid');
        fs.writeFileSync(pidFile, `${shell.pid}\n`);
        const run = () => {
          try {
            return execFileSync('bash', ['-c', claudeSessionScript(pidFile, shellEscape)],
              { env: { ...process.env, CLAUDE_CONFIG_DIR: dir } }).toString();
          } catch (err) {
            return { code: err.status };
          }
        };
        assert.deepStrictEqual(run(), { code: 1 }, 'no record yet: not a Claude process');
        const rec = JSON.stringify({ pid: Number(child), sessionId: 'abcdef12-3456' });
        fs.writeFileSync(path.join(dir, 'sessions', `${child}.json`), rec);
        assert.strictEqual(parseClaudeSession(run()).sessionId, 'abcdef12-3456');
      } finally {
        try { execFileSync('pkill', ['-P', String(shell.pid)]); } catch {}
        shell.kill();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  console.log(`\n${passed} passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
