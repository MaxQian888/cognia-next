---
name: cognia-host-automation
description: Use when a request concerns Cognia workflow runs, schedules, backfills, background jobs, monitors, or automation consent; do not use when the request is a one-off task workspace or agent-runtime operation.
license: AGPL-3.0-or-later
compatibility: Requires the cognia CLI; RPC calls require a same-host cognia-server Headless endpoint.
---

# Cognia Host Automation

Before any RPC, run `cognia host skills read cognia-host` and follow its offline check, schema,
state-read, dry-run and confirmation, accepted/completed handling, and authoritative verification
sequence. Never add `--yes` without confirmation of the exact operation and arguments. After a
timeout, retry only the same body and idempotency key; stop on validation, authentication,
confirmation, or resync errors. Treat results as opaque when `outputTyped` is false.

Discover automation commands with:

```bash
cognia host resources --category automation
cognia host commands --category automation --resource <resource> --query <workflow-or-schedule-term>
```

## Workflow

1. Inspect workflow or schedule state before create, update, pause, resume, run-now, or delete.
2. Treat workflow definitions and scheduled-task payloads as distinct schemas.
3. Query pending consent before responding; pass only the user's actual decision.
4. For background jobs and monitors, list/read before kill or cancel.
5. Use dry-run for destructive or externally visible actions and retain idempotency state.

Do not infer cron syntax, workflow input fields, or approval payloads; always read the command schema.
