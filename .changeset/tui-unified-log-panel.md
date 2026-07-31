---
"cognia-next": minor
---

TUI: add a unified `/logs` panel across agents, MCP servers, and the backend

Adds a scrollable, filterable log panel that aggregates every captured channel —
external-agent stderr/lifecycle/exit (previously emitted with **zero**
subscribers, so a failed agent spawn left no trace), sidecar exits, turn errors,
and a read-time projection of the MCP buffer.

- **Search** — type to filter (message + origin), `Tab` cycles level, `⇧Tab`
  cycles channel.
- **Inject** — `Enter` sends the selected line into the composer, `^A` sends the
  whole filtered set, so the agent can analyse an error directly. Large
  injections fold into a paste placeholder, keeping the composer one row tall.
- **Performance** — arrivals are coalesced into one batched append per frame
  instead of one dispatch + one full-buffer copy per line, the buffer trims on a
  high-water mark rather than on every append, filtering and tallies are
  memoized, and over-long lines are clamped at ingest.

The existing `/mcp logs` panel is unchanged.
