/**
 * Provider-neutral pull-request observation DTOs for the Agent Team PR feedback
 * loop. This is a trimmed TypeScript port of agent-orchestrator's
 * `backend/internal/ports/scm_observations.go`: a snapshot of a PR's state, CI,
 * review, and mergeability that the observer fetches, persists as durable facts,
 * and hands to the reaction reducer + status deriver.
 *
 * Kept lean because it is JSON-persisted in the `teamPrObservations` Dexie row.
 * All display status is DERIVED from these facts at read time (see
 * `derive-status.ts`) — never stored as a fact.
 */

import type { ReviewThread, ReviewThreadComment } from "@cognia/github-bot-kit"

export type CiSummary = "unknown" | "pending" | "passing" | "failing"

export type PrState = "draft" | "open" | "merged" | "closed"

export type ReviewDecision = "none" | "approved" | "changes_requested" | "review_required"

export type MergeabilityState = "unknown" | "mergeable" | "conflicting" | "behind" | "blocked"

export interface PrCheckObservation {
  /** Check-run name or status context name. */
  name: string
  /** Normalized check status: queued | in_progress | completed. */
  status: string
  /** Provider conclusion: success | failure | cancelled | timed_out | ... */
  conclusion?: string
  /** Provider link to the check details (used to resolve the job log). */
  url?: string
  /** Last ~20 lines of the failed job log, when fetched. Best-effort. */
  logTail?: string
  /** Head commit SHA the check applies to. */
  commitHash: string
  /** Opaque provider id (Actions job id) used to fetch the log tail. */
  providerId?: string
}

export type PrReviewCommentObservation = ReviewThreadComment

export type PrReviewThreadObservation = ReviewThread

export interface PrMetaObservation {
  url: string
  number: number
  state: PrState
  draft: boolean
  merged: boolean
  closed: boolean
  sourceBranch: string
  targetBranch: string
  headSha: string
  title: string
  additions: number
  deletions: number
  author: string
}

export interface PrCiObservation {
  summary: CiSummary
  headSha: string
  failedChecks: PrCheckObservation[]
}

export interface PrReviewObservation {
  decision: ReviewDecision
  threads: PrReviewThreadObservation[]
}

export interface PrMergeabilityObservation {
  state: MergeabilityState
  mergeable: boolean
  conflict: boolean
  behindBase: boolean
}

export interface PrChangedBuckets {
  metadata: boolean
  ci: boolean
  review: boolean
}

export type PrDerivedStatus =
  | "none"
  | "pr_open"
  | "draft"
  | "ci_pending"
  | "ci_failed"
  | "changes_requested"
  | "merge_conflict"
  | "review_pending"
  | "approved"
  | "mergeable"
  | "merged"
  | "closed"

export interface PrObserveEtags {
  pr?: string
  checks?: string
  reviews?: string
  comments?: string
}

export interface PrObservation {
  fetched: boolean
  observedAt: number
  /** "owner/name". */
  repo: string
  pr: PrMetaObservation
  ci: PrCiObservation
  review: PrReviewObservation
  mergeability: PrMergeabilityObservation
  changed: PrChangedBuckets
  /** Cache validators to pass to the next poll for conditional requests. */
  etags?: PrObserveEtags
}

export interface ObserveRepo {
  /** "owner/name". */
  fullName: string
  owner: string
  name: string
}

export type ObserveRef = { number: number; url?: string } | { branch: string }

export interface OctokitLike {
  request(
    route: string,
    params?: Record<string, unknown>
  ): Promise<{
    status: number
    headers: Record<string, string | undefined>
    data: unknown
  }>
}

export function unfetchedObservation(repo: string, observedAt: number): PrObservation {
  return {
    fetched: false,
    observedAt,
    repo,
    pr: {
      url: "",
      number: 0,
      state: "open",
      draft: false,
      merged: false,
      closed: false,
      sourceBranch: "",
      targetBranch: "",
      headSha: "",
      title: "",
      additions: 0,
      deletions: 0,
      author: "",
    },
    ci: { summary: "unknown", headSha: "", failedChecks: [] },
    review: { decision: "none", threads: [] },
    mergeability: { state: "unknown", mergeable: false, conflict: false, behindBase: false },
    changed: { metadata: false, ci: false, review: false },
  }
}

export function parseRepoFullName(fullName: string): ObserveRepo {
  const trimmed = fullName.trim().replace(/\.git$/, "")
  const slash = trimmed.indexOf("/")
  if (slash <= 0 || slash === trimmed.length - 1 || trimmed.indexOf("/", slash + 1) !== -1) {
    throw new Error(`invalid repo full name: "${fullName}" (expected "owner/name")`)
  }
  return { fullName: trimmed, owner: trimmed.slice(0, slash), name: trimmed.slice(slash + 1) }
}
