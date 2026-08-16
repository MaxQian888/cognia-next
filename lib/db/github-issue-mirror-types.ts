/**
 * Row type for the GitHub issue mirror (Dexie table `githubIssueMirror`, v171).
 *
 * Co-located with its CRUD module per `lib/db/CONVENTIONS.md` and re-exported
 * from `@/lib/db/schema`, matching how `crm-types.ts` is handled.
 *
 * This is a CACHE, not a source of truth. Everything here is re-derivable from
 * GitHub, which is why:
 *   - the table is excluded from companion sync (a drifting cache is worse
 *     than a re-fetch),
 *   - rows are read-only wherever they surface on the board, and
 *   - `etag` lives on the row so a conditional re-fetch can revalidate without
 *     a second store to keep in step.
 */

/** GitHub's own issue state, kept verbatim rather than pre-mapped. */
export type GithubIssueState = "open" | "closed"

/**
 * `state_reason` narrows a closed issue. GitHub returns `null` for open issues
 * and for closures predating the field, so the mapper must tolerate absence.
 */
export type GithubIssueStateReason = "completed" | "not_planned" | "reopened"

export interface GithubIssueMirrorLabel {
  name: string
  /** GitHub ships 6-digit hex without a leading `#`. */
  color?: string
}

export interface GithubIssueMirrorRow {
  /** `${repoFullName}#${number}` — stable, human-legible, collision-free. */
  id: string
  repoFullName: string
  number: number
  /** The delivery container this repo is bound to, when one is. */
  issueProjectId?: string
  title: string
  body?: string
  state: GithubIssueState
  stateReason?: GithubIssueStateReason
  /** GitHub login of the author. */
  authorLogin?: string
  /** GitHub logins of the assignees; empty when unassigned. */
  assigneeLogins: string[]
  labels: GithubIssueMirrorLabel[]
  htmlUrl: string
  commentCount: number
  /** Unix epoch ms, from GitHub's own timestamps. */
  createdAt: number
  updatedAt: number
  closedAt?: number
  /** Unix epoch ms — when this app last wrote the row. */
  syncedAt: number
  /** Response ETag for the page this row arrived in, for conditional re-fetch. */
  etag?: string
}

/** Per-repo sync watermark, stored alongside the rows it governs. */
export interface GithubMirrorCursor {
  repoFullName: string
  /** ISO-8601 timestamp handed to GitHub's `since` parameter. */
  since?: string
  etag?: string
  lastSyncedAt?: number
  lastError?: string
}
