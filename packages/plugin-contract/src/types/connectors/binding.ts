import type { PlatformKind } from "./platform-kind"
import type { ConversationDeliveryTarget, ConversationReference } from "./event"
import type { ConnectorMode, TriggerPolicy } from "./policy"

export interface PlatformBinding {
  adapterId: string
  conversationKey: string
  platform: PlatformKind
  /** Persisted alongside binding so proactive outbound has a handle. */
  conversationRef: ConversationReference
  /** Latest complete target, including topic identity and reply anchor. */
  deliveryTarget?: ConversationDeliveryTarget
}

/** Optional defaults a Character can ship per platform binding. */
export interface CharacterPlatformDefaults {
  mode?: ConnectorMode
  trigger?: Partial<TriggerPolicy>
}
