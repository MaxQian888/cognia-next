---
"cognia-next": patch
---

Scheduled and IM-started goals now handle a tool that needs approval instead of hanging until the turn times out or being silently denied. The tool is denied at once and the model is told why. The goal then pauses with `needs_approval` instead of retrying. The scheduled run fails with the tools named, and an IM conversation gets a line saying which tools need approval. Opening a scheduled goal's conversation and running `/goal resume` continues it in the chat, where the tool can be approved.
