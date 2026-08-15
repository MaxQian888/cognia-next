/**
 * `workflow` scheduled-task executor.
 *
 * Runs a published visual workflow through the canonical admission ingress
 * (`executeDeployedWorkflow`, ADR-0011 / ADR-0090) — the same path every other
 * published surface (HTTP, MCP, portal, skill, CLI) uses — so a timed run
 * pins an immutable deployment, honours the input schema, the risk gate and
 * the run ledger exactly like a human-initiated one. Nothing here reaches
 * into the orchestrator directly.
 *
 * Provenance: `entrypoint: "schedule"` + `triggeredBy.source: "schedule"` +
 * `caller: "scheduler:task:<taskId>"` so run history can tell a scheduled
 * run apart. `WorkflowTriggeredFrom.source === "schedule"` is a
 * NON-interactive source: a workflow with risk gating enabled fails a gated
 * step instead of waiting for a human (see `lib/workflow/runtime/risk-gate.ts`).
 *
 * Host neutrality: `executeDeployedWorkflow` itself is host-neutral (Dexie +
 * orchestrator); individual steps may still require host capabilities and
 * fail per step. This executor therefore declares no host requirement in
 * `TASK_TYPE_HOST_REQUIREMENTS`.
 *
 * Note this is distinct from the workflow's OWN cron trigger nodes (Rust
 * cron daemon → `workflow:trigger` → `dispatchTrigger`): those are surfaced
 * on the scheduler page as the unified `workflow` kind. A `workflow` TASK is
 * for scheduling any published workflow from the app scheduler with the
 * scheduler's own trigger / retry / overlap / notification model.
 */

import type {
  ScheduledTask,
  TaskExecution,
  TaskExecutorResult,
  WorkflowTaskPayload,
} from "@/types/scheduler"
import { loggers } from "@cognia/logging"

const log = loggers.scheduler

const TERMINAL_SUCCESS_STATUSES: ReadonlySet<string> = new Set(["succeeded"])

type NormalizedWorkflowPayload =
  { ok: true; payload: WorkflowTaskPayload } | { ok: false; error: string }

function normalizePayload(raw: unknown): NormalizedWorkflowPayload {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "workflow task requires a payload with `workflowId`" }
  }
  const payload = raw as Partial<WorkflowTaskPayload>
  if (typeof payload.workflowId !== "string" || payload.workflowId.trim().length === 0) {
    return { ok: false, error: "workflow task requires `workflowId` in payload" }
  }
  const environment =
    typeof payload.environment === "string" && payload.environment.trim().length > 0
      ? payload.environment.trim()
      : undefined
  const triggerId =
    typeof payload.triggerId === "string" && payload.triggerId.trim().length > 0
      ? payload.triggerId.trim()
      : undefined
  const idempotencyKey =
    typeof payload.idempotencyKey === "string" && payload.idempotencyKey.trim().length > 0
      ? payload.idempotencyKey.trim()
      : undefined
  return {
    ok: true,
    payload: {
      workflowId: payload.workflowId.trim(),
      environment,
      inputs: payload.inputs,
      triggerId,
      idempotencyKey,
    },
  }
}

export async function executeWorkflowTask(
  task: ScheduledTask,
  execution: TaskExecution,
  signal: AbortSignal
): Promise<TaskExecutorResult> {
  const normalized = normalizePayload(task.payload)
  if (!normalized.ok) return { success: false, error: normalized.error }
  const payload = normalized.payload

  if (signal.aborted) {
    return { success: false, error: "Workflow task aborted before start" }
  }

  // Lazy import keeps the workflow runtime graph out of the scheduler
  // executor module graph at load time (and out of test hoisting order).
  const { executeDeployedWorkflow, WorkflowAdmissionError } =
    await import("@/lib/workflow/runtime/execution-authority")

  const startedAt = Date.now()
  let admittedRunId: string | undefined
  try {
    const result = await executeDeployedWorkflow({
      workflowId: payload.workflowId,
      environment: payload.environment,
      entrypoint: "schedule",
      caller: `scheduler:task:${task.id}`,
      idempotencyKey: payload.idempotencyKey ?? `${task.id}:${execution.id}`,
      triggerKind: payload.triggerId ? "trigger.cron" : "trigger.manual",
      triggerId: payload.triggerId,
      triggerOriginAt: execution.scheduledFor?.getTime() ?? execution.startedAt.getTime(),
      payload: payload.inputs ?? {},
      signal,
      triggeredBy: { source: "schedule" },
      onAdmitted: (runId) => {
        admittedRunId = runId
      },
    })

    const status = String(result.result.status)
    const success = TERMINAL_SUCCESS_STATUSES.has(status)
    const output: Record<string, unknown> = {
      runId: result.runId,
      invocationId: result.invocationId,
      reused: result.reused,
      status,
      versionId: result.version.id,
      environment: payload.environment ?? "production",
      durationMs: Date.now() - startedAt,
    }
    if (result.result.output !== undefined) output.result = result.result.output
    if (result.result.error) output.error = result.result.error

    log.info("Scheduler workflow task settled", {
      taskId: task.id,
      executionId: execution.id,
      workflowId: payload.workflowId,
      runId: result.runId,
      status,
    })

    if (success) return { success: true, output }
    if (status === "cancelled" && signal.aborted) {
      return { success: false, output, error: "Workflow run was cancelled" }
    }
    return {
      success: false,
      output,
      error: result.result.error?.message ?? `Workflow run ended with status "${status}"`,
    }
  } catch (err) {
    const output: Record<string, unknown> = { workflowId: payload.workflowId }
    if (admittedRunId) output.runId = admittedRunId
    if (err instanceof WorkflowAdmissionError) {
      log.warn("Scheduler workflow task refused at admission", {
        taskId: task.id,
        workflowId: payload.workflowId,
        code: err.code,
      })
      output.admissionCode = err.code
      return { success: false, output, error: `${err.code}: ${err.message}` }
    }
    const message = err instanceof Error ? err.message : String(err)
    log.error("Scheduler workflow task failed", { taskId: task.id, error: message })
    return { success: false, output, error: message }
  }
}
