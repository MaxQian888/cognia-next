import { getActiveAccountId } from "@/lib/accounts/active-account-id"
import { redactText } from "@cognia/redact"
import { getDb } from "@/lib/db/schema"
import { getWorkflowDeploymentById } from "@/lib/db/workflow-deployments"
import { cancelWorkflowRun } from "@/lib/workflow/runtime/cancel-run"
import {
  executeDeployedWorkflow,
  WorkflowAdmissionError,
} from "@/lib/workflow/runtime/execution-authority"
import type { WorkflowEntrypoint } from "@/types/workflow/deployment"
import type { RunStatus, WorkflowRunRow } from "@/types/workflow/visual"

const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set(["succeeded", "failed", "cancelled"])
const SENSITIVE_KEY = /(?:authorization|cookie|password|secret|token|api[-_]?key)/i

export class WorkflowApiServiceError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly details?: unknown
  ) {
    super(message)
    this.name = "WorkflowApiServiceError"
  }
}

function assertScope(scopes: readonly string[], required: "workflow:run" | "workflow:read"): void {
  if (scopes.includes(required) || scopes.includes("workflow:admin")) return
  throw new WorkflowApiServiceError("scope_denied", 403, `${required} scope is required`)
}

function assertActiveAccount(accountId: string): void {
  if (accountId === getActiveAccountId()) return
  // Do not reveal whether an id exists in another account database.
  throw new WorkflowApiServiceError("run_not_found", 404, "Workflow run was not found")
}

function redact(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return redactText(value).redacted
  if (depth > 20) return "[REDACTED]"
  if (value === null || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1))
  const output: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    output[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : redact(child, depth + 1)
  }
  return output
}

async function getOwnedRun(accountId: string, runId: string): Promise<WorkflowRunRow> {
  assertActiveAccount(accountId)
  const run = await getDb().workflowRuns.get(runId)
  if (!run?.deploymentId) {
    throw new WorkflowApiServiceError("run_not_found", 404, "Workflow run was not found")
  }
  const deployment = await getDb().workflowDeployments.get(run.deploymentId)
  if (!deployment || deployment.accountId !== accountId) {
    throw new WorkflowApiServiceError("run_not_found", 404, "Workflow run was not found")
  }
  return run
}

export interface CreateWorkflowApiRunInput {
  accountId: string
  deploymentId: string
  /** Trusted host-selected origin. Public HTTP bridge payloads always use the default. */
  entrypoint?: WorkflowEntrypoint
  caller: string
  scopes: readonly string[]
  idempotencyKey?: string
  input: unknown
}

export interface WorkflowApiRunAccepted {
  runId: string
  status: RunStatus
}

/** Admit an HTTP run and return as soon as the authority reserves its durable run id. */
export async function createWorkflowApiRun(
  input: CreateWorkflowApiRunInput
): Promise<WorkflowApiRunAccepted> {
  assertScope(input.scopes, "workflow:run")
  if (input.accountId !== getActiveAccountId()) {
    throw new WorkflowApiServiceError(
      "deployment_not_found",
      404,
      "Workflow deployment was not found"
    )
  }
  const deployment = await getWorkflowDeploymentById(input.deploymentId, input.accountId)
  if (!deployment || deployment.status !== "active") {
    throw new WorkflowApiServiceError(
      "deployment_not_found",
      404,
      "Workflow deployment was not found"
    )
  }

  let resolveAdmission: (runId: string) => void = () => undefined
  const admitted = new Promise<string>((resolve) => {
    resolveAdmission = resolve
  })
  const execution = executeDeployedWorkflow({
    workflowId: deployment.workflowId,
    environment: deployment.environment,
    entrypoint: input.entrypoint ?? "http",
    caller: input.caller,
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    authorizedScopes: input.scopes,
    triggerKind: "trigger.manual",
    payload: { input: input.input },
    triggeredBy: { source: "api" },
    onAdmitted: resolveAdmission,
  })

  let runId: string
  try {
    runId = await Promise.race([execution.then((result) => result.runId), admitted])
  } catch (error) {
    if (error instanceof WorkflowAdmissionError) {
      const status = error.code === "input-schema-violation" ? 422 : 409
      throw new WorkflowApiServiceError(
        error.code.replaceAll("-", "_"),
        status,
        error.message,
        error.detail
      )
    }
    throw error
  }

  const run = await getDb().workflowRuns.get(runId)
  return { runId, status: run?.status ?? "pending" }
}

export interface GetWorkflowApiRunInput {
  accountId: string
  runId: string
  scopes: readonly string[]
}

export interface WorkflowApiRunView {
  runId: string
  workflowId: string
  versionId?: string
  deploymentId?: string
  deploymentRevision?: number
  status: RunStatus
  startedAt: number
  completedAt?: number
  output?: unknown
  error?: { message: string; nodeId?: string; code?: string }
}

export async function getWorkflowApiRun(
  input: GetWorkflowApiRunInput
): Promise<WorkflowApiRunView> {
  assertScope(input.scopes, "workflow:read")
  const run = await getOwnedRun(input.accountId, input.runId)
  return {
    runId: run.id,
    workflowId: run.workflowId,
    ...(run.versionId ? { versionId: run.versionId } : {}),
    ...(run.deploymentId ? { deploymentId: run.deploymentId } : {}),
    ...(run.deploymentRevision !== undefined ? { deploymentRevision: run.deploymentRevision } : {}),
    status: run.status,
    startedAt: run.startedAt,
    ...(run.completedAt !== undefined ? { completedAt: run.completedAt } : {}),
    ...(run.output !== undefined ? { output: redact(run.output) } : {}),
    ...(run.error
      ? {
          error: {
            message: redactText(run.error.message).redacted,
            ...(run.error.nodeId ? { nodeId: run.error.nodeId } : {}),
            ...(run.error.code ? { code: run.error.code } : {}),
          },
        }
      : {}),
  }
}

