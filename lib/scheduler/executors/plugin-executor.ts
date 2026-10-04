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

import type { ScheduledTask, TaskExecution, TaskExecutionLog } from "@/types/scheduler"
import { nanoid } from "nanoid"
import { loggers } from "@cognia/logging"
import { getPluginTaskHandler } from "@/lib/plugin/scheduler/scheduler-plugin-executor"
import { forgetExecutionProgress, reportTaskProgress } from "../execution-progress"
import { schedulerDb } from "../scheduler-db"
import {
  PLUGIN_TASK_HANDLER_LOG_KIND,
  PLUGIN_TASK_METRICS_LOG_KIND,
  type PluginTaskContext,
} from "@/types/plugin/plugin-scheduler"

const log = loggers.scheduler

export interface PluginTaskPayload {
  pluginId: string
  handler: string
  args?: Record<string, unknown>
  /** Set by the scheduler on an event fire (`triggerEventTask` / `fireEventTasks`). */
  event?: { type?: unknown; source?: unknown; data?: unknown }
}

/**
 * Handler log lines kept per execution. A handler that logs every row of a
 * large job must not grow the execution record without bound; past the cap
 * the oldest HANDLER lines are dropped, and the scheduler's own lines are
 * never touched.
 */
export const MAX_HANDLER_LOGS = 200

/** Minimum gap between two mid-run writes of an execution's handler logs. */
export const HANDLER_LOG_PERSIST_INTERVAL_MS = 500

/**
 * A handler's `data` is persisted inside the execution row, so it has to
 * survive serialization. Anything that does not (a function, a cycle, a
 * BigInt) is replaced by a marker rather than failing the write or the run.
 */
function toPersistableLogData(
  data: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (data === undefined) return undefined
  try {
    return JSON.parse(JSON.stringify(data)) as Record<string, unknown>
  } catch {
    return { unserializable: true }
  }
}

/** The event envelope the scheduler merged into the payload, when it is well formed. */
function readEventEnvelope(payload: PluginTaskPayload): PluginTaskContext["event"] {
  const event = payload.event
  if (!event || typeof event !== "object" || typeof event.type !== "string") return undefined
  return {
    type: event.type,
    ...(typeof event.source === "string" ? { source: event.source } : {}),
    ...(event.data && typeof event.data === "object" && !Array.isArray(event.data)
      ? { data: event.data as Record<string, unknown> }
      : {}),
  }
}

/**
 * Collects a handler's `ctx.log` lines onto the execution the scheduler owns.
 *
 * The scheduler persists `execution.logs` when the run settles, so appending
 * here is what puts the lines in `getExecutions()` and the run sheet. A
 * trailing, coalesced write also lands them while the run is still going, so
 * a long run's log is readable before it ends. `dispose` cancels a pending
 * write before the scheduler's own terminal write, which must be the last one.
 */
function createHandlerLogSink(execution: TaskExecution) {
  const handlerEntryIds: string[] = []
  let pendingWrite: ReturnType<typeof setTimeout> | null = null
  let lastWriteAt = 0

  const persist = () => {
    lastWriteAt = Date.now()
    void schedulerDb.updateExecution(execution).catch((error: unknown) => {
      log.debug("Failed to persist plugin handler logs", { executionId: execution.id, error })
    })
  }

  return {
    append(entry: Omit<TaskExecutionLog, "id" | "timestamp">): void {
      const row: TaskExecutionLog = { id: nanoid(), timestamp: new Date(), ...entry }
      execution.logs.push(row)
      handlerEntryIds.push(row.id)
      while (handlerEntryIds.length > MAX_HANDLER_LOGS) {
        const dropId = handlerEntryIds.shift()
        const index = execution.logs.findIndex((candidate) => candidate.id === dropId)
        if (index >= 0) execution.logs.splice(index, 1)
      }
      const sinceLast = Date.now() - lastWriteAt
      if (sinceLast >= HANDLER_LOG_PERSIST_INTERVAL_MS) {
        persist()
      } else if (!pendingWrite) {
        pendingWrite = setTimeout(() => {
          pendingWrite = null
          persist()
        }, HANDLER_LOG_PERSIST_INTERVAL_MS - sinceLast)
      }
    },
    dispose(): void {
      if (pendingWrite) clearTimeout(pendingWrite)
      pendingWrite = null
    },
  }
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

  const sink = createHandlerLogSink(execution)
  const event = readEventEnvelope(payload)

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
      ...(execution.triggerSource ? { triggerSource: execution.triggerSource } : {}),
      ...(event ? { event } : {}),
      signal: controller.signal,
      reportProgress: (progress, message) => {
        // Recorded on the execution row and, when the task opted into
        // `notification.onProgress`, raised through the notification center.
        // `reportTaskProgress` owns the write coalescing and the notification
        // rate limit; a report never fails the run.
        reportTaskProgress(task, execution, { progress, message })
      },
      log: (level, message, data) => {
        // Mirrored to the host logger, where it always went, and recorded on
        // the execution, where a plugin reading its own run history expects
        // to find it. Before, only the first half happened, so `getExecutions()`
        // never contained a single line the handler wrote.
        const fn = log[level] ?? log.info
        fn.call(log, message, { pluginId: payload.pluginId, executionId: execution.id, ...data })
        const persistable = toPersistableLogData(data)
        sink.append({
          level,
          message: String(message),
          data: {
            kind: PLUGIN_TASK_HANDLER_LOG_KIND,
            ...(persistable !== undefined ? { data: persistable } : {}),
          },
        })
      },
    }

    const result = await handler(payload.args ?? {}, ctx)
    if (result?.metrics && typeof result.metrics === "object") {
      // The execution row has no column for metrics; a tagged log entry keeps
      // them with the run, and the plugin API reads them back from it.
      sink.append({
        level: "info",
        message: "Handler metrics",
        data: {
          kind: PLUGIN_TASK_METRICS_LOG_KIND,
          metrics: toPersistableLogData(result.metrics as Record<string, unknown>) ?? {},
        },
      })
    }
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
    forgetExecutionProgress(execution.id)
    sink.dispose()
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
