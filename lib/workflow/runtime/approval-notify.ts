/**
 * Fan-out for `action.approval.request` (ADR 0061 P2).
 *
 * A fresh approval reaches humans through three surfaces:
 *
 *  1. Desktop notification center (`notify()`, `directed: true`) with
 *     persisted Approve / Reject actions — the command handler installed by
 *     {@link installApprovalNotificationActions} resolves the registry.
 *  2. `workflow://approval-request` — live WS frame to foreground paired
 *     devices. Carries the full title/message: the WS channel terminates on
 *     the paired device itself (TLS-pinned / HMAC WebRTC), same trust as
 *     chat streaming.
 *  3. `workflow://approval-pending` — push trigger for backgrounded devices.
 *     Ids ONLY: this payload transits APNs/FCM, so no user-authored text.
 *
 * Resolution emits `workflow://approval-resolved` so foreground devices
 * clear their pending list immediately.
 *
 * Notification copy is English by precedent (runtime notifications — see
 * TeamNotifier / handoff.ts). Companion delivery uses the host-neutral event
 * publisher, so both a desktop and a headless brain reach paired devices. All
 * delivery is best-effort: a lost frame degrades to the pending-approvals RPC
 * (`workflow_approval_list`) the mobile card polls on mount / refresh.
 */

import { registerNotificationCommand } from "@/lib/notifications/action-registry"
import { emitCompanionEvent } from "./companion-run-events"
import { respondToApproval, type ApprovalDecision, type PendingApproval } from "./approval-registry"

export const APPROVAL_REQUEST_CHANNEL = "workflow://approval-request"
export const APPROVAL_PENDING_PUSH_CHANNEL = "workflow://approval-pending"
export const APPROVAL_RESOLVED_CHANNEL = "workflow://approval-resolved"

/** Notification-action command key (persisted on center rows). */
export const APPROVAL_RESPOND_COMMAND = "workflow.approval.respond"

export interface ApprovalNotifyDeps {
  notify?: (input: {
    source: "workflow"
    level: "warning"
    title: string
    body?: string
    href: string
    dedupeKey: string
    directed: true
    sourceRef: { kind: string; id: string }
    actions: Array<{
      id: string
      label: string
      command: string
      args: Record<string, unknown>
      variant?: "primary" | "secondary"
    }>
  }) => Promise<string>
  emit?: (event: string, payload: unknown) => Promise<void>
}

async function defaultNotify(
  input: Parameters<NonNullable<ApprovalNotifyDeps["notify"]>>[0]
): Promise<string> {
  const { notify } = await import("@/lib/notifications/runtime")
  return notify(input)
}

/** Announce a fresh approval on every surface. Best-effort, never throws. */
export async function notifyApprovalRequested(
  entry: PendingApproval,
  deps: ApprovalNotifyDeps = {}
): Promise<void> {
  try {
    await (deps.notify ?? defaultNotify)({
      source: "workflow",
      level: "warning",
      title: `Approval requested: ${entry.title}`,
      ...(entry.message ? { body: entry.message } : {}),
      href: `/workflows/${entry.workflowId}/runs/${entry.runId}`,
      dedupeKey: entry.approvalId,
      directed: true,
      sourceRef: { kind: "workflow-approval", id: entry.approvalId },
      actions: [
        {
          id: "approve",
          label: "Approve",
          command: APPROVAL_RESPOND_COMMAND,
          args: { approvalId: entry.approvalId, decision: "approved" },
          variant: "primary",
        },
        {
          id: "reject",
          label: "Reject",
          command: APPROVAL_RESPOND_COMMAND,
          args: { approvalId: entry.approvalId, decision: "rejected" },
          variant: "secondary",
        },
      ],
    })
  } catch (err) {
    console.warn("approval notify: notification center delivery failed", err)
  }

  const emit = deps.emit ?? emitCompanionEvent
  try {
    await emit(APPROVAL_REQUEST_CHANNEL, entry)
    await emit(APPROVAL_PENDING_PUSH_CHANNEL, {
      approvalId: entry.approvalId,
      runId: entry.runId,
      workflowId: entry.workflowId,
    })
  } catch (err) {
    console.warn("approval notify: companion fan-out failed", err)
  }
}

/** Announce a resolution so foreground devices drop it from their list. */
export async function notifyApprovalResolved(
  entry: Pick<PendingApproval, "approvalId" | "runId" | "workflowId">,
  decision: ApprovalDecision,
  deps: ApprovalNotifyDeps = {}
): Promise<void> {
  try {
    await (deps.emit ?? emitCompanionEvent)(APPROVAL_RESOLVED_CHANNEL, {
      approvalId: entry.approvalId,
      runId: entry.runId,
      workflowId: entry.workflowId,
      decision,
    })
  } catch (err) {
    console.warn("approval notify: resolved fan-out failed", err)
  }
}

/**
 * Install the notification-action command handler. Mounted once at boot by
 * the workflow runtime provider; returns the unregister function.
 */
export function installApprovalNotificationActions(): () => void {
  return registerNotificationCommand(APPROVAL_RESPOND_COMMAND, async (ctx) => {
    const approvalIdArg = ctx.args?.approvalId
    const decision = ctx.args?.decision
    if (typeof approvalIdArg !== "string") return
    if (decision !== "approved" && decision !== "rejected") return
    await respondToApproval(approvalIdArg, { decision, respondedBy: "desktop" })
  })
}
