---
title: ADR 0022 — Agent Team runtime hardening
description: Converge the agent-team runtime onto the workflow orchestrator via concurrent ready-set scheduling, a thin team synthesizer producing VisualWorkflow, per-run shared state (TeammatePool with circuit breaker, BudgetGuard with four onCritical actions, TeamNotifier with three-channel routing), and six HITL gates on the existing approval-bus.
---

# ADR 0022 — Agent Team runtime hardening

> **Status**: Proposed on 2026-05-17. Implementation planned across 6 PRs over ~4 weeks. PR 1 (workflow orchestrator concurrent scheduling) is the cutover-risk PR; PR 4 is the team-runtime cutover.

## Context

The agent-team subsystem (`lib/ai/agent/agent-team-runtime.ts:runTeamLifecycle`) advertises itself as a multi-agent orchestrator but only delivers ~30% of its declared capabilities. A read-through against the project's "production reliable" bar surfaced these gaps:

**Engine gaps** — config fields exist, no engine drives them:

- `maxRetries` / `enableTaskRetry`: never read; a failing task is permanently failed on first error
- `defaultTimeout`: never passed to `executeAgent` — a stuck LLM call can only be killed by external abort
- `tokenBudget` / `warningThreshold` / `criticalThreshold` / `onCritical`: tokens are summed but never checked
- `task.dependencies`: ignored — the queue is sorted by `task.order` alone, so a task whose deps are unmet still runs
- `enableDeadlockRecovery`: decorative; no deadlock detection logic exists
- `delegationIds` / `consensusIds` / `TeamDelegationRecord` / `ConsensusRequest`: full types, zero engine
- `defaultMaxSteps`: never forwarded to the executor

**Runtime structure gaps**:

- Round-robin teammate rotation (`teammateRotation % workers.length`) doesn't filter out failed teammates — a teammate that just failed gets the next task
- `inflightControllers` is module-scope `Map<string, AbortController>`; on app reload, the team's status stays `executing` in store but no controller exists to advance it
- `stores/agent/agent-team-store/store.ts:24-29` `partialize` only persists `templates`, `defaultConfig`, `displayMode`, `workspaceTab`. **`teams` / `teammates` / `tasks` / `messages` / `executionReports` are NOT persisted** — a browser refresh erases all run state. Refresh is the only user-facing fallback for any of the failure modes above.

**Architectural duplication**:

- `lib/workflow/runtime/orchestrator.ts` already has topo-sort, IdempotencyCache, crash recovery (`resumeInFlightRuns`), Dexie persistence (`workflowRuns` + `workflowRunEvents`), `RunLogger` + live-query UI, wall-clock timeout, abort-signal cascade
- An `action.team.run` workflow node kind already exists (`lib/workflow/nodes/built-ins.ts:1165`) — workflow already delegates to teams as a primitive
- The existing `action.team.run` executor (`built-ins.ts:1186-1196`) ships with an `as unknown as` cast hack that papers over the store-shape mismatch — this is real, latent bug surface
- Two orchestrators long-term: every cross-cutting concern (resume, observability, cost telemetry) has to be implemented twice

The intended outcome: collapse to a single orchestrator (workflow), give it concurrent ready-set scheduling, and re-express team execution as workflow synthesis + per-run shared state injection. Team-specific concerns (plan approval, teammate pool, budget, notifications) live in a thin synthesizer that owns the human-in-the-loop touchpoints.

## Goals

1. **Single orchestrator.** Workflow runtime becomes the only execution engine; `runTeamLifecycle` retreats to a ~120-line synthesizer that produces a `VisualWorkflow` and delegates to `runWorkflow`.
2. **Workflow gains concurrent scheduling.** Replace the sequential `for (stepId of order)` loop with a ready-set + `maxConcurrency` scheduler. Default `maxConcurrency=1` preserves existing workflow behavior; team synthesizer sets it to `team.config.maxConcurrentTeammates`.
3. **Per-task retry with teammate rotation.** A failing `team.task.dispatch` node triggers workflow's standard retry; each retry's executor re-claims from the pool, naturally rotating to an available teammate.
4. **Per-teammate circuit breaker** (composes `lib/connectors/circuit-breaker.ts`) for transient quarantine with auto-recovery; **per-teammate disqualification** for catastrophic failures (auth, invalid config) that require user intervention.
5. **Token budget with all four `onCritical` actions implemented**: `notify`, `pause_for_review`, `reduce_concurrency`, `handoff_to_background` (defined as "downshift gear": cheaper model + concurrency=1 + silent toasts; not "spawn a worker process").
6. **Six HITL gates** all on the existing generic `lib/runtime/approval-bus`: plan approval (existing), budget override, deadlock unfreeze, teammate fix (v1); manual task retry, pause/resume (v2 follow-ups).
7. **Output validation** in the executor: empty/whitespace output triggers retry + rotation; configurable minimum length and refusal detection.
8. **Three-channel notification routing** (sonner toast / Tauri OS notification / workflow event-log) via a single ~80-line `team-notifier.ts`. Levels: info (log-only), warn (log+toast), critical (log+toast+OS+optional gate). Per-event dedupe.
9. **Crash recovery** for team runs as a free byproduct of riding workflow runtime — `resumeInFlightRuns()` already exists and already handles in-flight runs from the durable `workflowRuns` table.
10. **No new Dexie tables.** Team runs are workflow runs; the Runs UI shows both via the existing live-query on `workflowRuns`, filtered by `triggerKind === "team"`.

## Non-Goals

- **Durable worker process / external queue** (Temporal-style) — explicitly out of scope. `handoff_to_background` is interpreted as in-process downshift, not cross-process handoff.
- **Delegation / Consensus engines** — types stay in `types/agent/agent-team.ts` but no engine is added. These can be future modules without re-architecting.
- **Manual task retry UI and Pause/Resume** — deferred to v2; requires workflow runtime extensions (inject node into in-flight run; wake-bus integration into orchestrator) that don't block v1.
- **Pre-existing workflow refactoring** outside the concurrent-scheduler change — `topo-sort.ts` stays workflow-coupled; team synthesizer writes a small focused Kahn lookup. Extracting a shared `kahn-core` is a future opportunity.
- **Persistent agent team data migration** — the store today persists only templates/UI prefs; teams/teammates/tasks/messages are in-memory. There is no existing data to migrate.
- **Parent-child run UI for nested workflows** (a user workflow calling `action.team.run` produces two `workflowRuns` rows). `parentRunId` will be recorded in events for future surface work.
- **Locale routing or i18n changes to the team workspace UI** — copy keys for new modals follow the existing pattern in `i18n/messages/{en,zh-CN}.json` but no broader i18n scope.
- **Agent-authored workflow generation** (an agent that produces `VisualWorkflow` JSON from a user prompt) — explicitly handled by a separate forthcoming ADR; this design produces no infrastructure that constrains that future work.

