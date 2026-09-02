# Suite conventions

Most loops in the suite are driven by a **verb doc**: an instruction file named for what the agent is to do, like `produce-review.md` or `proceed-by-lock-and-branch.md`. Reference it in a prompt and the agent carries it out; `@` completion partial-matches, so `@proceed-b` is typically more than enough to land on `proceed-by-lock-and-branch.md`.

One resolution rule covers the suite: everything binds to these docs by filename, taking the nearest copy up the directory tree, the repo's `ai/` folder (a convention of this terminal, see below) counting as in the repo, with your home directory as the fallback. A clone under home serves every project; a clone inside a project overrides it there, with no central config anywhere.

## Placement

Two places a clone can live. Which fits depends on who reads the docs: the terminal, for the runbooks the terminal resolves itself ([voice-to-agent](https://github.com/albertwujj/voice-to-agent)), or you, for the verb docs you pick with `@` ([agent-lock](https://github.com/yunxin/agent-lock)'s `proceed-by-lock-and-branch.md`, mentioned above, and agent-threads' [produce-review.md](https://github.com/albertwujj/agent-threads/blob/main/code/produce-review.md)).

1. **Embedded in the repo** (recommended). Everything under one short folder, `ai/`: nested clones of agent-lock, agent-jobs, and agent-threads, so `@` completion reaches every verb doc, and the whole set shows as a single `ai/` line in `git status` (nested clones stay out of the outer repo on their own, and the short name keeps the noise low). Leave the folder unignored; a `.gitignore` entry would hide the docs from `@` pickers (Cursor's CLI does). The terminal's own runbook resolution looks in `ai/` too, right after the repo root, so the one agent-threads clone there serves both your `@` and the terminal.

2. **Up the tree**: a sibling clone beside the repo, or one in any directory above it, with your home directory as the terminal's final fallback. The terminal walks the chain closest-first, so one clone serves every repo below it, and a clone under home serves every project on the machine; the repo itself stays untouched. Note that an AI CLI's `@` completion may see only the workspace, so verb docs up the tree are referenced by path (`@../agent-lock/proceed-by-lock-and-branch.md`).

Clones may live in several places at once: the terminal takes the nearest copy, so an `ai/` clone in one project and a home clone for everything else never conflict.
