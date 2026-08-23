---
title: "0142 — The Agent SDK is two products, not one"
description: "@cognia/agent splits into a v0.1 runtime client that must first be correct about replay, backpressure, reconnection and attachments, and a v0.2 authoring layer whose agent definitions are immutable, host-persisted and version-frozen into each session. The client ships Apache-2.0; the host stays AGPL."
---

# ADR 0142 — The Agent SDK is two products, not one

**Status:** Accepted
**Date:** 2026-08-23
**Supersedes:** `docs/plans/2026-08-11-rpc-first-agent-sdk-productization.md`
**Related:** [ADR-0090](./0090-unified-agent-execution-and-gateway-compatibility), [ADR-0117](./0117-composed-agent-modes-and-creator), [ADR-0125](./0125-durable-work-submission)

## Context

`packages/agent` is a typed JSON-RPC client. `cli/` is the host it talks to —
`cognia-agent rpc`, whose service lives in `cli/src/agent/rpc/runtime-service.ts`
and whose framing lives in `cli/src/agent/rpc/server.ts`. The three
`packages/agent-host-*` packages carry the built host binary per platform, and
the client resolves them as optional dependencies.

That boundary is right and is not revisited here. What the 2026-08-11 plan got
wrong was treating "the boundary exists" as "the product is one release away".
Reading the shipped code against that plan turns up two separate problems that
were being solved as one.

**The runtime client is not yet correct.** Not incomplete — incorrect, in ways a
third-party integrator hits on day one:

- `SessionEventChannel` keeps **one** queue per session and every `events()`
  iterator `shift()`s from it. Two subscribers do not each see the stream; they
  split it. The plan's own acceptance criterion ("two subscribers get the same
  sequence") fails against the current implementation.
- `events({ afterEventId })` fires `entries()` without awaiting it and pushes
  the page into the same channel that live `agent/event` notifications are
  already writing to. Replayed history and live events interleave in arrival
  order, not event order.
- That queue is unbounded. A subscriber that stops consuming grows the client's
  heap until the process dies; there is no cursor to resume from.
- `traces.subscribe()` returns an `AsyncIterable` and nothing else. There is no
  `trace/unsubscribe` method in the protocol, so the host's `traceSubscriptions`
  map only shrinks when an emit throws.
- The host attributes every client hook invocation to
  `[...sessions.values()].find(candidate => candidate.busy)` — the *first* busy
  session. With two concurrent sessions, hook payloads are stamped with the
  wrong `sessionId`, `runId` and `attemptId`.
- `session/tree(sessionId)` ignores its argument and returns `store.tree()`, the
  entire forest.
- `AgentInput` accepts `attachments` with `path` and `data`. No host code path
  reads them. They are accepted and dropped.
- `initialize` sends a hardcoded `version: "0.1.0"` and the negotiated `limits`
  in the response are stored on `runtime.info` and never enforced by the client.
- There is no reconnection. A host crash ends the client.
- The README's first example iterates `session.events()` to completion before
  calling `session.run()`. It cannot terminate.

**The authoring story does not exist.** `sessions.create({ model, cwd })` is the
whole configuration surface. There is no way to name an agent, version it, or
have a session pin the definition it started under. Every integrator would build
that themselves, differently, on top of a session factory.

These are different products with different risks. Fusing them into one "1.0"
means the correctness work waits on a persistence design, and the persistence
design is validated against a client that mis-delivers events.

## Decision

### 1. Two layers, released separately

**v0.1 is a runtime client.** Its entire job is that a third-party Node process
can install the package, start a host, run turns, consume events, survive a host
crash, and shut down — on macOS arm64, Linux x64 and Windows x64. No new
authoring concepts. Everything in the Context section above is a v0.1 blocker.

**v0.2 is an authoring SDK.** It adds host-persisted, immutable, versioned agent
definitions, typed client tools, and structured output. It is additive: a v0.2
host serves a v0.1 client unchanged, and `sessions.create({ model, cwd })` keeps
working by mapping to an implicit standard definition.

Phase 4 capabilities — asset references, real tracing, evals, workspace
checkpoints — are incremental and block neither release.

### 2. Runs are non-blocking; interaction is an event, not a status

`session.run()` stays as the blocking convenience call. Alongside it:

```ts
const run = await session.start(input, options)
for await (const event of run.events()) { /* … */ }
const outcome = await run.result
```

`AgentRunHandle` exposes `events()`, `result`, `abort(reason?)`, and the current
`commandId` / `sessionId` / last acknowledged event cursor.

`AgentTurnOutcome` carries **terminal** statuses only. The existing
`requires_action` variant is removed: a turn awaiting a permission or an
elicitation has not ended, and modelling that as an outcome forces every caller
to re-enter a loop the SDK should own. Waiting is expressed by typed events on
the run's stream.

### 3. Replay is cursor-bounded and ordered before live

