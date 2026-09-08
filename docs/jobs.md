# Long jobs

![a long run wrapped in agent-job: the runner icon at the top right, its popover listing the job](assets/jobs-runner.png)

A long run the agent starts (CI, a heavy test suite, a deploy) leaves a standard session with two bad options: the agent either sits watching it, blocking the terminal, or ends its turn and nobody is there when the job finishes, so the result sits until you notice.

[agent-jobs](https://github.com/yunxin/agent-jobs) is the convention that fixes this. Clone it into `ai/`, make a folder of your own beside it, and ask the agent to write the verb doc and the script for your CI there, following agent-jobs' guide for agents. Neither comes with agent-jobs: they are written for your project, by your agent, and the doc is yours to settle. From then on a mention of that doc, `@run-ci` if you named it so, runs it: the agent starts the job under `agent-job`, ends its turn without stopping the work, and hands the terminal back to you. The job reports its own completion, per agent-term's [job-events.md](dev/job-events.md) contract, and when it finishes and the agent has been idle since, the terminal prompts the agent to pick the result up:

![the report the terminal hands the idle agent when the job finishes](assets/jobs-nudge.png)

The verb doc is yours after the agent writes it: read it, settle it, and the agent follows it without editing it. The scripts beside it are the usual runs; the agent may add one for a run they do not cover.

The records survive a session restart or resume, so a job outlives the session that started it.

A runner icon at the top right of the window shows the running jobs; click it for the list. The terminal reads the job records once a minute, so the icon can take that long to appear and to clear, and the report follows two minutes of the agent's idleness after the finish. The quickest first try is `agent-job sleep 180` in any window.
