---
"cognia-next": patch
---

Fix `session_list` returning 500 `contract_output_violation` to every device. Two data planes serve the command and they page differently: the Rust direct store counts the table and returns `total` + `nextOffset`, while the indexed bridge reads one row past the page and returns `next_offset` + `has_more` rather than paying for a full count. The contract required `total`, named only `nextOffset`, and set `additionalProperties: false` — describing neither implementation, and matching the one the consumer type (`lib/claude/ipc.ts::SessionListPage`) already declared optional. `rows` is the only field both planes always send, so that is what the schema now requires, with each plane's pagination fields documented for what they are.

Latent until now because `session_list` was classified `target: "client"` and refused before dispatch; the transport-classification fix made it reachable and the stale contract became a 500.
