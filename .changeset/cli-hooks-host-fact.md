---
"cognia-next": patch
---

cli: report `hookRuntimeAvailable` correctly at backend selection

`CLI_SELECTION_HOST_FACTS.hookRuntimeAvailable` was `false` with a stale
comment claiming the CLI does not run Cognia lifecycle hooks around external
turns. The external-agent session has wrapped every turn with
`dispatchUserPromptSubmit` plus stream lifecycle hooks for a while, and the
session-time host snapshot already reports `true`. The selection-time fact is
now `true` as well, so `hooks.lifecycle` resolves from the real host fact
instead of under-reporting the CLI's capability.
