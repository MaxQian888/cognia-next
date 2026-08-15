/**
 * When does a chat transcript switch from plain document flow to the TanStack
 * virtualizer? (ADR-0127 §3)
 *
 * The count threshold alone let a 39-message session made of 200 KB code
 * fences render every fence at once, while a 41-message session of one-liners
 * paid ResizeObserver churn for nothing. Two independent triggers keep both
 * honest:
 *
 *   - **count** — more than {@link VIRTUALIZE_THRESHOLD} rows (unchanged: the
 *     per-row ResizeObserver + scroll-time remount of heavy rows cost more
 *     than windowing saves on a handful of messages);
 *   - **bytes** — more than {@link VIRTUALIZE_TEXT_BYTES_THRESHOLD} characters
 *     of text across every part, which is where un-windowed markdown starts
 *     to dominate first paint regardless of how few rows carry it.
 *
 * Text length is the cheap proxy for render weight: markdown / code / reasoning
 * text is what react-markdown and Shiki have to walk; images and files travel
 * as refs and are already lazy.
 */

import type { UIMessage } from "ai"

/** Row-count trigger. Kept at its long-standing value. */
export const VIRTUALIZE_THRESHOLD = 40

/** Total-text trigger: 256 KB of part text across the transcript. */
export const VIRTUALIZE_TEXT_BYTES_THRESHOLD = 256 * 1024

interface MessageLike {
  parts?: ReadonlyArray<unknown> | null
}

/**
 * Sum of every text-bearing part's length across the transcript. Counts
 * `text`, `reasoning` and `data-commentary` text plus stringified tool
 * input/output only when they are already strings — no JSON.stringify of
 * arbitrary payloads on the render path.
 */
export function transcriptTextLength(messages: ReadonlyArray<MessageLike>): number {
  let total = 0
  for (const message of messages) {
    const parts = message.parts
    if (!parts) continue
    for (const part of parts) {
      if (!part || typeof part !== "object") continue
      const p = part as { text?: unknown; output?: unknown; input?: unknown }
      if (typeof p.text === "string") total += p.text.length
      if (typeof p.output === "string") total += p.output.length
      if (typeof p.input === "string") total += p.input.length
    }
  }
  return total
}

export interface VirtualizeDecisionInput {
  /** Rows the list will render (messages plus any synthetic trailing row). */
  rowCount: number
  /** Result of {@link transcriptTextLength}. */
  textLength: number
}

/** True when either trigger fires. */
export function shouldVirtualize({ rowCount, textLength }: VirtualizeDecisionInput): boolean {
  return rowCount > VIRTUALIZE_THRESHOLD || textLength > VIRTUALIZE_TEXT_BYTES_THRESHOLD
}

/** Convenience for callers that hold a `UIMessage[]`. */
export function shouldVirtualizeMessages(
  messages: ReadonlyArray<UIMessage>,
  extraRows = 0
): boolean {
  return shouldVirtualize({
    rowCount: messages.length + extraRows,
    textLength: transcriptTextLength(messages),
  })
}
