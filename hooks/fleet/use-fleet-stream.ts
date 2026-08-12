"use client"

/**
 * useFleetStream — live fleet snapshot for the island window (and any other
 * consumer). Thin `useSyncExternalStore` wrapper over the module-level
 * `fleetStreamStore` (one shared, refcounted Tauri listener; backfill +
 * `generatedAt` monotonic guard live in the store). A pending permission
 * arrives inside the snapshot (the Rust registry sets it on the session
 * before emitting), so consumers derive "needs attention" straight from
 * `snapshot` — no separate event channel.
 */

import { useSyncExternalStore } from "react"
import { isTauri } from "@/lib/tauri"
import { unifiedFleetStore } from "@/lib/fleet/unified-fleet-store"
import type { FleetSnapshot } from "@/lib/fleet/types"

export interface UseFleetStreamResult {
  snapshot: FleetSnapshot
  /** Whether the native runtime is available (desktop). */
  available: boolean
}

export function useFleetStream(): UseFleetStreamResult {
  const available = isTauri()
  const snapshot = useSyncExternalStore(
    unifiedFleetStore.subscribe,
    unifiedFleetStore.getSnapshot,
    unifiedFleetStore.getServerSnapshot
  )
  return { snapshot, available }
}
