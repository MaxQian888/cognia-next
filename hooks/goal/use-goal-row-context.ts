"use client"

/**
 * Everything a list of goal rows shows besides the goal itself, resolved once
 * per list rather than once per row: the conversation each goal runs in, the
 * agent's display name, and (optionally) the latest judge verdict.
 *
 * Each value is `undefined` while its read is in flight, so a row can tell
 * "still loading" from "known to be missing".
 */

import { useMemo } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import type { ChatSession } from "@cognia/agent-config-types"

import { useCharacters } from "@/lib/data-hooks/context"
import { latestJudgeReasons } from "@/lib/db/goals"
import type { Goal } from "@/types/goal"

import { useGoalSessions } from "./use-goal-sessions"

export interface GoalRowContext {
  /** `undefined` while loading; `null` once the conversation is known gone. */
  sessionFor: (goal: Pick<Goal, "sessionId">) => ChatSession | null | undefined
  agentNameFor: (goal: Pick<Goal, "characterId">) => string | undefined
  judgeNoteFor: (goal: Pick<Goal, "id">) => string | null
}

export function useGoalRowContext(
  goals: readonly Goal[] | undefined,
  options: { judgeNotes?: boolean } = {}
): GoalRowContext {
  const sessions = useGoalSessions(goals)
  const characters = useCharacters()
  const wantJudge = options.judgeNotes ?? false

  const idsKey = useMemo(
    () => (wantJudge && goals ? goals.map((goal) => goal.id).join("\n") : ""),
    [goals, wantJudge]
  )
  const judge = useLiveQuery(
    async () => (idsKey ? latestJudgeReasons(idsKey.split("\n")) : new Map<string, string>()),
    [idsKey]
  )

  const names = useMemo(() => {
    const map = new Map<string, string>()
    for (const character of characters ?? []) map.set(character.id, character.name)
    return map
  }, [characters])

  return useMemo<GoalRowContext>(
    () => ({
      sessionFor: (goal) => (sessions ? (sessions.get(goal.sessionId) ?? null) : undefined),
      agentNameFor: (goal) => (goal.characterId ? names.get(goal.characterId) : undefined),
      judgeNoteFor: (goal) => judge?.get(goal.id) ?? null,
    }),
    [sessions, names, judge]
  )
}
