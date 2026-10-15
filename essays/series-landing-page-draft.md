# Rethink what a terminal should be for AI CLIs

*Andy Yunxin Wu · A series on the design decisions behind AgentTerm*

Some people love terminals; others hate them. Some are surprised that AI tools are drawing people to the terminal.

I have been using AI CLIs in a terminal for coding, writing, planning and review. My focus is on understanding and steering the agents' work, rather than running commands. While I appreciate what the terminal offers, I want it to work differently, both inside its window and on the desktop.

I built [AgentTerm](https://github.com/albertwujj/agent-term#agentterm) as an experiment and have been using it since January. These essays explore the motivations and design choices behind it.

## Essays

### 1. [Why I give each agent its own OS window and a distinct Dock tile or taskbar button](https://github.com/albertwujj/agent-term/blob/main/essays/own-os-window.md)

Each lead agent gets a recognizable place on the desktop. The OS helps me switch between them, and a picker brings earlier sessions back without keeping every window in view.

### 2. [Why I run my own terminal from source](https://github.com/albertwujj/agent-term/blob/main/essays/run-from-source.md)

Running from source makes the terminal easy to personalize. A new window runs my changes while existing windows keep working.

### 3. [Why I open documents, code and images right in the agent’s terminal window](https://github.com/albertwujj/agent-term/blob/main/essays/files-in-terminal.md)

Conversation works well for exploration. Refinement needs a stable place to see changes in context and discuss them.

## Coming next

### Why I review an agent's curated walkthrough over the full diff

The agent explains the change through the code that needs my attention, including relevant code that did not change.

### Why I make my agents share one checkout over separate worktrees

How I manage several agents working on the same project, including the conflicts and limits of sharing a checkout.

### Why AgentTerm builds on the terminal's plain text over integrations and plugins

File references and text conventions connect the CLI conversation to richer views and actions in the terminal.

### Why AgentTerm uses a folder hierarchy of Markdown guides instead of skills

How related guides lead agents to the instructions they need, with agent-threads as a concrete example.

---

AgentTerm also supports [commenting directly on an agent's output](https://github.com/albertwujj/agent-term/blob/main/docs/comment.md). I may return to broader workflow topics, including writing with coding agents and why I ask my transcription service to skip auto-correction.

[AgentTerm: source, demonstration and setup](https://github.com/albertwujj/agent-term#agentterm)
