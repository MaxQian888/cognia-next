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
  /** Short label: model-generated summary if present, else first-line truncation. */
  label: string
  /** Longer preview shown on hover. */
  preview: string
  /** Wall-clock ms if the message carries one (persisted rows do). */
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
    const summary = (m as { metadata?: { minimapLabel?: string } }).metadata?.minimapLabel
    const firstLine =
      text
        .split(/\r?\n/)
        .find((l) => l.trim().length > 0)
        ?.trim() ?? ""
    const base = (summary && summary.trim()) || firstLine || "…"

    let replyCount = 0
    for (let j = i + 1; j < messages.length && messages[j].role !== "user"; j++) replyCount++

    turns.push({
      id: m.id,
      index: i,
      label: base.length > LABEL_MAX ? base.slice(0, LABEL_MAX).trim() + "…" : base,
      preview:
        text.length > PREVIEW_MAX ? text.slice(0, PREVIEW_MAX).trim() + "…" : text || firstLine,
      time: (m as { createdAt?: number }).createdAt,
      replyCount,
    })
  }
  return turns
}

/** Memoised `deriveTimelineTurns` keyed on the messages reference. */
export function useTimelineTurns(messages: UIMessage[]): TimelineTurn[] {
  return useMemo(() => deriveTimelineTurns(messages), [messages])
}
