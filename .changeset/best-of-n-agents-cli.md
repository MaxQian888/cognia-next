---
"cognia-next": minor
---

Best-of-N attempts can each run on a different agent, including external CLI agents (`/best-of-n --agents claude-code,codex …` or the start dialog's per-attempt picker); external attempts show cost as unknown and refuse a dollar budget they cannot enforce.

Add `cognia-agent best-of-n start|status|list|cancel|select|publish|archive`, driving the desktop app through the CLI bridge; select and publish need an interactive terminal confirmation and the desktop's own approval.

Plugins can start and observe best-of-N runs through `ctx.team` (`startBestOfN`, `getBestOfN`, `listBestOfN`, `cancelBestOfN`); choosing and publishing a winner stays a person's decision.

A paired device can ask the executing Host to stop a best-of-N run (picking, checks and publishing stay on the Host), and a Host restart now rebinds unfinished runs: interrupted attempts are parked for inspection, never-started ones fail, and a winner left inside an integration is released for a fresh publish.
