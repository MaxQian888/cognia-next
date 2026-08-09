import type { CreateScheduledTaskInput, TaskExecution } from "@/types/scheduler"
import type { AgentTask } from "@/types/agent/agent-task"
import {
  bindAgentTaskSchedule,
  getAgentTask,
  moveAgentTask,
  reconcileAgentTaskAttempts,
} from "@/lib/db/agent-tasks"
import { getTaskScheduler } from "@/lib/scheduler/task-scheduler"
import { schedulerDb } from "@/lib/scheduler/scheduler-db"

export interface AgentTaskRuntimeDeps {
  now: () => number
  getTask: (taskId: string) => Promise<AgentTask | undefined>
  bindSchedule: (taskId: string, scheduledTaskId: string, now: number) => Promise<unknown>
  moveTask: (taskId: string, status: AgentTask["status"], now: number) => Promise<unknown>
  createTask: (input: CreateScheduledTaskInput) => Promise<{ id: string }>
  runTaskNow: (taskId: string) => Promise<unknown>
  pauseTask: (taskId: string) => Promise<boolean>
  resumeTask: (taskId: string) => Promise<boolean>
  deleteTask: (taskId: string) => Promise<boolean>
  getExecution: (executionId: string) => Promise<TaskExecution | null>
  reconcile: typeof reconcileAgentTaskAttempts
}

export async function ensureAgentTaskSchedule(
  taskId: string,
  providedDeps?: AgentTaskRuntimeDeps
): Promise<string> {
  const deps = providedDeps ?? defaultDeps()
  const task = await deps.getTask(taskId)
  if (!task) throw new Error("Agent task not found")
  if (task.scheduledTaskId) return task.scheduledTaskId
  const runAt = new Date(task.scheduledFor ?? deps.now() + 10 * 365 * 24 * 60 * 60 * 1_000)
  const scheduled = await deps.createTask({
    name: task.title,
    description: task.description,
    type: "agent",
    trigger: { type: "once", runAt },
    payload: {
      prompt: task.description || task.title,
      characterId: task.agentId,
      agentTaskId: task.id,
      sessionTitle: task.title,
    },
    config: {
      overlapPolicy: "skip",
      allowConcurrent: false,
      maxRuns: task.scheduledFor ? 1 : undefined,
    },
    createdBy: { kind: "agent" },
    tags: ["agent-task", task.agentId, ...task.tags],
  })
  await deps.bindSchedule(task.id, scheduled.id, deps.now())
  return scheduled.id
}

export async function runAgentTaskNow(
  taskId: string,
  providedDeps?: AgentTaskRuntimeDeps
): Promise<unknown> {
  const deps = providedDeps ?? defaultDeps()
  const scheduledTaskId = await ensureAgentTaskSchedule(taskId, deps)
  const execution = await deps.runTaskNow(scheduledTaskId)
  if (!execution) throw new Error("Agent task Scheduler execution did not start")
  return execution
}

export async function pauseAgentTask(
  taskId: string,
  providedDeps?: AgentTaskRuntimeDeps
): Promise<void> {
  const deps = providedDeps ?? defaultDeps()
  const task = await deps.getTask(taskId)
  if (!task) throw new Error("Agent task not found")
  if (task.scheduledTaskId) await deps.pauseTask(task.scheduledTaskId)
  await deps.moveTask(taskId, "paused", deps.now())
}

export async function resumeAgentTask(
  taskId: string,
  providedDeps?: AgentTaskRuntimeDeps
): Promise<void> {
  const deps = providedDeps ?? defaultDeps()
  const task = await deps.getTask(taskId)
  if (!task) throw new Error("Agent task not found")
  await deps.moveTask(taskId, "pending", deps.now())
  if (task.scheduledTaskId) await deps.resumeTask(task.scheduledTaskId)
}

export async function cancelAgentTask(
  taskId: string,
  providedDeps?: AgentTaskRuntimeDeps
): Promise<void> {
  const deps = providedDeps ?? defaultDeps()
  const task = await deps.getTask(taskId)
  if (!task) throw new Error("Agent task not found")
  if (task.scheduledTaskId) await deps.deleteTask(task.scheduledTaskId)
  await deps.moveTask(taskId, "cancelled", deps.now())
}

export function reconcileAgentTaskRuntime(
  providedDeps?: AgentTaskRuntimeDeps
): Promise<{ interrupted: string[]; settled: string[] }> {
  const deps = providedDeps ?? defaultDeps()
  return deps.reconcile(deps.getExecution, deps.now())
}

function defaultDeps(): AgentTaskRuntimeDeps {
  const scheduler = getTaskScheduler()
  return {
    now: Date.now,
    getTask: getAgentTask,
    bindSchedule: bindAgentTaskSchedule,
    moveTask: moveAgentTask,
    createTask: (input) => scheduler.createTask(input),
    runTaskNow: (taskId) => scheduler.runTaskNow(taskId),
    pauseTask: (taskId) => scheduler.pauseTask(taskId),
    resumeTask: (taskId) => scheduler.resumeTask(taskId),
    deleteTask: (taskId) => scheduler.deleteTask(taskId),
    getExecution: (executionId) => schedulerDb.getExecution(executionId),
    reconcile: reconcileAgentTaskAttempts,
  }
}
