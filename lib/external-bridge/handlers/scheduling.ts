/**
 * Agent-facing scheduler tools.
 *
 * These are withheld from chat builds unless the conversation explicitly opts
 * in. Once present, writes remain provenance-scoped: an agent session can list
 * and cancel only tasks carrying its own `{ kind: "agent", sessionId }`
 * creator record.
 */

import { isTauri } from "@/lib/tauri"
import { proxyToRenderer } from "@/lib/external-bridge/orchestration-proxy-client"
import { getTaskScheduler } from "@/lib/scheduler/task-scheduler"
import { MAX_INTERVAL_MS, MIN_INTERVAL_MS } from "@/lib/loop/interval"
import type { CreateScheduledTaskInput, ScheduledTask, TaskExecution } from "@/types/scheduler"

export interface ScheduleTaskInput {
  sessionId: string
  prompt: string
  name?: string
  intervalMs?: number
  cronExpression?: string
  timezone?: string
}

export interface ScheduleTaskOutput {
  ok: boolean
  task?: {
    id: string
    name: string
    status: ScheduledTask["status"]
    nextRunAt?: string
  }
  error?: string
}

export interface ListScheduledTasksInput {
  sessionId: string
}

export interface ListScheduledTasksOutput {
  ok: boolean
  tasks?: Array<{
    id: string
    name: string
    status: ScheduledTask["status"]
    trigger: ScheduledTask["trigger"]
    nextRunAt?: string
    lastError?: string
  }>
  error?: string
}

export interface CancelScheduledTaskInput {
  sessionId: string
  taskId: string
}

export interface CancelScheduledTaskOutput {
  ok: boolean
  cancelled?: boolean
  error?: string
}

interface SchedulerPort {
  createTask(input: CreateScheduledTaskInput): Promise<ScheduledTask>
  getAllTasks(): Promise<ScheduledTask[]>
  deleteTask(taskId: string): Promise<boolean>
  runTaskNow?(taskId: string): Promise<TaskExecution | null>
}

interface SchedulingDeps {
  scheduler?: SchedulerPort
  /** Injected in tests. Defaults to the real policy gate. */
  authorize?: typeof import("@/lib/scheduler/write-authority").authorizeTaskWrite
  getSession?: (sessionId: string) => Promise<
    | {
        id: string
        characterId?: string
        platformBinding?: { adapterId?: string; conversationKey?: string }
      }
    | undefined
  >
}

function isOwnedByAgentSession(task: ScheduledTask, sessionId: string): boolean {
  return task.createdBy?.kind === "agent" && task.createdBy.sessionId === sessionId
}

function summarizeTask(task: ScheduledTask): NonNullable<ScheduleTaskOutput["task"]> {
  return {
    id: task.id,
    name: task.name,
    status: task.status,
    ...(task.nextRunAt ? { nextRunAt: task.nextRunAt.toISOString() } : {}),
  }
}

function taskName(input: ScheduleTaskInput): string {
  const compact = (input.name?.trim() || input.prompt.trim()).replace(/\s+/g, " ")
  return compact.length <= 72 ? compact : `${compact.slice(0, 71)}…`
}

function buildTrigger(input: ScheduleTaskInput): CreateScheduledTaskInput["trigger"] | string {
  const hasInterval = input.intervalMs !== undefined
  const hasCron = Boolean(input.cronExpression?.trim())
  if (hasInterval === hasCron) {
    return "schedule_task requires exactly one of intervalMs or cronExpression"
  }
  if (hasInterval) {
    if (
      !Number.isFinite(input.intervalMs) ||
      !Number.isInteger(input.intervalMs) ||
      input.intervalMs! < MIN_INTERVAL_MS ||
      input.intervalMs! > MAX_INTERVAL_MS
    ) {
      return `intervalMs must be an integer between ${MIN_INTERVAL_MS} and ${MAX_INTERVAL_MS}`
    }
    return { type: "interval", intervalMs: input.intervalMs }
  }
  return {
    type: "cron",
    cronExpression: input.cronExpression!.trim(),
    ...(input.timezone?.trim() ? { timezone: input.timezone.trim() } : {}),
  }
}

async function resolveSession(
  sessionId: string,
  deps: SchedulingDeps
): Promise<
  | {
      id: string
      characterId?: string
      platformBinding?: { adapterId?: string; conversationKey?: string }
    }
  | undefined
> {
  if (deps.getSession) return deps.getSession(sessionId)
  const { getSession } = await import("@/lib/db/sessions")
  return getSession(sessionId)
}

export async function scheduleTask(input: ScheduleTaskInput): Promise<ScheduleTaskOutput> {
  if (isTauri()) return scheduleTaskCore(input)
  return proxyToRenderer<ScheduleTaskOutput>("schedule_task", { ...input })
}

