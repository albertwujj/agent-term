// Probe whether bundled-CR (one write of body+\r) submits /resume on
// each CLI. We already know split-CR works for claude/codex/agent and
// NOT for copilot. If bundled also works for everyone, we can use it
// universally and skip per-CLI dispatch.

const pty = require('node-pty');
const { ResumeAutoFire } = require('../src/resume-autofire');

function stripAnsi(s) {
  return s
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b[PX^_].*?\x1b\\/g, '')
    .replace(/\x1b./g, '');
}

function probe(cli, shape) {
  return new Promise((resolve) => {
    const env = Object.assign({}, process.env, { TERM: 'xterm-256color' });
    let proc;
    try {
      proc = pty.spawn(cli, [], {
        name: 'xterm-color', cols: 100, rows: 30, cwd: process.cwd(), env,
      });
    } catch (err) {
      resolve({ error: err.message });
      return;
    }
    let post = '';
    let capture = false;
    const fire = new ResumeAutoFire({ onFire: () => {
      capture = true;
      if (shape === 'bundled') {
        proc.write('/resume\r');
      } else {
        proc.write('/resume');
        setTimeout(() => proc.write('\r'), 30);
      }
    }});
    fire.arm();
    proc.onData((d) => {
      if (fire.isArmed()) fire.recordPtyOutput(d);
      if (capture) post += d;
    });
    const tick = setInterval(() => fire.tick(), 100);
    setTimeout(() => {
      clearInterval(tick);
      try { proc.kill(); } catch {}
      resolve({ post });
    }, 20000);
  });
}

const MARKERS = {
  claude:  ['previous sessions', 'no previous conversation', 'search past'],
  codex:   ['resume a previous session', 'type to search'],
  copilot: ['resume sess'],
  agent:   ['previous sessions'],
};

(async () => {
  console.log('cli       | shape    | result');
  console.log('----------+----------+----------------------------------------');
  for (const cli of ['claude', 'codex', 'copilot', 'agent']) {
    for (const shape of ['split', 'bundled']) {
      const r = await probe(cli, shape);
      if (r.error) {
        console.log(`${cli.padEnd(9)} | ${shape.padEnd(8)} | ERROR ${r.error}`);
        continue;
      }
      const stripped = stripAnsi(r.post);
      const lower = stripped.toLowerCase();
      const hit = (MARKERS[cli] || []).find((m) => lower.indexOf(m) !== -1);
      const status = hit ? `OPENED ("${hit}")` : 'no picker';
      console.log(`${cli.padEnd(9)} | ${shape.padEnd(8)} | ${status}`);
      const peek = stripped.replace(/\s+/g, ' ').trim().slice(-400);
      console.log(`          |          | tail: ${JSON.stringify(peek)}`);
    }
  }
})();
