/**
 * Delivery-container progress, derived rather than stored.
 *
 * Progress is a pure function of the issues in a container, so storing it
 * would only create something that can drift. It was previously computed in
 * two places — `lib/db/issue-projects.ts:computeIssueProjectProgress` (one
 * query per container) and again inline in the projects console (one pass over
 * an issue list it had already loaded), and the two disagreed about what
 * `total` meant. This is the single implementation both now call.
 *
 * `total` counts every issue, cancelled included, because that is what "how
 * big is this project" means. `denominator` is the work that still counts —
 * a cancelled item is not outstanding, and leaving it in would make
 * abandoning scope look like losing ground. Progress bars and "3 / 12" labels
 * use `denominator`; inventory counts use `total`.
 */

import { statusCategoryOf, type IssueStatus } from "@/types/issues"

export interface IssueProjectProgress {
  /** Every issue in the container, cancelled included. */
  total: number
  /** `statusCategory === "completed"`. */
  completed: number
  /** `statusCategory === "canceled"`. */
  canceled: number
  /** `statusCategory === "started"` — in progress or in review, not backlog. */
  started: number
  /** `total - canceled`: the denominator `ratio` is measured against. */
  denominator: number
  /** 0..1, and exactly 0 for an empty container rather than NaN. */
  ratio: number
}

export const EMPTY_ISSUE_PROJECT_PROGRESS: Readonly<IssueProjectProgress> = Object.freeze({
  total: 0,
  completed: 0,
  canceled: 0,
  started: 0,
  denominator: 0,
  ratio: 0,
})

/** The minimum an issue-shaped row must expose to be counted. */
export interface ProgressCountable {
  issueProjectId?: string
  status: IssueStatus
}

/** Tally one flat list of issues, all assumed to belong to the same container. */
export function computeProgress(issues: readonly ProgressCountable[]): IssueProjectProgress {
  let completed = 0
  let canceled = 0
  let started = 0
  for (const issue of issues) {
    const category = statusCategoryOf(issue.status)
    if (category === "completed") completed += 1
    else if (category === "canceled") canceled += 1
    else if (category === "started") started += 1
  }
  const denominator = issues.length - canceled
  return {
    total: issues.length,
    completed,
    canceled,
    started,
    denominator,
    ratio: denominator > 0 ? completed / denominator : 0,
  }
}

/**
 * Progress for every listed container, in ONE pass over the issues.
 *
 * Containers are passed in explicitly so an empty one still gets a zeroed
 * entry — deriving the key set from the issues alone would make a container
 * with no work vanish from the table.
 */
export function computeProgressFromIssues(
  projectIds: readonly string[],
  issues: readonly ProgressCountable[]
): Map<string, IssueProjectProgress> {
  const buckets = new Map<string, ProgressCountable[]>()
  for (const id of projectIds) buckets.set(id, [])
  for (const issue of issues) {
    if (!issue.issueProjectId) continue
    buckets.get(issue.issueProjectId)?.push(issue)
  }

  const byId = new Map<string, IssueProjectProgress>()
  for (const [id, bucket] of buckets) byId.set(id, computeProgress(bucket))
  return byId
}
