---
title: "0137 — Delegation runtime"
description: "A handed-over task gets a run of its own: one card, steerable, stoppable, and handable to a person without ending it."
---

# ADR 0137 — Delegation runtime

**Status:** Accepted
**Date:** 2026-08-21

## Context

"Delegate this" had no carrier. Every kind in the execution journal names the
**engine** that is executing — `agent-turn`, `team`, `workflow`, `plan`, `goal`,
`scheduled` — and none of them outlives an attempt. A delegation whose turn
failed was simply a failed turn: nothing owned the commitment, so the work could
not report back as one thing, could not be handed to a person, and could not be
retried without pretending a settled run had not settled.

Three concrete gaps followed from that, each independently observable:

- **A team run dispatched from a chat thread was invisible.**
  `putExecutionRunBinding` had three call sites and none was a team run, so a
  team started from IM produced no card, no progress, and every control callback
  was rejected as a conversation mismatch. The run existed; the thread that asked
  for it could not see or reach it.
- **Nothing could be redirected.** The only verbs were stop and pause. A person
  watching an agent work on the wrong thing could end the run and re-explain the
  task, or watch. There was no third option.
- **`parentRunId` existed and was never indexed.** The column has been on
  `executionRuns` since v114 — "previous immutable journal run when this run
  continues a recovered attempt" — but "which runs belong to this one?" cost a
  full table scan, which is why nothing ever asked it.

## Decision

### A delegation is a run kind, and it names the commitment

`ExecutionRunKind` gains `"delegation"`. It is deliberately not a synonym for
any kind beside it: those name what is executing right now, this one names what
was promised, which outlives any single engine attempt. Engine runs point at it
through `parentRunId` (indexed at **v176**, including `[parentRunId+status]`),
and their progress is re-projected onto the parent.

**One delegation is one card.** Without that projection every engine run a
delegation spawns opens its own binding, and the person who asked one question
watches three cards drift apart — precisely the failure "hand this off" was
meant to remove.

Three weights, and only the first is automatic:

| Weight | Trigger | What exists | What the person sees |
| --- | --- | --- | --- |
| T0 one-shot | the turn answers inline | one `agent-turn` run + binding | one activity card, frozen on completion |
| T1 delegation | the turn is accepted as asynchronous | + one `delegation` run + binding; children carry `parentRunId` | confirmation + milestones, updated in place, steerable and stoppable |
| T2 tracked | explicit promotion | + `issues` + `issueRuns` | also on the board, with a number and a status column |

T2 stays explicit because minting an Issue for every delegation would burn the
permanent `issueCounters` numbering and flood a board people use to plan.

### The bridge is a reconciler, not a subscription

A subscription only sees transitions it was alive for, and a delegation is meant
to outlive reloads, host switches, and crashes. So the parent's journal is
**derived from the children's current rows** at any moment, and every emission
carries a `sourceEventId` keyed by `(child, state)`. Replay safety comes from the
journal's own idempotency rather than from remembering what was already sent —
which is what makes it correct after a crash it never observed.

Settlement is deliberately conservative. A delegation is not closed because its
children ran out; it is closed when nothing can still make progress **and**
nobody has been asked a question. A delegation parked on a human has no active
children by construction, so "no active children" alone would close every
handoff the moment it was made.

### Accepting opens the card immediately

`createExecutionRun` emits no event, and the presentation runner gates on
`snapshot.revision > binding.lastProjectedRevision`. A run created and then left
to plan quietly is invisible for exactly as long as the person is wondering
whether their request was heard. Acceptance therefore journals `run.started` (and
`plan.created` when a milestone skeleton already exists) in the same tick, and
binds **before** journalling so the runner cannot wake on an event whose binding
does not exist yet.

### Steering

`RunControlAction` gains `"steer"`, and the message travels on the **command**,
never in the journal. That journal is projected onto twelve platforms' cards, so
free user text in it would be one redaction hole in all of them at once; only
receipt ids are recorded.

Per kind:

- **team** — the coordinator's `steer` persists a receipt *before* attempting
  live delivery, so "nothing is attached right now" is the durable path working,
  not a failure. It fans out to every child that can still act; steering only the
  lead would leave the workers running on the instruction just corrected.
- **agent-turn** — the session's own live-input lane, which owns its PII gate.
- **delegation** — forwards to whichever children are carrying the work.
- everything else — `unsupported_for_kind`, so no card offers a button that
  cannot work.

