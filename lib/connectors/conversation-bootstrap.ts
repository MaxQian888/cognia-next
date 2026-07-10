/**
 * Proactive conversation materialization (W2 multi-bot, platform-generic).
 *
 * Historically a connector conversation only became "real" when the FIRST
 * INBOUND platform event minted a platform-bound ChatSession. Agent-created
 * chats (`im.create_chat`) invert that: the chat exists platform-side before
 * any inbound arrives. This module pre-mints the session so that
 *   - the conversation appears in the Inbox immediately
 *     (`conversation-list.tsx` lists sessions with `platformBinding`),
 *   - the next genuine inbound from the chat converges on the SAME session
 *     (`findActiveSessionForConversation` resolves via
 *     `platformConversationKey`), and
 *   - proactive AI turns work (`runConnectorDigestTurn` hard-fails with
 *     `session_missing` when no bound session exists).
 *
 * Idempotent: re-running for a conversation that already has a bound session
 * returns it untouched (`created: false`).
 */

import type { NormalizedInboundEvent } from "@/types/connectors/event"
import type { PlatformKind } from "@/types/connectors/platform-kind"
import { buildConversationKey } from "@/types/connectors/event"
import { appendAudit } from "@/lib/connectors/audit"
import {
  createPlatformSession,
  findSessionByConversationKey,
} from "@/lib/connectors/session-bindings"

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

/**
 * Build a fully-typed synthetic inbound event carrying exactly what
 * `createPlatformSession` reads (title/channel/binding fields) plus inert
 * defaults for the rest — no cast games, TS-strict.
 */
function syntheticBootstrapEvent(
  input: BootstrapConversationInput,
  conversationKey: string
): NormalizedInboundEvent {
  const { platform, adapterId, remoteChatId, name } = input
  return {
    platform,
    adapterId,
    selfId: "",
    messageId: `bootstrap:${conversationKey}`,
    conversationRef: { platform, adapterId, channelId: remoteChatId },
    conversationKey,
    sender: {
      id: "",
      platform,
      adapterId,
      remoteUserId: "",
      displayName: name,
    },
    channel: {
      id: remoteChatId,
      name,
      kind: "group",
      platformChannelId: remoteChatId,
    },
    segments: [],
    plainText: "",
    mentions: { selfMentioned: false, users: [] },
    timestamp: Date.now(),
    raw: null,
    kind: "system",
  }
}

export async function bootstrapConversation(
  input: BootstrapConversationInput
): Promise<BootstrapConversationResult> {
  const conversationKey = buildConversationKey(input.platform, input.adapterId, input.remoteChatId)

  const existing = await findSessionByConversationKey(conversationKey)
  if (existing) {
    return { conversationKey, sessionId: existing.id, created: false }
  }

  const session = await createPlatformSession(
    syntheticBootstrapEvent(input, conversationKey),
    input.characterId
  )
  await appendAudit({
    adapterId: input.adapterId,
    kind: "conversation.created",
    at: Date.now(),
    conversationKey,
    fields: {
      remoteChatId: input.remoteChatId,
      ...(input.name ? { name: input.name } : {}),
      ...(input.source ? { source: input.source } : {}),
    },
  })
  return { conversationKey, sessionId: session.id, created: true }
}
