/**
 * The executor's live upload for one shared run (ADR-0241).
 *
 * Turns the projected parts of the run's current reply into live frames
 * (`live-frames.ts`) and posts them, never stored. The stored corrections stay
 * the record; this only lets members watch a reply as it is written.
 *
 * - **One encoder at a time (R7).** A member draws one live reply per
 *   session, so a second interleaved reply would flicker. A reply ends with
 *   its `settled` (or `reset`) frame, and only then may the next one start.
 *   An ended reply never sends again, so a late frame cannot revive it.
 * - **Single-flight (R2-6).** While a POST is in flight a streaming tick is
 *   skipped rather than queued: the next tick encodes the newest parts, so
 *   the encoder never runs ahead of the wire and no patch is lost in a queue.
 *   A `settled`/`reset` frame waits for the in-flight POST and is always sent.
 * - **Failures never fail the run.** A 429, a 5xx or a network error drops
 *   the frame (the member marks the gap stale until the next keyframe, at
 *   most 2 s away). A redacted reply ends. A stale tool-detail revision asks
 *   the caller to re-read it. Any other 4xx turns live off for the run.
 */

import {
  createTranscriptLiveEncoder,
  type TranscriptLiveFrame,
  type TranscriptLivePart,
} from "@/lib/chat/transcript/live-frames"
import { CollabConflictError, CollabError } from "./client"

/** How often the executor encodes a live frame while a reply streams. */
export const SHARED_LIVE_FRAME_INTERVAL_MS = 250

export interface SharedRunLivePublisherOptions {
  /** The shared (server) session id the frames name. */
  sessionId: string
  post: (frame: TranscriptLiveFrame) => Promise<void>
  now: () => number
  /** The server refused a frame projected under an older tool-detail revision. */
  onToolDetailStale?: () => void
  /** A member redacted this reply while it streamed. */
  onRedacted?: (messageId: string) => void
}

export interface SharedLiveReply {
  /** The reply's server message id. */
  messageId: string
  /** The server id of the member message it answers. */
  replyTo: string
}

export interface SharedRunLivePublisher {
  /** The reply now streaming, if any. */
  readonly current: string | undefined
  readonly disabled: boolean
  /** Whether this reply already ended (settled, reset or redacted). */
  ended(messageId: string): boolean
  stream(reply: SharedLiveReply, parts: readonly TranscriptLivePart[]): Promise<void>
  /**
   * End the reply with its final parts. `afterRevision` is the last session
   * sequence before the final stored correction: a member keeps drawing the
   * reply until its pull has read past it.
   */
  settle(
    reply: SharedLiveReply,
    parts: readonly TranscriptLivePart[],
    afterRevision?: number
  ): Promise<void>
  /** End the reply without content: members fall back to what is stored. */
  reset(messageId: string): Promise<void>
  /** Wait for the in-flight POST. */
  drain(): Promise<void>
  /** Send nothing more. */
  stop(): void
}

function liveFailure(error: unknown): "drop" | "stale" | "redacted" | "disable" {
  if (error instanceof CollabConflictError) {
    const reason = (error.authoritative as { reason?: unknown } | undefined)?.reason
    if (reason === "tool_detail_stale") return "stale"
    if (reason === "message_redacted") return "redacted"
    return "disable"
  }
  if (error instanceof CollabError) {
    if (error.status === 429 || error.status >= 500) return "drop"
    return error.status >= 400 ? "disable" : "drop"
  }
  // A network error: the next keyframe repairs it.
  return "drop"
}

export function createSharedRunLivePublisher(
  options: SharedRunLivePublisherOptions
): SharedRunLivePublisher {
  let active:
    { reply: SharedLiveReply; encoder: ReturnType<typeof createTranscriptLiveEncoder> } | undefined
  const endedIds = new Set<string>()
  let inFlight: Promise<void> | undefined
  let disabled = false
  let stopped = false

  const closed = (messageId: string) => stopped || disabled || endedIds.has(messageId)

  const end = (messageId: string) => {
    endedIds.add(messageId)
    if (active?.reply.messageId === messageId) active = undefined
  }

  const send = async (frame: TranscriptLiveFrame) => {
    const posting = options.post(frame).then(
      () => undefined,
      (error: unknown) => {
        switch (liveFailure(error)) {
          case "stale":
            options.onToolDetailStale?.()
            return
          case "redacted":
            end(frame.messageId)
            options.onRedacted?.(frame.messageId)
            return
          case "disable":
            disabled = true
            return
          case "drop":
            return
        }
      }
    )
    inFlight = posting
    try {
      await posting
    } finally {
      if (inFlight === posting) inFlight = undefined
    }
  }

  const encoderFor = (reply: SharedLiveReply) => {
    if (active?.reply.messageId === reply.messageId) return active.encoder
    // One live reply at a time: a reply the caller moved past is over.
    if (active) endedIds.add(active.reply.messageId)
    const encoder = createTranscriptLiveEncoder({
      sessionId: options.sessionId,
      messageId: reply.messageId,
      replyTo: reply.replyTo,
      now: options.now,
    })
    active = { reply, encoder }
    return encoder
  }

  return {
    get current() {
      return active?.reply.messageId
    },
    get disabled() {
      return disabled
    },
    ended: (messageId) => endedIds.has(messageId),

    async stream(reply, parts) {
      if (closed(reply.messageId) || inFlight) return
      const frame = encoderFor(reply).next(parts, "streaming")
      if (frame) await send(frame)
    },

    async settle(reply, parts, afterRevision) {
      if (closed(reply.messageId)) return
      if (inFlight) await inFlight
      if (closed(reply.messageId)) return
      const frame = encoderFor(reply).next(parts, "settled", afterRevision)
      end(reply.messageId)
      if (frame) await send(frame)
    },

    async reset(messageId) {
      if (closed(messageId) || active?.reply.messageId !== messageId) {
        endedIds.add(messageId)
        return
      }
      if (inFlight) await inFlight
      const encoder = active?.reply.messageId === messageId ? active.encoder : undefined
      end(messageId)
      if (stopped || disabled || !encoder) return
      const frame = encoder.reset()
      if (frame) await send(frame)
    },

    async drain() {
      if (inFlight) await inFlight
    },

    stop() {
      stopped = true
    },
  }
}
