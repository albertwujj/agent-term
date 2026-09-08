# Long jobs

A long run the agent starts (CI, a heavy test suite, a deploy) leaves a standard session with two bad options: the agent either sits watching it, blocking the terminal, or ends its turn and nobody is there when the job finishes, so the result sits until you notice.

## What agent-jobs is

[agent-jobs](https://github.com/yunxin/agent-jobs) is a small convention that adds the option that was missing. The agent starts the job under its `agent-job` wrapper, ends its turn without stopping the work, and hands the terminal back to you. The job reports its own completion, per agent-term's [job-events.md](dev/job-events.md) contract, and when it finishes, the terminal prompts the agent to pick the result up:

![the report the terminal hands the idle agent when the job finishes](assets/jobs-nudge.png)

![a long run wrapped in agent-job: the runner icon at the top right, its popover listing the job](assets/jobs-runner.png)

A runner icon at the top right of the window shows the running jobs; click it for the list. How soon the icon and the report follow is in [job-events.md](dev/job-events.md). Closing a session and resuming it does not lose a job: one started before still reports to the session that comes back.

## An example: CI

CI is the example here; any long run goes the same way. Clone agent-jobs into `ai/`. Then make a folder of your own beside it, `ai/ci/` say, and ask the agent to write a [verb doc](conventions.md), `run-ci.md`, and the scripts there, following [agent-jobs' guide](https://github.com/yunxin/agent-jobs/blob/main/long-jobs.md).

After that, `@run-ci` in the prompt runs CI: the agent starts the script under `agent-job`, tells you CI is running, and ends its turn. When the run finishes, the agent evaluates the result and fixes what it finds, retrying on a transient infrastructure flake, and runs CI again the same way, until CI is green.

The agent can be told to take the [checkout lock](lock.md) while it reworks the code, or runs tests that use a shared global resource such as a port.
