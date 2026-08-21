/**
 * IM plan-approval card — the delegate behind `GateBehavior: "delegate"`.
 *
 * `resolveGatePolicy` used to be a two-value map: interactive blocks, and
 * everything else is "headless", where the plan gate fails fast because
 * "approval without a human is meaningless". That premise holds for a
 * scheduler run at 3am. It does not hold for IM: there is a person on the
 * other end of the thread, and the approval machinery they would answer
 * through already exists — `tool-approval.ts` suspends a turn on an A2UI
 * Allow/Deny card with a TTL, an actor-scope guard, and a durable
 * `ExecutionRunInterrupt`. An IM-triggered team run whose plan tripped the risk
 * gate was failing loudly instead of asking a question it had every means to
 * ask.
 *
 * So this is deliberately the same shape as `tool-approval.ts` — same registry,
 * same binding mechanics, same fail-closed posture — rather than a second
 * approval system. What differs is only what the card says and what a rejection
 * carries: a plan rejection's feedback text goes straight into the lead's
 * existing re-planning loop, which means a person's reply in a chat thread
 * becomes the revision instruction.
 */

import type { ApprovalDecision } from "@/lib/runtime/approval-bus"
import type { ConversationDeliveryTarget, ConversationReference } from "@/types/connectors/event"
import type { A2UISegmentContent } from "@/types/connectors/segment"
import { enqueueGoverned as enqueueOutbound } from "@/lib/connectors/delivery-gateway"
import { recordCallbackBinding } from "@/lib/connectors/adapters/_shared/a2ui-mapper"
import { appendAudit } from "@/lib/connectors/audit"
import { buildA2UISegment } from "@/lib/connectors/a2ui-bridge/a2ui-to-segments"
import { newIdempotencyKey } from "@/types/connectors/outbound"
import { sanitizeActivityLabel } from "@/lib/execution/run-activity"

import { awaitApproval } from "./approval-registry"

/** Action-id namespaces so the bus can route the press back here. */
export const PLAN_APPROVE_PREFIX = "plna:"
export const PLAN_REJECT_PREFIX = "plnr:"

export type PlanApprovalDecision = "approve" | "reject"

/** A plan card waits longer than a tool card: it is a real reading task. */
export const DEFAULT_PLAN_APPROVAL_TTL_MS = 30 * 60 * 1_000

/** Plans are long; a card that pastes one whole is unreadable on a phone. */
const PLAN_EXCERPT_LIMIT = 1_200

export interface PlanApprovalSurfaceInput {
  bindingId: string
  objective: string
  planText: string
  /** Present only when risk — not an operator switch — is what raised the gate. */
  riskReason?: string
  revision: number
}

/**
 * Pure builder for the Approve / Reject card.
 *
 * The plan text is excerpted rather than truncated silently: a reader who
 * cannot see the tail must be told the tail exists, or they approve something
 * they did not read.
 */
export function buildPlanApprovalSurface(input: PlanApprovalSurfaceInput): A2UISegmentContent {
  const approve = PLAN_APPROVE_PREFIX + input.bindingId
  const reject = PLAN_REJECT_PREFIX + input.bindingId
  const objective = sanitizeActivityLabel(input.objective, "Team run")
  const title = `计划待批准 / Plan awaiting approval: ${objective}`
  const why = input.riskReason
    ? `此运行涉及 ${input.riskReason}，需要批准。 / This run touches ${input.riskReason}, so approval is required.`
    : "负责人提出了计划。 / The lead proposed a plan."
  const truncated = input.planText.length > PLAN_EXCERPT_LIMIT
  const excerpt = truncated
    ? `${input.planText.slice(0, PLAN_EXCERPT_LIMIT)}\n…（已截断，完整计划见详情 / truncated, see details）`
    : input.planText
  const howToReject =
    "拒绝后请回复修改意见，负责人会据此重新规划。 / After rejecting, reply with feedback and the lead will re-plan."

  return {
    components: {
      root: { component: "Card", title, children: ["why", "plan", "howTo", "actions"] },
      why: { component: "Text", text: why },
      plan: { component: "Text", text: excerpt },
      howTo: { component: "Text", text: howToReject },
      actions: { component: "Row", children: ["approve", "reject"] },
      approve: { component: "Button", text: "批准 / Approve", action: "approve", value: approve },
      reject: { component: "Button", text: "拒绝 / Reject", action: "cancel", value: reject },
    },
    dataModel: {},
    rootId: "root",
    surfaceType: "inline",
    title,
    widget: {
      fallbackText: [
        `# ${title}`,
        why,
        excerpt,
        howToReject,
        "[批准 / Approve] [拒绝 / Reject]",
        "回复 1 批准 / 2 拒绝",
      ].join("\n"),
    },
  }
}

export interface ImPlanApprovalContext {
  /**
   * The registry key. Uses the run's own id rather than a chat session id
   * because a team run's plan gate is a property of the RUN — the same run may
   * be watched from more than one session, and only one plan is pending.
   */
  runId: string
  teamId: string
  objective: string
  adapterId: string
  conversationKey: string
  conversationRef: ConversationReference
  deliveryTarget?: ConversationDeliveryTarget
  /**
   * remoteUserId of the person whose message started this run. Feeds the
   * bindings' actorScope, so only the requester (or a configured operator) can
   * answer — the same rule the tool card uses.
   */
  initiatorUserId?: string
  ttlMs?: number
  // Injectable for tests.
  enqueue?: typeof enqueueOutbound
  recordBinding?: typeof recordCallbackBinding
  audit?: typeof appendAudit
}

