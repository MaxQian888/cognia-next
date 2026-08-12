import type { ResourceRefV1 } from "@cognia/agent-config-types/governance"
import { hasNoLeakingPiiDeep, redactText } from "@cognia/redact"

import { appendGoalEvent, getGoal, updateGoal } from "@/lib/db/goals"
import { getDb } from "@/lib/db/schema"
import { executeDeployedWorkflow } from "@/lib/workflow/runtime/execution-authority"
import { createPublishedWorkflowDependencyBinding } from "@/lib/workflow/runtime/execution-authority"
import { validateAgainstJsonSchema } from "@/lib/workflow/nodes/ai/schema-validate"
import type {
  Goal,
  GoalVerificationInputV1,
  GoalVerificationResultV1,
  GoalVerificationState,
} from "@/types/goal"
import type { WorkflowDependencyBinding, WorkflowVersion } from "@/types/workflow/deployment"

const MAX_SAFE_SUMMARY_BYTES = 8 * 1024
const MAX_EVIDENCE_REFS = 16
export const MAX_GOAL_VERIFICATION_FAILURES = 3

export const GOAL_VERIFICATION_INPUT_SCHEMA = {
  type: "object",
  required: ["contractVersion", "goal", "candidate", "execution"],
  properties: {
    contractVersion: { const: 1 },
    goal: {
      type: "object",
      required: ["id", "safeObjective", "turnsUsed", "tokensUsed"],
      properties: {
        id: { type: "string" },
        safeObjective: { type: "string" },
        turnsUsed: { type: "number" },
        tokensUsed: { type: "number" },
      },
    },
    candidate: {
      type: "object",
      required: ["summary"],
      properties: { summary: { type: "string", maxLength: MAX_SAFE_SUMMARY_BYTES } },
    },
    execution: { type: "array", items: { type: "object" } },
  },
} as const

export const GOAL_VERIFICATION_OUTPUT_SCHEMA = {
  type: "object",
  required: ["passed", "summary"],
  properties: {
    passed: { type: "boolean" },
    summary: { type: "string", maxLength: MAX_SAFE_SUMMARY_BYTES },
    evidenceRefs: { type: "array", items: { type: "object" } },
  },
} as const

type ObjectSchema = {
  type?: unknown
  required?: unknown
  const?: unknown
  properties?: Record<string, ObjectSchema>
}

function requires(schema: ObjectSchema, names: readonly string[]): boolean {
  const required = Array.isArray(schema.required) ? schema.required : []
  return names.every((name) => required.includes(name))
}

function coversContract(actual: ObjectSchema, contract: ObjectSchema): boolean {
  if (contract.type !== undefined && actual.type !== contract.type) return false
  if (contract.const !== undefined && actual.const !== contract.const) return false
  const contractRequired = Array.isArray(contract.required) ? contract.required : []
  if (!requires(actual, contractRequired)) return false
  for (const [name, contractProperty] of Object.entries(contract.properties ?? {})) {
    const actualProperty = actual.properties?.[name]
    if (!actualProperty || !coversContract(actualProperty, contractProperty)) return false
  }
  return true
}

/** Conservative admission filter: ambiguous schemas are not offered as verifiers. */
export function isGoalVerificationWorkflowVersion(version: WorkflowVersion): boolean {
  const input = version.interface.inputSchema as ObjectSchema | undefined
  const output = version.interface.outputSchema as ObjectSchema | undefined
  return Boolean(
    input &&
    output &&
    coversContract(input, GOAL_VERIFICATION_INPUT_SCHEMA) &&
    coversContract(output, GOAL_VERIFICATION_OUTPUT_SCHEMA)
  )
}

function validRef(value: unknown): value is ResourceRefV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const ref = value as Record<string, unknown>
  return (
    typeof ref.namespace === "string" &&
    ref.namespace.length > 0 &&
    typeof ref.type === "string" &&
    ref.type.length > 0 &&
    typeof ref.id === "string" &&
    ref.id.length > 0 &&
    !/^https?:\/\//i.test(ref.id)
  )
}