Attaching to a stream captures the host's `headEventId` first, pages history up
to exactly that cursor while buffering live notifications, deduplicates by event
ID, and only then switches to live delivery. No interleaving, no gap.

### 4. Each subscriber owns a bounded queue

Every `events()` call gets its own queue, default capacity 1024. Overflow closes
**that subscriber** with a `BackpressureError` carrying its last cursor, so the
caller can resume deliberately. One slow consumer never stalls the session and
never grows the heap without bound.

### 5. Unknown outcomes are surfaced, never retried

A command whose result did not arrive is reported as `IndeterminateCommandError`
with its `commandId`. The SDK never re-sends it. The caller may query or retry
under the same command ID, where the host's existing receipt table makes the
retry idempotent. Automatic replay of a possibly-executed side effect is not a
behaviour this SDK will have.

Reconnection itself is supported for `bundled` and `path` hosts (up to five
exponential-backoff attempts), and for `stream` hosts only when the caller
supplies a `factory` that can rebuild the transport. After reconnect the client
re-negotiates, re-registers tools and hooks, re-opens session handles and trace
subscriptions, and replays from its cursor.

### 6. Capabilities are fine-grained, versioned, and backend-derived

The current `SERVICE_CAPABILITIES` list is a flat set of sixteen bare strings
declared unconditionally. A client cannot tell whether `sandbox-policy-snapshots`
means a real filesystem checkpoint or a policy record. Capabilities become
versioned identifiers, declared only when the backend actually supports them.

### 7. Attachments are refused, not dropped

Until asset references land (Phase 4), a turn carrying a legacy `data`, base64,
or `path` attachment fails with `invalid_params`. Silently discarding user input
is worse than rejecting it.

### 8. Agent definitions are immutable, host-persisted, and frozen into sessions

```ts
interface AgentDefinitionV1 {
  schemaVersion: 1
  agentId: string
  version: number
  name: string
  description?: string
  composition: AgentCompositionSelectionV1
  instructions?: { append: string }
  runtimeBindingRef?: string
  toolRefs: AgentToolReference[]
  output?: JsonSchemaContract
  metadata?: Record<string, string | number | boolean>
  definitionDigest: string
}
```

The constraints are the decision:

- `instructions` **appends** to the resolved preset. It cannot replace the system
  policy, because the host's governance rides on that policy.
- A definition references host credential and runtime bindings. It never stores
  a provider key or any secret.
- Versions are immutable. An update is a compare-and-swap against
  `expectedVersion` that writes `N+1`.
- Archiving is logical. A version any session references stays readable forever.
- `session/create({ agent: { agentId, version? } })` resolves `latest` **once**,
  at creation, and freezes the exact version, definition digest, composition
  digest and execution fingerprint into the session manifest. An existing session
  never follows a later definition.

The resolver lowers definitions onto the existing composition resolver and
unified execution spec. No parallel authority, model, or tool configuration
system is introduced.

### 9. Tools are contracts on the host, handlers on the client

`defineTool()` derives input and output types from a Valibot schema and converts
it to JSON Schema. A raw JSON Schema escape hatch stays, typed `unknown`.

The definition stores the tool contract and a schema digest — never handler code.
The client registers handlers on every connect and reconnect. Before calling the
model, the host checks that a handler exists and that its digest matches. Input
and output are validated on both sides; a missing handler, a digest mismatch, or
an illegal output is a typed error, not a silent degradation.

### 10. Licensing splits at the process boundary

`@cognia/agent` ships **Apache-2.0**. The host, the CLI, and the runtime packages
stay **AGPL-3.0-only**. The client tarball must contain no AGPL runtime source
and must not statically link it — the two communicate only over the RPC
transport, which is exactly why the boundary was drawn there.

## Consequences

The client's event layer is rewritten rather than patched: per-subscriber queues,
a replay cursor, and a reconnect state machine are one design, not three fixes.

The host gains bounds it did not have — TTLs and ceilings on callback receipts,
trace subscriptions, open sessions, active turns and replay pages — and those
ceilings become observable rejections rather than unbounded maps.

Removing `requires_action` is a breaking change to `AgentTurnOutcome`. It is
taken before 0.1.0 is published precisely so it never has to be taken after.

The license change requires the client to keep earning its transport-only
status. Any future convenience that pulls runtime source into `packages/agent`
would silently relicense it, so the Apache boundary is a constraint on what the
client is allowed to contain, not just a field in `package.json`.

## Non-goals

A Pi-compatible API or wire protocol. Browser or Edge embedding of the runtime.
A new DAG or workflow engine. Provider credentials held by the client. Automatic
retry of side-effecting commands with unknown outcomes. Uploading arbitrary
executable extensions. Realtime voice or a hosted service. Additional language
SDKs before the TypeScript contract is stable. Presenting a sandbox policy
snapshot as a filesystem checkpoint.
