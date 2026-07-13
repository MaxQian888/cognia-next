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
 * The sidecar blocks the tool until the returned decision arrives, so the turn
 * suspends without any custom machinery. The button-press resolves the pending
 * promise via `bus.dispatchConnectorCallback`'s `tool_approve` short-circuit.
 */

import type { PermissionRequestEvent } from "@cognia/agent-config-types"
import type { CapturePermissionDecision } from "@/lib/claude/run-and-capture"
import type { ConversationReference } from "@/types/connectors/event"
import type { A2UISegmentContent } from "@/types/connectors/segment"
import { enqueueOutbound } from "@/lib/db/outbound-jobs"
import { recordCallbackBinding } from "@/lib/connectors/adapters/_shared/a2ui-mapper"
import { appendAudit } from "@/lib/connectors/audit"
import { buildA2UISegment } from "@/lib/connectors/a2ui-bridge/a2ui-to-segments"
import { newIdempotencyKey } from "@/types/connectors/outbound"
import {
  awaitApproval,
  grantSessionBypass,
  hasSessionBypass,
  type AwaitApprovalOptions,
} from "./approval-registry"

/** Action-id namespaces so the bus can route + the numeric mirror can map. */
export const TOOL_APPROVE_PREFIX = "tapa:"
export const TOOL_DENY_PREFIX = "tapd:"
export const TOOL_ALLOW_SESSION_PREFIX = "taps:"

/** Decision encoded onto a `tool_approve` binding payload. */
export type ToolApprovalDecision = "allow" | "deny" | "allow_session"

export interface ToolApprovalSurfaceInput {
  bindingId: string
  toolName: string
}

/**
 * Pure builder for the Allow / Deny / Allow-for-session card. Card-capable
 * adapters render the buttons natively; the rest fall back to the
 * `fallbackText` mirror (incl. the personal-WeChat numeric hint).
 */
export function buildToolApprovalSurface(input: ToolApprovalSurfaceInput): A2UISegmentContent {
  const approve = TOOL_APPROVE_PREFIX + input.bindingId
  const deny = TOOL_DENY_PREFIX + input.bindingId
  const allowSession = TOOL_ALLOW_SESSION_PREFIX + input.bindingId
  const title = `工具授权 / Tool approval: ${input.toolName}`
  const prompt = `助手想运行工具 “${input.toolName}”。是否允许？ / Allow the assistant to run "${input.toolName}"?`
  return {
    components: {
      root: { component: "Card", title, children: ["prompt", "actions"] },
      prompt: { component: "Text", text: prompt },
      actions: { component: "Row", children: ["allow", "deny", "allowSession"] },
      allow: { component: "Button", text: "允许 / Allow", action: "approve", value: approve },
      deny: { component: "Button", text: "拒绝 / Deny", action: "cancel", value: deny },
      allowSession: {
        component: "Button",
        text: "本会话始终允许 / Allow for session",
        action: "approve",
        value: allowSession,
      },
    },
    dataModel: {},
    rootId: "root",
    surfaceType: "inline",
    title,
    widget: {
      fallbackText: [
        `# ${title}`,
        prompt,
        "[允许 / Allow] [拒绝 / Deny] [本会话始终允许 / Allow for session]",
        "回复 1 允许 / 2 拒绝 / 3 本会话始终允许",
      ].join("\n"),
    },
  }
}

export interface ImPermissionResponderContext {
  sessionId: string
  adapterId: string
  conversationKey: string
  conversationRef: ConversationReference
  /** `"yolo"` auto-approves every ask-tier tool; default `"prompt"`. */
  approvalMode?: "prompt" | "yolo"
  // Injectable for tests.
  enqueue?: typeof enqueueOutbound
  recordBinding?: typeof recordCallbackBinding
  audit?: typeof appendAudit
  ttlMs?: number
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
    // 1. yolo mode or a prior "allow for session" → auto-approve.
    if (ctx.approvalMode === "yolo" || hasSessionBypass(ctx.sessionId, req.toolName)) {
      return { decision: "allow" }
    }

    // 2. Project the approval card + record one binding per button.
    const bindingId = newIdempotencyKey().slice(0, 8)
    const surfaceId = `tool_approve:${ctx.conversationKey}:${bindingId}`
    const surface = buildToolApprovalSurface({ bindingId, toolName: req.toolName })

    const buttons: Array<{
      actionId: string
      componentId: string
      decision: ToolApprovalDecision
    }> = [
      { actionId: TOOL_APPROVE_PREFIX + bindingId, componentId: "allow", decision: "allow" },
      { actionId: TOOL_DENY_PREFIX + bindingId, componentId: "deny", decision: "deny" },
      {
        actionId: TOOL_ALLOW_SESSION_PREFIX + bindingId,
        componentId: "allowSession",
        decision: "allow_session",
      },
    ]
    try {
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
          })
        )
      )
      await enqueue({
        adapterId: ctx.adapterId,
        conversationKey: ctx.conversationKey,
        request: {
          conversationRef: ctx.conversationRef,
          segments: [buildA2UISegment(surfaceId, surface)],
          metadata: { idempotencyKey: newIdempotencyKey() },
        },
        source: "ai-run",
      })
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
      return { decision: "deny", message: "failed to surface approval card" }
    }

    // 3. Suspend until the button-press callback resolves us (or TTL denies).
    const opts: AwaitApprovalOptions = {
      ttlMs: ctx.ttlMs,
      onExpire: () => {
        void audit({
          adapterId: ctx.adapterId,
          kind: "tool_approve.expired",
          at: Date.now(),
          conversationKey: ctx.conversationKey,
          fields: { toolName: req.toolName, requestId: req.requestId },
        }).catch(() => undefined)
      },
    }
    return awaitApproval(ctx.sessionId, req.requestId, opts)
  }
}

/**
 * Resolve a `tool_approve` button press into a capture decision + apply the
 * "allow for session" bypass. Returns the decision string used for auditing.
 * Called by the bus `tool_approve` short-circuit.
 */
export function applyToolApprovalCallback(input: {
  sessionId: string
  requestId: string
  toolName: string
  decision: ToolApprovalDecision
  resolve: (sessionId: string, requestId: string, decision: CapturePermissionDecision) => boolean
}): { granted: boolean; resolved: boolean } {
  const granted = input.decision !== "deny"
  if (input.decision === "allow_session") {
    grantSessionBypass(input.sessionId, input.toolName)
  }
  const capture: CapturePermissionDecision = granted ? { decision: "allow" } : { decision: "deny" }
  const resolved = input.resolve(input.sessionId, input.requestId, capture)
  return { granted, resolved }
}