## Verified findings that shape the brief

1. **`flow.split` is a marker node, not a fan-out primitive.** `built-ins.ts:262`'s executor returns upstream verbatim; the orchestrator's sequential for-loop is what serializes execution. Making the orchestrator concurrent silently upgrades `flow.split` to actual fan-out — backward compatible at the executor level but does change observable behavior for any user workflow that already used it. Mitigated by `maxConcurrency=1` default.
2. **`lib/queue/retry-policy.ts` already implements** `decideNextAttempt`, `backoffDelayMs`, `isRetryable` with `NON_RETRYABLE_PATTERNS` (401/403/404/400/validation/schema). Reuse directly; do not create a parallel `retry-policy.ts` inside `lib/ai/agent/team/`.
3. **`lib/connectors/circuit-breaker.ts` already implements** sliding-window breaker with `closed / open / half_open` states. Per-teammate breaker composition (rather than a binary quarantine boolean) is strictly stronger.
4. **`lib/runtime/approval-bus.ts`** is the generic HITL primitive; `plan-approval-bus.ts` is a thin wrapper. The same primitive already powers GitHub Delivery's HITL guard. All new gates (budget, deadlock, teammate-fix) reuse it.
5. **`lib/workflow/runtime/wake-bus.ts`** is in-process event subscribe with timeout + signal; this is the right primitive for v2 pause/resume and manual-retry events.
6. **`lib/tauri/notification.ts`** already wraps Tauri `sendNotification` with permission management and degrades to no-op outside Tauri. The `notify()` helper is the OS-notification channel for the team notifier.
7. **`lib/scheduler/notification-integration.ts`** is the precedent for a "multi-channel notifier" pattern (toast + desktop + webhook). The team notifier follows the same shape but routes by level rather than per-task config.
8. **No existing pool / worker abstraction.** `lib/ai/agent/background-agent-manager.ts` is just an AbortController registry for plugin-fire-and-forget agents — it is not a teammate pool. New code required.
9. **Workflow's `IdempotencyCache`** memoizes by `(runId, stepId)` and writes only on successful step completion. Retry attempts within `runStep` do not poison the cache — so "retry with different teammate" works without cache invalidation.
10. **Latest Dexie schema version is 35** (`lib/db/schema.ts`). No bump needed for this work because team runs piggyback on `workflowRuns` + `workflowRunEvents`.

## Decision: Path F (orchestrator convergence)

A single orchestrator (workflow runtime) executes all DAGs. Team execution becomes a thin synthesizer that produces a `VisualWorkflow` whose nodes are `team.task.dispatch` instances, with per-run shared state (`TeammatePool`, `BudgetGuard`, `TeamNotifier`, `ConcurrencyController`, `ModelPreferenceController`) registered in a module-scope `WeakMap<runId, TeamRunContext>` that the node executor consults.

### Why not the alternatives

- **Path A** (in-place evolution of `runTeamLifecycle`): smallest diff, but file grows past 600 lines with five responsibilities tangled; violates the project's small-bounded-units guideline.
- **Path B** (separate runtime, reuse utilities): keeps two orchestrators long-term; the existing `action.team.run` cast hack is evidence that the two paths must interact, and divergence will keep producing similar bugs.
- **Path C** (xstate-driven FSM): added dependency; FSM payoff requires 100+ states to amortize, current scope is <20.
- **Path D** (real durable worker process): requires Temporal-class infrastructure (queue, IPC, durable inbox); user explicitly de-scoped this.
- **Path E** (shared `run-history` observability layer, keep two engines): solves observability but not the action.team.run hack root cause.

Path F was selected because: it eliminates the duplicate orchestrator, fixes the action.team.run hack as a side effect, and the workflow orchestrator gaining concurrent execution is a strict feature upgrade that other workflow consumers (GitHub Delivery, twin) can opt into.

### Module diagram

```
┌─────────────────────────────────────────────────────────────────┐
│  Single orchestrator: lib/workflow/runtime/orchestrator.ts      │
│  Old: for (stepId of order) await runStep(...)                  │
│  New: ready-set + maxConcurrency + Promise.race scheduling      │
└─────────────────────────────────────────────────────────────────┘
                       ▲                          ▲
                       │                          │
            User-authored workflow         Team synthesizer
                                           runTeamLifecycle()
                                           ├─ planning gate (existing)
                                           ├─ synthesizeTeamWorkflow → VW
                                           ├─ register TeamRunContext
                                           ├─ runWorkflow(VW, concurrency, signal)
                                           └─ map result → { runId, status }
                                                      │
                                                      ▼
                                       ┌─────────────────────────────┐
                                       │ TeamRunContext               │
                                       │ WeakMap<runId, {             │
                                       │   pool, budget, notifier,    │
                                       │   concurrency, modelPref,    │
                                       │   storeWriter                │
                                       │ }>                           │
                                       └─────────────────────────────┘
                                                      ▲
                                                      │
                                       ┌─────────────────────────────┐
                                       │ team.task.dispatch executor │
                                       │ (registered in built-ins)   │
                                       │                              │
                                       │ 1. ctx = getTeamRunContext   │
                                       │ 2. teammate = pool.claim()   │
                                       │ 3. AbortSignal.any([...])    │
                                       │ 4. executeAgent(prompt)      │
                                       │ 5. validate output           │
                                       │ 6. pool.record(s/f) +        │
                                       │    budget.add() +            │
                                       │    storeWriter.addMessage    │
                                       └─────────────────────────────┘
```

