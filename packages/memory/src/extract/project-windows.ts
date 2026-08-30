/**
 * Split a project session's transcript into bounded windows for mining.
 *
 * WINDOWS ARE IDENTIFIED BY MESSAGE ID, NEVER BY INDEX. Index identity means an
 * edit anywhere earlier in the session shifts the identity of every window after
 * it, so a one-word fix near the top would re-mine the entire conversation and
 * duplicate every claim it already produced. Id identity is also what makes the
 * job's dedupe key stable and what feeds `MemoryJobCheckpoint`.
 *
 * Pure: no I/O, no model calls.
 */

import { createContextManager } from "@cognia/rag/context-manager"

/** Minimum shape this module needs from a transcript entry. */
export interface ProjectWindowMessage {
  id: string
  role: string
  text: string
  createdAt?: number
  parts?: readonly unknown[]
}

export interface ProjectMiningWindow {
  /** Id of the first message in the window. */
  firstMessageId: string
  /** Id of the last message in the window. */
  lastMessageId: string
  messages: ProjectWindowMessage[]
  /** Estimated tokens of the window's text, for budgeting. */
  estimatedTokens: number
}

export interface ProjectWindowOptions {
  maxMessages?: number
  maxTokens?: number
  /**
   * Messages repeated from the end of the previous window. A fact stated across
   * a turn boundary ("…because of X" answering a question asked two messages
   * back) is invisible to a window that starts after the question.
   */
  overlap?: number
}

export const DEFAULT_WINDOW_MAX_MESSAGES = 12
export const DEFAULT_WINDOW_MAX_TOKENS = 6_000
export const DEFAULT_WINDOW_OVERLAP = 2

const tokenCounter = createContextManager({ maxTokens: DEFAULT_WINDOW_MAX_TOKENS })

/** Estimated tokens for one message, reusing the repo's shared estimator. */
export function estimateMessageTokens(message: ProjectWindowMessage): number {
  return tokenCounter.estimateTokens(`${message.role}: ${message.text}`)
}

/**
 * Chunk `messages` into overlapping windows.
 *
 * A single message larger than `maxTokens` still gets its own window rather than
 * being dropped — the extractor's own `context_overflow` handling decides what to
 * do with it, and silently discarding a huge tool result would lose exactly the
 * outcome evidence project mining exists to capture.
 */
export function buildProjectMiningWindows(
  messages: readonly ProjectWindowMessage[],
  options: ProjectWindowOptions = {}
): ProjectMiningWindow[] {
  const maxMessages = Math.max(1, options.maxMessages ?? DEFAULT_WINDOW_MAX_MESSAGES)
  const maxTokens = Math.max(1, options.maxTokens ?? DEFAULT_WINDOW_MAX_TOKENS)
  const overlap = Math.max(0, Math.min(options.overlap ?? DEFAULT_WINDOW_OVERLAP, maxMessages - 1))

  const usable = messages.filter((message) => message.id && message.text.trim().length > 0)
  if (usable.length === 0) return []

  const windows: ProjectMiningWindow[] = []
  let start = 0

  while (start < usable.length) {
    let end = start
    let tokens = 0
    while (end < usable.length && end - start < maxMessages) {
      const next = estimateMessageTokens(usable[end]!)
      // Always take at least one message, even an oversized one.
      if (end > start && tokens + next > maxTokens) break
      tokens += next
      end += 1
    }

    const slice = usable.slice(start, end)
    windows.push({
      firstMessageId: slice[0]!.id,
      lastMessageId: slice[slice.length - 1]!.id,
      messages: slice,
      estimatedTokens: tokens,
    })

    if (end >= usable.length) break
    // Step forward by at least one message so overlap can never stall the walk.
    start = Math.max(start + 1, end - overlap)
  }

  return windows
}
