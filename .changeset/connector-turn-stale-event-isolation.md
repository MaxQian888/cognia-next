---
"cognia-next": patch
---

Fix IM connector turns reporting a spurious failure right after a previous turn timed out, and stop a silently stalled turn from tying up the conversation for 15 minutes.

When a connector turn hit its wall-clock timeout, the best-effort `interruptSession` it fired produced a late `session_ended` for the reused session id. By the time that event arrived the next turn had already subscribed, and — since `sessionId` was the only thing correlating events to a turn — it consumed the leftover end and failed instantly with "ended with no assistant text" while its own session was still starting up. Users saw two failures in the thread for one stuck turn. Each send now carries a `turnId` that the sidecar echoes on every session-scoped event, bound to the loop that was live when the turn started, so a superseded loop's late events are recognised and discarded instead of being mistaken for the current turn's result.

Connector turns also now set a read (idle) watchdog. They previously passed only the 15-minute wall clock, leaving `idleTimeoutMs` at its default of `0` — which disables the watchdog entirely — so a provider stream that simply went quiet burned the full 15 minutes before failing. The watchdog stands down for permission waits and in-flight tools, so only a genuinely stalled stream trips it.

The Anthropic dispatch path now logs the provider-request lifecycle (time to first event, stream end, and failures — the latter distinguishing "died before the first byte" from "broke mid-stream"). A stalled turn previously left no evidence of why it stalled.
