"use client"

/**
 * The conversations a set of goals run in, read once for the whole list.
 *
 * Every goal carries `sessionId`, and no goal surface used to render it — the
 * console had no way back to the chat a goal was working in. A row per
 * `getSession` live query would cost one subscription per goal; this resolves
 * the distinct ids in one `getSessionsByIds` read and hands back a map.
 *
 * `undefined` while loading. A goal whose conversation was deleted maps to
 * nothing, which the link renders as "conversation deleted" rather than a
 * dead link.
 */

import { useMemo } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import type { ChatSession } from "@cognia/agent-config-types"

import { getSessionsByIds } from "@/lib/db/sessions"

export type GoalSessionMap = ReadonlyMap<string, ChatSession>

export function useGoalSessions(
  goals: readonly { sessionId: string }[] | undefined
): GoalSessionMap | undefined {
  // A stable, sorted key so the query only re-runs when the id set changes,
  // not when the goals array is re-created with the same members.
  const key = useMemo(() => {
    if (!goals) return null
    return [...new Set(goals.map((goal) => goal.sessionId))].sort().join("\n")
  }, [goals])

  const sessions = useLiveQuery(
    async () => (key === null || key === "" ? [] : getSessionsByIds(key.split("\n"))),
    [key]
  )

  return useMemo(() => {
    if (sessions === undefined || key === null) return undefined
    return new Map(sessions.map((session) => [session.id, session]))
  }, [sessions, key])
}
