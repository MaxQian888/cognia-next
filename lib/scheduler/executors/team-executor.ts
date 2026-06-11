/**
 * `agent-team` scheduled-task executor.
 *
 * Runs a whole Agent Team to terminal via `agentTeamManager.start` (ADR-0022),
 * which synthesizes the team's tasks into a workflow and drives it through the
 * orchestrator. `start()` awaits the full run, so we simply await it and read
 * the team's terminal status from the store.
 *
 * Abort wiring: `start()` takes no signal — the runtime exposes `abortTeam`,
 * which fires the in-flight controller. We forward the task signal (timeout /
 * overlap-cancel) to it.
 *
 * Persistence: team DEFINITIONS (teams/teammates/tasks) survive an app restart
 * as of persist v4 (Scheduler Phase D), so a scheduled team re-instantiates and
 * runs after relaunch. A team that was never created (or was deleted) still
 * fails cleanly with a "team not found" error. Live runtime ephemera
 * (messages/events/consensus) are not persisted — run history lives in Dexie
 * `workflowRuns` (workflowId `__team__:<teamId>:<nonce>`).
 */

import type { AgentTeamTaskPayload, ScheduledTask, TaskExecution } from "@/types/scheduler"
import { loggers } from "@/lib/logging"

const log = loggers.scheduler

interface TeamExecutionResult {
  success: boolean
  output?: Record<string, unknown>
  error?: string
}

export async function executeAgentTeamTask(
  task: ScheduledTask,
  execution: TaskExecution,
  signal: AbortSignal
): Promise<TeamExecutionResult> {
  const payload = (task.payload ?? {}) as Partial<AgentTeamTaskPayload>
  if (!payload.teamId || !payload.teamId.trim()) {
    return { success: false, error: "agent-team task requires `teamId` in payload" }
  }

  // Lazy import keeps the heavy agent-team runtime chain out of the scheduler
  // executor module graph at load time (and out of test hoisting order).
  const [{ agentTeamManager }, { abortTeam }] = await Promise.all([
    import("@/lib/ai/agent/agent-team"),
    import("@/lib/ai/agent/agent-team-runtime"),
  ])

  const team = agentTeamManager.get(payload.teamId)
  if (!team) {
    return {
      success: false,
      error: `team not found: ${payload.teamId} (define or persist the team before scheduling it)`,
    }
  }

  if (signal?.aborted) {
    return { success: false, error: "Agent-team task aborted before start" }
  }

  const onAbort = () => {
    abortTeam(payload.teamId as string, new Error("scheduler timeout/cancel"))
  }
  signal.addEventListener("abort", onAbort, { once: true })

  log.info("Scheduler agent-team task → agentTeamManager.start", {
    taskId: task.id,
    executionId: execution.id,
    teamId: payload.teamId,
    ultracode: payload.ultracode,
  })

  try {
    await agentTeamManager.start(
      payload.teamId,
      typeof payload.ultracode === "boolean" ? { ultracode: payload.ultracode } : undefined
    )
    const status = agentTeamManager.get(payload.teamId)?.status
    const success = status === "completed"
    return {
      success,
      output: { teamId: payload.teamId, status },
      ...(success ? {} : { error: `Team ended with status: ${status ?? "unknown"}` }),
    }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    signal.removeEventListener("abort", onAbort)
  }
}
