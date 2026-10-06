/**
 * `agentTeamManager`: the team-addressed facade over the Squad execution chain.
 *
 * `list/get/create/update/delete` proxy the store's definition CRUD. Every
 * runtime verb is a thin adapter onto the two seams ADR-0169 leaves:
 *
 *   - `start()` goes through `startSquadRun`, the one launch seam, and then
 *     waits for the run to settle. Callers that await a start (the scheduler,
 *     `ctx.agent.runTeam`, a delegation) want the outcome, not the launch.
 *   - `pause() / resume() / shutdown()` go through `controlSquadTeam`, the one
 *     control state machine, addressed to the team's live run.
 *   - `retryChild()` targets one durable child through the coordinator and
 *     re-enters the lifecycle over that task only.
 *
 * There is no lifecycle body in here any more, and no branch on a runtime
 * version. `configureAgentTeamRuntime` is re-exported for the bootstrap and
 * for tests that install their own runtime deps.
 */

import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { loggers } from "@cognia/logging"
import type { AgentTeam, AgentTeamTask } from "@/types/agent/agent-team"
import type { LeadPlanResult, RunTeamLifecycleDeps } from "./agent-team-runtime"
import type { TeamRunOrigin } from "./gates/gate-policy"
import type { StartSquadRunResult } from "./squad/start-squad-run"
import type { SquadControlResult } from "./squad/squad-control"

export {
  configureAgentTeamRuntime,
  __resetAgentTeamRuntimeForTesting,
} from "./squad/squad-lifecycle-runner"

export type AgentTeamConfig = AgentTeam

export interface AgentTeamStartOptions {
  runId?: string
  signal?: AbortSignal
  ultracode?: boolean
  /** Trigger origin. Headless origins resolve HITL gates via gate-policy. */
  origin?: TeamRunOrigin
  /**
   * The conversation that asked for this run, when the caller has one. Names
   * the thread on the execution row so a gate can find its way back.
   */
  sessionId?: string
  /**
   * Return as soon as the run is journalled and launched instead of waiting
   * for it to settle. Default false: the callers of this facade historically
   * awaited the whole run.
   */
  detached?: boolean
}

export interface AgentTeamManager {
  list(): AgentTeam[]
  get(id: string): AgentTeam | undefined
  create(config: AgentTeamConfig): AgentTeam
  update(id: string, patch: Partial<AgentTeamConfig>): void
  delete(id: string): Promise<void>
  /**
   * Start the team's next run. Resolves when the run settles (or at once with
   * `detached`). Rejects with a typed refusal message when `startSquadRun`
   * refused, so a scheduler or plugin caller reports the real reason.
   */
  start(id: string, opts?: AgentTeamStartOptions): Promise<StartSquadRunResult>
  pause(id: string): Promise<SquadControlResult>
  /** Resume the team's paused run from its latest verified safe checkpoint. */
  resume(id: string): Promise<SquadControlResult>
  retryChild(childRunId: string, optionalHostRef?: string): Promise<void>
  /** Stop the team's live run for good. */
  shutdown(id: string): Promise<SquadControlResult>
}

