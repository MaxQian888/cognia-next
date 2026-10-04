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
 * pass-throughs to the renderer scheduler store and to the scheduler data
 * source, which own the scheduler-host binding (this device's schedule or a
 * paired host's); the policy is read through the write gate's own loader
 * (`lib/scheduler/write-authority.ts`), so neither is re-derived here.
 *
 * Every write passes the write gate, and every write is attributed. The
 * surface is bound to the calling plugin (`createUserSchedulerAPI(pluginId)`),
 * and a write may be made as that plugin (`{ kind: "plugin" }`, the default)
 * or on behalf of an agent using the plugin's tools
 * (`{ kind: "agent", sessionId }`). It may never be made as `"user"` or
 * `"system"`: the gate exempts the user entirely, so a plugin claiming to be
 * the user would walk past every setting the user has, and `"system"` is not
 * a writer a plugin can be. `createdBy.pluginId` is always overwritten with
 * the caller's id, so one plugin cannot charge its writes to another.
 *
 * The store and the scheduler are imported lazily on purpose. A plugin that
 * never touches the scheduler should not drag the scheduler system into its
 * module graph, and the agent tool that does call these runs long after boot.
 */

import type {
  CreateScheduledTaskInput,
  ScheduledTask,
  ScheduledTaskCreator,
  ScheduledTaskType,
  SchedulerPermissionPolicy,
  TaskExecution,
  TaskExecutionTriggerSource,
  UpdateScheduledTaskInput,
} from "@/types/scheduler"
import type { CancelExecutionOutcome } from "@/lib/scheduler/task-scheduler"

async function store() {
  const { useSchedulerStore } = await import("@/stores/scheduler/scheduler-store")
  return useSchedulerStore.getState()
}

async function dataSource() {
  const { getSchedulerDataSource } = await import("@/lib/scheduler/scheduler-data-source")
  return getSchedulerDataSource()
}

/**
 * Who a write is made as. A plugin acting on its own initiative is `plugin`;
 * a plugin tool an agent called is `agent`, with the agent's chat session, so
 * the user's agent policy (`agentToolsEnabled`, `agentAutoCreate`, the agent
 * quota) applies to it.
 */
export type PluginSchedulerActor = { kind: "plugin" } | { kind: "agent"; sessionId?: string }

export interface PluginSchedulerWriteOptions {
  /** Defaults to `{ kind: "plugin" }`. */
  actor?: PluginSchedulerActor
}

export interface PluginSchedulerRunOptions extends PluginSchedulerWriteOptions {
  /** Defaults to `"run-now"`, so history tells a manual run from a scheduled one. */
  triggerSource?: TaskExecutionTriggerSource
}

export interface PluginSchedulerExecutionPage {
  /** Rows per page, 1–200. Default 50. */
  limit?: number
  /** Only runs that started strictly before this instant (the cursor of the previous page). */
  before?: Date | string
}

/** One projected future run of one task. */
export interface PluginUpcomingRun {
  taskId: string
  taskName: string
  taskType: ScheduledTaskType
  at: Date
}

export interface PluginUserSchedulerAPI {
  getPolicy(): Promise<SchedulerPermissionPolicy>
  listTasks(): Promise<ScheduledTask[]>
  getTask(taskId: string): Promise<ScheduledTask | null>
  createTask(input: CreateScheduledTaskInput): Promise<ScheduledTask | null>
  updateTask(
    taskId: string,
    input: UpdateScheduledTaskInput,
    options?: PluginSchedulerWriteOptions
  ): Promise<ScheduledTask | null>
  deleteTask(taskId: string, options?: PluginSchedulerWriteOptions): Promise<boolean>
  pauseTask(taskId: string, options?: PluginSchedulerWriteOptions): Promise<boolean>
  resumeTask(taskId: string, options?: PluginSchedulerWriteOptions): Promise<boolean>
  runTaskNow(taskId: string, options?: PluginSchedulerRunOptions): Promise<TaskExecution | null>
  listExecutions(taskId: string, page?: PluginSchedulerExecutionPage): Promise<TaskExecution[]>
  getExecution(executionId: string): Promise<TaskExecution | null>
  cancelExecution(
    executionId: string,
    options?: PluginSchedulerWriteOptions
  ): Promise<CancelExecutionOutcome>
  getUpcoming(taskId?: string, count?: number): Promise<PluginUpcomingRun[]>
}

export function createUserSchedulerAPI(pluginId: string): PluginUserSchedulerAPI {
  return {
    getPolicy: getSchedulerPermissionPolicy,
    listTasks: listUserScheduledTasks,
    getTask: getUserScheduledTask,
    createTask: (input) => createUserScheduledTask(pluginId, input),
    updateTask: (taskId, input, options) =>
      updateUserScheduledTask(pluginId, taskId, input, options),
    deleteTask: (taskId, options) => deleteUserScheduledTask(pluginId, taskId, options),
    pauseTask: (taskId, options) => pauseUserScheduledTask(pluginId, taskId, options),
    resumeTask: (taskId, options) => resumeUserScheduledTask(pluginId, taskId, options),
    runTaskNow: (taskId, options) => runUserScheduledTaskNow(pluginId, taskId, options),
    listExecutions: listUserTaskExecutions,
    getExecution: getUserTaskExecution,
    cancelExecution: (executionId, options) =>
      cancelUserTaskExecution(pluginId, executionId, options),
    getUpcoming: getUserUpcomingRuns,
  }
}

// =============================================================================
// Attribution & the write gate
// =============================================================================

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function refusedAttribution(kind: unknown): Error {
  return new Error(
    `A plugin may write to the schedule as itself ("plugin") or for an agent using its tools ("agent"), not as "${String(kind)}". Writes made as the user bypass the scheduler permission policy, so they can only come from the user.`
  )
}

/** The gate's view of an actor, refusing any attribution a plugin may not claim. */
function resolveActor(actor: unknown): { source: "plugin" | "agent"; sessionId?: string } {
  if (actor === undefined) return { source: "plugin" }
  if (!isRecord(actor)) throw new Error("options.actor must be an object with a kind")
  if (actor.kind === "plugin") return { source: "plugin" }
  if (actor.kind === "agent") {
    if (actor.sessionId !== undefined && typeof actor.sessionId !== "string") {
      throw new Error("options.actor.sessionId must be a string")
    }
    return { source: "agent", ...(actor.sessionId ? { sessionId: actor.sessionId } : {}) }
  }
  throw refusedAttribution(actor.kind)
}

/**
 * The creator recorded on a new row: the kind the caller asked for, if a
 * plugin may claim it, always stamped with the calling plugin's id.
 */
function resolveCreator(pluginId: string, creator: unknown): ScheduledTaskCreator {
  if (creator === undefined) return { kind: "plugin", pluginId }
  if (!isRecord(creator)) throw new Error("createdBy must be an object with a kind")
  const actor = resolveActor({ kind: creator.kind, sessionId: creator.sessionId })
  return {
    kind: actor.source,
    pluginId,
    ...(actor.sessionId ? { sessionId: actor.sessionId } : {}),
  }
}

/**
 * Pass the gate for a write to an EXISTING task, or throw its refusal.
 *
 * `operation: "mutate"` because the per-source quota bounds how many tasks a
 * writer may own, not whether it may act on one; the rest still applies: an
 * agent is refused while "Allow agents to manage scheduled tasks" is off, a
 * `script` task is refused while script tasks are off, a type this host
 * cannot run is refused, and a type on the confirmation list is refused
 * because this caller cannot ask the user.
 */
async function assertMutationAllowed(
  pluginId: string,
  taskType: ScheduledTaskType,
  options: PluginSchedulerWriteOptions | undefined
): Promise<void> {
  const actor = resolveActor(options?.actor)
  const { assertTaskWriteAllowed } = await import("@/lib/scheduler/write-authority")
  await assertTaskWriteAllowed({
    taskType,
    source: actor.source,
    operation: "mutate",
    pluginId,
    ...(actor.sessionId ? { sessionId: actor.sessionId } : {}),
  })
}

/**
 * Dates a non-TypeScript caller (a Python plugin, anything that crossed a JSON
 * boundary) can only send as strings. The scheduler compares them as `Date`s,
 * so they are revived here rather than stored as strings that every bound
 * check would then misread.
 */
function reviveDate(value: unknown, field: string): Date {
  const date = value instanceof Date ? value : new Date(value as string)
  if (Number.isNaN(date.getTime())) throw new Error(`${field} must be a valid date`)
  return date
}

function reviveTriggerDates<T extends { runAt?: unknown }>(trigger: T): T {
  return trigger.runAt !== undefined
    ? { ...trigger, runAt: reviveDate(trigger.runAt, "trigger.runAt") }
    : trigger
}

// =============================================================================
// Reads
// =============================================================================

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

/** One task, from whichever schedule the app is bound to. Null when it does not exist. */
export async function getUserScheduledTask(taskId: string): Promise<ScheduledTask | null> {
  if (typeof taskId !== "string" || taskId.length === 0) return null
  return (await dataSource()).getTask(taskId)
}

/** The most recent rows a paired host's run list can return; its RPC caps there. */
const REMOTE_RUN_LOOKUP_LIMIT = 200

/**
 * One execution row by id.
 *
 * This device's schedule answers from its database. A paired host has no
 * lookup by run id, only its recent-runs list, so a run is looked for among
 * the newest {@link REMOTE_RUN_LOOKUP_LIMIT}. One that is older cannot be told
 * apart from one that does not exist, and saying "not found" for it would be a
 * guess: that case throws and names `listExecutions(taskId)` instead.
 */
export async function getUserTaskExecution(executionId: string): Promise<TaskExecution | null> {
  if (typeof executionId !== "string" || executionId.length === 0) return null
  const source = await dataSource()
  if (source.host === "local") {
    const { schedulerDb } = await import("@/lib/scheduler/scheduler-db")
    return schedulerDb.getExecution(executionId)
  }
  const recent = await source.getRecentExecutions(REMOTE_RUN_LOOKUP_LIMIT)
  const found = recent.find((execution) => execution.id === executionId)
  if (found) return found
  throw new Error(
    `Run ${executionId} is not among the paired host's ${REMOTE_RUN_LOOKUP_LIMIT} most recent runs, and the paired host offers no lookup by run id. Page through the task's runs with listExecutions(taskId) instead.`
  )
}

/** A task's runs, newest first, one page at a time. */
export async function listUserTaskExecutions(
  taskId: string,
  page: PluginSchedulerExecutionPage = {}
): Promise<TaskExecution[]> {
  if (typeof taskId !== "string" || taskId.length === 0) return []
  const limit = page.limit ?? 50
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new Error("limit must be an integer from 1 to 200")
  }
  const before =
    page.before !== undefined ? reviveDate(page.before, "before").toISOString() : undefined
  return (await dataSource()).getTaskExecutions(taskId, limit, before)
}

