// The prompt the terminal sends when a send finds no agent-threads runbook
// and the user asks it to: the README's "Fit it to your work" example for adding
// a loop, with agent-threads' URL in place of the loop shown there, so a
// reader who has seen the README recognises it. test/loop-install.test.js
// keeps the two the same shape.
const AGENT_THREADS_CLONE_PROMPT =
  'Clone https://github.com/albertwujj/agent-threads into ai/ in this project, '
  + 'and leave ai/ out of .gitignore.';

module.exports = { AGENT_THREADS_CLONE_PROMPT };
