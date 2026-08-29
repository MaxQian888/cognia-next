/**
 * Render another conversation into the text `@chat:` stages.
 *
 * Split out of `entity-sources.ts` so the registry stays free of message-part
 * knowledge, and so this can be unit-tested against parts without touching the
 * registry at all.
 *
 * The projection is `lib/chat/search/project-text.ts`, NOT a fresh walk over
 * `parts`. That module is already the single definition of "what a message's
 * readable body is" — it covers text / markdown / code / reasoning / file names
 * / source titles / tool names + inputs, and deliberately drops tool OUTPUTS
 * because a single file read can be tens of KB. Writing a second walk here
 * would mean two answers to one question, and the other one is the one chat
 * search has already been tuned against.
 */

import { projectSearchText } from "@/lib/chat/search/project-text"

/**
 * Messages included, newest-last.
 *
 * The TAIL, not the head: a conversation is referenced for where it got to, and
 * the opening exchange of a long session is the least useful part of it. The
 * cut is announced in the returned text so the model never reads a truncated
 * transcript as a complete one.
 */
export const MAX_TRANSCRIPT_MESSAGES = 40

interface TranscriptMessage {
  role: string
  parts: Parameters<typeof projectSearchText>[0]
}

export interface FormatTranscriptOptions {
  /**
   * The caller read a bounded tail, so it knows a cut happened but not how big
   * it was. The banner then omits the count rather than reporting the one
   * message the over-read happens to expose, which would understate the cut by
   * however many messages were never read.
   */
  earlierUnknown?: boolean
}

/** Format an already-loaded message list. Exported for tests. */
export function formatTranscript(
  messages: readonly TranscriptMessage[],
  { earlierUnknown = false }: FormatTranscriptOptions = {}
): string | null {
  const dropped = Math.max(0, messages.length - MAX_TRANSCRIPT_MESSAGES)
  const tail = dropped > 0 ? messages.slice(dropped) : messages
  const lines: string[] = []
  if (dropped > 0) {
    lines.push(
      earlierUnknown
        ? `[Earlier messages of this conversation are not included — only the most recent ${MAX_TRANSCRIPT_MESSAGES} are shown.]`
        : `[Earlier ${dropped} message(s) of this conversation are not included — only the most recent ${MAX_TRANSCRIPT_MESSAGES} are shown.]`,
      ""
    )
  }
  for (const message of tail) {
    const text = projectSearchText(message.parts)
    // A message that projects to nothing (a bare tool result, an image with no
    // alt) contributes an empty turn; skipping it keeps the transcript readable
    // rather than padding it with blank role labels.
    if (!text) continue
    lines.push(`${message.role}: ${text}`)
  }
  // Every message projected to nothing — a transcript of nothing but images or
  // tool results. Returning null makes the caller say the record is unreadable
  // instead of staging an empty chip that claims to carry a conversation.
  if (lines.every((line) => line === "" || line.startsWith("[Earlier "))) return null
  return lines.join("\n\n")
}

/**
 * Load and format a session's transcript, or null when it has no readable body.
 *
 * Reads the TAIL only (`listRecentMessages`), not the whole conversation. The
 * previous `listMessages(sessionId)` pulled every row of the session *with its
 * `parts`* — a single tool result can be tens of KB — and then discarded all
 * but the last 40. One extra message is read so the "[Earlier N …]" banner can
 * still say that a cut happened; the exact N is unknowable without counting the
 * whole session, so the banner is phrased for that (`formatTranscript` sees the
 * over-read slice and drops exactly one message).
 */
export async function getSessionTranscriptText(sessionId: string): Promise<string | null> {
  const { listRecentMessages } = await import("@/lib/db/messages")
  const messages = await listRecentMessages(sessionId, MAX_TRANSCRIPT_MESSAGES + 1)
  if (messages.length === 0) return null
  return formatTranscript(
    messages.map((m) => ({ role: m.role, parts: m.parts })),
    { earlierUnknown: messages.length > MAX_TRANSCRIPT_MESSAGES }
  )
}
