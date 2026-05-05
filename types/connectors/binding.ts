import type { PlatformKind } from "./platform-kind"
import type { ConversationReference } from "./event"
import type { ConnectorMode, TriggerPolicy } from "./policy"

export interface PlatformBinding {
  adapterId: string
  conversationKey: string
  platform: PlatformKind
  /** Persisted alongside binding so proactive outbound has a handle. */
  conversationRef: ConversationReference
}

/** Optional defaults a Character can ship per platform binding. */
export interface CharacterPlatformDefaults {
  mode?: ConnectorMode
  trigger?: Partial<TriggerPolicy>
}