export async function scheduleTaskCore(
  input: ScheduleTaskInput,
  deps: SchedulingDeps = {}
): Promise<ScheduleTaskOutput> {
  if (!input.sessionId?.trim() || !input.prompt?.trim()) {
    return { ok: false, error: "schedule_task requires non-empty sessionId and prompt" }
  }
  const trigger = buildTrigger(input)
  if (typeof trigger === "string") return { ok: false, error: trigger }

  try {
    const scheduler = deps.scheduler ?? getTaskScheduler()

    const session = await resolveSession(input.sessionId, deps)
    if (!session) return { ok: false, error: `session not found: ${input.sessionId}` }
    const binding = session.platformBinding
    const isImBound = Boolean(binding?.adapterId && binding?.conversationKey)

    // The user's own policy decides, not a constant in this file. This used to
    // enforce a hardcoded quota of 8 per session that no setting could reach,
    // while `SchedulerPermissionPolicy.maxTasksPerSource` sat unenforced.
    const { authorizeTaskWrite, verdictNeedsConfirmation } =
      await import("@/lib/scheduler/write-authority")
    const taskType = isImBound ? "connection:scheduled:digest" : "chat"
    const verdict = await (deps.authorize ?? authorizeTaskWrite)({
      taskType,
      source: "agent",
      sessionId: input.sessionId,
    })
    if (!verdict.allowed) return { ok: false, error: verdict.message }
    if (verdictNeedsConfirmation(verdict)) {
      // These tools have no confirmation surface. Saying so is the honest
      // answer: the assistant can relay it, and the user can add the task from
      // the scheduler panel where a confirmation dialog exists.
      return { ok: false, error: verdict.message }
    }
    const task = await scheduler.createTask({
      name: taskName(input),
      description: `Created by agent session ${input.sessionId}`,
      type: taskType,
      trigger,
      payload: isImBound
        ? {
            adapterId: binding!.adapterId!,
            conversationKey: binding!.conversationKey!,
            characterId: session.characterId ?? "",
            prompt: input.prompt.trim(),
          }
        : { sessionId: input.sessionId, prompt: input.prompt.trim() },
      createdBy: { kind: "agent", sessionId: input.sessionId },
      notification: isImBound
        ? {
            onStart: false,
            onComplete: false,
            onError: true,
            channels: ["im"],
            imTarget: { conversationKey: binding!.conversationKey! },
          }
        : undefined,
      tags: ["agent-created"],
    })
    return { ok: true, task: summarizeTask(task) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function listScheduledTasks(
  input: ListScheduledTasksInput
): Promise<ListScheduledTasksOutput> {
  if (isTauri()) return listScheduledTasksCore(input)
  return proxyToRenderer<ListScheduledTasksOutput>("list_scheduled_tasks", { ...input })
}

export async function listScheduledTasksCore(
  input: ListScheduledTasksInput,
  deps: SchedulingDeps = {}
): Promise<ListScheduledTasksOutput> {
  if (!input.sessionId?.trim()) {
    return { ok: false, error: "list_scheduled_tasks requires a non-empty sessionId" }
  }
  try {
    const scheduler = deps.scheduler ?? getTaskScheduler()
    const tasks = (await scheduler.getAllTasks())
      .filter((task) => isOwnedByAgentSession(task, input.sessionId))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((task) => ({
        id: task.id,
        name: task.name,
        status: task.status,
        trigger: task.trigger,
        ...(task.nextRunAt ? { nextRunAt: task.nextRunAt.toISOString() } : {}),
        ...(task.lastError ? { lastError: task.lastError } : {}),
      }))
    return { ok: true, tasks }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function cancelScheduledTask(
  input: CancelScheduledTaskInput
): Promise<CancelScheduledTaskOutput> {
  if (isTauri()) return cancelScheduledTaskCore(input)
  return proxyToRenderer<CancelScheduledTaskOutput>("cancel_scheduled_task", { ...input })
}

export async function cancelScheduledTaskCore(
  input: CancelScheduledTaskInput,
  deps: SchedulingDeps = {}
): Promise<CancelScheduledTaskOutput> {
  if (!input.sessionId?.trim() || !input.taskId?.trim()) {
    return {
      ok: false,
      error: "cancel_scheduled_task requires non-empty sessionId and taskId",
    }
  }
  try {
    const scheduler = deps.scheduler ?? getTaskScheduler()
    const task = (await scheduler.getAllTasks()).find((row) => row.id === input.taskId)
    if (!task) return { ok: false, error: `task not found: ${input.taskId}` }
    if (!isOwnedByAgentSession(task, input.sessionId)) {
      return { ok: false, error: "task is not owned by this agent session" }
    }
    return { ok: true, cancelled: await scheduler.deleteTask(task.id) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