/** Rebuild durable queues after a restart and replay only safe checkpoints. */
export async function recoverDurableAgentTeams(
  options: { signal?: AbortSignal } = {}
): Promise<Array<{ runId: string; status: "recovering" | "needs_input" }>> {
  if (options.signal?.aborted) return []
  const [{ getDurableTeamCoordinator }, { getAgentTeamRun }] = await Promise.all([
    import("./durable/durable-runtime"),
    import("@/lib/db/agent-team-runtime"),
  ])
  if (options.signal?.aborted) return []
  const outcomes = await getDurableTeamCoordinator().recover()
  if (options.signal?.aborted) return outcomes
  await Promise.all(
    outcomes.map(async (outcome) => {
      const run = await getAgentTeamRun(outcome.runId)
      if (!run || options.signal?.aborted) return
      const team = useAgentTeamStore.getState().getTeam(run.teamId)
      if (!team) return
      if (outcome.status === "needs_input") {
        useAgentTeamStore.getState().setTeamStatus(team.id, "paused")
        const { ensureTeamRecoveryInterrupt } = await import("./durable/team-recovery")
        await ensureTeamRecoveryInterrupt(outcome.runId).catch(() => undefined)
        return
      }
      const { listPendingSquadReviews, openSquadReview, squadReviewRequestIdFromInterrupt } =
        await import("./gates/squad-review-gate")
      const pending = await listPendingSquadReviews(outcome.runId)
      const {
        guardSquadResume,
        prepareSquadResume,
        resumeTaskFilter,
        runSquadLifecycle,
        restoreSquadRunInput,
        parkSquadRecovery,
      } = await import("./squad/squad-lifecycle-runner")
      const stillRecovering = async () => {
        if (options.signal?.aborted) return false
        const current = await getAgentTeamRun(outcome.runId)
        return !options.signal?.aborted && current?.status === "recovering"
      }
      const parkFailedRecovery = async (lifecycleStarted = false) => {
        if (options.signal?.aborted) return
        try {
          const current = await getAgentTeamRun(outcome.runId)
          if (
            options.signal?.aborted ||
            !current ||
            (current.status !== "recovering" && !(lifecycleStarted && current.status === "running"))
          )
            return
          await parkSquadRecovery(outcome.runId, team.id, "reentry_failed")
          outcome.status = "needs_input"
        } catch {
          if (!options.signal?.aborted) {
            loggers.agent.error("Failed to park interrupted Squad recovery", {
              runId: outcome.runId,
            })
          }
        }
      }
      const reenter = async () => {
        if (!(await stillRecovering())) return
        const guard = await guardSquadResume(team.id, outcome.runId)
        if (guard.blocked) {
          outcome.status = "needs_input"
          return
        }
        if (!(await stillRecovering())) return
        const restored = await restoreSquadRunInput(team.id, outcome.runId)
        if (!restored) {
          outcome.status = "needs_input"
          return
        }
        if (!(await stillRecovering())) return
        await prepareSquadResume(team.id)
        // Readiness and restore can await host state. A Pause/Stop that won
        // while they were pending owns the run now, not this old continuation.
        if (!(await stillRecovering())) return
        void runSquadLifecycle({
          ...restored,
          taskFilter: resumeTaskFilter,
          recovery: { signal: options.signal },
        }).catch(() => parkFailedRecovery(true))
      }
      if (pending.length > 0) {
        // A persisted human question still owns the next step. Re-entry must
        // not replace it with a readiness recovery before the person answers.
        // The bootstrap stays ready while the existing durable gate waits.
        void (async () => {
          for (const review of pending) {
            const target = squadReviewRequestIdFromInterrupt(review)
            if (!target || target.kind === "team_recovery" || options.signal?.aborted) return
            const decision = await openSquadReview({
              ...target,
              teamId: team.id,
              signal: options.signal,
            })
            if (options.signal?.aborted) return
            const current = await getAgentTeamRun(outcome.runId)
            if (!current || current.status !== "recovering") return
            if (decision.outcome !== "approve") {
              // No lifecycle survived to handle a refusal. Keep the decision
              // durable and pause; only a new operator gesture may resume work.
              const { controlSquadRun } = await import("./squad/squad-control")
              if (!(await stillRecovering())) return
              await controlSquadRun(outcome.runId, "pause")
              return
            }
          }
          await reenter()
        })().catch(() => parkFailedRecovery())
        return
      }
      await reenter()
    })
  )
  return outcomes
}