export interface WorkflowApiEventView {
  runId: string
  sequence: number
  type: string
  timestamp: string
  stepId?: string
  level?: string
  payload?: unknown
}

export interface ListWorkflowApiEventsInput extends GetWorkflowApiRunInput {
  afterSequence: number
  limit?: number
}

export async function listWorkflowApiEvents(input: ListWorkflowApiEventsInput): Promise<{
  events: WorkflowApiEventView[]
  terminal: boolean
}> {
  assertScope(input.scopes, "workflow:read")
  const run = await getOwnedRun(input.accountId, input.runId)
  const limit = Math.max(1, Math.min(input.limit ?? 200, 1_000))
  const events = await getDb()
    .workflowRunEvents.where("[runId+sequence]")
    .between(
      [input.runId, Math.max(0, input.afterSequence)],
      [input.runId, Number.MAX_SAFE_INTEGER],
      false,
      true
    )
    .limit(limit)
    .toArray()
  return {
    events: events.map((event) => ({
      runId: event.runId,
      sequence: event.sequence!,
      type: event.type,
      timestamp: new Date(event.ts).toISOString(),
      ...(event.stepId ? { stepId: event.stepId } : {}),
      ...(event.level ? { level: event.level } : {}),
      ...(event.payload !== undefined ? { payload: redact(event.payload) } : {}),
    })),
    // A terminal run can still have more than one page of durable events.
    // Keep the stream open until a short final page proves the cursor caught up.
    terminal: TERMINAL_STATUSES.has(run.status) && events.length < limit,
  }
}

export interface CancelWorkflowApiRunInput extends GetWorkflowApiRunInput {
  caller: string
}

export async function cancelWorkflowApiRun(input: CancelWorkflowApiRunInput): Promise<{
  runId: string
  cancelled: boolean
  mode: string
}> {
  assertScope(input.scopes, "workflow:run")
  await getOwnedRun(input.accountId, input.runId)
  const result = await cancelWorkflowRun(
    input.runId,
    `cancelled via workflow API by ${input.caller}`
  )
  return { runId: input.runId, cancelled: result.cancelled, mode: result.mode }
}

export type WorkflowApiBridgeCommand =
  | "workflow_api_run_create"
  | "workflow_api_run_get"
  | "workflow_api_events_list"
  | "workflow_api_run_cancel"

export type WorkflowApiBridgeResponse =
  | { ok: true; data: unknown }
  | {
      ok: false
      error: { code: string; status: number; message: string; details?: unknown }
    }

function requiredString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key]
  if (typeof value !== "string" || !value.trim()) {
    throw new WorkflowApiServiceError("invalid_request", 400, `${key} is required`)
  }
  return value
}

function scopesFrom(payload: Record<string, unknown>): string[] {
  const value = payload.scopes
  if (!Array.isArray(value) || !value.every((scope) => typeof scope === "string")) {
    throw new WorkflowApiServiceError("invalid_request", 400, "scopes must be a string array")
  }
  return value
}

/** Stable JSON bridge used by both Desktop and Headless Companion transports. */
export async function dispatchWorkflowApiBridgeCommand(
  command: WorkflowApiBridgeCommand,
  payload: Record<string, unknown>
): Promise<WorkflowApiBridgeResponse> {
  try {
    const accountId = requiredString(payload, "accountId")
    const scopes = scopesFrom(payload)
    switch (command) {
      case "workflow_api_run_create":
        return {
          ok: true,
          data: await createWorkflowApiRun({
            accountId,
            deploymentId: requiredString(payload, "deploymentId"),
            caller: requiredString(payload, "caller"),
            scopes,
            ...(typeof payload.idempotencyKey === "string" && payload.idempotencyKey
              ? { idempotencyKey: payload.idempotencyKey }
              : {}),
            input: payload.input ?? {},
          }),
        }
      case "workflow_api_run_get":
        return {
          ok: true,
          data: await getWorkflowApiRun({
            accountId,
            runId: requiredString(payload, "runId"),
            scopes,
          }),
        }
      case "workflow_api_events_list": {
        const afterSequence = payload.afterSequence ?? 0
        if (
          typeof afterSequence !== "number" ||
          !Number.isSafeInteger(afterSequence) ||
          afterSequence < 0
        ) {
          throw new WorkflowApiServiceError(
            "invalid_event_cursor",
            400,
            "Last-Event-ID must be a non-negative safe integer"
          )
        }
        return {
          ok: true,
          data: await listWorkflowApiEvents({
            accountId,
            runId: requiredString(payload, "runId"),
            scopes,
            afterSequence,
          }),
        }
      }
      case "workflow_api_run_cancel":
        return {
          ok: true,
          data: await cancelWorkflowApiRun({
            accountId,
            runId: requiredString(payload, "runId"),
            caller: requiredString(payload, "caller"),
            scopes,
          }),
        }
    }
  } catch (error) {
    if (error instanceof WorkflowApiServiceError) {
      return {
        ok: false,
        error: {
          code: error.code,
          status: error.status,
          message: error.message,
          ...(error.details !== undefined ? { details: redact(error.details) } : {}),
        },
      }
    }
    return {
      ok: false,
      error: {
        code: "internal_error",
        status: 500,
        message: "The workflow service could not complete the request",
      },
    }
  }
}
