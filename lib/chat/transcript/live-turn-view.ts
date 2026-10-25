/**
 * Drawing a member agent's live reply beside the Host's timeline (P6e).
 *
 * The brain persists the reply about once a second while the live frames
 * (`live-frames.ts`) arrive every tenth of a second, so a timeline read during
 * the turn already holds an older copy of the same reply. The live reply wins
 * for that turn: the timeline keeps the turn's user side and drops its reply
 * previews, and the live tail draws the reply. A turn the timeline has not
 * read yet is drawn whole from the chat store's tail plus the live reply.
 */

import type { UIMessage } from "ai"
import type { TranscriptTimelineItem } from "@cognia/agent-config-types"

import type { TranscriptLiveTurn } from "./live-frames"

/** Whether a timeline item is the turn that answers `userMessageId`. */
function isTurnOf(item: TranscriptTimelineItem, userMessageId: string): boolean {
  if (item.kind === "system") return false
  if (item.turnKey === `turn:${userMessageId}`) return true
  return item.kind === "completed-turn"
    ? item.userMessages.some((message) => message.id === userMessageId)
    : item.messages.some((message) => message.id === userMessageId)
}

function withoutReply(item: TranscriptTimelineItem, replyId: string): TranscriptTimelineItem {
  if (item.kind === "completed-turn") {
    const { finalResponse, visibleResult, ...rest } = item
    return {
      ...rest,
      ...(finalResponse && finalResponse.id !== replyId ? { finalResponse } : {}),
      ...(visibleResult && visibleResult.id !== replyId ? { visibleResult } : {}),
      // Its detail holds the same reply, older: not while it is drawn live.
      collapsed: { ...item.collapsed, exists: false },
    }
  }
  if (item.kind === "active-turn") {
    return { ...item, messages: item.messages.filter((message) => message.id !== replyId) }
  }
  return item
}

export interface LiveTurnView {
  items: TranscriptTimelineItem[]
  liveMessages: UIMessage[]
}

/**
 * The timeline and live tail to draw. `tail` is the chat store's unfinished
 * tail (`selectActiveTurnMessages`); `live` is the reply to draw, or `null`.
 */
export function withLiveTurn(input: {
  items: TranscriptTimelineItem[]
  tail: UIMessage[]
  live: TranscriptLiveTurn | null
}): LiveTurnView {
  const { items, tail, live } = input
  if (!live) return { items, liveMessages: tail }
  const reply: UIMessage = { id: live.messageId, role: "assistant", parts: live.parts }
  const turn = items.findIndex((item) => isTurnOf(item, live.replyTo))
  if (turn >= 0) {
    return {
      items: items.map((item, index) =>
        index === turn ? withoutReply(item, live.messageId) : item
      ),
      liveMessages: [reply],
    }
  }
  const replaced = tail.some((message) => message.id === live.messageId)
  return {
    items,
    liveMessages: replaced
      ? tail.map((message) => (message.id === live.messageId ? reply : message))
      : [...tail, reply],
  }
}

/**
 * Whether a settled reply has been replaced by the timeline: the timeline has
 * read past the revision the brain had persisted before its final frame.
 * Without that revision, any timeline read after the settle counts.
 */
export function settledReplyCaughtUp(
  live: TranscriptLiveTurn,
  timelineRevision: number | null,
  revisionAtSettle: number | null
): boolean {
  if (live.state !== "settled" || timelineRevision === null) return false
  if (live.afterRevision !== undefined) return timelineRevision > live.afterRevision
  return revisionAtSettle !== null && timelineRevision !== revisionAtSettle
}
