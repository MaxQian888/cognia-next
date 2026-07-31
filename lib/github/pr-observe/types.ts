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

/** Aggregate CI state, normalized across check-runs + commit statuses. */
export type CiSummary = "unknown" | "pending" | "passing" | "failing"

/** Normalized PR lifecycle state. */
export type PrState = "draft" | "open" | "merged" | "closed"

/** Normalized review decision computed from the PR's latest reviews. */
export type ReviewDecision = "none" | "approved" | "changes_requested" | "review_required"

/** Normalized mergeability verdict. */
export type MergeabilityState = "unknown" | "mergeable" | "conflicting" | "behind" | "blocked"

/** One normalized check-run / status context that is currently failing. */
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

/** One normalized review comment inside a thread. */
export interface PrReviewCommentObservation {
  id: string
  author: string
  body: string
  isBot: boolean
}

/**
 * A normalized review thread. NOTE: GitHub's REST API does not expose
 * thread-resolution state (that is GraphQL-only), so `resolved` is best-effort
 * and defaults to false over REST. The reaction reducer treats an unresolved,
 * non-bot comment as actionable, so REST over-reports rather than drops
 * feedback — the safe direction.
 */
export interface PrReviewThreadObservation {
  id: string
  path: string
  line: number
  resolved: boolean
  isBot: boolean
  comments: PrReviewCommentObservation[]
}

/** PR metadata facts. */
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

/** CI facts (rolled-up summary + only the failing checks that may need action). */
export interface PrCiObservation {
  summary: CiSummary
  headSha: string
  failedChecks: PrCheckObservation[]
}

/** Review facts (decision + normalized threads/comments). */
export interface PrReviewObservation {
  decision: ReviewDecision
  threads: PrReviewThreadObservation[]
}

/** Mergeability facts. */
export interface PrMergeabilityObservation {
  state: MergeabilityState
  mergeable: boolean
  conflict: boolean
  behindBase: boolean
}

/** Which semantic buckets changed vs the previous snapshot (semantic diff). */
export interface PrChangedBuckets {
  metadata: boolean
  ci: boolean
  review: boolean
}

/**
 * Display status DERIVED from a {@link PrObservation} at read time (never
 * stored). A trimmed port of agent-orchestrator's status-derivation precedence
 * (docs/architecture.md "Status Derivation"), scoped to PR facts. Session-level
 * states (needs_input / working / terminated) are derived separately by the
 * team runtime, not here.
 */
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

/** ETag cache validators carried forward for conditional (304) requests. */
export interface PrObserveEtags {
  pr?: string
  checks?: string
  reviews?: string
  comments?: string
}

/**
 * A complete provider-neutral PR observation. When `fetched` is false the nested
 * facts are zero-valued and must not be treated as authoritative (mirrors AO's
 * `SCMObservation.Fetched`).
 */
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

/** A repository reference for the observation fetch. */
export interface ObserveRepo {
  /** "owner/name". */
  fullName: string
  owner: string
  name: string
}

/**
 * How to locate the PR to observe: by explicit number, or by discovering the
 * open PR whose head is `branch`.
 */
export type ObserveRef = { number: number; url?: string } | { branch: string }

/**
 * The minimal Octokit surface the fetcher needs. Injected so pure fetch logic is
 * decoupled from `@octokit/core` and trivially mockable in tests (mirrors the
 * poller's `GhTable` minimal-interface pattern).
 */
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

/** Zero-valued observation for the not-fetched / no-PR path. */
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

/** Split "owner/name" into parts. Throws on a malformed repo full name. */
export function parseRepoFullName(fullName: string): ObserveRepo {
  const trimmed = fullName.trim().replace(/\.git$/, "")
  const slash = trimmed.indexOf("/")
  if (slash <= 0 || slash === trimmed.length - 1 || trimmed.indexOf("/", slash + 1) !== -1) {
    throw new Error(`invalid repo full name: "${fullName}" (expected "owner/name")`)
  }
  return { fullName: trimmed, owner: trimmed.slice(0, slash), name: trimmed.slice(slash + 1) }
}
