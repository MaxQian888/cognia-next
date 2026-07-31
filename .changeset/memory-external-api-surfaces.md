---
"cognia-next": minor
---

Long-term memory is now callable from outside chat (ADR-0069): plugins get a `ctx.memory` API (`memory:read`/`memory:write` permissions), external MCP agents get five `memory_*` bridge tools behind new opt-in `memory:read`/`memory:write` scopes (default OFF), and paired devices get five `memory_*` companion RPCs (writes remote-control-gated). All writes flow through one shared PII-gated helper layer with a new `external` provenance (never procedural) and per-surface attribution shown in the memory console. Also: a `/memory` manage command (`status`/`list`/`forget`), the `hybridEnabled` toggle now actually forces BM25-only retrieval, and workflow/pet recall honor the configured decay half-life.