> **Implementation note (correction):** the registry is a plain
> `Map<string, TeamRunContext>`, **not** a `WeakMap`. The diagram above shows the
> original aspiration, but a WeakMap is not applicable here: the key is a string
> `runId`, and the dispatch executor looks the context up by that string
> (`getTeamRunContext(ctx.runId)`) — there is no shared object token between the
> synthesizer that registers and the executor that reads, so weak keying is
> impossible. Leak-safety instead rests on the lifecycle's `finally`-block
> `unregisterTeamRunContext`, hardened with two non-throwing diagnostics
> (`team-run-context.ts`): a warning on re-registering a still-live `runId`
> (missing unregister) and a warning when the registry grows past a soft limit
> (unbalanced register/unregister). See `team-run-context.test.ts`.

### File inventory

| Path                                                  | Action                                                                                            | Lines (impl + test) |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------- |
| `lib/workflow/runtime/orchestrator.ts`                | Modify main loop to ready-set scheduler                                                           | +80 −40 / +120 test |
| `lib/workflow/runtime/concurrency-controller.ts`      | New                                                                                               | ~40 / ~80           |
| `lib/workflow/runtime/model-preference-controller.ts` | New                                                                                               | ~30 / ~60           |
| `types/workflow/visual.ts`                            | Add `maxConcurrency?: number` to settings; extend `TriggerEvent.kind` union with `"team"` variant | +10                 |
| `lib/workflow/nodes/built-ins.ts`                     | Register `team.task.dispatch`; fix `action.team.run` hack                                         | +60 −20 / +80 test  |
| `lib/ai/agent/team/team-run-context.ts`               | New (WeakMap registry)                                                                            | ~40 / ~80           |
| `lib/ai/agent/team/teammate-pool.ts`                  | New (composes circuit-breaker)                                                                    | ~120 / ~180         |
| `lib/ai/agent/team/budget-guard.ts`                   | New (4-action onCritical)                                                                         | ~110 / ~160         |
| `lib/ai/agent/team/team-notifier.ts`                  | New (3-channel routing + dedupe + suspend)                                                        | ~80 / ~140          |
| `lib/ai/agent/team/synthesize-workflow.ts`            | New (team → VisualWorkflow)                                                                       | ~80 / ~140          |
| `lib/ai/agent/agent-team-runtime.ts`                  | Rewrite as thin synthesizer                                                                       | 280 → ~120          |
| `lib/ai/agent/agent-team-runtime-deps.ts`             | Simplify; remove `runTeammateTask`                                                                | −150                |
| `components/agent/approval-gate-dialog.tsx`           | New shared modal                                                                                  | ~100 / ~120         |
| Team UI: workspace pages                              | Migrate data source to `workflowRuns`                                                             | varies              |

Net diff estimate: **+1100 / −200 production lines, +1300 test lines**.

### Reuse table (no reinvention)

| Need                                          | Reused primitive                                                                                                                               | Path                                                               |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| DAG topo-sort                                 | `topoSort()` from workflow (used by orchestrator); team synthesizer writes its own ~30-line Kahn over `AgentTeamTask[]` to keep coupling local | `lib/workflow/runtime/topo-sort.ts` (reference only for team side) |
| Workflow retry + non-retryable classification | `decideNextAttempt`, `isRetryable`, `NON_RETRYABLE_PATTERNS`                                                                                   | `lib/queue/retry-policy.ts`                                        |
| Per-teammate breaker                          | `createCircuitBreaker` (sliding-window + half-open probe)                                                                                      | `lib/connectors/circuit-breaker.ts`                                |
| Per-task timeout                              | `AbortSignal.timeout` + `AbortSignal.any`                                                                                                      | Web standard                                                       |
| HITL gates                                    | `waitForDecision` / `approve` / `reject`                                                                                                       | `lib/runtime/approval-bus.ts`                                      |
| Plan-approval (existing)                      | `plan-approval-bus` (thin wrapper)                                                                                                             | `lib/ai/agent/plan-approval-bus.ts`                                |
| LLM dispatch                                  | `executeAgent` (unchanged)                                                                                                                     | `lib/ai/agent/agent-executor.ts`                                   |
| OS notifications                              | `notify` + `ensureNotificationPermission`                                                                                                      | `lib/tauri/notification.ts`                                        |
| In-app toast                                  | `sonner`                                                                                                                                       | npm dep                                                            |
| Crash recovery                                | `resumeInFlightRuns` (called on app boot today)                                                                                                | `lib/workflow/runtime/resume-controller.ts`                        |
| Run persistence                               | `workflowRuns` + `workflowRunEvents` (unchanged schema)                                                                                        | `lib/db/schema.ts`                                                 |
| Event log + live UI                           | `RunLogger` + Runs page live-query                                                                                                             | `lib/workflow/runtime/event-log.ts`                                |
| Wake-bus (v2 hooks)                           | `subscribeWake` + `emitWake`                                                                                                                   | `lib/workflow/runtime/wake-bus.ts`                                 |

## Module contracts

### TeamRunContext (`lib/ai/agent/team/team-run-context.ts`)

```ts
export interface TeamRunContext {
  readonly runId: string
  readonly teamId: string
  readonly team: AgentTeam
  readonly pool: TeammatePool
  readonly budget: BudgetGuard
  readonly notifier: TeamNotifier
  readonly concurrency: ConcurrencyController
  readonly modelPref: ModelPreferenceController
  readonly storeWriter: TeamStoreWriter
}

export function registerTeamRunContext(ctx: TeamRunContext): void
export function getTeamRunContext(runId: string): TeamRunContext | undefined
export function unregisterTeamRunContext(runId: string): void

export interface TeamStoreWriter {
  addMessage(input: SendMessageInput): void
  setTaskStatus(taskId: string, status: TeamTaskStatus, result?: string, error?: string): void
  updateTeammate(teammateId: string, updates: Partial<AgentTeammate>): void
}
```

### TeammatePool (`lib/ai/agent/team/teammate-pool.ts`)

