"use client"

import { useLiveQuery } from "dexie-react-hooks"
import { getOpenGoalForSession } from "@/lib/db/goals"
import type { Goal } from "@/types/goal"

/**
 * Live-query the open goal (status `"active"` or `"paused"`) for a session —
 * used by the status pill / detail sheet so the user can resume from there.
 * Returns `undefined` on first render before Dexie has emitted (mirrors the
 * standard `useLiveQuery` contract); `null` once we know there's no row; the
 * row otherwise.
 *
 * The send path does NOT use this hook: `hooks/chat/use-claude-chat.ts` reads
 * the active goal directly via `getGoalRuntime().getActiveGoalForSession()`.
 */
export function useOpenGoal(sessionId: string | null | undefined): Goal | null | undefined {
  return useLiveQuery(async () => {
    if (!sessionId) return null
    return (await getOpenGoalForSession(sessionId)) ?? null
  }, [sessionId]) as Goal | null | undefined
}
