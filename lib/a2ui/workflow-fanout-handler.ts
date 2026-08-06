/**
 * Bus-side dispatcher for `wf_fanout_approve` / `wf_fanout_cancel`
 * callback bindings.
 *
 * Mirrors `workflow-approval-handler.ts`: on Approve the handler writes
 * a `workflowFanoutSubscriptions` row + enqueues "✅ 已订阅"; on Cancel
 * it enqueues "⊘ 已取消" without writing anything. In both cases the
 * sibling binding is dropped so the user can't double-tap.
 *
 * Permission constraint: the upstream tool already enforced "the target
 * channel must be the current IM session itself" by checking the
 * session's platformBinding. The handler trusts that — it never accepts
 * a cross-channel target from a bus callback.
 */

import type { ConnectorCallbackBindingRow } from "@/types/connectors/interaction"
import type { PlatformKind } from "@/types/connectors/platform-kind"
import { getDb } from "@/lib/db/schema"
import { enqueueGoverned as enqueueOutbound } from "@/lib/connectors/delivery-gateway"
import { parseConversationKey } from "@/types/connectors/event"
import { createFanoutSubscription } from "@/lib/db/workflow-fanout-subscriptions"

export interface HandleWorkflowFanoutInput {
  binding: ConnectorCallbackBindingRow
  cancelled: boolean
  adapterId: string
  platform: PlatformKind
  conversationKey?: string
}

interface FanoutPayload {
  workflowId: string
  workflowName?: string
  target: { adapterId: string; conversationKey: string }
  createdBy: string
}

function readPayload(binding: ConnectorCallbackBindingRow): FanoutPayload | null {
  const payload = binding.payload as Partial<FanoutPayload> | undefined
  if (!payload || typeof payload.workflowId !== "string") return null
  const target = payload.target
  if (
    !target ||
    typeof target.adapterId !== "string" ||
    typeof target.conversationKey !== "string"
  ) {
    return null
  }
  return {
    workflowId: payload.workflowId,
    workflowName: payload.workflowName,
    target,
    createdBy:
      typeof payload.createdBy === "string" && payload.createdBy.length > 0
        ? payload.createdBy
        : "claude-tool",
  }
}

async function deleteSiblingBindings(adapterId: string, surfaceId: string): Promise<void> {
  const rows = await getDb()
    .connectorCallbackBindings.where("adapterId")
    .equals(adapterId)
    .filter((b) => b.surfaceId === surfaceId)
    .primaryKeys()
  if (rows.length === 0) return
  await getDb().connectorCallbackBindings.bulkDelete(rows as string[])
}

async function pushOutboundText(args: {
  adapterId: string
  platform: PlatformKind
  conversationKey: string
  text: string
  idempotencyKey: string
}): Promise<void> {
  await enqueueOutbound({
    adapterId: args.adapterId,
    conversationKey: args.conversationKey,
    request: {
      conversationRef: { platform: args.platform, adapterId: args.adapterId },
      segments: [{ type: "text", text: args.text }],
      metadata: { idempotencyKey: args.idempotencyKey },
    },
    // Mirror workflow-approval-handler's source so both A2UI
    // approve/cancel confirmations land with the same inbox badge.
    source: "workflow",
  })
}

export async function handleWorkflowFanoutCallback(
  input: HandleWorkflowFanoutInput
): Promise<void> {
  const payload = readPayload(input.binding)
  if (!payload) {
    await deleteSiblingBindings(input.adapterId, input.binding.surfaceId)
    return
  }

  const conversationKey = input.conversationKey ?? payload.target.conversationKey
  if (!conversationKey) {
    await deleteSiblingBindings(input.adapterId, input.binding.surfaceId)
    return
  }

  let platform = input.platform
  try {
    platform = parseConversationKey(conversationKey).platform
  } catch {
    // fall back to bus-provided platform
  }

  const labelName = payload.workflowName ?? payload.workflowId

  if (input.cancelled) {
    await pushOutboundText({
      adapterId: input.adapterId,
      platform,
      conversationKey,
      text: `⊘ 已取消订阅「${labelName}」`,
      idempotencyKey: `wf-fanout-cancel:${input.binding.surfaceId}`,
    })
    await deleteSiblingBindings(input.adapterId, input.binding.surfaceId)
    return
  }

  await createFanoutSubscription({
    workflowId: payload.workflowId,
    adapterId: payload.target.adapterId,
    conversationKey: payload.target.conversationKey,
    createdBy: payload.createdBy,
  })
  await pushOutboundText({
    adapterId: input.adapterId,
    platform,
    conversationKey,
    text: `✅ 已订阅「${labelName}」的运行进度到当前会话`,
    idempotencyKey: `wf-fanout-ok:${input.binding.surfaceId}`,
  })
  await deleteSiblingBindings(input.adapterId, input.binding.surfaceId)
}
