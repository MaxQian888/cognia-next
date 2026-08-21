/**
 * Acceptance for a workflow-bound conversation — the missing third answer.
 *
 * `autonomy: "suggest"` (ADR-0117) says a human signs off before the assistant
 * acts. Each execution target honours that through the mechanism it actually
 * has:
 *
 *   - direct    → hold the PRODUCT: the reply lands here, so it becomes a
 *                 `connectorDrafts` row a person approves, edits, or discards.
 *   - team      → hold the PLAN: the product lands minutes later through the
 *                 presentation runner, where there is nothing left to hold, so
 *                 the sign-off moves to the plan gate (`plan-approval.ts`).
 *   - workflow  → hold the DISPATCH, which is this module.
 *
 * A workflow has no plan gate, and its product is delivered by its own nodes
 * rather than returning to the inbound handler — so by the time anything is
 * holdable the work has already shipped. The only point at which "a human signs
 * off before it acts" is still true is BEFORE the run starts. That is what this
 * holds.
 *
 * It is deliberately not a fourth approval system. The `wf_approve` / `wf_cancel`
 * binding kinds already exist for exactly this shape — an Approve/Cancel card
 * whose press starts (or drops) an IM-triggered workflow run — and they are
 * already routed by the bus short-circuit into
 * `lib/a2ui/workflow-approval-handler.ts`. This module only records that pair
 * of bindings and delivers the card, so the acceptance path and the
 * `wf_run_workflow_by_name` plugin path converge on one dispatcher.
 *
 * Unlike the plan and tool cards, nothing here blocks: the pending decision
 * lives in a durable Dexie binding rather than an in-process promise, so the
 * inbound job completes immediately and the approval survives a reload. The
 * permission ceiling rides on the binding payload for the same reason — a
 * dispatch that resolved its ceiling at approval time would silently widen when
 * the thread's policy changed while the card sat unanswered.
 */

import type { AgentPermissionCeiling } from "@/types/agent/permission-ceiling"
import type { ConversationDeliveryTarget, ConversationReference } from "@/types/connectors/event"
import type { WorkflowTriggeredFrom } from "@/types/workflow/visual"
import { appendAudit } from "@/lib/connectors/audit"
import { buildA2UISegment } from "@/lib/connectors/a2ui-bridge/a2ui-to-segments"
import {
  WF_APPROVE_PREFIX,
  WF_CANCEL_PREFIX,
  buildApprovalSurface,
} from "@/lib/connectors/a2ui-bridge/workflow-to-a2ui"
import { recordCallbackBinding } from "@/lib/connectors/adapters/_shared/a2ui-mapper"
import { enqueueGoverned as enqueueOutbound } from "@/lib/connectors/delivery-gateway"
import { getDb } from "@/lib/db/schema"
import { newIdempotencyKey } from "@/types/connectors/outbound"

/** Surface-id namespace, shared with the `wf_run_workflow_by_name` card. */
export const WORKFLOW_HOLD_SURFACE_PREFIX = "wfsurf:"

/**
 * A held card outlives the turn that produced it, but not indefinitely: an
 * unanswered request to run something is stale long before the binding table's
 * 30-day default reaps it, and a month-old Approve button that still starts a
 * run is a trap rather than a courtesy.
 */
export const DEFAULT_WORKFLOW_HOLD_TTL_MS = 24 * 60 * 60 * 1_000

/** How much of the triggering message the card quotes back. */
const REQUEST_EXCERPT_LIMIT = 280

export interface HoldWorkflowDispatchInput {
  workflowId: string
  /** Surfaced to trigger-aware nodes as `$trigger.payload` once approved. */
  runParams: Record<string, unknown>
  /** IM origin metadata — identical to the one an immediate dispatch passes. */
  triggeredFrom: WorkflowTriggeredFrom
  /** The IM ceiling this dispatch must inherit; frozen onto the binding. */
  permissionCeiling?: AgentPermissionCeiling
  adapterId: string
  conversationKey: string
  conversationRef: ConversationReference
  deliveryTarget?: ConversationDeliveryTarget
  /** remoteUserId of the person whose message would have started the run. */
  initiatorUserId?: string
  /** The triggering message, quoted on the card so the ask is reviewable. */
  requestText?: string
  ttlMs?: number
  now?: number
  // Injectable for tests.
  enqueue?: typeof enqueueOutbound
  recordBinding?: typeof recordCallbackBinding
  audit?: typeof appendAudit
  readWorkflow?: (
    workflowId: string
  ) => Promise<{ name?: string; description?: string } | undefined>
}

export type HoldWorkflowDispatchResult =
  | { held: true; surfaceId: string; workflowName: string }
  | { held: false; reason: "card_delivery_failed"; message: string }

async function readWorkflowRow(
  workflowId: string
): Promise<{ name?: string; description?: string } | undefined> {
  return getDb().workflows.get(workflowId)
}