```ts
export type TeammateFailureKind =
  | "ordinary" // standard failure → sliding-window breaker
  | "rate_limited" // 429 → immediate open, cooldown recovers
  | "catastrophic" // 401/403/404/auth → disqualified, no auto-recovery
  | "empty_output" // ordinary path
  | "refusal" // ordinary path

export interface TeammatePool {
  claim(taskId: string): AgentTeammate | null
  recordSuccess(teammateId: string): void
  recordFailure(teammateId: string, error: unknown): void
  availableCount(): number
  isDisqualified(teammateId: string): boolean
  allUnavailable(): boolean // quarantined ∪ disqualified == all
  onAllUnavailable(cb: () => void): () => void
  onTeammateDisqualified(cb: (teammateId: string, reason: TeammateFailureKind) => void): () => void
  forceUnquarantine(input: { teammateIds?: string[]; resetAll?: boolean }): void
  rejoin(teammateId: string): void // user fixed config; clear disqualified
}

export interface TeammatePoolOptions {
  teammates: AgentTeammate[]
  breakerOptions?: Partial<CircuitBreakerOptions>
  strategy?: "round-robin" // v1 only
  now?: () => number
}

export function createTeammatePool(opts: TeammatePoolOptions): TeammatePool
```

**Invariants**:

- `claim()` only returns teammates where `canPass() && !isDisqualified()` — caller never checks state
- Catastrophic failures bypass the sliding window and immediately mark disqualified
- `forceUnquarantine` resets breaker; `rejoin` clears disqualified — they are distinct operations
- Teammate roster is **frozen at pool construction** — mid-run additions/deletions to the team store do not mutate the pool

### BudgetGuard (`lib/ai/agent/team/budget-guard.ts`)

```ts
export type BudgetEventName =
  | "warning_crossed"
  | "critical_crossed"
  | "pause_for_review"
  | "entered_background_mode"

export interface BudgetGuardOptions {
  runId: string
  limit: number // 0 = unlimited
  warnAt?: number // default 0.80
  critAt?: number // default 0.95
  onCritical: TeamBudgetEscalationAction
  notifier: TeamNotifier
  concurrencyCtrl?: ConcurrencyController
  modelCtrl?: ModelPreferenceController
}

export interface BudgetGuard {
  add(usage: SubAgentTokenUsage): void
  status(): { used: number; limit: number; level: "ok" | "warning" | "critical" }
  extendLimit(extraTokens: number): void // HITL approve resets thresholds
  on(event: BudgetEventName, cb: (payload: { runId: string }) => void): () => void
}

export function createBudgetGuard(opts: BudgetGuardOptions): BudgetGuard
```

`onCritical` dispatch:

- `"notify"`: emit `notifier.notify({ level: "critical", ... })`, no further effect
- `"pause_for_review"`: emit `pause_for_review` event (synthesizer opens gate)
- `"reduce_concurrency"`: `concurrencyCtrl.reduceTo(1)`, emit warn notification
- `"handoff_to_background"`: `concurrencyCtrl.reduceTo(1)` + `modelCtrl.downshift()` + `notifier.suspend()` + emit `entered_background_mode`

### TeamNotifier (`lib/ai/agent/team/team-notifier.ts`)

```ts
export type TeamNotifyLevel = "info" | "warn" | "critical"

export interface TeamNotifyPayload {
  level: TeamNotifyLevel
  title: string
  body?: string
  runId: string
  teamId: string
  taskId?: string
  openApproval?: ApprovalKey // only allowed at critical level
  detailHref?: string
  dedupeKey?: string // same key 5min window → suppressed
}

export interface TeamNotifier {
  notify(p: TeamNotifyPayload): void
  suspend(): void // handoff_to_background → toast/OS off
  resume(): void // v2 use
}

export interface TeamNotifierDeps {
  toast?: (msg: string, opts?: { description?: string }) => void
  osNotify?: (opts: { title: string; body?: string }) => Promise<void>
  log?: (level: "info" | "warn" | "error", message: string, payload?: unknown) => Promise<void>
  now?: () => number
}

export function createTeamNotifier(
  runCtx: { runId: string; teamId: string },
  deps?: TeamNotifierDeps
): TeamNotifier
```

Channel routing by level:

| Level    | sonner toast | OS notify | event-log |
| -------- | ------------ | --------- | --------- |
| info     | no           | no        | yes       |
| warn     | yes          | no        | yes       |
| critical | yes          | yes       | yes       |

### ConcurrencyController (`lib/workflow/runtime/concurrency-controller.ts`)

```ts
export interface ConcurrencyController {
  get(): number
  reduceTo(n: number): void // monotone non-increasing only; cannot raise
  subscribe(fn: (n: number) => void): () => void
}

export function createConcurrencyController(initial: number): ConcurrencyController
```

Backward compatibility: `RunWorkflowInput.concurrency` is optional. When omitted, orchestrator constructs an internal controller from `workflow.settings.maxConcurrency ?? 1` — behavior identical to today's sequential execution.

### ModelPreferenceController (`lib/workflow/runtime/model-preference-controller.ts`)

```ts
export interface ModelPreferenceController {
  get(): { preferCheap?: boolean; modelHint?: string }
  downshift(): void // set preferCheap=true, optionally apply modelHint
}

export function createModelPreferenceController(opts?: {
  cheapModel?: string // e.g. "claude-haiku-4-5"
}): ModelPreferenceController
```

### synthesizeTeamWorkflow (`lib/ai/agent/team/synthesize-workflow.ts`)

```ts
export interface SynthesizeInput {
  team: AgentTeam
  tasks: AgentTeamTask[]
  initialConcurrency: number
  wallClockTimeoutMs?: number
  perTaskTimeoutMs?: number
}

export interface SynthesizeResult {
  workflow: VisualWorkflow
  nodeIdToTaskId: Map<string, string>
}

export function synthesizeTeamWorkflow(input: SynthesizeInput): SynthesizeResult

export class SynthesizeError extends Error {
  constructor(reason: "cycle" | "empty" | "invalid_dep", details: string)
}
```

Synthesized workflow shape:

- `id`: `__team__:${team.id}:${nanoid(8)}` — synthetic prefix; UI must not navigate to a workflow definition for this ID
- Each task → one node with `type: "team.task.dispatch"`, `typeVersion: 1`, `data.params: { teamId, taskId, title, description, expectedOutput }`
- Each `task.dependencies[]` entry → one edge `{ id: ${depId}->${task.id}, source: depId, target: task.id }`
- `settings.maxConcurrency = initialConcurrency` (synthesizer passes `team.config.maxConcurrentTeammates ?? 5`)
- `settings.timeoutMs = wallClockTimeoutMs` (synthesizer passes the wall-clock cap)

Default sourcing for `SynthesizeInput`:

- `perTaskTimeoutMs` falls back to `team.config.defaultTimeout ?? 600_000` (10min); the executor reads it from `TeamRunContext` and combines with `ctx.signal` via `AbortSignal.any`
- `wallClockTimeoutMs` defaults to `0` (no wall-clock cap) when the team config doesn't set one; the synthesizer relies on `tokenBudget` + `externalSignal` as the natural bounds

### team.task.dispatch node (registered in `lib/workflow/nodes/built-ins.ts`)

```ts
registerNodeExecutor({
  kind: "team.task.dispatch",
  typeVersion: 1,
  retryable: true,
  // timeoutMs is set per-run via workflow.settings.timeoutMs; runStep already honors that
  execute: async (ctx) => {
    /* see contract below */
  },
})

interface TeamTaskDispatchParams {
  teamId: string
  taskId: string
  title: string
  description: string
  expectedOutput?: string
}

interface TeamTaskDispatchOutput {
  text: string
  teammateId: string
  teammateName: string
  tokenUsage?: SubAgentTokenUsage
  attempt: number
}
```

Executor body contract:

1. `getTeamRunContext(ctx.runId)` → if missing, throw `nonRetryable("team run context not registered")`
2. `pool.claim(taskId)` → if `null`, throw `RetryableError("no available teammate")`
3. Construct `AbortSignal.any([ctx.signal, AbortSignal.timeout(perTaskTimeoutMs)])`
4. `executeAgent(prompt, { systemPrompt, model: modelPref.get().modelHint, abortSignal })`
5. Validate output:
   - `text.trim().length === 0` → `pool.recordFailure(teammate, EmptyOutputError)`, throw retryable
   - Below `team.config.minOutputChars` → same
   - Refusal detection (when enabled) → same
6. Success: `pool.recordSuccess` + `budget.add(usage)` + `storeWriter.addMessage(result_share)` + `storeWriter.setTaskStatus(completed, text)`
7. Failure: `pool.recordFailure(teammate, error)` (which internally classifies) + `storeWriter.setTaskStatus(failed, undefined, errorMessage)` + rethrow

### runTeamLifecycle (rewritten in `lib/ai/agent/agent-team-runtime.ts`)

```ts
export interface RunTeamLifecycleDeps {
  storeReader: {
    getTeam(teamId: string): AgentTeam | undefined
    getTeammates(teamId: string): AgentTeammate[]
    getTeamTasks(teamId: string): AgentTeamTask[]
  }
  storeWriter: TeamStoreWriter
  runLeadPlanning?: (params: {
    team: AgentTeam
    lead: AgentTeammate
    feedback?: string
    signal: AbortSignal
  }) => Promise<LeadPlanResult>
  notifierDeps?: TeamNotifierDeps
}

export interface RunTeamLifecycleResult {
  runId: string // matches workflowRuns row
  status: "completed" | "failed" | "cancelled"
  reason?: string
}

export async function runTeamLifecycle(
  teamId: string,
  deps: RunTeamLifecycleDeps,
  externalSignal?: AbortSignal
): Promise<RunTeamLifecycleResult>
```

Synthesizer responsibilities (in order):

1. Resolve team/tasks/teammates from `storeReader`
2. Plan-approval gate (if `team.config.requirePlanApproval`), reusing `waitForDecision({scope: "agent-team", id: teamId})`
3. Construct per-run modules: `TeammatePool`, `BudgetGuard`, `TeamNotifier`, `ConcurrencyController(maxConcurrentTeammates)`, `ModelPreferenceController`
4. Subscribe `pool.onAllUnavailable` → deadlock gate (blocks via `reduceTo(0)` then awaits decision)
5. Subscribe `pool.onTeammateDisqualified` → non-blocking teammate-fix notification + gate
6. Subscribe `budget.on("pause_for_review")` → blocking gate via `reduceTo(0)`
7. `synthesizeTeamWorkflow(...)` → `VisualWorkflow`
8. `registerTeamRunContext(...)` in a `try` block
9. `runWorkflow({ workflow, trigger: { kind: "team", payload: { teamId } }, runId, signal, concurrency })`
10. `finally`: `unregisterTeamRunContext`, dispose subscriptions

### agent-team-runtime-deps.ts (simplified)

```ts
// New role: prompt builders + planning provider; no longer per-task executor
export function buildTeammatePrompt(team, teammate, task): string // unchanged
export function buildLeadPlanningPrompt(team, workers, feedback): string // unchanged
export function buildAgentTeamRuntimeDeps(
  opts?
): Pick<RunTeamLifecycleDeps, "runLeadPlanning" | "notifierDeps">
```

The old `runTeammateTask` is deleted — the executor calls `executeAgent` directly.

## Fallback layers

The system has five layers of fallback, ordered from innermost to outermost. All but Layer 4 are inherited from existing primitives.

### Layer 1 — Single execution attempt (executor body)

- `AbortSignal.any([ctx.signal, AbortSignal.timeout(perTaskTimeoutMs)])` — wraps the LLM call
- `try` / `finally` ensures `pool.recordSuccess` or `recordFailure` always fires

### Layer 1.5 — Output validation (executor body, post-LLM)

- Empty output → `RetryableError("EMPTY_OUTPUT")` + `pool.recordFailure`
- Below `minOutputChars` (default 1) → same
- Refusal detection (default off) → same

### Layer 2 — Workflow node retry (`runStep`)

- `workflow.retryDefaults.maxAttempts` and `backoffMs` honored
- Each retry re-enters the executor, which re-claims from the pool → naturally rotates to a different teammate

### Layer 2.5 — Pool error classification (inside `recordFailure`)

| Error pattern                                          | Treatment                                         |
| ------------------------------------------------------ | ------------------------------------------------- |
| `EMPTY_OUTPUT`, `REFUSAL_DETECTED`                     | ordinary (sliding window)                         |
| `\b429\b` / rate-limit                                 | breaker opens immediately, cooldown recovers      |
| `\b40[134]\b` / unauthorized / invalid key / forbidden | **catastrophic** → disqualified, no auto-recovery |
| Other                                                  | ordinary                                          |

### Layer 3 — Orchestrator (workflow runtime, no new code)

