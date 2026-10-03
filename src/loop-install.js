// The prompt the terminal sends when a send finds no agent-threads runbook
// and the user asks it to: the setup guide's own step for agent-threads
// (docs/setup.md, "Add the local components") — the same clone, into ai/,
// kept out of .gitignore — so the agent is asked for what the docs describe.
// test/loop-install.test.js keeps the two in step.
const AGENT_THREADS_CLONE_PROMPT =
  'Clone https://github.com/albertwujj/agent-threads into ai/ in this project, '
  + 'and leave ai/ out of .gitignore.';

module.exports = { AGENT_THREADS_CLONE_PROMPT };
