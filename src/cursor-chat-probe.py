"""Print the resumable chat in the foreground Cursor process of a Linux PTY."""

import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time


UUID = re.compile(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", re.I)
INIT = re.compile(rb"^\[([^\]]+)\] conversationClassification\.init (\{.*\})$")
LOG_NAME = re.compile(r"session-.*-([0-9]+)-[0-9]+\.log")
TICKS = os.sysconf("SC_CLK_TCK")


def process_stat(pid):
    # The command name in parentheses can itself contain spaces and parentheses.
    return Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()


def foreground(root):
    shell = process_stat(root)
    group = int(shell[5])
    if group <= 0 or group == int(shell[2]):
        return {}
    rows = subprocess.check_output(["ps", "-e", "-o", "pid=,ppid=,pgid="], text=True)
    processes = {pid: (parent, pgrp) for pid, parent, pgrp in
                 (map(int, line.split()) for line in rows.splitlines() if line.strip())}
    result = {}
    for pid, (_, pgrp) in processes.items():
        if pgrp != group:
            continue
        ancestor = pid
        depth = 0
        while ancestor != root and ancestor in processes and depth < 64:
            ancestor = processes[ancestor][0]
            depth += 1
        if ancestor == root:
            result[pid] = depth
    return result


def timestamp(value):
    return datetime.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def last_chat(log, pid, born):
    with log.open("rb") as stream:
        stream.readline(512)
        header = json.loads(stream.readline(8192))
        if (not isinstance(header, dict) or header.get("event") != "debug-session-start"
                or header.get("pid") != pid):
            return None
        if timestamp(header["startTime"]) < born:
            return None

        # Read backward in chunks. The active-chat event may be much earlier
        # than the latest diagnostics, and logs can grow for days.
        offset = stream.seek(0, os.SEEK_END)
        remainder = b""
        while offset:
            size = min(offset, 65536)
            offset -= size
            stream.seek(offset)
            lines = (stream.read(size) + remainder).split(b"\n")
            remainder = lines.pop(0) if offset else b""
            for line in reversed(lines):
                match = INIT.fullmatch(line.rstrip(b"\r"))
                if match:
                    try:
                        record = json.loads(match[2])
                        return timestamp(match[1].decode()), record
                    except (ValueError, TypeError):
                        continue
    return None


def resume_dir(record):
    chat = record.get("conversationId")
    workspace = record.get("workspacePath")
    if not isinstance(chat, str) or not UUID.fullmatch(chat):
        return {"id": None}

    config = os.environ.get("CURSOR_CONFIG_DIR")
    xdg = os.environ.get("XDG_CONFIG_HOME")
    chats = (Path(config) if config else Path(xdg) / "cursor" if xdg
             else Path.home() / ".cursor") / "chats"
    candidates = set()
    for folder in chats.glob(f"*/{chat}"):
        if not (folder / "store.db").is_file():
            continue
        try:
            meta = json.loads((folder / "meta.json").read_text())
        except (OSError, ValueError):
            meta = {}
        if not isinstance(meta, dict) or meta.get("hasConversation") is False:
            continue
        for directory in (meta.get("cwd"), workspace):
            if (isinstance(directory, str) and directory.startswith("/")
                    and hashlib.md5(os.fsencode(directory)).hexdigest() == folder.parent.name):
                candidates.add(directory)
    if len(candidates) != 1:
        return {"id": None}
    return {"id": chat.lower(), "dir": candidates.pop()}


def probe(root):
    processes = foreground(root)
    if not processes:
        return None
    boot = time.time() - time.clock_gettime(time.CLOCK_BOOTTIME)
    logs = Path(tempfile.gettempdir()) / f"cursor-agent-logs-{os.getuid()}"
    latest = {}
    for log in logs.iterdir():
        match = LOG_NAME.fullmatch(log.name)
        if not match or int(match[1]) not in processes:
            continue
        pid = int(match[1])
        try:
            started = process_stat(pid)[19]
            found = last_chat(log, pid, boot + int(started) / TICKS)
            if (found and process_stat(pid)[19] == started and
                    (pid not in latest or found[0] > latest[pid][0])):
                latest[pid] = found
        except (OSError, KeyError, TypeError, ValueError):
            continue
    if not latest:
        return None
    depth = min(processes[pid] for pid in latest)
    records = [row for pid, (_, row) in latest.items() if processes[pid] == depth]
    if len(records) != 1 or not isinstance(records[0], dict):
        return {"id": None}
    return resume_dir(records[0])


try:
    result = probe(int(sys.argv[1]))
    if result is not None:
        print("cursor-chat\t" + json.dumps(result))
except (OSError, ValueError, subprocess.CalledProcessError):
    pass
