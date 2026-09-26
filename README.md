# Stewrd Terminal

An embedded interactive terminal (pwsh, falling back to powershell.exe) backed by the host's PTY commands (`pty_spawn`/`pty_write`/`pty_resize`/`pty_kill`). Requires a Stewrd build that includes those PTY commands.

The sidebar icon reflects shell state:
- `in-progress` while a command is running
- `warning` when the shell appears to be waiting on input (a `y/n` prompt, a password prompt, etc.)
- `success` / `error` based on the last command's exit code
- `idle` after you focus the pane, or on startup

Detection uses OSC 133 shell-integration markers emitted by a wrapped PowerShell `prompt` function - the same mechanism used by VS Code, iTerm2, and Windows Terminal - not text scraping.
