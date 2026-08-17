import { isPlatformKind, type PlatformKind } from "./platform-kind"
import type { ChannelKind } from "./event"

export type TopicIsolationCapability = "native" | "unsupported"
export type AmbiguousDeliveryCapability = "remote_idempotent" | "reconciliation_required"

/**
 * Platform-neutral conversation/runtime capability declaration. Correctness
 * semantics never derive from this matrix; it only selects an explicitly
 * declared delivery or presentation path.
 */
export interface ConnectorRuntimeCapabilityMatrix {
  topicIsolation: TopicIsolationCapability
  unmentionedDelivery: boolean
  historyPagination: boolean
  liveSteer: boolean
  textStreaming: boolean
  componentMutation: boolean
  fullReplacement: boolean
  messageEditing: boolean
  appendFallback: boolean
  interactiveControls: boolean
  followUpBubbles: boolean
  staticMenus: boolean
  suggestedPrompts: boolean
  ambiguousDelivery: AmbiguousDeliveryCapability
}

const FINAL_ONLY: ConnectorRuntimeCapabilityMatrix = {
  topicIsolation: "unsupported",
  unmentionedDelivery: false,
  historyPagination: false,
  liveSteer: true,
  textStreaming: false,
  componentMutation: false,
  fullReplacement: false,
  messageEditing: false,
  appendFallback: true,
  interactiveControls: false,
  followUpBubbles: false,
  staticMenus: false,
  suggestedPrompts: false,
  ambiguousDelivery: "reconciliation_required",
}

const BUILT_IN_OVERRIDES: Partial<Record<PlatformKind, Partial<ConnectorRuntimeCapabilityMatrix>>> =
  {
    lark: {
      topicIsolation: "native",
      unmentionedDelivery: true,
      historyPagination: true,
      textStreaming: true,
      componentMutation: true,
      fullReplacement: true,
      messageEditing: true,
      interactiveControls: true,
      followUpBubbles: true,
      staticMenus: true,
      ambiguousDelivery: "remote_idempotent",
    },
    slack: {
      topicIsolation: "native",
      unmentionedDelivery: true,
      historyPagination: true,
      textStreaming: true,
      messageEditing: true,
      interactiveControls: true,
      suggestedPrompts: true,
      // Slack chat.postMessage currently receives no stable client_msg_id
      // from our serializer, so a lost acknowledgement cannot be retried
      // safely. Keep reconciliation-required until the wire contract proves
      // propagation of the request idempotency key.
      ambiguousDelivery: "reconciliation_required",
    },
    discord: {
      topicIsolation: "native",
      unmentionedDelivery: true,
      historyPagination: true,
      messageEditing: true,
      interactiveControls: true,
      // Every message-create carries a deterministic `nonce` +
      // `enforce_nonce: true` derived from the job idempotency key
      // (`discordNonce` in adapters/discord/serialize.ts), so a retry after
      // a lost ack returns the original message instead of a duplicate.
      ambiguousDelivery: "remote_idempotent",
    },
    telegram: {
      topicIsolation: "native",
      unmentionedDelivery: true,
      messageEditing: true,
      interactiveControls: true,
    },
    matrix: {
      unmentionedDelivery: true,
      historyPagination: true,
      messageEditing: true,
      // `PUT /rooms/{room}/send/{type}/{txnId}` with txnId = idempotency key:
      // the homeserver de-duplicates on txnId and returns the same event id.
      ambiguousDelivery: "remote_idempotent",
    },
    onebot: { unmentionedDelivery: true, historyPagination: true },
    wecom: { unmentionedDelivery: true, textStreaming: true },
    "wechat-personal": { unmentionedDelivery: true },
    // Explicit (not implicit FINAL_ONLY) so a reviewer can see the verdict:
    // DingTalk stream-mode bots only receive @-messages / DMs, and neither
    // the group nor the oto send API takes an idempotency token.
    dingtalk: { unmentionedDelivery: false, ambiguousDelivery: "reconciliation_required" },
    // QQ pushes only @-messages / C2C; passive `msg_seq` is derived from the
    // idempotency key so a retry is REJECTED (not delivered twice), but the
    // rejection is an error rather than the original id → still reconcile.
    "qq-official": { unmentionedDelivery: false, ambiguousDelivery: "reconciliation_required" },
    // Every subscriber message reaches the official account (no @ concept);
    // customer-service sends carry no idempotency token.
    "wechat-oa": { unmentionedDelivery: true, ambiguousDelivery: "reconciliation_required" },
  }

/**
 * True when `platform` has an explicit entry in the built-in override table
 * (even an empty one), i.e. its runtime contract was reviewed rather than
 * silently inheriting `FINAL_ONLY`. Every shipped (non-`planned`) platform
 * must be explicit — pinned by runtime-capability.test.ts.
 */
export function hasExplicitRuntimeCapabilityOverride(platform: PlatformKind): boolean {
  return isPlatformKind(platform) && Object.hasOwn(BUILT_IN_OVERRIDES, platform)
}

export function builtInConnectorRuntimeCapabilities(
  platform: PlatformKind
): ConnectorRuntimeCapabilityMatrix {
  return {
    ...FINAL_ONLY,
    ...(isPlatformKind(platform) ? BUILT_IN_OVERRIDES[platform] : undefined),
  }
}

/** Resolve platform features whose contract varies by conversation scope. */
export function connectorRuntimeCapabilitiesForScope(
  platform: PlatformKind,
  scopeKind: ChannelKind
): ConnectorRuntimeCapabilityMatrix {
  const capabilities = builtInConnectorRuntimeCapabilities(platform)
  if (platform === "lark" && scopeKind !== "private") {
    return { ...capabilities, followUpBubbles: false }
  }
  return capabilities
}
