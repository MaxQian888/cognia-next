/**
 * Merge the two sources of a message's mentions into one deduplicated list.
 *
 * A turn's citations arrive from two places that cannot see each other:
 *   - `resolve-mentions.ts` re-parses the SENT TEXT, which by construction only
 *     finds picks that inserted a token (`@src/app.ts`, `@reviewer`);
 *   - the composer's `citedRefs`, which is how a pick that inserted NO token
 *     (a staged document, a staged record) reports itself.
 *
 * Kept separate from `resolveMentions` on purpose: that function is pure over a
 * string and is also the legacy read path in `read.ts`, where no store exists
 * to consult. Merging there would have made a text-only reader depend on
 * composer state it cannot have.
 */

import type { ContextRef } from "./types"

/** `kind:id` — the same identity `resolveMentions` dedupes on. */
function refKey(ref: ContextRef): string {
  return `${ref.kind}:${ref.id}`
}

/**
 * Concatenate in order, first occurrence wins.
 *
 * Parsed refs come first because a token the user actually typed is the more
 * literal record of what the message says. A duplicate can only happen if a
 * kind is BOTH inserted and recorded, which no current handler does — the
 * dedupe is here so that a future one that does cannot produce two entries for
 * one citation.
 */
export function mergeContextRefs(
  parsed: readonly ContextRef[],
  cited: readonly ContextRef[]
): ContextRef[] {
  const seen = new Set<string>()
  const out: ContextRef[] = []
  for (const ref of [...parsed, ...cited]) {
    const key = refKey(ref)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(ref)
  }
  return out
}
