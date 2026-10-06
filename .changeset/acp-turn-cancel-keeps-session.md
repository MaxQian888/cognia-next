---
"cognia-next": patch
---

Stopping an ACP agent's turn (Claude Code, Codex, Gemini, Goose, Kimi, Devin and other ACP agents) no longer discards its session: the next message continues in the same session instead of reconnecting, and pausing an ACP teammate reports it as paused.