/**
 * The next fire times of one task, or of every active task merged in time
 * order, projected from their triggers through the same expansion the
 * scheduler panel's calendar uses. Paused, disabled and expired tasks have no
 * future runs; an `event` task has no schedule to project.
 */
export async function getUserUpcomingRuns(
  taskId?: string,
  count: number = 10
): Promise<PluginUpcomingRun[]> {
  if (!Number.isInteger(count) || count < 1 || count > 100) {
    throw new Error("count must be an integer from 1 to 100")
  }
  const source = await dataSource()
  const tasks =
    taskId !== undefined
      ? [await source.getTask(taskId)].filter((task): task is ScheduledTask => task !== null)
      : await source.listTasks({ statuses: ["active"] })
  const { projectTriggerFireTimes } = await import("@/lib/scheduler/upcoming-occurrences")
  const from = new Date()
  const runs: PluginUpcomingRun[] = []
  for (const task of tasks) {
    if (task.status !== "active") continue
    for (const at of projectTriggerFireTimes(task.trigger, count, {
      from,
      nextRunAt: task.nextRunAt,
    })) {
      runs.push({ taskId: task.id, taskName: task.name, taskType: task.type, at })
    }
  }
  runs.sort((a, b) => a.at.getTime() - b.at.getTime() || a.taskId.localeCompare(b.taskId))
  return runs.slice(0, count)
}

