---
name: cognia-host-observe
description: Use when a request needs cross-domain Cognia status, logs, sessions, or replayable events for read-only investigation; do not use when any write or side effect is requested, or when one domain skill fully covers the read.
license: AGPL-3.0-or-later
compatibility: Requires the cognia CLI; RPC calls require a same-host cognia-server Headless endpoint.
---

# Observe Cognia Host

Before any RPC, run `cognia host skills read cognia-host` and follow its offline check, schema,
state-read, accepted/completed handling, and authoritative verification sequence. Never add `--yes`.
After a timeout, retry only the same body and idempotency key; stop on validation, authentication,
confirmation, or resync errors. Treat results as opaque when `outputTyped` is false. Keep this
workflow read-only.

## Workflow

1. Run `cognia host doctor` and `cognia host categories` to establish host and catalog health.
2. Narrow the surface with `cognia host resources --category <category>`.
3. Discover low-risk read commands with
   `cognia host commands --resource <resource> --operation read --risk low`.
4. Run `cognia host schema <rpc-command>` before every call; never guess fields.
5. Read authoritative status before logs or historical records, then correlate identifiers and
   timestamps across results.
6. Use `cognia host events --since <seq>` when live evidence is needed. Preserve the last cursor.

Honor each command's catalog idempotency policy; do not invent an explicit key for structural
reads.

Do not call write or side-effect commands. Never add `--yes`; a read-only investigation does not
need confirmation bypasses. Treat opaque outputs as undocumented JSON. If an event cursor requires
resynchronization, refresh state through read RPCs rather than inferring gaps.
