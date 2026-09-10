/**
 * Reply references on messages (ADR-0177, batch 2).
 *
 * A reply is `metadata.replyTo` on the replying row: a target id and a
 * preview. This module is the one place that builds, reads, and renders the
 * reference for the model, so the composer, the room runner, the connector
 * runtime, and the transcript all agree on the shape.
 *
 * Pure: no store, no React, no Dexie.
 */

import {
  buildReplyPreview,
  type MessageReplyTo,
  type SendContent,
} from "@cognia/agent-config-types"

/** The fields a reply needs from the message it targets. */
export interface ReplyTargetLike {
  id: string
  parts?: readonly unknown[]
}

/** The reference a reply to `target` carries. */
export function buildReplyTo(target: ReplyTargetLike): MessageReplyTo {
  return { messageId: target.id, preview: buildReplyPreview(target.parts) }
}

/** The reference on a message, or `null` when it is absent or malformed. */
export function readReplyTo(message: { metadata?: unknown }): MessageReplyTo | null {
  const meta = message.metadata
  if (!meta || typeof meta !== "object") return null
  const value = (meta as { replyTo?: unknown }).replyTo
  if (!value || typeof value !== "object") return null
  const { messageId, preview, platformMessageId } = value as Record<string, unknown>
  if (typeof messageId !== "string" || !messageId) return null
  if (typeof preview !== "string") return null
  return {
    messageId,
    preview,
    ...(typeof platformMessageId === "string" && platformMessageId ? { platformMessageId } : {}),
  }
}

/**
 * A reply reference the way an RPC payload may carry it, or `null` when the
 * value is not one. Strict on purpose: the companion arm hands the result to
 * the runner unchanged, so an unexpected key must not ride into the row.
 */
export function parseReplyToPayload(value: unknown): MessageReplyTo | null {
  return readReplyTo({ metadata: { replyTo: value } })
}

/** The one line a model reads ahead of a reply, so it knows what was answered. */
export function replyContextLine(replyTo: MessageReplyTo): string {
  const preview = replyTo.preview.trim()
  return preview ? `[Replying to: "${preview}"]` : "[Replying to an earlier message]"
}

/**
 * `content` with the reply line in front, for the provider only. The persisted
 * user row keeps the text the user typed and carries the reference in its
 * metadata, so an edit or a re-run never sees the line as part of the prompt.
 */
export function prefixReplyContext(content: SendContent, replyTo: MessageReplyTo): SendContent {
  const line = replyContextLine(replyTo)
  if (typeof content === "string") return `${line}\n\n${content}`
  return [{ type: "text", text: line }, ...content]
}
