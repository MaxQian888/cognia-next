/**
 * `im.broadcast` — fan one message out to multiple known conversations
 * (W2 multi-bot "结果派发"). Needs no adapter capability: each target's
 * conversationKey already carries its adapterId, and delivery rides the
 * durable outbound queue (per-adapter rate limit / circuit breaker /
 * quiet-hours / per-conversation FIFO all apply automatically).
 *
 * Hard rules:
 *   - the content passes `hasNoLeakingPiiDeep` ONCE before any enqueue
 *     (direct-enqueue content is otherwise never PII-scanned — verified gap);
 *   - every target gets a DISTINCT idempotency key (the outbound runner
 *     short-circuits duplicates, which would collapse the fan-out);
 *   - unparseable keys / conversations without a bound session are skipped
 *     and REPORTED, never silently dropped (`broadcast.partial_failure`).
 */

import { z } from "zod"

import { registerBuiltInSkill } from "../registry"
import type { BuiltInSkill } from "../types"
import { buildConfirmSurface } from "../_shared/confirm-surface"
import { previewText } from "./_helpers"

const schema = z.object({
  conversationKeys: z
    .array(z.string().min(1))
    .min(1)
    .max(20)
    .describe(
      "Target conversation keys (platform:adapterId:chatId). Use the current conversation's key or keys from the Inbox; max 20 per call."
    ),
  message: z.string().min(1).describe("Text message to deliver to every target."),
})

interface TargetOutcome {
  conversationKey: string
  status: "enqueued" | "skipped"
  reason?: string
}

const skill: BuiltInSkill<typeof schema> = {
  id: "im.broadcast",
  family: "im",
  label: { en: "Broadcast message", "zh-CN": "广播消息" },
  description: {
    en: "Send one message to multiple existing IM conversations (across bots/platforms). Respects each conversation's quiet hours and rate limits; reports per-target outcomes.",
    "zh-CN":
      "把一条消息发送到多个既有 IM 会话（可跨 bot/平台）。遵守各会话的安静时段与限流；按目标返回结果。",
  },
  platforms: "any",
  // Blast-radius friction: IM channels must allowlist `im.broadcast` before
  // the model can fan out from a chat; desktop invocations are HITL-gated.
  mutation: "write",
  imAccess: "opt-in",
  mcpToolName: "im_broadcast",
  inputSchema: schema,
  execute: async (args) => {
    const { hasNoLeakingPiiDeep } = await import("@cognia/redact")
    if (!hasNoLeakingPiiDeep(args.message)) {
      return {
        status: "denied",
        reason: "pii_blocked",
        message: "Broadcast content rejected by the PII gate — redact identifiers and retry.",
      }
    }

    const { parseConversationKey } = await import("@/types/connectors/event")
    const { findSessionByConversationKey } = await import("@/lib/connectors/session-bindings")
    const { enqueueGovernedMany } = await import("@/lib/connectors/delivery-gateway")
    const { newIdempotencyKey } = await import("@/types/connectors/outbound")
    const { appendAudit } = await import("@/lib/connectors/audit")

    const outcomes: TargetOutcome[] = []
    const batch: Array<Parameters<typeof enqueueGovernedMany>[0][number]> = []
    for (const key of args.conversationKeys) {
      let parsed
      try {
        parsed = parseConversationKey(key)
      } catch {
        outcomes.push({ conversationKey: key, status: "skipped", reason: "invalid_key" })
        continue
      }
      const session = await findSessionByConversationKey(key)
      if (!session) {
        outcomes.push({ conversationKey: key, status: "skipped", reason: "no_bound_session" })
        continue
      }
      const conversationRef = session.platformBinding?.conversationRef ?? {
        platform: parsed.platform,
        adapterId: parsed.adapterId,
        channelId: parsed.remoteChatId,
      }
      batch.push({
        adapterId: parsed.adapterId,
        conversationKey: key,
        request: {
          conversationRef,
          segments: [{ type: "text", text: args.message }],
          // DISTINCT key per target — a shared key would make the runner's
          // idempotency short-circuit collapse the fan-out to one send.
          metadata: { idempotencyKey: newIdempotencyKey() },
        },
        source: "skill",
      })
      outcomes.push({ conversationKey: key, status: "enqueued" })
    }

    await enqueueGovernedMany(batch)

    const enqueued = outcomes.filter((o) => o.status === "enqueued").length
    const skipped = outcomes.length - enqueued
    const auditAdapterId = outcomes.find((o) => o.status === "enqueued")
      ? parseConversationKey(outcomes.find((o) => o.status === "enqueued")!.conversationKey)
          .adapterId
      : "broadcast"
    await appendAudit({
      adapterId: auditAdapterId,
      kind: "broadcast.enqueued",
      at: Date.now(),
      fields: { targetCount: outcomes.length, enqueued, skipped },
    })
    if (skipped > 0) {
      await appendAudit({
        adapterId: auditAdapterId,
        kind: "broadcast.partial_failure",
        at: Date.now(),
        fields: {
          skipped,
          targets: outcomes.filter((o) => o.status === "skipped"),
        },
      })
    }
    return { enqueued, skipped, outcomes }
  },
  hitlSurface: (args) =>
    buildConfirmSurface({
      surfaceId: `sfc_im_broadcast_${Date.now().toString(36)}`,
      title: "Broadcast message",
      summary: `Send one message to ${args.conversationKeys.length} conversation(s).`,
      details: [
        { label: "Message", value: previewText(args.message) },
        {
          label: "Targets",
          value:
            args.conversationKeys.slice(0, 5).join(", ") +
            (args.conversationKeys.length > 5
              ? ` … (+${args.conversationKeys.length - 5} more)`
              : ""),
        },
      ],
    }),
}

registerBuiltInSkill(skill)
