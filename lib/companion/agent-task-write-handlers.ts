import { nanoid } from "nanoid"
import {
  addAgentTaskComment,
  getAgentTask,
  moveAgentTask,
} from "@/lib/db/agent-tasks"
import {
  cancelAgentTask,
  pauseAgentTask,
  resumeAgentTask,
  runAgentTaskNow,
} from "@/lib/agent-tasks/runtime"
import type { AgentTaskStatus } from "@/types/agent/agent-task"

export interface AgentTaskCommandResult {
  ok: boolean
  reason?: "invalid-payload" | "invalid-status" | "task-not-found" | "transition-denied"
  executionId?: string
  commentId?: string
}

const REMOTE_MOVE_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "paused",
  "completed",
  "failed",
  "cancelled",
])

function readString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key]
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null
}

async function resolveScopedTask(payload: Record<string, unknown>) {
  const agentId = readString(payload, "agentId")
  const taskId = readString(payload, "taskId")
  if (!agentId || !taskId) return { error: "invalid-payload" as const }
  const task = await getAgentTask(taskId)
  if (!task || task.agentId !== agentId) return { error: "task-not-found" as const }
  return { task }
}

async function runRuntimeAction(
  payload: Record<string, unknown>,
  action: (taskId: string) => Promise<unknown>
): Promise<AgentTaskCommandResult> {
  const resolved = await resolveScopedTask(payload)
  if ("error" in resolved) return { ok: false, reason: resolved.error }
  try {
    await action(resolved.task.id)
    return { ok: true }
  } catch {
    return { ok: false, reason: "transition-denied" }
  }
}

export async function handleAgentTaskStart(
  payload: Record<string, unknown>
): Promise<AgentTaskCommandResult> {
  const resolved = await resolveScopedTask(payload)
  if ("error" in resolved) return { ok: false, reason: resolved.error }
  try {
    const execution = await runAgentTaskNow(resolved.task.id)
    const executionId =
      typeof execution === "object" && execution && "id" in execution
        ? String(execution.id)
        : undefined
    return { ok: true, ...(executionId ? { executionId } : {}) }
  } catch {
    return { ok: false, reason: "transition-denied" }
  }
}

export function handleAgentTaskPause(
  payload: Record<string, unknown>
): Promise<AgentTaskCommandResult> {
  return runRuntimeAction(payload, pauseAgentTask)
}

export function handleAgentTaskResume(
  payload: Record<string, unknown>
): Promise<AgentTaskCommandResult> {
  return runRuntimeAction(payload, resumeAgentTask)
}

export function handleAgentTaskCancel(
  payload: Record<string, unknown>
): Promise<AgentTaskCommandResult> {
  return runRuntimeAction(payload, cancelAgentTask)
}

export async function handleAgentTaskComment(
  payload: Record<string, unknown>
): Promise<AgentTaskCommandResult> {
  const resolved = await resolveScopedTask(payload)
  if ("error" in resolved) return { ok: false, reason: resolved.error }
  const text = readString(payload, "text")
  if (!text) return { ok: false, reason: "invalid-payload" }
  const commentId = `agent-task-comment:${nanoid()}`
  try {
    await addAgentTaskComment(resolved.task.id, { id: commentId, author: "user", text })
    return { ok: true, commentId }
  } catch {
    return { ok: false, reason: "transition-denied" }
  }
}

export async function handleAgentTaskMove(
  payload: Record<string, unknown>
): Promise<AgentTaskCommandResult> {
  const resolved = await resolveScopedTask(payload)
  if ("error" in resolved) return { ok: false, reason: resolved.error }
  const to = readString(payload, "to")
  if (!to || !REMOTE_MOVE_STATUSES.has(to)) return { ok: false, reason: "invalid-status" }
  try {
    await moveAgentTask(resolved.task.id, to as AgentTaskStatus)
    return { ok: true }
  } catch {
    return { ok: false, reason: "transition-denied" }
  }
}
