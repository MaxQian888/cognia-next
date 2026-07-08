"use client"

/**
 * useFleetStream — live fleet snapshot for the island window (and any other
 * consumer). Backfills once via `fleet_get_snapshot`, then replaces state on
 * every `fleet://update` (full-snapshot semantics — no delta reconciliation,
 * mirroring `use-perf-stream.ts`). A pending permission arrives inside the
 * snapshot (the Rust registry sets it on the session before emitting), so
 * consumers derive "needs attention" straight from `snapshot` — no separate
 * event channel.
 */

import { useEffect, useRef, useState } from "react"
import { isTauri } from "@/lib/tauri"
import { fleetGetSnapshot } from "@/lib/tauri/fleet"
import { FLEET_UPDATE_EVENT, type FleetSnapshot } from "@/lib/fleet/types"

export interface UseFleetStreamResult {
  snapshot: FleetSnapshot
  /** Whether the native runtime is available (desktop). */
  available: boolean
}

const EMPTY: FleetSnapshot = { sessions: [], generatedAt: 0 }

export function useFleetStream(): UseFleetStreamResult {
  const available = isTauri()
  const [snapshot, setSnapshot] = useState<FleetSnapshot>(EMPTY)
  const aliveRef = useRef(true)

  useEffect(() => {
    if (!available) return undefined
    aliveRef.current = true
    let unlisten: (() => void) | undefined

    void (async () => {
      // Dynamic import keeps the Tauri event module out of web bundles.
      const { listen } = await import("@tauri-apps/api/event")
      if (!aliveRef.current) return

      const unUpdate = await listen<FleetSnapshot>(FLEET_UPDATE_EVENT, (e) => {
        if (aliveRef.current) setSnapshot(e.payload)
      })
      if (!aliveRef.current) {
        unUpdate()
        return
      }
      unlisten = unUpdate

      // Backfill AFTER subscribing so no update can slip between the two.
      const initial = await fleetGetSnapshot()
      if (aliveRef.current) {
        setSnapshot((current) => (current.generatedAt >= initial.generatedAt ? current : initial))
      }
    })()

    return () => {
      aliveRef.current = false
      unlisten?.()
    }
  }, [available])

  return { snapshot, available }
}
