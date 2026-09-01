"use client"

/**
 * The one projection of "what every Squad in this workspace is doing".
 *
 * Three surfaces derived this independently: the fleet console inlined it as
 * three `useMemo`s, the Settings library re-derived the workspace-scoped list
 * with a different sort, and a phone body was about to be the third. Squad
 * triage is not a rendering detail, so it lives once.
 *
 * The projection itself (workspace scoping, roster size, live and waiting, and
 * the sort) lives in `lib/agent/squad-presence.ts`, because a FOURTH surface
 * needs the same answer and is not a page: the composer chip that binds a
 * conversation to a Squad. This hook keeps everything that is a hook's job and
 * a pure function cannot do, which is the whole of what makes it useful here:
 * narrowing by the URL facets, the before-narrowing counts, and the
 * Dexie-is-still-loading answer.
 *
 * The sort is the whole point of a fleet view. A Squad blocked on a human
 * approval is the one row that will not move until it is answered, so it goes
 * above everything, working Squads next, then by name. Sorting the blocked one
 * below an alphabetically earlier idle Squad buries the only actionable thing
 * on the page.
 */

import { useMemo } from "react"

import {
  collectSquadPresence,
  isLiveSquadStatus,
  LIVE_SQUAD_STATUSES,
  type SquadPresenceRow,
} from "@/lib/agent/squad-presence"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { usePendingGatesStore } from "@/stores/agent/pending-gates-store"
import { useProjectStore } from "@/stores/project/project-store"
import { useClientLiveQuery } from "@/hooks/data"
import { getDb } from "@/lib/db/schema"
import type { TeamStatus } from "@/types/agent/agent-team"
import type { SquadFilter } from "./use-squad-route-state"

/**
 * Statuses that mean "this Squad is doing something right now".
 *
 * Re-exported rather than redeclared. There were two of these sets, and two
 * definitions of "live" is how a fleet console and a composer chip start
 * disagreeing about which Squads are working.
 */
export const LIVE_TEAM_STATUSES: ReadonlySet<string> = LIVE_SQUAD_STATUSES
export { isLiveSquadStatus }

/**
 * The identity subset a list row needs, never the whole team object.
 *
 * An alias, not a second declaration: the composer's Squad picker renders the
 * same row from the same derivation, and two structurally-identical interfaces
 * are two places for a field to be added to only one of them.
 */
export type SquadFleetRow = SquadPresenceRow<TeamStatus>

export interface SquadFleetSnapshot {
  /** Narrowed and sorted, ready to render. */
  squads: SquadFleetRow[]
  /** Before narrowing, so the empty state can tell "none" from "none match". */
  total: number
  live: number
  waiting: number
  /**
   * Dexie has not answered yet. NOT the same as "there are none": since persist
   * v8 the definitions arrive through the store's async Dexie bridge rather than
   * out of localStorage, so a cold page rendered "No Squads yet", a claim about
   * the user's data, for the whole of the first read.
   */
  loading: boolean
}

export interface SquadFleetOptions {
  query?: string
  filter?: SquadFilter
}

export function useSquadFleet(options: SquadFleetOptions = {}): SquadFleetSnapshot {
  const { query = "", filter = "all" } = options
  const teams = useAgentTeamStore((s) => s.teams)
  const teammates = useAgentTeamStore((s) => s.teammates)
  const workspaceId = useProjectStore((state) => state.activeProjectId)
  // `PendingGate.teamId` has carried this all along, so nothing new is stored
  // to sort by it.
  const gates = usePendingGatesStore((state) => state.gates)

  // Whether the mirror holds anything at all, asked of Dexie rather than of the
  // store, because the store is what is still filling. The `try` matters: a
  // locked account makes `getDb()` throw, and an unresolved live query would
  // pin the skeleton on screen forever.
  const mirroredCount = useClientLiveQuery(
    async () => {
      try {
        return await getDb().agentTeams.count()
      } catch {
        return 0
      }
    },
    [],
    0
  )

  // Scoped, annotated and already in triage order. The filter below only ever
  // removes rows, so it preserves that order for free.
  const scoped = useMemo(
    () => collectSquadPresence<TeamStatus>({ teams, teammates, gates, workspaceId }),
    [teams, teammates, gates, workspaceId]
  )

  return useMemo(() => {
    const needle = query.trim().toLowerCase()
    const narrowed = scoped.filter((squad) => {
      if (filter === "waiting" && !squad.waiting) return false
      if (filter === "live" && !squad.live) return false
      if (!needle) return true
      return (
        squad.name.toLowerCase().includes(needle) ||
        (squad.description ?? "").toLowerCase().includes(needle)
      )
    })

    return {
      squads: narrowed,
      total: scoped.length,
      live: scoped.filter((s) => s.live).length,
      waiting: scoped.filter((s) => s.waiting).length,
      loading: mirroredCount === undefined && scoped.length === 0,
    }
  }, [scoped, query, filter, mirroredCount])
}
