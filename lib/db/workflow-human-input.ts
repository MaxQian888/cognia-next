import type {
  HumanInputActor,
  HumanInputAssignee,
  HumanInputField,
  HumanInputSubmissionResult,
  HumanInputValue,
  WorkflowHumanInputRequest,
  WorkflowHumanInputSubmission,
  WorkflowHumanInputSubmissionRow,
} from "@/types/workflow/human-input"
import {
  openHumanInputValues,
  sealHumanInputValues,
  type HumanInputCryptoDeps,
} from "@/lib/workflow/runtime/human-input-crypto"
import { getDb } from "./schema"
import { createWorkflowWaitpoint, decideWorkflowWaitpoint } from "./workflow-waitpoints"

export function humanInputRequestId(runId: string, stepId: string): string {
  return `hir_${runId}_${stepId}`
}

function assigneeKey(assignee: HumanInputAssignee): string {
  return assignee.kind === "initiator" ? "initiator" : `${assignee.kind}:${assignee.id}`
}

function matchedAssignees(assignees: HumanInputAssignee[], actor: HumanInputActor): string[] {
  const groups = new Set(actor.groupIds ?? [])
  return assignees.flatMap((assignee) => {
    if (assignee.kind === "initiator") return actor.isInitiator ? [assigneeKey(assignee)] : []
    if (assignee.kind === "member") return assignee.id === actor.id ? [assigneeKey(assignee)] : []
    return groups.has(assignee.id) ? [assigneeKey(assignee)] : []
  })
}

export function isHumanInputAssigned(
  request: WorkflowHumanInputRequest,
  actor: HumanInputActor
): boolean {
  return matchedAssignees(request.assignees, actor).length > 0
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function validateField(field: HumanInputField, value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") {
    return field.required ? `${field.id} is required` : undefined
  }
  if (field.type === "short-text" || field.type === "long-text" || field.type === "file") {
    return isNonEmptyString(value) ? undefined : `${field.id} must be a non-empty string`
  }
  if (field.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) return `${field.id} must be a number`
    if (field.min !== undefined && value < field.min) return `${field.id} is below its minimum`
    if (field.max !== undefined && value > field.max) return `${field.id} is above its maximum`
    return undefined
  }
  if (field.type === "boolean") {
    return typeof value === "boolean" ? undefined : `${field.id} must be a boolean`
  }
  if (field.type === "single-select") {
    const allowed = new Set((field.options ?? []).map((option) => option.value))
    return typeof value === "string" && allowed.has(value)
      ? undefined
      : `${field.id} is not an allowed option`
  }
  if (field.type === "multi-select" || field.type === "file-list") {
    if (!Array.isArray(value) || value.some((item) => !isNonEmptyString(item))) {
      return `${field.id} must be a string array`
    }
    if (field.type === "multi-select") {
      const allowed = new Set((field.options ?? []).map((option) => option.value))
      if (value.some((item) => !allowed.has(item))) return `${field.id} has an unknown option`
    }
    if (field.maxFiles !== undefined && value.length > field.maxFiles) {
      return `${field.id} exceeds its file limit`
    }
  }
  return undefined
}

function validateValues(
  request: WorkflowHumanInputRequest,
  values: Record<string, HumanInputValue>
): string | undefined {
  const fieldIds = new Set(request.fields.map((field) => field.id))
  const unknown = Object.keys(values).find((id) => !fieldIds.has(id))
  if (unknown) return `unknown field: ${unknown}`
  for (const field of request.fields) {
    const invalid = validateField(field, values[field.id])
    if (invalid) return invalid
  }
  return undefined
}

function completionReached(
  request: WorkflowHumanInputRequest,
  submissions: WorkflowHumanInputSubmission[]
): boolean {
  if (request.completionPolicy.mode === "any") return submissions.length >= 1
  if (request.completionPolicy.mode === "quorum") {
    return submissions.length >= request.completionPolicy.count
  }
  const satisfied = new Set(submissions.flatMap((submission) => submission.matchedAssigneeKeys))
  return request.assignees.every((assignee) => satisfied.has(assigneeKey(assignee)))
}

