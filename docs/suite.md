# The suite

The [recommended setup](setup.md#recommended-setup) adds the local components together. Each is a small repo and can also be used on its own.

## Included in the recommended setup

| Piece | What it adds | Setting up |
|---|---|---|
| [agent-threads](https://github.com/albertwujj/agent-threads) | writing on [plans and documents](plan.md), and on [curated reviews](review.md) | one clone, for both |
| [agent-lock](https://github.com/yunxin/agent-lock) | the [checkout lock](lock.md) agents share | a clone |
| [agent-jobs](https://github.com/yunxin/agent-jobs) | [long runs](jobs.md) that report their own completion | a clone |
| [voice-to-agent](https://github.com/albertwujj/voice-to-agent) | interpreting [dictated input](phone.md#reply-from-the-same-terminal) using the agent's session context | a clone on the machine running the agent |

## Using the components

- **[Plans and documents](plan.md):** ask your agent to write a Markdown file, then open it in AgentTerm to comment or write directly on it.
- **[Curated reviews](review.md):** ask your agent to follow [produce-review.md](https://github.com/albertwujj/agent-threads/blob/main/code/produce-review.md); `@produce-r` completes to it.
- **[Checkout lock](lock.md):** start a task with [proceed-by-lock-and-branch.md](https://github.com/yunxin/agent-lock/blob/main/proceed-by-lock-and-branch.md); `@proceed-b` completes to it.
- **[Long jobs](jobs.md):** ask your agent to follow [long-jobs.md](https://github.com/yunxin/agent-jobs/blob/main/long-jobs.md) when starting a long run.

The voice interpretation guide is referenced automatically with transcripts from the phone viewer. Recording and transcription require the hub's [voice input setup](https://github.com/albertwujj/agent-stream-hub/blob/main/docs/setup.md#optional-voice-input).

## Set up separately

| Piece | What it adds | Setting up |
|---|---|---|
| [agent-stream-hub](https://github.com/albertwujj/agent-stream-hub) | [your phone](phone.md) as the same terminal | a relay you host; voice input needs recording and transcription configured too |
| [IntelliJ Navigator](https://github.com/albertwujj/intellij-navigator/releases) | [click a reference, the IDE jumps](ide.md) | a plugin installed in the IDE |
