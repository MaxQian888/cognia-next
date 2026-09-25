/**
 * Plugin-facing view of the USER's scheduled tasks.
 *
 * `ctx.scheduler` (`PluginSchedulerAPI`) is a different thing: it owns tasks a
 * plugin creates for ITSELF, addressed by a plugin handler name. It cannot
 * reach the tasks a *user* owns — the `/scheduler` list, whose rows carry a
 * `ScheduledTaskType` (`chat` / `agent` / `skill` / `goal` / `plan` / …) rather
 * than a handler — and it does not expose the `SchedulerPermissionPolicy` that
 * decides whether an agent may create one at all.
 *
 * This module is that surface, published to authors as
 * `@cognia/plugin-sdk/api/scheduled-task`. The task functions are thin
 * pass-throughs to the renderer scheduler store, which owns the
 * scheduler-host binding; the policy is read through the write gate's own
 * loader (`lib/scheduler/write-authority.ts`), so neither is re-derived here.
 *
 * The store is imported lazily on purpose. A plugin that never touches the
 * scheduler should not drag the scheduler system into its module graph, and the
 * agent tool that does call these runs long after boot.
 */

import type {
  CreateScheduledTaskInput,
  ScheduledTask,
  SchedulerPermissionPolicy,
  TaskExecution,
  TaskExecutionTriggerSource,
} from "@/types/scheduler"

async function store() {
  const { useSchedulerStore } = await import("@/stores/scheduler/scheduler-store")
  return useSchedulerStore.getState()
}

export interface PluginUserSchedulerAPI {
  getPolicy(): Promise<SchedulerPermissionPolicy>
  listTasks(): Promise<ScheduledTask[]>
  createTask(input: CreateScheduledTaskInput): Promise<ScheduledTask | null>
  deleteTask(taskId: string): Promise<boolean>
  runTaskNow(
    taskId: string,
    options?: { triggerSource?: TaskExecutionTriggerSource }
  ): Promise<TaskExecution | null>
}

export function createUserSchedulerAPI(): PluginUserSchedulerAPI {
  return {
    getPolicy: getSchedulerPermissionPolicy,
    listTasks: listUserScheduledTasks,
    createTask: createUserScheduledTask,
    deleteTask: deleteUserScheduledTask,
    runTaskNow: runUserScheduledTaskNow,
  }
}

/**
 * The user's current scheduler permission policy — `agentToolsEnabled`,
 * `agentAutoCreate`, `scriptTasksEnabled`, `confirmationRequired`,
 * `maxTasksPerSource`.
 *
 * Read from `AppSettings` at call time through the same loader the write gate
 * uses (`loadSchedulerPolicy`), NOT from the scheduler store. The store serves
 * `DEFAULT_PERMISSION_POLICY` until something hydrates it, and that default has
 * `agentToolsEnabled: true` — so a plugin tool asking a fresh renderer "may
 * agents manage the schedule?" got "yes" even after the user had switched it
 * off. A plugin exposing agent tools gates EVERY action on this answer.
 */
export async function getSchedulerPermissionPolicy(): Promise<SchedulerPermissionPolicy> {
  const { loadSchedulerPolicy } = await import("@/lib/scheduler/write-authority")
  return loadSchedulerPolicy()
}

/**
 * Every scheduled task the user owns, after making sure the store has loaded.
 * Reading `tasks` without the load is how a fresh renderer reports an empty
 * schedule and lets a caller blow past `maxTasksPerSource`.
 */
export async function listUserScheduledTasks(): Promise<ScheduledTask[]> {
  const state = await store()
  await state.loadTasks().catch(() => undefined)
  return (await store()).tasks
}

/**
 * Create a task on the user's schedule.
 *
 * The policy is ENFORCED here, not merely documented. This function used to
 * carry a comment telling plugin authors they "MUST consult" the policy first
 * while doing nothing to make that true, which meant a plugin could put
 * anything on the user's schedule regardless of what they had configured.
 *
 * A write that needs the user's confirmation is refused rather than performed:
 * a plugin has no confirmation surface here, and deciding on the user's behalf
 * is the thing the setting exists to prevent. The thrown message names the
 * scheduler panel as the place to do it instead.
 *
 * Returns `null` when the store refuses the write. Throws when the POLICY
 * refuses it, because a plugin author needs to know the difference between
 * "that did not persist" and "the user does not permit this".
 */
export async function createUserScheduledTask(
  input: CreateScheduledTaskInput
): Promise<ScheduledTask | null> {
  const { assertTaskWriteAllowed } = await import("@/lib/scheduler/write-authority")
  const creator = input.createdBy
  await assertTaskWriteAllowed({
    taskType: input.type,
    source: creator?.kind ?? "plugin",
    sessionId: creator?.sessionId,
    pluginId: creator?.pluginId,
  })
  return (await store()).createTask(input)
}

/** Delete a task. Returns false when no task with that id exists. */
export async function deleteUserScheduledTask(taskId: string): Promise<boolean> {
  return (await store()).deleteTask(taskId)
}

/**
 * Run a task immediately, out of band from its trigger. `triggerSource`
 * defaults to `"run-now"` so the execution history distinguishes a manual /
 * agent-driven run from one the scheduler fired.
 */
export async function runUserScheduledTaskNow(
  taskId: string,
  options: { triggerSource?: TaskExecutionTriggerSource } = {}
): Promise<TaskExecution | null> {
  return (await store()).runTaskNow(taskId, { triggerSource: "run-now", ...options })
}
