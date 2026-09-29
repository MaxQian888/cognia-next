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

/**
 * What the PR observer needs to find and follow one pull request, whoever owns
 * it — a teammate here, a project thread in `lib/project-coordinator/pr-watch.ts`
 * (ADR-0204). Owners extend it with their own identity.
 */
export interface PrWatchTarget {
  /** "owner/name". */
  repo: string
  /** The PR head branch. */
  branch: string
  /** Explicit PR number when known; else the PR is discovered by branch. */
  prNumber?: number
  /** Known PR url (when given or after discovery). */
  prUrl?: string
}

/** How the observer keys a target and names who receives its nudges. */
export interface PrWatchIdentity {
  /** Stable tracking key (the PR url is unknown until discovered). */
  key: string
  /** Nudge recipient — also seeds the retry jitter so recipients spread out. */
  recipient: string
}

export interface TeammatePrBinding extends PrWatchTarget {
  runId: string
  teamId: string
  /** Teammate (member) id — the nudge recipient. */
  memberId: string
  taskId: string
}

/** Stable per-run tracking key for a binding (PR url is unknown until discovered). */
export function bindingKey(b: TeammatePrBinding): string {
  return `${b.runId}:${b.memberId}:${b.taskId}`
}

/** A teammate binding's identity for the observer. */
export function teammateIdentity(b: TeammatePrBinding): PrWatchIdentity {
  return { key: bindingKey(b), recipient: b.memberId }
}

/** How the fetcher should locate the PR: by explicit number, else by branch. */
export function bindingRef(b: PrWatchTarget): ObserveRef {
  if (typeof b.prNumber === "number") return { number: b.prNumber, url: b.prUrl }
  return { branch: b.branch }
}
