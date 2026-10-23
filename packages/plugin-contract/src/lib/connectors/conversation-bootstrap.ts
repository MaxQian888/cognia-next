/**
 * The plugin contract's share of `lib/connectors/conversation-bootstrap.ts`, which re-exports these.
 */
import type { PlatformKind } from "../../types/connectors/platform-kind"

export interface BootstrapConversationInput {
  platform: PlatformKind
  adapterId: string
  /** Platform-native chat id (Lark `oc_…`). */
  remoteChatId: string
  /** Chat display name — becomes the session title. */
  name?: string
  characterId?: string
  /** Provenance for the audit row (e.g. `"im.create_chat"`). */
  source?: string
}

export interface BootstrapConversationResult {
  conversationKey: string
  sessionId: string
  /** False when an existing bound session was reused (idempotent re-run). */
  created: boolean
}
