// Where the review runtime keeps its packages: <git-common-dir>/review — a
// `.git` path component followed by `review`. Exact component match, so
// `.git-review/` or a plain `review/` directory outside .git stays an ordinary
// markdown file the md viewer opens.
//
// A package is a document only the review flow can render: the md viewer would
// show the agent's prose with none of the diff it explains, so it refuses the
// path instead. Recognizing the shape is what lets a click on a bare package
// path reach the renderer rather than that refusal.
const REVIEW_RUNTIME_PATH = /\/\.git\/review\//;

function isReviewPackagePath(filePath) {
  const path = String(filePath || '').replace(/\\/g, '/');
  return REVIEW_RUNTIME_PATH.test(path) && /\.md$/i.test(path);
}

module.exports = { REVIEW_RUNTIME_PATH, isReviewPackagePath };
