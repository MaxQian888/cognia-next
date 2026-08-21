---
"cognia-next": minor
---

Imported conversations now say where they came from. A chat opened from an
external coding agent's history carries a "From Claude Code / Codex / …" chip in
its header, and when the on-disk source changes after you have continued the
conversation in Cognia, the chip becomes an explicit "moved on" warning you can
dismiss — the divergence signal the import guard has always described but never
actually surfaced. Imported subagent inner transcripts are also included in full
backups and cross-device sync, so the "Open transcript" link on a parent turn no
longer leads to a missing conversation after a restore; if one is genuinely
absent, the link now says so instead of opening a blank chat.
