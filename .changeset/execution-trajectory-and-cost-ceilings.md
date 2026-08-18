---
"cognia-next": minor
---

A chat turn now leaves a durable record of what it did, and spending can be
capped.

**The trajectory.** A normal desktop chat turn produced no canonical event log
at all — `appendCanonicalEnvelopes` had two callers, and neither was chat. It
now writes one, on the same run id the execution journal and the usage row
already use, so a cost row can be joined to the events that produced it.
Semantic events (tool calls and results, permission decisions, usage, compaction,
checkpoints, subagents, failures, the session preamble) are always recorded;
streaming deltas, prompt text and tool payloads are not, and never reach the log
unless a debug session is armed. Redaction runs at the envelope boundary, so no
caller can forget it.

**Trace depth.** A subagent's tool calls used to appear as siblings of the `Task`
call that spawned them, which is why every trace was one level deep. They now
nest underneath it. Spans emitted inside the sidecar are repatriated to the local
store instead of existing only as OTLP — on a default install, with no collector
configured, the waterfall previously showed a multi-second hole where the model
call ran. Retrieval, embeddings, MCP round-trips and plugin WASM callbacks emit
spans for the first time; `retrieval` was a declared operation name with no
producer at all.

**Ecosystem shape.** Exported spans carry their OTel kind (`client`/`server` on a
process hop), an OpenInference `span.kind` for backends that key on it, the
execution identity, and the cache-TTL split. An unfinished span reports `UNSET`
rather than claiming success, and joinable fields — the tool-call id, the request
id, the HTTP status — are promoted to real attribute names instead of being
buried under a vendor prefix where nothing can query them.

**Spending you could not see.** Embedding batches, twin distillation, OCR pages
and TTS characters are metered. Each of these could run all day and leave the
Usage tab's total unchanged. Usage reconstructed from an imported transcript is
marked as such and excluded from local totals — that money was spent in another
agent, often on another account.

**Spending you could not stop.** New USD ceilings under Settings → Observability
→ Usage & cost: daily and monthly, globally or per provider. You are warned at
80% and 95%; at 100% the next request is held until you approve it, once. This is
deliberately stricter than the routing budget under Providers, which stays
advisory: a warning that scrolls past is how a budget gets discovered on the
invoice. Nothing is configured by default, and a send costs nothing extra when no
ceiling is set.

**Reproducing a problem.** The old content-capture switch was a boolean with no
expiry — off meant nothing was reproducible, on meant every prompt was persisted
forever. It is replaced by a time-bounded debug session with independent tiers
for deltas, prompts, tool details and raw bodies, capped at an hour, expiring on
its own, scoped to one conversation if you want. Captured content stays local: it
cannot ride a backup, an export, or a diagnostic report.

The observability dashboard gains cost-by-provider and cost-by-project panels,
and both are filterable.
