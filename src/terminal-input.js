// Telling the user's input from the terminal's own traffic. Everything bound for
// the pty arrives through one channel, xterm's onData: keys and pastes, but also
// focus reports (CSI I / CSI O, on every focus change with mode 1004) and replies
// to a CLI's probes (cursor position, device attributes, palette queries).
//
// Rule: a multi-byte ESC-prefixed sequence is protocol, never the user's input.
//   · A bare ESC is the Esc key, and counts as input.
//   · A bracketed paste (ESC[200~ … ESC[201~) is ESC-prefixed but is the user's:
//     it is text they put in the prompt, as much as if they had typed it.
//   · Arrow, function and navigation keys ride ESC prefixes too, so they read as
//     protocol. A deliberate tradeoff: they move around a screen, and mostly leave
//     nothing behind for anyone to protect. Up recalling a history line is the
//     exception, which only reading the screen can see.
//
// Main and the renderer each hold decisions on this answer, so both ask here. Two
// copies drifted once: main took pastes for protocol, and a host notice's CR then
// submitted a pasted draft.

function isTerminalProtocol(data) {
  return typeof data === 'string'
    && data.length > 1
    && /^\x1b[\[\]OP_^]/.test(data)
    && !data.startsWith('\x1b[200~');
}

module.exports = { isTerminalProtocol };
