"use client"

import { useEffect } from "react"

import { usePlatform } from "@/hooks/use-platform"
import { installDesktopSyncSource } from "@/lib/sync/desktop-sync-source"
import { installAgentTeamProjection } from "@/lib/db/agent-team-projection"

/**
 * Tauri-only provider that installs the desktop-side bridge for
 * `_rpc/sync_pull`. Listens for the Rust HTTP handler's
 * `companion://sync-pull-request` event, runs the corresponding Dexie
 * query, and ships the delta back through the
 * `companion_sync_pull_response` Tauri command.
 *
 * No-op on Capacitor (the phone consumes deltas, never produces them)
 * and on plain web (no Tauri runtime; nothing to hook into).
 */
export function DesktopSyncSourceProvider({ children }: { children: React.ReactNode }) {
  const platform = usePlatform()

  useEffect(() => {
    if (platform !== "tauri") return
    let teardown: (() => void) | null = null
    let cancelled = false
    // Desktop-only: the store→Dexie board projection that feeds the
    // `agentTeamBoard` sync table (v104). Installing this on the mobile
    // shell would wipe the synced mirror with the phone's empty store.
    const uninstallProjection = installAgentTeamProjection()
    void installDesktopSyncSource().then((unsub) => {
      if (cancelled) {
        unsub()
        return
      }
      teardown = unsub
    })
    return () => {
      cancelled = true
      uninstallProjection()
      teardown?.()
    }
  }, [platform])

  return <>{children}</>
}
