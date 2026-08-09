---
name: cognia-host-agents
description: Use when handling routine Cognia agent lifecycle, coordination, approvals, interruptions, teams, fleets, or goals; do not use when diagnosing or containing an unhealthy run, where cognia-host-agent-incident applies.
license: AGPL-3.0-or-later
compatibility: Requires the cognia CLI; RPC calls require a same-host cognia-server Headless endpoint.
---

# Cognia Host Agents

Before any RPC, run `cognia host skills read cognia-host` and follow its offline check, schema,
state-read, dry-run and confirmation, accepted/completed handling, and authoritative verification
sequence. Never add `--yes` without confirmation of the exact operation and arguments. After a
timeout, retry only the same body and idempotency key; stop on validation, authentication,
confirmation, or resync errors. Treat results as opaque when `outputTyped` is false.

Discover only this domain:

```bash
cognia host resources --category agents
cognia host commands --category agents --resource <resource> --query <agent-or-goal-term>
```

## Workflow

1. Inspect status/list commands before lifecycle actions.
2. Distinguish Claude sessions, external agents, fleet sessions, team runs, and goals; their IDs are
   not interchangeable.
3. Use the exact schema for approvals and question responses; never fabricate approval decisions.
4. Confirm the target before interrupt, stop, cancel, or kill operations.
5. Reuse an idempotency key after timeout instead of issuing a second lifecycle action.

Do not add `--yes`; high-risk agent control requires the user's explicit confirmation.
