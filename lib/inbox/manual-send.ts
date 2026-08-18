/**
 * Send free text into one platform-bound (IM) conversation as a manual reply.
 *
 * Thin client of the inbox write path (`lib/connectors/inbox-writes`, ADR-0131):
 * it hands over the session's binding and the text, and the relay picks the
 * route (local connector runtime vs. durable relay to the host) and mints the
 * one idempotency key + client message id every layer shares. Used by the
 * message row's "send to IM…" action; the Inbox composer's own manual mode goes
 * through the same `sendManualReply`.
 */

import type { ChatSession } from "@cognia/agent-config-types"

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
