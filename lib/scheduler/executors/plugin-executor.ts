/**
 * Plugin task executor stub.
 *
 * Cognia's plugin runtime resolves a registered task handler keyed on
 * `${pluginId}:${handler}`. cognia-next has no plugin runtime yet (see
 * `lib/plugin/index.ts`), so this executor short-circuits with a clean
 * "handler not registered" failure. The signature matches the scheduler
 * `TaskExecutor` contract so the registry call site stays unchanged once a
 * real plugin runtime lands.
 */

import type { ScheduledTask, TaskExecution } from "@/types/scheduler"
import { loggers } from "@/lib/logger"

const log = loggers.scheduler

export interface PluginTaskPayload {
  pluginId: string
  handler: string
  args?: Record<string, unknown>
}

const activeExecutions = new Map<string, AbortController>()

export async function executePluginTask(
  task: ScheduledTask,
  execution: TaskExecution
): Promise<{ success: boolean; output?: Record<string, unknown>; error?: string }> {
  const payload = task.payload as unknown as PluginTaskPayload | undefined
  if (!payload?.pluginId || !payload.handler) {
    return { success: false, error: "Plugin task payload missing pluginId/handler" }
  }

  const fullName = `${payload.pluginId}:${payload.handler}`
  log.warn("Plugin scheduled task triggered, but no plugin runtime is wired up", {
    taskId: task.id,
    executionId: execution.id,
    handler: fullName,
  })

  return {
    success: false,
    error: `Plugin task handler not found: ${fullName}. cognia-next does not ship a plugin runtime yet.`,
  }
}

export function cancelPluginTaskExecution(executionId: string): boolean {
  const controller = activeExecutions.get(executionId)
  if (!controller) return false
  controller.abort()
  activeExecutions.delete(executionId)
  return true
}

export function getActivePluginTaskCount(): number {
  return activeExecutions.size
}

export function isPluginTaskExecutionActive(executionId: string): boolean {
  return activeExecutions.has(executionId)
}
