// The session's identity text: the verbatim first prompt, and, when that is
// short, the next one or two joined on.
//
// The identity drives the taskbar icon letters and the Dock tile, the window
// title, the chrome bar, the picker's first line, and the thumbnail header.
// A first prompt of a few words ("generate more") names none of that well,
// and the prompt after it usually does. So a short first prompt takes the
// next one, and the one after, until the text reaches IDENTITY_MIN_LEN or
// IDENTITY_MAX_PROMPTS have joined. The first prompt stays in front, so the
// icon letters (the first characters of the identity) never change; only
// the rest grows, once or twice, early in the session.
//
// A prompt later than IDENTITY_WINDOW_MS after the first never joins: a
// session resumed from the picker a day later keeps the label the user
// picked it by. The window is generous because the gap between a short
// first prompt and its follow-up is usually the agent's run.
//
// One rule for both sides: the fold in sessions-log.js (what the picker
// and a resume read) and the live window's own state in main.js build the
// identity from the same prompts with this function, so they agree.

const IDENTITY_MIN_LEN = 24;
const IDENTITY_MAX_PROMPTS = 3;
const IDENTITY_WINDOW_MS = 30 * 60 * 1000;
const IDENTITY_SEPARATOR = ' · ';

// prompts: [{ prompt, t }] in chronological order — every prompt of the
// session, or as many as the caller kept before the identity was complete.
// Returns { text, prompts, complete }: the identity text, the prompts it is
// built from (a prefix of the input), and whether a later prompt can still
// change it. A caller holding an incomplete identity keeps feeding prompts;
// one holding a complete identity can stop.
function identityFromPrompts(prompts) {
  const parts = [];
  let text = '';
  for (const p of prompts || []) {
    if (!p || typeof p.prompt !== 'string' || !p.prompt) continue;
    if (parts.length > 0 && (isSettled(text, parts) || (p.t || 0) - parts[0].t > IDENTITY_WINDOW_MS)) {
      // This prompt does not join, and no later one can: later prompts
      // are later still.
      return { text, prompts: parts, complete: true };
    }
    parts.push({ prompt: p.prompt, t: p.t || 0 });
    text = parts.map(x => x.prompt).join(IDENTITY_SEPARATOR);
  }
  return { text, prompts: parts, complete: isSettled(text, parts) };
}

function isSettled(text, parts) {
  return text.length >= IDENTITY_MIN_LEN || parts.length >= IDENTITY_MAX_PROMPTS;
}

module.exports = {
  identityFromPrompts,
  IDENTITY_MIN_LEN,
  IDENTITY_MAX_PROMPTS,
  IDENTITY_WINDOW_MS,
  IDENTITY_SEPARATOR,
};
