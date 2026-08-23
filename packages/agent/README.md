# @cognia/agent

Typed Node.js client for the Cognia agent host. The package is transport-only:
provider credentials, tools, sandboxing, persistence, and model execution remain
inside the `cognia-agent` host process.

## Requirements

- Node.js 20.19 or newer.
- A version-compatible Cognia host. The client checks an explicit path first,
  then the matching optional platform package, then `cognia-agent` on `PATH`.
- The client never downloads executable code at runtime.

## Usage

```ts
import { createCogniaClient } from "@cognia/agent"

await using client = await createCogniaClient()
await using session = await client.sessions.create({ name: "release-fix" })

// `start` returns once the turn is running, so events and the result can be
// awaited concurrently. Iterating `session.events()` before starting a turn
// would block forever — the stream only ends when the session closes.
const run = await session.start("Diagnose the failing build and fix it")

for await (const envelope of run.events()) {
  if (envelope.event.kind === "permission-request") {
    await session.resolvePermission(String(envelope.event.requestId), { kind: "approve" })
  }
}

const outcome = await run.result
console.log(outcome.status, outcome.result.text)
```

When nothing has to happen mid-turn, `run` blocks until the turn is over:

```ts
const outcome = await session.run("Summarise the changelog")

const compacted = await session.compact({ instructions: "Preserve API decisions" })
if (compacted.undoAvailable && compacted.boundaryId) {
  await session.undoCompact(compacted.boundaryId)
}
```

For development or a custom distribution, select the host explicitly:

```ts
const client = await createCogniaClient({
  host: {
    kind: "path",
    path: "/opt/cognia/bin/cognia-agent",
    args: ["rpc"],
  },
})
```

Tests can inject connected Node streams with `host: { kind: "streams", ... }`.

## Agents

An agent definition lives in the host, is immutable, and is versioned.

```ts
import { defineOutput, defineTool } from "@cognia/agent"
import * as v from "valibot"

const readFile = defineTool({
  name: "read_file",
  description: "Read a file from the workspace",
  input: v.object({ path: v.pipe(v.string(), v.description("Absolute path")) }),
  output: v.object({ contents: v.string() }),
  handler: async ({ path }) => ({ contents: await readTheFile(path) }),
})
await client.tools.register(readFile.registration, readFile.invoke)

const agent = await client.agents.create({
  agentId: "release-bot",
  name: "Release bot",
  composition: { presetId: "coding" },
  instructions: { append: "Prefer pnpm over npm." },
  toolRefs: [readFile.reference],
  output: defineOutput(v.object({ summary: v.string() })),
})

const run = await agent.start("Cut the release")
```

`defineTool` derives the JSON Schema the model sees, the handler's types, and
the runtime validation on both sides from one Valibot schema. The definition
stores the tool's _contract_ and a schema digest — never handler code — and the
host refuses to start a turn when a declared tool has no registered handler or
the handler's digest has drifted from the contract. For a schema outside the
convertible subset, `defineRawTool` takes a hand-written JSON Schema and types
its handler input as `unknown`, so the lost inference is visible.

Updating is a compare-and-swap that writes a new version:

```ts
const next = await agent.update({ ...changes }) // expectedVersion defaults to agent.version
```

Versions never change once written. `session/create` resolves `latest` **once**,
at creation, and freezes that version and its digests into the session — a
session created from v1 keeps running v1 after the agent reaches v9. Archiving
is logical: any version a session references stays readable.

Read a structured result with `parseStructuredOutput`, which types it and
reports a schema failure as a distinct error rather than a string on an
otherwise successful result.

## Events

Each `events()` call is an independent subscriber with its own bounded queue
(1024 events by default, `eventQueueCapacity` to change it). Two subscribers see
the same sequence; neither can starve the other.

History is replayed before live delivery, bounded by the head cursor the host
reports, and deduplicated by `eventId` — replay and live events never interleave
and none are lost in the handover.

A subscriber that stops consuming closes itself with a `BackpressureError`
carrying `lastEventId`. Nothing else is affected, and the caller resumes
deliberately:

```ts
try {
  for await (const envelope of session.events()) {
    /* … */
  }
} catch (error) {
  if (error instanceof BackpressureError) {
    for await (const envelope of session.events({ afterEventId: error.lastEventId })) {
      // …
    }
  }
}
```

## Reconnection

For `bundled` and `path` hosts the client reconnects on its own — up to five
attempts with exponential backoff — then re-negotiates, re-registers tools and
hooks, re-opens session handles and trace subscriptions, and replays events from
its cursor. A `streams` host needs a `factory` that can rebuild the transport;
without one, reconnection is impossible and stays off.

Reads are retried after a successful reconnect. Commands are not. A command
whose result never arrived fails with `IndeterminateCommandError` carrying its
`commandId`: the SDK does not know whether the host ran it, so it will not send
it again. Retrying under the same `commandId` is safe — the host returns the
original receipt for a duplicate command.

## Errors

Every error carries a stable string `code`. `RpcError` also keeps the numeric
JSON-RPC code as `rpcCode`.

