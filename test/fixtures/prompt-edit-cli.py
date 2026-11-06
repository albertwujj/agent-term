"""Readline supplies a real editor for the resumed-session capture test."""
import json
from pathlib import Path
import readline
import sys


def title(text):
    print("\x1b]0;" + text + "\x07", end="", flush=True)


title("agent-term-debug")
assert input("› ") == "/resume"
input("Resume filter: ")
title("Fix xterm npm vulnerability | agent-term-debug")
prompts = [input("› "), input("› ")]
Path(sys.argv[1]).write_text(json.dumps(prompts))
input("› ")  # Keep the CLI alive until the test closes its window.
