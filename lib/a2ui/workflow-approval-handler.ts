/**
 * Bus-side dispatcher for `wf_approve` / `wf_cancel` callback bindings.
 *
 * Companion to the `defaultConnectorCallbackHandler` (which drives a model
 * digest turn). The workflow approval kind is special-cased upstream in
 * `lib/connectors/bus.ts:dispatchConnectorCallback` so the assistant turn
 * isn't synthesised — we want the user to see a tight "✅ Started" / "⊘
 * Cancelled" reply, then progress cards driven by the execution bridge +
 * run-presentation runner, NOT a long model recap.
 *
 * Approve path: kick off `startWorkflowFromIM` (fire-and-forget) and
 * enqueue a single "started" outbound. Cancel path: skip the start and
 * enqueue a "cancelled" outbound. In both cases the sibling binding is
 * deleted so the user can't double-approve / double-cancel.
 */

import type { ConnectorCallbackBindingRow } from "@/types/connectors/interaction"
import type { PlatformKind } from "@/types/connectors/platform-kind"
import { getDb } from "@/lib/db/schema"
import { enqueueGoverned as enqueueOutbound } from "@/lib/connectors/delivery-gateway"
import { parseConversationKey } from "@/types/connectors/event"
import { startWorkflowFromIM } from "@/lib/workflow/runtime/start-from-im"
import type { WorkflowTriggeredFrom } from "@/types/workflow/visual"

export interface HandleWorkflowApprovalInput {
  binding: ConnectorCallbackBindingRow
  cancelled: boolean
  adapterId: string
  platform: PlatformKind
  conversationKey?: string
}

interface ApprovalPayload {
  workflowId: string
  workflowName?: string
  runParams?: Record<string, unknown>
  triggeredFrom: WorkflowTriggeredFrom
}

function readPayload(binding: ConnectorCallbackBindingRow): ApprovalPayload | null {
  const payload = binding.payload as Partial<ApprovalPayload> | undefined
  if (!payload || typeof payload.workflowId !== "string") return null
  const tf = payload.triggeredFrom
  if (!tf || tf.source !== "im") return null
  return {
    workflowId: payload.workflowId,
    workflowName: payload.workflowName,
    runParams: payload.runParams,
    triggeredFrom: tf,
  }
}

async function deleteSiblingBindings(adapterId: string, surfaceId: string): Promise<void> {
  // Approve + Cancel rows share the same surfaceId. Drop both so the
  // user can't double-click either button after the decision.
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
    source: "workflow",
  })
}

export async function handleWorkflowApprovalCallback(
  input: HandleWorkflowApprovalInput
): Promise<void> {
  const payload = readPayload(input.binding)
  if (!payload) {
    // Malformed binding — clean it up and abort. Already-audited as
    // `workflow_approval_failed` by the bus dispatcher if this throws.
    await deleteSiblingBindings(input.adapterId, input.binding.surfaceId)
    return
  }

  const conversationKey = input.conversationKey ?? payload.triggeredFrom.conversationKey
  if (!conversationKey) {
    await deleteSiblingBindings(input.adapterId, input.binding.surfaceId)
    return
  }

  // Derive platform from the conversation key when the bus didn't pass
  // a stronger signal — parseConversationKey gives us a typed PlatformKind.
  let platform = input.platform
  try {
    platform = parseConversationKey(conversationKey).platform
  } catch {
    // Fall back to the bus-provided platform.
  }

  if (input.cancelled) {
    await pushOutboundText({
      adapterId: input.adapterId,
      platform,
      conversationKey,
      text: `⊘ ${payload.workflowName ?? "Workflow"} 已取消`,
      idempotencyKey: `wfcan:${input.binding.surfaceId}`,
    })
    await deleteSiblingBindings(input.adapterId, input.binding.surfaceId)
    return
  }

  const result = await startWorkflowFromIM({
    workflowId: payload.workflowId,
    runParams: payload.runParams,
    triggeredFrom: payload.triggeredFrom,
  })

  if (!result.ok) {
    await pushOutboundText({
      adapterId: input.adapterId,
      platform,
      conversationKey,
      text: `✗ 无法启动「${payload.workflowName ?? payload.workflowId}」：${
        result.reason === "workflow-not-found" ? "workflow not found" : "unknown error"
      }`,
      idempotencyKey: `wferr:${input.binding.surfaceId}`,
    })
    await deleteSiblingBindings(input.adapterId, input.binding.surfaceId)
    return
  }

  await pushOutboundText({
    adapterId: input.adapterId,
    platform,
    conversationKey,
    text: `✅ ${payload.workflowName ?? "Workflow"} 已启动 (runId=${result.runId})`,
    idempotencyKey: `wfok:${input.binding.surfaceId}`,
  })
  await deleteSiblingBindings(input.adapterId, input.binding.surfaceId)
}
