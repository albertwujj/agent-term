// The prompt the README's "Make it yours" section gives the reader for adding
// the planning and review loops. The terminal sends the same words when a
// send finds no agent-threads runbook and the user asks it to, so there is
// one text: in the README for the reader, here for the dialog.
// test/loop-install.test.js keeps the two identical.
const AGENT_THREADS_CLONE_PROMPT =
  'Clone https://github.com/albertwujj/agent-threads into ai/ in this project, '
  + 'and leave ai/ out of .gitignore.';

module.exports = { AGENT_THREADS_CLONE_PROMPT };
