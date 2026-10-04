# Pi Durable: adoption opportunities for Cognia

Date: 2026-10-02 (Asia/Shanghai)

## Recommendation

Borrow Pi Durable's explicit recovery and state contracts incrementally. Do not replace Cognia's execution platform or add a second authoritative scheduler/storage layer for the same work.

The highest-value opportunities are:

1. Align ordinary background subagent recovery with Cognia's stronger durable submission and Squad contracts.
2. Connect existing tool side-effect/idempotency declarations to durable recovery where that bridge is missing.
3. Move AI-SDK compaction off the foreground request path, with revision-aware publication.
4. Define historical version selection and ownership for working sets, plans, and artifacts when conversations fork. Todo snapshots already follow copied message parts in direct branches; summary-only branches have a different representation.

These recommendations were established before implementation approval. The subsequent user-authorized changes and their verification boundaries are recorded in the [implementation note](./pi-durable-cognia-implementation-2026-10-02.md).

## Revalidation: existing authorities take precedence

Revalidated on 2026-10-02 against the same dirty working-tree baseline, tracing callers and lower execution layers rather than treating a single interface as the whole product. The first assessment understated several existing capabilities:

| Earlier implication                                         | Current-code verdict                                                                                                                            | Reuse decision                                                                                                                                     |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tool replay needs new general metadata                      | Too broad. Agent SDK tools have `SideEffectClass`; plugin tools have `retryable`; integration actions have idempotency metadata and key checks. | Bridge these declarations into recovery; do not add an independent tool policy registry or retry executor.                                         |
| Todo needs a new versioned application document             | Incorrect for the transcript-owned Todo. `TodoWrite` already carries authoritative snapshots in message parts, which branches copy.             | Reuse the existing Todo derivation and rendering; investigate other state domains separately.                                                      |
| Durable memoization is an adoption opportunity from scratch | Incorrect. Shared `StepMemoCache` is live through the workflow `IdempotencyCache` and step executor.                                            | Reuse completion hydration; it does not by itself resolve effects interrupted before their result was recorded.                                    |
| Ownership/control is mainly a Squad capability              | Incomplete. Generic delegations already adopt child `ExecutionRun` records, reconcile progress, and fan out controls.                           | Extend the existing delegation/control authorities only for a proven missing lifecycle rule.                                                       |
| Background work can directly enter the current chat outbox  | Unsupported. The installed recovery dispatcher explicitly rejects non-chat submissions.                                                         | Add a compatible dispatch/settlement adapter if approved, keeping the existing execution service; do not silently route a subagent as Direct Chat. |

The remaining opportunities are specific connections and lifecycle guarantees, not missing platform primitives. This revalidation itself was read-only; implementation was authorized afterward.

## Evidence and version boundary

- Earendil's [announcement](https://earendil.com/posts/pi-durable/) is dated 2026-10-01 and explicitly calls Pi Durable experimental. It is a separate framework, not a durability switch in the Pi coding-agent CLI.
- The npm package `@earendil-works/pi-durable` reports `latest: 1.0.0`; publication was 2026-10-01T19:11:04.822Z, or 2026-10-02T03:11:04.822+08:00. Release commit: `a13d35a742c6ef8462812a28fbe1d8c8b7431c32`.
- Upstream source inspected: `7fbbd5f4a1d982bb02d63472dde0774fa639f99b`. The latest Durable-specific change after release adds an Unreleased changelog section. See the [upstream evidence note](./pi-durable-upstream-2026-10-02.md) for exact release, source, and test references.
- Cognia source inspection began at HEAD `6db34c4f2130f57b93b05878eb7793a7097bc6fd`, with extensive pre-existing working-tree changes. Local findings describe the inspected working-tree files, not a clean published release.
- Initial validation was document/source/test-code inspection. Revalidation additionally ran ten focused Cognia Jest suites: 146 tests passed, with coverage disabled. No Pi package installation, model request, credential access, crash experiment, performance benchmark, or live UI/runtime acceptance test was performed.

