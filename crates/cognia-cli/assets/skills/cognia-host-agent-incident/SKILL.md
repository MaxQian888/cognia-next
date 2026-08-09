---
name: cognia-host-agent-incident
description: Use when a request needs triage or containment for stuck Cognia agents, failed tasks, runaway teams, runtime incidents, or goal failures; do not use when handling routine lifecycle, coordination, or healthy-run control, where cognia-host-agents applies.
license: AGPL-3.0-or-later
compatibility: Requires the cognia CLI; RPC calls require a same-host cognia-server Headless endpoint.
---

# Cognia Agent Incident

Before any RPC, run `cognia host skills read cognia-host` and follow its offline check, schema,
state-read, dry-run and confirmation, accepted/completed handling, and authoritative verification
sequence. Never add `--yes` without confirmation of the exact operation and arguments. After a
timeout, retry only the same body and idempotency key; stop on validation, authentication,
confirmation, or resync errors. Treat results as opaque when `outputTyped` is false. Prefer diagnosis
and reversible containment over termination.

## Workflow

1. Discover agent resources with `cognia host resources --category agents`.
2. Find status, team, fleet, goal, log, and event read commands; inspect every schema before calling.
3. Establish the affected agent/team identifiers, lifecycle state, current task, and recent errors.
4. Correlate logs with `cognia host events`, preserving the last event sequence.
5. If containment is necessary, inspect pause or interrupt commands before considering kill or
   termination commands. Use `--dry-run` with the exact identifiers.
6. Obtain explicit user confirmation for high- or critical-risk containment. Never add `--yes`
   without that confirmation, and preserve idempotency when retrying.
7. Re-read runtime, team, task, and goal state to verify containment and record unresolved work.

Do not mutate healthy peers during fleet incidents. Do not assume opaque output fields or treat a
transport timeout as proof that a mutation failed.