export interface PlanApprovalRequest {
  planText: string
  revision: number
  riskReason?: string
}

/**
 * Build the delegate `applyGateBehavior` calls for `planApproval: "delegate"`.
 *
 * Returns a rejection rather than throwing when the card cannot be surfaced:
 * `applyGateBehavior` treats a throwing delegate as `fail-fast`, and a run that
 * dies because a card failed to send is strictly worse for the operator than a
 * run that reports "not approved". Both refuse to proceed; only one says why in
 * the loop that can act on it.
 */
export function makeImPlanApprovalDelegate(
  ctx: ImPlanApprovalContext
): (request: PlanApprovalRequest) => Promise<ApprovalDecision> {
  const enqueue = ctx.enqueue ?? enqueueOutbound
  const recordBinding = ctx.recordBinding ?? recordCallbackBinding
  const audit = ctx.audit ?? appendAudit

  return async (request: PlanApprovalRequest): Promise<ApprovalDecision> => {
    // One registry key per REVISION: a re-plan is a new question, and reusing
    // the key would let a stale press answer the plan that replaced it.
    const requestId = `plan-approval:${ctx.runId}:${request.revision}`
    const bindingId = newIdempotencyKey().slice(0, 8)
    const surfaceId = `plan_approve:${ctx.conversationKey}:${bindingId}`
    const surface = buildPlanApprovalSurface({
      bindingId,
      objective: ctx.objective,
      planText: request.planText,
      ...(request.riskReason ? { riskReason: request.riskReason } : {}),
      revision: request.revision,
    })

    const actorScope = ctx.initiatorUserId
      ? { mode: "initiator" as const, allowedUserIds: [ctx.initiatorUserId] }
      : { mode: "operators" as const }
    const buttons: Array<{
      actionId: string
      componentId: string
      decision: PlanApprovalDecision
    }> = [
      { actionId: PLAN_APPROVE_PREFIX + bindingId, componentId: "approve", decision: "approve" },
      { actionId: PLAN_REJECT_PREFIX + bindingId, componentId: "reject", decision: "reject" },
    ]

    try {
      await Promise.all(
        buttons.map((button) =>
          recordBinding({
            adapterId: ctx.adapterId,
            actionId: button.actionId,
            surfaceId,
            componentId: button.componentId,
            conversationKey: ctx.conversationKey,
            kind: "plan_approve",
            payload: {
              runId: ctx.runId,
              teamId: ctx.teamId,
              requestId,
              decision: button.decision,
            },
            actorScope,
            // Wire-level A2UI verbs, not decisions.
            allowedActions: [button.decision === "reject" ? "cancel" : "approve"],
          })
        )
      )
      await enqueue({
        adapterId: ctx.adapterId,
        conversationKey: ctx.conversationKey,
        request: {
          conversationRef: ctx.conversationRef,
          ...(ctx.deliveryTarget ? { deliveryTarget: ctx.deliveryTarget } : {}),
          segments: [buildA2UISegment(surfaceId, surface)],
          metadata: { idempotencyKey: newIdempotencyKey() },
        },
        source: "ai-run",
      })
      await audit({
        adapterId: ctx.adapterId,
        kind: "plan_approve.requested",
        at: Date.now(),
        conversationKey: ctx.conversationKey,
        fields: { runId: ctx.runId, teamId: ctx.teamId, revision: request.revision },
      })
    } catch (error) {
      await audit({
        adapterId: ctx.adapterId,
        kind: "adapter.error",
        at: Date.now(),
        conversationKey: ctx.conversationKey,
        reason: "plan_approval_card_failed",
        message: error instanceof Error ? error.message : String(error),
        fields: { runId: ctx.runId },
      }).catch(() => undefined)
      return { outcome: "reject", feedback: "plan approval card could not be delivered" }
    }

    // Suspend on the same registry the tool card uses. A TTL expiry resolves as
    // a rejection, which lands in the lead's re-planning loop rather than
    // wedging the run open forever.
    const decision = await awaitApproval(ctx.runId, requestId, {
      ttlMs: ctx.ttlMs ?? DEFAULT_PLAN_APPROVAL_TTL_MS,
      onExpire: () => {
        void audit({
          adapterId: ctx.adapterId,
          kind: "plan_approve.expired",
          at: Date.now(),
          conversationKey: ctx.conversationKey,
          fields: { runId: ctx.runId, revision: request.revision },
        }).catch(() => undefined)
      },
    })
    return decision.decision === "allow"
      ? { outcome: "approve" }
      : {
          outcome: "reject",
          ...(decision.message ? { feedback: decision.message } : {}),
        }
  }
}

/**
 * Resolve a `plan_approve` button press. Called by the bus short-circuit.
 *
 * Returns whether a waiter was actually released so the caller can tell "the
 * lead is now re-planning" from "that card is stale" — the second is common
 * (a press on the previous revision) and must not be reported as success.
 */
export function applyPlanApprovalCallback(input: {
  runId: string
  requestId: string
  decision: PlanApprovalDecision
  /** Free-text revision instruction typed alongside a reject, if any. */
  feedback?: string
  resolve: (
    runId: string,
    requestId: string,
    decision: { decision: "allow" | "deny"; message?: string }
  ) => boolean
}): { approved: boolean; resolved: boolean } {
  const approved = input.decision === "approve"
  const resolved = input.resolve(input.runId, input.requestId, {
    decision: approved ? "allow" : "deny",
    ...(input.feedback ? { message: input.feedback } : {}),
  })
  return { approved, resolved }
}
