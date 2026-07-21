#!/usr/bin/env node
'use strict';

// Dev-only full-screen alt-buffer demo for manually testing AgentTerm search
// behavior without depending on an external TUI like Copilot.

const ESC = '\x1b';
const ENTER_ALT_SCREEN = `${ESC}[?1049h${ESC}[2J${ESC}[H${ESC}[?25l`;
const EXIT_ALT_SCREEN = `${ESC}[?25h${ESC}[?1049l`;

const FRAME_COUNT = 24;
const AUTO_ADVANCE_MS = 850;
const BURST_STEPS = 12;
const BURST_INTERVAL_MS = 120;

let currentFrameIndex = 0;
let redrawCount = 0;
let autoAdvanceTimer = null;
let burstTimer = null;
let burstStepsRemaining = 0;
let cleanedUp = false;
let lastAction = 'Started demo';
let lastFrameChangeAt = new Date();
let showHelp = false;

const frames = buildFrames(FRAME_COUNT);

function buildFrames(count) {
  const topics = [
    'handoff parser', 'caret probe', 'retry loop', 'diff overlay',
    'session replay', 'burst capture', 'cursor trace', 'quote path',
    'link matcher', 'viewport sync', 'scroll restore', 'checkpoint flush',
  ];
  const owners = ['atlas', 'rhea', 'milo', 'sol', 'nora', 'iris'];
  const files = [
    'src/renderer.js:405',
    'src/terminal-keyboard.js:25',
    'test/integration.test.js:878',
    'src/navigation.js:112',
    'src/main.js:315',
    'README.md:15',
  ];

  return Array.from({ length: count }, (_, index) => {
    const number = index + 1;
    const padded = String(number).padStart(2, '0');
    const topic = topics[index % topics.length];
    const owner = owners[index % owners.length];
    const fileRef = files[index % files.length];

    return {
      id: number,
      token: `ALT-DEMO-${padded}`,
      phrase: `history-search-sample-${padded}-${topic.replace(/\s+/g, '-')}`,
      title: `Frame ${padded}: ${topic}`,
      fileRef,
      symbolRef: `AltHistoryDemo.frame${padded}`,
      url: `https://example.com/agent-term/alt-demo/${padded}`,
      owner,
      noteA: `Owner ${owner} staged ${topic} on batch ${100 + number}.`,
      noteB: `Unique replay needle ${padded} should disappear after the next repaint.`,
      noteC: `Clickable target ${fileRef} stays visible only on this frame.`,
    };
  });
}

function isInteractiveTty() {
  return !!(process.stdin.isTTY && process.stdout.isTTY);
}

function write(text) {
  process.stdout.write(text);
}

function clearScreen() {
  write(`${ESC}[2J${ESC}[H`);
}

function moveCursor(row, col) {
  write(`${ESC}[${row};${col}H`);
}

function clampFrameIndex(index) {
  const lastIndex = frames.length - 1;
  if (index < 0) return 0;
  if (index > lastIndex) return lastIndex;
  return index;
}

function setFrame(index, reason) {
  const nextIndex = clampFrameIndex(index);
  if (nextIndex === currentFrameIndex && reason !== 'refresh') {
    lastAction = `${reason}: stayed on frame ${String(currentFrameIndex + 1).padStart(2, '0')}`;
    render();
    return;
  }

  currentFrameIndex = nextIndex;
  lastFrameChangeAt = new Date();
  lastAction = `${reason}: moved to frame ${String(currentFrameIndex + 1).padStart(2, '0')}`;
  render();
}

function nextFrame(reason) {
  setFrame((currentFrameIndex + 1) % frames.length, reason);
}

function previousFrame(reason) {
  setFrame((currentFrameIndex - 1 + frames.length) % frames.length, reason);
}

function toggleAutoAdvance() {
  if (autoAdvanceTimer) {
    clearInterval(autoAdvanceTimer);
    autoAdvanceTimer = null;
    lastAction = 'Autoplay disabled';
    render();
    return;
  }

  autoAdvanceTimer = setInterval(() => {
    nextFrame('autoplay');
  }, AUTO_ADVANCE_MS);
  lastAction = `Autoplay enabled at ${AUTO_ADVANCE_MS}ms`;
  render();
}

function stopBurst() {
  if (!burstTimer) return;
  clearInterval(burstTimer);
  burstTimer = null;
  burstStepsRemaining = 0;
}

function startBurst() {
  stopBurst();
  burstStepsRemaining = BURST_STEPS;
  lastAction = `Burst started: ${BURST_STEPS} frames at ${BURST_INTERVAL_MS}ms`;
  render();

  burstTimer = setInterval(() => {
    burstStepsRemaining -= 1;
    nextFrame('burst');
    if (burstStepsRemaining <= 0) {
      stopBurst();
      lastAction = 'Burst finished';
      render();
    }
  }, BURST_INTERVAL_MS);
}

