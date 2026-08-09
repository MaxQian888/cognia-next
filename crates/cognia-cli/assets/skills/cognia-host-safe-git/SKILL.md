---
name: cognia-host-safe-git
description: Use when a request needs safeguarded Git commits, rebases, resets, worktrees, destructive changes, conflict handling, or recovery through Cognia; do not use when handling non-Git tools or a simple read-only Git lookup.
license: AGPL-3.0-or-later
compatibility: Requires the cognia CLI; RPC calls require a same-host cognia-server Headless endpoint.
---

# Safe Git Through Cognia Host

Before any RPC, run `cognia host skills read cognia-host` and follow its offline check, schema,
state-read, dry-run and confirmation, accepted/completed handling, and authoritative verification
sequence. Never add `--yes` without confirmation of the exact operation and arguments. After a
timeout, retry only the same body and idempotency key; stop on validation, authentication,
confirmation, or resync errors. Treat results as opaque when `outputTyped` is false.

Discover the current Git resource instead of assuming command names:

```bash
cognia host resources --category development
cognia host commands --category development --resource git
```

## Workflow

1. Inspect status, current branch, diffs, conflicts, and sequencer state before any mutation.
2. Inspect the exact schema for every selected RPC and preserve repository/worktree identifiers.
3. Use `--dry-run` for the exact mutation body and record its body hash and idempotency policy.
4. Obtain explicit user confirmation for every high- or critical-risk operation. Never add `--yes`
   without that confirmation.
5. Execute the smallest exact mutation. Reuse the idempotency key when continuing a timed-out call.
6. Re-read status, branch, diff, and conflict state to verify the requested postcondition.

Do not combine unrelated repository changes. Never infer that a destructive operation is safe from
a stale read or an opaque response.
