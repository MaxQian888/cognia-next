---
title: "0136 — Cross-device placement"
description: "One answer to where work runs: a shared liveness rule, a shared placement resolver, an explicit execution authority, and a durable host-to-target dispatch queue."
---

# ADR 0136 — Cross-device placement

**Status:** Accepted
**Date:** 2026-08-21

## Context

ADR-0097's own `## Not done` section states the gap plainly: *"Nothing chooses
where a run executes… no desktop-liveness probe, no executor election and no
handoff."* The 2026-08-20 audit
(`docs/research/cross-device-connection-and-dispatch-audit-2026-08-20.zh.md`)
confirmed it from the other direction: the **connection** surface is complete —
five transports, authenticated, pinned, reconnecting — while the **dispatch**
surface is not. Of eleven cross-device dispatch paths exactly one
(`mobileOutboundQueue`, client → host) was durable, idempotent, and recoverable.

Each subsystem had answered "where does this run?" for itself, and none could
see the others' answers:

- **AgentTeam** had a complete resolver (`remote-worker-runtime.ts`) with eleven
  typed rejection reasons and a deterministic tiebreak — for exactly one
  candidate kind.
- **`action.mobile.*`** sorted paired devices by `lastSeenAt` and *never checked
  it*, so a phone last seen three days ago won the sort, absorbed the dispatch,
  and blocked the run for 120 s before failing — with no attempt at the next
  candidate.
- **Workflow capability preflight** unioned capabilities across paired devices
  with the same omission, so a run passed the gate and then hung on dispatch.
- **The scheduler** returned `true` from `isTimingAuthority()` unconditionally
  whenever the timing driver had no leader election — which is every driver in
  production. Two desktops signed into one account each armed the same cron and
  each fired it.

Four independent notions of "online" existed, and two of them were the constant
`true`. Meanwhile `capabilitiesAt` / `featureManifestAt` were written in six
places and read in none.

## Decision

### 1. One liveness rule (`lib/placement/liveness.ts`)

`isPlaceable(liveness, now, policy)` replaces every ad-hoc check. The
distinction that matters is not where the signal came from but whether it proves
presence *now*: a socket does and is trusted outright; a timestamp does only
inside a TTL, and that TTL is `90_000` ms to match `IDLE_TIMEOUT_SECS` in
`ws_worker.rs` — the two sides must not disagree about who is online. "Never
seen" never reads as "here"; clock skew into the future is tolerated, because
refusing a machine over a few seconds of NTP drift is worse than accepting it.

### 2. One placement resolver (`lib/placement/`)

`evaluatePlacement` and `selectPlacement` are generalized from the AgentTeam
resolver rather than written fresh — it was already the only complete
implementation of the question. Both of its properties that matter under
concurrency are preserved: **least loaded first**, so a fleet fills evenly, and
**lexicographic ref as the tiebreak**, so two hosts resolving the same placement
at the same instant reach the same answer.

`PlacementRequirement` carries a `dimension` discriminant.
`CapabilityId` (platform surfaces) and `AgentCapabilityId` (execution features)
are **not merged**: they are different value spaces owned by different modules,
and merging them would invent a third vocabulary nobody owns. A platform
`streaming` therefore cannot satisfy an agent `streaming`.

`selectPlacement` accepts an `evaluate` override so a caller with a richer
vocabulary keeps its own verdicts. `evaluateRemoteWorkerPlacement` uses it: its
eleven reasons are persisted on `AgentTeamChildRun.placementReason`, so the
union is append-only and may never be flattened or renamed.

`PlacementWaitingError` keeps "come back in a moment" distinct from "this will
never work". Collapsing them turns a transient condition into a failed run.

### 3. Explicit execution authority, self by default

`lib/placement/authority.ts` resolves who may fire time-based work:

- **unconfigured ⇒ self-authority** — byte-for-byte today's behaviour, no
  inter-host protocol, nothing to go wrong on a single-machine install;
- **configured ⇒ that host owns timing**, everyone else stands down;
- **configured but unreachable past a grace window ⇒ run locally and say so.**

A laptop that sleeps for two minutes does not trigger a takeover. One that stays
dark does, and the takeover is recorded — silence would mean a team's schedules
simply stop the day that machine is shut down, with nothing explaining why.

### 4. Deterministic idempotency, not an election

Cron double-fire is solved by making the *work* identifiable rather than by
electing an owner. `deterministicTriggerIdempotencyKey` derives a key from what
the hosts agree on — workflow, trigger, and the scheduled instant aligned to a
second — so two hosts observing one occurrence compute one key and the existing
invocation ledger absorbs the second.

The ledger was already sound (deterministic primary key, single-transaction
insert, duplicate `add` resolving to the existing row); it was being bypassed.
`dispatchTrigger` passed no key at all, so the lookup was skipped outright, and
the scheduler passed `${taskId}:${executionId}` where the execution row is
minted per host.

Only time-derived and externally-identified triggers get a key. Two manual
clicks are two runs.

### 5. Visible degradation (`lib/placement/degraded-audit.ts`)

A `placement.degraded` record goes to the notification center **and** the
workflow run event log — the two existing authorities, not a new store. Coalesced
per episode, never per tick. It never throws: the work has already degraded once,
and failing it over an audit write would turn a visible degradation into an
outage.

### 6. Durable host → target dispatch (`hostDispatchQueue`, Dexie v175)

