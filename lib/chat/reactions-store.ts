/**
 * Mirror a reaction write into the open pane (ADR-0177, batch 2).
 *
 * `setMessageReaction` writes the Dexie row and publishes a transcript
 * revision, but the only consumer of that revision is the search index. The
 * chat store's slice for an open session is a copy of the rows, so without
 * this the pill would appear only after the next reload. Both writers call
 * it: the local picker and the bus landing an inbound IM reaction. A session
 * with no slice (not open in any pane) is left alone, since its next open
 * reads the row.
 */

import type { UIMessage } from "ai"
import type { MessageReaction } from "@cognia/agent-config-types"

import { useChatStore } from "@/stores/chat"

export function reflectMessageReactions(
  sessionId: string,
  messageId: string,
  reactions: readonly MessageReaction[]
): boolean {
  const store = useChatStore.getState()
  const slice = store.sessions[sessionId]
  if (!slice) return false
  const index = slice.messages.findIndex((message) => message.id === messageId)
  if (index < 0) return false
  const current = slice.messages[index]!
  const metadata = {
    ...((current as { metadata?: Record<string, unknown> }).metadata ?? {}),
    reactions: [...reactions],
  }
  const next = slice.messages.slice()
  next[index] = { ...current, metadata } as UIMessage
  store.replaceSessionMessages(sessionId, next)
  return true
}
