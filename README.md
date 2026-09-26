# Stewrd Terminal

An embedded interactive terminal (pwsh, falling back to powershell.exe) backed by the host's PTY commands (`pty_spawn`/`pty_write`/`pty_resize`/`pty_kill`). Requires a Stewrd build that includes those PTY commands.

The sidebar icon reflects shell state:
- `in-progress` while a command is running
- `warning` when the shell appears to be waiting on input (a `y/n` prompt, a password prompt, etc.)
- `success` / `error` based on the last command's exit code
- `idle` after you focus the pane, or on startup

Detection uses OSC 133 shell-integration markers emitted by a wrapped PowerShell `prompt` function - the same mechanism used by VS Code, iTerm2, and Windows Terminal - not text scraping.

## Multiple panes

Dropping Terminal into more than one pane at once gives each pane its own independent shell, keyed by the host's per-pane id (requires a Stewrd build that passes `paneId` to plugin components). Switching a pane's tool away and back, or visiting Settings, doesn't lose that pane's shell/scrollback - but permanently closing a pane does leak its shell process until the plugin next reloads or the app restarts, since the plugin has no way to tell "pane closed" apart from "pane just hidden".
