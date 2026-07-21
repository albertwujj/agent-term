// Test whether character-by-character typing (with realistic delays)
// is both:
//   (a) visually faithful — the user sees "/resume" being typed in the
//       CLI's input box, character by character.
//   (b) functionally correct — Enter at the end submits and opens the
//       session picker.
//
// Tries several inter-character delays per CLI; reports submit
// detection from picker-UI markers.

const pty = require('node-pty');
const { ResumeAutoFire } = require('../src/resume-autofire');

const PICKER_MARKERS = {
  claude:  ['ctrl+a to show all projects', 'type to search', 'esc to cancel'],
  codex:   ['resume a previous session', 'type to search'],
  copilot: ['sort:relevance', 'enter select', 'esc cancel'],
  agent:   ['previous sessions', 'no sessions or cloud agents'],
};

function stripAnsi(s) {
  return s
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b[PX^_].*?\x1b\\/g, '')
    .replace(/\x1b./g, '');
}

function typeChars(proc, text, perCharDelayMs, postBodyDelayMs) {
  return new Promise((resolve) => {
    let i = 0;
    const next = () => {
      if (i < text.length) {
        proc.write(text[i++]);
        setTimeout(next, perCharDelayMs);
      } else {
        setTimeout(() => { proc.write('\r'); resolve(); }, postBodyDelayMs);
      }
    };
    next();
  });
}

function probe(cli, perChar, postBody) {
  return new Promise((resolve) => {
    const env = Object.assign({}, process.env, { TERM: 'xterm-256color' });
    let proc;
    try {
      proc = pty.spawn(cli, [], {
        name: 'xterm-color', cols: 100, rows: 30, cwd: process.cwd(), env,
      });
    } catch (err) { resolve({ error: err.message }); return; }

    let post = '';
    let typing = false;
    const fire = new ResumeAutoFire({
      onFire: () => {
        typing = true;
        typeChars(proc, '/resume', perChar, postBody);
      },
    });
    fire.arm();

    proc.onData((d) => {
      if (fire.isArmed()) fire.recordPtyOutput(d);
      if (typing) post += d;
    });

    const tick = setInterval(() => fire.tick(), 100);
    setTimeout(() => {
      clearInterval(tick);
      try { proc.kill(); } catch {}
      resolve({ post });
    }, 25000);
  });
}

(async () => {
  const variants = [
    { perChar: 50, postBody: 100 },
    { perChar: 80, postBody: 150 },
    { perChar: 120, postBody: 200 },
  ];
  for (const cli of ['claude', 'codex', 'copilot', 'agent']) {
    console.log('\n=== ' + cli + ' ===');
    for (const v of variants) {
      const r = await probe(cli, v.perChar, v.postBody);
      if (r.error) { console.log('  ' + JSON.stringify(v) + ' → ERROR ' + r.error); continue; }
      const stripped = stripAnsi(r.post).toLowerCase();
      const hit = (PICKER_MARKERS[cli] || []).find((m) => stripped.indexOf(m) !== -1);
      const status = hit ? 'picker OPENED ("' + hit + '")' : 'NO picker';
      console.log('  perChar=' + v.perChar + 'ms postBody=' + v.postBody + 'ms → ' + status);
    }
  }
})();
