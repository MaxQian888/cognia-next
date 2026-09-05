---
title: "0169 — One runtime, one review contract, one control machine"
description: "The Squad execution chain is unified: durable-v2 is the only runtime, ExecutionRunInterrupt is the only pending review, RunControlCommand is the only control seam, and every surface reads the same projected snapshot."
---

# ADR 0169 — One runtime, one review contract, one control machine

**Status:** Accepted
**Date:** 2026-09-05
**Amends:** ADR-0022 (runtime hardening), ADR-0140 (Squad as an executor)

## Context

A Squad could run on two runtimes. The legacy path (`runTeamLifecycle` with
the in-memory `approval-bus`, `workflowRuns` rows under a `__team__:` id and
`agentTeamManager` holding the only control handle) and the durable path
(`agentTeamRuns` plus its child tables, checkpoints, leases and a coordinator
that survives a restart). `config.runtimeVersion` chose between them per
Squad, `DEFAULT_TEAM_CONFIG` defaulted to the legacy one, and a "Migrate to
durable" button in the operations tab moved a Squad across.

Every surface then had to answer "what is this Squad doing?" from three
sources at once: the optimistic `team.status` in the store, the legacy
`workflowRuns` row, and the durable run record. They disagreed after a
reload, after a crash, and on a phone that syncs one table and not the
others. Five HITL gates rode a per-tab bus a reload emptied. Abort was an
alias of pause. A run started from a workflow node, a scheduled task, a slash
command, a connector and the composer took five different code paths to the
same lifecycle, each with its own idea of what to check first.

## Decision

### One runtime

`durable-v2` is the only executable runtime. `AgentTeamRuntimeVersion`,
`config.runtimeVersion` and every branch that read them are gone. There is no
selector, no fallback and no migration UI. A saved definition that still
carries a runtime selector is stripped of it at every boundary (persist
migration v9, the Dexie hydration, the sync inbound sanitizer, the CLI and
the plugin API) by `lib/agent-team/definition-contract.ts`, which also stamps
`contractVersion: 2` and infers the two bindings the coordinator needs
(primary repository, environment) **only when exactly one deterministic
candidate exists**.

`AgentTeam` is a definition. Status, progress, result, cost and recovery live
on `AgentTeamRunRecord`. `ExecutionRun` is the one-way projection every
surface reads. The store's `status` is a mirror written by the lifecycle
runner and nowhere else.

### One launch seam

`startSquadRun` is the only way a Squad starts, from chat, workflow nodes,
the scheduler, slash commands, plugins, connector dispatch, CLI remote calls
and paired-mobile intents alike. Its order is the contract:

1. the runtime is ready (`awaitSquadRuntimeReady`, else `runtime_not_ready`),
2. `SquadReadiness` has no blockers (`not_ready`, with stable codes such as
   `missing_primary_repository`, `environment_not_found`,
   `workspace_controller_unavailable`, `host_unavailable`),
3. no live run exists for the Squad (`already_running`, with the open run id),
4. the durable run record and the canonical `ExecutionRun` plus its
   `run.started` event are written **in one transaction** (`journal_failed`
   means nothing executes),
5. and only then the lifecycle is dispatched, fire-and-forget.

A blocked Squad stays visible and editable. It does not dispatch.

### One control machine

`RunControlCommand` is the only control seam: revision-checked, idempotent,
authorized. Pause is cooperative and resumable. Resume re-enters only from a
verified safe checkpoint. Anything else parks the run as `needs_input` with a
reason code and raises a `team_recovery` review. Stop is terminal, cascades
to children, and denies every pending interrupt. Retry is a linked
replacement run through `startSquadRun`, and the settled history is never
rewritten. Steer persists a receipt and passes the PII gate. The Abort verb
is gone. The visible destructive action is Stop.

A backfilled legacy run (`recoveryReason: legacy_run_not_resumable`) never
resumes. Its recovery review offers `restart_run` and `terminate` only, and
the decision validator refuses anything else against the interrupt's
`subject.choices`.

### One review contract