function excerpt(raw: string | undefined): string {
  const text = (raw ?? "").trim()
  if (text.length === 0) return ""
  return text.length > REQUEST_EXCERPT_LIMIT ? `${text.slice(0, REQUEST_EXCERPT_LIMIT)}…` : text
}

/**
 * Build the card's body text.
 *
 * It has to answer two questions a bare workflow name cannot: why is this
 * asking at all (the conversation is in suggest mode, not because anything went
 * wrong), and what exactly would run (the message that triggered it). A card
 * that only says "Approve?" makes the reader guess at both.
 */
export function buildWorkflowHoldSummary(input: {
  workflowDescription?: string
  requestText?: string
}): string {
  const request = excerpt(input.requestText)
  const description = (input.workflowDescription ?? "").trim()
  return [
    "此会话为建议模式，工作流需批准后才会运行。 / This conversation is in suggest mode, so the workflow runs only after approval.",
    ...(description.length > 0 ? [description] : []),
    ...(request.length > 0 ? [`触发消息 / Request: ${request}`] : []),
  ].join("\n")
}

/**
 * Record the Approve/Cancel bindings and deliver the card. Starts nothing.
 *
 * Fail-closed: when the card cannot be delivered this returns `held: false` and
 * the caller must NOT fall through to a dispatch. The alternative — running the
 * workflow because the question could not be asked — is the exact gap this
 * closes, only louder.
 */
export async function holdWorkflowDispatchForApproval(
  input: HoldWorkflowDispatchInput
): Promise<HoldWorkflowDispatchResult> {
  const enqueue = input.enqueue ?? enqueueOutbound
  const recordBinding = input.recordBinding ?? recordCallbackBinding
  const audit = input.audit ?? appendAudit
  const readWorkflow = input.readWorkflow ?? readWorkflowRow
  const now = input.now ?? Date.now()

  const row = await readWorkflow(input.workflowId).catch(() => undefined)
  const workflowName = row?.name?.trim() || input.workflowId
  const bindingId = newIdempotencyKey().slice(0, 8)
  const surfaceId = WORKFLOW_HOLD_SURFACE_PREFIX + bindingId
  const surface = buildApprovalSurface({
    bindingId,
    workflowName,
    summary: buildWorkflowHoldSummary({
      ...(row?.description ? { workflowDescription: row.description } : {}),
      ...(input.requestText ? { requestText: input.requestText } : {}),
    }),
  })

  // Same actor rule as the tool and plan cards: the person who asked answers,
  // or a configured operator when the platform gave us no stable user id.
  const actorScope = input.initiatorUserId
    ? { mode: "initiator" as const, allowedUserIds: [input.initiatorUserId] }
    : { mode: "operators" as const }

  // The whole dispatch, frozen. `handleWorkflowApprovalCallback` re-reads this
  // and nothing else, so a conversation that is re-bound while the card waits
  // cannot redirect the run that was actually approved.
  const payload = {
    workflowId: input.workflowId,
    workflowName,
    runParams: input.runParams,
    triggeredFrom: input.triggeredFrom,
    ...(input.permissionCeiling ? { permissionCeiling: input.permissionCeiling } : {}),
  }
  const expiresAt = now + (input.ttlMs ?? DEFAULT_WORKFLOW_HOLD_TTL_MS)

  try {
    await Promise.all(
      (
        [
          { actionId: WF_APPROVE_PREFIX + bindingId, componentId: "approve", kind: "wf_approve" },
          { actionId: WF_CANCEL_PREFIX + bindingId, componentId: "cancel", kind: "wf_cancel" },
        ] as const
      ).map((button) =>
        recordBinding({
          adapterId: input.adapterId,
          actionId: button.actionId,
          kind: button.kind,
          surfaceId,
          componentId: button.componentId,
          conversationKey: input.conversationKey,
          payload,
          actorScope,
          // Wire-level A2UI verbs, not decisions.
          allowedActions: ["approve", "cancel"],
          createdAt: now,
          expiresAt,
        })
      )
    )
    await enqueue({
      adapterId: input.adapterId,
      conversationKey: input.conversationKey,
      request: {
        conversationRef: input.conversationRef,
        ...(input.deliveryTarget ? { deliveryTarget: input.deliveryTarget } : {}),
        segments: [buildA2UISegment(surfaceId, surface)],
        metadata: { idempotencyKey: newIdempotencyKey() },
      },
      source: "ai-run",
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await audit({
      adapterId: input.adapterId,
      kind: "adapter.error",
      at: now,
      conversationKey: input.conversationKey,
      reason: "workflow_hold_card_failed",
      message,
      fields: { workflowId: input.workflowId, surfaceId },
    }).catch(() => undefined)
    return { held: false, reason: "card_delivery_failed", message }
  }

  return { held: true, surfaceId, workflowName }
}
