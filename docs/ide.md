# Confirm with your IDE

![click a reference and your IDE jumps to that exact line](../assets/click-to-ide.gif)

Agents explain themselves by quoting file:line and symbols. `Ctrl/Cmd`-click any reference the agent mentions and your IDE jumps to that exact line, so you can drill in. It works in reverse too: wherever you are in the IDE, `Ctrl/Cmd+K` quotes that file and line into the prompt.

The IDE editor stays read-only by default, so a stray keystroke won't mess things up; flip a setting on the rare occasion you want to edit directly.

Navigation targets JetBrains today through the [IntelliJ Navigator plugins](https://github.com/albertwujj/intellij-navigator/releases). The protocol is open, newline-delimited JSON over a local socket, so other editors are easy to add; see the [API spec](https://github.com/albertwujj/intellij-navigator/blob/main/API.md).
