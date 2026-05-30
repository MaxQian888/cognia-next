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
  AgentTeammate,
  AgentTeamTask,
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
}

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
  /**
   * Per-teammate cache of capability resolution. Populated lazily by the
   * dispatch executor on first claim so each teammate's plugin capability
   * pool (skills / mcp / native-tools / character / subagents / a2ui)
   * is computed exactly once per run. See
   * `lib/ai/agent/team/capability-resolver.ts:resolveTeammateCapabilities`.
   */
  readonly resolvedCapabilities: Map<string, ResolvedCapabilities>
}

const registry = new Map<string, TeamRunContext>()

export function registerTeamRunContext(ctx: TeamRunContext): void {
  registry.set(ctx.runId, ctx)
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
