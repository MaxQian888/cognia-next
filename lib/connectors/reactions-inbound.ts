/**
 * An IM member's reaction landing on the stored message (ADR-0177, batch 2).
 *
 * `ConnectorBus.applySystemEvent` used to keep a `reaction_added` /
 * `reaction_removed` event as an audit row only. The row it targets is
 * findable (the same `platformMessageId` lookup edits and deletes use), so
 * the reaction now also lands on `metadata.reactions`, where the renderer,
 * the room transcript, and the local picker read it. The actor is namespaced
 * by platform so two platforms' user ids never collide.
 */

import type { StoredMessage } from "@cognia/agent-config-types"
import { platformReactorId } from "@cognia/agent-config-types"

import { reflectMessageReactions } from "@/lib/chat/reactions-store"
import { setMessageReaction } from "@/lib/db/messages"
import type { NormalizedInboundEvent } from "@/types/connectors/event"

export interface InboundReactionInput {
  event: Pick<NormalizedInboundEvent, "platform" | "sender" | "systemKind">
  /** The stored message the reaction targets, already resolved by the bus. */
  row: Pick<StoredMessage, "id" | "sessionId">
  emoji: string
}

/** True when the event is one of the two reaction kinds. */
export function isReactionSystemEvent(
  systemKind: NormalizedInboundEvent["systemKind"]
): systemKind is "reaction_added" | "reaction_removed" {
  return systemKind === "reaction_added" || systemKind === "reaction_removed"
}

/**
 * Record the inbound reaction on the row. Returns `false` when the event did
 * not carry what a reaction needs (an actor and one of the two kinds).
 */
export async function recordInboundReaction(input: InboundReactionInput): Promise<boolean> {
  const { event, row, emoji } = input
  if (!isReactionSystemEvent(event.systemKind)) return false
  const remoteUserId = event.sender?.remoteUserId
  if (!remoteUserId || !emoji) return false
  const reactions = await setMessageReaction(row.sessionId, row.id, {
    emoji,
    actorId: platformReactorId(event.platform, remoteUserId),
    add: event.systemKind === "reaction_added",
  })
  // The desktop bus runs beside the renderer, so an open pane updates now.
  if (reactions) reflectMessageReactions(row.sessionId, row.id, reactions)
  return true
}
