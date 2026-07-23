"use client"

/**
 * Fleet boot initializer, mounted in the main desktop window inside
 * `DesktopOnlyInitializers` (already gated to the main window). Two jobs:
 *
 * 1. Restore the monitor if it was enabled before the last quit — a fresh
 *    token replaces the stale one the persisted hook scripts would present to
 *    a dead ingress. Without this, externally-launched agents POST into
 *    nothing after every relaunch until the user re-toggles in Settings.
 * 2. Restore the island overlay if it was showing at last quit. This is the
 *    other half of the same promise: the monitor coming back with no overlay
 *    to show it in reads as "monitoring is broken", not "you closed a window".
 *    A no-op when it was closed.
 * 3. Run the history sink so live sessions persist to Dexie even when the
 *    island overlay is closed.
 */

import { useEffect, useRef } from "react"
import { useFleetHistorySink } from "@/hooks/fleet/use-fleet-history-sink"
import { fleetMonitorRestore, islandRestore } from "@/lib/tauri/fleet"

export function FleetHistorySinkInitializer() {
  const restored = useRef(false)
  useEffect(() => {
    if (restored.current) return
    restored.current = true
    // Sequential: the island's first snapshot should come from a live ingress,
    // not an empty one it then has to backfill.
    void fleetMonitorRestore().then(() => islandRestore())
  }, [])
  useFleetHistorySink()
  return null
}

export default FleetHistorySinkInitializer