// =============================================================================
// Writes
// =============================================================================

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
 * refuses it, or when the input claims an attribution a plugin may not make,
 * because a plugin author needs to know the difference between "that did not
 * persist" and "the user does not permit this".
 */
export async function createUserScheduledTask(
  pluginId: string,
  input: CreateScheduledTaskInput
): Promise<ScheduledTask | null> {
  if (!isRecord(input as unknown)) throw new Error("createTask needs an input object")
  const createdBy = resolveCreator(pluginId, input.createdBy)
  const { assertTaskWriteAllowed } = await import("@/lib/scheduler/write-authority")
  await assertTaskWriteAllowed({
    taskType: input.type,
    source: createdBy.kind as "plugin" | "agent",
    sessionId: createdBy.sessionId,
    pluginId,
  })
  return (await store()).createTask({
    ...input,
    trigger: isRecord(input.trigger) ? reviveTriggerDates(input.trigger) : input.trigger,
    ...(input.endAt !== undefined ? { endAt: reviveDate(input.endAt, "endAt") } : {}),
    createdBy,
  })
}

/**
 * Amend a task. Null when no task has that id (or the store refused the
 * write); throws when the policy refuses it.
 */
export async function updateUserScheduledTask(
  pluginId: string,
  taskId: string,
  input: UpdateScheduledTaskInput,
  options?: PluginSchedulerWriteOptions
): Promise<ScheduledTask | null> {
  resolveActor(options?.actor)
  if (!isRecord(input as unknown)) throw new Error("updateTask needs an input object")
  const task = await getUserScheduledTask(taskId)
  if (!task) return null
  await assertMutationAllowed(pluginId, task.type, options)
  return (await store()).updateTask(taskId, {
    ...input,
    ...(isRecord(input.trigger) ? { trigger: reviveTriggerDates(input.trigger) } : {}),
    ...(input.endAt !== undefined && input.endAt !== null
      ? { endAt: reviveDate(input.endAt, "endAt") }
      : {}),
  })
}

