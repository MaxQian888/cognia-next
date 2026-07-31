/**
 * Plugin task executor (§B-2 activation).
 *
 * Cognia's plugin runtime resolves a registered task handler keyed on
 * `${pluginId}:${handler}`. Phase 2 ports the handler registry from Cognia
 * (`lib/plugin/scheduler/scheduler-plugin-executor.ts`) — this executor now
 * delegates to that registry rather than short-circuiting with "not wired
 * up". When no plugin has registered a matching handler, the executor still
 * returns a clean failure so the scheduler can mark the task as failed and
 * surface the diagnostic to the user.
 *
 * The signature, payload type, and cancellation helpers are intentionally
 * unchanged — `lib/scheduler/task-scheduler.ts:registerTaskExecutor("plugin", …)`
 * call sites continue to work without edits.
 */

import type { ScheduledTask, TaskExecution } from "@/types/scheduler"
import { loggers } from "@cognia/logging"
import { getPluginTaskHandler } from "@/lib/plugin/scheduler/scheduler-plugin-executor"
import type { PluginTaskContext } from "@/types/plugin/plugin-scheduler"

const log = loggers.scheduler

export interface PluginTaskPayload {
  pluginId: string
  handler: string
  args?: Record<string, unknown>
}

const activeExecutions = new Map<string, AbortController>()

export async function executePluginTask(
  task: ScheduledTask,
  execution: TaskExecution,
  signal: AbortSignal
): Promise<{ success: boolean; output?: Record<string, unknown>; error?: string }> {
  const payload = task.payload as unknown as PluginTaskPayload | undefined
  if (!payload?.pluginId || !payload.handler) {
    return { success: false, error: "Plugin task payload missing pluginId/handler" }
  }

  const fullName = `${payload.pluginId}:${payload.handler}`
  const handler = getPluginTaskHandler(fullName)
  if (!handler) {
    log.warn("Plugin scheduled task triggered, but no handler is registered", {
      taskId: task.id,
      executionId: execution.id,
      handler: fullName,
    })
    return {
      success: false,
      error: `Plugin task handler not registered: ${fullName}. The contributing plugin may be disabled or uninstalled.`,
    }
  }

  // Wire cancellation through `cancelPluginTaskExecution(executionId)`.
  const controller = new AbortController()
  activeExecutions.set(execution.id, controller)

  let forwardAbort: (() => void) | undefined
  if (signal) {
    if (signal.aborted) {
      controller.abort()
    } else {
      forwardAbort = () => controller.abort()
      signal.addEventListener("abort", forwardAbort, { once: true })
    }
  }

  try {
    const startedAt = new Date()
    const ctx: PluginTaskContext = {
      taskId: task.id,
      executionId: execution.id,
      pluginId: payload.pluginId,
      taskName: task.name,
      scheduledAt: execution.scheduledFor ?? startedAt,
      startedAt,
      attemptNumber: (execution.retryAttempt ?? 0) + 1,
      signal: controller.signal,
      reportProgress: (progress, message) => {
        // Progress is purely advisory at this layer; the scheduler doesn't
        // record per-task progress yet, so we log it for diagnostics.
        log.debug("Plugin task progress", {
          executionId: execution.id,
          progress,
          message,
        })
      },
      log: (level, message, data) => {
        const fn = log[level] ?? log.info
        fn.call(log, message, data)
      },
    }

    const result = await handler(payload.args ?? {}, ctx)
    return {
      success: result.success,
      output: result.output,
      error: result.error,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error("Plugin task handler threw", {
      taskId: task.id,
      executionId: execution.id,
      handler: fullName,
      error: message,
    })
    return { success: false, error: message }
  } finally {
    if (forwardAbort && signal) {
      signal.removeEventListener("abort", forwardAbort)
    }
    activeExecutions.delete(execution.id)
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
