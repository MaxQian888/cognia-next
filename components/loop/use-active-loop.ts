"use client"

import { useLiveQuery } from "dexie-react-hooks"
import { getOpenLoopForSession } from "@/lib/db/loops"
import type { Loop } from "@/types/loop"

/**
 * Live-query the open (active OR paused) loop for a session. Returns
 * `undefined` before Dexie emits, `null` when there's no row, the row
 * otherwise — mirrors `useOpenGoal`.
 */
export function useOpenLoop(sessionId: string | null | undefined): Loop | null | undefined {
  return useLiveQuery(async () => {
    if (!sessionId) return null
    return (await getOpenLoopForSession(sessionId)) ?? null
  }, [sessionId]) as Loop | null | undefined
}
