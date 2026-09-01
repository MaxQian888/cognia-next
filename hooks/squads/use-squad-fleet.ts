"use client"

/**
 * The one projection of "what every Squad in this workspace is doing".
 *
 * Three surfaces derived this independently: the fleet console inlined it as
 * three `useMemo`s, the Settings library re-derived the workspace-scoped list
 * with a different sort, and a phone body was about to be the third. Squad
 * triage is not a rendering detail, so it lives once.
 *
 * The sort is the whole point of a fleet view. A Squad blocked on a human
 * approval is the one row that will not move until it is answered, so it goes
 * above everything, working Squads next, then by name. Sorting the blocked one
 * below an alphabetically earlier idle Squad buries the only actionable thing
 * on the page.
 */

import { useMemo } from "react"

import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { usePendingGatesStore } from "@/stores/agent/pending-gates-store"
import { useProjectStore } from "@/stores/project/project-store"
import { useClientLiveQuery } from "@/hooks/data"
import { getDb } from "@/lib/db/schema"
import type { TeamStatus } from "@/types/agent/agent-team"
import type { SquadFilter } from "./use-squad-route-state"

/** Statuses that mean "this Squad is doing something right now". */
export const LIVE_TEAM_STATUSES: ReadonlySet<TeamStatus> = new Set<TeamStatus>([
  "planning",
  "executing",
])

/** The identity subset a list row needs, never the whole team object. */
export interface SquadFleetRow {
  id: string
  name: string
  description?: string
  status: TeamStatus
  memberCount: number
  /** Holding a run open on a human answer. */
  waiting: boolean
  live: boolean
}

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

  const waitingIds = useMemo(
    () =>
      new Set(gates.filter((gate) => gate.status === "open" && gate.teamId).map((g) => g.teamId!)),
    [gates]
  )

  return useMemo(() => {
    const scoped = Object.values(teams)
      // Workspace-scoped, like every other console. `createTeam` stamps the
      // active project and the store purges per project, so a Squad from
      // another workspace is noise here. A Squad with no project is shared,
      // not foreign, which is why an absent value passes.
      .filter((team) => !workspaceId || !team.projectId || team.projectId === workspaceId)
      .map((team) => ({
        id: team.id,
        name: team.name,
        ...(team.description ? { description: team.description } : {}),
        status: team.status,
        memberCount: Object.values(teammates).filter((m) => m.teamId === team.id).length,
        waiting: waitingIds.has(team.id),
        live: LIVE_TEAM_STATUSES.has(team.status),
      }))

    const needle = query.trim().toLowerCase()
    const narrowed = scoped
      .filter((squad) => {
        if (filter === "waiting" && !squad.waiting) return false
        if (filter === "live" && !squad.live) return false
        if (!needle) return true
        return (
          squad.name.toLowerCase().includes(needle) ||
          (squad.description ?? "").toLowerCase().includes(needle)
        )
      })
      .sort((a, b) => {
        const aWait = a.waiting ? 0 : 1
        const bWait = b.waiting ? 0 : 1
        const aLive = a.live ? 0 : 1
        const bLive = b.live ? 0 : 1
        return aWait - bWait || aLive - bLive || a.name.localeCompare(b.name)
      })

    return {
      squads: narrowed,
      total: scoped.length,
      live: scoped.filter((s) => s.live).length,
      waiting: scoped.filter((s) => s.waiting).length,
      loading: mirroredCount === undefined && scoped.length === 0,
    }
  }, [teams, teammates, workspaceId, waitingIds, query, filter, mirroredCount])
}
