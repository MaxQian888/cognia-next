/**
 * Format staged review outcomes into a block prepended to the outgoing chat
 * message, closing the revision round trip.
 *
 * The forward half already worked: a selection chip aimed a turn at an
 * artifact, and the reply became a per-hunk proposal. The return half did not —
 * rejecting a proposal, or keeping 2 of its 5 hunks, only deleted it locally.
 * The assistant was never told, so it could re-propose exactly what the user
 * had just turned down.
 *
 * Deliberately terse and factual. This rides along silently on the user's next
 * message (they never wrote it), so it must read as a status note the model can
 * act on rather than as words put in the user's mouth.
 *
 * Pure + framework-free for easy testing.
 */

import type { ArtifactReviewReceipt } from "@/types/artifact/artifact"

function formatOne(receipt: ArtifactReviewReceipt): string {
  if (receipt.outcome === "rejected") {
    return `- "${receipt.title}": the user rejected your proposed revision (${receipt.total} ${receipt.total === 1 ? "change" : "changes"}). The artifact is unchanged.`
  }
  if (receipt.accepted === receipt.total) {
    return `- "${receipt.title}": the user accepted your proposed revision in full (${receipt.total}/${receipt.total}).`
  }
  if (receipt.accepted === 0) {
    // Applying with nothing accepted leaves the content untouched — same
    // practical outcome as a rejection, and saying "applied" would mislead.
    return `- "${receipt.title}": the user kept none of the ${receipt.total} proposed changes. The artifact is unchanged.`
  }
  return `- "${receipt.title}": the user accepted ${receipt.accepted} of ${receipt.total} proposed changes and discarded the rest.`
}

/**
 * Returns a markdown block, or an empty string when there is nothing to report
 * (so callers can prepend unconditionally without adding noise).
 */
export function formatReviewReceiptsForLLM(receipts: ArtifactReviewReceipt[]): string {
  if (receipts.length === 0) {
    return ""
  }
  return [
    "Outcome of your previous revision proposal(s) — take this into account rather than re-proposing the same changes:",
    ...receipts.map(formatOne),
  ].join("\n")
}
