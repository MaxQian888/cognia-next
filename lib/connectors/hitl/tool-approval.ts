import { settleApprovalCard } from "./approval-card-state"
/**
 * IM tool-permission approval responder (control-plane HITL).
 *
 * Produces the `onPermissionRequest` callback the connector runtime hands to
 * `runAndCaptureAssistantReply`. When the sidecar asks to run an ask-tier tool
 * mid-turn, this responder:
 *   1. auto-allows when the conversation is in `yolo` approval mode, or the
 *      user already chose "allow for session" for this tool;
 *   2. otherwise projects an A2UI Allow / Deny / Allow-for-session card to the
 *      conversation, records a `tool_approve` callback binding per button, and
 *      `await`s the registry until the user taps (or the TTL auto-denies).
 *
 * An outbound call the policy left to a person (ADR-0239,
 * `PermissionRequestEvent.outbound`) is asked per call: the card names its
 * recipients, says a deny fences them, and offers "allow for this request" in
 * place of "allow for session" when every recipient can be named.
 *
 * The sidecar blocks the tool until the returned decision arrives, so the turn
 * suspends without any custom machinery. The button-press resolves the pending
 * promise via `bus.dispatchConnectorCallback`'s `tool_approve` short-circuit.
 */

import {
  TOOL_APPROVE_PREFIX,
  TOOL_DENY_PREFIX,
  TOOL_ALLOW_SESSION_PREFIX,
  TOOL_ALLOW_REQUEST_PREFIX,
} from "@/lib/connectors/hitl/callback-prefixes"
import type { PendingOutboundTarget, PermissionRequestEvent } from "@cognia/agent-config-types"
import type { CapturePermissionDecision } from "@/lib/claude/run-and-capture"
import type { ConversationDeliveryTarget, ConversationReference } from "@/types/connectors/event"
import type { A2UISegmentContent } from "@/types/connectors/segment"
import { enqueueGoverned as enqueueOutbound } from "@/lib/connectors/delivery-gateway"
import { recordCallbackBinding } from "@/lib/connectors/adapters/_shared/a2ui-mapper"
import { appendAudit } from "@/lib/connectors/audit"
import { buildA2UISegment } from "@/lib/connectors/a2ui-bridge/a2ui-to-segments"
import { newIdempotencyKey } from "@/types/connectors/outbound"
import {
  forgetRunApprovalOutbound,
  rememberRunApprovalOutbound,
} from "@/lib/execution/run-approval-outbound"
import { outboundRecipientId } from "@/lib/policy/action-review/outbound-targets"
import { outboundGrantableForRequest } from "@/lib/policy/action-review/policy"
import {
  awaitApproval,
  grantSessionBypass,
  hasSessionBypass,
  type AwaitApprovalOptions,
} from "./approval-registry"

/**
 * Turn-capture timeout for a connector turn whose tool requests go through
 * this responder. Raised above the 5-min capture default so an in-flight human
 * approval (registry TTL `DEFAULT_APPROVAL_TTL_MS`, 10 min) resolves
 * before the turn times out, while still bounding a stuck sidecar. Shared by
 * inbound IM turns (`runtime.ts`) and the IM `/goal` driver (`commands/goal.ts`).
 */
export const CONNECTOR_TURN_TIMEOUT_MS = 15 * 60 * 1000

/** Action-id namespaces so the bus can route + the numeric mirror can map. */
export {
  TOOL_APPROVE_PREFIX,
  TOOL_DENY_PREFIX,
  TOOL_ALLOW_SESSION_PREFIX,
  TOOL_ALLOW_REQUEST_PREFIX,
} from "@/lib/connectors/hitl/callback-prefixes"

/** Decision encoded onto a `tool_approve` binding payload. */
export type ToolApprovalDecision = "allow" | "deny" | "allow_session" | "allow_request"

export interface ToolApprovalSurfaceInput {
  bindingId: string
  toolName: string
  /** A per-call ask: no "allow for session" button. */
  perCall?: boolean
  /** An outbound ask's recipients (ADR-0239): named on the card. */
  recipients?: readonly PendingOutboundTarget[]
  /** Offer "allow for this request" (every recipient can be named). */
  allowForRequest?: boolean
}