- `workflow.settings.timeoutMs` wall-clock abort
- External `AbortSignal` cascade
- `topoSort` cycle detection → run fails fast
- `resumeInFlightRuns()` on app boot reads `workflowRuns where status = 'running'` and continues from `IdempotencyCache`

### Layer 4 — Synthesizer HITL gates (team-specific)

| Trigger                         | Action                                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------------------------ |
| `pool.onAllUnavailable`         | `concurrencyCtrl.reduceTo(0)` → block scheduling → open `agent-team-deadlock` gate               |
| `pool.onTeammateDisqualified`   | open `agent-team-teammate-fix` gate **without** blocking; run continues with remaining teammates |
| `budget.on("pause_for_review")` | `concurrencyCtrl.reduceTo(0)` → block → open `agent-team-budget` gate                            |
| Plan-approval revision limit    | After `maxPlanRevisions` rejected revisions, run fails with reason "plan rejected"               |

## HITL gates

All six gates use `lib/runtime/approval-bus`. Each gate has a unique `(scope, id)` key.

| Gate                  | scope                       | id                       | When                                              | v1 / v2 |
| --------------------- | --------------------------- | ------------------------ | ------------------------------------------------- | ------- |
| Plan approval         | `"agent-team"`              | `teamId`                 | After lead generates plan (existing)              | v1      |
| Budget override       | `"agent-team-budget"`       | `runId`                  | `onCritical: "pause_for_review"` triggered at 95% | v1      |
| Deadlock unfreeze     | `"agent-team-deadlock"`     | `runId`                  | All teammates unavailable                         | v1      |
| Teammate fix          | `"agent-team-teammate-fix"` | `${runId}:${teammateId}` | Single teammate disqualified                      | v1      |
| Manual task retry     | `"agent-team-retry"`        | `${runId}:${taskId}`     | After task permanently failed                     | v2      |
| Workflow pause/resume | `"workflow-pause"`          | `runId`                  | User clicks pause button                          | v2      |

UI: a single `<ApprovalGateDialog>` component takes `(scope, id, title, body, schema, onApprove, onReject)`. Three concrete v1 modals share this component with different payload schemas.

### Gate payload schemas

```ts
// agent-team-budget approve payload
{ extraTokens: number }

// agent-team-deadlock approve payload
{ teammateIds?: string[]; resetAll?: boolean }

// agent-team-teammate-fix approve payload
{ action: "rejoin" | "skip_permanently" }
```

## Notification mechanism

Single public entry point routes by level to three channels. No new infrastructure — composes `sonner`, `lib/tauri/notification`, workflow's `RunLogger`.

### Triggers (where `notifyTeamRunEvent` fires)

| Source                | Event                             | Level    |
| --------------------- | --------------------------------- | -------- |
| Synthesizer           | Plan generated, awaiting approval | critical |
| Synthesizer           | All teammates unavailable         | critical |
| BudgetGuard           | warning_crossed (80%)             | warn     |
| BudgetGuard           | critical_crossed (95%)            | critical |
| Pool                  | Teammate disqualified             | critical |
| Executor              | Teammate quarantined              | warn     |
| Executor              | Task retry (attempt > 1)          | info     |
| Orchestrator → bridge | Run completed / failed            | critical |

### Dedupe rules

- BudgetGuard `warning_crossed` / `critical_crossed` are one-shot per run (reset on `extendLimit`)
- Per-teammate quarantine: same teammateId within 5min window suppressed
- Run-completion notifications are not deduped (each run fires once)

## Migration plan

Six PRs, each independently mergeable and revertible. PR 4 is the cutover; all earlier PRs add capability without changing existing behavior.

| PR       | Scope                                                                                                                                              | Risk                              | Behavior change                                |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ---------------------------------------------- |
| **PR 1** | `ConcurrencyController` + `ModelPreferenceController` + orchestrator main-loop refactor (default `maxConcurrency=1` preserves sequential behavior) | high (touches workflow main loop) | none (no consumer)                             |
| **PR 2** | `TeammatePool` + `BudgetGuard` + `TeamNotifier` + `team-run-context`                                                                               | low                               | none (no consumer)                             |
| **PR 3** | `synthesizeTeamWorkflow` + register `team.task.dispatch` node kind                                                                                 | low                               | none (node registered, no caller)              |
| **PR 4** | **Cutover**: rewrite `runTeamLifecycle`; delete old `runTeammateTask`; fix `built-ins.ts:1186` `action.team.run` cast hack                         | **high**                          | team execution switches to F path              |
| **PR 5** | UI: team detail / Runs page reads `workflowRuns where triggerKind="team"`; `<ApprovalGateDialog>` + 3 modals                                       | medium                            | UI gains real run history (currently has none) |
| **PR 6** | Layer 1.5 output validation + Layer 2.5 error classification + disqualified state + teammate-fix gate + rejoin UI                                  | medium                            | runs more robust under teammate failures       |

### Suggested timeline

| Week | PRs                     |
| ---- | ----------------------- |
| W1   | PR 1 + PR 2 in parallel |
| W2   | PR 3 + PR 4 draft       |
| W3   | PR 4 land + PR 5        |
| W4   | PR 6                    |

### Rollback plans

- **PR 1**: orchestrator regression → `git revert`. PRs 2 & 3 have no consumers, unaffected.
- **PR 4**: team execution regression → `git revert`. Restores old `runTeamLifecycle` path; existing `action.team.run` hack returns (bug latent, not new). PR 5 / 6 must be reverted in reverse order if they shipped.
- **PR 5**: UI regression → revert; backend data source unchanged.
- **PR 6**: pool regression → revert; v1 fallback behavior (no output validation, no catastrophic classification) restored.

### Existing call site audit before PR 4

```bash
rtk grep -r "runTeamLifecycle\|agentTeamManager.start" --include='*.ts' --include='*.tsx'
```

Expected hits to migrate:

- `lib/ai/agent/agent-team.ts:99` (`agentTeamManager.start`)
- `lib/workflow/nodes/built-ins.ts:1199` (the `action.team.run` body)
- Team workspace components (Start button handlers)
- Existing `*.test.ts` against `runTeamLifecycle` and friends

Return-value consumers must switch from inspecting `TeamExecutionReport` to looking up `workflowRuns` by `runId`.

## Testing strategy

### Unit tests per new module

