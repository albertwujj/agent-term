# Add a loop

Each loop is a small repo of its own, and each is optional: the terminal runs without any of them, so add one when you want what it adds.

| Loop | What it adds | What setting it up means |
|---|---|---|
| [agent-threads](https://github.com/albertwujj/agent-threads) | writing on [plans and documents](plan.md), and on [curated reviews](review.md) | one clone, for both |
| [agent-lock](https://github.com/yunxin/agent-lock) | the [checkout lock](lock.md) agents share | a clone |
| [agent-jobs](https://github.com/yunxin/agent-jobs) | [long runs](jobs.md) that report their own completion | a clone |
| [agent-stream-hub](https://github.com/albertwujj/agent-stream-hub) | [your phone](phone.md) as the same terminal | a relay you host, and the page added to your home screen |
| [IntelliJ Navigator](https://github.com/albertwujj/intellij-navigator/releases) | [click a reference, the IDE jumps](ide.md) | a plugin installed in the IDE |

A loop is commanded from the prompt by naming one of its instruction files, such as `@produce-r` for producing a review. The CLI's `@` completion and the terminal both look for that file in the nearest clone up the directory tree. A clone's location therefore decides which projects can reach it: `ai/` inside a project, the default, serves that project, while a clone in the home directory serves every project on the machine. Leave `ai/` out of `.gitignore`: an ignored folder is invisible to some `@` pickers, and the nested clones stay out of the outer repo on their own. [Placement](conventions.md) has the rule and the trade-off.

Voice on the phone reads from a kit of its own, [voice-to-agent](https://github.com/albertwujj/voice-to-agent), placed by that same rule. The terminal resolves it and tells the agent when it cannot find it.
