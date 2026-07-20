---
"cognia-next": minor
---

Chat "simplified" display mode now folds tool calls the way the TUI does. Bursts of context-gathering reads (Read/Grep/Glob/ls and web fetches) collapse into one glanceable "3 reads · 2 searches" activity group, while the real actions — edits, writes and commands — and any running or failed tool stay as their own prominent rows instead of being buried. A folded group stays open while a tool is still running or has errored (so live progress and failures are never hidden) and auto-collapses once everything settles. Collapsed rows now show a unified output-size hint (lines/matches/files) for every tool, a running tool streams a live "N lines…" chip, and a group with failures shows an "N failed" badge. Expanding/collapsing no longer clips its last rows, and the view no longer drifts off the bottom when a streamed turn finishes. Standard and detailed modes are unchanged.
