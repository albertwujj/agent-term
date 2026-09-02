# Review, not a wall of diff

![the review loop: comment on a line, the agent fixes it and replies, the review re-renders in place](assets/review-loop.gif)

When the agent finishes, it prepares your review: it hands you the parts that need your judgment, ordered and explained with trade-offs flagged, and leaves out what doesn't need it: the routine changes (renames, imports, boilerplate) and what you already settled during the session. Comment inline, on the code *and* on its reasoning; it edits and replies in the thread, with the latest shown in real time.

The loop's instruction docs live in [agent-threads](https://github.com/albertwujj/agent-threads): reference [produce-review.md](https://github.com/albertwujj/agent-threads/blob/main/code/produce-review.md) in a prompt and the agent produces the package and hands you the link.

The spec is open, the review is markdown, this terminal renders it and carries your inline comments back. Other hosts welcome.
