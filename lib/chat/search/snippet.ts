/**
 * Snippet builder — turns a match into "…text around the match…" plus the
 * character positions to emphasize.
 *
 * The positions are the load-bearing part. `MatchHighlight`
 * (`components/chat/completion/match-highlight.tsx`) marks indices *into the
 * string it renders*, so a builder that returned source-text offsets alongside a
 * clipped excerpt would highlight the wrong characters — silently, and worse the
 * further into a message the match sits. Everything here exists to keep the two
 * coordinate systems in sync, including the leading ellipsis's own width.
 *
 * Occurrence finding is delegated to `lib/chat/message-search.ts:findOccurrences`
 * so find-in-conversation and history search cannot disagree about overlapping
 * matches ("aa" in "aaa" is two places a reader would look, not one).
 */

import { findOccurrences } from "@/lib/chat/message-search"

/** Total characters of source text a snippet may show, ellipses excluded. */
export const SNIPPET_MAX_CHARS = 160

/** Characters of lead-in context kept before the first match. */
export const SNIPPET_CONTEXT_CHARS = 40

/** Clip marker. Its width is part of the position arithmetic — keep it 1 char. */
export const ELLIPSIS = "…"

export interface Snippet {
  /** The excerpt, with `…` where it was clipped. */
  text: string
  /** Indices **into `text`** to emphasize. Feed straight to `MatchHighlight`. */
  positions: number[]
}

export interface BuildSnippetOptions {
  /** Override {@link SNIPPET_MAX_CHARS}. */
  maxChars?: number
  /** Override {@link SNIPPET_CONTEXT_CHARS}. */
  contextChars?: number
}

/** Head-of-text preview, used when there is nothing to centre on. */
function headPreview(text: string, maxChars: number): Snippet {
  return {
    text: text.length > maxChars ? text.slice(0, maxChars) + ELLIPSIS : text,
    positions: [],
  }
}

/**
 * Build the excerpt around the first occurrence of `needle` in `text`.
 *
 * Case-insensitive matching, original casing preserved in the output. A blank or
 * absent needle yields a head preview with no positions, so callers can use this
 * as the list-row preview builder too rather than keeping a second one.
 */
export function buildSnippet(
  text: string,
  needle: string,
  { maxChars = SNIPPET_MAX_CHARS, contextChars = SNIPPET_CONTEXT_CHARS }: BuildSnippetOptions = {}
): Snippet {
  if (!text) return { text: "", positions: [] }

  const trimmed = needle.trim().toLowerCase()
  if (!trimmed) return headPreview(text, maxChars)

  const occurrences = findOccurrences(text.toLowerCase(), trimmed)
  if (occurrences.length === 0) return headPreview(text, maxChars)

  // Window: `contextChars` of lead-in, then as much as the budget allows. When
  // the match sits near the end there is no lead-in to spend, so pull `start`
  // back to use the whole budget rather than emitting a short snippet.
  let start = Math.max(0, occurrences[0] - contextChars)
  const end = Math.min(text.length, start + maxChars)
  if (end - start < maxChars) start = Math.max(0, end - maxChars)

  const leading = start > 0
  const trailing = end < text.length
  const body = text.slice(start, end)
  const snippet = (leading ? ELLIPSIS : "") + body + (trailing ? ELLIPSIS : "")

  // Source index → snippet index. The leading ellipsis shifts everything right.
  const shift = (leading ? ELLIPSIS.length : 0) - start

  // A set, because overlapping occurrences ("aa" in "aaa") claim the same index
  // twice. `MatchHighlight` tolerates duplicates, but emitting them would push
  // the dedupe onto every consumer and make position counts misleading.
  const claimed = new Set<number>()
  for (const at of occurrences) {
    // Straddling the edge is normal — mark only the characters actually shown.
    for (let i = at; i < at + trimmed.length; i++) {
      if (i < start || i >= end) continue
      claimed.add(i + shift)
    }
  }

  return { text: snippet, positions: [...claimed].sort((a, b) => a - b) }
}
