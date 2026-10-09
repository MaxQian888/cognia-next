/**
 * Open-goal scopes for the Goals console Overview (ADR-0019).
 *
 * The Overview lists goals that can still move — `active` and `paused` — and
 * one of those paused states is not like the others: a judge-completed goal
 * parked for the user's verdict (`awaitingAcceptance`) is waiting on a person,
 * not on a resume. Those goals get their own "Needs you" list at the top of
 * the Overview, so they are split off here and never counted or listed twice:
 * the scopes (All · Active · Paused) cover the rest.
 *
 * Pure, so the scope counts and the filtered list stay one computation and
 * are unit-tested without rendering.
 */

import { filterAndSortGoals, type GoalSortKey, type SortDir } from "@/lib/goal/history-filter"
import type { Goal } from "@/types/goal"

export type OpenGoalScope = "all" | "active" | "paused"

/** Render order of the scope control. */
export const OPEN_GOAL_SCOPES: readonly OpenGoalScope[] = ["all", "active", "paused"]

export function isOpenGoalScope(value: unknown): value is OpenGoalScope {
  return typeof value === "string" && (OPEN_GOAL_SCOPES as readonly string[]).includes(value)
}

/** Still able to move: running or paused (awaiting acceptance included). */
export function isOpenGoal(goal: Pick<Goal, "status">): boolean {
  return goal.status === "active" || goal.status === "paused"
}

/** Parked by the acceptance gate, waiting for Accept / Request changes. */
export function isAwaitingAcceptance(goal: Pick<Goal, "status" | "awaitingAcceptance">): boolean {
  return goal.status === "paused" && goal.awaitingAcceptance === true
}

export interface SplitOpenGoals {
  /** Waiting on the user's verdict — the "Needs you" list, oldest first. */
  awaiting: Goal[]
  /** Every other open goal — what the scopes filter. */
  running: Goal[]
}

/**
 * Split open goals into the ones waiting on the user and the rest. Terminal
 * goals are dropped. Awaiting goals come oldest first: the one that has waited
 * longest is the one to answer first.
 */
export function splitOpenGoals(goals: readonly Goal[]): SplitOpenGoals {
  const awaiting: Goal[] = []
  const running: Goal[] = []
  for (const goal of goals) {
    if (!isOpenGoal(goal)) continue
    if (isAwaitingAcceptance(goal)) awaiting.push(goal)
    else running.push(goal)
  }
  awaiting.sort((a, b) => a.updatedAt - b.updatedAt)
  return { awaiting, running }
}

function inScope(goal: Goal, scope: OpenGoalScope): boolean {
  switch (scope) {
    case "all":
      return true
    case "active":
      return goal.status === "active"
    case "paused":
      return goal.status === "paused"
  }
}

export type OpenGoalScopeCounts = Record<OpenGoalScope, number>

/** How many goals each scope holds, before search. Pass `splitOpenGoals().running`. */
export function countOpenGoalScopes(running: readonly Goal[]): OpenGoalScopeCounts {
  const counts: OpenGoalScopeCounts = { all: 0, active: 0, paused: 0 }
  for (const goal of running) {
    for (const scope of OPEN_GOAL_SCOPES) {
      if (inScope(goal, scope)) counts[scope] += 1
    }
  }
  return counts
}

export interface OpenGoalFilter {
  scope: OpenGoalScope
  query?: string
  sort?: GoalSortKey
  dir?: SortDir
}

/** The goals a scope + search admit, in the requested order. Pass `running`. */
export function filterOpenGoals(running: readonly Goal[], filter: OpenGoalFilter): Goal[] {
  const scoped = running.filter((goal) => inScope(goal, filter.scope))
  return filterAndSortGoals(scoped, { query: filter.query, sort: filter.sort, dir: filter.dir })
}
