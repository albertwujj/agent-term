"""A composer that logs each input byte as received, for To prompt's byte order.

Draws what a CLI does: a marker, a dim placeholder after the caret, typed text.
Ctrl+U empties it and truncates the log; Ctrl+C exits to the shell.
"""
import os
import re
import sys
import termios
import tty

log_path = sys.argv[1]
PLACEHOLDER = "\x1b[2mAsk anything\x1b[22m\x1b[12D"


def draw(text):
    os.write(1, text.encode())


def empty_composer():
    draw("\r\x1b[K› " + PLACEHOLDER)


saved = termios.tcgetattr(0)
tty.setraw(0)
draw("\x1b]0;codex\x07\x1b[?2004h")
empty_composer()
placeholder_shown = True
try:
    while True:
        data = os.read(0, 65536)
        if b"\x03" in data:
            break
        if b"\x15" in data:
            open(log_path, "wb").close()
            empty_composer()
            placeholder_shown = True
            continue
        with open(log_path, "ab") as log:
            log.write(data)
        if placeholder_shown:
            draw("\x1b[K")
            placeholder_shown = False
        shown = re.sub(rb"\x1b\[20[01]~", b"", data).replace(b"\n", b"\r\n  ")
        os.write(1, shown)
finally:
    draw("\x1b[?2004l\r\n")
    termios.tcsetattr(0, termios.TCSADRAIN, saved)
