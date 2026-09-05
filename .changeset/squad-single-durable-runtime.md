---
"cognia-next": minor
---

Squads run on one durable runtime with one review contract. The legacy/durable-v2 runtime selector is gone: every Squad definition is migrated onto the durable contract (repository + environment bindings inferred only when unambiguous), a Squad missing a binding is shown as not ready with actionable blockers instead of silently running degraded, and every start goes through `startSquadRun`, which refuses duplicate live runs and writes the run record and execution row in one transaction before anything dispatches. Pause, resume, stop and retry share one state machine (Abort no longer aliases Pause), and every Squad approval (plan, capability audit, budget, deadlock, teammate repair, re-plan, recovery) is a durable run interrupt answered through the run control plane with a typed, validated decision, so it survives a reload and can be answered from the cockpit, a phone or an IM card.
