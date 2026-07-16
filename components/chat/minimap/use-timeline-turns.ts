import { useMemo } from "react"
import type { UIMessage } from "ai"

/**
 * One navigable anchor in the conversation timeline — a user turn plus the
 * assistant/tool replies that follow it (until the next user message).
 */
export interface TimelineTurn {
  /** The anchoring user message id (used for DOM jump + React key). */
  id: string
  /** Index of the user message in the source `messages` array. */
  index: number
  /**
   * Every message id in this turn — the anchoring user message plus its
   * replies. Bookmarks are per-message and the star isn't role-gated, so a
   * turn counts as bookmarked when ANY of its messages is starred; matching on
   * `id` alone would silently drop a starred assistant reply.
   */
  messageIds: string[]
  /** Short label: model-generated summary if present, else first-line truncation. */
  label: string
  /** Longer preview shown on hover. */
  preview: string
  /**
   * Wall-clock ms, read from `metadata.createdAt` — which `listMessages`
   * hoists off the Dexie column. Absent on a message that hasn't been
   * persisted yet (the turn the user just typed), so callers must tolerate
   * `undefined`; `formatTurnTime` renders "" for it.
   */
  time?: number
  /** Number of assistant/tool messages belonging to this turn. */
  replyCount: number
}

const LABEL_MAX = 40
const PREVIEW_MAX = 280

function plainText(m: UIMessage): string {
  return m.parts
    .map((p) => {
      const part = p as { type?: string; text?: string }
      return part.type === "text" && typeof part.text === "string" ? part.text : ""
    })
    .filter(Boolean)
    .join(" ")
    .trim()
}

/**
 * Derive timeline turns from a message list. Each `role === "user"` message
 * starts a turn; the label prefers the cached `metadata.minimapLabel`
 * (model-generated, opt-in) and otherwise falls back to the first non-empty
 * line of the user's text.
 */
export function deriveTimelineTurns(messages: UIMessage[]): TimelineTurn[] {
  const turns: TimelineTurn[] = []
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (m.role !== "user") continue

    const text = plainText(m)
    const meta = (m as { metadata?: { minimapLabel?: string; createdAt?: number } }).metadata
    const summary = meta?.minimapLabel
    const firstLine =
      text
        .split(/\r?\n/)
        .find((l) => l.trim().length > 0)
        ?.trim() ?? ""
    const base = (summary && summary.trim()) || firstLine || "…"

    const messageIds = [m.id]
    for (let j = i + 1; j < messages.length && messages[j].role !== "user"; j++) {
      messageIds.push(messages[j].id)
    }
    const replyCount = messageIds.length - 1

    turns.push({
      id: m.id,
      index: i,
      messageIds,
      label: base.length > LABEL_MAX ? base.slice(0, LABEL_MAX).trim() + "…" : base,
      preview:
        text.length > PREVIEW_MAX ? text.slice(0, PREVIEW_MAX).trim() + "…" : text || firstLine,
      time: typeof meta?.createdAt === "number" ? meta.createdAt : undefined,
      replyCount,
    })
  }
  return turns
}

/** Memoised `deriveTimelineTurns` keyed on the messages reference. */
export function useTimelineTurns(messages: UIMessage[]): TimelineTurn[] {
  return useMemo(() => deriveTimelineTurns(messages), [messages])
}
