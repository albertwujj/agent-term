# The suite

Each piece of the suite is a small repo of its own, and each is optional.

| Piece | What it adds | Setting up |
|---|---|---|
| [agent-threads](https://github.com/albertwujj/agent-threads) | writing on [plans and documents](plan.md), and on [curated reviews](review.md) | one clone, for both |
| [agent-lock](https://github.com/yunxin/agent-lock) | the [checkout lock](lock.md) agents share | a clone |
| [agent-jobs](https://github.com/yunxin/agent-jobs) | [long runs](jobs.md) that report their own completion | a clone |
| [agent-stream-hub](https://github.com/albertwujj/agent-stream-hub) | [your phone](phone.md) as the same terminal | a relay you host and the page added to your home screen; a [voice-to-agent](https://github.com/albertwujj/voice-to-agent) clone on the terminal's machine for voice interpretation |
| [IntelliJ Navigator](https://github.com/albertwujj/intellij-navigator/releases) | [click a reference, the IDE jumps](ide.md) | a plugin installed in the IDE |

A clone is best placed in `ai/` in the project (see [placement](conventions.md) for alternatives). Reuse the README's [example prompt for agent-lock](../README.md#where-to-go-next) for agent-threads, agent-jobs, or voice-to-agent by replacing the repository URL.

The agent-facing pieces are commanded from the prompt by naming one of their instruction files, such as [`@produce-r`](https://github.com/albertwujj/agent-threads/blob/main/code/produce-review.md) for a review.