| Module                        | Required scenarios                                                                                                                                                                                                                             |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `concurrency-controller`      | `reduceTo` triggers subscribers; cannot raise; concurrent access safe                                                                                                                                                                          |
| `model-preference-controller` | `downshift` sets preferCheap; executor reads hint                                                                                                                                                                                              |
| `teammate-pool`               | round-robin selection; transient failure → quarantine → cooldown recovery; catastrophic → disqualified (no auto-recovery); `forceUnquarantine` vs `rejoin` distinction; `onAllUnavailable` edge-triggered once; rate-limit immediate-open path |
| `budget-guard`                | all four `onCritical` actions; one-shot warning / critical; `extendLimit` resets thresholds; concurrent `add()` from parallel executors                                                                                                        |
| `team-notifier`               | level → channel routing; `dedupeKey` suppression; `suspend()` blocks toast/OS but not log; non-Tauri fallback (no-op `osNotify`)                                                                                                               |
| `synthesize-workflow`         | DAG → VW conversion; deps → edges; cycle detection throws `SynthesizeError("cycle")`; empty tasks throws `SynthesizeError("empty")`; invalid dep ref throws `SynthesizeError("invalid_dep")`                                                   |
| `team-run-context`            | register / get / unregister; WeakMap doesn't leak                                                                                                                                                                                              |

### Orchestrator concurrency tests (new in `orchestrator.test.ts`)

- Backward compat: existing tests all pass with `maxConcurrency=1` default
- Pure parallel: 3 independent nodes, `maxConcurrency=3` → measured wall-clock < sum of node durations
- Dependency chain: A → B → C with `maxConcurrency=3` → still serial (only A ready first)
- Half-parallel: A → {B, C}; B and C run in parallel after A
- `reduceTo(0)` mid-run: no new dispatches, in-flight finish, then runs resume after restore
- Branch + parallel: split decision causes some nodes skipped; remaining ready run in parallel

### Integration / e2e tests

- **Happy path**: 3 tasks, 2 teammates, 1 dependency → all complete; assert `workflowRuns.status === "completed"`, all task `setTaskStatus(completed)` calls fired
- **Retry + rotation**: teammate A fails twice, B succeeds; assert pool.recordFailure called twice on A, recordSuccess on A or B; task ends `completed`
- **Deadlock + recovery**: mock all teammates failing → `onAllUnavailable` fires → notifier emits critical → gate opens → test approves with `{teammateIds: ["W1"]}` → pool resets W1 → run completes
- **Deadlock + reject**: gate opens → test rejects → abort signal fires → run ends `cancelled`
- **Budget pause_for_review**: mock high-token tasks → critical_crossed → gate opens → approve `{extraTokens: N}` → continues to completion
- **Budget reduce_concurrency**: triggers `concurrencyCtrl.reduceTo(1)` → measured inflight stays ≤ 1
- **Budget handoff_to_background**: assert `modelPref.downshift()` called, notifier `suspend()` called, event-log still receives writes
- **Catastrophic teammate**: mock 401 from W1 → disqualified immediately → notifier opens teammate-fix gate without blocking → other tasks proceed on W2 → approve `rejoin` → W1 re-claimable
- **Empty output**: mock executeAgent returns `""` → recordFailure with `EMPTY_OUTPUT` → workflow retries → second attempt with different teammate succeeds
- **Plan-approval rejection over revision limit**: gate rejects `maxPlanRevisions` times → run ends `failed` with reason "plan rejected"
- **Crash recovery** (manual): start run with workflow-mirror enabled → simulate process abort → call `resumeInFlightRuns()` → assert in-flight team run continues from IdempotencyCache

### Coverage gate

Coverage requirement from `CLAUDE.md` (≥90% lines/branches/functions) applies to all new modules. The orchestrator's modified main loop must keep its existing coverage.

## Consequences

### Positive

- **Single mental model.** Anyone wanting to understand "how does this run" reads workflow runtime once. Team-specific code is ~500 lines of focused concerns.
- **Crash recovery for free.** Team runs survive app restart via `resumeInFlightRuns()` without any team-specific persistence code.
- **Unified observability.** Runs page (one URL) shows both hand-authored workflows and team runs; users learn one UI.
- **`flow.split` becomes meaningful.** Workflows that already use split/join get parallel execution when they opt into `maxConcurrency > 1`.
- **Foundation for future work.** Agent-authored workflows (separate ADR) target the same `VisualWorkflow` artifact and same execution engine — generators don't need to know team specifics.
- **Bug debt cleared.** The `action.team.run` cast hack disappears as a side effect of the rewrite.

### Negative / accepted trade-offs

- **Workflow orchestrator's main loop is touched.** A subtle scheduling bug could affect GitHub Delivery, twin workflows, and any user workflows. Mitigated by `maxConcurrency=1` default + extensive test matrix, but is the highest-risk piece of work.
- **Two workflow rows for nested execution.** A user workflow containing `action.team.run` produces a parent row plus a synthesized child row. UI doesn't surface the parent-child link in v1 (deferred).
- **Team config fields semantically migrate.** `maxRetries`, `defaultTimeout`, `defaultMaxSteps`, `enableTaskRetry`, `enableDeadlockRecovery` are no longer team-private — they map onto workflow settings + node retry policy. UI labels for the team config page may need updates to reflect this.
- **No durable resume of plan-approval gate.** If the user is asked to approve a plan and closes the app, the run is cancelled (the approval-bus subscription is in-memory). This matches today's behavior; durable approval is a v2 follow-up if needed.
- **Synthesized workflows have synthetic IDs.** UI components that try to navigate to a workflow definition for a `__team__:...` id must handle "no definition" gracefully.

### Out-of-band note

Multiple Rust diagnostics surfaced in adjacent files during this design conversation (`src-tauri/src/vector/`, `src-tauri/src/tray*`, `src-tauri/src/keyring_secrets.rs`) representing E0432 / E0277 / E0583 / E0761 hard compile errors. These are unrelated to this ADR but block Rust builds. They should be addressed in a separate task before PR 1 lands, since PR 1 will need `pnpm tauri dev` to run cleanly for integration testing.

## Open questions and v2 follow-ups

