# Path resolution

How a clicked name becomes a file. The user-facing rules are in [docs/paths.md](../paths.md); this is the design behind them.

## Two resolvers, one seam

Both live in `src/main.js` and probe the disk only through the POSIX shell seam. On Windows the files live in WSL, where the UI process's own filesystem cannot reach, so the shell is the only route that works in production, and macOS takes the same route so both platforms exercise one path. Every command is portable across WSL Linux and macOS: `test`, `find … | head` (no GNU-only `-quit`), `cat`, and python3 where a walk has to stop on a deadline.

**The OS and IDE route** (`resolveClickedPath`). Absolute and `~` paths are checked as they are. A relative path is tried exactly under the live shell cwd; in the default mode that hit wins outright and the wider searches run only on a miss. The search matches a path with separators as a whole suffix and a bare name by name, under the cwd first, then home, with a short timeout on each. A path containing `..` is resolved against the cwd only, since it has no suffix to search by. Up to eight hits become a chooser. The explicit mode, Alt-click, runs the full sweep even when the cwd hit exists, so every candidate lands in the chooser with the cwd hit first.

**The markdown route** (`resolveMarkdownChoices`). Scope is the repo (the cwd tree), then its sibling folders, then home. Siblings are reached by rooting the search at the cwd's parent, refused when that parent is a top-level directory such as `/Users` or `/home`. A path with separators is specific enough to resolve without a chooser: the exact hit under the cwd, else the nearest suffix match. A bare name lists every same-named file so duplicates surface a chooser: the repo is walked exhaustively, since it is small and it is where duplicates matter, then the siblings under a wall-clock budget of a few seconds, then home. The chooser here filters as you type, so it can carry a long list where the Alt-click chooser fits eight. Every markdown resolution, a click, a refresh, a history entry, goes through the same discovery and ordering, so a gesture that cannot show a chooser lands on the file a click would default to.

## Pruning

One prune set serves the click resolvers and the viewer selector's disk walk (`src/viewer-disk-search.js`): `node_modules`, `.cache`, `.npm`, `Library`. `.git` is pruned by content rather than by name, so `.git/discussion` stays reachable while objects, refs, and the review runtime stay out of every search.

## Deadlines

A `find` cannot be stopped on a deadline without losing what it has printed, so timed-out searches keep the hits printed before the kill, and the walks that must stop on time, the sibling sweep and the selector's, are python with a deadline argument. Budgets and caps are constants at the top of the resolver section in `src/main.js`; change them there, not here.

## The renderer's side

`src/renderer.js` decides what was clicked before anything is resolved: the file reference on the clicked row nearest the click, else the nearest file context up to two hundred rows above (diff headers, edit boxes, a printed path). Markdown goes to the markdown route and the viewer; an Alt-click chooses among all matches first and then flows through the normal destinations with an absolute path; everything else goes to the OS route. A miss ends in a toast rather than a fallback, since the viewer's own read would only repeat the same sweep.
