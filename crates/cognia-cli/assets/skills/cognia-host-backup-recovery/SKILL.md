---
name: cognia-host-backup-recovery
description: Use when a request needs deliberate Cognia backup export, verification, import, restore, disaster recovery, or post-recovery checks; do not use when handling routine system status, logs, sync, or secret administration.
license: AGPL-3.0-or-later
compatibility: Requires the cognia CLI; RPC calls require a same-host cognia-server Headless endpoint.
---

# Cognia Backup and Recovery

Before any RPC, run `cognia host skills read cognia-host` and follow its offline check, schema,
state-read, dry-run and confirmation, accepted/completed handling, and authoritative verification
sequence. Never add `--yes` without confirmation of the exact operation and arguments. After a
timeout, retry only the same body and idempotency key; stop on validation, authentication,
confirmation, or resync errors. Treat results as opaque when `outputTyped` is false. Treat restore
and import as destructive state replacement.

## Workflow

1. Run `cognia host doctor` and inspect system resources and backup-related read commands.
2. Read current storage, sync, and backup status before choosing an operation.
3. Inspect the export schema, destination, overwrite behavior, and idempotency policy.
4. Export first. Verify the reported destination or artifact using a read command; do not infer
   success from process completion alone.
5. Before import or restore, inspect its schema and run `--dry-run` with the exact source and scope.
6. Obtain explicit user confirmation for the exact restore/import. Never add `--yes` without that
   confirmation. Reuse the idempotency key across retries or timeout continuation.
7. Run `doctor` again and verify authoritative storage, sync, session, and task state.

Do not print credentials or private key paths. Do not restore from an unverified destination or
assume opaque response fields.
