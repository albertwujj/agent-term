# Rethink the terminal: A portal to AI

*Andy Yunxin Wu · A series on the design decisions behind AgentTerm*

AI CLIs have fundamentally changed what I use a terminal for. I now use it for almost all my work: coding, planning, review and writing, from starting a task to finishing it and revisiting it later.

My focus is on understanding and steering agents’ work rather than running commands. That calls for a terminal designed around this collaboration, both inside the window and across the desktop.

I built [AgentTerm](https://github.com/albertwujj/agent-term#agentterm) as an experiment and have been using it since January. These essays explore the motivations and design choices behind reshaping the terminal as a portal to AI.

## Rethinking the terminal

### 1. [Why I give each lead agent its own OS window and a unique Dock tile or taskbar button](https://yunxin.github.io/rethink-terminal/own-os-window/)

### 2. [Why I run AgentTerm from source](https://yunxin.github.io/rethink-terminal/run-from-source/)

My agent changes the source; the next window runs it. No installer dialog or launch command.

### 3. [Why documents, code and images open right in the agent’s terminal window](https://yunxin.github.io/rethink-terminal/files-in-terminal/)

The agent writes; we collaborate on the rendered content.

### 4. Plain text as an interface to build on

## Building on the terminal

Beyond the terminal itself, I have been exploring how its new capabilities can improve the way I work with agents.

### 5. [Curated code review: explanations grounded in code](https://yunxin.github.io/rethink-terminal/curated-review/)

I removed a check so the agent could focus on what needs my judgment.

### 6. A hub for agents across machines, with phone and voice access

The agent interprets my spoken instructions in the context of our work.

---

AgentTerm has other features and design choices not covered above, such as [writing with coding agents](https://github.com/albertwujj/agent-term/blob/main/docs/plan.md), [commenting on their terminal output](https://github.com/albertwujj/agent-term/blob/main/docs/comment.md) or [copying it without reformatting](https://github.com/albertwujj/agent-term/blob/main/docs/copy.md), [connecting to an IDE](https://github.com/albertwujj/agent-term/blob/main/docs/ide.md), [running long jobs](https://github.com/albertwujj/agent-term/blob/main/docs/jobs.md), [coordinating a shared workspace](https://github.com/albertwujj/agent-term/blob/main/docs/lock.md), and [setting up and invoking guides across AI CLIs using a namespace convention based on folder paths](https://github.com/albertwujj/agent-term/blob/main/docs/conventions.md#guides-across-cli-vendors).

Check out the [AgentTerm repo](https://github.com/albertwujj/agent-term#agentterm), try it for yourself, and build on it.
