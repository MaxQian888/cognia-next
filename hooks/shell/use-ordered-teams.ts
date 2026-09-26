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
// This serializes every team preference kept on `conversationSidebar` — the
// order and the mute set (`hooks/shell/use-team-mute.ts`) — against each
// other: `conversationSidebar` is replaced whole by each `save()`, so a mute
// and a drag landing together would otherwise let the second erase the first.
// `saveSidebarSettings` in `channel-list.tsx` serializes the display options
// against themselves; the two writers could still overlap, but in practice
// they do not: both are driven by the same pointer, and neither starts while
// the other's gesture is in flight.
let teamPrefsWriteQueue: Promise<void> | null = null

type ConversationSidebar = NonNullable<
  NonNullable<ReturnType<typeof useSettingsStore.getState>["settings"]>["conversationSidebar"]
>

/**
 * Queue one write to `conversationSidebar`. `patch` receives the stored object
 * as it is when the write reaches the front of the queue and returns the
 * fields to change; everything else is carried over.
 */
export function enqueueTeamPrefsWrite(
  patch: (current: ConversationSidebar | undefined) => Partial<ConversationSidebar>
): Promise<void> {
  const run = async () => {
    const state = useSettingsStore.getState()
    const current = state.settings?.conversationSidebar
    await state.save({ conversationSidebar: { ...current, ...patch(current) } })
  }
  const task = teamPrefsWriteQueue ? teamPrefsWriteQueue.then(run, run) : run()
  // A rejected write must not wedge the queue for every later drag, but the
  // initiating caller still sees its own failure.
  const recovered = task.catch(() => undefined)
  teamPrefsWriteQueue = recovered
  void recovered.then(() => {
    if (teamPrefsWriteQueue === recovered) teamPrefsWriteQueue = null
  })
  return task
}

function enqueueTeamOrderWrite(ids: string[]): Promise<void> {
  return enqueueTeamPrefsWrite(() => ({ teamOrder: ids }))
}

/** Exposed for tests — the module-level queue outlives a single render tree. */
export function __resetTeamOrderQueueForTests(): void {
  teamPrefsWriteQueue = null
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
