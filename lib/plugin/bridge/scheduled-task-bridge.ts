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
 * A def whose trigger, timeout or retry changed since the row was written
 * re-arms that row instead of being skipped.
 *
 * Attribution: rows are created with `createdBy: { kind: "plugin", pluginId }`,
 * so the per-source quota counts them and `ctx.scheduler`'s ownership check can
 * read the owner off the row. They are deliberately NOT passed through the
 * write gate (`assertTaskWriteAllowed`). The user consented to these exact
 * tasks by installing and enabling a plugin whose manifest declares them, and
 * refusing one at the quota would leave the plugin half-registered with a
 * handler that never fires. They still occupy the plugin source's quota, so a
 * runtime `ctx.scheduler.createTask` is measured against them.
 *
 * On disable (and suspend, unload, uninstall: the manager tears every module
 * bridge down through the same hook) every `"plugin"` task owned by the
 * plugin is deleted, runtime-created ones included. That is the contribution
 * model: a plugin's tasks are only runnable while its handlers are
 * registered, and a handler-less task can only fail, raise an error toast and
 * eventually auto-pause. ADR-0079 makes plugin tasks ordinary scheduler rows
 * and says nothing about them outliving the plugin, so nothing here keeps a
 * row the plugin cannot serve. A plugin that creates tasks at runtime should
 * recreate them idempotently in `activate`.
 *
 * The scheduler is injected (defaults to the live `getTaskScheduler()`) so the
 * bridge stays unit-testable without the Dexie/timer machinery.
 *
 * See ADR-0026 (plugin extension-point expansion).
 */

import type { PluginManifest, PluginScheduledTaskDef } from "@/types/plugin/plugin"
import type {
  CreateScheduledTaskInput,
  ScheduledTask,
  TaskExecutionConfig,
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

/**
 * The execution config a def asks for, in the scheduler's units. Only the
 * fields the def sets: an omitted `timeout` or `retry` keeps the scheduler's
 * defaults, as it always has.
 */
function configForDef(def: PluginScheduledTaskDef): Partial<TaskExecutionConfig> {
  return {
    ...(def.timeout ? { timeout: def.timeout * 1000 } : {}),
    ...(def.retry
      ? {
          maxRetries: Math.max(0, Math.floor(def.retry.maxAttempts)),
          retryDelay: Math.max(0, def.retry.delaySeconds) * 1000,
        }
      : {}),
  }
}

/** Whether a stored config already matches every field the def sets. */
function configMatches(
  stored: TaskExecutionConfig | undefined,
  wanted: Partial<TaskExecutionConfig>
): boolean {
  return Object.entries(wanted).every(
    ([key, value]) => stored?.[key as keyof TaskExecutionConfig] === value
  )
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
        const config = configForDef(def)
        const triggerChanged = JSON.stringify(existingTask.trigger) !== JSON.stringify(trigger)
        const configChanged = !configMatches(existingTask.config, config)
        if (!triggerChanged && !configChanged) {
          result.skipped += 1
        } else {
          await scheduler.updateTask(existingTask.id, {
            ...(triggerChanged ? { trigger } : {}),
            ...(configChanged ? { config } : {}),
          })
          result.updated += 1
        }
        continue
      }
      const config = configForDef(def)
      const input: CreateScheduledTaskInput = {
        name: def.name,
        description: def.description,
        type: "plugin",
        trigger: toTaskTrigger(def),
        payload: { pluginId, handler: def.handler } satisfies PluginTaskPayload,
        tags: [PLUGIN_TASK_TAG(pluginId), ...(def.tags ?? [])],
        createdBy: { kind: "plugin", pluginId },
        ...(Object.keys(config).length > 0 ? { config } : {}),
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
