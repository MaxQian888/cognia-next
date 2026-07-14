---
"cognia-next": patch
---

Fix the macOS Fleet island: the tucked strip is now OS-level click-through (it no longer swallows clicks aimed at the menu bar under the notch) with a native cursor-driven slam-to-top reveal; a completed Claude Code / Codex / OpenCode turn no longer leaves a stale "needs input" row (idle notifications are honored mid-turn only, and turn-complete / session-idle release parked plans, questions, and permissions); a stale pin or missed mouseleave can no longer keep the island expanded on screen indefinitely.
