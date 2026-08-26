---
"cognia-next": patch
---

Headless hosts can now sweep the connector attachment cache. `connectors_attachment_list`, `_delete`, `_evict_adapter` and `_enforce_budget` existed only as desktop Tauri commands, so on a headless host the "Connector attachment cache upkeep" task failed on every housekeeping cycle with `the requested command is not registered` — the orphaned-blob sweep and the total-bytes ceiling never ran, and the encrypted cache grew without a bound. All four now have companion RPC arms (service-scope, typed request/response contracts), and a new guard test fails whenever a `connectors_*` wrapper the brain can send has no remote dispatch arm.
