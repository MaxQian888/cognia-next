"use client"

/**
 * The team list in the order the user put it — the one reading of
 * `teams × conversationSidebar.teamOrder` that the sidebar's guild accordion
 * (`components/desktop/channel-list.tsx` → `sidebar-guild-sections.tsx`) and
 * the icon rail (`components/shell/guild-rail.tsx`) both use, so the two
 * states of the navigation can never disagree about which team is third.
 *
 * The writer takes the whole rendered order rather than a patch: a drag moves
 * one row but pins every row, including the ones that had only ever been in
 * the alphabetical tail (see `lib/shell/team-order.ts`).
 */

import { useCallback, useMemo } from "react"

import type { Team } from "@cognia/agent-config-types"
import { useClientLiveQuery } from "@/hooks/data"
import { listTeams } from "@/lib/db/teams"
import { moveTeamInOrder, orderTeams, teamOrderFrom } from "@/lib/shell/team-order"
import { useSettingsStore } from "@/stores/settings/settings-store"

export interface UseOrderedTeams {
  /** Every team, in the user's order. `undefined` until the first Dexie read. */
  teams: Team[] | undefined
  /** The same list as ids — what a `SortableContext` wants. */
  teamIds: string[]
  /** Persist a complete new order (ids of teams that exist, in render order). */
  reorderTeams: (ids: string[]) => void
  /** Move one team by `delta` slots. No-op at either end. */
  moveTeam: (teamId: string, delta: number) => void
}

// Two drags can land within one round trip to the settings store, and the
// second must not derive its order from the snapshot the first already
// replaced. Same shape as `enqueueSidebarLayoutMutation`
// (`components/shell/use-sidebar-layout.ts`): read the store only when the
// write reaches the front of the queue.
//
// This serializes the team order against itself, the way `saveSidebarSettings`
// in `channel-list.tsx` serializes the display options against themselves —
// `conversationSidebar` is replaced whole by each `save()`, so the two writers
// could still overlap. They cannot in practice: both are driven by the same
// pointer, and neither starts while the other's gesture is in flight.
let teamOrderWriteQueue: Promise<void> | null = null

function enqueueTeamOrderWrite(ids: string[]): Promise<void> {
  const run = async () => {
    const state = useSettingsStore.getState()
    await state.save({
      conversationSidebar: { ...state.settings?.conversationSidebar, teamOrder: ids },
    })
  }
  const task = teamOrderWriteQueue ? teamOrderWriteQueue.then(run, run) : run()
  // A rejected write must not wedge the queue for every later drag, but the
  // initiating caller still sees its own failure.
  const recovered = task.catch(() => undefined)
  teamOrderWriteQueue = recovered
  void recovered.then(() => {
    if (teamOrderWriteQueue === recovered) teamOrderWriteQueue = null
  })
  return task
}

/** Exposed for tests — the module-level queue outlives a single render tree. */
export function __resetTeamOrderQueueForTests(): void {
  teamOrderWriteQueue = null
}

export function useOrderedTeams(): UseOrderedTeams {
  const stored = useSettingsStore((s) => s.settings?.conversationSidebar?.teamOrder)
  const rows = useClientLiveQuery<Team[]>(() => listTeams(), [], [])
  const teams = useMemo(() => (rows ? orderTeams(rows, stored) : undefined), [rows, stored])
  const teamIds = useMemo(() => teamOrderFrom(teams ?? []), [teams])

  const reorderTeams = useCallback((ids: string[]) => {
    void enqueueTeamOrderWrite(ids)
  }, [])

  const moveTeam = useCallback(
    (teamId: string, delta: number) => {
      const next = moveTeamInOrder(teamIds, teamId, delta)
      if (next) void enqueueTeamOrderWrite(next)
    },
    [teamIds]
  )

  return { teams, teamIds, reorderTeams, moveTeam }
}
