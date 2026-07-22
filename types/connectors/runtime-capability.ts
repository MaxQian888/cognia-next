import type { PlatformKind } from "./platform-kind"

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
  liveSteer: false,
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
      followUpBubbles: false,
      staticMenus: true,
      ambiguousDelivery: "remote_idempotent",
    },
    slack: {
      topicIsolation: "native",
      unmentionedDelivery: true,
      historyPagination: true,
      liveSteer: false,
      textStreaming: true,
      messageEditing: true,
      interactiveControls: true,
      suggestedPrompts: true,
      ambiguousDelivery: "remote_idempotent",
    },
    discord: {
      topicIsolation: "native",
      unmentionedDelivery: true,
      historyPagination: true,
      messageEditing: true,
      interactiveControls: true,
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
    },
    onebot: { unmentionedDelivery: true, historyPagination: true },
    wecom: { unmentionedDelivery: true, textStreaming: true },
    "wechat-personal": { unmentionedDelivery: true },
  }

export function builtInConnectorRuntimeCapabilities(
  platform: PlatformKind
): ConnectorRuntimeCapabilityMatrix {
  return { ...FINAL_ONLY, ...BUILT_IN_OVERRIDES[platform] }
}
