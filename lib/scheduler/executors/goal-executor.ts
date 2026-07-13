/**
 * `goal` scheduled-task executor.
 *
 * Creates a self-driving `/goal` (ADR-0019) in a fresh background session (or
 * a supplied one) and drives its turn loop to terminal headlessly via
 * `runGoalLoopHeadless`. Requires the Tauri runtime — the loop drives real
 * model turns through the sidecar.
 */

import type { AppSettings } from "@cognia/agent-config-types"
import type { GoalTaskPayload, ScheduledTask, TaskExecution } from "@/types/scheduler"
import { isTauri } from "@/lib/tauri"
import { loggers } from "@cognia/logging"

const log = loggers.scheduler

interface GoalExecutionResult {
  success: boolean
  output?: Record<string, unknown>
  error?: string
}

export async function executeGoalTask(
  task: ScheduledTask,
  execution: TaskExecution,
  signal: AbortSignal
): Promise<GoalExecutionResult> {
  if (!isTauri()) {
    return { success: false, error: "Goal scheduled tasks require the Tauri runtime" }
  }

  const payload = (task.payload ?? {}) as Partial<GoalTaskPayload>
  if (!payload.objective || !payload.objective.trim()) {
    return { success: false, error: "goal task requires `objective` in payload" }
  }
  if (signal?.aborted) {
    return { success: false, error: "Goal task aborted before start" }
  }

  // Lazy import keeps the heavy goal/runtime + db chains out of the scheduler
  // executor module graph at load time (and out of test hoisting order).
  const [
    { createSession, getSession },
    { getSettings },
    { getGoalRuntime },
    { runGoalLoopHeadless },
  ] = await Promise.all([
    import("@/lib/db/sessions"),
    import("@/lib/db/settings"),
    import("@/lib/goal/runtime"),
    import("./goal-headless-runner"),
  ])

  let appSettings: AppSettings | null = null
  try {
    appSettings = await getSettings()
  } catch (err) {
    log.warn("Scheduler goal task: getSettings failed; continuing with no app defaults", {
      err: String(err),
    })
  }

  // 1. Resolve / create the background session.
  let sessionId: string
  if (payload.sessionId) {
    const existing = await getSession(payload.sessionId)
    if (!existing) return { success: false, error: `Session not found: ${payload.sessionId}` }
    sessionId = existing.id
  } else {
    const session = await createSession({
      title: payload.sessionTitle ?? `${task.name} (scheduled goal)`,
      kind: "direct",
      characterId: payload.characterId,
    })
    sessionId = session.id
  }

  // 2. Create the goal row (redacts the objective, persists, logs).
  let goalId: string
  try {
    const goal = await getGoalRuntime().createGoal({
      sessionId,
      characterId: payload.characterId,
      rawObjective: payload.objective,
      config: payload.config,
      appSettings,
    })
    goalId = goal.id
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }

  log.info("Scheduler goal task → headless loop", {
    taskId: task.id,
    executionId: execution.id,
    sessionId,
    goalId,
  })

  // 3. Drive the loop to terminal.
  const result = await runGoalLoopHeadless({ sessionId, goalId, appSettings, signal })

  const success = result.status === "completed"
  return {
    success,
    output: {
      goalId,
      sessionId,
      status: result.status,
      turns: result.turns,
      lastResponse: result.lastResponse,
    },
    ...(success ? {} : { error: result.error ?? `Goal ended with status: ${result.status}` }),
  }
}
