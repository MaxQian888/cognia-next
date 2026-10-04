# Pi Durable adoption: Cognia implementation

Date: 2026-10-02 (Asia/Shanghai)

This implementation follows the [research and reuse assessment](./pi-durable-cognia-assessment-2026-10-02.md). It extends Cognia's existing execution, persistence, compaction, and branching paths. It does not install Pi Durable or introduce another scheduler, tool policy registry, workflow memo cache, or document editor.

## Background dispatch and recovery

`startDispatchRun` now commits admission and an owned hidden child session before invoking the existing `AgentExecutionService` path. The existing background task journal stores the frozen target/caller, database namespace, host identity, context fingerprint, deadline, dispatch phase, cancellation intent, and recovery provenance. Terminal output must commit before collection and parent delivery.

Recovery claims a replacement atomically and checks the original phase again inside the transaction. Never-dispatched internal admissions can restart without pretending that a tool effect has already occurred. Dispatched attempts restart automatically only when the current identity and context still match and the original execution is demonstrably free of tool/lifecycle-hook effects. Unknown remote hooks, external runtimes, unreconstructable nested budgets, expired deadlines, handoff locks, and cancellation intent prevent automatic replay. Existing manual rerun remains an explicit new attempt.

Cancellation reuses the existing cancellation registries. The durable receipt precedes abort, and Job Center, Runtime Panel, and model-facing cancellation await that receipt. This prevents a renderer crash from automatically resurrecting a task that the user already cancelled.

This is not an exactly-once guarantee for native tools. An interrupted external effect without a durable correlated result cannot safely be inferred from a retryable error or a tool declaration alone.

## AI-SDK background compaction

The existing compactor retains all strategies, tool-result caps, frozen-summary behavior, hooks, undo metadata, provider routing, and accounting. It starts preparation at a soft threshold, publishes only at a safe model-loop boundary, and waits at the existing hard threshold.

A preparation owns a cloned conversation prefix and model/generation identity. Appends survive publication; changes to the captured prefix reject the candidate. Interrupt, model changes, restore, close, and teardown invalidate outstanding work. Unfinished preparation is cancelled before its owning turn's billing gate closes; a completed candidate may wait for the next boundary. An idle manual compact is serialized with an arriving send.

Destructive transcript changes and AI-SDK reconstruction share a short database/session-scoped lock. Reconstruction reuses the existing message converter, media restoration, visible-branch selection, and PII gate. Retained runtimes avoid a full-history read on ordinary sends. Native SDK resume identity is preserved. The existing send-options module owns preparation, and the existing IPC entry point applies it to local scheduler, room, capture, and chat sends. Controller and HostState dispatch hold the same lock through preparation, frozen-context binding, and the send receipt. Frozen replay validates its original generation instead of relabeling old history. AI-SDK acknowledges reconstruction only after initialization succeeds, including sends without an open chat controller. Queued lock admission and asynchronous hydration refuse a database/account namespace switch.

Closing a sidecar session is a command write receipt, not proof that all old frames have drained. Runtime generations therefore fence event handling, coalesced writes, and database commits. The durable generation remains after the matching replacement initialization acknowledges the pending invalidation. It also distinguishes regeneration attempts that share a logical turn ID. HostState-capable remote sends prepare on the execution host. An older direct remote path explicitly refuses an edited mirrored transcript because the mirror cannot establish the host generation; remote frozen replay is parked for the same reason.

## WorkingSet inheritance

The existing branch dialog adds a native select for three policies:

| Policy              | Behavior                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------- |
| At the branch point | Use the recorded WorkingSet at the last selected message.                                   |
| Current state       | Copy the source session's current WorkingSet. Whole-conversation forks use this explicitly. |
| Start fresh         | Create an empty WorkingSet at revision zero.                                                |

Snapshots are optional fields on existing message rows, so there is no new table or migration. WorkingSet mutations update the current state and its visible message boundary together. Streaming and delta writes preserve these snapshots independently of stale renderer metadata. A branch copies its history and records the selected state at its final boundary; subsequent mutations remain independent.

The visible-branch selector is reused when the newest stored message belongs to an alternative branch. Ordinary ungrouped tails retain a one-message lookup. Older transcripts without historical snapshots produce an explicit choice error instead of silently substituting current state. Both supported locales include the new controls and error text.

