---
"cognia-next": patch
---

The headless Cognia server now serves the Router + Fusion Run API, the `cognia/*` models and the passthrough ledger; `/v1/embeddings` calls are ledgered too, a reservation is always settled even if the switch changes mid-request, and artifact read links stay valid across restarts.
