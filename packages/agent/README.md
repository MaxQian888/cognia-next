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

for await (const envelope of session.events()) {
  console.log(envelope.event.kind)
}

const outcome = await session.run("Diagnose the failing build and fix it")
if (outcome.status === "requires_action") {
  console.log(outcome.suspended)
}

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

## Protocol

The client and host negotiate bidirectional JSON-RPC v2 over newline-delimited
UTF-8 JSON. Import schemas, method maps, guards, limits, and stable error codes
from `@cognia/agent/protocol`. Unknown or unavailable host methods fail with a
typed capability error; the host never returns successful placeholder results.

Events are delivered at least once and deduplicated by `eventId`. Commands carry
stable `commandId` values and duplicate commands return the original receipt.
Cancellation sends `turn/abort` before rejecting the caller.

Compaction returns a boundary only when the live runtime captured a real
pre-compaction snapshot. Undo is intentionally live-host-only and single-use;
it is never simulated after a host restart.

## Security

The SDK accepts no provider API key. Configure credentials in the host. Stdout
is reserved for RPC frames; diagnostics are emitted on stderr. Explicit host
environment overrides are additive and should contain only variables required
by the selected host.
