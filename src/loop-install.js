// The prompt the terminal sends when a send finds no agent-threads runbook
// and the user asks it to: the setup guide's own step for agent-threads
// (docs/setup.md, "Add the local components") — the same clone, into
// ai/agent-threads, kept out of .gitignore — so the agent is asked for what the
// docs describe. The folder is named in full: "into ai/" reads as making ai/
// the clone itself, where the runbook lookup (ai/agent-threads/…) never finds
// it. test/loop-install.test.js keeps the two in step.
const AGENT_THREADS_CLONE_PROMPT =
  'Clone https://github.com/albertwujj/agent-threads into ai/agent-threads in this project, '
  + 'and leave ai/ out of .gitignore.';

module.exports = { AGENT_THREADS_CLONE_PROMPT };