| `code`                  | Raised when                                                  |
| ----------------------- | ------------------------------------------------------------ |
| `host_not_found`        | No host binary at any searched location                      |
| `incompatible_host`     | The host selected a protocol version this SDK does not speak |
| `backpressure_exceeded` | A subscriber overflowed its queue; carries `lastEventId`     |
| `indeterminate_command` | A command's outcome is unknown; carries `commandId`          |
| `connection_lost`       | The transport dropped and no reconnect was possible          |
| `reconnect_failed`      | Reconnection exhausted its attempt budget                    |
| `limit_exceeded`        | A negotiated protocol limit would be exceeded                |

## Assets

Bytes go to the host once and a turn references them:

```ts
const asset = await client.assets.upload(png, { mediaType: "image/png", name: "chart.png" })
// or, when the host can already see the file:
const same = await client.assets.registerPath("/srv/reports/chart.png")
```

An asset is content-addressed, so uploading identical bytes twice yields one id.
`registerPath` copies nothing — the host records where the file is and the digest
it had, and refuses to read it later if it changed underneath.

A turn carries `{ assetId, digest, mediaType, byteLength }` and never bytes or a
host path, so neither ends up in the canonical event log that gets replayed,
exported and shared. Bytes or a path smuggled onto a reference are rejected.

Two capabilities, deliberately: `assets-v1` means the store works, and
`assets-in-turn-v1` means the agent runtime can actually read an asset during a
turn. The current host declares the first and not the second, so a turn carrying
`assets` is **refused** rather than run without them.

The legacy `attachments` field is likewise refused with `invalid_params`. It was
previously accepted and silently dropped.

## Protocol

The client and host negotiate bidirectional JSON-RPC v2 over newline-delimited
UTF-8 JSON. Import schemas, method maps, guards, limits, and stable error codes
from `@cognia/agent/protocol`. Unknown or unavailable host methods fail with a
typed capability error; the host never returns successful placeholder results.

Events are delivered at least once and deduplicated by `eventId`. Commands carry
stable `commandId` values and duplicate commands return the original receipt.
Cancellation sends `turn/abort` before rejecting the caller.

Host capabilities are versioned identifiers (`event-replay-v2`,
`trace-unsubscribe-v1`, …) declared only when the selected backend supports
them. Check one with `client.runtime.supports("…")`; matching is exact, because
`-v2` is a different contract from `-v1` rather than a superset of it.

Compaction returns a boundary only when the live runtime captured a real
pre-compaction snapshot. Undo is intentionally live-host-only and single-use;
it is never simulated after a host restart.

## Traces

`client.traces.subscribe()` streams real `AgentTraceSpan`s from
`@cognia/agent-trace` — trace id, parent, duration, usage — not the audit rows
that used to be delivered under the same name. `trace/export` returns them as
JSON or as OTLP JSON (`format: "otlp-json"`).

Content is off by default. A span carries no prompt or completion preview unless
the subscriber passes `includeContent: true`, and that opt-in buys visibility,
not an exemption: every preview still passes the host's PII gate, and one that
fails is dropped with `metadata.inputPreviewBlocked` saying why. Exports never
carry content at all.

```ts
await using traces = await client.traces.subscribe({ sessionId, includeContent: true })
for await (const span of traces) console.log(span.operationName, span.durationMs)
```

Audit rows remain available on `client.audit.query()` and in the JSON export's
`audit` block. They answer a different question — which method ran and how it
ended — and are no longer mixed into the span stream.

## Record and replay

`client.evals` drives the host's existing replay engine — it does not add one.

```ts
await using recording = await client.evals.record(scenario)
// Point the provider at recording.proxyUrl and drive the session, then:
const { fixture } = await recording.stop()

const result = await client.evals.replay(fixture, { requireSynthetic: false })
console.log(result.summary, result.unmatched)
```

A replay runs the real agent loop — real build-options assembly, real sidecar,
real tools, real permission gate, real persistence — and substitutes only the
model endpoint. It needs no provider credential and cannot reach a provider even
if something tries. `requireSynthetic` defaults to on, so a fixture read out of a
repository is refused unless every tape is marked synthetic; a fresh recording
is marked non-synthetic and has to be read and scrubbed before it can be
committed.

`refreshFixture` re-derives a fixture's digests after an intentional edit.

## Licensing

`@cognia/agent` is **Apache-2.0**. The host — `cognia-agent`, shipped in the
`@cognia/agent-host-*` platform packages — is **AGPL-3.0-only**, and so is the
runtime it contains.

The split works because the boundary is a process boundary. This package is
transport-only: it holds no runtime source, links none, and talks to the host
solely over the RPC transport described above. `pnpm --dir packages/agent
pack:test` fails the build if a host artifact ever appears inside the client
tarball, because that would relicense it.

## Security

The SDK accepts no provider API key. Configure credentials in the host. Stdout
is reserved for RPC frames; diagnostics are emitted on stderr. Explicit host
environment overrides are additive and should contain only variables required
by the selected host.
