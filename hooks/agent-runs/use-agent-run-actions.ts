"use client"

/**
 * Per-kind lifecycle actions for the Agent Runs panel (Scheduler Phase D).
 *
 * Routes abort / pause / resume to the right runtime for each `AgentRun` kind:
 *  - goal → `getGoalRuntime().stopGoal / pauseGoal / resumeGoal`
 *  - plan → `getPlanRuntime().cancelPlan / pausePlan / resumePlan`
 *  - team → `abortTeam` (abort) / `agentTeamManager.pause` (pause)
 *  - scheduled-task → not controllable from this panel (managed in /scheduler)
 *
 * Heavy runtimes are lazy-imported inside each method so the hook stays cheap to
 * mount. Capability predicates gate the buttons so the UI only offers an action
 * the run + runtime can actually take.
 */

import { useMemo } from "react"
import type { AgentRun } from "@/types/agent-runs/agent-run"

export interface AgentRunActions {
  canAbort(run: AgentRun): boolean
  canPause(run: AgentRun): boolean
  canResume(run: AgentRun): boolean
  abort(run: AgentRun): Promise<void>
  pause(run: AgentRun): Promise<void>
  resume(run: AgentRun): Promise<void>
}

const CONTROLLABLE: ReadonlySet<AgentRun["kind"]> = new Set(["goal", "plan", "team"])

export function useAgentRunActions(): AgentRunActions {
  return useMemo<AgentRunActions>(() => {
    return {
      canAbort: (run) => run.isLive && CONTROLLABLE.has(run.kind),
      canPause: (run) => run.status === "running" && CONTROLLABLE.has(run.kind),
      // Teams have no true resume (paused teams are aborted + re-run), so only
      // goal / plan offer resume.
      canResume: (run) => run.status === "paused" && (run.kind === "goal" || run.kind === "plan"),

      async abort(run) {
        switch (run.kind) {
          case "goal": {
            const id = run.origin.goalId ?? run.origin.nativeId
            const { getGoalRuntime } = await import("@/lib/goal/runtime")
            await getGoalRuntime().stopGoal(id)
            return
          }
          case "plan": {
            const id = run.origin.planId ?? run.origin.nativeId
            const { getPlanRuntime } = await import("@/lib/agent/plan/runtime")
            await getPlanRuntime().cancelPlan(id)
            return
          }
          case "team": {
            const id = run.origin.teamId
            if (!id) return
            const { abortTeam } = await import("@/lib/ai/agent/agent-team-runtime")
            abortTeam(id, "aborted from agent-runs panel")
            return
          }
          default:
            return
        }
      },

      async pause(run) {
        switch (run.kind) {
          case "goal": {
            const id = run.origin.goalId ?? run.origin.nativeId
            const { getGoalRuntime } = await import("@/lib/goal/runtime")
            await getGoalRuntime().pauseGoal(id)
            return
          }
          case "plan": {
            const id = run.origin.planId ?? run.origin.nativeId
            const { getPlanRuntime } = await import("@/lib/agent/plan/runtime")
            await getPlanRuntime().pausePlan(id)
            return
          }
          case "team": {
            const id = run.origin.teamId
            if (!id) return
            const { agentTeamManager } = await import("@/lib/ai/agent/agent-team")
            await agentTeamManager.pause(id)
            return
          }
          default:
            return
        }
      },

      async resume(run) {
        switch (run.kind) {
          case "goal": {
            const id = run.origin.goalId ?? run.origin.nativeId
            const { getGoalRuntime } = await import("@/lib/goal/runtime")
            await getGoalRuntime().resumeGoal(id)
            return
          }
          case "plan": {
            const id = run.origin.planId ?? run.origin.nativeId
            const { getPlanRuntime } = await import("@/lib/agent/plan/runtime")
            await getPlanRuntime().resumePlan(id)
            return
          }
          default:
            return
        }
      },
    }
  }, [])
}
