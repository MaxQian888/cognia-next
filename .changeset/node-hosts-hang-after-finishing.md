---
"cognia-next": patch
---

Fix `cognia-agent run` never exiting: the turn finished, printed its answer, and then hung forever. Four cross-context coordination handles that are free in a browser each keep Node's event loop alive on their own, and none of them was unref'd — the Dexie upgrade-yield channel (which pinned _every_ Node host that opens the database), the scheduler's missed-task and auto-cleanup intervals, its execution-status channel, and the tab-leader election channel plus heartbeat. `unref` drops only the loop reference, so all four still deliver for as long as the process is running for a real reason; long-lived hosts (the brain's socket, the TUI's input) are unaffected. Dexie already unrefs its own internal channel for exactly this reason, as does the scheduler's per-task alarm driver.

Also fix one misconfigured remote MCP server silently removing _all_ of them from a turn. The egress guard threw out of the projection loop, abandoning the whole server map — including stdio servers the guard never inspects — and the caller logged it as a single line about the first bad URL. The refusal is now per server: the rejected endpoint is still never projected into a session, the others survive, and each exclusion is logged with the server name and reason.
