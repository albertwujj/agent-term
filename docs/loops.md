# Add a loop

Each loop is a small repo of its own, and each is optional: the terminal runs without any of them, so add one when you want what it adds.

| Loop | What it adds | What setting it up means |
|---|---|---|
| [agent-threads](https://github.com/albertwujj/agent-threads) | writing on [plans](plan.md) and [curated reviews](review.md) | a clone |
| [agent-lock](https://github.com/yunxin/agent-lock) | the [checkout lock](lock.md) agents share | a clone |
| [agent-jobs](https://github.com/yunxin/agent-jobs) | [long runs](jobs.md) that report their own completion | a clone |
| [agent-stream-hub](https://github.com/albertwujj/agent-stream-hub) | [your phone](phone.md) as the same terminal | a relay you host, and the page added to your home screen |
| [IntelliJ Navigator](https://github.com/albertwujj/intellij-navigator/releases) | [click a reference, the IDE jumps](ide.md) | a plugin installed in the IDE |

Where a clone sits decides what resolves, and the default is the project's own `ai/` folder. You command these loops by naming an instruction file (`@produce-r` for producing a review), and both your `@` completion and the terminal take the nearest copy up the directory tree. That folder serves the project it sits in; a clone in your home directory serves every project on the machine instead. [Placement](conventions.md) has the rule and the trade-off.

Voice on the phone reads from a kit of its own, [voice-to-agent](https://github.com/albertwujj/voice-to-agent), placed by that same rule. The terminal resolves it and tells the agent when it cannot find it.
