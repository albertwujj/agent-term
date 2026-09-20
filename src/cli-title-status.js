// Optional status evidence from CLI OSC titles. Unknown means the existing
// output-recency detector remains in charge. Keep exact vendor formats here;
// words in conversation names and arbitrary intent text are not activity.
// Format evidence and versions: docs/dev/session-titles.md.

const CODEX_STATUS = /^(Ready|Starting|Thinking|Working|Waiting|\[ [!.] \] Action Required) \| (codex(?: \| .*)?)$/;
const CURSOR_STATUS = /^(.*) - (?:📤 Moving to cloud|📂 Loading conversation|🔄 Reconnecting|⌨️? Running shell command|🧭 Planning|⏳ Working(?: [·.]{3})?|📋 Queued|❓ Waiting for you|🔐 Waiting for confirmation|📝 Reviewing changes|✅ Ready)$/u;

function cliTitleStatus(title, cli) {
  const text = typeof title === 'string' ? title.trim() : '';
  if (cli === 'codex') {
    // Status precedes app-name to distinguish it from legacy titles such as
    // "codex | Working", where Working is just the conversation's name.
    const match = CODEX_STATUS.exec(text);
    if (match) return {
      title: match[2],
      working: match[1] !== 'Ready' && !match[1].endsWith('Action Required'),
    };
  } else if (cli === 'claude') {
    // Current Claude uses half-circle frames; older versions use braille.
    // Its asterisk marker is idle, not the animated spinner in the body.
    if (/^[◐◑\u2800-\u28ff]\s+\S/u.test(text)) return { title: text, working: true };
    if (/^[✳✱]\s+\S/u.test(text)) return { title: text, working: false };
  } else if (cli === 'agent') {
    const match = CURSOR_STATUS.exec(text);
    if (match && match[1]) return {
      title: match[1],
      working: !/ - (?:✅ Ready|❓ Waiting for you|🔐 Waiting for confirmation)$/.test(text),
    };
  }
  // Copilot's title contains arbitrary intent/name text. Even its bare brand
  // can appear at turn start before intent arrives, so it is not idle evidence.
  return { title: text, working: null };
}

function createTitleActivityTracker({ multiplexer = false } = {}) {
  let lastCli = null;
  let sawClaudeBusy = false;
  return {
    working: null,
    reset() { this.working = null; lastCli = null; sawClaudeBusy = false; },
    update(title, cli) {
      if (cli !== lastCli) { this.reset(); lastCli = cli; }
      let { working } = cliTitleStatus(title, cli);
      if (cli === 'claude') {
        // Older star-only title spinners and static titles under multiplexers
        // do not prove idle. Observe the supported busy/idle pair first.
        if (working === true) sawClaudeBusy = true;
        if (multiplexer || !sawClaudeBusy) working = null;
      }
      this.working = working;
    },
  };
}

// Add an explicit-idle veto to the existing predicate. A busy title never
// latches activity forever after a CLI crashes or stops producing output.
// Unknown/disabled status formats retain the original five-second timing.
function isAgentWorking({ iconLocked, now, lastPtyOutputTime, lastTypingTime,
  titleWorking = null, idleMs = 5000, userQuietMs = 5000 }) {
  return !!iconLocked && titleWorking !== false
    && now - lastPtyOutputTime < idleMs
    && now - lastTypingTime > userQuietMs;
}

module.exports = { cliTitleStatus, createTitleActivityTracker, isAgentWorking };
