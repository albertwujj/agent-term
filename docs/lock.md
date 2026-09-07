# The checkout lock

![the agent takes the lock and branches; the padlock at the top right turns green](assets/lock-padlock.png)

Several agents sharing one checkout step on each other's HEAD and working tree, and their heavy local tests bind host-global resources such as ports, so runs collide. `git worktree` splits the working tree but not those resources, and parallel worktrees are harder to track.

[agent-lock](https://github.com/yunxin/agent-lock) is the convention that serializes this. Start a task by naming [proceed-by-lock-and-branch.md](https://github.com/yunxin/agent-lock/blob/main/proceed-by-lock-and-branch.md) in the prompt, where `@proceed-b` completes to it: the agent takes the lock, cuts a fresh `work/<slug>` branch off the latest remote tip, and only then edits, releasing the lock when its resource-using phase is done.

The lock's own scripts refuse a colliding step, as an extra layer of safety. Its clean-tree guards tolerate untracked files under `ai/` by default (`SCRATCH_DIR`; set it empty for a strict check). A second verb doc, [borrow-lock.md](https://github.com/yunxin/agent-lock/blob/main/borrow-lock.md), covers a higher-priority session taking over the checkout from another holder.

The terminal shows who holds the checkout as a padlock at the top right of each window: green with a check when this terminal window holds it.

The padlock reports one repo, the first the session's shell was in, so a session working across several repos sees the state of only that one ([the lock indicator](dev/lock-indicator.md)).
