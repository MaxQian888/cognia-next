---
"cognia-next": minor
---

Reworked Bash tool-call rendering in the message stream: instead of a heavy bordered card with status badges, a Parameters JSON block and a nested dark terminal, a call is now a single inline row — breathing status dot + `$` + command (first line, truncated, shimmer while running) with hover-revealed copy / run-in-dock actions. Expanding shows a theme-matched output block that echoes the full command like a real terminal transcript (multi-line commands get a `+N lines` hint on the row) followed by ANSI-aware output; failed calls keep the same row and show the parsed error trace. The ai-elements `Terminal` component was realigned with upstream (ANSI support via `ansi-to-react`, `TerminalContext`, copy/clear buttons, auto-scroll).
