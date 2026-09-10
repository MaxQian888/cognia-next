/**
 * An inbound IM reply becomes a `replyTo` reference on the stored row
 * (ADR-0177, batch 2).
 *
 * Adapters already parse the platform's reply descriptor (`event.replyTo`:
 * the parent's platform id and a snippet). Until now it was read by the
 * trigger policy and dropped. The stored row now keeps it, resolved to the
 * local message id when the parent was stored in the same conversation, and
 * otherwise kept as the platform id with `platformMessageId` set, so the
 * renderer can still show the quote and simply not offer a jump.
 */

import { buildReplyPreview, REPLY_PREVIEW_MAX } from "@cognia/agent-config-types"
import type { MessageReplyTo } from "@cognia/agent-config-types"

import type { NormalizedInboundEvent } from "@/types/connectors/event"

export interface ResolveInboundReplyToInput {
  event: Pick<NormalizedInboundEvent, "replyTo">
  /**
   * Look the parent up in the target conversation by its platform id.
   * Returns the stored row's id and parts when found.
   */
  findParent: (
    platformMessageId: string
  ) => Promise<{ id: string; parts?: readonly unknown[] } | undefined>
}

export async function resolveInboundReplyTo(
  input: ResolveInboundReplyToInput
): Promise<MessageReplyTo | undefined> {
  const descriptor = input.event.replyTo
  if (!descriptor?.messageId) return undefined
  const snippet = descriptor.snippet.replace(/\s+/g, " ").trim().slice(0, REPLY_PREVIEW_MAX)
  const parent = await input.findParent(descriptor.messageId)
  if (parent) {
    // Prefer the stored text: the platform's snippet is often truncated or
    // absent, and the row is what the quote will jump to.
    const preview = buildReplyPreview(parent.parts) || snippet
    return { messageId: parent.id, preview, platformMessageId: descriptor.messageId }
  }
  return {
    messageId: descriptor.messageId,
    preview: snippet,
    platformMessageId: descriptor.messageId,
  }
}