function safeSummary(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`)
  const redacted = redactText(value.trim()).redacted
  if (!redacted) throw new Error(`${label} is required`)
  const bytes = new TextEncoder().encode(redacted)
  if (bytes.byteLength > MAX_SAFE_SUMMARY_BYTES) {
    return new TextDecoder().decode(bytes.slice(0, MAX_SAFE_SUMMARY_BYTES)).replace(/\uFFFD$/u, "")
  }
  return redacted
}

async function executionRefs(goal: Goal): Promise<ResourceRefV1[]> {
  const db = getDb()
  const [runs, session] = await Promise.all([
    db.executionRuns.where("sessionId").equals(goal.sessionId).reverse().limit(10).toArray(),
    db.sessions.get(goal.sessionId),
  ])
  const refs: ResourceRefV1[] = runs.map((run) => ({
    namespace: "cognia",
    type: "execution-run",
    id: run.id,
  }))
  const workspace = session?.executionContext?.taskWorkspace
  if (workspace) {
    refs.push({ namespace: "cognia", type: "task-workspace", id: workspace.taskId })
  }
  try {
    const { useArtifactStore } = await import("@/stores/artifact/artifact-store")
    for (const artifact of Object.values(useArtifactStore.getState().artifacts)) {
      if (artifact.sessionId === goal.sessionId) {
        refs.push({ namespace: "cognia", type: "artifact", id: artifact.id })
      }
    }
  } catch {
    // Artifact projection is renderer-only; persisted run/workspace refs remain authoritative.
  }
  return refs.slice(0, 32)
}

function validateResult(output: unknown): GoalVerificationResultV1 {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    throw new Error("Verifier output must be an object")
  }
  const value = output as Record<string, unknown>
  if (typeof value.passed !== "boolean") throw new Error("Verifier output.passed must be boolean")
  const summary = safeSummary(value.summary, "Verifier output.summary")
  const evidenceRefs = value.evidenceRefs ?? []
  if (!Array.isArray(evidenceRefs) || evidenceRefs.length > MAX_EVIDENCE_REFS) {
    throw new Error(`Verifier output.evidenceRefs may contain at most ${MAX_EVIDENCE_REFS} refs`)
  }
  if (!evidenceRefs.every(validRef))
    throw new Error("Verifier output contains an invalid evidence ref")
  return { passed: value.passed, summary, evidenceRefs }
}

export type GoalVerificationOutcome =
  | { kind: "passed"; result: GoalVerificationResultV1 }
  | { kind: "failed"; result: GoalVerificationResultV1; failureCount: number; paused: boolean }
  | { kind: "error"; error: string }
  | { kind: "stale" }

export interface GoalVerificationDependencies {
  execute?: typeof executeDeployedWorkflow
  now?: () => number
}

export async function verifyGoalCompletion(
  input: { goalId: string; candidateSummary: string; capturedGenerationId: string },
  dependencies: GoalVerificationDependencies = {}
): Promise<GoalVerificationOutcome> {
  const goal = await getGoal(input.goalId)
  if (!goal || goal.generationId !== input.capturedGenerationId) return { kind: "stale" }
  const binding = goal.config.verificationWorkflow
  if (!binding) throw new Error("Goal has no verification workflow")
  const prior = goal.verification
  if (prior?.generationId === input.capturedGenerationId && prior.status === "passed") {
    return {
      kind: "passed",
      result: {
        passed: true,
        summary: prior.summary ?? "Verification passed",
        evidenceRefs: prior.evidenceRefs,
      },
    }
  }
  const resumePending =
    prior?.generationId === input.capturedGenerationId &&
    (prior.status === "requested" || prior.status === "running")
  const candidateSummary = resumePending
    ? prior.candidateSummary
    : safeSummary(input.candidateSummary, "Goal completion candidate")
  const attempt = resumePending ? prior.attempt : (prior?.attempt ?? 0) + 1
  const failureCount = prior?.failureCount ?? 0
  const now = dependencies.now ?? Date.now
  const idempotencyKey = resumePending
    ? prior.idempotencyKey
    : `goal-verification:${goal.id}:${input.capturedGenerationId}:${attempt}`
  const requested: GoalVerificationState = {
    attempt,
    status: "requested",
    idempotencyKey,
    generationId: input.capturedGenerationId,
    failureCount,
    candidateSummary,
    updatedAt: now(),
  }
  await updateGoal(goal.id, { verification: requested })
  if (!resumePending) {
    await appendGoalEvent({
      goalId: goal.id,
      kind: "verification_requested",
      payload: { kind: "verification_requested", attempt },
    })
  }

  try {
    const verificationInput: GoalVerificationInputV1 = {
      contractVersion: 1,
      goal: {
        id: goal.id,
        safeObjective: goal.safeObjective,
        turnsUsed: goal.turnsUsed,
        tokensUsed: goal.tokensUsed,
      },
      candidate: { summary: candidateSummary },
      execution: await executionRefs(goal),
    }
    if (!hasNoLeakingPiiDeep(verificationInput)) {
      throw new Error("Goal verification input rejected by the PII gate")
    }
    const inputValidation = validateAgainstJsonSchema(
      GOAL_VERIFICATION_INPUT_SCHEMA,
      verificationInput
    )
    if (!inputValidation.ok) {
      throw new Error(
        `Goal verification input contract failed: ${inputValidation.errors.join("; ")}`
      )
    }
    let admittedRunId: string | undefined
    const execute = dependencies.execute ?? executeDeployedWorkflow
    const execution = await execute({
      workflowId: binding.workflowId,
      entrypoint: "trigger",
      caller: `goal-verifier:${goal.id}`,
      idempotencyKey,
      triggerKind: "trigger.manual",
      payload: { input: verificationInput },
      lockedDependency: binding,
      onAdmitted: (workflowRunId) => {
        admittedRunId = workflowRunId
      },
    })
    const workflowRunId = admittedRunId ?? execution.runId
    await updateGoal(goal.id, {
      verification: {
        ...requested,
        status: "running",
        workflowRunId,
        updatedAt: now(),
      },
    })
    if (!resumePending || prior?.status !== "running") {
      await appendGoalEvent({
        goalId: goal.id,
        kind: "verification_started",
        payload: { kind: "verification_started", attempt, workflowRunId },
      })
    }
    const fresh = await getGoal(goal.id)
    if (!fresh || fresh.generationId !== input.capturedGenerationId) return { kind: "stale" }
    if (execution.result.status !== "succeeded") {
      throw new Error(execution.result.error?.message ?? "Verifier workflow did not succeed")
    }
    const outputValidation = validateAgainstJsonSchema(
      GOAL_VERIFICATION_OUTPUT_SCHEMA,
      execution.result.output
    )
    if (!outputValidation.ok) {
      throw new Error(
        `Goal verification output contract failed: ${outputValidation.errors.join("; ")}`
      )
    }
    const result = validateResult(execution.result.output)
    if (result.passed) {
      await updateGoal(goal.id, {
        verification: {
          ...requested,
          status: "passed",
          workflowRunId: execution.runId,
          summary: result.summary,
          evidenceRefs: result.evidenceRefs,
          updatedAt: now(),
        },
      })
      await appendGoalEvent({
        goalId: goal.id,
        kind: "verification_passed",
        payload: { kind: "verification_passed", attempt, summary: result.summary },
      })
      return { kind: "passed", result }
    }

    const nextFailureCount = failureCount + 1
    const paused = nextFailureCount >= MAX_GOAL_VERIFICATION_FAILURES
    await updateGoal(goal.id, {
      ...(paused ? { status: "paused" as const } : {}),
      verification: {
        ...requested,
        status: "failed",
        workflowRunId: execution.runId,
        failureCount: nextFailureCount,
        summary: result.summary,
        evidenceRefs: result.evidenceRefs,
        updatedAt: now(),
      },
    })
    await appendGoalEvent({
      goalId: goal.id,
      kind: "verification_failed",
      payload: {
        kind: "verification_failed",
        attempt,
        failureCount: nextFailureCount,
        summary: result.summary,
        paused,
      },
    })
    return { kind: "failed", result, failureCount: nextFailureCount, paused }
  } catch (error) {
    const message = safeSummary(
      error instanceof Error ? error.message : String(error),
      "Verifier error"
    )
    await updateGoal(goal.id, {
      status: "paused",
      verification: { ...requested, status: "error", error: message, updatedAt: now() },
    })
    await appendGoalEvent({
      goalId: goal.id,
      kind: "verification_error",
      payload: { kind: "verification_error", attempt, error: message },
    })
    return { kind: "error", error: message }
  }
}

export async function disableGoalVerification(goalId: string): Promise<Goal | null> {
  const goal = await getGoal(goalId)
  if (!goal) return null
  const config = { ...goal.config, verificationWorkflow: undefined }
  const generationId = crypto.randomUUID()
  await updateGoal(goalId, {
    config,
    status: "active",
    generationId,
    awaitingAcceptance: false,
    verification: goal.verification
      ? { ...goal.verification, status: "disabled", generationId, updatedAt: Date.now() }
      : undefined,
  })
  await appendGoalEvent({
    goalId,
    kind: "verification_disabled",
    payload: { kind: "verification_disabled" },
  })
  return (await getGoal(goalId)) ?? null
}

export function goalVerificationFeedback(result: GoalVerificationResultV1): string {
  return `The configured completion verifier rejected the candidate. Continue working and address this feedback:\n\n${result.summary}`
}

export interface GoalVerifierWorkflowOption {
  name: string
  binding: WorkflowDependencyBinding
}

export async function listGoalVerifierWorkflowOptions(): Promise<GoalVerifierWorkflowOption[]> {
  const db = getDb()
  const deployments = await db.workflowDeployments
    .filter(
      (deployment) => deployment.status === "active" && deployment.environment === "production"
    )
    .toArray()
  const options = await Promise.all(
    deployments.map(async (deployment) => {
      const version = await db.workflowVersions.get(deployment.versionId)
      if (!version || !isGoalVerificationWorkflowVersion(version)) return undefined
      try {
        const binding = await createPublishedWorkflowDependencyBinding(deployment.workflowId)
        return { name: version.name, binding }
      } catch {
        return undefined
      }
    })
  )
  return options
    .filter((option): option is GoalVerifierWorkflowOption => Boolean(option))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** Retry a paused candidate without bypassing acceptance or terminal linkage. */
export async function retryPausedGoalVerification(
  goalId: string
): Promise<GoalVerificationOutcome> {
  const goal = await getGoal(goalId)
  if (!goal?.verification) throw new Error("Goal has no verification candidate to retry")
  const outcome = await verifyGoalCompletion({
    goalId,
    candidateSummary: goal.verification.candidateSummary,
    capturedGenerationId: goal.generationId,
  })
  await finalizeGoalVerificationOutcome(goalId, outcome)
  return outcome
}

async function finalizeGoalVerificationOutcome(
  goalId: string,
  outcome: GoalVerificationOutcome
): Promise<void> {
  if (outcome.kind !== "passed") return
  const goal = await getGoal(goalId)
  if (!goal) return
  if (goal.config.requireAcceptance) {
    await updateGoal(goalId, { status: "paused", awaitingAcceptance: true })
    await appendGoalEvent({
      goalId,
      kind: "acceptance_requested",
      payload: { kind: "acceptance_requested", turnNumber: goal.turnsUsed },
    })
  } else {
    await updateGoal(goalId, { status: "completed" })
    await appendGoalEvent({
      goalId,
      kind: "exit_triggered",
      payload: {
        kind: "exit_triggered",
        exit: "judge_done",
        reason: "workflow verification passed",
      },
    })
    const completed = await getGoal(goalId)
    if (completed) {
      const { onGoalTerminal } = await import("./completion-linkage")
      void onGoalTerminal(completed)
    }
  }
}

/** Re-admit only durable requested/running attempts; the idempotency key prevents duplicates. */
export async function reconcilePendingGoalVerifications(): Promise<void> {
  const goals = await getDb()
    .chatGoals.filter(
      (goal) =>
        Boolean(goal.config.verificationWorkflow) &&
        (goal.verification?.status === "requested" || goal.verification?.status === "running")
    )
    .toArray()
  await Promise.all(
    goals.map(async (goal) => {
      const outcome = await verifyGoalCompletion({
        goalId: goal.id,
        candidateSummary: goal.verification!.candidateSummary,
        capturedGenerationId: goal.generationId,
      })
      await finalizeGoalVerificationOutcome(goal.id, outcome)
    })
  )
}
