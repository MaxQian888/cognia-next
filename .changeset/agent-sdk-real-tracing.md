---
"@cognia/agent": minor
"cognia-next": patch
---

Emit real trace spans from the Agent SDK host instead of audit rows wearing the name.

`trace/event` previously carried `RpcAuditEntry` records — which method ran and how it ended. Those
have no trace id, no parent, no duration tree, and nothing OTLP can consume, and a subscriber could
not tell them apart from anything else on the stream. The host now emits genuine `AgentTraceSpan`s
through `@cognia/agent-trace`, one per turn, joinable to the canonical event log by run, turn and
attempt id. `trace/export` serialises them as JSON or OTLP JSON.

Content is off by default: a span carries no prompt or completion preview unless the subscriber
passes `includeContent: true`, and that opt-in does not bypass the PII gate — a preview that fails it
is dropped and the span records why. Exports never carry content at all.

Audit rows stay on `audit/query` and in the JSON export's `audit` block.
