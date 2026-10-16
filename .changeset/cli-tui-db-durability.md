---
"cognia-next": patch
---

Keep CLI data written just before the TUI is closed or killed: database writes flush as they happen and on SIGINT/SIGTERM/SIGHUP, and workflow copilot runs now show up in the run history.
