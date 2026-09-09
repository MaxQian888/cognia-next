---
"cognia-next": patch
---

CLI: `cognia-agent -p` and `chat` no longer print plugin-manager and other library log lines into the answer stream. Diagnostics go to stderr (or through Ink's console in the TUI) at warn level and above, and `--verbose` (or `COGNIA_LOG_LEVEL`) brings back info/debug lines.
