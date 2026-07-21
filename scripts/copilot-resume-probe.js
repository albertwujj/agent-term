// One-off probe: try several submit-shape variants against Copilot
// and see which one (if any) actually opens its session picker.
// Output for each variant: a peek of the post-submit PTY stream.

const pty = require('node-pty');
const { ResumeAutoFire } = require('../src/resume-autofire');

function stripAnsi(s) {
  return s
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b[PX^_].*?\x1b\\/g, '')
    .replace(/\x1b[()][AB012]/g, '')
    .replace(/\x1b./g, '');
}

function tryVariant(label, write) {
  return new Promise((resolve) => {
    const env = Object.assign({}, process.env, { TERM: 'xterm-256color' });
    const proc = pty.spawn('copilot', [], {
      name: 'xterm-color', cols: 100, rows: 30, cwd: process.cwd(), env,
    });
    const start = Date.now();
    let post = '';
    let capture = false;
    const fire = new ResumeAutoFire({ onFire: () => {
      capture = true;
      write(proc);
    }});
    fire.arm();
    proc.onData((data) => {
      if (fire.isArmed()) fire.recordPtyOutput(data);
      if (capture) post += data;
    });
    const tick = setInterval(() => fire.tick(), 100);
    setTimeout(() => {
      clearInterval(tick);
      try { proc.kill(); } catch {}
      const peek = stripAnsi(post).replace(/\s+/g, ' ').trim().slice(0, 400);
      console.log(`\n[${label}] bytes=${post.length}`);
      console.log(`  peek: ${JSON.stringify(peek)}`);
      resolve();
    }, 15000);
  });
}

(async () => {
  // V1: bundled \r at the end (no split).
  await tryVariant('bundled /resume\\r', (p) => p.write('/resume\r'));
  // V2: split-CR 30ms (production shape).
  await tryVariant('split 30ms /resume then \\r', (p) => {
    p.write('/resume');
    setTimeout(() => p.write('\r'), 30);
  });
  // V3: split-CR 200ms (longer delay).
  await tryVariant('split 200ms /resume then \\r', (p) => {
    p.write('/resume');
    setTimeout(() => p.write('\r'), 200);
  });
  // V4: \r\n instead of \r.
  await tryVariant('bundled /resume\\r\\n', (p) => p.write('/resume\r\n'));
  // V5: char-by-char typing + \r.
  await tryVariant('char-by-char then 100ms \\r', (p) => {
    const chars = '/resume';
    let i = 0;
    const next = () => {
      if (i < chars.length) {
        p.write(chars[i++]);
        setTimeout(next, 20);
      } else {
        setTimeout(() => p.write('\r'), 100);
      }
    };
    next();
  });
  // V6: \n only.
  await tryVariant('bundled /resume\\n', (p) => p.write('/resume\n'));
})();
