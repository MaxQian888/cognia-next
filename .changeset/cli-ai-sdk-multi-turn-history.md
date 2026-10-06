---
"cognia-next": patch
---

CLI: chats with OpenAI-compatible and other non-Anthropic providers keep their conversation across turns again, including after `cognia chat --continue`; each turn no longer starts the model from an empty or stale history.
