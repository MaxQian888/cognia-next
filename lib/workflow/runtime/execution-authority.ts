import { nanoid } from "nanoid"

import { getDb } from "@/lib/db/schema"
import { resolveWorkflowDeployment } from "@/lib/db/workflow-deployments"
import { validateAgainstJsonSchema } from "@/lib/workflow/nodes/ai/schema-validate"
import { workflowVersionDigest } from "@/lib/workflow/versioning/version-snapshot"
import type {
  WorkflowEntrypoint,
  WorkflowExecutionBinding,
  WorkflowInvocation,
  WorkflowVersion,
} from "@/types/workflow/deployment"
import type {
  TriggerEvent,
  WorkflowNodeKind,
  WorkflowTriggerBinding,
  WorkflowTriggeredFrom,
} from "@/types/workflow/visual"
import { runWorkflow, type RunWorkflowResult } from "./orchestrator"

export class WorkflowAdmissionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly detail?: unknown
  ) {
    super(message)
    this.name = "WorkflowAdmissionError"
  }
}

export interface ExecuteDeployedWorkflowInput {
  workflowId: string
  environment?: string
  entrypoint: WorkflowEntrypoint
  caller: string
  idempotencyKey?: string
  authorizedScopes?: readonly string[]
  triggerKind: WorkflowNodeKind
  triggerId?: string
  triggerBinding?: WorkflowTriggerBinding
  payload: unknown
  signal?: AbortSignal
  triggeredBy?: WorkflowTriggeredFrom
  /** Server-generated correlation id used by legacy Companion dispatch. */
  requestedRunId?: string
  /** Called after the admission ledger has durably reserved the run id. */
  onAdmitted?: (runId: string) => void
  /** Called after the orchestrator has persisted the WorkflowRun row. */
  onPersisted?: (runId: string) => void
}

export interface ExecuteDeployedWorkflowResult {
  invocationId: string
  runId: string
  reused: boolean
  version: WorkflowVersion
  executionBinding: WorkflowExecutionBinding
  result: RunWorkflowResult
}

function invocationId(input: {
  accountId: string
  entrypoint: WorkflowEntrypoint
  deploymentId: string
  caller: string
  idempotencyKey?: string
}): string {
  if (!input.idempotencyKey) return `wfi_${nanoid(16)}`
  return `wfi_${workflowVersionDigest(input).slice("wfv1:".length)}`
}

function assertScope(scopes: readonly string[] | undefined): void {
  if (scopes && !scopes.includes("workflow:run") && !scopes.includes("workflow:admin")) {
    throw new WorkflowAdmissionError("scope-denied", "workflow:run scope is required")
  }
}

/**
 * Canonical formal-execution ingress. Draft/editor calls deliberately continue
 * to call `runWorkflow` directly; every published surface resolves and pins an
 * immutable deployment here before a run row can be created.
 */