Todo continues to derive from message parts. Plan, artifact, canvas, workspace filesystem, permission grants, execution handles, and scheduler ownership remain with their existing authorities; this change establishes historical inheritance specifically for WorkingSet.

## Completeness follow-up

Terminal background results now persist their pending delivery state in the same journal write. Boot reconciliation preserves live tasks in the same renderer registry and independently hosted tasks, serializes overlapping reconciliation, and can recover a safe attempt interrupted by another crash before redispatch. Delivery reserves a stable batch identity on existing journal rows and waits for the existing WorkSubmission, HostState, Squad, or Fusion admission receipt. A refused send stays pending; newly arriving results are not removed with an earlier batch, and a late settle notification cannot redeliver an acknowledged result. Automatic paths without durable admission remain pending and manually collectable. Cross-window ownership is now enforced by the existing task journal as described below.

An AI-SDK session ID stored on disk is no longer treated as proof of a live conversation. The existing control channel exposes `runtimeStatus` under `session.multi-turn`. A matching idle runtime avoids history hydration; a missing or incompatible runtime rebuilds canonical visible history. The send carries the expected live runtime identity so a restart between inspection and dispatch refuses before model or tool effects. A replacement generation or explicit history snapshot rebuilds the loop. Final sidecar PII validation includes restored history and nested tool results.

Manual compaction queued before Undo is invalidated with the old work. Provider context overflow permits one compact-and-retry only before any text or tool output; disabled compaction, unchanged context, and a second failure stop recovery. Summary and model calls retain their existing accounting. The shared provider error classifier is compiled through the existing linked-package build for production sidecar resolution.

Generation fences accept a replacement frame that arrives before its cross-window notification after checking durable state. Rejected generations are cached with bounded storage. An in-progress local invalidation cannot reload an old durable generation while session close is still pending, and a delayed notification read cannot replace a newer local fence.

Whole-conversation remote branching reads complete authoritative history through the existing pagination helper, with metadata and namespace consistency checks. Truncated, duplicated, inconsistent, or unavailable history refuses the branch instead of copying the loaded tail. Branches clear stale branch ownership and avoid reusing an invalidated or historically incompatible SDK context. Failed Aside conversion removes the newly created child. These changes reuse the existing branch dialog, converter, session service, and error presentation.

Remote history reads are consistency-checked rather than an atomic server snapshot. Legacy hosts without a transcript revision use the available update and WorkingSet revisions. Native SDK resume files retain their existing ownership.

## Cross-window owner leases

Renderer-owned journal rows now include an optional `ownerLease` with a process-instance owner ID, execution epoch, and expiry. The existing journal owns admission, renewal, settlement, cancellation, and recovery checks; no additional table or scheduler is introduced. New leases last 60 seconds and renew every 20 seconds. Recovery preserves a valid lease regardless of which window is inspecting it. Once expired, the existing transaction marks interruption and the existing atomic recovery admission claims exactly one replacement, incrementing the predecessor epoch.

The shared `BackgroundTaskRegistry` drives renewal for admitted subagents, ordinary renderer background tasks, plugin agents, and team delegations. Foreground subagent journaling uses that same registry internally without exposing foreground runs as collectable live background tasks. The existing work-submission timer was extracted into a shared lease-heartbeat helper; both callers serialize renewals and ignore late completions after teardown. A lost renewal aborts the owning execution and rejects its result. Terminal journal writes independently require the original database, owner, epoch, running status, and unexpired lease before updating either the result or the attached child session. Old owners cannot settle or cancel a recovered attempt.

The existing recovery initializer now periodically revisits expired tasks, retaining opt-in auto-resume, attempt caps, frozen context validation, and the external-effect safety checks. Desktop lifecycle follows account revision, runtime target, and vault state. The headless runtime uses the same stoppable recovery loop. Namespace changes and teardown prevent subsequent dispatch and rescheduling. Tasks created by older versions without a lease are parked with an explicit unknown-ownership reason and are excluded from automatic replay; manual retry remains available.

Lease expiry is conservative: a suspended owner may lose ownership even if its process remains alive. The resumed owner aborts when it checks its lease, and its late journal result is rejected. This cannot revoke an external effect already issued by a provider or tool; the existing no-unsafe-auto-replay rules remain necessary.

