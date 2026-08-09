---
name: cognia-host-tasks
description: Use when a request concerns Cognia task lifecycle, workspaces, resources, comments, patches, transfers, conflict resolution, settlement, or cleanup; do not use when the work primarily controls agent runtimes or chat sessions rather than task state.
license: AGPL-3.0-or-later
compatibility: Requires the cognia CLI; RPC calls require a same-host cognia-server Headless endpoint.
---

# Cognia Host Tasks

Before any RPC, run `cognia host skills read cognia-host` and follow its offline check, schema,
state-read, dry-run and confirmation, accepted/completed handling, and authoritative verification
sequence. Never add `--yes` without confirmation of the exact operation and arguments. After a
timeout, retry only the same body and idempotency key; stop on validation, authentication,
confirmation, or resync errors. Treat results as opaque when `outputTyped` is false.

Search the task domain:

```bash
cognia host resources --category tasks
cognia host commands --category tasks --resource <resource> --query <workspace-or-resource-term>
```

## Workflow

1. Resolve the task/workspace and inspect its status before mutation.
2. For resources, use open/read-chunk/close or open/write-chunk/commit as one lifecycle; abort an
   incomplete upload explicitly.
3. Inspect patch sets and resource events before apply, undo, settle, prune, or conflict resolution.
4. Keep task, workspace, run, resource, and upload/download identifiers separate.
5. Preserve the idempotency key and exact body across retries.

Never settle, prune, undo, or resolve a conflict without confirming the selected workspace state.
