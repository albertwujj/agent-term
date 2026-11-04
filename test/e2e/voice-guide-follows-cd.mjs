// End-to-end: a voice transcript names the guide of the directory the CLI was
// started in, not the one the window opened on. The shell opens on `start`,
// cds into a subfolder of another repo, and starts a fake CLI there; a local
// hub then hands the window a voice transcript and, on the next heartbeat, a
// typed line. The fake CLI records every byte it is given.
//
// Two decoys sit where a lookup made too early or in the wrong order lands:
// `start/voice-to-agent` (the window's opening directory) and the folder just
// above the repo (an ancestor checked before the repo's ai/ once was). The
// right copy is the repo's `ai/voice-to-agent`. The typed line must arrive
// after the transcript, though the transcript waits for its lookup.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { launchElectron } from './electron.mjs';

const require = createRequire(import.meta.url);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-term-voice-guide-')));
const home = path.join(scratch, 'home');
const start = path.join(scratch, 'start');
const proj = path.join(scratch, 'proj');
const sub = path.join(proj, 'src');
const guide = (root) => path.join(root, 'voice-to-agent', 'interpret.md');
for (const dir of [home, start, sub]) fs.mkdirSync(dir, { recursive: true });
// The lookup's probes run in login shells. A slow login makes the transcript's
// lookup outlast the gap to the next heartbeat, so a typed line that does not
// wait its turn would overtake it.
fs.writeFileSync(path.join(home, '.bash_profile'), 'case "$-" in *i*) ;; *) sleep 1 ;; esac\n');
execFileSync('git', ['init', '-q', proj]);
for (const root of [start, scratch, path.join(proj, 'ai')]) {
  fs.mkdirSync(path.dirname(guide(root)), { recursive: true });
  fs.writeFileSync(guide(root), '# interpret\n');
}

const pendingVoice = [];
const pendingInputs = [];
let heartbeats = 0;
let voiceDelivered = false;
const hub = http.createServer(async (req, res) => {
  for await (const _ of req) { /* drain */ }
  const body = { ok: true, viewerAgeMs: null };
  if (/^\/runs\/[^/]+\/heartbeat$/.test(req.url)) {
    heartbeats++;
    body.inputs = pendingInputs.splice(0);
    body.voiceInputs = pendingVoice.splice(0);
    if (body.voiceInputs.length) voiceDelivered = true;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
});
await new Promise((resolve) => hub.listen(0, '127.0.0.1', resolve));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, message, timeout = 20_000) {
  const begin = Date.now();
  while (!predicate()) {
    assert.ok(Date.now() - begin < timeout, message);
    await sleep(80);
  }
}
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";

const ready = path.join(scratch, 'ready');
const received = path.join(scratch, 'received');
const fake = path.join(scratch, 'fake.cjs');
fs.writeFileSync(fake, `
  const fs = require('node:fs');
  fs.writeFileSync(${JSON.stringify(ready)}, process.cwd());
  // A title is how the window learns the CLI is up; capture waits for it.
  process.stdout.write('\\x1b]0;✳ Voice test\\x1b\\\\');
  // Cooked mode: the tty echoes what is typed, which is what prompt capture
  // reads back, and the echo is what a submission waits for before its CR.
  process.stdin.on('data', (chunk) => fs.appendFileSync(${JSON.stringify(received)}, chunk));
`);
const receivedText = () => (fs.existsSync(received) ? fs.readFileSync(received, 'utf8') : '');

const app = await launchElectron({
  executablePath: require('electron'),
  args: ['--no-sandbox', `--user-data-dir=${path.join(scratch, 'userdata')}`, repo],
  env: {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    AGENT_TERM_START_CWD: start,
    AGENT_STREAM_HUB_URL: `http://127.0.0.1:${hub.address().port}`,
    TMUX: '', STY: '', ZELLIJ: '',
  },
  timeout: 45_000,
});
let failed = false;
try {
  const page = await app.firstWindow();
  await page.waitForSelector('.xterm-helper-textarea');
  await sleep(1000);
  if (await page.locator('.at-picker-overlay').count()) await page.keyboard.press('Escape');
  const terminal = page.locator('.xterm-helper-textarea');
  await terminal.focus();
  await page.keyboard.type(`claude() { ${quote(process.execPath)} ${quote(fake)} "$@"; }`);
  await page.keyboard.press('Enter');
  await page.keyboard.type(`cd ${quote(sub)}`);
  await page.keyboard.press('Enter');
  await sleep(300);
  await page.evaluate((command) => window.pty.pickerStartNew(command), 'claude');
  await until(() => fs.existsSync(ready), 'the fake CLI did not start');
  assert.equal(fs.readFileSync(ready, 'utf8'), sub, 'the CLI started where the shell cd\'d');

  await terminal.focus();
  await page.keyboard.type('first prompt so the session streams');
  await page.keyboard.press('Enter');
  await until(() => heartbeats > 0, 'no heartbeat reached the hub');

  pendingVoice.push('run the pie test');
  await until(() => voiceDelivered, 'the hub never handed over the transcript');
  pendingInputs.push('typed after voice');
  await until(() => receivedText().includes('typed after voice') && receivedText().includes('pie test'),
    'the transcript and the typed line did not both reach the CLI');

  const text = receivedText();
  assert.ok(text.includes(`[${guide(path.join(proj, 'ai'))}]\nrun the pie test`),
    `the transcript names the repo's ai/ copy: ${JSON.stringify(text.slice(-400))}`);
  assert.ok(!text.includes('[Warning from terminal host]'), 'no missing-guide warning');
  assert.ok(text.indexOf('run the pie test') < text.indexOf('typed after voice'),
    'the typed line arrived after the transcript');
  // The tty turns the submit's CR into \n. Without it between them, the two
  // would reach a real CLI's composer together and go out as one prompt.
  assert.ok(text.includes('run the pie test\x1b[201~\ntyped after voice'),
    `the transcript was submitted before the typed line began: ${JSON.stringify(text.slice(-120))}`);
  console.log('PASS voice guide follows the directory the CLI started in');
} catch (err) {
  failed = true;
  console.log('FAIL ' + (err && err.message));
} finally {
  await app.close().catch(() => {});
  hub.close();
  fs.rmSync(scratch, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
