"use client"

/**
 * The goal each conversation is running, for the rows a list draws.
 *
 * A conversation with a `/goal` on it looked like any other in the
 * conversation manager; the goal side knew its conversation (`Goal.sessionId`)
 * and nothing pointed back. This reads every goal attached to the drawn ids in
 * one live query (`listGoalsForSessions`) and keeps the one worth showing per
 * conversation: the open goal if there is one (at most one per conversation can
 * be active), otherwise the most recent finished one.
 *
 * Only the drawn page's ids are read, the same way usage is, so a long history
 * costs one indexed read per page rather than one per conversation.
 */

import { useMemo } from "react"
import { useLiveQuery } from "dexie-react-hooks"

import { listGoalsForSessions } from "@/lib/db/goals"
import { isOpenGoal } from "@/lib/goal/overview-filter"
import type { Goal } from "@/types/goal"

export type SessionGoalMap = ReadonlyMap<string, Goal>

const EMPTY: SessionGoalMap = new Map()

/** Pick the goal a conversation row shows. Exported for the unit test. */
export function pickSessionGoals(goals: readonly Goal[]): Map<string, Goal> {
  const bySession = new Map<string, Goal>()
  for (const goal of goals) {
    const current = bySession.get(goal.sessionId)
    if (!current) {
      bySession.set(goal.sessionId, goal)
      continue
    }
    const currentOpen = isOpenGoal(current)
    const candidateOpen = isOpenGoal(goal)
    if (candidateOpen && !currentOpen) bySession.set(goal.sessionId, goal)
    else if (candidateOpen === currentOpen && goal.createdAt > current.createdAt) {
      bySession.set(goal.sessionId, goal)
    }
  }
  return bySession
}

export function useSessionGoals(sessionIds: readonly string[]): SessionGoalMap {
  const key = useMemo(() => [...sessionIds].sort().join("\n"), [sessionIds])
  const goals = useLiveQuery(async () => (key ? listGoalsForSessions(key.split("\n")) : []), [key])
  return useMemo(() => (goals ? pickSessionGoals(goals) : EMPTY), [goals])
}
