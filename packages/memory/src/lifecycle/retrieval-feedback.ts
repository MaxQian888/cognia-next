/**
 * What a user's verdict on a recalled memory does to its ranking.
 *
 * Pure, and separate from the Dexie writer, for two reasons: the arithmetic is
 * the part worth testing, and `governanceScoreFor` reads these counters through
 * a Laplace prior — `(positive + 1) / (positive + negative + 2)` — so the shape
 * of what is written here is the shape that moves retrieval order.
 *
 * ## `wrong` is a ranking signal, never a review status
 *
 * It is tempting to map "this was wrong" onto `reviewStatus: "conflict"`. Do
 * not. `isMemoryEligibleForRetrieval` hard-excludes conflicted rows, so one
 * mis-click would silently and permanently remove a memory from recall, from a
 * chip that offers no undo. Correcting a memory is a different intent with its
 * own entry point (`update` / `invalidate`, both of which have confirmation UI).
 *
 * ## `outdated` is the one verdict with a second effect
 *
 * "Wrong" says the memory does not apply here; "outdated" says it stopped being
 * true. The second is a fact about the memory itself, so it also sets
 * `staleness: "stale"` — which `governanceScoreFor` weights at 0.3 against a
 * fresh row's 1.0. Both still count as negative feedback: either way the user
 * is saying this should not have surfaced.
 *
 * ## No `memoryEvidence` row
 *
 * Deliberate. Evidence rows are what the inspector's timeline renders, and a
 * per-click row would bury the handful of entries that explain where a memory
 * came from under a stream of votes. The counters ARE the record.
 */

import type { Memory, MemoryStaleness } from "../types/memory"

export type RetrievalFeedbackVerdict = "helpful" | "wrong" | "outdated"

export const RETRIEVAL_FEEDBACK_VERDICTS: readonly RetrievalFeedbackVerdict[] = [
  "helpful",
  "wrong",
  "outdated",
]

export function isRetrievalFeedbackVerdict(value: unknown): value is RetrievalFeedbackVerdict {
  return value === "helpful" || value === "wrong" || value === "outdated"
}

export interface RetrievalFeedbackPatch {
  retrievalFeedback: {
    positive: number
    negative: number
    lastFeedbackAt: number
  }
  /** Only set by `outdated`; absent otherwise so an existing value is kept. */
  staleness?: MemoryStaleness
}

/**
 * The patch one verdict produces.
 *
 * Counters are clamped at zero on read: a restored backup or a hand-edited row
 * can carry a negative count, and letting that through would make the Laplace
 * ratio exceed 1 and rank a disliked memory above every other.
 */
export function applyRetrievalFeedback(
  memory: Pick<Memory, "retrievalFeedback">,
  verdict: RetrievalFeedbackVerdict,
  now: number
): RetrievalFeedbackPatch {
  const positive = Math.max(0, memory.retrievalFeedback?.positive ?? 0)
  const negative = Math.max(0, memory.retrievalFeedback?.negative ?? 0)
  const patch: RetrievalFeedbackPatch = {
    retrievalFeedback: {
      positive: verdict === "helpful" ? positive + 1 : positive,
      negative: verdict === "helpful" ? negative : negative + 1,
      lastFeedbackAt: now,
    },
  }
  if (verdict === "outdated") patch.staleness = "stale"
  return patch
}