function truncateLine(text, width) {
  if (width <= 0) return '';
  if (text.length <= width) return text;
  if (width <= 3) return text.slice(0, width);
  return `${text.slice(0, width - 3)}...`;
}

function buildBodyLines(frame, columns, rows) {
  const width = Math.max(20, columns);
  const controls = autoAdvanceTimer
    ? 'keys: n next  p prev  a auto-off  b burst  h help  q quit'
    : 'keys: n next  p prev  a auto-on   b burst  h help  q quit';
  const status = burstTimer
    ? `burst ${burstStepsRemaining} left`
    : 'Burst idle';
  const timeLabel = lastFrameChangeAt.toISOString().slice(11, 19);

  const rawLines = [
    `AgentTerm alt demo | ${frame.title} | draw ${redrawCount}`,
    controls,
    '',
    `Token: ${frame.token}`,
    `Phrase: ${frame.phrase}`,
    `File: ${frame.fileRef}`,
    `Symbol: ${frame.symbolRef}`,
    `URL: ${frame.url}`,
    `State: owner ${frame.owner} | auto ${autoAdvanceTimer ? 'on' : 'off'} | ${status}`,
    `Action: ${lastAction}`,
    `Changed: ${timeLabel}`,
    '',
    `Needle: replay-${String(frame.id).padStart(2, '0')}-gone-next-frame`,
    `Note: ${frame.noteC}`,
    '',
    'Burst away from a token, then search it again in history.',
  ];

  if (showHelp) {
    rawLines.push(
      '',
      'Help:',
      '  n / space / right / down = next',
      '  p / left / up          = prev',
      '  a = toggle autoplay',
      '  b = run fast burst',
      '  r = redraw current frame',
      '  h or ? = toggle help',
      '  q or Ctrl-C = quit',
    );
  }

  const trimmed = rawLines
    .map((line) => truncateLine(line, width))
    .slice(0, Math.max(1, rows - 1));
  while (trimmed.length < rows) trimmed.push('');
  return trimmed;
}

function render() {
  if (cleanedUp) return;
  redrawCount += 1;

  const columns = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;
  const frame = frames[currentFrameIndex];
  const lines = buildBodyLines(frame, columns, rows);

  clearScreen();
  for (let row = 0; row < rows; row++) {
    moveCursor(row + 1, 1);
    write(truncateLine(lines[row] || '', columns));
    write(`${ESC}[K`);
  }
  moveCursor(1, 1);
}

function cleanupAndExit(exitCode) {
  if (cleanedUp) {
    process.exit(exitCode);
    return;
  }

  cleanedUp = true;
  stopBurst();
  if (autoAdvanceTimer) {
    clearInterval(autoAdvanceTimer);
    autoAdvanceTimer = null;
  }

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }

  write(EXIT_ALT_SCREEN);
  process.exit(exitCode);
}

function tokenizeInput(input) {
  const tokens = [];
  let index = 0;

  while (index < input.length) {
    const nextThree = input.slice(index, index + 3);
    if (
      nextThree.length === 3
      && nextThree[0] === '\u001b'
      && nextThree[1] === '['
      && 'ABCD'.includes(nextThree[2])
    ) {
      tokens.push(nextThree);
      index += 3;
      continue;
    }

    tokens.push(input[index]);
    index += 1;
  }

  return tokens;
}

function handleToken(token) {
  if (token === '\u0003' || token === 'q') {
    cleanupAndExit(0);
    return;
  }

  if (token === 'n' || token === ' ' || token === '\u001b[C' || token === '\u001b[B') {
    nextFrame('manual-next');
    return;
  }

  if (token === 'p' || token === '\u001b[D' || token === '\u001b[A') {
    previousFrame('manual-prev');
    return;
  }

  if (token === 'a') {
    toggleAutoAdvance();
    return;
  }

  if (token === 'b') {
    startBurst();
    return;
  }

  if (token === 'r') {
    lastAction = 'Forced redraw';
    setFrame(currentFrameIndex, 'refresh');
    return;
  }

  if (token === 'h' || token === '?') {
    showHelp = !showHelp;
    lastAction = showHelp ? 'Help opened' : 'Help closed';
    render();
  }
}

function handleInput(chunk) {
  const input = chunk.toString('utf8');
  for (const token of tokenizeInput(input)) {
    handleToken(token);
  }
}

function main() {
  if (!isInteractiveTty()) {
    process.stderr.write('This demo needs an interactive TTY. Run it inside AgentTerm or another terminal.\n');
    process.exit(1);
  }

  process.on('SIGINT', () => cleanupAndExit(0));
  process.on('SIGTERM', () => cleanupAndExit(0));
  process.on('exit', () => {
    if (!cleanedUp) {
      write(EXIT_ALT_SCREEN);
    }
  });
  process.on('uncaughtException', (error) => {
    write(EXIT_ALT_SCREEN);
    process.stderr.write(`${error.stack || error}\n`);
    process.exit(1);
  });

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', handleInput);
  process.stdout.on('resize', () => render());

  write(ENTER_ALT_SCREEN);
  render();
}

main();
