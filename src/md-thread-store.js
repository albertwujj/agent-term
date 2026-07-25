// Where a markdown document's thread store lives, and how that path reaches the
// filesystem on each deployment.
//
// The store used to be the document's hidden sibling, /path/.NAME-comments.json.
// That works, but it puts an untracked dotfile beside every commented document,
// and the only way to quiet git is a glob (`.*-comments.json`) written into each
// clone's .git/info/exclude — a pattern you have to parse, in a file that does
// not travel. A folder is the .DS_Store shape instead: one name, recognised on
// sight, ignored once in a global gitignore and then handled everywhere.
//
// The folder is still the document's sibling, so this needs no git resolution
// and behaves identically for documents outside a repo.
//
// The agent-facing contract is ~/agent-threads/contract.md + md/user-intent.md.

const MD_STORE_DIR = '.agent-threads';

// /path/NAME.md → /path/.agent-threads/NAME-comments.json
//
// NAME is the document's basename verbatim (no case or character transform) and
// the markdown extension is replaced by -comments.json, which is the suffix both
// surfaces share. The leading dot the sibling form carried is dropped: the
// folder is already hidden, and a dotfile inside a dot-folder is noise.
function mdStorePosixPath(docPath) {
  const doc = String(docPath || '');
  const cut = doc.lastIndexOf('/') + 1;
  const dir = doc.slice(0, cut);
  const stem = doc.slice(cut).replace(/\.(?:md|markdown|mdown)$/i, '');
  return `${dir}${MD_STORE_DIR}/${stem}-comments.json`;
}

// A WSL POSIX path in the UNC form Windows can open. On Windows the app runs on
// the host while the shell, the documents and their stores all live inside WSL,
// so every fs call from main has to cross that boundary. Separators flip and the
// \\wsl.localhost\<distro> prefix goes on the front; nested directories need no
// special handling, which is what makes the store folder work here unchanged.
function uncFromPosix(posixPath, distro) {
  return `\\\\wsl.localhost\\${distro}${String(posixPath || '').replace(/\//g, '\\')}`;
}

module.exports = {
  MD_STORE_DIR,
  mdStorePosixPath,
  uncFromPosix,
};
