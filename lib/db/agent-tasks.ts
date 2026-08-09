import { nanoid } from "nanoid"
import type {
  AgentTask,
  AgentTaskApprovalPolicy,
  AgentTaskAttempt,
  AgentTaskAttemptStatus,
  AgentTaskComment,
  AgentTaskPriority,
  AgentTaskStatus,
} from "@/types/agent/agent-task"
import { deriveDependencyStatus, guardAgentTaskMove } from "@/lib/agent-tasks/state-machine"
import { getDb } from "./schema"

const MAX_COMMENTS = 100
const MAX_COMMENT_CHARS = 4_000

export interface CreateAgentTaskInput {
  id?: string
  agentId: string
  projectId?: string
  title: string
  description: string
  priority?: AgentTaskPriority
  dependencies?: string[]
  tags?: string[]
  order?: number
  approvalPolicy?: AgentTaskApprovalPolicy
  scheduledFor?: number
  now?: number
}

export async function createAgentTask(input: CreateAgentTaskInput): Promise<AgentTask> {
  const now = input.now ?? Date.now()
  const dependencies = [...new Set(input.dependencies ?? [])]
  const dependencyRows = await getDb().agentTasks.bulkGet(dependencies)
  if (dependencyRows.some((row) => row && row.agentId !== input.agentId)) {
    throw new Error("Agent task dependencies must belong to the same Agent")
  }
  const status = deriveDependencyStatus(
    "pending",
    dependencyRows.map((row) => row?.status ?? "pending")
  )
  const task: AgentTask = {
    id: input.id ?? `agent-task:${nanoid()}`,
    agentId: input.agentId,
    ...(input.projectId ? { projectId: input.projectId } : {}),
    title: input.title.trim(),
    description: input.description.trim(),
    status,
    priority: input.priority ?? "normal",
    dependencies,
    tags: [...new Set(input.tags ?? [])],
    order: input.order ?? 0,
    approvalPolicy: input.approvalPolicy ?? "on-risk",
    ...(input.scheduledFor ? { scheduledFor: input.scheduledFor } : {}),
    latestAttemptNo: 0,
    comments: [],
    createdAt: now,
    updatedAt: now,
    revision: 1,
  }
  if (!task.title) throw new Error("Agent task title is required")
  await getDb().agentTasks.add(task)
  return task
}

export function getAgentTask(id: string): Promise<AgentTask | undefined> {
  return getDb().agentTasks.get(id)
}

export async function listAgentTasks(agentId: string): Promise<AgentTask[]> {
  return getDb().agentTasks.where("agentId").equals(agentId).sortBy("updatedAt")
}

export function listAgentTaskAttempts(taskId: string): Promise<AgentTaskAttempt[]> {
  return getDb().agentTaskAttempts.where("taskId").equals(taskId).sortBy("attemptNo")
}

export async function bindAgentTaskSchedule(
  taskId: string,
  scheduledTaskId: string,
  now = Date.now()
): Promise<void> {
  await getDb().agentTasks.update(taskId, {
    scheduledTaskId,
    updatedAt: now,
  })
}

export async function moveAgentTask(
  taskId: string,
  to: AgentTaskStatus,
  now = Date.now()
): Promise<AgentTask> {
  return getDb().transaction("rw", getDb().agentTasks, getDb().agentTaskAttempts, async () => {
    const task = await getDb().agentTasks.get(taskId)
    if (!task) throw new Error("Agent task not found")
    const verdict = guardAgentTaskMove(task.status, to)
    if (!verdict.allowed) throw new Error(`Agent task move denied: ${verdict.reason}`)
    if (task.status === to) return task

    if (task.activeAttemptId && (to === "paused" || to === "cancelled")) {
      await getDb().agentTaskAttempts.update(task.activeAttemptId, {
        status: to === "paused" ? "paused" : "cancelled",
        ...(to === "cancelled" ? { completedAt: now } : {}),
        updatedAt: now,
      })
    }
    const next: AgentTask = {
      ...task,
      status: to,
      ...(to === "pending" || to === "cancelled" ? { activeAttemptId: undefined } : {}),
      updatedAt: now,
      revision: task.revision + 1,
    }
    await getDb().agentTasks.put(next)
    return next
  })
}

export async function addAgentTaskComment(
  taskId: string,
  comment: Omit<AgentTaskComment, "createdAt">,
  now = Date.now()
): Promise<AgentTaskComment> {
  const row: AgentTaskComment = {
    ...comment,
    text: comment.text.trim().slice(0, MAX_COMMENT_CHARS),
    createdAt: now,
  }
  if (!row.text) throw new Error("Agent task comment is required")
  await getDb().transaction("rw", getDb().agentTasks, async () => {
    const task = await getDb().agentTasks.get(taskId)
    if (!task) throw new Error("Agent task not found")
    await getDb().agentTasks.put({
      ...task,
      comments: [...task.comments, row].slice(-MAX_COMMENTS),
      updatedAt: now,
      revision: task.revision + 1,
    })
  })
  return row
}

