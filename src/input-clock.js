// The input clock: how long the user has spent in AgentTerm, in minutes. A
// minute counts when any AgentTerm window took the user's input during it, so
// time away from the desk, asleep, locked, or in other apps leaves the clock
// where it was. Auto-hide measures how stale a window is on this clock, not on
// the wall clock (docs/dev/auto-hide.md).
//
// Every window shares it through one small file. Only a window taking input
// advances it, and input reaches one window at a time, so two writers meet
// only at a focus change inside the same minute; the worst a collision can do
// is miss one minute.

const fs = require('fs');
const path = require('path');
const { writeFileAtomicSync } = require('./atomic-file');

const MINUTE_MS = 60 * 1000;

function clockFile(userDataDir) {
  return path.join(userDataDir, 'input-clock.json');
}

// { minutes, minute }: the clock's reading, and the wall-clock minute that was
// counted last (so a second window's input in that minute adds nothing).
function readState(userDataDir) {
  try {
    const s = JSON.parse(fs.readFileSync(clockFile(userDataDir), 'utf8'));
    return {
      minutes: Number.isFinite(s.minutes) ? s.minutes : 0,
      minute: Number.isFinite(s.minute) ? s.minute : null,
    };
  } catch {
    return { minutes: 0, minute: null };
  }
}

function createInputClock(userDataDir, { now = Date.now } = {}) {
  // The wall-clock minute this window last settled, and the reading then.
  // Input arrives per keystroke; the file is touched once a minute at most.
  let settledMinute = null;
  let settledReading = 0;
  return {
    // The user gave input now. Counts this minute unless a window already
    // has, and returns the clock's reading.
    note() {
      const minute = Math.floor(now() / MINUTE_MS);
      if (minute === settledMinute) return settledReading;
      const s = readState(userDataDir);
      if (s.minute === null || s.minute < minute) {
        s.minutes += 1;
        s.minute = minute;
        writeFileAtomicSync(clockFile(userDataDir), JSON.stringify(s));
      }
      settledMinute = minute;
      settledReading = s.minutes;
      return settledReading;
    },
    read() {
      return readState(userDataDir).minutes;
    },
  };
}

module.exports = { createInputClock, MINUTE_MS };
