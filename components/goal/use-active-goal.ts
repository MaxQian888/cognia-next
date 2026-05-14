"use client"

import { useLiveQuery } from "dexie-react-hooks"
import { getActiveGoalForSession, getOpenGoalForSession } from "@/lib/db/goals"
import type { Goal } from "@/types/goal"

/**
 * Live-query the active goal (status === "active") for a session. Returns
 * `undefined` on first render before Dexie has emitted (mirrors the
 * standard `useLiveQuery` contract); `null` once we know there's no row;
 * the row otherwise.
 */
export function useActiveGoal(sessionId: string | null | undefined): Goal | null | undefined {
  return useLiveQuery(async () => {
    if (!sessionId) return null
    return (await getActiveGoalForSession(sessionId)) ?? null
  }, [sessionId]) as Goal | null | undefined
}

/**
 * Same as `useActiveGoal` but also returns paused goals — used by the
 * sheet so the user can resume from there.
 */
export function useOpenGoal(sessionId: string | null | undefined): Goal | null | undefined {
  return useLiveQuery(async () => {
    if (!sessionId) return null
    return (await getOpenGoalForSession(sessionId)) ?? null
  }, [sessionId]) as Goal | null | undefined
}
