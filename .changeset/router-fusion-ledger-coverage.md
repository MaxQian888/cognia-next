---
"cognia-next": patch
---

With Router + Fusion's ledger switches on, every model call of the `ai.prompt` v2 node (explicit and routed, each fallback attempt included), `ai.council`, `ai.ensemble`, the `/council` command, Agent auto-compose and Agent text-only runs is now reserved and settled on the ledger under the right workspace; concurrent background calls are no longer double-counted, and a call that falls back unledgered raises a "Model call not ledgered" notice.
