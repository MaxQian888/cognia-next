/**
 * Send human-authored text and attachments into a platform-bound conversation.
 *
 * Thin client of the inbox write path (`lib/connectors/inbox-writes`, ADR-0131):
 * it hands over the session's binding and the text, and the relay picks the
 * route (local connector runtime vs. durable relay to the host) and mints the
 * one idempotency key + client message id every layer shares. Used by the
 * message row's "send to IM…" action; the unified IM composer goes
 * through the same `sendManualReply`.
 */

import type { ChatSession, MessageReplyTo } from "@cognia/agent-config-types"

import type { ChatTemplateRun } from "@/lib/chat/template/run"
import type { SubmittedFile } from "@/lib/chat/attachments/dispatch"
import type { MessageSegment } from "@/types/connectors/segment"
import { getDb } from "@/lib/db/schema"

import { sendManualReply, type SendManualReplyOutcome } from "@/lib/connectors/inbox-writes"

export interface SendManualTextInput {
  /** The target conversation — must carry a `platformBinding`. */
  session: ChatSession
  text: string
}

export interface SendManualTextResult {
  /** Local route only; on the remote route the host allocates the job. */
  jobId?: string
  messageId: string
  route: SendManualReplyOutcome["route"]
  sessionId: string
  conversationKey: string
}

export class NotPlatformBoundError extends Error {
  constructor(sessionId: string) {
    super(`session ${sessionId} has no platform binding`)
    this.name = "NotPlatformBoundError"
  }
}

export class UnsupportedPlatformAttachmentsError extends Error {
  constructor(readonly platform: string) {
    super(`platform ${platform} does not support inline attachments`)
    this.name = "UnsupportedPlatformAttachmentsError"
  }
}

export async function sendManualTextToConversation({
  session,
  text,
}: SendManualTextInput): Promise<SendManualTextResult> {
  const binding = session.platformBinding
  if (!binding) throw new NotPlatformBoundError(session.id)
  const trimmed = text.trim()
  if (!trimmed) throw new Error("empty text")

  const result = await sendManualReply({
    adapterId: binding.adapterId,
    conversationKey: binding.conversationKey,
    conversationRef: binding.conversationRef,
    sessionId: session.id,
    segments: [{ type: "text", text: trimmed }],
  })
  return {
    jobId: result.jobId,
    messageId: result.messageId,
    route: result.route,
    sessionId: session.id,
    conversationKey: binding.conversationKey,
  }
}

/** Files arrive with durable data URLs from the shared composer intake. */
export interface SendManualMessageInput extends SendManualTextInput {
  files: readonly SubmittedFile[]
  replyTo?: MessageReplyTo | null
  templateRun?: ChatTemplateRun | null
}

/** Preserve attachment bytes instead of applying the model's text extraction. */
export async function sendManualMessageToConversation({
  session,
  text,
  files,
  replyTo,
  templateRun,
}: SendManualMessageInput): Promise<SendManualReplyOutcome> {
  const binding = session.platformBinding
  if (!binding) throw new NotPlatformBoundError(session.id)
  // These adapters require public media URLs or render media as text links.
  // Inline bytes cannot be delivered there; reject before accepting any text/job.
  if (files.length > 0 && ["dingtalk", "wechat-oa", "qq-official"].includes(binding.platform))
    throw new UnsupportedPlatformAttachmentsError(binding.platform)
  const segments: MessageSegment[] = text.trim() ? [{ type: "text", text: text.trim() }] : []
  for (const file of files) {
    // A blob URL is process-local and is revoked when the composer clears.
    // Refuse the whole send if intake could not preserve an attachment.
    const match = /^data:([^;,]*);base64,([a-zA-Z0-9+/]*={0,2})$/.exec(file.url ?? "")
    if (!match) throw new Error("attachment bytes unavailable")
    const url = file.url!
    const mimeType = file.mediaType || match[1] || "application/octet-stream"
    const sizeBytes = atob(match[2]).length
    if (mimeType.startsWith("image/")) {
      segments.push({ type: "image", url, alt: file.filename, mimeType })
    } else {
      segments.push({ type: "file", url, name: file.filename || "attachment", mimeType, sizeBytes })
    }
  }
  if (segments.length === 0) throw new Error("empty text")
  let platformMessageId = replyTo?.platformMessageId
  if (replyTo && !platformMessageId) {
    const target = await getDb().messages.get(replyTo.messageId)
    if (target?.sessionId === session.id) {
      platformMessageId = target.platformMessageId ?? target.metadata?.platformMessage?.messageId
      const jobId = target.metadata?.outboundJobId
      if (!platformMessageId && typeof jobId === "string") {
        const job = await getDb().outboundQueue.get(jobId)
        // Some adapters have no message identity (e.g. Slack file-only
        // uploads); the runner stores its idempotency key as delivery evidence.
        if (job?.platformMessageId && job.platformMessageId !== job.idempotencyKey)
          platformMessageId = job.platformMessageId
      }
    }
    // Never send a Cognia message UUID as a platform message id.
    if (!platformMessageId) throw new Error("platform reply target unavailable")
  }
  const threadId = binding.conversationRef.threadId
  return sendManualReply({
    adapterId: binding.adapterId,
    conversationKey: binding.conversationKey,
    conversationRef: binding.conversationRef,
    sessionId: session.id,
    segments,
    ...(platformMessageId ? { replyTo: { messageId: platformMessageId } } : {}),
    ...(typeof threadId === "string" && threadId ? { threadId } : {}),
    label: session.title ?? binding.conversationKey,
    ...(replyTo || templateRun
      ? {
          messageMetadata: {
            ...(replyTo ? { replyTo } : {}),
            ...(templateRun ? { templateRun } : {}),
          },
        }
      : {}),
  })
}
