/** Repository diff scopes supported by Cognia's unified review surface. */
export type ReviewScope = "lastTurn" | "uncommitted" | "commit" | "branch"

export interface ReviewCommentAnchor {
  repositoryRoot: string
  path: string
  /** Content hash of the exact diff hunk the comment was authored against. */
  hunkHash: string
  side: "before" | "after"
  line: number
  commitSha?: string
}

/** A line comment whose identity follows content rather than transient hunk order. */
export interface ReviewComment {
  id: string
  contentHash: string
  anchor: ReviewCommentAnchor
  body: string
  createdAt: number
  updatedAt: number
  status: "draft" | "submitted" | "resolved" | "stale"
}

export interface ReviewFeedbackBundle {
  id: string
  sessionId: string
  scope: ReviewScope
  repositoryRoots: string[]
  comments: ReviewComment[]
  summary: string
  state: "draft" | "sent"
  createdAt: number
  updatedAt: number
}

export interface PullRequestRef {
  provider: string
  repository: string
  number: number
  url: string
  headRef: string
  baseRef: string
  title: string
  state: "open" | "closed" | "merged"
}

export interface CreatePullRequestInput {
  repositoryRoot: string
  headRef: string
  baseRef: string
  title: string
  body: string
  draft?: boolean
}

/**
 * One repository's leg of a cross-repository delivery.
 *
 * ADR-0111 §6 ratified the shape: "Cross-repository publish is one branch/PR
 * per repository, grouped into one delivery unit in the UI; no cross-repository
 * network atomicity is claimed." A leg is that per-repository unit, and it
 * carries its own outcome so a failure in one root neither hides nor undoes a
 * success in another.
 */
export interface ReviewDeliveryLeg {
  repositoryRoot: string
  status: "pending" | "succeeded" | "failed" | "skipped"
  pullRequest?: PullRequestRef
  /** Comments anchored to this root that were (or would be) posted. */
  commentCount: number
  error?: {
    message: string
    /** The failure looks transient — a retry is worth offering. */
    recoverable: boolean
  }
  /**
   * The request never received a response, so whether the review landed is
   * genuinely unknown.
   *
   * Kept separate from `recoverable` because the two ask different questions.
   * `recoverable` is "should we offer a retry"; this is "might a retry
   * double-post". GitHub's review endpoint has no idempotency key, so a leg
   * that timed out mid-flight cannot be replayed safely without saying so.
   */
  outcomeUncertain?: boolean
}

/** One publish attempt across every repository a bundle touches. */
export interface ReviewDelivery {
  bundleId: string
  legs: ReviewDeliveryLeg[]
  startedAt: number
  updatedAt: number
}

/**
 * Per-repository refs for a scoped review.
 *
 * Two roots in one review are two repositories with two histories: the commit
 * that matters in one is meaningless in the other, and `main` may not even
 * exist there. Applying one `commitSha` / `baseRef` / `targetRef` to every
 * selected root — which is what the single-ref request did — asks each
 * repository a question about someone else's history.
 */
export interface ReviewRepositoryRefs {
  commitSha?: string
  baseRef?: string
  targetRef?: string
  /** Task Workspace run whose patch set is this root's last turn. */
  lastTurnRunId?: string
}

/** Provider-neutral PR boundary; GitHub is the first adapter. */
export interface PullRequestProvider {
  readonly id: string
  getAuthenticationState(): Promise<"authenticated" | "unauthenticated" | "unavailable">
  findForBranch(repositoryRoot: string, branch: string): Promise<PullRequestRef | null>
  push(repositoryRoot: string, branch: string): Promise<void>
  create(input: CreatePullRequestInput): Promise<PullRequestRef>
  /**
   * Post one repository's comments as one review.
   *
   * `bundle` MUST name exactly one repository root, and every comment it
   * carries must be anchored to that root. An adapter is required to refuse a
   * bundle that breaks either rule rather than resolve the ambiguity itself —
   * the previous implementation picked `repositoryRoots[0]` and posted every
   * comment there, including ones anchored to a different repository.
   *
   * Slice a multi-root bundle with `lib/review/bundle.ts` first, or drive the
   * whole delivery through `lib/review/delivery.ts`.
   */
  publishFeedback(pullRequest: PullRequestRef, bundle: ReviewFeedbackBundle): Promise<void>
}