Squad HITL rides the Action Review contract. `ExecutionRunInterrupt` is the
only pending record, `ActionReviewRequest / Decision / Receipt` the only
protocol. The review kinds are typed (`plan`, `capability_audit`,
`budget_extension`, `deadlock`, `teammate_repair`, `replan`,
`team_recovery`), each with its own `SquadReviewDecision` shape, validated by
`validateSquadReviewDecision` before any handler sees the command. A
`team_recovery` decision is `retry_same_host`, `retry_host`, `restart_run`
or `terminate`. Free text (plan feedback) is redacted before it is stored and
never enters the run journal. Interrupts are restart-safe: a checkpoint is
written before one opens, a re-armed lifecycle finds the same deterministic
row, and expiry denies (durable human handoffs excepted). The `approval-bus`,
`pending-gates-store` and `GateModalsHost` have no Squad readers left.

### One bootstrap

`runSquadBootstrap` orders startup: unlocked account, hydrate and migrate
definitions, install the runtime and control adapters, import legacy run
history into canonical records, reconcile interrupts and recover live runs,
re-arm pending recoveries, then flip ready. A launch that arrives early waits
on the signal, and is refused if it never flips.

### One cockpit

`/squads` keeps definitions, roster, readiness and the task board. Its Runs
tab is the canonical `/agent-runs` panel with `kind = team` (and the selected
Squad) pinned. Run cards deep-link to `/agent-runs?run=…`. The retired
command centre and the per-team runs list, with their own history queries,
are deleted. Desktop, web, mobile, chat, connector and CLI read the same
projected snapshot and the same `allowedActions`. A companion shell submits
its control command to the desktop host as `execution_run_control`, which is
the cockpit's own command through the same gate. The retired
`team_run_pause|resume|stop` answer `upgrade-required`.

### Codes, not sentences

Raw statuses and runtime-authored English are replaced by reason and event
codes localized in `en` and `zh-CN` (`waitingReason` is `waiting_review` or
`recovery_required`, blocker codes render through `squads.readiness.blockers`,
decision and delivery-node statuses through their own tables).

### Telemetry

The existing agent-trace substrate carries a root span per Squad run (the
teammate `invoke_agent` spans already join it by `traceId`), a child span per
review with the gate wait and outcome, and events for dispatch latency,
recovery outcome and duplicate controls. The root closes with the terminal
reason code and token totals. No prompt, argument or secret is emitted.

## Consequences

- Every surface answers "what is this Squad doing?" from one record, and a
  reload, a crash or a phone gets the same answer.
- The five gates that a reload used to lose are durable rows a phone can
  answer, and every answer leaves a receipt.
- Older paired clients keep read-only history and lose Squad mutations until
  they upgrade. That is the price of a single contract.
- The non-terminal legacy runs a user still had become `recovery_required`
  once, with two honest choices. Their history stays immutable.
- ADR-0022's approval-bus gates and ADR-0140's `agentTeamManager` control
  surface are superseded by this document. Both keep their record of *why*
  the pieces exist.

## Invariants (pinned by tests)

1. No code path reads `runtimeVersion` (`definition-contract.test.ts`,
   `store.migrate.test.ts`, `agent-team-definitions.test.ts`).
2. `startSquadRun` writes records before it dispatches, and refuses rather
   than races (`start-squad-run.test.ts`, `squad-run-records.test.ts`).
3. Resume never re-enters over an unsafe checkpoint or a legacy row
   (`squad-control.test.ts`, `team-recovery.test.ts`).
4. Every review kind round-trips through the typed decision and the receipt
   (`squad-review-gate.test.ts`, `squad-review-decision.test.ts`).
5. The bootstrap runs its stages in order and an early launch waits
   (`bootstrap.test.ts`).
6. The `/squads` Runs tab is the `/agent-runs` panel
   (`squad-fleet-console.test.tsx`, `squads-mobile-body.test.tsx`).

## Related

- Docs: [HITL reviews](/docs/chat/agent-teams/hitl-gates),
  [Data model](/docs/chat/agent-teams/data-model),
  [Surfaces](/docs/chat/agent-teams/surfaces),
  [Lifecycle](/docs/chat/agent-teams/lifecycle-and-synthesis).
- ADR-0090 (unified execution), ADR-0045 (plan hub), ADR-0136 (cross-device
  placement), ADR-0152 (local resident host).