/** One recipient line of an outbound card. Bilingual, like the rest of the card. */
export function imRecipientLine(target: PendingOutboundTarget): string {
  const id = outboundRecipientId(target)
  switch (target.kind) {
    case "conversation":
      return `会话 / Chat ${id}（${target.channel}）`
    case "person":
      return `成员 / Person ${id}（${target.channel}）`
    case "mail":
      return `邮箱 / Email ${id}`
    case "repository":
      return `仓库 / Repository ${id}${target.thread ? ` #${target.thread}` : ""}`
    case "site":
      return `网站 / Site ${id}`
    case "public":
      return `公开链接 / Public link（${id}）`
    case "unknown":
      return "无法识别的收件人 / A recipient it could not name"
  }
}

const RECIPIENTS_HEADING = "发送给 / Sends to:"
const DENY_FENCES_NOTICE =
  "拒绝后，在新指令之前也不会再向这些收件人发送。 / Deny also stops sending to these recipients until a new instruction."

/**
 * Pure builder for the Allow / Deny / Allow-for-session card. Card-capable
 * adapters render the buttons natively; the rest fall back to the
 * `fallbackText` mirror (incl. the personal-WeChat numeric hint).
 */
export function buildToolApprovalSurface(input: ToolApprovalSurfaceInput): A2UISegmentContent {
  const approve = TOOL_APPROVE_PREFIX + input.bindingId
  const deny = TOOL_DENY_PREFIX + input.bindingId
  const allowSession = TOOL_ALLOW_SESSION_PREFIX + input.bindingId
  const allowRequest = TOOL_ALLOW_REQUEST_PREFIX + input.bindingId
  const title = `工具授权 / Tool approval: ${input.toolName}`
  const prompt = `助手想运行工具 “${input.toolName}”。是否允许？ / Allow the assistant to run "${input.toolName}"?`
  const sessionButton = !input.perCall
  // Only a per-call ask offers the request; it then takes the session's place.
  const requestButton = !sessionButton && input.allowForRequest === true
  const recipients = input.recipients?.length
    ? [RECIPIENTS_HEADING, ...input.recipients.map((target) => `- ${imRecipientLine(target)}`)]
    : []
  const recipientsText = recipients.length ? [...recipients, DENY_FENCES_NOTICE].join("\n") : ""
  const third = sessionButton
    ? { id: "allowSession", label: "本会话始终允许 / Allow for session", short: "本会话始终允许" }
    : requestButton
      ? {
          id: "allowRequest",
          label: "本次请求内允许 / Allow for this request",
          short: "本次请求内允许",
        }
      : undefined
  return {
    components: {
      root: {
        component: "Card",
        title,
        children: recipientsText ? ["prompt", "recipients", "actions"] : ["prompt", "actions"],
      },
      prompt: { component: "Text", text: prompt },
      ...(recipientsText ? { recipients: { component: "Text", text: recipientsText } } : {}),
      actions: {
        component: "Row",
        children: third ? ["allow", "deny", third.id] : ["allow", "deny"],
      },
      allow: { component: "Button", text: "允许 / Allow", action: "approve", value: approve },
      deny: { component: "Button", text: "拒绝 / Deny", action: "cancel", value: deny },
      ...(third
        ? {
            [third.id]: {
              component: "Button",
              text: third.label,
              action: "approve",
              value: sessionButton ? allowSession : allowRequest,
            },
          }
        : {}),
    },
    dataModel: {},
    rootId: "root",
    surfaceType: "inline",
    title,
    widget: {
      fallbackText: [
        `# ${title}`,
        prompt,
        ...(recipientsText ? [recipientsText] : []),
        ...(third
          ? [
              `[允许 / Allow] [拒绝 / Deny] [${third.label}]`,
              `回复 1 允许 / 2 拒绝 / 3 ${third.short}`,
            ]
          : ["[允许 / Allow] [拒绝 / Deny]", "回复 1 允许 / 2 拒绝"]),
      ].join("\n"),
    },
  }
}

export interface ImPermissionResponderContext {
  sessionId: string
  adapterId: string
  conversationKey: string
  conversationRef: ConversationReference
  deliveryTarget?: ConversationDeliveryTarget
  /** `"yolo"` auto-approves every ask-tier tool; default `"prompt"`. */
  approvalMode?: "prompt" | "yolo"
  // Injectable for tests.
  enqueue?: typeof enqueueOutbound
  recordBinding?: typeof recordCallbackBinding
  audit?: typeof appendAudit
  signal?: AbortSignal
  ttlMs?: number
  /** Durable Execution Run that owns this permission request. */
  runId?: string
  /**
   * remoteUserId of the human whose message started this turn. Feeds the
   * approval bindings' actorScope so the callback authorization guard only
   * lets the requester (or a configured operator) resolve the approval
   * (plan 2026-07-24 Phase 2). Absent → operators-only scope.
   */
  initiatorUserId?: string
  /**
   * Answers a request no human could decide: the card could not be surfaced,
   * or its TTL expired with no tap. Its decision replaces the default deny.
   * Not called for an explicit Deny (a decision) nor when `signal` ended the
   * wait (the run is over). The IM `/goal` driver passes the goal runner's
   * unattended responder here, so an unanswered card pauses the goal
   * `needs_approval` instead of letting the loop re-ask every turn.
   */
  onUnanswered?: (
    req: PermissionRequestEvent
  ) => CapturePermissionDecision | Promise<CapturePermissionDecision>
}

