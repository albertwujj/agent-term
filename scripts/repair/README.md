# Repair scripts

One-time fixes for data AgentTerm wrote before it recorded something it now
needs. Each one is safe to run more than once and does nothing when there is
nothing to fix. Run them from the checkout, with AgentTerm closed.

## backfill-cursor-conversations.js

Older Cursor sessions were recorded without the conversation ID that resume
needs, so picking one from the session list cannot resume it. This matches
those sessions to Cursor's own chat history by their prompts and writes the
ID back.

It only prints what it would change until you pass `--apply`. On Windows the
profile is the Windows one, reached from WSL through `/mnt/c`:

```bash
node scripts/repair/backfill-cursor-conversations.js \
  --user-data "/mnt/c/Users/<you>/AppData/Roaming/agent-term"
node scripts/repair/backfill-cursor-conversations.js \
  --user-data "/mnt/c/Users/<you>/AppData/Roaming/agent-term" --apply
```

On macOS the profile is `~/Library/Application Support/agent-term`.
