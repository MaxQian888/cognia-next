/**
 * `action.approval.request` executor (ADR 0061 P2) — the human-in-the-loop
 * gate. Blocks the step until a human approves or rejects, then routes
 * downstream via the `approved` / `rejected` decision handles.
 *
 * Crash-resume: the first entry appends a `step.long_running.checkpoint`
 * event (key `approval-request`) recording `requestedAt`. A re-entered step
 * (no `step_completed` yet) finds the checkpoint, re-registers the pending
 * approval WITHOUT re-notifying (no duplicate push), and keeps the original
 * timeout budget. Responses only resolve against a live orchestrator — the
 * registry is in-memory by design (see approval-registry.ts).
 *
 * Not retryable: a retry would re-ask the human a question they may already
 * have answered.
 */

import type { StepExecutionContext, StepExecutionResult } from "@/types/workflow/visual"
import { listRunEvents, appendEvent } from "@/lib/workflow/runtime/event-log"
import { findLatestCheckpoint } from "@/lib/workflow/runtime/long-step-runner"
import { subscribeWake } from "@/lib/workflow/runtime/wake-bus"
import {
  approvalId,
  approvalWakeKey,
  registerPendingApproval,
  removePendingApproval,
  type ApprovalResponse,
  type PendingApproval,
} from "@/lib/workflow/runtime/approval-registry"
import {
  notifyApprovalRequested,
  notifyApprovalResolved,
} from "@/lib/workflow/runtime/approval-notify"

export const APPROVAL_CHECKPOINT_KEY = "approval-request"

/** Default wait budget before the onTimeout policy applies: 1 hour. */
const DEFAULT_TIMEOUT_MS = 3_600_000

interface ApprovalParams {
  title?: unknown
  message?: unknown
  timeoutMs?: unknown
  onTimeout?: unknown
}

interface ApprovalCheckpointState {
  approvalId: string
  requestedAt: number
}

export async function runApprovalRequest(ctx: StepExecutionContext): Promise<StepExecutionResult> {
  const params = ctx.params as ApprovalParams
  const title = typeof params.title === "string" ? params.title.trim() : ""
  if (!title) throw new Error("action.approval.request: params.title is required")
  const message = typeof params.message === "string" && params.message ? params.message : undefined
  const timeoutMs =
    typeof params.timeoutMs === "number" && params.timeoutMs > 0
      ? params.timeoutMs
      : DEFAULT_TIMEOUT_MS
  const onTimeout = params.onTimeout === "fail" ? "fail" : "reject"

  const id = approvalId(ctx.runId, ctx.stepId)

  // Crash-resume detection: a prior checkpoint means we already notified.
  let requestedAt = Date.now()
  let fresh = true
  try {
    const events = await listRunEvents(ctx.runId)
    const prior = findLatestCheckpoint(events, ctx.stepId)
    if (prior && prior.checkpointKey === APPROVAL_CHECKPOINT_KEY) {
      const state = prior.state as Partial<ApprovalCheckpointState> | undefined
      if (state && typeof state.requestedAt === "number") {
        requestedAt = state.requestedAt
        fresh = false
      }
    }
  } catch {
    // No readable event log (unit-level runs) — treat as fresh.
  }

  const timeoutAt = requestedAt + timeoutMs
  const entry: PendingApproval = {
    approvalId: id,
    runId: ctx.runId,
    workflowId: ctx.workflowId,
    stepId: ctx.stepId,
    title,
    ...(message ? { message } : {}),
    requestedAt,
    timeoutAt,
  }

  const timeoutOutcome = (): StepExecutionResult => {
    if (onTimeout === "fail") {
      throw new Error(`action.approval.request: no response within ${timeoutMs}ms`)
    }
    return {
      output: { approvalId: id, decision: "rejected", respondedBy: "timeout", respondedAt: null },
      decision: "rejected",
    }
  }

  registerPendingApproval(entry)
  try {
    if (fresh) {
      const state: ApprovalCheckpointState = { approvalId: id, requestedAt }
      try {
        await appendEvent({
          runId: ctx.runId,
          stepId: ctx.stepId,
          type: "step.long_running.checkpoint",
          payload: { checkpointKey: APPROVAL_CHECKPOINT_KEY, state },
        })
      } catch (err) {
        console.warn("approval request: checkpoint persistence failed", err)
      }
      await notifyApprovalRequested(entry)
      ctx.log("info", `Approval requested (${id}); waiting up to ${timeoutMs}ms`)
    } else {
      ctx.log("info", `Approval ${id} re-armed after resume; original request preserved`)
    }

    const remaining = timeoutAt - Date.now()
    if (remaining <= 0) return timeoutOutcome()

    let wake
    try {
      wake = await subscribeWake(approvalWakeKey(ctx.runId, ctx.stepId), {
        timeoutMs: remaining,
        signal: ctx.signal,
      })
    } catch (err) {
      // The wake bus rejects with in-repo contract messages: "… timed out
      // after Nms" for timeouts, "wake bus: aborted" for run cancellation.
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes("timed out")) return timeoutOutcome()
      throw err
    }

    const response = wake.data as ApprovalResponse
    void notifyApprovalResolved(entry, response.decision)
    ctx.log("info", `Approval ${id} ${response.decision} by ${response.respondedBy}`)
    return {
      output: {
        approvalId: id,
        decision: response.decision,
        respondedBy: response.respondedBy,
        respondedAt: wake.emittedAt,
      },
      decision: response.decision,
    }
  } finally {
    removePendingApproval(id)
  }
}
