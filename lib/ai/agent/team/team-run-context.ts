/**
 * Per-run shared state consulted by the team.task.dispatch executor.
 *
 * Lifecycle (per ADR-0022 §3.1): synthesizer `register`s before calling
 * `runWorkflow`, `unregister`s in a `finally`. The executor reads
 * `getTeamRunContext(ctx.runId)`; if missing (e.g., a stale workflow run from
 * before the synthesizer was installed), it throws nonRetryable.
 */

import type {
  AddTeammateInput,
  AgentTeam,
  AgentTeamEvent,
  AgentTeammate,
  AgentTeamTask,
  CreateTaskInput,
  ResolvedCapabilities,
  SendMessageInput,
  TeamTaskStatus,
} from "@/types/agent/agent-team"
import type { TwinRuntimeDepsForBuild } from "@/lib/claude/build-options"
import type { ConcurrencyController } from "@/lib/workflow/runtime/concurrency-controller"
import type { ModelPreferenceController } from "@/lib/workflow/runtime/model-preference-controller"
import type { TeammatePool } from "./teammate-pool"
import type { BudgetGuard } from "./budget-guard"
import type { TeamNotifier } from "./team-notifier"
import type { AgentTeamRegistryWorkspaceController } from "./workspace/registry-controller"

/**
 * Minimal store-write surface the team.task.dispatch executor needs.
 * Keeps the executor decoupled from Zustand so tests pass a plain object.
 */
export interface TeamStoreWriter {
  addMessage(input: SendMessageInput): void
  setTaskStatus(taskId: string, status: TeamTaskStatus, result?: string, error?: string): void
  updateTeammate(teammateId: string, updates: Partial<AgentTeammate>): void
  /**
   * Persist the run's final synthesized result onto the team (used by ultracode
   * runs to write the synthesizer report to `team.finalResult`). Optional so
   * non-ultracode callers / test fixtures need not provide it.
   */
  setFinalResult?(teamId: string, result: string): void
  /**
   * Create a new task row mid-run (used by adaptive re-planning when a lead
   * checkpoint injects work for a later wave). Returns the created task so the
   * caller can wire its id into the next wave's frontier. Optional so callers
   * that never re-plan (eval/plan fixtures) need not provide it.
   */
  addTask?(input: CreateTaskInput): AgentTeamTask
  /**
   * Patch an existing task row mid-run (used by adaptive re-planning to reorder
   * remaining work via `{ order }`). Optional, same rationale as `addTask`.
   */
  updateTask?(taskId: string, updates: Partial<AgentTeamTask>): void
  /**
   * Create a new teammate row mid-run (used by adaptive re-planning to RECRUIT
   * an Employee Digital Twin as a fresh member). Returns the created teammate so
   * the checkpoint can register it in the live `TeammatePool`. Optional so
   * callers that never recruit (eval/plan fixtures, connector/IM headless path)
   * need not provide it.
   */
  addTeammate?(input: AddTeammateInput): AgentTeammate
  /**
   * Push a live event into the team event stream (drives the workspace activity
   * panel). Used by teammate-progress streaming. Optional so non-UI callers /
   * fixtures may omit it.
   */
  addEvent?(event: AgentTeamEvent): void
}

/**
 * Light summary of an Employee Digital Twin the team may recruit (mid-run
 * re-staffing) or consult. Content-free beyond a short expertise blurb — never
 * carries raw chunk text. Built once per run by `resolveTeamTwinRuntime`.
 */
export interface TeamTwinSummary {
  id: string
  name: string
  /** Short expertise blurb (voice summary + key entities), truncated. */
  expertise: string
}

