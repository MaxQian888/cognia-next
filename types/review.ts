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

/** Provider-neutral PR boundary; GitHub is the first adapter. */
export interface PullRequestProvider {
  readonly id: string
  getAuthenticationState(): Promise<"authenticated" | "unauthenticated" | "unavailable">
  findForBranch(repositoryRoot: string, branch: string): Promise<PullRequestRef | null>
  push(repositoryRoot: string, branch: string): Promise<void>
  create(input: CreatePullRequestInput): Promise<PullRequestRef>
  publishFeedback(pullRequest: PullRequestRef, bundle: ReviewFeedbackBundle): Promise<void>
}
