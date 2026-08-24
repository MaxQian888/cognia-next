/**
 * Binding between a running teammate (its worktree branch) and the PR the
 * observer watches. A teammate either (a) has an explicit task-bound PR number,
 * or (b) opens a PR itself (via its git/gh tools, or the optional auto-publish
 * step), which the observer discovers by the branch head.
 *
 * The Registry promotion branch keeps the historical naming
 * (`agent/<runId>/<teammate>/<taskId>`) so a PR opened for that branch is
 * discoverable by the observer.
 */

import type { ObserveRef } from "@/lib/github/pr-observe/types"

export interface TeammatePrBinding {
  runId: string
  teamId: string
  /** Teammate (member) id — the nudge recipient. */
  memberId: string
  taskId: string
  /** "owner/name". */
  repo: string
  /** The teammate's worktree branch (PR head). */
  branch: string
  /** Explicit PR number when task-bound; else the PR is discovered by branch. */
  prNumber?: number
  /** Known PR url (when task-bound or after discovery). */
  prUrl?: string
}

/** Stable per-run tracking key for a binding (PR url is unknown until discovered). */
export function bindingKey(b: TeammatePrBinding): string {
  return `${b.runId}:${b.memberId}:${b.taskId}`
}

/** How the fetcher should locate the PR: by explicit number, else by branch. */
export function bindingRef(b: TeammatePrBinding): ObserveRef {
  if (typeof b.prNumber === "number") return { number: b.prNumber, url: b.prUrl }
  return { branch: b.branch }
}