## What is distinctive about Pi Durable

The [package README](https://github.com/earendil-works/pi/blob/7fbbd5f4a1d982bb02d63472dde0774fa639f99b/packages/durable/README.md) and [specification](https://github.com/earendil-works/pi/blob/7fbbd5f4a1d982bb02d63472dde0774fa639f99b/packages/durable/docs/spec.md) expose the following contracts:

| Capability                          | Meaning for an application                                                                                                                                                                                                       |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Checkpointed tasks                  | Model responses, tool calls, compaction, and custom work are resumable task records rather than only live promises. Recovery follows recorded phases.                                                                            |
| Selective tool replay               | An interrupted tool is rerun only under an explicit safe policy. Otherwise interruption is surfaced to the model. This is not a guarantee that external effects execute once.                                                    |
| Durable submissions                 | A conversation-scoped `requestId` lets a retry recover the original submission. Queueing and steering are persisted rather than owned by a UI connection.                                                                        |
| Ownership and cancellation          | Tasks and conversations form an ownership tree; foreground work blocks idle and participates in ordinary cancellation, while explicitly background work can outlive the current turn.                                            |
| Background compaction               | Summarization starts before the hard context limit, publishes at a turn boundary, and blocks only when needed to fit the next request. A reset can start fresh context while retaining history.                                  |
| Transactional application documents | Typed JSON state can commit with transcript changes. Fork policies choose historical state (`asOf`), current state, or fresh state; rewind behavior is explicit.                                                                 |
| Extension-level primitives          | Tools, tool wrappers, hooks, task definitions, and persisted first-write-wins task memos make application-specific orchestration possible. Subagents are composed from owned conversations rather than a built-in squad product. |
| Commit-based clients                | Clients can subscribe to stored changes and reconnect using cursors; model-facing history and UI-facing state need not be identical representations.                                                                             |

## What Cognia already has

### Durable acceptance, deduplication, and frozen inputs

[`acceptWorkSubmission`](../../lib/work-submission/service.ts) checks the account-scoped idempotency key, repeats that check within a transaction, and persists the transcript, input batch, submission, and canonical execution run together. Dispatch follows acceptance. Execution context is bound under a write-once guard. This already addresses the basic problem of a visible user message being lost between acceptance and dispatch.

[`planWorkSubmissionRecovery`](../../lib/work-submission/recovery.ts) deliberately parks a previously dispatched turn when its journal records any `tool.started`, `tool.completed`, or `tool.failed` event. It composes the existing canonical recovery planner. It must not be described as a missing recovery system. See [ADR-0125](../content/docs/en/adr/0125-durable-work-submission.md).

### Squad checkpoints, side effects, review, and control

[`durable-runtime.ts`](../../lib/ai/agent/team/durable/durable-runtime.ts) validates checkpoint safety and rejects uncheckpointed later remote events. [`durable-dispatch.ts`](../../lib/ai/agent/team/durable/durable-dispatch.ts) records tool intents, results, side-effect state, and checkpoints. The type model already includes `safe | unsafe | unknown` replay classification.

Squad launch/control/review already converge on one durable runtime and canonical `ExecutionRun` projection. Pending review identities and receipts survive restart; Stop cascades to children. See [ADR-0169](../content/docs/en/adr/0169-one-runtime-one-review-one-control-machine.md), [`squad-control.ts`](../../lib/ai/agent/team/squad/squad-control.ts), and [`squad-review-gate.ts`](../../lib/ai/agent/team/gates/squad-review-gate.ts).

### Multi-surface state and execution ownership

[`host-state-store.ts`](../../lib/sync/host-state-store.ts) already has lease acquisition, generation fencing, revision checks, action deduplication, and atomic business projection/receipt writes. [`host-state-service.ts`](../../lib/sync/host-state-service.ts) checks ordered delivery and snapshot cuts. Pi's commit streams are useful reference material, but Cognia does not need another transport or parallel state owner. See [ADR-0116](../content/docs/en/adr/0116-host-authoritative-session-state.md).

Cognia's [cross-host handoff](../content/docs/en/adr/0103-cross-host-session-handoff.md) also carries a separate two-phase single-writer contract. A library that permits multiple attached clients is not a substitute for that transfer protocol or collaboration authorization.

### Completed-step memoization and generic delegation

[`StepMemoCache`](../../lib/durable/idempotency.ts) already hydrates successful outputs from a durable log projection. The workflow [`IdempotencyCache`](../../lib/workflow/runtime/idempotency.ts) specializes the event mapping; [`orchestrator.ts`](../../lib/workflow/runtime/orchestrator.ts) hydrates it and [`step-executor.ts`](../../lib/workflow/runtime/step-executor.ts) returns cached completions before executing again. The shared utility itself owns neither persistence nor an unfinished effect's replay decision. Its comments mention Bot reuse, but the verified production consumer here is the workflow path.

Generic [`delegation.ts`](../../lib/execution/delegation.ts), [`delegation-bridge.ts`](../../lib/execution/delegation-bridge.ts), and [`control-handlers.ts`](../../lib/execution/control-handlers.ts) already provide child adoption, progress projection, settlement reconciliation, and child control. Do not infer universal cancellation ownership from `parentRunId`: the same field also represents retry lineage. Any stronger structured-cancellation behavior must distinguish ownership edges from provenance edges.

## Recommended changes, in priority order

### 1. Align background-task recovery before expanding automatic replay

**Observed gap:** [`BackgroundTaskRegistry`](../../lib/background-tasks/registry-core.ts) stores live promises and performs best-effort journal writes; `writeJournal` catches persistence failures. [`startDispatchRun`](../../lib/claude/agents/dispatch-run.ts) starts `runWithRetries()` before registering the background journal. [`redispatchBackgroundRun`](../../lib/background-tasks/redispatch.ts) starts a new run from the saved prompt/subagent/tool flag and links provenance; it does not resume a recorded task phase.

The [boot initializer](../../components/providers/initializers/background-task-initializer.tsx) exposes this as opt-in auto-resume for interrupted background subagents, with an attempt cap. This is a real reachable path, but source inspection does not prove a duplicate external effect has occurred.

**Borrow:** durable acceptance before execution, persisted phase/outcome state, explicit ownership and recovery classification. A retry cap limits repeated work; it does not establish replay safety.

**Cognia implementation seam:** extend the existing background-task adapter and canonical work submission/recovery/control machinery. The actual dispatch already reaches [`AgentExecutionService`](../../lib/ai/agent/execution/agent-execution-service.ts) through [`plugin/agent-sdk/dispatch.ts`](../../lib/plugin/agent-sdk/dispatch.ts), preserving resolver and workspace authority; it must not be replaced by a parallel execution path. Preserve job-center collectability, result delivery, attempt lineage, permissions, budget inheritance, and deletion behavior.

The current [`bootstrap.ts`](../../lib/work-submission/bootstrap.ts) installs `createStoredChatDispatch()` for both renderer and headless. [`stored-chat-dispatch.ts`](../../lib/work-submission/stored-chat-dispatch.ts) rejects `sourceKind !== "chat"`, and acceptance currently creates an `agent-turn` run. Reuse therefore requires an explicit dispatch/settlement adapter and compatible run-kind handling, not merely inserting a background-subagent row. Do not create a second scheduler simply to imitate Pi's API.

**Acceptance checks:** kill after acceptance but before dispatch; kill after an external side effect but before recording its result; fail the acceptance write; restart twice during result delivery. Verify durable acceptance or explicit refusal, safe parking for ambiguous effects, no duplicate parent delivery, and cleanup of owned foreground work.

### 2. Make tool replay a verified execution contract

**Corrected verdict:** Direct Chat recovery treats observed tool activity as disqualifying, and Squad capture initializes tool intent with `replay: "unknown"`. Those findings stand, but the absence of replay metadata on [`ToolDefinition`](../../types/agent/tool.ts) was not sufficient to characterize Cognia's tool platform.

Existing contracts already include:

- [`SideEffectClass`](../../packages/agent/src/types.ts): `none | idempotent | non-idempotent`, attached to `ClientToolRegistration`, with defaults in [`define-tool.ts`](../../packages/agent/src/define-tool.ts).
- [`PluginToolDef.retryable`](../../types/plugin/plugin.ts): explicit opt-in for idempotent plugin retries, consumed by [`invoke-plugin-tool.ts`](../../lib/plugin/core/invoke-plugin-tool.ts) through existing resilience handling.
- Integration action idempotency: bridged to retryability by [`integrations-bridge.ts`](../../lib/plugin/bridge/integrations-bridge.ts), with key enforcement and retry bounds in [`action-runner.ts`](../../lib/integrations/action-runner.ts).
- CLI client-tool recovery: [`runtime-service.ts`](../../cli/src/agent/rpc/runtime-service.ts) persists pending external tools and supports continuing with a supplied recovered result without another client invocation. This is distinct from automatically rerunning an unfinished tool.

**Borrow:** safe replay is explicitly opt-in, with both the persisted policy and current resolved tool policy checked. Pi's recovery tests also show that current execution settings such as `cwd` can affect a rerun; Cognia should retain its stronger frozen execution-context binding.

**Cognia implementation seam:** map the existing declarations into the existing side-effect/checkpoint recovery decision. Do not add another policy enum, metadata registry, or retry executor before proving the current contracts cannot represent the required distinction. Live transient retry, restoring a known result, and replay after process loss have different proof requirements. Begin with a narrow set of operations whose repeat behavior and stable identity are understood; unknown/unsafe operations still require reconciliation or human review. Preserve recorded results, reusing completed-step memoization where applicable.

Do not infer safety from a tool name, lack of an approval dialog, or an MCP `readOnlyHint`. Cognia already documents this trust distinction in [`eligibility.ts`](../../lib/ai/code-mode/eligibility.ts). Read-only operations can still return changed data or consume billable quota; replay-safe does not mean deterministic or free.

**Acceptance checks:** repeated safe reads, policy changes across restart, changed workspace/account/host, a deselected tool, missing result after successful external mutation, stable remote idempotency keys, and unknown external runtimes. Automatic recovery must remain closed when evidence is insufficient.

### 3. Make AI-SDK compaction asynchronous and revision-aware

**Observed gap:** [`dispatchAiSdk`](../../sidecar/src/runtimes/ai-sdk/index.ts) awaits `maybeCompact` before each model-loop leg. [`createCompactor`](../../sidecar/src/runtimes/ai-sdk/compaction.ts) produces the summary and then replaces the in-memory conversation. This specific path can put summary latency directly before the next model request; it is not a claim about every external runtime Cognia supports.

Cognia already supports strategy selection, frozen-summary reuse, alternate summary models, token limits, ledgered calls, plugin hooks, undo capture, and [encrypted compaction checkpoints](../../lib/rag/compaction-checkpoint.ts). The opportunity is scheduling/publication, not adding compaction from scratch.

**Borrow:** begin a background summary at a soft threshold; await it only at a hard threshold; publish at a safe turn boundary. Keep canonical history available for retrieval and preserve tool-call/result pairs.

**Improve on upstream:** bind the summary to the source transcript revision, account/host/session identity, and compaction generation. Reuse the canonical `sessions.transcriptRevision` maintained in [`messages.ts`](../../lib/db/messages.ts) and published through [`revision-events.ts`](../../lib/chat/transcript/revision-events.ts), not another revision store. Carry the selected prefix identity/fingerprint as needed: append-only new turns should not invalidate the background overlap, whereas an edit, redaction, reset, deletion, or incompatible fork of the summarized prefix must. Reuse the current PII gate, billing ledger, checkpoint storage, cancellation, and frozen-summary caching. Existing encrypted compaction recovery records are already wired, but are not scheduler checkpoints for an in-flight summarization task.

Pi's [compaction test](https://github.com/earendil-works/pi/blob/7fbbd5f4a1d982bb02d63472dde0774fa639f99b/packages/durable/test/harness-compaction.test.ts#L1753-L1770) and [specification](https://github.com/earendil-works/pi/blob/7fbbd5f4a1d982bb02d63472dde0774fa639f99b/packages/durable/docs/spec.md#L4473-L4479) explicitly expose stale summary context after a concurrent edit/redaction. This is not evidence that the canonical edit was deleted; the summary can still describe the old content.

**Acceptance checks:** fixed long-conversation workload, foreground latency before/after, extra summary tokens/cost, restart during summary, stale revision publication, edit/redaction while summarizing, paired tool messages, and one bounded overflow retry. No speedup is claimed until measured.

### 4. Give conversation-owned state explicit fork and rewind semantics

**Corrected verdict:** [`branchSessionAtMessage`](../../lib/chat/branch-session.ts) copies the selected message prefix and current session settings, using an SDK fork for eligible tail branches or a seed for other branches. It also copies each message's parts. [`todos.ts`](../../lib/chat/todos.ts) derives the latest authoritative `TodoWrite` snapshot from those parts, so a transcript-local Todo already travels with the retained branch history. A new Todo store or snapshot engine would duplicate this design.

Other state already has domain owners:

- [`working-set.ts`](../../lib/chat/working-set.ts) provides reads, mutation, revision compare-and-set, and PII validation. The branch child currently omits `workingSet`; a revision counter alone does not provide historical snapshots.
- [`artifact-store.ts`](../../stores/artifact/artifact-store.ts) owns both Artifact and Canvas version save/restore and their persistence. Use those histories rather than a new generic document-version store.
- [`PlanRuntime`](../../lib/agent/plan/runtime.ts) and [`plans.ts`](../../lib/db/plans.ts) own current plans and a bounded event log. The `plan_updated` event does not contain a complete historical plan snapshot; the event log cannot simply be treated as a ready historical reconstruction backend.

The narrower unresolved seam is the mapping from a selected historical message/commit to each domain's version, plus child identity/reference remapping and explicit inheritance policy. The current branch write persists the child session and messages without that cross-domain mapping.

**Borrow:** classify each domain deliberately: keep transcript-owned Todo snapshots as they are; define historical/current/fresh behavior only for the remaining state that needs it. Commit state changes with their causative transcript/run event when they share a storage authority.

**Cognia implementation seam:** extend the existing branch/session and artifact/version repositories. First inventory which state is conversation-local, project-shared, externally owned, or permission-sensitive. Never roll back a real workspace, reuse a live sandbox handle, or copy approvals merely because the transcript rewinds. Across Dexie, Rust storage, or external services, use the existing durable receipt/outbox reconciliation boundaries rather than claiming one cross-system transaction.

**Acceptance checks:** branch before and after a plan update, edit the parent after creating a child, fork while work is active, rewind across an approval, resolve deleted artifacts, and ensure a resource is released only by its owner.

### 5. Reuse commit streams and persistent decisions where they improve existing seams

**Already substantially present:** HostState ordered actions and receipts, Squad review persistence, generic delegation ownership/projection/control, canonical run controls, child records, foreground/background metadata, and workflow step memoization.

**Borrow selectively:** consistent ownership/cancellation semantics across ordinary subagents, Squads, jobs, and timers; a reconnectable projection of transcript, queue, tools, run state, and application state. Generic task memos may help replay-stable internal choices, but must not become an alternative approval authority or preserve a grant after identity/policy changes.

**Acceptance checks:** two attached clients steer concurrently; a client misses commits then reconnects; Stop races child completion; foreground cancellation leaves explicitly independent background work running; a parent deleted during work does not receive a late result.

## UI and control reuse map

These are mounted consumers, not merely available components. Any approved implementation should extend these existing seams before considering a new component.

| Product need                                        | Existing component and actual consumer                                                                                                                                                                                          | Existing authority / required boundary                                                                                                                                                             |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Global task entry and background history            | [`JobCenterPanel`](../../components/desktop/job-center-panel.tsx), mounted by desktop [`status-bar-zone.tsx`](../../components/desktop/status-bar-zone.tsx) and [`app-shell-mobile.tsx`](../../components/app-shell-mobile.tsx) | Keep the same job entry, status filters, collect/cancel/rerun behavior. Do not add a Durable dashboard.                                                                                            |
| Current execution monitoring                        | [`ExecutionMonitorPanel`](../../components/execution/execution-monitor-panel.tsx), already rendered inside Job Center                                                                                                           | Reuse [`use-execution-monitor.ts`](../../components/execution/use-execution-monitor.ts) and its existing broker/run/workflow/scheduler projection.                                                 |
| Cross-engine history, detail, and recovery evidence | [`AgentRunsPanel`](../../components/agent-runs/agent-runs-panel.tsx) and its existing `RunDetailPane`, used by `/agent-runs`, Squad fleet/mobile, and Bot runs                                                                  | Reuse canonical `executionRuns`, cockpit projection and deduplication. Job Center already deep-links job detail here.                                                                              |
| Chat progress, queue, Todo, and subagent tree       | [`RunPanel`](../../components/chat/run-panel.tsx), mounted as `RunStatusBar` in [`chat-view.tsx`](../../components/chat/chat-view.tsx)                                                                                          | Reuse current session selectors and the existing queue, Todo, and subagent sections; do not add a parallel run strip/store.                                                                        |
| Background result controls                          | `BackgroundedRunControls`, shared by Job Center and [`subagent-part.tsx`](../../components/chat/message-parts/subagent-part.tsx)                                                                                                | Update underlying recovery behavior and capabilities; keep rerun distinct from genuine checkpoint resume.                                                                                          |
| Permission/recovery decisions                       | [`PendingDecisionSurface`](../../components/chat/decisions/pending-decision-surface.tsx), reused by desktop and mobile tool approval                                                                                            | Use it only for compatible permission/elicitation semantics. Preserve typed Squad/Fusion review forms rather than flattening every recovery choice into Allow.                                     |
| User run actions                                    | [`use-agent-run-actions.ts`](../../hooks/agent-runs/use-agent-run-actions.ts) → [`run-control-dispatch.ts`](../../lib/execution/run-control-dispatch.ts) → authorized local/remote control                                      | Extend `allowedActions` and existing handlers, preserving revisions, idempotency, authorization, and pending interrupts. New UI must not call a runtime directly.                                  |
| Conversation branches and resource state            | Existing `BranchDialog` / `branchWholeConversation` → [`branchSessionAtMessage`](../../lib/chat/branch-session.ts)                                                                                                              | Reuse domain version histories. Keep [`restoreSessionSnapshot`](../../lib/task-workspace/handoff.ts) as an explicit workspace operation; conversation branching must not silently roll back files. |

Control installation is live through [`deferred-boot-initializers-impl.tsx`](../../components/providers/initializers/deferred-boot-initializers-impl.tsx) and the connector runtime. HostState is already installed in desktop, mobile, and web Companion providers; adding Pi-style commit observation does not justify a second sync provider or transport.

## What should not be copied wholesale

- **An experimental replacement runtime.** Pi Durable introduces its own storage/task/conversation model. Putting it beside Cognia's existing authorities for the same run creates reconciliation and ownership work, not automatic durability.
- **Unqualified exactly-once claims.** Pi deduplicates submission by conversation and request ID. Its [implementation](https://github.com/earendil-works/pi/blob/7fbbd5f4a1d982bb02d63472dde0774fa639f99b/packages/durable/src/harness/submissions.ts#L148-L162) returns the original same-type submission even if a reused ID has a different payload. External writes still require their own idempotency/reconciliation contract. A content fingerprint should detect accidental key reuse where Cognia's API requires that guarantee.
- **Unqualified power-loss claims.** The [JSONL storage specification](https://github.com/earendil-works/pi/blob/7fbbd5f4a1d982bb02d63472dde0774fa639f99b/packages/durable/docs/spec.md#L4413-L4431) distinguishes sidecar flushing from main-marker durability. Process restart and power-loss survival are separate guarantees.
- **Multi-client as multi-writer.** Pi's deployment contract uses one active process owning a storage backend. Attached clients do not imply distributed execution ownership, horizontal task workers, RBAC, or Cognia's cross-host transfer protocol.
- **Optional hooks as mandatory security.** Pi's selected-extension hooks are useful customization points. Cognia's PII gate, permission ceiling, sandbox enforcement, and account/host isolation must remain mandatory boundaries outside optional application extensions.

## Relationship to Cognia's existing Pi integration

Cognia currently drives `pi --mode rpc` through [`PiRpcClientAdapter`](../../lib/ai/agent/external/runtimes/pi/pi-rpc-client.ts). The inspected `PI_CERTIFIED_VERSION` is `0.85.1`; newer versions are allowed but marked unverified. The [ecosystem setup hint](../../lib/ai/agent/external/ecosystem-adapters.ts) still names `0.84.3`, so the hint and executable policy are not aligned in this working-tree snapshot.

A Pi 1.0 native-RPC compatibility review is a separate, smaller follow-up: validate command/event shapes, permission-extension handshake, steering/follow-up, compaction, session tree/fork, plugin packages, and sandbox behavior before changing certification. Upgrading the CLI does not confer Pi Durable's task/document guarantees.

If evaluating the package itself later, use an isolated experiment for one headless application and explicitly map ownership, storage, PII, permissions, billing, and public projections. Do not give both Cognia and Pi authority to dispatch or recover the same logical run.

## Proposed order and decision gates

| Order          | Deliverable                                                   | Decision evidence                                                                                 |
| -------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| First          | Background recovery contract audit and alignment              | Crash matrix proves acceptance, safe replay/parking, result delivery, and ownership behavior.     |
| Second         | Bridge existing replay/idempotency declarations into recovery | Fewer unnecessary manual recoveries without duplicated external effects or broadened permissions. |
| Third          | Background compaction experiment in AI-SDK runtime            | Lower measured foreground waiting, bounded token cost, no stale summary publication.              |
| Fourth         | Fork-state contract for WorkingSet or AgentPlan               | Reuse domain stores and existing artifact versions; Todo snapshots remain transcript-owned.       |
| Separate track | Pi 1.0 RPC compatibility certification                        | Real sandboxed protocol flow, independent of a Durable adoption decision.                         |

## Revalidation checks

The final focused command completed with **10 suites passed, 146 tests passed**, coverage disabled:

```sh
rtk pnpm exec jest --selectProjects node --runTestsByPath lib/durable/idempotency.test.ts lib/background-tasks/registry-core.test.ts lib/background-tasks/redispatch.test.ts lib/work-submission/recovery.test.ts lib/work-submission/stored-chat-dispatch.test.ts lib/chat/branch-session.test.ts lib/chat/todos.test.ts lib/execution/delegation-bridge.test.ts packages/agent/src/define-tool.test.ts lib/workflow/runtime/step-executor.test.ts --maxWorkers=2 --coverage=false --watch=false
```

An earlier invocation mistakenly included nonexistent `lib/workflow/runtime/idempotency.test.ts`; six real suites passed (91 tests), but that invocation failed due to the invalid path. The final command above corrected the selection and added existing behavioral tests for the newly identified reuse contracts. No test/source file was added or changed.

These tests validate existing local behaviors with their established test doubles. They do not demonstrate real process-crash recovery, external side-effect exactly-once behavior, authenticated CLI recovery, UI rendering, or a compaction speedup. CLI recovered-result behavior and additional UI/runtime paths were traced in source and test code only.

No product implementation was performed as part of this assessment or revalidation.
