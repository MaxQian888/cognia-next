import { enqueueGoverned } from "@/lib/connectors/delivery-gateway"
import { waitForOutboundTerminal } from "@/lib/db/outbound-jobs"
import { appendAudit } from "@/lib/connectors/audit"
import { buildLarkCommandFrame } from "@/lib/connectors/adapters/lark/card"
import {
  LARK_ICON,
  larkMarkdown,
  larkNote,
  type LarkIcon,
} from "@/lib/connectors/adapters/lark/card-kit"
import type { ConversationReference } from "@/types/connectors/event"
import type { MessageSegment } from "@/types/connectors/segment"

export type ApprovalCardState =
  "approved" | "denied" | "expired" | "processed" | "failed" | "answered" | "skipped" | "cancelled"

/** How each closed state reads: title, icon and colour. */
const CLOSED_STATE: Record<
  ApprovalCardState,
  { title: string; icon: LarkIcon; tone: "success" | "warning" | "info" }
> = {
  approved: { title: "已批准", icon: LARK_ICON.success, tone: "success" },
  denied: { title: "已拒绝", icon: LARK_ICON.close, tone: "warning" },
  expired: { title: "已过期", icon: LARK_ICON.waiting, tone: "warning" },
  processed: { title: "已处理", icon: LARK_ICON.success, tone: "success" },
  failed: { title: "处理失败", icon: LARK_ICON.error, tone: "warning" },
  answered: { title: "已回答", icon: LARK_ICON.success, tone: "success" },
  skipped: { title: "已跳过", icon: LARK_ICON.done, tone: "info" },
  cancelled: { title: "已停止", icon: LARK_ICON.stop, tone: "warning" },
}

export function approvalStateSegment(state: ApprovalCardState, detail?: string): MessageSegment {
  const closed = CLOSED_STATE[state]
  const trimmed = detail?.trim()
  return {
    type: "card",
    card: {
      kind: "lark",
      payload: buildLarkCommandFrame(
        closed.title,
        [
          // The detail is markdown its producer wrote (the question in bold,
          // the answer quoted); only a mention in it is disarmed.
          ...(trimmed ? [larkMarkdown(trimmed.slice(0, 500).replace(/<at\b/gi, "<\u200Bat"))] : []),
          larkNote("此请求已结束，操作按钮已移除。"),
        ],
        closed.tone,
        { icon: closed.icon }
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
