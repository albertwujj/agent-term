# Long jobs

![a long run wrapped in agent-job: the runner icon at the top right, its popover listing the job](assets/jobs-runner.png)

A long run the agent starts (CI, a heavy test suite, a deploy) leaves a standard session with two bad options: the agent either sits watching it, blocking the terminal, or ends its turn and the finish arrives to nobody, the result sitting unhandled until you notice.

[agent-jobs](https://github.com/yunxin/agent-jobs) is the convention that fixes this, and its whole interface is a wrapper: the agent runs `agent-job <command>`, ends its turn, and hands the terminal back to you; the job records its start and reports its own completion, per agent-term's [job-events.md](job-events.md) contract. When it finishes and the agent has been idle since, the terminal prompts the agent to pick the result up:

![the report the terminal hands the idle agent when the job finishes](assets/jobs-nudge.png)

The records survive a session restart or resume, so a job outlives the session that started it.

A runner icon at the top right of the window shows the running jobs; click it for the list.
