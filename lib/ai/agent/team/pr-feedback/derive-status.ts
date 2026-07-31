/**
 * Read-time PR status derivation for the Agent Team PR feedback loop. A trimmed
 * port of agent-orchestrator's status-derivation precedence
 * (docs/architecture.md "Status Derivation"): display status is computed from
 * the durable {@link PrObservation} facts and never stored.
 *
 * Precedence (highest → lowest): merged, closed, draft, ci_failed,
 * changes_requested, merge_conflict, ci_pending, mergeable, approved,
 * review_pending, pr_open. A not-fetched / no-PR observation is `none`.
 */

import { hasUnresolvedNonBotComments } from "@/lib/github/pr-observe/predicates"
import type { PrDerivedStatus, PrObservation } from "@/lib/github/pr-observe/types"

export function derivePrStatus(obs: PrObservation): PrDerivedStatus {
  if (!obs.fetched || obs.pr.number === 0) return "none"
  if (obs.pr.merged) return "merged"
  if (obs.pr.closed) return "closed"
  if (obs.pr.draft) return "draft"

  // CI failure is the highest actionable signal — fix it before anything else.
  if (obs.ci.summary === "failing") return "ci_failed"

  // Requested changes / unresolved human comments outrank a merge conflict:
  // reviewers gate the content, rebasing is mechanical.
  if (
    obs.review.decision === "changes_requested" ||
    hasUnresolvedNonBotComments(obs.review.threads)
  ) {
    return "changes_requested"
  }
  if (obs.mergeability.conflict) return "merge_conflict"
  if (obs.ci.summary === "pending") return "ci_pending"

  // Ready-to-merge outranks a bare approval (approved but not yet mergeable, e.g.
  // behind base, stays "approved").
  if (obs.mergeability.mergeable) return "mergeable"
  if (obs.review.decision === "approved") return "approved"
  if (obs.review.decision === "none") return "review_pending"
  return "pr_open"
}
