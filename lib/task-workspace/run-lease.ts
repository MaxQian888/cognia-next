import {
  beginTaskWorkspaceTurn,
  settleTaskWorkspaceRunWithProjection,
  type BeginTaskWorkspaceTurn,
} from "./client"
import type { ResourceChange, ResourceTrackingPolicy, TaskRun, WorkspaceBaseSpec } from "./types"

export interface TaskWorkspaceRunLease {
  run: TaskRun
  settle: (finalState?: "ready" | "failed" | "cancelled") => Promise<ResourceChange[]>
}

export async function openTaskWorkspaceRunLease(
  input: BeginTaskWorkspaceTurn
): Promise<TaskWorkspaceRunLease | null> {
  const run = await beginTaskWorkspaceTurn(input)
  if (!run) return null
  return {
    run,
    settle: (finalState = "ready") => settleTaskWorkspaceRunWithProjection(run.runId, finalState),
  }
}

export interface TaskWorkspaceRunLeaseInput {
  enabled: boolean
  workspaceRoot?: string
  base?: WorkspaceBaseSpec
  taskId?: string
  sessionId: string
  runId: string
  parentRunId?: string
  turnId?: string
  attemptId: string
  providerAttemptId?: string
  executionRunId?: string
  traceId?: string
  traceSpanId?: string
  surface: string
  agentId: string
  agentKind: string
  trackingPolicy?: ResourceTrackingPolicy
}

export interface TaskWorkspaceRunLeaseOutcome<T> {
  value: T
  taskWorkspaceRunId?: string
  executionRoot: string
  trackingUnavailable?: boolean
}

function boundaryId(prefix: string, parts: Array<string | undefined>): string {
  const value = parts
    .filter(Boolean)
    .join(":")
    .replace(/[^a-zA-Z0-9_.:-]/g, "_")
  return `${prefix}${value}`.slice(0, 128)
}

function failedRunState(error: unknown): "failed" | "cancelled" {
  return error instanceof Error && error.name === "AbortError" ? "cancelled" : "failed"
}

/** Owns the complete begin → isolated execution → settle/projection lifecycle. */
export async function withTaskWorkspaceRun<T>(
  input: TaskWorkspaceRunLeaseInput,
  execute: (executionRoot: string) => Promise<T>
): Promise<TaskWorkspaceRunLeaseOutcome<T>> {
  const workspaceRoot = input.workspaceRoot?.trim()
  if (!input.enabled || !workspaceRoot) {
    return {
      value: await execute(workspaceRoot ?? ""),
      executionRoot: workspaceRoot ?? "",
      ...(!workspaceRoot ? { trackingUnavailable: true } : {}),
    }
  }

  const taskId = input.taskId ?? boundaryId("task:", [input.sessionId, input.turnId ?? input.runId])
  const workspaceRunId = boundaryId("run:", [input.runId, input.attemptId])
  const lease = await openTaskWorkspaceRunLease({
    taskId,
    sessionId: input.sessionId,
    runId: workspaceRunId,
    ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
    agentId: input.agentId,
    agentKind: input.agentKind,
    workspaceRoot,
    ...(input.base ? { base: input.base } : {}),
    executionRunId: input.executionRunId ?? input.runId,
    ...(input.traceId ? { traceId: input.traceId } : {}),
    ...(input.traceSpanId ? { traceSpanId: input.traceSpanId } : {}),
    ...(input.turnId ? { turnId: input.turnId } : {}),
    attemptId: input.attemptId,
    ...(input.providerAttemptId ? { providerAttemptId: input.providerAttemptId } : {}),
    surface: input.surface,
    ...(input.trackingPolicy ? { trackingPolicy: input.trackingPolicy } : {}),
  })
  if (!lease) {
    return {
      value: await execute(workspaceRoot),
      executionRoot: workspaceRoot,
      trackingUnavailable: true,
    }
  }

  let value: T
  try {
    value = await execute(lease.run.executionRoot)
  } catch (error) {
    await lease.settle(failedRunState(error)).catch(() => undefined)
    throw error
  }

  try {
    await lease.settle("ready")
    return {
      value,
      taskWorkspaceRunId: lease.run.runId,
      executionRoot: lease.run.executionRoot,
    }
  } catch {
    return {
      value,
      taskWorkspaceRunId: lease.run.runId,
      executionRoot: lease.run.executionRoot,
      trackingUnavailable: true,
    }
  }
}
