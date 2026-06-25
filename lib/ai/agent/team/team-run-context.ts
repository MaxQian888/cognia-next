/**
 * Per-run shared state consulted by the team.task.dispatch executor.
 *
 * Lifecycle (per ADR-0022 §3.1): synthesizer `register`s before calling
 * `runWorkflow`, `unregister`s in a `finally`. The executor reads
 * `getTeamRunContext(ctx.runId)`; if missing (e.g., a stale workflow run from
 * before the synthesizer was installed), it throws nonRetryable.
 */

import type {
  AgentTeam,
  AgentTeamEvent,
  AgentTeammate,
  AgentTeamTask,
  CreateTaskInput,
  ResolvedCapabilities,
  SendMessageInput,
  TeamTaskStatus,
} from "@/types/agent/agent-team"
import type { ConcurrencyController } from "@/lib/workflow/runtime/concurrency-controller"
import type { ModelPreferenceController } from "@/lib/workflow/runtime/model-preference-controller"
import type { TeammatePool } from "./teammate-pool"
import type { BudgetGuard } from "./budget-guard"
import type { TeamNotifier } from "./team-notifier"

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
   * Push a live event into the team event stream (drives the workspace activity
   * panel). Used by teammate-progress streaming. Optional so non-UI callers /
   * fixtures may omit it.
   */
  addEvent?(event: AgentTeamEvent): void
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
  readonly notifier: TeamNotifier
  readonly concurrency: ConcurrencyController
  readonly modelPref: ModelPreferenceController
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
