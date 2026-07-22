import type { AdapterInstanceRow, ConversationOverrideRow } from "@/lib/db/connector-types"
import {
  activateConnectorConversation,
  closeConnectorConversation,
  getConnectorConversationState,
  touchConnectorConversation,
} from "@/lib/db/connector-conversation-state"
import { readForResolution } from "@/lib/db/conversation-overrides"
import type { NormalizedInboundEvent } from "@/types/connectors/event"
import { deliveryTargetFromEvent } from "@/types/connectors/event"
import type { InboundActivationPolicy } from "@/types/connectors/policy"

export const DEFAULT_TOPIC_ACTIVATION_TTL_MS = 24 * 60 * 60 * 1_000

export type ConversationAdmissionReason =
  | "at_mention_required"
  | "at_direct_only"
  | "delivery_unverified"
  | "topic_activation_required"
  | "topic_activation_expired"

export interface ConversationAdmissionDecision {
  allowed: boolean
  reason?: ConversationAdmissionReason
  activated: boolean
}

type LegacyActivationSettings = Pick<
  AdapterInstanceRow,
  "atResponseStrategy" | "inboundActivationPolicy"
>

/** Resolve the new policy without silently changing any legacy row semantics. */
export function resolveInboundActivationPolicy(
  adapter: LegacyActivationSettings,
  override?: Pick<ConversationOverrideRow, "inboundActivationPolicy">
): InboundActivationPolicy {
  if (override?.inboundActivationPolicy) return override.inboundActivationPolicy
  if (adapter.inboundActivationPolicy) return adapter.inboundActivationPolicy
  switch (adapter.atResponseStrategy) {
    case "always":
      return "always"
    case "direct_only":
      return "direct_only"
    case "mention_only":
    case undefined:
      return "mention_each"
  }
}

/**
 * Apply conversation-aware admission after transport/chat-list validation.
 * Mention activation is intentionally limited to explicit thread scopes;
 * parent groups keep requiring a mention.
 */
export async function admitConversationEvent(
  event: NormalizedInboundEvent,
  adapter: AdapterInstanceRow,
  options: { now?: number; activationTtlMs?: number } = {}
): Promise<ConversationAdmissionDecision> {
  if (event.kind && event.kind !== "create") return { allowed: true, activated: false }
  if (event.channel.kind === "private") return { allowed: true, activated: false }

  const override = await readForResolution(event.conversationKey).catch(() => undefined)
  const policy = resolveInboundActivationPolicy(adapter, override)
  if (policy === "always") return { allowed: true, activated: false }
  if (policy === "direct_only") {
    return { allowed: false, reason: "at_direct_only", activated: false }
  }
  if (policy === "mention_each" || event.channel.kind !== "thread") {
    return event.mentions.selfMentioned
      ? { allowed: true, activated: false }
      : { allowed: false, reason: "at_mention_required", activated: false }
  }

  // `mention_activates` only promises direct follow-ups after the platform has
  // proven it can actually deliver unmentioned group events.
  if (adapter.deliveryReadiness !== "all_messages_verified") {
    return event.mentions.selfMentioned
      ? { allowed: true, activated: false }
      : { allowed: false, reason: "delivery_unverified", activated: false }
  }

  const now = options.now ?? Date.now()
  const ttl = options.activationTtlMs ?? DEFAULT_TOPIC_ACTIVATION_TTL_MS
  const deliveryTarget = deliveryTargetFromEvent(event)

  if (event.mentions.selfMentioned) {
    if (deliveryTarget) {
      await activateConnectorConversation(deliveryTarget, {
        activatedBy: event.sender.remoteUserId,
        expiresAt: now + ttl,
        now,
      })
      return { allowed: true, activated: true }
    }
    return { allowed: true, activated: false }
  }

  const state = await getConnectorConversationState(event.conversationKey)
  if (!state || state.activationStatus !== "active") {
    return { allowed: false, reason: "topic_activation_required", activated: false }
  }
  if (state.expiresAt !== undefined && state.expiresAt <= now) {
    await closeConnectorConversation(event.conversationKey, { now })
    return { allowed: false, reason: "topic_activation_expired", activated: false }
  }
  await touchConnectorConversation(event.conversationKey, {
    deliveryTarget,
    expiresAt: now + ttl,
    now,
  })
  return { allowed: true, activated: false }
}
