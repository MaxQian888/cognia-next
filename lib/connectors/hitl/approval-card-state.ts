import { enqueueGoverned } from "@/lib/connectors/delivery-gateway"
import { waitForOutboundTerminal } from "@/lib/db/outbound-jobs"
import { appendAudit } from "@/lib/connectors/audit"
import { buildLarkCommandFrame } from "@/lib/connectors/adapters/lark/card"
import type { ConversationReference } from "@/types/connectors/event"
import type { MessageSegment } from "@/types/connectors/segment"

export type ApprovalCardState =
  "approved" | "denied" | "expired" | "processed" | "failed" | "answered" | "skipped" | "cancelled"

export function approvalStateSegment(state: ApprovalCardState, detail?: string): MessageSegment {
  const title = {
    approved: "✓ 已批准 / Approved",
    denied: "⊘ 已拒绝 / Denied",
    expired: "◷ 已过期 / Expired",
    processed: "✓ 已处理 / Processed",
    failed: "✕ 处理失败 / Failed",
    answered: "✓ 已回答 / Answered",
    skipped: "↷ 已跳过 / Skipped",
    cancelled: "⊘ 已停止 / Stopped",
  }[state]
  const trimmed = detail?.trim()
  return {
    type: "card",
    card: {
      kind: "lark",
      payload: buildLarkCommandFrame(
        title,
        [
          ...(trimmed ? [{ tag: "markdown" as const, content: trimmed.slice(0, 500) }] : []),
          {
            tag: "markdown",
            content:
              "此请求已结束，操作按钮已移除。 / This request is closed. Its action buttons have been removed.",
          },
        ],
        state === "approved" || state === "processed" || state === "answered"
          ? "success"
          : "warning"
      ),
    },
  }
}

/** Edit through the durable, governed queue so transient platform errors retry. */
export async function settleApprovalCard(input: {
  adapterId: string
  conversationKey: string
  conversationRef: ConversationReference
  surfaceId: string
  state: ApprovalCardState
  messageId?: string
  jobId?: string
  /** Optional echo rendered above the closed notice (e.g. the given answer). */
  detail?: string
}): Promise<void> {
  if (input.conversationRef.platform !== "lark") return
  try {
    const delivery =
      !input.messageId && input.jobId ? await waitForOutboundTerminal(input.jobId, 5000) : undefined
    const messageId = input.messageId ?? delivery?.platformMessageId
    if (!messageId) return
    await enqueueGoverned({
      adapterId: delivery?.adapterId ?? input.adapterId,
      conversationKey: delivery?.conversationKey ?? input.conversationKey,
      request: {
        conversationRef: delivery?.request.conversationRef ?? input.conversationRef,
        ...(delivery?.request.deliveryTarget
          ? { deliveryTarget: delivery.request.deliveryTarget }
          : {}),
        editTargetMessageId: messageId,
        segments: [approvalStateSegment(input.state, input.detail)],
        metadata: { idempotencyKey: `approval-state:${input.surfaceId}:${input.state}` },
      },
      source: "ai-run",
    })
  } catch {
    // Presentation failure must never reverse an already applied decision.
    await appendAudit({
      adapterId: input.adapterId,
      conversationKey: input.conversationKey,
      kind: "adapter.error",
      at: Date.now(),
      reason: "approval_card_update_failed",
    }).catch(() => undefined)
  }
}