export async function registerHumanInputRequest(
  request: WorkflowHumanInputRequest
): Promise<WorkflowHumanInputRequest> {
  const existing = await getDb().workflowHumanInputRequests.get(request.id)
  if (existing) return existing
  await createWorkflowWaitpoint({
    id: request.waitpointId,
    kind: "human_input",
    status: "pending",
    runId: request.runId,
    workflowId: request.workflowId,
    stepId: request.stepId,
    key: `human-input:${request.runId}:${request.stepId}`,
    title: request.title,
    ...(request.message ? { message: request.message } : {}),
    createdAt: request.createdAt,
    notBefore: request.createdAt,
    expiresAt: request.expiresAt,
    updatedAt: request.createdAt,
  })
  await getDb().workflowHumanInputRequests.add(request)
  return request
}

export function getHumanInputRequest(id: string): Promise<WorkflowHumanInputRequest | undefined> {
  return getDb().workflowHumanInputRequests.get(id)
}

export async function listPendingHumanInputRequests(): Promise<WorkflowHumanInputRequest[]> {
  return getDb().workflowHumanInputRequests.where("status").equals("pending").sortBy("createdAt")
}

export async function listHumanInputSubmissions(
  requestId: string,
  deps: HumanInputCryptoDeps = {},
  now = Date.now()
): Promise<WorkflowHumanInputSubmission[]> {
  const request = await getHumanInputRequest(requestId)
  if (!request) return []
  const rows = await getDb()
    .workflowHumanInputSubmissions.where("requestId")
    .equals(requestId)
    .sortBy("submittedAt")
  return Promise.all(rows.map((row) => hydrateSubmission(request, row, deps, now)))
}

async function hydrateSubmission(
  request: WorkflowHumanInputRequest,
  row: WorkflowHumanInputSubmissionRow,
  deps: HumanInputCryptoDeps,
  now: number
): Promise<WorkflowHumanInputSubmission> {
  const expired =
    row.sensitiveValuesExpired === true ||
    (row.sensitiveExpiresAt !== undefined && row.sensitiveExpiresAt <= now)
  const sensitiveValues =
    row.encryptedSensitiveValues && !expired
      ? await openHumanInputValues(
          row.encryptedSensitiveValues,
          {
            accountId: request.accountId,
            requestId: request.id,
            responderId: row.responderId,
          },
          deps
        )
      : {}
  return {
    id: row.id,
    requestId: row.requestId,
    responderId: row.responderId,
    matchedAssigneeKeys: row.matchedAssigneeKeys,
    actionId: row.actionId,
    values: { ...row.values, ...sensitiveValues },
    submittedAt: row.submittedAt,
    ...(expired ? { sensitiveValuesExpired: true } : {}),
  }
}

export async function markHumanInputRequestTerminal(
  id: string,
  status: "timed_out" | "cancelled",
  now = Date.now()
): Promise<void> {
  const request = await getHumanInputRequest(id)
  if (!request || request.status !== "pending") return
  await getDb().workflowHumanInputRequests.put({
    ...request,
    status,
    updatedAt: now,
    completedAt: now,
  })
}

