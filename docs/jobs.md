# Long jobs

![a long run wrapped in agent-job: the runner icon at the top right, its popover listing the job](assets/jobs-runner.png)

A long run the agent starts (CI, a heavy test suite, a deploy) leaves a standard session with two bad options: the agent either sits watching it, blocking the terminal, or ends its turn and nobody is there when the job finishes, so the result sits until you notice.

## What agent-jobs is

[agent-jobs](https://github.com/yunxin/agent-jobs) is a small convention that removes the choice. The agent starts the job under its `agent-job` wrapper, ends its turn without stopping the work, and hands the terminal back to you. The job reports its own completion, per agent-term's [job-events.md](dev/job-events.md) contract, and when it finishes and the agent has been idle since, the terminal prompts the agent to pick the result up:

![the report the terminal hands the idle agent when the job finishes](assets/jobs-nudge.png)

A runner icon at the top right of the window shows the running jobs; click it for the list. The terminal reads the job records once a minute, so the icon can take that long to appear and to clear, and the report follows two minutes of the agent's idleness after the finish. The records survive a session restart or resume, so a job outlives the session that started it. The quickest first try is `agent-job sleep 180` in any window.

## Using it for CI

Clone agent-jobs into `ai/`. Then make a folder of your own beside it, `ai/ci/` say, and ask the agent to write two things there: a verb doc, `run-ci.md`, and a script for the usual run, `run-ci.sh`, following agent-jobs' guide for agents. Neither comes with agent-jobs: they are written for your project, by your agent, and the doc is yours to settle. Read it, change what you want, and from then on the agent follows it without editing it. The scripts beside it are the usual runs; the agent may add one for a run they do not cover.

After that, `@run-ci` in the prompt runs CI: the agent starts the script under `agent-job`, tells you CI is running, and ends its turn. When the run finishes, the report reaches the idle agent with the log's path; on a failure the agent reads the log, fixes what it finds, and runs CI again the same way, until the report says pass.
