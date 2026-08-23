import type {
  HumanInputAction,
  HumanInputAssignee,
  HumanInputCompletionPolicy,
  HumanInputField,
  WorkflowHumanInputRequest,
} from "@/types/workflow/human-input"
import type { StepExecutionContext, StepExecutionResult } from "@/types/workflow/visual"
import { getActiveAccountId } from "@/lib/accounts/active-account-id"
import { getDb } from "@/lib/db/schema"
import {
  getHumanInputRequest,
  humanInputRequestId,
  listHumanInputSubmissions,
  markHumanInputRequestTerminal,
  reconcileHumanInputRequest,
  registerHumanInputRequest,
} from "@/lib/db/workflow-human-input"
import { waitForWorkflowWaitpoint } from "@/lib/workflow/runtime/waitpoint-repository"
import {
  notifyHumanInputRequested,
  notifyHumanInputResolved,
} from "@/lib/workflow/runtime/human-input-notify"

const DEFAULT_TIMEOUT_MS = 3 * 24 * 60 * 60 * 1000

interface HumanInputParams {
  title?: unknown
  message?: unknown
  fields?: unknown
  actions?: unknown
  assignees?: unknown
  completionPolicy?: unknown
  timeoutMs?: unknown
  sensitiveRetentionDays?: unknown
}

export async function runHumanInputRequest(
  ctx: StepExecutionContext
): Promise<StepExecutionResult> {
  const params = ctx.params as HumanInputParams
  const title = typeof params.title === "string" ? params.title.trim() : ""
  if (!title) throw new Error("action.humanInput.request: params.title is required")
  if (!Array.isArray(params.fields)) {
    throw new Error("action.humanInput.request: params.fields is required")
  }
  if (!Array.isArray(params.actions) || params.actions.length === 0) {
    throw new Error("action.humanInput.request: params.actions is required")
  }
  if (!Array.isArray(params.assignees) || params.assignees.length === 0) {
    throw new Error("action.humanInput.request: params.assignees is required")
  }

  const id = humanInputRequestId(ctx.runId, ctx.stepId)
  const existing = await getHumanInputRequest(id)
  const run = existing ? undefined : await getDb().workflowRuns.get(ctx.runId)
  const triggeredBy = run?.triggeredBy
  const initiatorId = triggeredBy?.initiator?.principalId
    ? triggeredBy.initiator.principalId
    : triggeredBy?.initiator?.externalSubjectKey
      ? triggeredBy.initiator.externalSubjectKey
      : triggeredBy?.deviceId
        ? `device:${triggeredBy.deviceId}`
        : undefined
  const createdAt = existing?.createdAt ?? Date.now()
  const timeoutMs =
    typeof params.timeoutMs === "number" && params.timeoutMs > 0
      ? params.timeoutMs
      : DEFAULT_TIMEOUT_MS
  const request: WorkflowHumanInputRequest =
    existing ??
    ({
      id,
      accountId: getActiveAccountId(),
      waitpointId: id,
      status: "pending",
      runId: ctx.runId,
      workflowId: ctx.workflowId,
      stepId: ctx.stepId,
      ...(initiatorId ? { initiatorId } : {}),
      title,
      ...(typeof params.message === "string" && params.message ? { message: params.message } : {}),
      fields: params.fields as HumanInputField[],
      actions: params.actions as HumanInputAction[],
      assignees: params.assignees as HumanInputAssignee[],
      completionPolicy: (params.completionPolicy ?? { mode: "any" }) as HumanInputCompletionPolicy,
      ...(typeof params.sensitiveRetentionDays === "number"
        ? { sensitiveRetentionDays: params.sensitiveRetentionDays }
        : {}),
      createdAt,
      expiresAt: createdAt + timeoutMs,
      updatedAt: createdAt,
    } satisfies WorkflowHumanInputRequest)

  await registerHumanInputRequest(request)
  await reconcileHumanInputRequest(id)
  if (!existing) {
    await notifyHumanInputRequested(request)
    ctx.log("info", `Human Input requested (${id}); waiting up to ${timeoutMs}ms`)
  } else {
    ctx.log("info", `Human Input ${id} re-armed after resume`)
  }

  const waitpoint = await waitForWorkflowWaitpoint(id, {
    signal: ctx.signal,
    cancelOnAbort: true,
  })
  if (waitpoint.status === "timed_out") {
    await markHumanInputRequestTerminal(id, "timed_out", waitpoint.updatedAt)
    void notifyHumanInputResolved(request, "timed_out")
    return {
      output: { requestId: id, actionId: "timeout", values: {}, submissions: [] },
      decision: "timeout",
    }
  }
  if (waitpoint.status === "cancelled") {
    await markHumanInputRequestTerminal(id, "cancelled", waitpoint.updatedAt)
    void notifyHumanInputResolved(request, "cancelled")
    throw new Error("workflow waitpoint: cancelled")
  }
  const data = waitpoint.resolution?.data as { actionId?: unknown } | undefined
  const actionId = typeof data?.actionId === "string" ? data.actionId : ""
  if (!actionId || !request.actions.some((action) => action.id === actionId)) {
    throw new Error(`action.humanInput.request: invalid waitpoint resolution for ${id}`)
  }
  const submissions = await listHumanInputSubmissions(id)
  const terminal =
    submissions.find(
      (submission) => submission.responderId === waitpoint.resolution?.respondedBy
    ) ?? submissions[submissions.length - 1]
  if (!terminal) {
    throw new Error(`action.humanInput.request: resolved request ${id} has no submission`)
  }
  void notifyHumanInputResolved(request, "completed")
  return {
    output: {
      requestId: id,
      actionId,
      values: terminal.values,
      submissions,
      respondedBy: waitpoint.resolution?.respondedBy,
      respondedAt: waitpoint.resolution?.resolvedAt,
    },
    decision: actionId,
  }
}