export async function beginAgentTaskAttempt(
  taskId: string,
  input: { id?: string; sessionId?: string; runId?: string; now?: number } = {}
): Promise<AgentTaskAttempt> {
  const now = input.now ?? Date.now()
  return getDb().transaction("rw", getDb().agentTasks, getDb().agentTaskAttempts, async () => {
    const task = await getDb().agentTasks.get(taskId)
    if (!task) throw new Error("Agent task not found")
    if (task.activeAttemptId || task.status === "in_progress") {
      throw new Error("Agent task is already running")
    }
    if (!["pending", "blocked", "failed", "paused"].includes(task.status)) {
      throw new Error(`Agent task cannot start from ${task.status}`)
    }
    const dependencyRows = await getDb().agentTasks.bulkGet(task.dependencies)
    const dependencyStatuses = dependencyRows.map((row) => row?.status ?? "pending")
    if (!dependencyStatuses.every((status) => status === "completed")) {
      if (task.status !== "blocked") {
        await getDb().agentTasks.put({
          ...task,
          status: "blocked",
          updatedAt: now,
          revision: task.revision + 1,
        })
      }
      throw new Error("Agent task dependencies are not complete")
    }
    const attemptNo = task.latestAttemptNo + 1
    const attempt: AgentTaskAttempt = {
      id: input.id ?? `agent-task-attempt:${nanoid()}`,
      taskId,
      agentId: task.agentId,
      attemptNo,
      status: "running",
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
      createdAt: now,
      startedAt: now,
      updatedAt: now,
    }
    await getDb().agentTaskAttempts.add(attempt)
    await getDb().agentTasks.put({
      ...task,
      status: "in_progress",
      activeAttemptId: attempt.id,
      latestAttemptNo: attemptNo,
      updatedAt: now,
      revision: task.revision + 1,
    })
    return attempt
  })
}

export async function linkAgentTaskAttemptExecution(
  attemptId: string,
  schedulerExecutionId: string,
  now = Date.now()
): Promise<void> {
  const changed = await getDb().agentTaskAttempts.update(attemptId, {
    schedulerExecutionId,
    updatedAt: now,
  })
  if (!changed) throw new Error("Agent task attempt not found")
}

export async function settleAgentTaskAttempt(
  attemptId: string,
  input: {
    status: "completed" | "failed" | "cancelled"
    result?: string
    errorCode?: string
    errorMessage?: string
    requiresReview?: boolean
    now?: number
  }
): Promise<AgentTaskAttempt> {
  const now = input.now ?? Date.now()
  return getDb().transaction("rw", getDb().agentTasks, getDb().agentTaskAttempts, async () => {
    const attempt = await getDb().agentTaskAttempts.get(attemptId)
    if (!attempt) throw new Error("Agent task attempt not found")
    const task = await getDb().agentTasks.get(attempt.taskId)
    if (!task) throw new Error("Agent task not found")
    if (attempt.status !== "running" && attempt.status !== "queued") return attempt

    const needsReview =
      input.status === "completed" &&
      (input.requiresReview === true || task.approvalPolicy !== "auto")
    const attemptStatus: AgentTaskAttemptStatus = needsReview ? "review" : input.status
    const taskStatus: AgentTaskStatus = needsReview ? "review" : input.status
    const settled: AgentTaskAttempt = {
      ...attempt,
      status: attemptStatus,
      ...(input.result !== undefined ? { result: input.result } : {}),
      ...(input.errorCode !== undefined ? { errorCode: input.errorCode } : {}),
      ...(input.errorMessage !== undefined ? { errorMessage: input.errorMessage } : {}),
      completedAt: now,
      updatedAt: now,
    }
    await getDb().agentTaskAttempts.put(settled)
    await getDb().agentTasks.put({
      ...task,
      status: taskStatus,
      activeAttemptId: undefined,
      updatedAt: now,
      revision: task.revision + 1,
    })
    return settled
  })
}

type ReconciledExecution = {
  status: "pending" | "running" | "completed" | "failed" | "cancelled"
  output?: Record<string, unknown>
  error?: string
}

export async function reconcileAgentTaskAttempts(
  resolveExecution: (executionId: string) => Promise<ReconciledExecution | null>,
  now = Date.now()
): Promise<{ interrupted: string[]; settled: string[] }> {
  const active = await getDb()
    .agentTaskAttempts.where("status")
    .anyOf(["queued", "running"])
    .toArray()
  const interrupted: string[] = []
  const settled: string[] = []
  for (const attempt of active) {
    const execution = attempt.schedulerExecutionId
      ? await resolveExecution(attempt.schedulerExecutionId)
      : null
    if (!execution) {
      await markAttemptInterrupted(attempt, "execution_missing", now)
      interrupted.push(attempt.id)
    } else if (execution.status === "completed") {
      await settleAgentTaskAttempt(attempt.id, {
        status: "completed",
        result: execution.output ? JSON.stringify(execution.output) : undefined,
        now,
      })
      settled.push(attempt.id)
    } else if (execution.status === "failed" || execution.status === "cancelled") {
      await settleAgentTaskAttempt(attempt.id, {
        status: execution.status,
        errorCode: `scheduler_${execution.status}`,
        errorMessage: execution.error,
        now,
      })
      settled.push(attempt.id)
    }
  }
  return { interrupted, settled }
}

async function markAttemptInterrupted(
  attempt: AgentTaskAttempt,
  errorCode: string,
  now: number
): Promise<void> {
  await getDb().transaction("rw", getDb().agentTasks, getDb().agentTaskAttempts, async () => {
    await getDb().agentTaskAttempts.put({
      ...attempt,
      status: "interrupted",
      errorCode,
      completedAt: now,
      updatedAt: now,
    })
    const task = await getDb().agentTasks.get(attempt.taskId)
    if (task?.activeAttemptId === attempt.id) {
      await getDb().agentTasks.put({
        ...task,
        status: "failed",
        activeAttemptId: undefined,
        updatedAt: now,
        revision: task.revision + 1,
      })
    }
  })
}