export async function submitHumanInput(
  input: {
    requestId: string
    actor: HumanInputActor
    actionId: string
    values: Record<string, HumanInputValue>
    now?: number
  },
  deps: HumanInputCryptoDeps = {}
): Promise<HumanInputSubmissionResult> {
  const db = getDb()
  const now = input.now ?? Date.now()
  const preliminary = await db.workflowHumanInputRequests.get(input.requestId)
  if (!preliminary) return { ok: false, reason: "not-found" }
  if (preliminary.status !== "pending") return { ok: false, reason: "not-pending" }
  const preliminaryMatches = matchedAssignees(preliminary.assignees, input.actor)
  if (preliminaryMatches.length === 0) return { ok: false, reason: "not-assigned" }
  if (!preliminary.actions.some((action) => action.id === input.actionId)) {
    return { ok: false, reason: "invalid-action" }
  }
  const preliminaryInvalid = validateValues(preliminary, input.values)
  if (preliminaryInvalid) {
    return { ok: false, reason: "invalid-values", message: preliminaryInvalid }
  }
  const sensitiveIds = new Set(
    preliminary.fields.filter((field) => field.sensitive).map((field) => field.id)
  )
  const storedValues = Object.fromEntries(
    Object.entries(input.values).map(([id, value]) => [id, sensitiveIds.has(id) ? null : value])
  ) as Record<string, HumanInputValue>
  const sensitiveValues = Object.fromEntries(
    Object.entries(input.values).filter(([id]) => sensitiveIds.has(id))
  ) as Record<string, HumanInputValue>
  const encryptedSensitiveValues =
    Object.keys(sensitiveValues).length > 0
      ? await sealHumanInputValues(
          sensitiveValues,
          {
            accountId: preliminary.accountId,
            requestId: preliminary.id,
            responderId: input.actor.id,
          },
          deps
        )
      : undefined
  const result = await db.transaction<HumanInputSubmissionResult>(
    "rw",
    db.workflowHumanInputRequests,
    db.workflowHumanInputSubmissions,
    async () => {
      const request = await db.workflowHumanInputRequests.get(input.requestId)
      if (!request) return { ok: false, reason: "not-found" }
      if (request.status !== "pending") return { ok: false, reason: "not-pending" }
      const matchedAssigneeKeys = matchedAssignees(request.assignees, input.actor)
      if (matchedAssigneeKeys.length === 0) return { ok: false, reason: "not-assigned" }
      if (!request.actions.some((action) => action.id === input.actionId)) {
        return { ok: false, reason: "invalid-action" }
      }
      const invalid = validateValues(request, input.values)
      if (invalid) return { ok: false, reason: "invalid-values", message: invalid }
      const id = `${request.id}:${input.actor.id}`
      if (await db.workflowHumanInputSubmissions.get(id)) {
        return { ok: false, reason: "already-submitted" }
      }
      const row: WorkflowHumanInputSubmissionRow = {
        id,
        requestId: request.id,
        responderId: input.actor.id,
        matchedAssigneeKeys,
        actionId: input.actionId,
        values: storedValues,
        submittedAt: now,
        ...(encryptedSensitiveValues ? { encryptedSensitiveValues } : {}),
        ...(encryptedSensitiveValues
          ? {
              sensitiveExpiresAt:
                now + (request.sensitiveRetentionDays ?? 30) * 24 * 60 * 60 * 1000,
            }
          : {}),
      }
      await db.workflowHumanInputSubmissions.add(row)
      const submissions = [
        ...(await db.workflowHumanInputSubmissions.where("requestId").equals(request.id).toArray()),
      ]
      const completed = completionReached(request, submissions)
      const next: WorkflowHumanInputRequest = completed
        ? {
            ...request,
            status: "completed",
            finalActionId: row.actionId,
            completedAt: now,
            updatedAt: now,
          }
        : { ...request, updatedAt: now }
      await db.workflowHumanInputRequests.put(next)
      const submission: WorkflowHumanInputSubmission = {
        id: row.id,
        requestId: row.requestId,
        responderId: row.responderId,
        matchedAssigneeKeys: row.matchedAssigneeKeys,
        actionId: row.actionId,
        values: input.values,
        submittedAt: row.submittedAt,
      }
      return { ok: true, request: next, submission, completed }
    }
  )

  if (result.ok && result.completed) {
    const submissions = await listHumanInputSubmissions(result.request.id, deps, now)
    await decideWorkflowWaitpoint(result.request.waitpointId, {
      outcome: "event",
      respondedBy: result.submission.responderId,
      data: {
        actionId: result.submission.actionId,
        submissionIds: submissions.map((submission) => submission.id),
      },
      resolvedAt: result.submission.submittedAt,
    })
  }
  return result
}

/** Repair the only cross-store crash window: completed request before waitpoint CAS. */
export async function reconcileHumanInputRequest(id: string): Promise<void> {
  const request = await getHumanInputRequest(id)
  if (!request || request.status !== "completed" || !request.finalActionId) return
  const submissions = await listHumanInputSubmissions(id)
  const terminal = submissions[submissions.length - 1]
  if (!terminal) return
  await decideWorkflowWaitpoint(request.waitpointId, {
    outcome: "event",
    respondedBy: terminal.responderId,
    data: {
      actionId: request.finalActionId,
      submissionIds: submissions.map((submission) => submission.id),
    },
    resolvedAt: request.completedAt ?? terminal.submittedAt,
  })
}

/** Remove expired sensitive ciphertext while preserving non-sensitive audit metadata. */
export async function pruneExpiredHumanInputSensitiveValues(now = Date.now()): Promise<number> {
  const db = getDb()
  const rows = await db.workflowHumanInputSubmissions
    .where("sensitiveExpiresAt")
    .belowOrEqual(now)
    .toArray()
  if (rows.length === 0) return 0
  await db.workflowHumanInputSubmissions.bulkPut(
    rows.map(({ encryptedSensitiveValues: _encrypted, ...row }) => ({
      ...row,
      sensitiveValuesExpired: true as const,
    }))
  )
  return rows.length
}
