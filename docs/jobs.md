# Long jobs

![a long run wrapped in agent-job: the runner icon at the top right, its popover listing the job](assets/jobs-runner.png)

A long run the agent starts (CI, a heavy test suite, a deploy) leaves a standard session with two bad options: the agent either sits watching it, blocking the terminal, or ends its turn and the finish arrives to nobody, the result sitting unhandled until you notice.

[agent-jobs](https://github.com/yunxin/agent-jobs) is the convention that fixes this, and its whole interface is a wrapper: the agent runs `agent-job <command>`, ends its turn, and hands the terminal back to you; the job records its start and reports its own completion, per agent-term's [job-events.md](job-events.md) contract. When it finishes and the agent has been idle since, the terminal prompts the agent to pick the result up:

![the report the terminal hands the idle agent when the job finishes](assets/jobs-nudge.png)

**How to use it.** Tell the agent the convention once, in the project's guide file (`CLAUDE.md`, `AGENTS.md`) or in the prompt itself: run long jobs under `agent-job` in the background, then end the turn; the terminal hands over the result. `agent-job` runs the command in the foreground and reports when it exits, so the agent starts it as a background command (the CLI's background run, or a trailing `&`) and ends its turn. Scripts of your own can report a richer result by sourcing agent-jobs' `job-events.sh`: a build watch, say, reports the verdict and the build link as its message.

The records survive a session restart or resume, so a job outlives the session that started it.

A runner icon at the top right of the window shows the running jobs; click it for the list.
