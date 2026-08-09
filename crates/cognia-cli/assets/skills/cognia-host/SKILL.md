---
name: cognia-host
description: Use when a task broadly concerns same-host Cognia operations or no narrower cognia-host-* skill is known to discover and safely invoke the loopback-only Headless RPC plane; do not use when a domain or workflow skill directly matches the request.
license: AGPL-3.0-or-later
compatibility: Requires the cognia CLI; RPC calls require a same-host cognia-server Headless endpoint.
---

# Cognia Headless Host CLI

Use this skill only for a `cognia-server` running on the same host or in the same container/Pod
network namespace. Start with `cognia host doctor --offline`; run `cognia host doctor` before the
first network call.

Prefer a narrower skill when one matches: domain skills cover routine work in one category, while
workflow skills cover cross-command observation, Git safety, incidents, recovery, rollout, and
connector delivery.

## Required workflow

1. Check the offline catalog and local configuration with `cognia host doctor --offline`.
2. Choose a domain with `cognia host categories`; read its skill when one is listed.
3. List its resource groups with `cognia host resources --category <category>`.
4. Search before guessing:
   `cognia host commands --category <category> --resource <resource> --query <term>`.
5. Inspect the exact input contract with `cognia host schema <rpc-command>` and read current
   authoritative state before any mutation.
6. For a mutation, run the exact body through `--dry-run`, obtain required user confirmation, then
   invoke only the named RPC with `cognia host call <rpc-command> --data '<json>'`.
7. Distinguish `state: accepted` from `state: completed`; retain the operation and idempotency data
   needed to continue an accepted call.
8. Re-read authoritative state to verify the requested postcondition. Treat every result as opaque
   JSON when `outputTyped` is false.

## Safety

- Commands marked `high` or `critical` require explicit user confirmation.
- An agent must never add global `--yes` on its own. Pass it only after the user has confirmed the
  exact operation and arguments.
- Use `--dry-run` to inspect route, risk, idempotency, body shape, size, and hash without reading a
  token or contacting the server.
- Never log `COGNIA_SERVICE_TOKEN`, Authorization headers, or event WebSocket URLs.

## Durable calls and events

- Required idempotency keys are generated automatically. Reuse an explicitly supplied key when
  resuming a timed-out call.
- The default call waits by replaying the same request and idempotency key. Use `--no-wait` only
  when the caller can retain the returned `operationId` and idempotency key.
- `cognia host events` prints NDJSON. Persist the last `seq` and reconnect with `--since`.
- `resync_required` means the cursor left the retention window; refresh authoritative state through
  RPC rather than inventing missing events.

## Failure handling

- After a timeout, retry only the same body with the same idempotency key.
- Stop on validation, authentication, confirmation, or resynchronization errors; correct the cause
  instead of changing arguments speculatively.
- A transport failure is not proof that a mutation failed. Verify state before deciding whether to
  continue.

See `references/output-contract.md` for stable envelopes and exit codes.
