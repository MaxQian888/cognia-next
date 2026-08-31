/**
 * Scheduled-Task Bridge.
 *
 * Resolves `manifest.scheduledTasks[]` contributions on plugin enable. Each
 * def declares a `handler` name + a `trigger`. The bridge:
 *   1. Records the def in `scheduled-task-registry.ts` (count/diagnostics).
 *   2. Creates a real, firing `ScheduledTask` row (type `"plugin"`) in the
 *      scheduler's Dexie store, with `payload = { pluginId, handler }` so the
 *      plugin executor (`lib/scheduler/executors/plugin-executor.ts`) can
 *      resolve the registered handler (`${pluginId}:${handler}`) at fire time.
 *
 * Idempotent across restarts: before creating, the bridge checks for an
 * existing plugin task matching `(pluginId, name, handler)` so the manager's
 * boot-time re-enable doesn't duplicate rows the scheduler already persisted.
 * On disable, every `"plugin"` task owned by the plugin is deleted (matching
 * the contribution model — a disabled plugin's tasks disappear).
 *
 * The scheduler is injected (defaults to the live `getTaskScheduler()`) so the
 * bridge stays unit-testable without the Dexie/timer machinery.
 *
 * See ADR-0026 (plugin extension-point expansion).
 */

import type { PluginManifest } from "@/types/plugin/plugin"
import type {
  CreateScheduledTaskInput,
  ScheduledTask,
  UpdateScheduledTaskInput,
} from "@/types/scheduler"
import { toTaskTrigger } from "@cognia/plugin-sdk/api/scheduled-task"

export { toTaskTrigger } from "@cognia/plugin-sdk/api/scheduled-task"
import { loggers } from "@/lib/plugin/core/logger"
import {
  registerScheduledTaskDefsForPlugin,
  unregisterScheduledTaskDefsByPlugin,
} from "@/lib/plugin/scheduler/scheduled-task-registry"

/** The slice of the task scheduler the bridge needs. `getTaskScheduler()` satisfies it. */
export interface ScheduledTaskSchedulerPort {
  getAllTasks(): Promise<ScheduledTask[]>
  createTask(input: CreateScheduledTaskInput): Promise<ScheduledTask>
  updateTask(taskId: string, input: UpdateScheduledTaskInput): Promise<ScheduledTask | null>
  deleteTask(taskId: string): Promise<boolean>
  pauseTask(taskId: string): Promise<boolean>
}

export interface ScheduledTaskBridgeOptions {
  scheduler?: ScheduledTaskSchedulerPort
}

export interface ScheduledTaskBridgeResult {
  /** Tasks newly created this call. */
  created: number
  /** Defs skipped because an equivalent task already existed. */
  skipped: number
  /** Existing tasks whose manifest trigger changed and were re-armed. */
  updated: number
  errors: Array<{ pluginId: string; taskName: string; message: string }>
}

const PLUGIN_TASK_TAG = (pluginId: string): string => `plugin:${pluginId}`

interface PluginTaskPayload {
  pluginId: string
  handler: string
}

async function getScheduler(
  options: ScheduledTaskBridgeOptions
): Promise<ScheduledTaskSchedulerPort> {
  if (options.scheduler) return options.scheduler
  const { getTaskScheduler } = await import("@/lib/scheduler/task-scheduler")
  return getTaskScheduler()
}

function isPluginTaskFor(task: ScheduledTask, pluginId: string): boolean {
  if (task.type !== "plugin") return false
  const payload = task.payload as unknown as Partial<PluginTaskPayload> | undefined
  return payload?.pluginId === pluginId
}

/**
 * Create scheduler tasks for every `manifest.scheduledTasks[]` def, idempotently.
 */
export async function registerScheduledTasksForPlugin(
  manifest: PluginManifest,
  options: ScheduledTaskBridgeOptions = {}
): Promise<ScheduledTaskBridgeResult> {
  const pluginId = manifest.id
  const defs = manifest.scheduledTasks ?? []
  const result: ScheduledTaskBridgeResult = { created: 0, skipped: 0, updated: 0, errors: [] }

  // Always record the defs (count/diagnostics) even if scheduling fails.
  registerScheduledTaskDefsForPlugin(pluginId, defs)
  if (defs.length === 0) return result

  const scheduler = await getScheduler(options)
  const existing = await scheduler.getAllTasks()
  const ownExisting = existing.filter((t) => isPluginTaskFor(t, pluginId))

  for (const def of defs) {
    try {
      const existingTask = ownExisting.find((t) => {
        const payload = t.payload as unknown as Partial<PluginTaskPayload> | undefined
        return t.name === def.name && payload?.handler === def.handler
      })
      if (existingTask) {
        const trigger = toTaskTrigger(def)
        if (JSON.stringify(existingTask.trigger) === JSON.stringify(trigger)) {
          result.skipped += 1
        } else {
          await scheduler.updateTask(existingTask.id, { trigger })
          result.updated += 1
        }
        continue
      }
      const input: CreateScheduledTaskInput = {
        name: def.name,
        description: def.description,
        type: "plugin",
        trigger: toTaskTrigger(def),
        payload: { pluginId, handler: def.handler } satisfies PluginTaskPayload,
        tags: [PLUGIN_TASK_TAG(pluginId), ...(def.tags ?? [])],
        ...(def.timeout ? { config: { timeout: def.timeout * 1000 } } : {}),
      }
      const task = await scheduler.createTask(input)
      // Honour `defaultEnabled: false` by parking the freshly-created task.
      if (def.defaultEnabled === false) {
        await scheduler.pauseTask(task.id)
      }
      result.created += 1
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      result.errors.push({ pluginId, taskName: def.name, message })
      loggers.manager.error(`[scheduled-task-bridge] failed to create ${pluginId}:${def.name}`, err)
    }
  }

  return result
}

/**
 * Plugin-disable hook — drop the def registry entries AND delete every
 * `"plugin"` scheduler task this plugin created.
 */
export async function unregisterScheduledTasksForPlugin(
  pluginId: string,
  options: ScheduledTaskBridgeOptions = {}
): Promise<number> {
  unregisterScheduledTaskDefsByPlugin(pluginId)
  const scheduler = await getScheduler(options)
  let deleted = 0
  try {
    const all = await scheduler.getAllTasks()
    for (const task of all) {
      if (isPluginTaskFor(task, pluginId)) {
        const ok = await scheduler.deleteTask(task.id)
        if (ok) deleted += 1
      }
    }
  } catch (err) {
    loggers.manager.error(`[scheduled-task-bridge] failed to delete tasks for ${pluginId}`, err)
  }
  return deleted
}
