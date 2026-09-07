# Confirm with your IDE

![click a reference and your IDE jumps to that exact line](assets/click-to-ide.gif)

Agents explain by quoting file:line and symbols. Click any reference the agent mentions and your IDE jumps to that exact line after a brief pause for selection gestures; `Ctrl/Cmd`-click jumps immediately ([click behavior](clicks.md)). It works in reverse too: wherever you are in the IDE, `Ctrl/Cmd+K` quotes that file and line into the prompt.

The IDE editor stays read-only by default, so a stray keystroke won't mess things up; flip a setting on the rare occasion you want to edit directly.

Navigation targets JetBrains today through the [IntelliJ Navigator plugins](https://github.com/albertwujj/intellij-navigator/releases). Until an IDE with the plugin is listening, a click on a reference shows a notice pointing here, once per window; a `Ctrl/Cmd`-click shows it every time. The protocol is open, newline-delimited JSON over a local socket, so other editors are easy to add; see the [API spec](https://github.com/albertwujj/intellij-navigator/blob/main/API.md).
