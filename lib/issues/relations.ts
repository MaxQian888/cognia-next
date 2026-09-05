/**
 * Pure reads over the relations an issue carries (spec 2026-09-06, D5):
 * parent and sub-issues, blocking dependencies, due state and the numbers a
 * card or a cycle header prints from them.
 *
 * No Dexie here. The board already holds every issue of the workspace, so a
 * caller passes the rows it has and gets answers in one pass. The three array
 * fields are optional on the type (older rows, older hosts over sync), and
 * `issueRelations()` is where that `?? []` lives so nobody else spells it.
 */

import type { Issue, IssueExternalRef } from "@/types/issues"

/** The relation fields with their defaults filled in. */
export function issueRelations(issue: {
  blockedBy?: readonly string[]
  externalRefs?: readonly IssueExternalRef[]
  parentId?: string
}): {
  blockedBy: readonly string[]
  externalRefs: readonly IssueExternalRef[]
  parentId?: string
} {
  return {
    blockedBy: issue.blockedBy ?? [],
    externalRefs: issue.externalRefs ?? [],
    ...(issue.parentId ? { parentId: issue.parentId } : {}),
  }
}

/** A row that has neither finished nor been dropped. */
function isOpen(issue: Pick<Issue, "statusCategory">): boolean {
  return issue.statusCategory === "unstarted" || issue.statusCategory === "started"
}

/**
 * Blockers that still stand in the way: listed in `blockedBy`, present in
 * `byId`, and not finished. A deleted or done blocker no longer blocks.
 */
export function openBlockers<T extends Pick<Issue, "statusCategory">>(
  issue: { blockedBy?: readonly string[] },
  byId: ReadonlyMap<string, T>
): T[] {
  const out: T[] = []
  for (const blockerId of issue.blockedBy ?? []) {
    const blocker = byId.get(blockerId)
    if (blocker && isOpen(blocker)) out.push(blocker)
  }
  return out
}

export function isBlocked(
  issue: { blockedBy?: readonly string[] },
  byId: ReadonlyMap<string, Pick<Issue, "statusCategory">>
): boolean {
  return openBlockers(issue, byId).length > 0
}

/** Issues that list `issueId` as a blocker (the derived `blocks` side). */
export function blockedIssues<T extends { blockedBy?: readonly string[] }>(
  issueId: string,
  issues: readonly T[]
): T[] {
  return issues.filter((candidate) => (candidate.blockedBy ?? []).includes(issueId))
}

export function childIssues<T extends Pick<Issue, "id" | "parentId">>(
  parentId: string,
  issues: readonly T[]
): T[] {
  return issues.filter((candidate) => candidate.parentId === parentId)
}

export interface SubIssueProgress {
  total: number
  done: number
}

/** Direct children only. Grand-children roll up through their own parent's card. */
export function subIssueProgress(
  parentId: string,
  issues: readonly Pick<Issue, "id" | "parentId" | "statusCategory">[]
): SubIssueProgress {
  let total = 0
  let done = 0
  for (const candidate of issues) {
    if (candidate.parentId !== parentId) continue
    total += 1
    if (candidate.statusCategory === "completed") done += 1
  }
  return { total, done }
}

/**
 * Would setting `parentId` on `issueId` create a loop? Pure twin of the check
 * `setIssueParent` performs in its transaction, for the picker to disable the
 * entries the write would refuse.
 */
export function wouldCreateParentLoop(
  issueId: string,
  parentId: string,
  byId: ReadonlyMap<string, Pick<Issue, "id" | "parentId">>
): boolean {
  if (issueId === parentId) return true
  const seen = new Set<string>([issueId])
  let cursor = byId.get(parentId)
  while (cursor) {
    if (seen.has(cursor.id)) return true
    seen.add(cursor.id)
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined
  }
  return false
}

export type DueState = "none" | "later" | "soon" | "today" | "overdue" | "met"

const DAY_MS = 24 * 60 * 60 * 1000
/** "Soon" is within three days. A preference later, a constant now. */
export const DUE_SOON_WINDOW_MS = 3 * DAY_MS

/**
 * How the due date reads today. A finished issue is `met` whatever the date:
 * a badge that shouts "overdue" on a closed card is noise.
 */
export function dueState(
  issue: Pick<Issue, "dueDate" | "statusCategory">,
  now: number = Date.now()
): DueState {
  if (issue.dueDate === undefined) return "none"
  if (!isOpen(issue)) return "met"
  const endOfToday = startOfDay(now) + DAY_MS
  if (issue.dueDate < startOfDay(now)) return "overdue"
  if (issue.dueDate < endOfToday) return "today"
  if (issue.dueDate < now + DUE_SOON_WINDOW_MS) return "soon"
  return "later"
}

function startOfDay(ts: number): number {
  const date = new Date(ts)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

export interface CycleProgress {
  total: number
  done: number
  points: number
  pointsDone: number
}

/** Counts and points for one cycle, from the rows the caller already holds. */
export function cycleProgress(
  cycleId: string,
  issues: readonly Pick<Issue, "cycleId" | "statusCategory" | "estimate">[]
): CycleProgress {
  const out: CycleProgress = { total: 0, done: 0, points: 0, pointsDone: 0 }
  for (const issue of issues) {
    if (issue.cycleId !== cycleId) continue
    const points = issue.estimate ?? 0
    out.total += 1
    out.points += points
    if (issue.statusCategory === "completed") {
      out.done += 1
      out.pointsDone += points
    }
  }
  return out
}
