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

## Attachments

This version carries none. A turn whose input has `attachments` fails with
`invalid_params` rather than running without them, which is what previously
happened silently. Asset references arrive with the `assets-v1` capability.

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

## Security

The SDK accepts no provider API key. Configure credentials in the host. Stdout
is reserved for RPC frames; diagnostics are emitted on stderr. Explicit host
environment overrides are additive and should contain only variables required
by the selected host.
