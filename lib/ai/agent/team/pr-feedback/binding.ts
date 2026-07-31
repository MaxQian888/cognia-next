/**
 * Binding between a running teammate (its worktree branch) and the PR the
 * observer watches. A teammate either (a) has an explicit task-bound PR number,
 * or (b) opens a PR itself (via its git/gh tools, or the optional auto-publish
 * step), which the observer discovers by the branch head.
 *
 * The worktree branch mirrors the allocator's naming
 * (`agent/<runId>/<teammate>/<taskId>`) so a PR opened for that branch is
 * discoverable; {@link teammateBranch} reuses the allocator's `sanitizeSegment`
 * so the two never drift.
 */

import { sanitizeSegment } from "@/lib/ai/agent/team/workspace/allocator"
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

/** The allocator branch for a teammate/task — kept in sync with the allocator. */
export function teammateBranch(runId: string, teammateName: string, taskId: string): string {
  return `agent/${runId}/${sanitizeSegment(teammateName)}/${sanitizeSegment(taskId)}`
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
