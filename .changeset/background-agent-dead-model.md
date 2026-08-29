---
"cognia-next": patch
---

Internal: remove the background-agent execution model that was never built. `types/agent/background-agent.ts` described a queue, a notification bus, per-step records, a manager state tree and serializers — fourteen exported types with zero references anywhere in the repo, plus a `BACKGROUND_AGENT_STATUS_CONFIG` that shadowed the real one through the `types/agent` barrel. None of it survived the rewrite of the background-agent manager into a facade over the durable task registry. The markdown exporter that formatted one of those records goes with it: nothing constructed the shape it took, so it could never be called with real data. Only the status vocabulary the display table keys on remains.
