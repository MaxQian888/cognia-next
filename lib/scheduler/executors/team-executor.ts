/**
 * Runs a scheduled Agent Team through the canonical durable lifecycle.
 * Each scheduler execution keeps a stable run ID and forwards cancellation to
 * that exact run. Completion reads the durable run record, since the mutable
 * team definition can already reflect a newer execution.
 */

import type {
  AgentTeamTaskPayload,
  ScheduledTask,
  TaskExecution,
  TaskExecutorResult,
} from "@/types/scheduler"
import { assertTaskTypeSupportedOnHost } from "../host-support"
import { loggers } from "@cognia/logging"

const log = loggers.scheduler

type TeamExecutionResult = TaskExecutorResult

export async function executeAgentTeamTask(
  task: ScheduledTask,
  execution: TaskExecution,
  signal: AbortSignal
): Promise<TeamExecutionResult> {
  // Host gate: every teammate turn goes through the sidecar. A browser-only
  // shell has none, so refuse with the structured reason rather than letting
  // the team runtime fail turn by turn.
  const refused = assertTaskTypeSupportedOnHost(task.type)
  if (refused) return refused

  const payload = (task.payload ?? {}) as Partial<AgentTeamTaskPayload>
  if (!payload.teamId || !payload.teamId.trim()) {
    return { success: false, error: "agent-team task requires `teamId` in payload" }
  }

  // Lazy import keeps the heavy agent-team runtime chain out of the scheduler
  // executor module graph at load time (and out of test hoisting order).
  const { agentTeamManager } = await import("@/lib/ai/agent/agent-team")

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

  log.info("Scheduler agent-team task → agentTeamManager.start", {
    taskId: task.id,
    executionId: execution.id,
    teamId: payload.teamId,
    ultracode: payload.ultracode,
  })

  try {
    const result = await agentTeamManager.start(payload.teamId, {
      origin: "scheduler",
      runId: `run_team_scheduled_${execution.id}`,
      signal,
      ...(typeof payload.ultracode === "boolean" ? { ultracode: payload.ultracode } : {}),
    })
    const { getExecutionRun } = await import("@/lib/db/execution-runs")
    const run = result.executionRunId ? await getExecutionRun(result.executionRunId) : undefined
    const status = run?.status
    const success = status === "completed"
    return {
      success,
      output: {
        teamId: payload.teamId,
        runId: result.runId,
        executionRunId: result.executionRunId,
        status,
      },
      ...(success ? {} : { error: `Team ended with status: ${status ?? "unknown"}` }),
    }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}
