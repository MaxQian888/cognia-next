"use client"

/**
 * Fleet boot initializer, mounted in the main desktop window inside
 * `DesktopOnlyInitializers` (already gated to the main window). Two jobs:
 *
 * 1. Restore the monitor if it was enabled before the last quit — a fresh
 *    token replaces the stale one the persisted hook scripts would present to
 *    a dead ingress. Without this, externally-launched agents POST into
 *    nothing after every relaunch until the user re-toggles in Settings.
 * 2. Run the history sink so live sessions persist to Dexie even when the
 *    island overlay is closed.
 */

import { useEffect, useRef } from "react"
import { useFleetHistorySink } from "@/hooks/fleet/use-fleet-history-sink"
import { fleetMonitorRestore } from "@/lib/tauri/fleet"

export function FleetHistorySinkInitializer() {
  const restored = useRef(false)
  useEffect(() => {
    if (restored.current) return
    restored.current = true
    void fleetMonitorRestore()
  }, [])
  useFleetHistorySink()
  return null
}

export default FleetHistorySinkInitializer
