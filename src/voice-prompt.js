// What precedes a voice transcript in the paste the host injects. The resolved
// reference is the normal case; the rest is what to say when the guide cannot
// be found, which is the case the user meets while away from the machine.
//
// Both reference forms are a published contract with this kit
// (voice-to-agent/.maintainer/guide-design.md) — change them there first.
const VOICE_RUNBOOK = 'voice-to-agent/interpret.md';
const BARE_REFERENCE = `[@${VOICE_RUNBOOK}]`;

// Said once per instance, because it is the only chance to say where the host
// looked and how to fix it. The clauses earn their length in that one turn:
// where it looked, do not go looking yourself, what the text actually is, and
// the one place that explains the fix.
// The one thing that has to hold on every turn, guide or no guide. Both forms
// carry it word for word, so it is written once rather than kept in step by
// hand — and the repeat is exactly this and nothing else.
const DICTATION_CLAUSE =
  'Text below is dictated speech, not typing: repair it against this session before '
  + 'acting, and ask rather than guess when a reading is not safe.';

const GUIDE_MISSING_FIRST =
  '[Warning from terminal host] The voice interpretation guide is missing: not in this '
  + 'repo, its parents, or the home directory. The reference below will not resolve, so '
  + 'do not search for it. ' + DICTATION_CLAUSE
  + ' Setup and placement: https://github.com/albertwujj/voice-to-agent';

// Every utterance after, in the same instance. A Notice rather than a Warning:
// the fact has already been raised, and repeating the heavier envelope for
// something the agent was told a minute ago reads as alarm without news.
//
// It carries the operative clause and nothing else. The missing guide, where
// the host looked and how to fix it were the first message's business; saying
// them again is meta about a fact already delivered, where this is the one
// thing that has to be true on every turn — what the text is and how to read
// it. That clause is the guide's own opening, which is what the envelope owes
// an agent that cannot read the guide.
const GUIDE_MISSING_AGAIN = `[Notice from terminal host] ${DICTATION_CLAUSE}`;

// `resolvedPath` is the guide's absolute path, or null when the ladder found
// nothing. `warned` is whether this instance has already sent the long form.
//
// Returns the prefix lines and the new `warned` state. The caller owns the
// state so a resumed session, which is a new instance, warns again: the host
// cannot know what a previous agent was told, and a fresh context needs the
// long form as much as a first one did.
function voicePromptPrefix({ resolvedPath = null, warned = false } = {}) {
  if (resolvedPath) return { prefix: `[${resolvedPath}]`, warned };
  const lead = warned ? GUIDE_MISSING_AGAIN : GUIDE_MISSING_FIRST;
  return { prefix: `${lead}\n${BARE_REFERENCE}`, warned: true };
}

module.exports = {
  VOICE_RUNBOOK,
  BARE_REFERENCE,
  DICTATION_CLAUSE,
  GUIDE_MISSING_FIRST,
  GUIDE_MISSING_AGAIN,
  voicePromptPrefix,
};
