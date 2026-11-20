# Setup scripts

Run by hand, once per machine. The app launches from the checkout and never
installs itself, so anything a platform expects of an installed app lives here.

## windows-shortcuts.js

Windows only, and it runs inside WSL. There is no macOS setup script.

Adds AgentTerm to the Windows Start menu, to the Startup folder so it opens
at logon, and to Settings > Apps where it can be uninstalled. The entry
launches this checkout and opens the window in the directory you name.

Run it from WSL, in the directory the window should open in:

```bash
node ~/agent-term/scripts/setup/windows-shortcuts.js --dir ~/primary
```

Running it again replaces the shortcuts in place. Remove them from Settings >
Apps.

The icon is `icon.svg` beside this script, the same one the phone app uses.
The script renders it to a `.ico`; that needs Pillow (`pip install pillow`).