| Item                                                                                       | Why deferred                                                                                                                           | Trigger to revisit                                   |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Manual task retry                                                                          | Workflow runtime needs "inject node into in-flight run" — additive but non-trivial                                                     | First user request after v1 ships                    |
| Pause / Resume                                                                             | Wake-bus integration into orchestrator scheduler loop                                                                                  | Same                                                 |
| Parent-child run UI for nested workflows (e.g. user workflow containing `action.team.run`) | UX-only; data already captured in events                                                                                               | When Runs page redesign happens                      |
| `handoff_to_background` "real" mode (separate process / queue)                             | Requires worker queue, IPC, durable inbox — full architectural addition (D path)                                                       | If LLM cost becomes a primary user pain point        |
| Extract `kahn-core` shared between workflow topo-sort and team synthesizer                 | Cosmetic refactor; both implementations are small                                                                                      | When a third Kahn user appears                       |
| Delegation lifecycle (`TeamDelegationRecord`) engine                                       | Explicitly de-scoped                                                                                                                   | If delegation becomes a user request                 |
| Consensus voting engine                                                                    | Explicitly de-scoped                                                                                                                   | If consensus becomes a user request                  |
| Agent-authored workflow generation                                                         | Separate concern; this ADR's synthesizer produces `VisualWorkflow` and an LLM generator would produce the same type with zero coupling | Tracked in forthcoming agent-workflow-generation ADR |

## Addendum (2026-05-30) — Ultracode orchestration

Ports Claude Code's **ultracode** mode (effort-driven multi-agent workflow authoring + quality patterns) onto this subsystem. Ultracode is a second synthesis path alongside the flat task DAG — it reuses the entire Path-F engine (orchestrator, `ConcurrencyController`, `BudgetGuard`, `TeammatePool`, event log, IM fan-out, HITL gates) and adds three things.

**1. Tool-enabled teammates.** The flat path's `action.team.task.dispatch` ran teammates through `executeAgent` (AI SDK `streamText`, text-only). The dispatch core is extracted into a reusable primitive `lib/ai/agent/team/dispatch-teammate.ts:dispatchTeammate` (claim → run → validate → record pool/budget/hooks). On desktop it routes the turn through the Tauri sidecar (`runAndCaptureAssistantReply` + `resolveSendOptions`) so teammates get real Bash/Read/Edit/MCP/skills/native-tools; on web/mobile it falls back to `executeAgent`. The bridge `teammate-character.ts:teammateToCharacter` synthesizes an in-memory `Character` from `AgentTeammate` + its `ResolvedCapabilities`, so the full build-options pipeline applies (subagents come from `session.kind === "team"`). Structured output uses `structured-dispatch.ts:dispatchStructured` (JSON-fenced instruction → `parseProposedPlan` → Zod validate → one retry), uniform across both channels. The flat dispatch executor was rewritten to delegate to `dispatchTeammate`, so standard runs are unchanged but now tool-enabled on desktop.

**2. Quality patterns as higher-order nodes.** Six `pattern.*` node executors (`lib/ai/agent/team/patterns/`) each fan out `dispatchTeammate`/`dispatchStructured` internally — bounded by the run's `ConcurrencyController`, emitting `run_log` sub-events — so runtime-unknown fan-out (loop-until-dry, judge panel) lives *inside* one workflow node and the outer DAG stays valid: `multi-modal-sweep`, `loop-until-dry`, `adversarial-verify` (majority-refute kill; perspective-diverse lenses), `judge-panel`, `completeness-critic`, `synthesize`. Verifiers run tool-enabled.

**3. Plan + trigger.** `ultracode-planner.ts:planUltracodeWorkflow` has a planner teammate author a typed `UltracodePlan` (which patterns, counts, lenses); `synthesize-ultracode.ts:synthesizeUltracodeWorkflow` lowers it to a `pattern.*` DAG (finders → verify → synthesize, with synthesize fanning in from every prior node). `runTeamLifecycle` branches on `ultracode-trigger.ts:isUltracodeActive` (operator override > `ultracode.enabled` + `autoMode`; `auto` keys off `routingAssessment.factors.taskComplexity === "complex"`). The terminal `pattern.synthesize` output becomes `team.finalResult`. Config + manual "Run with ultracode" live in the workspace (`components/agent/workspace/settings/section-ultracode.tsx`, `overview.tsx`).

**Known limitation.** Tool-enabled teammates require the Tauri sidecar; web/mobile fall back to text-only reasoning (surfaced in the UI), inherent to the static-export shell — not a simplification.

## Revision note (2026-07-08) — delivered follow-ups & corrections

Several statements above are superseded (see ADR-0066 for the full design):

- **Manual task retry: delivered** — not via mid-run node injection, but as a guarded
  `failed → pending` board move (`task-move-guard.ts:canMoveTask`); the next run/resume
  re-dispatches the task.
- **Pause / Resume: delivered** — `agentTeamManager.resume()` re-enters
  `runTeamLifecycle` over not-yet-done tasks (`RunTeamLifecycleDeps.taskFilter`,
  filtered ids become `satisfiedDependencyIds`), with an unstrand/reset pass and
  blackboard re-seeding from persisted `task.result`.
- **Delegation & Consensus "types only"**: outdated — engine code now exists
  (`team/delegation-orchestrator.ts`, `team/consensus-orchestrator.ts`).
- **"No new Dexie tables"**: still true for team RUNS (they remain `workflowRuns`
  rows). Two adjacent tables exist for other concerns: `teamPrObservations` (v103,
  PR feedback) and `agentTeamBoard` (v104, a one-way board mirror for mobile sync —
  the store remains the single write source).
- **Wave-runner fix**: the per-wave path reuses one `runId`, which the later
  ADR-0061 P4 ownership guard treated as terminal after wave 1 — silently skipping
  every subsequent wave. The runtime now re-opens the row between waves (companion
  soft-cancel still honored).
- **Workspace tabs**: the `AgentTeamWorkspaceTab` union was corrected to the tabs
  actually rendered (the never-implemented `graph`/`analytics` values were removed).

## Current-state amendment (2026-08-13)

Manual retry, pause/resume, delegation, consensus, persistence, review, and remote dispatch are now delivered by the AgentTeam runtime and later ADRs. The durable external queue remains intentionally excluded. Current ownership is shared with ADR-0066, ADR-0071, ADR-0111, and ADR-0113; this ADR no longer represents an open request to build parallel orchestration state.
