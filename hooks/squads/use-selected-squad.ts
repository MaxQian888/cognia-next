"use client"

/**
 * The Squad a `/squads?id=` link names, and whether it is really gone.
 *
 * "Not in the store" has two meanings on a cold page. Squad definitions reach
 * the store through its async Dexie bridge, so for a moment after load a Squad
 * that exists is simply not there yet; a link that names a deleted Squad is
 * not there either. Telling them apart by the fleet's loading flag was not
 * enough: that flag clears as soon as Dexie answers ANY count, which can be
 * before the store holds the row, and the page flashed "Squad unavailable" for
 * a Squad that arrived a moment later.
 *
 * So the question is asked of Dexie, by id: a row there that the store does
 * not hold yet is still loading, and only an id Dexie does not hold either is
 * missing.
 */

import { useClientLiveQuery } from "@/hooks/data"
import { getDb } from "@/lib/db/schema"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import type { AgentTeam } from "@/types/agent/agent-team"

export type SelectedSquadState =
  | { status: "none" }
  | { status: "found"; squad: AgentTeam }
  | { status: "loading" }
  | { status: "missing" }

export function useSelectedSquad(squadId: string | undefined): SelectedSquadState {
  const squad = useAgentTeamStore((s) => (squadId ? s.teams[squadId] : undefined))
  // `true` / `false` once Dexie answers, `undefined` until then. Only asked
  // while the store does not hold the Squad; a locked account has no database
  // and reads as absent rather than pinning the page in a loading state.
  const stored = useClientLiveQuery(
    async () => {
      if (!squadId || squad) return false
      try {
        return (await getDb().agentTeams.get(squadId)) !== undefined
      } catch {
        return false
      }
    },
    [squadId, Boolean(squad)],
    undefined
  )

  if (!squadId) return { status: "none" }
  if (squad) return { status: "found", squad }
  if (stored === undefined || stored === true) return { status: "loading" }
  return { status: "missing" }
}
