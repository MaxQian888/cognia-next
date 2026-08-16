---
title: "0125 — Durable Work Submission and Immutable Input Ownership"
description: "Commits a chat turn's message, frozen input and execution run in one transaction before anything is dispatched, so a crash cannot leave a visible message nothing will answer — and never replays work automatically once a tool has run."
---

# ADR 0125 — Durable Work Submission and Immutable Input Ownership

**Status:** Accepted, behind `durableWorkSubmission` (off by default)
**Date:** 2026-08-15

## Context

When a user pressed send, the intent to do that work existed only in renderer
memory. `hooks/chat/use-claude-chat-controller.ts` wrote the user message,
created an `ExecutionRun`, then called `sendPrompt` — three separate commits
with real gaps between them. A crash in any gap left one of two bad states: a
message the user can see that nothing will ever answer, or a run with no
message. Neither was recoverable, because nothing recorded that the work had
been accepted.

Retries had a related problem. Nothing owned the input, so a retry re-derived
the prompt from whatever the session looked like at retry time. A turn retried
after the transcript had moved on was a *different* turn wearing the same id.

Two further facts shaped the design, both verified against the tree rather than
assumed:

- **Direct Chat never touched `AgentExecutionService`.** It calls `sendPrompt`
  directly; no spec resolution, no fingerprint, no capability gate. The
  `surface: "chat"` enum member existed with no producer. Routing Chat through
  the ADR-0090 resolver is a separate, larger change, and
  `agentExecutionResolverV2` is still off by default.
- **Input and context do not become final at the same moment.**
  `effectiveContent` settles at the Workbench payload gate; `sendOptions`
  continues to change for hundreds of lines afterwards — project root, task
  workspace, task execution root, then routing. Any single freeze point is
  wrong for one of them.

## Decision

Persist work before dispatching it, and make the persisted copy authoritative
for any replay.

### One acceptance transaction

The user message, a `workSubmissions` row, the frozen `workInputBatches` row and
the `ExecutionRun` commit together in a single Dexie transaction (v169). Runner
wake-ups, event-bus broadcasts and UI notifications all happen strictly after
commit, because a listener that reacts to work the database has not yet accepted
can observe state a rollback then erases.

The run is opened as `queued`, not `running`. `run.started` projects a run to
`running` via `lib/execution/run-reducer.ts`, which would be false for work that
is accepted but still waiting for a runner — `queued` is precisely that state.
The start event is emitted at dispatch instead.

### Two freeze points, not one

`acceptWorkSubmission` freezes the model-side input at the content freeze point.
`bindWorkExecutionContext` freezes the execution context immediately before
dispatch, under a **write-once** guard: on a retry the stored bundle wins. That
guard is the enforcement point for "a retry replays the original surroundings"
rather than re-resolving the project root against whatever the host looks like
later.

### Dispatch state is not lifecycle

`workSubmissions.dispatchState` answers only "who owes a dispatch attempt".
`ExecutionRun.status` remains the single user-visible lifecycle authority.
Keeping them apart is what stops a terminal product state and a terminal queue
state from disagreeing.

### Replay requires proof, not the absence of doubt

Recovery is asymmetric on purpose. Re-dispatching work that already ran a tool
can double-fire a side effect the user cannot undo; leaving work parked costs an
explicit resume. So automatic replay requires positive evidence that nothing
happened. Any `tool.*` event in the semantic journal, an unresolved tool call in
the canonical envelope log, a corrupt log, or an unreadable journal all park the
submission as `recovery_required`.

This composes the existing zero-replay machinery in `lib/ai/agent/recovery/`
(`readCanonicalEnvelopes` → `candidateFromEnvelopes` → `planRecovery`) rather
than introducing a second recovery machine. The semantic journal is checked
first because Direct Chat writes `tool.*` events there long before canonical
envelopes exist.

Recovery is also decided *before* claiming, so work that must never be replayed
is never even marked as re-attempted.

### Exactly one terminal write

Four places in `hooks/chat/claude-chat-events.ts` can observe a turn ending. All
four route through one settle, and only the first wins — the transcript write
runs for that caller alone. An empty reply settles as `no_response`, a
successful outcome, rather than being misreported as a failure.

### Encryption reuses existing authorities

Frozen input and context are encrypted at rest with the existing account-scoped
key provisioning (`loadOrCreateAccountArtifactKey`, extended with a
`work-submission` domain) and the existing AAD-bound envelope
(`encryptContentEnvelope`, already persisted by `retrievalEncryptedContent`).
The AAD binds `account : submission : half`, so a ciphertext cannot be
transplanted onto another submission, the other half of the same submission, or
another account.

Absolute paths stay on the executing host: the queryable row carries logical
refs only, enforced structurally by `ref-safety.ts`.

## Consequences

- A turn the user can see is either recoverable or explicitly parked for a
  human. It cannot silently vanish.
- Every retry replays a byte-identical input, provable by digest.
- Chat still routes the legacy way in this phase. The resolved spec is recorded
  with `specAuthority: "shadow"` so it cannot be read back as routing evidence
  it never was.
- The headless host gains stranded-run recovery it never had:
  `recoverStaleDirectChatExecutionRuns` was mounted only in renderer
  initializers, so a brain that died mid-turn left its runs untouched.
- Rollback is a flag. With `durableWorkSubmission` off, every entry point
  returns null and the chat path is byte-for-byte what it was.

## Alternatives considered

**One freeze point.** Rejected: the two halves genuinely settle at different
times, so a single point captures a context that is not yet decided or leaves
the message un-owned across the window this ADR exists to close.

**Reusing `run.started` at acceptance.** Rejected: it projects the run to
`running`, which is a lie for queued work and would make the `queued` state
decorative.

**Last-writer-wins recovery.** Rejected for the same reason ADR-0090 Phase 8
rejected it: side-effect ambiguity cannot be resolved by recency.

**A second recovery machine scoped to submissions.** Rejected; the existing
planner already encodes the dominance and fork rules, and two machines would
drift.

## Relationships

- **ADR-0090 (Unified Agent Execution)** — unchanged. This ADR does not route
  Chat through the resolver; it records a shadow spec alongside the legacy path.
- **ADR-0116 (Host-authoritative session state)** — unchanged.
  `HOST_STATE_PROTOCOL_VERSION` stays 1 and `AllowedHostStateIntentV1` is
  untouched; the Host wraps the existing `message.enqueue`.
- **ADR-0079 (Scheduler extension contract)** — unaffected in this phase. When
  Automation adopts submissions it will register an executor through the
  existing `registerTaskExecutor`, add no timing driver, and reconcile across
  the separate `CogniaSchedulerDB` by idempotency key rather than assuming a
  shared transaction.
- **ADR-0086 / ADR-0111 (Task-scoped workspaces)** — the frozen context carries
  the workspace binding as a logical ref; workspace ownership is unchanged.
