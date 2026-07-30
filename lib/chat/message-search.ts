/**
 * Find-in-conversation: locate a needle across the active session's messages.
 *
 * Pure and DOM-free so it works identically on both message-list paths — the
 * virtualized one (where most rows have no DOM node to search) and the
 * document-flow one. Callers turn a {@link MessageSearchHit} into a jump via
 * `index` (virtualizer) or `id` (the row's `data-msg-id` anchor), the same two
 * mechanisms the timeline minimap uses.
 *
 * Text comes from `extractPlainText`, which is why a needle inside a code block
 * or an A2UI surface's plain-text mirror still matches — a `parts[].type ===
 * "text"` walk would silently miss both.
 */

import type { UIMessage } from "ai"
import { extractPlainText } from "@/lib/inbox/extract-plain-text"

export interface MessageSearchHit {
  /** Message id — the `data-msg-id` anchor for document-flow jumps. */
  id: string
  /** Index into the source array — the virtualizer's `scrollToIndex` target. */
  index: number
  /** Number of occurrences within this message (the readout counts messages,
   *  not occurrences, but callers may want the density). */
  count: number
}

export interface MessageSearchIndexEntry {
  id: string
  index: number
  text: string
}

/**
 * Start offsets of every occurrence of `needle` in `haystack`, both already
 * lower-cased. Exported because the history-search snippet builder
 * (`lib/chat/search/snippet.ts`) needs the offsets, not just the count, and the
 * two must not disagree about overlapping matches.
 */
export function findOccurrences(haystack: string, needle: string): number[] {
  if (!needle) return []
  const at: number[] = []
  let from = 0
  for (;;) {
    const found = haystack.indexOf(needle, from)
    if (found === -1) return at
    at.push(found)
    // Advance by one, not by needle.length: overlapping matches ("aa" in
    // "aaa") are still two distinct places a reader would look.
    from = found + 1
  }
}

/** Occurrences of `needle` in `haystack`, both already lower-cased. */
function countOccurrences(haystack: string, needle: string): number {
  return findOccurrences(haystack, needle).length
}

/**
 * Messages whose plain text contains `query`, in conversation order.
 * Case-insensitive substring match; a blank/whitespace-only query matches
 * nothing (rather than everything, which would make "next hit" meaningless).
 */
export function buildMessageSearchIndex(messages: UIMessage[]): MessageSearchIndexEntry[] {
  return messages.map((message, index) => ({
    id: message.id,
    index,
    text: extractPlainText(message.parts).toLowerCase(),
  }))
}

export function findIndexedMessageHits(
  index: MessageSearchIndexEntry[],
  query: string
): MessageSearchHit[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return []

  const hits: MessageSearchHit[] = []
  for (const entry of index) {
    const count = countOccurrences(entry.text, needle)
    if (count > 0) hits.push({ id: entry.id, index: entry.index, count })
  }
  return hits
}

export function findMessageHits(messages: UIMessage[], query: string): MessageSearchHit[] {
  return findIndexedMessageHits(buildMessageSearchIndex(messages), query)
}

/**
 * Step to the next/previous hit, wrapping at both ends. Unlike the timeline's
 * anchor stepping (which clamps), find-in-page conventionally cycles — you ask
 * for "next" until you've seen them all.
 */
export function stepHitIndex(current: number, delta: number, total: number): number {
  if (total <= 0) return -1
  return (((current + delta) % total) + total) % total
}
