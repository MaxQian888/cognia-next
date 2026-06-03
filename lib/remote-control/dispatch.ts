/**
 * Remote command dispatch registry (renderer side).
 *
 * The Rust inbound server authenticates + emits a generic
 * `remote-control://command` event; this module routes it to each subsystem's
 * existing headless run entry. Every handler is fire-and-forget: it kicks the
 * run off and returns synchronously with the server-supplied runId so the
 * inbound HTTP caller's 202 stays fast.
 *
 * Rust cannot execute Goals / Workflows / Team / Plan directly (that logic
 * lives here in the renderer), which is exactly why the routing layer is in TS.
 */

import type { RemoteCommand, RemoteCommandResult } from "@/types/remote-control"
import { loggers } from "@/lib/logging"

const log = loggers.scheduler

function reject(runId: string, detail: string): RemoteCommandResult {
  return { runId, status: "rejected", detail }
}
function accept(runId: string, detail?: string): RemoteCommandResult {
  return { runId, status: "accepted", detail }
}

/** Read a required non-empty string arg, or null. */
function str(args: Record<string, unknown>, key: string): string | null {
  const v = args[key]
  return typeof v === "string" && v.length > 0 ? v : null
}

export async function dispatchRemoteCommand(command: RemoteCommand): Promise<RemoteCommandResult> {
  const { target, args, runId } = command
  try {
    switch (target) {
      case "scheduler.task.run": {
        const taskId = str(args, "taskId")
        if (!taskId) return reject(runId, "taskId required")
        const { useSchedulerStore } = await import("@/stores/scheduler/scheduler-store")
        void useSchedulerStore.getState().runTaskNow(taskId, { triggerSource: "remote" })
        return accept(runId, `task ${taskId}`)
      }
      case "scheduler.event": {
        const eventType = str(args, "eventType")
        if (!eventType) return reject(runId, "eventType required")
        const { emitSchedulerEvent } = await import("@/lib/scheduler/event-integration")
        void emitSchedulerEvent(
          eventType as never,
          (args.data as Record<string, unknown>) ?? {},
          str(args, "eventSource") ?? undefined
        )
        return accept(runId, eventType)
      }
      case "workflow.run": {
        const workflowId = str(args, "workflowId")
        if (!workflowId) return reject(runId, "workflowId required")
        const { startWorkflowFromRemote } = await import("@/lib/workflow/runtime/start-from-remote")
        const r = await startWorkflowFromRemote({
          workflowId,
          runParams: (args.runParams as Record<string, unknown>) ?? {},
          runId,
        })
        return r.ok ? accept(runId, `workflow ${workflowId}`) : reject(runId, r.reason)
      }
      case "team.dispatch": {
        const teamId = str(args, "teamId")
        if (!teamId) return reject(runId, "teamId required")
        const { agentTeamManager } = await import("@/lib/ai/agent/agent-team")
        // Fire-and-forget: agentTeamManager.start awaits the full run, so we
        // intentionally do NOT await it here (the dispatchAgentTeam wrapper
        // would block the inbound 202 for the entire run).
        void agentTeamManager.start(teamId)
        return accept(runId, `team ${teamId}`)
      }
      case "plan.run": {
        const planId = str(args, "planId")
        if (!planId) return reject(runId, "planId required")
        const { getPlanRuntime } = await import("@/lib/agent/plan/runtime")
        void getPlanRuntime().runPlan(planId)
        return accept(runId, `plan ${planId}`)
      }
      case "goal.continue": {
        const goalId = str(args, "goalId")
        if (!goalId) return reject(runId, "goalId required")
        const { getGoalRuntime } = await import("@/lib/goal/runtime")
        getGoalRuntime().requestManualContinue(goalId)
        return accept(runId, `goal ${goalId}`)
      }
      case "goal.create": {
        const rawObjective = str(args, "rawObjective")
        const sessionId = str(args, "sessionId")
        if (!rawObjective) return reject(runId, "rawObjective required")
        // v1 keeps goal.create honest: the remote caller must name a
        // background session it owns. "Mint a fresh session" is intentionally
        // out of scope (YAGNI) — add a session-mint step here if product wants it.
        if (!sessionId) return reject(runId, "sessionId required")
        const { getGoalRuntime } = await import("@/lib/goal/runtime")
        void getGoalRuntime().createGoal({ sessionId, rawObjective })
        return accept(runId, "goal created")
      }
      default:
        return reject(runId, `unknown target: ${String(target)}`)
    }
  } catch (error) {
    log.error("remote command dispatch failed", error as Error)
    return reject(runId, error instanceof Error ? error.message : String(error))
  }
}