export const agentTeamManager: AgentTeamManager = {
  list: () => Object.values(useAgentTeamStore.getState().teams),
  get: (id) => useAgentTeamStore.getState().teams[id],
  create: (team) => {
    useAgentTeamStore.getState().upsertTeam(team)
    return team
  },
  update: (id, patch) => {
    useAgentTeamStore.getState().updateTeam(id, patch)
  },
  delete: (id) => useAgentTeamStore.getState().deleteTeam(id),
  start: async (id, opts) => {
    opts?.signal?.throwIfAborted()
    const { startSquadRun } = await import("./squad/start-squad-run")
    const origin = opts?.origin ?? "interactive"
    const result = await startSquadRun({
      squadId: id,
      ...(opts?.runId ? { runId: opts.runId } : {}),
      goal: "",
      origin,
      triggeredFrom: { source: origin === "im" ? "im" : "ui" },
      ...(opts?.ultracode !== undefined ? { ultracode: opts.ultracode } : {}),
      ...(opts?.sessionId
        ? { session: { id: opts.sessionId } as import("@cognia/agent-config-types").ChatSession }
        : {}),
    })
    if (!result.started) {
      const detail =
        result.reason === "not_ready"
          ? `not_ready:${(result.blockers ?? []).map((b) => b.code).join(",")}`
          : (result.reason ?? "dispatch_error")
      throw new Error(`Squad run refused: ${detail}`)
    }
    if (opts?.signal?.aborted && result.runId) {
      const { controlSquadRun } = await import("./squad/squad-control")
      await controlSquadRun(result.runId, "stop")
      opts.signal.throwIfAborted()
    }
    if (opts?.detached || !result.executionRunId || result.duplicate) return result
    const { awaitSquadRunSettlement } = await import("./squad/watch-squad-run")
    if (opts?.signal) {
      const { controlSquadRun } = await import("./squad/squad-control")
      const stop = () => {
        void controlSquadRun(result.runId!, "stop").catch(() => undefined)
      }
      opts.signal.addEventListener("abort", stop, { once: true })
      try {
        if (opts.signal.aborted) stop()
        await awaitSquadRunSettlement(result.executionRunId, { signal: opts.signal })
      } finally {
        opts.signal.removeEventListener("abort", stop)
      }
    } else {
      await awaitSquadRunSettlement(result.executionRunId)
    }
    return result
  },
  pause: async (id) => {
    const { controlSquadTeam } = await import("./squad/squad-control")
    return controlSquadTeam(id, "pause")
  },
  resume: async (id) => {
    const { controlSquadTeam } = await import("./squad/squad-control")
    return controlSquadTeam(id, "resume")
  },
  retryChild: async (childRunId, optionalHostRef) => {
    const [{ getDurableTeamCoordinator }, { getAgentTeamChildRun }] = await Promise.all([
      import("./durable/durable-runtime"),
      import("@/lib/db/agent-team-runtime"),
    ])
    const child = await getAgentTeamChildRun(childRunId)
    if (!child) throw new Error(`Unknown durable child: ${childRunId}`)
    const team = useAgentTeamStore.getState().getTeam(child.teamId)
    if (!team) throw new Error(`Unknown Squad: ${child.teamId}`)
    await getDurableTeamCoordinator().retryChild(childRunId, optionalHostRef)
    useAgentTeamStore.getState().updateTask(child.taskId, {
      status: "pending",
      error: undefined,
      completedAt: undefined,
    })
    const { runSquadLifecycle, restoreSquadRunInput, guardSquadResume } =
      await import("./squad/squad-lifecycle-runner")
    const guard = await guardSquadResume(team.id, child.runId)
    if (guard.blocked) return
    const restored = await restoreSquadRunInput(team.id, child.runId)
    if (!restored) return
    await runSquadLifecycle({
      ...restored,
      taskFilter: (task) => task.id === child.taskId,
    })
  },
  shutdown: async (id) => {
    const { controlSquadTeam } = await import("./squad/squad-control")
    return controlSquadTeam(id, "stop")
  },
}

// Re-export for callers that want to plug in their own runtime deps
// programmatically (e.g. from a Tauri-aware app shell).
export type { LeadPlanResult, RunTeamLifecycleDeps }
export type { AgentTeamTask }
