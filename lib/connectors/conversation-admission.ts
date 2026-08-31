import type { AdapterInstanceRow, ConversationOverrideRow } from "@/lib/db/connector-types"
import {
  activateConnectorConversation,
  closeConnectorConversation,
  getConnectorConversationState,
  touchConnectorConversation,
} from "@/lib/db/connector-conversation-state"
import { readForResolution } from "@/lib/db/conversation-overrides"
import type { NormalizedInboundEvent } from "@/types/connectors/event"
import { deliveryTargetFromEvent, isReplyToSelf } from "@/types/connectors/event"
import type { InboundActivationPolicy } from "@/types/connectors/policy"

export const DEFAULT_TOPIC_ACTIVATION_TTL_MS = 24 * 60 * 60 * 1_000

export function resolveDeliveryReadiness(
  conversationReadiness: AdapterInstanceRow["deliveryReadiness"] | undefined,
  adapterReadiness: AdapterInstanceRow["deliveryReadiness"] | undefined
): NonNullable<AdapterInstanceRow["deliveryReadiness"]> {
  return conversationReadiness && conversationReadiness !== "unknown"
    ? conversationReadiness
    : (adapterReadiness ?? "unknown")
}

export function resolveActivationTtlMs(
  adapter: Pick<AdapterInstanceRow, "activationTtlMs">,
  override?: Pick<ConversationOverrideRow, "activationTtlMs">,
  explicit?: number
): number {
  return (
    explicit ??
    override?.activationTtlMs ??
    adapter.activationTtlMs ??
    DEFAULT_TOPIC_ACTIVATION_TTL_MS
  )
}

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
 * "The user addressed this bot in a group": an @-mention, or a reply to a
 * message this bot authored. Replying to the bot is as direct an address as
 * mentioning it — `defaultGroupChatPolicy()` has always gated on both — so the
 * mention gate must accept either, otherwise the `reply-to-bot` trigger rule
 * can never fire in a group and ships dormant.
 *
 * `delivery_unverified` deliberately keeps testing `selfMentioned` alone: that
 * gate is about whether the PLATFORM will push unmentioned group events to us,
 * which a reply says nothing about.
 */
export function addressesUs(event: NormalizedInboundEvent): boolean {
  return event.mentions.selfMentioned || isReplyToSelf(event)
}

/**
 * Apply conversation-aware admission after transport/chat-list validation.
 * Mention activation is intentionally limited to explicit thread scopes;
 * parent groups keep requiring a mention.
 */
/**
 * What the admission policy decides for one event, before any stored state is
 * consulted.
 *
 * `consult-activation` is the single branch a pure caller cannot answer: an
 * already-open activation window would admit the message, and only the
 * database knows whether one is open. Naming it as its own outcome is what
 * lets the plugin-facing predictor
 * (`lib/connectors/at-gate.ts:shouldRespondToMessage`) and the bus share this
 * function instead of hand-mirroring two switch statements that drifted every
 * time a branch was added.
 */
export type AdmissionPolicyOutcome =
  | { kind: "allow" }
  /** Admitted, and this message opens or refreshes the activation window. */
  | { kind: "allow-and-activate" }
  | { kind: "deny"; reason: ConversationAdmissionReason }
  | { kind: "consult-activation" }

/** `selfMentioned` or a reply to one of our own messages. */
/**
 * The stateless half of admission: everything decidable from the event, the
 * adapter row and the conversation's policy override.
 *
 * Private chats are admitted before the policy is consulted at all,
 * `direct_only` included, since a DM is exactly what that policy is for.
 */
export function evaluateAdmissionPolicy(input: {
  event: NormalizedInboundEvent
  adapter: Pick<AdapterInstanceRow, "type" | "deliveryReadiness"> & LegacyActivationSettings
  override?: Pick<ConversationOverrideRow, "inboundActivationPolicy"> | null
}): AdmissionPolicyOutcome {
  const { event, adapter } = input
  if (event.channel.kind === "private") return { kind: "allow" }

  const policy = resolveInboundActivationPolicy(adapter, input.override ?? undefined)
  // `delivery_unverified` tests `selfMentioned` ALONE: that gate is about
  // whether the platform will push unmentioned group events to us at all,
  // which a reply says nothing about.
  const deliveryVerified = adapter.deliveryReadiness === "all_messages_verified"
  const mentionedOrDenyUnverified = (): AdmissionPolicyOutcome =>
    event.mentions.selfMentioned
      ? { kind: "allow" }
      : { kind: "deny", reason: "delivery_unverified" }

  if (policy === "always") {
    // Lark only delivers unmentioned group messages once the operator has
    // proven it, so until then `always` still needs a mention.
    if (adapter.type !== "lark" || deliveryVerified) return { kind: "allow" }
    return mentionedOrDenyUnverified()
  }
  if (policy === "direct_only") return { kind: "deny", reason: "at_direct_only" }

  // Activation is limited to explicit thread scopes. A parent group keeps
  // requiring a mention every time.
  if (policy === "mention_each" || event.channel.kind !== "thread") {
    return addressesUs(event) ? { kind: "allow" } : { kind: "deny", reason: "at_mention_required" }
  }

  // `mention_activates` only promises direct follow-ups after the platform has
  // proven it can actually deliver unmentioned group events.
  if (!deliveryVerified) return mentionedOrDenyUnverified()
  if (addressesUs(event)) return { kind: "allow-and-activate" }
  return { kind: "consult-activation" }
}

export async function admitConversationEvent(
  event: NormalizedInboundEvent,
  adapter: AdapterInstanceRow,
  options: {
    now?: number
    activationTtlMs?: number
    override?: ConversationOverrideRow | null
  } = {}
): Promise<ConversationAdmissionDecision> {
  if (event.kind && event.kind !== "create") return { allowed: true, activated: false }
  if (event.channel.kind === "private") return { allowed: true, activated: false }

  const override =
    options.override === undefined
      ? await readForResolution(event.conversationKey).catch(() => undefined)
      : (options.override ?? undefined)
  // The stateless half. Shared verbatim with the plugin-facing predictor, so
  // the two cannot disagree about anything a database is not needed for.
  const outcome = evaluateAdmissionPolicy({ event, adapter, override })
  if (outcome.kind === "allow") return { allowed: true, activated: false }
  if (outcome.kind === "deny") {
    return { allowed: false, reason: outcome.reason, activated: false }
  }

  const now = options.now ?? Date.now()
  const ttl = resolveActivationTtlMs(adapter, override, options.activationTtlMs)
  const deliveryTarget = deliveryTargetFromEvent(event)

  if (outcome.kind === "allow-and-activate") {
    if (deliveryTarget) {
      await activateConnectorConversation(deliveryTarget, {
        activatedBy: event.sender.remoteUserId,
        expiresAt: now + ttl,
        sourceTimestamp: event.timestamp,
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
    sourceTimestamp: event.timestamp,
    now,
  })
  return { allowed: true, activated: false }
}
