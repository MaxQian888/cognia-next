import { nanoid } from "nanoid"
import { generateTraceId } from "@cognia/logging"
import Dexie from "dexie"

import { getDb } from "@/lib/db/schema"
import { migrateWorkflow } from "@/lib/workflow/definition/migrate"
import {
  resolveLockedWorkflowDeployment,
  resolveWorkflowDeployment,
} from "@/lib/db/workflow-deployments"
import { validateAgainstJsonSchema } from "@/lib/workflow/nodes/ai/schema-validate"
import { workflowVersionDigest } from "@/lib/workflow/versioning/version-snapshot"
import type {
  WorkflowEntrypoint,
  WorkflowDependencyBinding,
  WorkflowDependencyLock,
  WorkflowExecutionBinding,
  WorkflowInvocation,
  WorkflowVersion,
} from "@/types/workflow/deployment"
import type {
  TriggerEvent,
  VisualWorkflow,
  WorkflowNodeKind,
  WorkflowRunLineage,
  WorkflowRunSecurityContext,
  WorkflowRunRow,
  WorkflowTriggerBinding,
  WorkflowTriggeredFrom,
} from "@/types/workflow/visual"
import { runWorkflow, type RunWorkflowResult } from "./orchestrator"
import { getRunStepOutputs } from "./run-from-step"
import { isWorkflowDeploymentControlPlaneEnabled } from "./feature-flags"

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
  /** Original producer timestamp; defaults to local admission time. */
  triggerOriginAt?: number
  payload: unknown
  signal?: AbortSignal
  triggeredBy?: WorkflowTriggeredFrom
  traceId?: string
  lineage?: WorkflowRunLineage
  securityContext?: WorkflowRunSecurityContext
  retry?: {
    retryOfRunId: string
    retryMode: import("@/types/workflow/visual").WorkflowRetryMode
    operatedBy: string
    startStepId?: string
    seedRunId?: string
  }
  /** Server-generated correlation id used by legacy Companion dispatch. */
  requestedRunId?: string
  /** Exact child artifact selected by an already-admitted parent run. */
  lockedDependency?: WorkflowDependencyBinding
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

const activeInvocations = new Map<string, Promise<ExecuteDeployedWorkflowResult>>()

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

function assertTriggerBinding(
  workflow: VisualWorkflow,
  triggerId: string | undefined,
  triggerKind: WorkflowNodeKind
): void {
  if (!triggerId) return
  const triggerNode = workflow.nodes.find((node) => node.id === triggerId)
  if (!triggerNode || triggerNode.type !== triggerKind || triggerNode.data.disabled === true) {
    throw new WorkflowAdmissionError(
      "trigger-binding-invalid",
      `Trigger ${triggerId} is missing, disabled, or not ${triggerKind}`
    )
  }
}

async function lockWorkflowDependencies(
  version: WorkflowVersion,
  environment = "production",
  ancestors: ReadonlySet<string> = new Set([version.workflowId])
): Promise<WorkflowDependencyLock> {
  const workflows: WorkflowDependencyLock["workflows"] = {}
  for (const dependency of version.dependencyManifest.workflows) {
    const resolved = await resolveWorkflowDeployment(dependency.workflowId, environment)
    if (!resolved) {
      throw new WorkflowAdmissionError(
        "dependency-not-deployed",
        `Subworkflow ${dependency.workflowId} used by node ${dependency.nodeId} is not deployed`
      )
    }
    const cyclic = ancestors.has(resolved.version.workflowId)
    if (cyclic) {
      throw new WorkflowAdmissionError(
        "dependency-cycle",
        `Subworkflow dependency cycle reaches ${resolved.version.workflowId} at node ${dependency.nodeId}`
      )
    }
    workflows[dependency.nodeId] = {
      workflowId: resolved.version.workflowId,
      versionId: resolved.version.id,
      deploymentId: resolved.deployment.id,
      deploymentRevision: resolved.deployment.revision,
      dependencyLock: await lockWorkflowDependencies(
        resolved.version,
        environment,
        new Set([...ancestors, resolved.version.workflowId])
      ),
    }
  }
  return { workflows, indexes: {} }
}

