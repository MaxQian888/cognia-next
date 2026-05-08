"use client"

/**
 * Mounts the Rust → Dexie event bridge for the mobile-companion subsystem.
 *
 * On mount, subscribes to `companion://device-paired` and
 * `companion://device-seen` via the shared transport and persists payloads
 * to the `pairedDevices` Dexie table. On unmount, detaches both listeners.
 *
 * Wrapped in a provider so React's strict-mode double-mount doesn't double
 * the listener count — `useEffect` cleanup runs between mounts.
 */

import { useEffect } from "react"
import { installCompanionEventBridge } from "@/lib/companion/event-bridge"

export function CompanionEventBridgeProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    if (typeof window === "undefined") return
    const detach = installCompanionEventBridge()
    return detach
  }, [])

  return <>{children}</>
}
