/**
 * Shared read-only predicates over a PR observation's review threads. Extracted
 * so the reaction reducer (nudge content) and the status deriver agree on what
 * counts as actionable review feedback.
 */

import type { PrReviewThreadObservation } from "./types"

/** True when at least one unresolved, non-bot thread has a non-bot comment. */
export function hasUnresolvedNonBotComments(threads: PrReviewThreadObservation[]): boolean {
  return threads.some((t) => !t.resolved && !t.isBot && t.comments.some((c) => !c.isBot))
}

/**
 * Collect unresolved, non-bot review comment bodies and their ids. Bodies drive
 * the nudge text; ids drive the dedup signature (so a re-worded body with the
 * same id does not re-fire, and a new comment does).
 */
export function collectUnresolvedComments(threads: PrReviewThreadObservation[]): {
  bodies: string[]
  ids: string[]
} {
  const bodies: string[] = []
  const ids: string[] = []
  for (const t of threads) {
    if (t.resolved || t.isBot) continue
    for (const c of t.comments) {
      if (c.isBot) continue
      bodies.push(c.body)
      ids.push(c.id)
    }
  }
  return { bodies, ids }
}
