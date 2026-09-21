---
"cognia-next": patch
---

Fix the `External agent capability drift` warning on every `pi-rpc` session: the capability manifest declared `hooks.lifecycle` as `unsupported` (`agentOwned`), but Cognia hooks are a host facility the protocol cannot answer for — every other protocol row already says `unknown` and lets the live host fact decide. The CLI hook runtime does dispatch lifecycle hooks around external turns, so the row now reads `equivalent` when the runtime is present instead of permanently disagreeing with it.
