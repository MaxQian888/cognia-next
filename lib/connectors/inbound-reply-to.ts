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
import { stripInboundDisplayMarkers } from "./inbound-stored-parts"
import { encodeQQMessageId } from "./adapters/qq-official/serialize"
import { buildMatrixMessageId } from "./adapters/matrix/ids"

/** Match wire references against adapter-public delivery ids without changing wire replies. */
export function inboundReplyLookupIds(
  event: Pick<NormalizedInboundEvent, "platform" | "replyTo" | "conversationRef">
): string[] {
  const id = event.replyTo?.messageId
  if (typeof id !== "string" || !id) return []
  const ref = event.conversationRef
  if (
    event.platform === "matrix" &&
    typeof ref.roomId === "string" &&
    !id.startsWith(`${ref.roomId}|`)
  )
    return [id, buildMatrixMessageId(ref.roomId, id)]
  if (
    event.platform === "qq-official" &&
    (ref.scene === "group" ||
      ref.scene === "c2c" ||
      ref.scene === "channel" ||
      ref.scene === "direct") &&
    typeof ref.sceneId === "string"
  )
    return [id, encodeQQMessageId(ref.scene, ref.sceneId, id)]
  return [id]
}

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
  if (typeof descriptor?.messageId !== "string" || !descriptor.messageId) return undefined
  const snippet = stripInboundDisplayMarkers(
    typeof descriptor.snippet === "string" ? descriptor.snippet : ""
  )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, REPLY_PREVIEW_MAX)
  const parent = await input.findParent(descriptor.messageId)
  if (parent) {
    // Prefer the stored text: the platform's snippet is often truncated or
    // absent, and the row is what the quote will jump to.
    const preview = stripInboundDisplayMarkers(buildReplyPreview(parent.parts)) || snippet
    return { messageId: parent.id, preview, platformMessageId: descriptor.messageId }
  }
  return {
    messageId: descriptor.messageId,
    preview: snippet,
    platformMessageId: descriptor.messageId,
  }
}