export interface TeamRunContext {
  readonly runId: string
  readonly teamId: string
  /**
   * Optional run-scoped agent-trace id. When set (e.g. by the eval team
   * target), every teammate dispatch emits its `invoke_agent` span under this
   * trace so the run can be assembled via `queryByTrace`. Undefined for normal
   * runs — dispatch spans then fall back to their own generated trace id.
   */
  readonly traceId?: string
  readonly team: AgentTeam
  readonly pool: TeammatePool
  readonly budget: BudgetGuard
  /**
   * ADR-0090 Phase 7: the run's ONE budget authority. When present, teammate
   * dispatch draws usage through `governor.allocate(childRunId)` (attempts /
   * provider attempts / failures ledgered per child); `budget` is then the
   * governor's own root guard. Optional so hand-built test contexts keep
   * working on the legacy guard alone.
   */
  readonly governor?: import("@/lib/ai/agent/execution/run-budget-governor").RunBudgetGovernor
  readonly notifier: TeamNotifier
  readonly concurrency: ConcurrencyController
  readonly modelPref: ModelPreferenceController
  /**
   * Immutable durable-v2 execution environment captured at run start. Each
   * repository caches its own prepared root while every child receives a
   * distinct logical environment session/worktree.
   */
  readonly durableEnvironment?: {
    adapter: import("../execution/local-tauri-environment").AgentExecutionEnvironment
    profile: Readonly<import("@/types/project-environment").ProjectEnvironmentVersion>
    preparedByRepository: Map<
      string,
      import("../execution/local-tauri-environment").PreparedAgentEnvironment
    >
  }
  /**
   * Per-run HITL gate policy resolved from the trigger origin (see
   * `gate-policy.ts`). Optional so tests that hand-build a context keep
   * working — consumers treat absence as the interactive (block) policy.
   */
  /**
   * The lead of this team, and its review dependency (ADR-0071). Both are set
   * only when `team.config.taskReview.enabled`; the `action.team.task.review`
   * executor fails the task when review is on but either is missing, rather
   * than passing work no one reviewed.
   */
  readonly lead?: AgentTeammate
  readonly runLeadReview?: NonNullable<
    import("../agent-team-runtime").RunTeamLifecycleDeps["runLeadReview"]
  >
  readonly gatePolicy?: import("./gate-policy").TeamGatePolicy
  /**
   * Trigger origin of this run (IM conversation binding, workflow, …).
   * Threaded from `runTeamLifecycle`'s `deps.triggeredFrom` so run-scoped
   * consumers (e.g. the `team_post_to_chat` collaboration tool) can resolve
   * the originating IM conversation without a store lookup. Undefined for
   * interactive/UI runs.
   */
  readonly triggeredFrom?: import("@/types/workflow/visual").WorkflowTriggeredFrom
  /** IM parent ceiling; teammate and Team policies may only narrow it. */
  readonly parentPermissionCeiling?: import("@/types/agent/permission-ceiling").AgentPermissionCeiling
  readonly storeWriter: TeamStoreWriter
  /**
   * Per-teammate cache of capability resolution. Populated lazily by the
   * dispatch executor on first claim so each teammate's plugin capability
   * pool (skills / mcp / native-tools / character / subagents / a2ui)
   * is computed exactly once per run. See
   * `lib/ai/agent/team/capability-resolver.ts:resolveTeammateCapabilities`.
   */
  readonly resolvedCapabilities: Map<string, ResolvedCapabilities>
  /**
   * Per-run cache of external-agent backing instances, keyed by preset id.
   * Populated lazily by `resolveTeammateExternalAgent` so all teammates backed
   * by the same external preset reuse one spawned CLI process for the run.
   * See `lib/ai/agent/team/resolve-external-backing.ts`.
   */
  readonly externalAgentInstances: Map<string, string>
  /**
   * Guarded rate-limit resume controller (ADR — compaction/nudge). Owns the
   * per-run nudge ledger + scheduled cooldown timers; `dispatchTeammate` reports
   * a caught rate-limit failure to it, and the lifecycle disposes it in
   * `finally` so no timer outlives the run. Absent when nudges are disabled.
   */
  readonly rateLimitResume?: import("./rate-limit-resume").RateLimitResumeController
  /**
   * Per-run Employee Digital Twin runtime deps (ADR-0003), built once by
   * `resolveTeamTwinRuntime` when any teammate is twin-bound OR the team exposes
   * `knowledgeTwinIds` OR the run may recruit twins. Threaded into every
   * twin-bound teammate's dispatch (sidecar → `resolveSendOptions`;
   * text → `applyTeammateTwinContext`) so all members share one vector-store
   * client. Undefined when the twin runtime isn't configured — twin injection
   * then degrades to the plain system prompt.
   */
  readonly twinDeps?: TwinRuntimeDepsForBuild
  /**
   * Per-run long-term memory read deps (ADR-0069), built once by
   * `resolveTeamMemoryRuntime`. Threaded into every teammate dispatch so
   * `resolveSendOptions` can recall against the same backend the direct chat
   * path would have used. Undefined when memory is off, temporary, or
   * unreachable; injection then degrades to no recall, which is what a Squad
   * turn did before this field existed.
   */
  readonly memoryDeps?: import("@/lib/memory/runtime/apply-memory-context").ApplyMemoryContextDeps
  /**
   * Twins the lead may recruit as fresh members during adaptive re-planning
   * (see `replan-checkpoint.ts`). Empty when the team can't recruit or none
   * exist. Content-free summaries only.
   */
  readonly availableTwins?: TeamTwinSummary[]
  /**
   * The run's only writable local workspace controller. It acquires detached,
   * Registry-owned Bundles and opens a tracked Bundle Turn per dispatch. When
   * a tool-capable dispatch has a repository but this controller is absent,
   * dispatch fails closed instead of writing to the live checkout.
   */
  readonly workspaceController?: AgentTeamRegistryWorkspaceController
}

const registry = new Map<string, TeamRunContext>()

/**
 * Soft cap on live run contexts. The registry is keyed by string runId, so a
 * WeakMap (the ADR-0022 §3.1 aspiration) is not applicable — there is no shared
 * object token between the synthesizer that `register`s and the executor that
 * looks up by `ctx.runId` string. Correctness instead rests on the lifecycle's
 * `finally`-block `unregister`; these two warnings make a leak observable rather
 * than silent: a still-live re-register (missing unregister) or unbounded
 * growth. They never throw — a warning is a diagnostic, not a gate.
 */
const SOFT_LIMIT = 64

export function registerTeamRunContext(ctx: TeamRunContext): void {
  if (registry.has(ctx.runId)) {
    console.warn(
      `TeamRunContext: runId "${ctx.runId}" is already registered (missing unregister?) — overwriting.`
    )
  }
  registry.set(ctx.runId, ctx)
  if (registry.size > SOFT_LIMIT) {
    console.warn(
      `TeamRunContext: registry size ${registry.size} exceeds soft limit ${SOFT_LIMIT} — possible context leak (unbalanced register/unregister).`
    )
  }
}

export function getTeamRunContext(runId: string): TeamRunContext | undefined {
  return registry.get(runId)
}

export function unregisterTeamRunContext(runId: string): void {
  registry.delete(runId)
}

/** Test-only escape hatch. Production code must not call this. */
export function __resetTeamRunContextForTesting(): void {
  registry.clear()
}

export type { AgentTeammate, AgentTeamTask }
