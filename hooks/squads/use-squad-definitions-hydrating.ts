"use client"

/**
 * Whether Squad definitions are still on their way into the store.
 *
 * They arrive through the store's async Dexie bridge, so on a cold load the
 * store is empty for a moment while Dexie already holds the user's Squads. A
 * surface that resolves what to show from the store alone picks its "no
 * Squads" answer first and swaps a moment later: Settings → Squads opened on
 * the template gallery and crossfaded to the first Squad, which read as a
 * flicker, and its rail said "No Squads yet" in the meantime.
 *
 * Hydrating means: Dexie has not answered yet, or it holds rows the store does
 * not, and the bridge has not reported its hydration settled. The bridge's own
 * verdict ends the wait even if the store stays empty, because a failed
 * hydration disables the mirror rather than filling the store, and waiting on
 * the store alone would hold a skeleton on screen for good. A locked account
 * has no database and counts as empty.
 */

import { useEffect, useState } from "react"

import { useClientLiveQuery } from "@/hooks/data"
import { getDb } from "@/lib/db/schema"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { whenAgentTeamDexieBridgeHydrated } from "@/stores/agent/agent-team-store/dexie-bridge"

export function useSquadDefinitionsHydrating(): boolean {
  const storeHasTeams = useAgentTeamStore((s) => Object.keys(s.teams).length > 0)
  const mirroredCount = useClientLiveQuery(
    async () => {
      try {
        return await getDb().agentTeams.count()
      } catch {
        return 0
      }
    },
    [],
    undefined
  )
  const [bridgeSettled, setBridgeSettled] = useState(false)
  useEffect(() => {
    let live = true
    void whenAgentTeamDexieBridgeHydrated()
      .catch(() => undefined)
      .then(() => {
        if (live) setBridgeSettled(true)
      })
    return () => {
      live = false
    }
  }, [])

  if (mirroredCount === undefined) return true
  return mirroredCount > 0 && !storeHasTeams && !bridgeSettled
}
