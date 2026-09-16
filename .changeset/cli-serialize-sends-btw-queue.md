---
"cognia-next": patch
---

Serialize concurrent TUI turns so a message submitted in the busy→idle repaint gap (or a background-result delivery racing the steer drain) can no longer open a second concurrent turn on the same session — overlapping prompt listeners were fanning every `session/update` notification out twice, which is how transcript rows like "commands changed" / "External mode" rendered duplicated under ACP backends such as Devin. `AgentSessionApi` gains a synchronous `sendInFlight()` check so the submit path reliably queues mid-turn text as a `btw` steer, and the queued affordance is clearer: a `💬 queued ×N` chip plus `⏵`-marked preview lines instead of transcript-identical `•` rows.
