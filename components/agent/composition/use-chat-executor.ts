"use client"

/**
 * The conversation's executor: an ordinary single agent, or one of the Squads.
 *
 * Reads and writes `ChatSession.squadId` (Dexie v177) rather than the
 * composition axis, because the column is the storage of record — a binding
 * has to survive a reload, be visible to the conversation list, and travel to
 * a second device, and the axis is device-local zustand. The axis still
 * *carries* the id for a single-turn override; it just does not own it.
 *
 * Live-queried, not read once: the settings sheet writes the same column, and
 * two surfaces disagreeing about what a conversation is bound to is the exact
 * confusion this replaced.
 *
 * The offered Squads are ANNOTATED and WORKSPACE-SCOPED, by the same derivation
 * `/squads` uses (`lib/agent/squad-presence.ts`). Before that they were bare
 * `{id, name}` pairs from every workspace, so the control where a conversation
 * is actually bound to a Squad knew less about those Squads than the page that
 * only reports on them: no roster size, no sign of which one was mid-run, and
 * no sign of which one was parked on a question waiting to be answered.
 *
 * The gate subscription is the one cost. Gates open and close rarely (a
 * permission prompt), and it buys the whole toolbar a consistent answer.
 */

import { useCallback, useMemo } from "react"

import { useClientLiveQuery } from "@/hooks/data/use-client-live-query"
import { getSession, updateSession } from "@/lib/db/sessions"
import { collectSquadPresence, type SquadPresenceRow } from "@/lib/agent/squad-presence"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { selectTeammates, selectTeams } from "@/stores/agent/agent-team-store/selectors"
import { usePendingSquadReviews } from "@/hooks/squads/use-pending-squad-reviews"
import { useProjectStore } from "@/stores/project/project-store"

/** Name, roster size, and whether it is running or waiting on a person. */
export type ChatExecutorSquad = SquadPresenceRow

export interface ChatExecutor {
  /** The Squad this conversation runs on, or `null` for a single agent. */
  squadId: string | null
  /** Resolved name, or `null` when the binding points at a Squad that is gone. */
  squadName: string | null
  /** Every Squad that can be picked, name-sorted. */
  squads: readonly ChatExecutorSquad[]
  /** Bind the conversation to a Squad, or `null` to go back to one agent. */
  select: (squadId: string | null) => Promise<void>
  /** No session yet (a conversation before its first turn) — nothing to bind. */
  bindable: boolean
}

export function useChatExecutor(sessionId?: string): ChatExecutor {
  const teams = useAgentTeamStore(selectTeams)
  const teammates = useAgentTeamStore(selectTeammates)
  const gates = usePendingSquadReviews()
  const workspaceId = useProjectStore((state) => state.activeProjectId)
  const session = useClientLiveQuery(
    () => (sessionId ? getSession(sessionId) : Promise.resolve(undefined)),
    [sessionId],
    undefined
  )

  const squads = useMemo(
    () => collectSquadPresence({ teams, teammates, gates, workspaceId }),
    [teams, teammates, gates, workspaceId]
  )

  const squadId = session?.squadId ?? null
  // A binding whose Squad was deleted resolves to no name rather than to the
  // id: showing a raw id would read as a working selection.
  const squadName = squadId ? (teams[squadId]?.name ?? null) : null

  const select = useCallback(
    async (next: string | null) => {
      if (!sessionId) return
      await updateSession(sessionId, { squadId: next ?? undefined })
    },
    [sessionId]
  )

  return { squadId, squadName, squads, select, bindable: Boolean(sessionId) }
}
