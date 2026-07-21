// Integration test for the remote-input → PTY path.
//
// Production flow:
//   viewer POSTs /input → hub queues → next heartbeat response delivers
//   inputs to StreamClient → client.js calls onInputs → main.js wires
//   onInputs to a loop that calls writeAsSubmission(prompt) per input.
//
// This test exercises the SOURCE side of that flow without standing up a
// real hub: we mirror main.js's onInputs handler and writeAsSubmission
// helper byte-for-byte, spawn each CLI through node-pty, wait for it to
// settle, deliver a /resume input, and check whether the picker UI
// shows up in the post-output. If this passes, the path works in
// production for whatever agent-term binary has the same helpers.

const pty = require('node-pty');

// Matches main.js's echo-wait submission timing.
const SUBMIT_POST_ECHO_MS = 100;
const SUBMIT_FALLBACK_MS = 1500;
const POST_INPUT_CAPTURE_MS = 15000;  // Copilot's picker takes ~10s

function stripAnsi(s) {
  return s
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b[PX^_].*?\x1b\\/g, '')
    .replace(/\x1b./g, '');
}

// Verbatim copy of main.js's echo-wait submit helper. The caller tracks
// PTY output time via `getLastOutputAt`; we pass that in instead of a
// global so the test fixture stays self-contained.
function writeAsSubmission(proc, body, getLastOutputAt) {
  if (!proc) return false;
  const tBefore = getLastOutputAt();
  try { proc.write(body); } catch { return false; }
  let crSent = false;
  const sendCR = () => {
    if (crSent || !proc) return;
    crSent = true;
    clearInterval(echoTimer);
    clearTimeout(fallbackTimer);
    try { proc.write('\r'); } catch {}
  };
  const echoTimer = setInterval(() => {
    if (getLastOutputAt() > tBefore) {
      clearInterval(echoTimer);
      setTimeout(sendCR, SUBMIT_POST_ECHO_MS);
    }
  }, 30);
  const fallbackTimer = setTimeout(sendCR, SUBMIT_FALLBACK_MS);
  return true;
}
function onInputsHandler(proc, inputs, getLastOutputAt) {
  for (const raw of inputs) {
    if (typeof raw !== 'string') continue;
    const prompt = raw.replace(/[\r\n]+/g, ' ').trim();
    if (!prompt) continue;
    writeAsSubmission(proc, prompt, getLastOutputAt);
  }
}

const RESUME_UI_MARKERS = {
  claude:  ['ctrl+a to show all projects', 'type to search', 'esc to cancel'],
  codex:   ['resume a previous session', 'type to search'],
  copilot: ['sort:relevance', 'enter select', 'esc cancel'],
  agent:   ['previous sessions', 'no sessions or cloud agents'],
};

// Wait this long after spawn before injecting — generous so the CLI
// has time to boot and present its input prompt. With auto-fire
// removed, we don't need adaptive detection: production also requires
// the user to wait for the CLI before pressing Enter / sending input.
const PRE_INJECT_WAIT_MS = 6000;

function spawnAndInject(cli) {
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
    let injected = false;
    let injectedAt = null;
    let lastOutputAt = 0;
    const start = Date.now();

    proc.onData((data) => {
      lastOutputAt = Date.now();
      if (injected) post += data;
    });

    // Inject after a generous fixed wait — mimics "user picked session
    // and pressed Enter once the CLI looked ready."
    setTimeout(() => {
      injected = true;
      injectedAt = Date.now() - start;
      onInputsHandler(proc, ['/resume'], () => lastOutputAt);
    }, PRE_INJECT_WAIT_MS);

    setTimeout(() => {
      try { proc.kill(); } catch {}
      resolve({ post, injectedAt });
    }, PRE_INJECT_WAIT_MS + POST_INPUT_CAPTURE_MS);
  });
}

async function main() {
  let passed = 0, failed = 0;
  for (const cli of ['claude', 'codex', 'copilot', 'agent']) {
    process.stdout.write('[' + cli + '] spawning... ');
    const r = await spawnAndInject(cli);
    if (r.error) {
      console.log('SKIP (' + r.error + ')');
      continue;
    }
    const stripped = stripAnsi(r.post || '');
    const lower = stripped.toLowerCase();
    const markers = RESUME_UI_MARKERS[cli] || [];
    const hit = markers.find(function (m) { return lower.indexOf(m) !== -1; }) || null;
    const peek = stripped.replace(/\s+/g, ' ').trim().slice(0, 280);
    if (hit) {
      console.log('OK   injectedAt=' + r.injectedAt + 'ms bytes=' + (r.post || '').length + ' UI:"' + hit + '"');
      passed++;
    } else {
      console.log('FAIL injectedAt=' + r.injectedAt + 'ms bytes=' + (r.post || '').length + ' UI:NONE');
      failed++;
    }
    if (peek) console.log('       peek: ' + JSON.stringify(peek));
  }
  console.log('\n--- Remote-input integration: ' + passed + ' passed, ' + failed + ' failed ---');
  process.exit(failed ? 1 : 0);
}

main();
