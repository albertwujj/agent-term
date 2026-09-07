# The lock indicator

The padlock at the top right of each window reports [agent-lock](https://github.com/yunxin/agent-lock)'s state for one repo. The decision is pure (`src/lock-status.js`): from the git facts, this window's `AGENT_SESSION_ID`, and the holder window's record, it returns one of `none`, `free`, `mine`, `other-active`, `other-idle`, `no-window`. Main polls and draws. The icon never pings, prompts, or interrupts an agent; the protocol's own refusals are where a wrong step is caught.

## Which repo it watches

The poll anchors. The session's current directory is resolved once to a repo root (`git rev-parse --show-toplevel`), cached, and probed from then on, so a shell that wanders into a subdirectory, a sibling repo, or a transient directory cannot repoint the indicator. The anchor is re-resolved only when it stops being a repo.

For a session that spans repos, that means three things. Above every repo there is no anchor, so the padlock stays hidden. The first repo the shell enters becomes the anchor. A later move to a sibling repo is not followed, so the padlock keeps reporting the first.

Each repo has its own lock and the agent takes whichever its task needs; only the indicator is singular. Following the live directory instead would repoint the padlock on every `cd`, which costs more than it gives for something read at a glance. The alternative worth weighing, if multi-repo sessions become common, is anchoring to the repo whose lock this session's token holds: it follows the work rather than the shell, and shows nothing while the session holds no lock.
