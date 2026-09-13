"""A local composer for the Electron capture test; it never runs an agent."""
import os
import re
import termios
import tty


def write(text):
    os.write(1, text.encode())


original = termios.tcgetattr(0)
tty.setraw(0)
prompt = ""
completions = {"@pr-rev": "@ai/gerrit/pr-review.md", "@guide": "@docs/guide.md"}


def redraw():
    suggestion = "   → @docs/never-picked.md" if prompt in completions else ""
    write("\r\x1b[2K  → " + prompt + "\r\n\x1b[2K" + suggestion +
          "\r\n\x1b[2KLocal composer\x1b[2A")


try:
    write("\x1b]0;Cursor Agent\x07")
    redraw()
    while True:
        data = os.read(0, 1)
        if not data or data == b"\x03":
            break
        key = data.decode()
        if key in ("\r", "\n", "\t") and prompt in completions:
            prompt = completions[prompt] + " "
        elif key in ("\r", "\n"):
            write("\r\n\x1b[J\r\nRead @logs/output-only.md\r\n\r\n")
            write("\x1b]0;Review the proposed change\x07")
            prompt = ""
        elif key == "\x7f":
            prompt = prompt[:-1]
        elif re.match(r"[ -~]", key):
            prompt += key
        redraw()
finally:
    termios.tcsetattr(0, termios.TCSADRAIN, original)
