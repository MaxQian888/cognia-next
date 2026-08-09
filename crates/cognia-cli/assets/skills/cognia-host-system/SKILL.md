---
name: cognia-host-system
description: Use when inspecting routine Cognia capabilities, admin leases, secrets, sync, logs, bridge administration, or device reports; do not use when performing multi-step backup export, restore, or disaster recovery, where cognia-host-backup-recovery applies.
license: AGPL-3.0-or-later
compatibility: Requires the cognia CLI; RPC calls require a same-host cognia-server Headless endpoint.
---

# Cognia Host System

Before any RPC, run `cognia host skills read cognia-host` and follow its offline check, schema,
state-read, dry-run and confirmation, accepted/completed handling, and authoritative verification
sequence. Never add `--yes` without confirmation of the exact operation and arguments. After a
timeout, retry only the same body and idempotency key; stop on validation, authentication,
confirmation, or resync errors. Treat results as opaque when `outputTyped` is false.

Discover system commands with:

```bash
cognia host resources --category system
cognia host commands --category system --resource <resource> --query <capability-secret-backup-sync-or-log>
```

## Workflow

1. Start with host capabilities/feature manifest or status/list commands.
2. Treat secret-store and keyring results as sensitive; do not echo them into logs or arguments.
3. Confirm data directory and destination before backup import/export or sync.
4. Inspect bridge status/config before enable, rotate, revoke, restart, or relay changes.
5. Issue/revoke admin leases only for the exact operation the user approved.

System commands use a privileged service principal. Local confirmation reduces mistakes but does not
create a security boundary; never add `--yes` autonomously.