**A steer that cannot be applied is degraded, not refused.** The two are
different: a refusal means the user's message is spent, a degradation means it is
intact and still theirs to place. `steer_degraded` lets the IM path hand the text
back to the ordinary inbound pipeline, which queues it as a turn — so a
correction is never dropped and never sent twice. Without that distinction every
caller has to choose between those two failures.

Reaching it from a thread required one new matching rule: registration items can
match by **prefix** (`steer: …` / `调整：…`), because steering carries a payload
and the existing exact-label rule cannot. A prefix match deliberately does *not*
consume the registration — buttons are one-shot, but a person redirecting a long
run says several things over its life.

### Handing it to a person

The brief is a **projection, not a table**. What was asked, who asked, what is
done, what was tried, where it stuck, what decision is outstanding, what came out
of it — all of it already exists in the journal, and copying it into a handoff
record would create a second source of truth that goes stale the moment the run
moves.

Neither existing envelope fits. `HandoffEnvelope` is a parent→child handoff
inside one run and its validator rejects URLs and absolute paths: right for a
machine recipient, wrong for a human whose first question is where exactly it
stopped. `ThreadHandoffTicket` moves a conversation between hosts and says
nothing about who owns the work.

The handoff **does not terminate the delegation**. The commitment stays open, the
thread it reports to is still the thread the person answers in, and handing it
back is `resume` on the same run rather than a new request. Any note attached to
the return travels as a steer, through the same gate as every other correction.

Two edges are load-bearing:

- Assigning fails after the interrupt is recorded → the interrupt is resolved
  back out and the run resumed. A delegation waiting on a human nobody was told
  about is worse than no handoff at all.
- An overdue handoff is **marked, not expired**. `recoverPendingRunInterrupts`
  expires anything past its deadline, which is right for a tool approval and
  wrong here: expiring would silently un-assign work a person still owns and
  resume an agent on a task they are mid-way through. Recovery now branches on
  the interrupt type.

### Asking about a plan from the surface that started the run

`resolveGatePolicy` was a two-value map: interactive blocks, everything else is
headless, where the plan gate fails fast because approval without a human is
meaningless. That premise is exactly right for a scheduler run at 3am and false
for IM — there is a person in the thread, and the approval machinery they would
answer through already exists.

A fifth `GateBehavior`, `"delegate"`, closes it. Supplying a delegate is the
caller's **proof** that a reachable human exists, and that is what flips the
policy; a dispatch with no delivery target keeps failing fast, because claiming a
channel that cannot be serviced turns a loud failure into a silent hang. Only
`planApproval` moves: deadlock and budget block indefinitely by design, so
handing them to a card would park a run on a question no answer can unblock.

The card is the same shape as the tool-approval card — same registry, same
binding mechanics, same fail-closed posture — because what differs is only what
it says and what a rejection carries. A plan rejection's feedback lands in the
lead's existing re-planning loop, so a reply in a chat thread becomes the next
revision's instruction.

### `retry` stays declared and unimplemented

The index it was waiting for now exists, but the re-dispatch seam does not.
`allowedActions` still never offers it: a button that always fails is worse than
an absent one. The shape when it lands is the one the recovery policy already
uses — mint a **new** run linked by `parentRunId` and journal there, leaving the
settled row untouched, because a settled journal's history being final is a
guarantee worth keeping.

## Reused ownership

No second execution journal, control gate, approval registry, permission model,
or outbound queue. This decision extends `executionRuns` / `executionRunEvents` /
`executionRunBindings` / `executionRunInterrupts`, `executeRunControlCommand`,
`lib/connectors/hitl/approval-registry.ts`, the governed outbound gateway, and
the run-presentation runner. Exactly one Dexie version (**v176**) and it is an
index-only change with no backfill: rows without a `parentRunId` are absent from
the index, which is correct — they are roots.

## Compatibility and rollback

Every new field is additive and optional. `delegation` is a new kind, so no
existing run changes shape or behaviour. `steer` appears in `allowedActions` only
for the three kinds with a real steering track. `resolveGatePolicy` defaults to
*no* approval channel, so every existing caller keeps its behaviour byte for
byte. Rollback needs no reverse migration; the v176 index is inert without
delegation rows.

## Consequences

A delegated task becomes a first-class object: it reports as one thing, survives
the process that started it, can be redirected without being killed, and can
change hands without ending. The costs are a reconciliation pass over open
delegations, one more run row per promoted turn, and a control vocabulary that is
now large enough that "which kinds can actually do this?" has to be answered per
verb — which is why `unsupported_for_kind` and `steer_degraded` exist as distinct
answers rather than one generic refusal.