/** Resolve and freeze the complete production deployment graph for a caller-owned binding. */
export async function createPublishedWorkflowDependencyBinding(
  workflowId: string,
  environment = "production"
): Promise<WorkflowDependencyBinding> {
  const resolved = await resolveWorkflowDeployment(workflowId, environment, {
    entrypoint: "trigger",
    caller: "binding-resolver",
  })
  if (!resolved) {
    throw new WorkflowAdmissionError(
      "deployment-not-found",
      `No active ${environment} deployment for workflow ${workflowId}`
    )
  }
  return {
    workflowId,
    versionId: resolved.version.id,
    deploymentId: resolved.deployment.id,
    deploymentRevision: resolved.deployment.revision,
    dependencyLock: await lockWorkflowDependencies(resolved.version, environment),
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
  if (!isWorkflowDeploymentControlPlaneEnabled()) {
    return executeLegacyPublishedWorkflow(input)
  }
  const provenance = {
    entrypoint: input.entrypoint,
    caller: input.caller,
    idempotencyKey: input.idempotencyKey,
  }
  if (input.lockedDependency && input.lockedDependency.workflowId !== input.workflowId) {
    throw new WorkflowAdmissionError(
      "dependency-lock-invalid",
      `Locked workflow ${input.lockedDependency.workflowId} does not match requested workflow ${input.workflowId}`
    )
  }
  const resolved = input.lockedDependency
    ? await resolveLockedWorkflowDeployment(input.lockedDependency, provenance)
    : await resolveWorkflowDeployment(input.workflowId, input.environment, provenance)
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
  const traceId = input.traceId ?? generateTraceId()
  const lineage: WorkflowRunLineage = input.lineage ?? {
    rootRunId: proposedRunId,
    ...(input.retry
      ? { retryOfRunId: input.retry.retryOfRunId, retryMode: input.retry.retryMode }
      : {}),
  }
  const securityContext: WorkflowRunSecurityContext = input.securityContext ?? {
    piiEgressRequired:
      input.triggerKind === "trigger.connector.inbound" ||
      input.triggerKind === "trigger.connector.system",
    sourceTriggerKind: input.triggerKind,
  }

  // Idempotency precedes schema validation. A retry belongs to the original
  // admission even when the deployment pointer has since moved to a version
  // with a different interface.
  const existingInvocation = input.idempotencyKey
    ? await getDb().workflowInvocations.get(id)
    : undefined
  if (existingInvocation) {
    return reuseInvocation(existingInvocation, input.onAdmitted)
  }

  assertTriggerBinding(resolved.workflow, input.triggerId, input.triggerKind)

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

  const dependencyLock =
    input.lockedDependency?.dependencyLock ??
    (await lockWorkflowDependencies(resolved.version, input.environment))
  const executionBinding: WorkflowExecutionBinding = {
    ...resolved.binding,
    dependencyLock,
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
    dependencyLock,
    ...(input.retry
      ? {
          retryOfRunId: input.retry.retryOfRunId,
          retryMode: input.retry.retryMode,
          operatedBy: input.retry.operatedBy,
          ...(input.retry.startStepId ? { startStepId: input.retry.startStepId } : {}),
          ...(input.retry.seedRunId ? { seedRunId: input.retry.seedRunId } : {}),
        }
      : {}),
    createdAt: now,
    updatedAt: now,
  }
  const trigger: TriggerEvent = {
    workflowId: resolved.workflow.id,
    kind: input.triggerKind,
    ...(input.triggerId ? { triggerId: input.triggerId } : {}),
    ...(input.triggerBinding ? { binding: input.triggerBinding } : {}),
    payload: input.payload,
    originAt: input.triggerOriginAt ?? now,
  }
  executionBinding.invocationId = invocation.id
  const pendingRun: WorkflowRunRow = {
    id: proposedRunId,
    workflowId: resolved.workflow.id,
    versionId: resolved.version.id,
    deploymentId: resolved.deployment.id,
    deploymentRevision: resolved.deployment.revision,
    executionBinding,
    dependencyLock,
    status: "pending",
    triggerKind: trigger.kind,
    ...(trigger.triggerId ? { triggerId: trigger.triggerId } : {}),
    triggerPayload: trigger.payload,
    triggerOriginAt: trigger.originAt,
    ...(trigger.binding ? { triggerBinding: trigger.binding } : {}),
    startedAt: now,
    workflowSnapshot: resolved.workflow,
    ...(input.triggeredBy ? { triggeredBy: input.triggeredBy } : {}),
    triggeredBySource: input.triggeredBy?.source ?? "ui",
    traceId,
    lineage,
    securityContext,
  }
  let admission: { invocation: WorkflowInvocation; reused: boolean }
  try {
    const db = getDb()
    await Dexie.ignoreTransaction(() =>
      db.transaction("rw", db.workflowInvocations, db.workflowRuns, () => {
        // The admission ledger and its externally visible pending run are one
        // durability unit. A process crash can no longer leave an invocation
        // that points at a run id absent from status/events APIs.
        return Promise.all([
          db.workflowInvocations.add(invocation),
          db.workflowRuns.add(pendingRun),
        ]).then(() => undefined)
      })
    )
    admission = { invocation, reused: false }
  } catch (error) {
    // Idempotent requests use a deterministic primary key. A concurrent
    // winner may insert between our read and add; the losing add resolves to
    // that durable row rather than starting a second run.
    const existing = input.idempotencyKey ? await getDb().workflowInvocations.get(id) : undefined
    if (!existing) {
      const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      throw new Error(`Workflow admission transaction failed: ${detail}`, { cause: error })
    }
    admission = { invocation: existing, reused: true }
  }

  const runId = admission.invocation.runId!
  if (admission.reused) {
    return reuseInvocation(admission.invocation, input.onAdmitted)
  }
  // Notify surfaces before starting the driver. Plugin hooks may open their
  // own Dexie transactions; running them concurrently with the first driver
  // update leaks fake-indexeddb's transaction zone and can abort admission.
  input.onAdmitted?.(runId)
  const driving = driveInvocation({
    invocation: admission.invocation,
    version: resolved.version,
    workflow: resolved.workflow,
    trigger,
    executionBinding,
    signal: input.signal,
    triggeredBy: input.triggeredBy,
    traceId,
    lineage,
    securityContext,
    startStepId: input.retry?.startStepId,
    seedRunId: input.retry?.seedRunId,
    onPersisted: input.onPersisted,
  })
  activeInvocations.set(admission.invocation.id, driving)
  try {
    return await driving
  } finally {
    if (activeInvocations.get(admission.invocation.id) === driving) {
      activeInvocations.delete(admission.invocation.id)
    }
  }
}

async function executeLegacyPublishedWorkflow(
  input: ExecuteDeployedWorkflowInput
): Promise<ExecuteDeployedWorkflowResult> {
  const stored = await getDb().workflows.get(input.workflowId)
  if (!stored?.published) {
    throw new WorkflowAdmissionError(
      "deployment-not-found",
      `Workflow ${input.workflowId} has no legacy publication`
    )
  }
  const persistedVersion = stored.published.versionId
    ? await getDb().workflowVersions.get(stored.published.versionId)
    : undefined
  if (!persistedVersion) {
    throw new WorkflowAdmissionError(
      "publication-version-missing",
      `Workflow ${input.workflowId} publication has no immutable version artifact`
    )
  }
  const version = persistedVersion
  const immutableWorkflow = migrateWorkflow(version.definition)
  assertTriggerBinding(immutableWorkflow, input.triggerId, input.triggerKind)
  const runId = input.requestedRunId ?? `run_${nanoid(12)}`
  const traceId = input.traceId ?? generateTraceId()
  const lineage: WorkflowRunLineage = input.lineage ?? {
    rootRunId: runId,
    ...(input.retry
      ? { retryOfRunId: input.retry.retryOfRunId, retryMode: input.retry.retryMode }
      : {}),
  }
  const securityContext: WorkflowRunSecurityContext = input.securityContext ?? {
    piiEgressRequired:
      input.triggerKind === "trigger.connector.inbound" ||
      input.triggerKind === "trigger.connector.system",
    sourceTriggerKind: input.triggerKind,
  }
  const executionBinding: WorkflowExecutionBinding = {
    versionId: version.id,
    deploymentId: stored.published.deploymentId ?? `legacy:${immutableWorkflow.id}`,
    deploymentRevision: stored.published.deploymentRevision ?? 0,
    entrypoint: input.entrypoint,
    caller: input.caller,
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
  }
  const seedOutputs = input.retry?.seedRunId
    ? await getRunStepOutputs(input.retry.seedRunId)
    : undefined
  const result = await runWorkflow({
    workflow: immutableWorkflow,
    runId,
    trigger: {
      workflowId: immutableWorkflow.id,
      kind: input.triggerKind,
      ...(input.triggerId ? { triggerId: input.triggerId } : {}),
      ...(input.triggerBinding ? { binding: input.triggerBinding } : {}),
      payload: input.payload,
      originAt: input.triggerOriginAt ?? Date.now(),
    },
    executionBinding,
    traceId,
    lineage,
    securityContext,
    ...(input.retry?.startStepId ? { startStepId: input.retry.startStepId } : {}),
    ...(seedOutputs ? { seedOutputs } : {}),
    signal: input.signal,
    triggeredBy: input.triggeredBy,
    onPersisted: (persistedRunId) => {
      input.onAdmitted?.(persistedRunId)
      input.onPersisted?.(persistedRunId)
    },
  })
  return {
    invocationId: `legacy:${runId}`,
    runId,
    reused: false,
    version,
    executionBinding,
    result,
  }
}

interface DriveInvocationInput {
  invocation: WorkflowInvocation
  version: WorkflowVersion
  workflow: import("@/types/workflow/visual").VisualWorkflow
  trigger: TriggerEvent
  executionBinding: WorkflowExecutionBinding
  signal?: AbortSignal
  triggeredBy?: WorkflowTriggeredFrom
  traceId?: string
  lineage?: WorkflowRunLineage
  securityContext?: WorkflowRunSecurityContext
  startStepId?: string
  seedRunId?: string
  onPersisted?: (runId: string) => void
}

async function driveInvocation(
  input: DriveInvocationInput
): Promise<ExecuteDeployedWorkflowResult> {
  const runId = input.invocation.runId!
  await getDb().workflowInvocations.update(input.invocation.id, {
    status: "running",
    updatedAt: Date.now(),
  })
  try {
    const seedOutputs = input.seedRunId ? await getRunStepOutputs(input.seedRunId) : undefined
    const result = await runWorkflow({
      workflow: input.workflow,
      trigger: input.trigger,
      runId,
      signal: input.signal,
      triggeredBy: input.triggeredBy,
      executionBinding: input.executionBinding,
      traceId: input.traceId,
      lineage: input.lineage,
      securityContext: input.securityContext,
      ...(input.startStepId ? { startStepId: input.startStepId } : {}),
      ...(seedOutputs ? { seedOutputs } : {}),
      onPersisted: input.onPersisted,
    })
    await getDb().workflowInvocations.update(input.invocation.id, {
      status: "completed",
      updatedAt: Date.now(),
    })
    return {
      invocationId: input.invocation.id,
      runId,
      reused: false,
      version: input.version,
      executionBinding: input.executionBinding,
      result,
    }
  } catch (error) {
    await getDb().workflowInvocations.update(input.invocation.id, {
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
  const active = activeInvocations.get(invocation.id)
  if (active) {
    return { ...(await active), reused: true }
  }
  if (existingRun?.status === "pending") {
    // No in-process driver owns this durable admission. This is the recovery
    // path after a process crash between admission and orchestrator startup.
    const executionBinding: WorkflowExecutionBinding = {
      invocationId: invocation.id,
      versionId: invocation.versionId,
      deploymentId: invocation.deploymentId,
      deploymentRevision: invocation.deploymentRevision,
      entrypoint: invocation.entrypoint,
      caller: invocation.caller,
      ...(invocation.idempotencyKey ? { idempotencyKey: invocation.idempotencyKey } : {}),
      ...(invocation.dependencyLock ? { dependencyLock: invocation.dependencyLock } : {}),
    }
    const trigger: TriggerEvent = {
      workflowId: version.workflowId,
      kind: existingRun.triggerKind,
      ...(existingRun.triggerId ? { triggerId: existingRun.triggerId } : {}),
      ...(existingRun.triggerBinding ? { binding: existingRun.triggerBinding } : {}),
      payload: existingRun.triggerPayload,
      originAt: existingRun.startedAt,
    }
    const recovery = driveInvocation({
      invocation,
      version,
      workflow: version.definition,
      trigger,
      executionBinding,
      triggeredBy: existingRun.triggeredBy,
      traceId: existingRun.traceId,
      lineage: existingRun.lineage,
      securityContext: existingRun.securityContext,
      startStepId: invocation.startStepId,
      seedRunId: invocation.seedRunId,
    })
    activeInvocations.set(invocation.id, recovery)
    try {
      return { ...(await recovery), reused: true }
    } finally {
      if (activeInvocations.get(invocation.id) === recovery) {
        activeInvocations.delete(invocation.id)
      }
    }
  }
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
      ...(invocation.dependencyLock ? { dependencyLock: invocation.dependencyLock } : {}),
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

export interface ExecuteWorkflowVersionInput extends Omit<
  ExecuteDeployedWorkflowInput,
  "lockedDependency"
> {
  versionId: string
  deploymentId: string
  deploymentRevision: number
  dependencyLock?: WorkflowDependencyLock
}

/** Formal execution of one explicitly selected immutable artifact. */
export function executeWorkflowVersion(
  input: ExecuteWorkflowVersionInput
): Promise<ExecuteDeployedWorkflowResult> {
  const { versionId, deploymentId, deploymentRevision, dependencyLock, ...rest } = input
  return executeDeployedWorkflow({
    ...rest,
    lockedDependency: {
      workflowId: input.workflowId,
      versionId,
      deploymentId,
      deploymentRevision,
      ...(dependencyLock ? { dependencyLock } : {}),
    },
  })
}

export interface RetryWorkflowRunInput {
  runId: string
  mode: import("@/types/workflow/visual").WorkflowRetryMode
  operatedBy: string
  startStepId?: string
  signal?: AbortSignal
  /**
   * Origin to attach to the replacement, overriding the `{ source: "ui" }`
   * default.
   *
   * A retry driven from the surface that ASKED for the work has to keep
   * reporting there: dropping the seed's IM origin would start a run whose
   * progress fans back to nobody, which is indistinguishable from the retry not
   * having happened. The desktop history view keeps the default, because a
   * retry pressed there is a desktop action.
   */
  triggeredBy?: WorkflowTriggeredFrom
  /** Called after the admission ledger has durably reserved the run id. */
  onAdmitted?: (runId: string) => void
  /** Called after the orchestrator has persisted the WorkflowRun row. */
  onPersisted?: (runId: string) => void
}

/**
 * Create a new formal invocation for one of the three operator-visible retry
 * modes. The seed run is immutable; no history row is overwritten.
 */
export async function retryWorkflowRun(
  input: RetryWorkflowRunInput
): Promise<ExecuteDeployedWorkflowResult> {
  const seed = await getDb().workflowRuns.get(input.runId)
  if (!seed) throw new WorkflowAdmissionError("seed-run-not-found", `Run ${input.runId} not found`)
  const binding = seed.executionBinding
  if (!binding || !seed.versionId || !seed.deploymentId) {
    throw new WorkflowAdmissionError(
      "seed-run-not-formal",
      `Run ${input.runId} has no immutable execution binding and can only be replayed in local debug mode`
    )
  }
  const requestedRunId = `run_${nanoid(12)}`
  const common: ExecuteDeployedWorkflowInput = {
    workflowId: seed.workflowId,
    entrypoint: "desktop",
    caller: input.operatedBy,
    triggerKind: seed.triggerKind,
    ...(seed.triggerId ? { triggerId: seed.triggerId } : {}),
    ...(seed.triggerBinding ? { triggerBinding: seed.triggerBinding } : {}),
    triggerOriginAt: Date.now(),
    payload: seed.triggerPayload,
    signal: input.signal,
    requestedRunId,
    ...(seed.traceId ? { traceId: seed.traceId } : {}),
    triggeredBy: input.triggeredBy ?? { source: "ui" },
    ...(input.onAdmitted ? { onAdmitted: input.onAdmitted } : {}),
    ...(input.onPersisted ? { onPersisted: input.onPersisted } : {}),
    lineage: {
      rootRunId: seed.lineage?.rootRunId ?? seed.id,
      retryOfRunId: seed.id,
      retryMode: input.mode,
    },
    securityContext: seed.securityContext,
    retry: {
      retryOfRunId: seed.id,
      retryMode: input.mode,
      operatedBy: input.operatedBy,
      ...(input.mode === "failed-step"
        ? {
            startStepId: input.startStepId ?? seed.error?.nodeId,
            seedRunId: seed.id,
          }
        : {}),
    },
  }
  if (input.mode === "failed-step" && !common.retry?.startStepId) {
    throw new WorkflowAdmissionError(
      "failed-step-missing",
      `Run ${seed.id} has no failed step to continue from`
    )
  }
  if (input.mode === "current-deployment") return executeDeployedWorkflow(common)
  return executeWorkflowVersion({
    ...common,
    versionId: binding.versionId,
    deploymentId: binding.deploymentId,
    deploymentRevision: binding.deploymentRevision,
    dependencyLock: binding.dependencyLock ?? seed.dependencyLock,
  })
}