/** Delete a task. False when no task with that id exists; throws when the policy refuses. */
export async function deleteUserScheduledTask(
  pluginId: string,
  taskId: string,
  options?: PluginSchedulerWriteOptions
): Promise<boolean> {
  resolveActor(options?.actor)
  const task = await getUserScheduledTask(taskId)
  if (!task) return false
  await assertMutationAllowed(pluginId, task.type, options)
  return (await store()).deleteTask(taskId)
}

/** Pause a task. False when it does not exist or could not be paused; throws when refused. */
export async function pauseUserScheduledTask(
  pluginId: string,
  taskId: string,
  options?: PluginSchedulerWriteOptions
): Promise<boolean> {
  resolveActor(options?.actor)
  const task = await getUserScheduledTask(taskId)
  if (!task) return false
  await assertMutationAllowed(pluginId, task.type, options)
  return (await store()).pauseTask(taskId)
}

/** Resume a paused task. False when it does not exist or was not paused; throws when refused. */
export async function resumeUserScheduledTask(
  pluginId: string,
  taskId: string,
  options?: PluginSchedulerWriteOptions
): Promise<boolean> {
  resolveActor(options?.actor)
  const task = await getUserScheduledTask(taskId)
  if (!task) return false
  await assertMutationAllowed(pluginId, task.type, options)
  return (await store()).resumeTask(taskId)
}

/**
 * Run a task immediately, out of band from its trigger. `triggerSource`
 * defaults to `"run-now"` so the execution history distinguishes a manual /
 * agent-driven run from one the scheduler fired. Null when the task does not
 * exist; throws when the policy refuses.
 */
export async function runUserScheduledTaskNow(
  pluginId: string,
  taskId: string,
  options: PluginSchedulerRunOptions = {}
): Promise<TaskExecution | null> {
  resolveActor(options.actor)
  const task = await getUserScheduledTask(taskId)
  if (!task) return null
  await assertMutationAllowed(pluginId, task.type, options)
  return (await store()).runTaskNow(taskId, {
    triggerSource: options.triggerSource ?? "run-now",
  })
}

/**
 * Stop a run, answering the scheduler's own outcome (`cancelled`, or why not:
 * `not-found`, `already-settled`, `requested` of the context that owns it,
 * `not-owned-here`, `unsupported-on-remote`).
 *
 * A start the overlap policy is still holding has no row yet; on this
 * device's schedule its task is read from the scheduler's queue, so it can be
 * withdrawn like any run.
 */
export async function cancelUserTaskExecution(
  pluginId: string,
  executionId: string,
  options?: PluginSchedulerWriteOptions
): Promise<CancelExecutionOutcome> {
  resolveActor(options?.actor)
  const execution = await getUserTaskExecution(executionId)
  let taskId = execution?.taskId
  if (!taskId && (await dataSource()).host === "local") {
    const { getTaskScheduler } = await import("@/lib/scheduler/task-scheduler")
    taskId = getTaskScheduler().getQueuedStartTaskId(executionId)
  }
  if (!taskId) return { cancelled: false, reason: "not-found" }
  if (execution && execution.status !== "running" && execution.status !== "pending") {
    return { cancelled: false, reason: "already-settled", status: execution.status }
  }
  const task = await getUserScheduledTask(taskId)
  if (!task) return { cancelled: false, reason: "not-found" }
  await assertMutationAllowed(pluginId, task.type, options)
  return (await store()).cancelExecution(executionId)
}