Ownership verification: 11 combined suites passed, with 206 tests covering the database, registry, foreground/background dispatch, plugin facade, recovery loop, initializer, shared heartbeat, and lifecycle observers. A separate headless initializer smoke test verifies start/stop wiring. Tests use synthetic identities and local test databases; they do not establish native window-kill or real provider acceptance. Scoped TypeScript, ESLint, formatting, and diff checks passed.

The owner-lease follow-up adds no translation keys. Its initializer reuses existing English/Chinese notification keys. Repository-wide `i18n:build:check` and `lint:i18n` currently fail because the shared workspace's generated locale files drift from their split sources, including unrelated `publicStatus` references. Those generated files and unrelated components were left unchanged.

## Verification boundaries

Behavioral tests cover admission failures, recovery claims and races, cancellation persistence, handoff locks, replay refusal, output-before-delivery, speculative compaction and accounting, transcript generation races, tool-paired reconstruction, WorkingSet history, and the branch dialog.

Full-repository build TypeScript checking currently includes unrelated browser-extension and web project sources under the root build configuration and reports thousands of diagnostics. This must not be reported as a passing repository gate. Focused tests and scoped checks are separate evidence from real provider, native desktop, process-crash, and power-loss acceptance.

### Verification record

Completeness follow-up on 2026-10-02:

- Integrated frontend and persistence checks: 18 suites, 782 tests passed, including background delivery receipts, Squad/Fusion integration, remote complete-history branching, cold runtime restoration, and generation fences.
- Focused persistence/coalescing checks: 4 suites, 128 tests passed. These overlap the integrated set and are not an additional unique-test count.
- Sidecar runtime, compaction, command, lifecycle, control, and stdio checks: 185 tests passed. Provider error classification: 48 tests passed; linked-package build contract: 5 tests passed. Nine runtime/stdio tests also passed against the compiled classifier export.
- Control-method and capability gate tests: 55 passed. The agent-control method audit passed across all four implementation sites. The Rust control-method allowlist regression passed (1 test).
- Translation freshness and i18n parity passed. No translation strings were added in the follow-up.
- Final scoped TypeScript, sidecar TypeScript, scoped ESLint, Prettier, and diff checks passed. Recovery/Fusion checks also passed 139 tests in seven node suites; delivery/controller checks passed 415 tests in five jsdom suites. These sets overlap the integrated run.
- The broader build-options regression run reported four unrelated tool-manifest fixture failures involving the concurrently added `artifact_capture`; those assertions were left unchanged.
- No new native desktop, paired-device, process-crash, or real-provider acceptance was performed in this follow-up. Scripted sidecar HTTP tests use a local synthetic provider.

Initial implementation checks, retained as historical evidence:

- Combined frontend integration checks: 14 suites, 731 tests passed, covering WorkingSet, branching, the dialog, persistence, plugin mutations, send preparation, the controller, events, coalescing, revision fences, IPC, frozen replay, and HostState dispatch.
- Background admission/recovery/cancellation checks: 13 suites, 306 tests passed (including existing callers). After shared IPC integration, the 11 directly changed background suites were rerun: 245 tests passed.
- Controller and shared send preparation after extraction: 2 suites, 360 tests passed (included in the combined run).
- Event handling, coalescer, and revision fencing passed; Sidecar lifecycle: 30 tests passed. The final AI-SDK initialization correction passed 90 runtime tests and 43 event tests.
- AI-SDK compactor and surrounding runtime regression checks: 5 suites, 140 tests passed; sidecar TypeScript passed.
- The final queued-lock account-switch regression failed before the guard and passed afterward; the four affected persistence/IPC suites passed 180 tests.
- Root source/test ESLint, formatting, scoped TypeScript, translation build freshness and i18n parity passed. Whole-repository TypeScript did not pass; see the boundary above.
- An isolated browser session used the existing E2E fixture bridge and a synthetic local account. The existing message menu opened the branch dialog with all three policies. Selecting Start fresh created a child with the two messages through the selected assistant response. The parent retained all four messages, and opening the child from the sidebar rendered the expected pair. No provider request or real account credentials were used.

The browser check establishes control wiring, branch creation, persisted message boundaries, and child navigation. Nonempty historical/current WorkingSet differences and missing-history refusal are covered by the behavioral tests. Real Tauri interruption, cross-device transport, native process crashes, provider billing, and power-loss recovery were not exercised in this run.
