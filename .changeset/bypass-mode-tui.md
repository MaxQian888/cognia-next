---
"cognia-next": minor
---

TUI: first-class bypass permission mode — `--bypass` launch flag, a once-per-session acknowledgement before any no-guardrail switch, and Shift+Tab access. External agents now run under the same permission: Codex drops its sandbox to full access in bypass (and `thread/start` finally sends the sandbox in the wire format it accepts), and the footer says when a backend can only enforce a weaker mode.
