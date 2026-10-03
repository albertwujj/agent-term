// Where agent-threads' split runbook writes discussion docs:
// <git-common-dir>/discussion/<topic>.md, in subfolders when they help
// (discussion/split.md in agent-threads). The runbook's handoff is each doc's
// absolute path, printed on its own line, so a path of this shape in the
// agent's output is the agent handing the user a doc to read. Exact `.git`
// component, as for review packages (review-package-path.js).
const DISCUSSION_DOC_PATH = /\/\.git\/discussion\/(?:[^/]+\/)*[^/]+\.(?:md|markdown|mdown)$/i;

function isDiscussionDocPath(filePath) {
  const path = String(filePath || '').replace(/\\/g, '/');
  return path.startsWith('/') && DISCUSSION_DOC_PATH.test(path);
}

module.exports = { isDiscussionDocPath };
