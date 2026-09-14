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
import { stripPromptPreambleFromParts } from "@/lib/chat/prompt-preamble"

/** The fields a reply needs from the message it targets. */
export interface ReplyTargetLike {
  id: string
  parts?: readonly unknown[]
}

/** The reference a reply to `target` carries. */
export function buildReplyTo(target: ReplyTargetLike): MessageReplyTo {
  // Previewed from what the target's author typed. A reply to a turn that
  // carried references would otherwise quote the opening of the app's context
  // envelope instead of the words being answered.
  const parts = target.parts ? stripPromptPreambleFromParts(target.parts) : target.parts
  return { messageId: target.id, preview: buildReplyPreview(parts) }
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

interface ProviderMessageLike {
  role: string
  parts: readonly unknown[]
  metadata?: unknown
}

/**
 * A transcript with every reply line put back in front of its user turn, for a
 * provider that is handed the WHOLE conversation each turn.
 *
 * `prefixReplyContext` only reaches the content of the turn being sent. The
 * standalone engine never reads that content: it converts the message list
 * (`lib/ai/chat/standalone-engine.ts`), whose rows keep the typed text alone —
 * so on a BYOK provider the model never learned which message a reply
 * answered, on the turn itself or on any later one. Rebuilding the line from
 * `metadata.replyTo` for every row is what the Agent SDK's own transcript
 * already holds, since it recorded the prefixed content when it was sent.
 *
 * Returns the same array when no row carries a reply, and never mutates a row.
 */
export function withReplyContextLines<T extends ProviderMessageLike>(messages: readonly T[]): T[] {
  let changed = false
  const out = messages.map((message) => {
    if (message.role !== "user") return message
    const replyTo = readReplyTo(message)
    if (!replyTo) return message
    changed = true
    return {
      ...message,
      parts: [{ type: "text", text: replyContextLine(replyTo) }, ...message.parts],
    } as T
  })
  return changed ? out : (messages as T[])
}
