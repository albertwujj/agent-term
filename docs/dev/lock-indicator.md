# The lock indicator

The padlock's decision is pure and lives in `src/lock-status.js`, with its states and inputs described there; `main.js` polls it. What follows is what neither file says on its own.

The poll anchors to one repo, resolving the session's directory to a repo root once so that a wandering shell cannot repoint the indicator. For a session that spans repos, that yields three behaviours:

- Above every repo there is no anchor, so the padlock stays hidden.
- The first repo the shell enters becomes the anchor.
- A later move to a sibling repo is not followed.

Each repo has its own lock and the agent takes whichever its task needs. Only the indicator is singular.

If sessions spanning repos become the normal way to work, the anchor worth weighing is the repo whose lock this session's token holds: it follows the work rather than the shell, and shows nothing while the session holds no lock.
