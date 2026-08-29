---
"cognia-next": minor
---

`!` shell mode in the chat composer becomes a real shell prompt. Typing a command now offers completions — shell builtins, known CLIs and their subcommands/flags, executables on the connected Host's `$PATH`, and files and directories under the working directory — with Up/Down to move, Tab to accept and Escape to close. Completion understands the whole line, not just the first word: commands after `|`, `&&`, `||`, `;` and inside `$(…)` or backticks are recognised as commands, so `cat foo | gre` suggests `grep`. Unknown commands and unclosed quotes get an advisory red underline that never blocks Enter.

Commands now run under the shell you configured in `terminal.defaultShell` (falling back to the Host's own default) instead of always `sh -c` — fish, nushell, PowerShell and cmd each get their correct invocation — and they run on whichever Host you are attached to, so a `!` line works from a paired browser or phone, not only the desktop app. A client with no Host keeps builtin and CLI completion and says so plainly instead of failing silently. Reuses `terminal.autocomplete.enabled` as the master switch; with it off, `!` mode is unchanged.
