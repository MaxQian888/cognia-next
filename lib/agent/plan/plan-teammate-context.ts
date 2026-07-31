/**
 * Adapt a plan run into the minimal `TeamRunContext` that `dispatchTeammate`
 * needs — without standing up the full team lifecycle (`runTeamLifecycle`).
 *
 * A plan `teammate_dispatch` step (ADR-0045 P3) reuses the team subsystem's
 * `dispatchTeammate` primitive (claim a teammate, run one turn, validate). But
 * a plan run carries only a lean `PlanRunContext` — it has no teammate pool /
 * budget / notifier. This factory builds a ONE-SHOT `TeamRunContext` from a
 * store-resident `AgentTeam` + its teammates, reusing the exact controller
 * factories the real team runtime uses (`createTeammatePool` /
 * `createBudgetGuard` / `createTeamNotifier` / `createConcurrencyController` /
 * `createModelPreferenceController`, mirroring `agent-team-runtime.ts:252-263`).
 * The context is discarded after the step, so its pool/budget mutations never
 * leak into a concurrent real team run.
 *
 * The `storeWriter` is an in-memory no-op: plan steps call `dispatchTeammate`
 * with `recordToStore: false`, so the writer is never exercised — it exists
 * only to satisfy the required `TeamRunContext` shape.
 */

import type { AgentTeam, AgentTeammate } from "@/types/agent/agent-team"
import { createConcurrencyController } from "@/lib/workflow/runtime/concurrency-controller"
import { createModelPreferenceController } from "@/lib/workflow/runtime/model-preference-controller"
import { createTeammatePool } from "@/lib/ai/agent/team/teammate-pool"
import { createBudgetGuard } from "@/lib/ai/agent/team/budget-guard"
import { createTeamNotifier } from "@/lib/ai/agent/team/team-notifier"
import type { TeamRunContext, TeamStoreWriter } from "@/lib/ai/agent/team/team-run-context"

/** A store-write surface that drops every call (plan dispatch never records). */
const NO_OP_STORE_WRITER: TeamStoreWriter = {
  addMessage: () => {},
  setTaskStatus: () => {},
  updateTeammate: () => {},
}

export interface CreatePlanTeammateRunContextInput {
  /** The plan run id — used as the team run id so spans / hooks correlate. */
  runId: string
  team: AgentTeam
  /** Teammates eligible for this dispatch (the whole team or a single member). */
  teammates: AgentTeammate[]
}

/**
 * Build a one-shot `TeamRunContext` for a single plan `teammate_dispatch`
 * step. Reuses the live team controller factories; nothing is persisted.
 */
export function createPlanTeammateRunContext(
  input: CreatePlanTeammateRunContextInput
): TeamRunContext {
  const { runId, team, teammates } = input

  const concurrency = createConcurrencyController(team.config?.maxConcurrentTeammates ?? 5)
  const modelPref = createModelPreferenceController()
  const notifier = createTeamNotifier({ runId, teamId: team.id })
  const pool = createTeammatePool({ teammates, teamId: team.id, runId })
  const budget = createBudgetGuard({
    runId,
    limit: team.config?.tokenBudget ?? 0,
    onCritical: team.config?.governancePolicy?.budget?.onCritical ?? "notify",
    notifier,
    concurrencyCtrl: concurrency,
    modelCtrl: modelPref,
  })

  return {
    runId,
    teamId: team.id,
    team,
    pool,
    budget,
    notifier,
    concurrency,
    modelPref,
    storeWriter: NO_OP_STORE_WRITER,
    // Lazily populated by dispatchTeammate on first claim.
    resolvedCapabilities: new Map(),
    // Lazily populated by resolveTeammateExternalAgent for external-backed teammates.
    externalAgentInstances: new Map(),
  }
}