/**
 * Build the `onPermissionRequest` responder for one IM turn. Returns a function
 * `runAndCaptureAssistantReply` can call; its returned Promise resolves to the
 * user's decision (or an auto-allow / TTL deny).
 */
export function makeImPermissionResponder(
  ctx: ImPermissionResponderContext
): (req: PermissionRequestEvent) => Promise<CapturePermissionDecision> {
  const enqueue = ctx.enqueue ?? enqueueOutbound
  const recordBinding = ctx.recordBinding ?? recordCallbackBinding
  const audit = ctx.audit ?? appendAudit

  return async (req: PermissionRequestEvent): Promise<CapturePermissionDecision> => {
    // A per-call ask (ADR-0201; an outbound call to an unauthorized
    // recipient, ADR-0239) is a person's decision every time: neither yolo nor
    // a remembered "allow for session" answers it, and no card offers one.
    const perCall = req.requiresPerCallApproval === true

    // 1. yolo mode or a prior "allow for session" → auto-approve.
    if (
      !perCall &&
      (ctx.approvalMode === "yolo" || hasSessionBypass(ctx.sessionId, req.toolName))
    ) {
      return { decision: "allow" }
    }

    // 2. Project the approval card + record one binding per button.
    const bindingId = newIdempotencyKey().slice(0, 8)
    const interruptId = ctx.runId ? `tool-interrupt:${ctx.runId}:${req.requestId}` : undefined
    if (ctx.runId && interruptId) {
      const { createRunInterrupt } = await import("@/lib/execution/run-control")
      await createRunInterrupt({
        id: interruptId,
        runId: ctx.runId,
        type: "tool_approval",
        status: "pending",
        title: `Approve ${req.toolName}`,
        toolName: req.toolName,
        requestDigest: req.requestId,
        expiresAt: Date.now() + (ctx.ttlMs ?? 30 * 60 * 1_000),
        createdAt: Date.now(),
      })
    }
    const surfaceId = `tool_approve:${ctx.conversationKey}:${bindingId}`
    // Shadow mode (`enforced: false`) never reaches here with recipients:
    // the outbound policy only attaches them to an ask it enforces.
    const outbound = req.outbound?.enforced ? req.outbound : undefined
    const allowForRequest = perCall && outboundGrantableForRequest(outbound)
    const surface = buildToolApprovalSurface({
      bindingId,
      toolName: req.toolName,
      perCall,
      ...(outbound ? { recipients: outbound.targets } : {}),
      allowForRequest,
    })

    const buttons: Array<{
      actionId: string
      componentId: string
      decision: ToolApprovalDecision
    }> = [
      { actionId: TOOL_APPROVE_PREFIX + bindingId, componentId: "allow", decision: "allow" },
      { actionId: TOOL_DENY_PREFIX + bindingId, componentId: "deny", decision: "deny" },
      ...(perCall
        ? []
        : [
            {
              actionId: TOOL_ALLOW_SESSION_PREFIX + bindingId,
              componentId: "allowSession",
              decision: "allow_session" as const,
            },
          ]),
      ...(allowForRequest
        ? [
            {
              actionId: TOOL_ALLOW_REQUEST_PREFIX + bindingId,
              componentId: "allowRequest",
              decision: "allow_request" as const,
            },
          ]
        : []),
    ]
    let approvalJobId: string | undefined
    let expired = false
    try {
      const actorScope = ctx.initiatorUserId
        ? { mode: "initiator" as const, allowedUserIds: [ctx.initiatorUserId] }
        : { mode: "operators" as const }
      await Promise.all(
        buttons.map((b) =>
          recordBinding({
            adapterId: ctx.adapterId,
            actionId: b.actionId,
            surfaceId,
            componentId: b.componentId,
            conversationKey: ctx.conversationKey,
            kind: "tool_approve",
            payload: {
              sessionId: ctx.sessionId,
              requestId: req.requestId,
              toolName: req.toolName,
              decision: b.decision,
            },
            actorScope,
            // Wire-level A2UI verbs, not decisions: the allow/allow-session
            // buttons emit action "approve", the deny button emits "cancel".
            allowedActions: [b.decision === "deny" ? "cancel" : "approve"],
          })
        )
      )
      const approvalJob = await enqueue({
        adapterId: ctx.adapterId,
        conversationKey: ctx.conversationKey,
        request: {
          conversationRef: ctx.conversationRef,
          ...(ctx.deliveryTarget ? { deliveryTarget: ctx.deliveryTarget } : {}),
          segments: [buildA2UISegment(surfaceId, surface)],
          metadata: { idempotencyKey: newIdempotencyKey() },
        },
        source: "ai-run",
        authorization: { kind: "system-notice", inboundConversationKey: ctx.conversationKey },
      })
      approvalJobId = approvalJob?.id
      await audit({
        adapterId: ctx.adapterId,
        kind: "tool_approve.requested",
        at: Date.now(),
        conversationKey: ctx.conversationKey,
        fields: { toolName: req.toolName, requestId: req.requestId },
      })
    } catch {
      // If we can't even surface the card, fail closed — deny so the turn
      // completes rather than hanging on a card the user never saw.
      if (ctx.runId && interruptId) {
        const { resolveRunInterruptFromSource } = await import("@/lib/execution/run-control")
        await resolveRunInterruptFromSource(ctx.runId, interruptId, "deny")
      }
      if (ctx.onUnanswered) return ctx.onUnanswered(req)
      return { decision: "deny", message: "failed to surface approval card" }
    }

    // 3. Suspend until the button-press callback resolves us (or TTL denies).
    const opts: AwaitApprovalOptions = {
      ttlMs: ctx.ttlMs,
      signal: ctx.signal,
      onExpire: () => {
        expired = true
        if (ctx.runId && interruptId) {
          void import("@/lib/execution/run-control").then(({ expireRunInterruptFromSource }) =>
            expireRunInterruptFromSource(ctx.runId!, interruptId)
          )
        }
        void audit({
          adapterId: ctx.adapterId,
          kind: "tool_approve.expired",
          at: Date.now(),
          conversationKey: ctx.conversationKey,
          fields: { toolName: req.toolName, requestId: req.requestId },
        }).catch(() => undefined)
      },
    }
    // The run's interrupt is listed on a paired phone too, which names the
    // recipients from the host's memory while the card waits (ADR-0239).
    if (interruptId && outbound) rememberRunApprovalOutbound(interruptId, outbound)
    let decision: CapturePermissionDecision
    try {
      decision = await awaitApproval(ctx.sessionId, req.requestId, opts)
    } finally {
      if (interruptId) forgetRunApprovalOutbound(interruptId)
    }
    void settleApprovalCard({
      adapterId: ctx.adapterId,
      conversationKey: ctx.conversationKey,
      conversationRef: ctx.conversationRef,
      surfaceId,
      jobId: approvalJobId,
      state: expired ? "expired" : decision.decision === "allow" ? "approved" : "denied",
    })
    if (ctx.runId && interruptId) {
      const { resolveRunInterruptFromSource } = await import("@/lib/execution/run-control")
      await resolveRunInterruptFromSource(
        ctx.runId,
        interruptId,
        decision.decision === "allow" ? "approve" : "deny"
      )
    }
    // `onExpire` also fires when the owner's signal ends the wait; only a TTL
    // expiry means nobody answered.
    if (expired && !ctx.signal?.aborted && ctx.onUnanswered) return ctx.onUnanswered(req)
    return decision
  }
}

/**
 * Resolve a `tool_approve` button press into a capture decision + apply the
 * "allow for session" bypass. "Allow for this request" resolves an allow the
 * outbound policy grants for the rest of the request (ADR-0239). Returns the
 * decision string used for auditing. Called by the bus `tool_approve`
 * short-circuit.
 */
export function applyToolApprovalCallback(input: {
  sessionId: string
  requestId: string
  toolName: string
  decision: ToolApprovalDecision
  resolve: (sessionId: string, requestId: string, decision: CapturePermissionDecision) => boolean
}): { granted: boolean; resolved: boolean } {
  const granted = input.decision !== "deny"
  const capture: CapturePermissionDecision = !granted
    ? { decision: "deny" }
    : input.decision === "allow_request"
      ? { decision: "allow", forRequest: true }
      : { decision: "allow" }
  const resolved = input.resolve(input.sessionId, input.requestId, capture)
  if (resolved && input.decision === "allow_session")
    grantSessionBypass(input.sessionId, input.toolName)
  return { granted: granted && resolved, resolved }
}