export async function executeDeployedWorkflow(
  input: ExecuteDeployedWorkflowInput
): Promise<ExecuteDeployedWorkflowResult> {
  assertScope(input.authorizedScopes)
  const resolved = await resolveWorkflowDeployment(input.workflowId, input.environment, {
    entrypoint: input.entrypoint,
    caller: input.caller,
    idempotencyKey: input.idempotencyKey,
  })
  if (!resolved) {
    throw new WorkflowAdmissionError(
      "deployment-not-found",
      `No active ${input.environment ?? "production"} deployment for workflow ${input.workflowId}`
    )
  }

  const now = Date.now()
  const id = invocationId({
    accountId: resolved.deployment.accountId,
    entrypoint: input.entrypoint,
    deploymentId: resolved.deployment.id,
    caller: input.caller,
    idempotencyKey: input.idempotencyKey,
  })
  const proposedRunId = input.requestedRunId ?? `run_${nanoid(12)}`

  // Idempotency precedes schema validation. A retry belongs to the original
  // admission even when the deployment pointer has since moved to a version
  // with a different interface.
  const existingInvocation = input.idempotencyKey
    ? await getDb().workflowInvocations.get(id)
    : undefined
  if (existingInvocation) {
    return reuseInvocation(existingInvocation, input.onAdmitted)
  }

  if (input.triggerId) {
    const triggerNode = resolved.workflow.nodes.find((node) => node.id === input.triggerId)
    if (
      !triggerNode ||
      triggerNode.type !== input.triggerKind ||
      triggerNode.data.disabled === true
    ) {
      throw new WorkflowAdmissionError(
        "trigger-binding-invalid",
        `Trigger ${input.triggerId} is missing, disabled, or not ${input.triggerKind}`
      )
    }
  }

  const runInput =
    input.payload && typeof input.payload === "object" && "input" in input.payload
      ? (input.payload as { input?: unknown }).input
      : input.payload
  const inputSchema = resolved.version.interface.inputSchema
  if (inputSchema && Object.keys(inputSchema).length > 0) {
    const validation = validateAgainstJsonSchema(inputSchema, runInput ?? {})
    if (!validation.ok) {
      throw new WorkflowAdmissionError(
        "input-schema-violation",
        `Workflow input does not match the deployed schema: ${validation.errors.join("; ")}`,
        { errors: validation.errors }
      )
    }
  }

  const invocation: WorkflowInvocation = {
    id,
    accountId: resolved.deployment.accountId,
    entrypoint: input.entrypoint,
    caller: input.caller,
    deploymentId: resolved.deployment.id,
    deploymentRevision: resolved.deployment.revision,
    versionId: resolved.version.id,
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    runId: proposedRunId,
    status: "admitted",
    createdAt: now,
    updatedAt: now,
  }
  let admission: { invocation: WorkflowInvocation; reused: boolean }
  try {
    await getDb().workflowInvocations.add(invocation)
    admission = { invocation, reused: false }
  } catch (error) {
    // Idempotent requests use a deterministic primary key. A concurrent
    // winner may insert between our read and add; the losing add resolves to
    // that durable row rather than starting a second run.
    const existing = input.idempotencyKey ? await getDb().workflowInvocations.get(id) : undefined
    if (!existing) throw error
    admission = { invocation: existing, reused: true }
  }

  const runId = admission.invocation.runId!
  input.onAdmitted?.(runId)
  if (admission.reused) {
    return reuseInvocation(admission.invocation)
  }

  await getDb().workflowInvocations.update(admission.invocation.id, {
    status: "running",
    updatedAt: Date.now(),
  })
  const trigger: TriggerEvent = {
    workflowId: resolved.workflow.id,
    kind: input.triggerKind,
    ...(input.triggerId ? { triggerId: input.triggerId } : {}),
    ...(input.triggerBinding ? { binding: input.triggerBinding } : {}),
    payload: input.payload,
    originAt: Date.now(),
  }
  const executionBinding: WorkflowExecutionBinding = {
    ...resolved.binding,
    invocationId: admission.invocation.id,
  }
  try {
    const result = await runWorkflow({
      workflow: resolved.workflow,
      trigger,
      runId,
      signal: input.signal,
      triggeredBy: input.triggeredBy,
      executionBinding,
      onPersisted: input.onPersisted,
    })
    await getDb().workflowInvocations.update(admission.invocation.id, {
      status: "completed",
      updatedAt: Date.now(),
    })
    return {
      invocationId: admission.invocation.id,
      runId,
      reused: false,
      version: resolved.version,
      executionBinding,
      result,
    }
  } catch (error) {
    await getDb().workflowInvocations.update(admission.invocation.id, {
      status: "rejected",
      updatedAt: Date.now(),
    })
    throw error
  }
}

async function reuseInvocation(
  invocation: WorkflowInvocation,
  onAdmitted?: (runId: string) => void
): Promise<ExecuteDeployedWorkflowResult> {
  const runId = invocation.runId
  if (!runId) {
    throw new WorkflowAdmissionError(
      "invocation-corrupt",
      `Workflow invocation ${invocation.id} has no run id`
    )
  }
  const version = await getDb().workflowVersions.get(invocation.versionId)
  if (!version) {
    throw new WorkflowAdmissionError(
      "invocation-version-missing",
      `Workflow invocation ${invocation.id} references missing version ${invocation.versionId}`
    )
  }
  onAdmitted?.(runId)
  const existingRun = await getDb().workflowRuns.get(runId)
  return {
    invocationId: invocation.id,
    runId,
    reused: true,
    version,
    executionBinding: {
      invocationId: invocation.id,
      versionId: invocation.versionId,
      deploymentId: invocation.deploymentId,
      deploymentRevision: invocation.deploymentRevision,
      entrypoint: invocation.entrypoint,
      caller: invocation.caller,
      ...(invocation.idempotencyKey ? { idempotencyKey: invocation.idempotencyKey } : {}),
    },
    result: existingRun
      ? {
          runId,
          status: existingRun.status,
          output: existingRun.output,
          error: existingRun.error,
        }
      : { runId, status: "pending" },
  }
}
