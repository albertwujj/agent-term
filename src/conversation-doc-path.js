// Where agent-threads' continue-in-doc runbook writes conversation docs:
// <git-common-dir>/conversation/<topic>.md, in subfolders when they help
// (conversation/continue-in-doc.md in agent-threads). The runbook's handoff is
// each doc's absolute path, printed on its own line, so a path of this shape
// in the agent's output is the agent handing the user a doc to continue in.
// Exact `.git` component, as for review packages (review-package-path.js).
const CONVERSATION_DOC_PATH = /\/\.git\/conversation\/(?:[^/]+\/)*[^/]+\.(?:md|markdown|mdown)$/i;

function isConversationDocPath(filePath) {
  const path = String(filePath || '').replace(/\\/g, '/');
  return path.startsWith('/') && CONVERSATION_DOC_PATH.test(path);
}

module.exports = { isConversationDocPath };
