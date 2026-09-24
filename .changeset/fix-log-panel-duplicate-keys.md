---
"cognia-next": patch
---

Fix duplicate React key warnings on the Logs panel: agent-trace spans are persisted twice — once in the unified log store and once in the `agentTraces` Dexie table, both keyed by `span.id` — so the panel's merge rendered every span twice and React logged duplicate-key warnings on each refresh tick. The merged list now dedupes by entry id.
