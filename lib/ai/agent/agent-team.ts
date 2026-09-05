/**
 * `agentTeamManager`: the team-addressed facade over the Squad execution chain.
 *
 * `list/get/create/update/delete` proxy the store's definition CRUD. Every
 * runtime verb is a thin adapter onto the two seams ADR-0168 leaves:
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
import type { AgentTeam, AgentTeamTask } from "@/types/agent/agent-team"
import type { LeadPlanResult, RunTeamLifecycleDeps } from "./agent-team-runtime"
import type { TeamRunOrigin } from "./team/gate-policy"
import type { StartSquadRunResult } from "./team/start-squad-run"
import type { SquadControlResult } from "./team/squad-control"

export {
  configureAgentTeamRuntime,
  __resetAgentTeamRuntimeForTesting,
} from "./team/squad-lifecycle-runner"

export type AgentTeamConfig = AgentTeam

export interface AgentTeamStartOptions {
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
  delete(id: string): void
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
export async function recoverDurableAgentTeams(): Promise<
  Array<{ runId: string; status: "recovering" | "needs_input" }>
> {
  const [{ getDurableTeamCoordinator }, { getAgentTeamRun }] = await Promise.all([
    import("./team/durable-runtime"),
    import("@/lib/db/agent-team-runtime"),
  ])
  const outcomes = await getDurableTeamCoordinator().recover()
  await Promise.all(
    outcomes.map(async (outcome) => {
      const run = await getAgentTeamRun(outcome.runId)
      if (!run) return
      const team = useAgentTeamStore.getState().getTeam(run.teamId)
      if (!team) return
      if (outcome.status === "needs_input") {
        useAgentTeamStore.getState().setTeamStatus(team.id, "paused")
        return
      }
      const { prepareSquadResume, resumeTaskFilter, runSquadLifecycle } =
        await import("./team/squad-lifecycle-runner")
      await prepareSquadResume(team.id)
      await runSquadLifecycle({
        teamId: team.id,
        runId: outcome.runId,
        taskFilter: resumeTaskFilter,
      })
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
  delete: (id) => {
    useAgentTeamStore.getState().deleteTeam(id)
  },
  start: async (id, opts) => {
    const { startSquadRun } = await import("./team/start-squad-run")
    const origin = opts?.origin ?? "interactive"
    const result = await startSquadRun({
      squadId: id,
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
    if (opts?.detached || !result.executionRunId || result.duplicate) return result
    const { awaitSquadRunSettlement } = await import("./team/watch-squad-run")
    await awaitSquadRunSettlement(result.executionRunId)
    return result
  },
  pause: async (id) => {
    const { controlSquadTeam } = await import("./team/squad-control")
    return controlSquadTeam(id, "pause")
  },
  resume: async (id) => {
    const { controlSquadTeam } = await import("./team/squad-control")
    return controlSquadTeam(id, "resume")
  },
  retryChild: async (childRunId, optionalHostRef) => {
    const [{ getDurableTeamCoordinator }, { getAgentTeamChildRun }] = await Promise.all([
      import("./team/durable-runtime"),
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
    const { runSquadLifecycle } = await import("./team/squad-lifecycle-runner")
    await runSquadLifecycle({
      teamId: team.id,
      runId: child.runId,
      taskFilter: (task) => task.id === child.taskId,
    })
  },
  shutdown: async (id) => {
    const { controlSquadTeam } = await import("./team/squad-control")
    return controlSquadTeam(id, "stop")
  },
}

// Re-export for callers that want to plug in their own runtime deps
// programmatically (e.g. from a Tauri-aware app shell).
export type { LeadPlanResult, RunTeamLifecycleDeps }
export type { AgentTeamTask }
