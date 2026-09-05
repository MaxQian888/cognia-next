/**
 * What a card or a row prints about an issue's planning state, computed once
 * per board pass (spec 2026-09-06, batch 1).
 *
 * The board already holds every item of the workspace, so blocked-ness,
 * sub-issue progress and the cycle name are derived here in one walk and
 * handed to the card as a small hint. The card stays a pure renderer, and the
 * list row and the mobile sheet read the same hint, so the three can never
 * disagree about whether an issue is blocked.
 */

import type { IssueCycle } from "@/types/issues"
import type { UnifiedIssueItem } from "@/types/issues/unified"
import { dueState, openBlockers, type DueState, type SubIssueProgress } from "./relations"

export interface IssuePlanningHint {
  /** At least one open blocker stands. */
  blocked: boolean
  /** Identifiers of the open blockers, for the badge's title. */
  blockerIdentifiers: readonly string[]
  /** Direct children, when any exist. */
  subIssues?: SubIssueProgress
  /** Parent identifier, when the issue is a sub-issue. */
  parentIdentifier?: string
  due: DueState
  cycleName?: string
}

const NO_BLOCKERS: readonly string[] = Object.freeze([])

/**
 * One hint per `unifiedId`. Only local rows carry relation fields, but the
 * map is built for every item so a consumer can look any card up without a
 * kind check.
 */
export function buildPlanningHints(
  items: readonly UnifiedIssueItem[],
  cyclesById: ReadonlyMap<string, IssueCycle> = new Map(),
  now: number = Date.now()
): Map<string, IssuePlanningHint> {
  // Relations are keyed by the LOCAL id (`sourceId`), which is what
  // `blockedBy` and `parentId` store.
  const localById = new Map<string, UnifiedIssueItem>()
  for (const item of items) {
    if (item.kind === "local") localById.set(item.sourceId, item)
  }

  const children = new Map<string, SubIssueProgress>()
  for (const item of items) {
    if (item.kind !== "local" || !item.parentId) continue
    const progress = children.get(item.parentId) ?? { total: 0, done: 0 }
    progress.total += 1
    if (item.statusCategory === "completed") progress.done += 1
    children.set(item.parentId, progress)
  }

  const hints = new Map<string, IssuePlanningHint>()
  for (const item of items) {
    const blockers = item.kind === "local" ? openBlockers(item, localById) : []
    const subIssues = item.kind === "local" ? children.get(item.sourceId) : undefined
    const parent = item.parentId ? localById.get(item.parentId) : undefined
    const cycle = item.cycleId ? cyclesById.get(item.cycleId) : undefined
    hints.set(item.unifiedId, {
      blocked: blockers.length > 0,
      blockerIdentifiers:
        blockers.length > 0 ? blockers.map((blocker) => blocker.identifier) : NO_BLOCKERS,
      ...(subIssues ? { subIssues } : {}),
      ...(parent ? { parentIdentifier: parent.identifier } : {}),
      due: dueState(item, now),
      ...(cycle ? { cycleName: cycle.name } : {}),
    })
  }
  return hints
}

/** Does the hint carry anything a badge would print? */
export function hasPlanningBadges(hint: IssuePlanningHint | undefined): boolean {
  if (!hint) return false
  return (
    hint.blocked ||
    hint.subIssues !== undefined ||
    (hint.due !== "none" && hint.due !== "met" && hint.due !== "later")
  )
}
