# The loops

Each loop is a small repo of its own, and each is optional: the terminal runs without any of them. The [README's prompt](../README.md#make-it-yours) adds one; the rest go in the same way.

| Loop | What it adds | Setting up |
|---|---|---|
| [agent-threads](https://github.com/albertwujj/agent-threads) | writing on [plans and documents](plan.md), and on [curated reviews](review.md) | one clone, for both |
| [agent-lock](https://github.com/yunxin/agent-lock) | the [checkout lock](lock.md) agents share | a clone |
| [agent-jobs](https://github.com/yunxin/agent-jobs) | [long runs](jobs.md) that report their own completion | a clone |
| [agent-stream-hub](https://github.com/albertwujj/agent-stream-hub) | [your phone](phone.md) as the same terminal | a relay you host, and the page added to your home screen |
| [IntelliJ Navigator](https://github.com/albertwujj/intellij-navigator/releases) | [click a reference, the IDE jumps](ide.md) | a plugin installed in the IDE |

A clone is best placed in `ai/` in the project; [placement](conventions.md) covers the other places it can live. A loop is commanded from the prompt by naming one of its instruction files, such as [`@produce-r`](https://github.com/albertwujj/agent-threads/blob/main/code/produce-review.md) for a review.

Voice on the phone reads from a kit of its own, [voice-to-agent](https://github.com/albertwujj/voice-to-agent), placed like the others. The terminal resolves it.
