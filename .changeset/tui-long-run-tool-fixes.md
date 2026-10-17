---
"cognia-next": patch
---

Fix five agent-tool defects found in a long-running TUI test: Esc and timeouts now stop every process a `bash` command started, heredoc contents no longer trip the interactive-command check, `apply_patch` rejects diffs with no hunk instead of reporting success, multi-step turns report the real context-window occupancy (and `autoCompact: false` now disables runtime auto-compaction), and `working_set` works in CLI sessions.