One generic table with a `domain` discriminant (`mobile-step` / `remote-step` /
`schedule-handoff`) rather than three: the runner, backoff, dead-letter policy,
and recovery sweep are identical and only the delivery call differs. Semantics
are copied from `mobileOutboundQueue` because they are correct; the table is
separate because the direction and addressing are not.

`idempotencyKey` is a **unique** index. A read-then-write check is not atomic —
two concurrent enqueues of the same work both saw "no existing row" and both
inserted. The constraint is what makes enqueue-once true rather than likely.

### 7. Leases stop travelling and stop outliving their host

`readWorkflowRunsDelta` projects `lease` and `cancelRequestedAt` out of synced
rows. `lease.expiresAt` is an absolute timestamp from the *executing* desktop's
clock and the receiving client judged it with its own `Date.now()`, so a phone
could call a lease live or stale purely by clock skew, owned by a process it
cannot reach.

A desktop that quits releases what it holds (`installExitLeaseRelease`). Exit is
never blocked and no takeover is awaited — there may be nobody to take over —
but leaving a live lease behind made the run unclaimable for the rest of its TTL
even though its executor was demonstrably gone.

## Consequences

- `action.mobile.*` now fails over across candidates. A device-side **denial or
  cancel is not retried elsewhere** — that is the device's answer, and shopping
  it around would put the same prompt on a phone the user never touched.
- Workflow preflight is stricter: a run that would previously have started and
  then hung now fails the gate with a reason.
- A pinned target that is stale reports so immediately rather than waiting out
  the step timeout, because a pinned target names one machine and there is
  nowhere to fail over to.
- `PlacementReason` and `RemoteWorkerPlacementReason` are both append-only.

## Since accepted

The three gaps this ADR recorded as `## Not done` have been closed, except the
one that was deliberate. What shipped, and where it deviates from the original
sketch:

- **Placement is workflow-level, not node-level.** `WorkflowSettings.runOn`
  carries the constraint, the Workflow Editor's Run Policy field sets it, and
  `dispatchPlacedWorkflowTrigger` resolves it. **Node-level `runOn` is no longer
  part of this decision** — a node cannot be placed independently of the run it
  belongs to without splitting one run's journal across two Hosts, and a run has
  exactly one event log. It applies only to top-level *asynchronous*
  entrypoints (manual, schedule, webhook/event, async HTTP); Skill, MCP,
  agent-tool and subworkflow calls stay colocated with their caller and keep
  their synchronous return contract. An absent `runOn` is strictly equivalent to
  `colocate`, so every workflow written before this field behaves exactly as it
  did.
- **The `hostDispatchQueue` runner exists** (`lib/placement/host-dispatch-runner.ts`,
  installed once per host by `installHostDispatchRuntime`) and drains the two
  domains that have a producer: `mobile-step` and `schedule-handoff`. Claiming
  is a conditional lease inside one Dexie transaction, an expired lease is
  recoverable, and `expiresAt` is minted once at enqueue so neither a retry nor a
  restart extends the deadline. `remote-step` keeps its domain and no runner: a
  runner with nothing to deliver is worse than an honest gap.
- **A terminal dispatch is now visible.** `recordHostDispatchFailure` puts every
  dead-letter and non-retryable refusal in the notification center, and attaches
  it to the run's own event log when the dispatch belongs to one. A
  `schedule-handoff` has no local run, so it gets the notification only — that is
  the honest projection, not an omission. Only the attempt that exhausts the
  budget is audited; the retries before it are not something to page a human for.
- **The execution authority is configurable** from the Scheduled Tasks host area
  (`SchedulerAuthorityControl`): this host or a paired remote host, with a 1 / 5 /
  15 minute unreachability grace, defaulting to 5. Handing timing away also
  disarms what this host already armed (`reconcileTimingAuthority`), and
  `handleTaskDue` re-checks the authority before firing — a slot armed before the
  handover must not fire here, and must not consume the occurrence or advance
  `nextRunAt`, or the two schedules desynchronise.
- **Headless hosts publish host events.** The `host-event-publisher` runtime
  registers the bridge publisher before any authoritative runtime can emit, and
  `ws_bridge.rs` gates it on a closed topic allowlist. Push frames stay IDs-only;
  full approval and step parameters travel on the authenticated WS only.
- **The source projects a handoff, it does not mirror it.** `WorkflowHandoffPanel`
  shows dispatch status, target Host, the run the target minted, and the failure
  reason, and offers to open the target Host. Cancelling splits on admission:
  before `remoteRunId` exists the source owns the occurrence and can cancel;
  after, the run is the target's and cancelling here would strand it.

## Not done

- **Inter-host authority negotiation.** Deliberately absent — the authority is
  explicit configuration, and the deterministic idempotency key is what makes a
  race harmless rather than an election. The grace window is likewise a local
  preference: no election, no lease negotiation, no host-config replication.
- **A `remote-step` domain runner.** The domain is reserved; nothing enqueues it
  yet, and inventing a worker step protocol to fill it would freeze a contract
  before it has a caller.

## Amends

- **ADR-0128 decision 6** ("the scheduler is host-owned and never handed off")
  is revised: a host still owns its own schedules, but it consults the execution
  authority before arming them, and hands off by standing down rather than by
  transferring state. See that ADR's amendment note.
- **ADR-0097** — the placement half of its `## Not done` is now addressed;
  executor election deliberately is not (see above).
