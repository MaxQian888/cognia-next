"use client"

import { useEffect } from "react"

import { usePlatform } from "@/hooks/use-platform"
import { installDesktopSyncSource } from "@/lib/sync/desktop-sync-source"
import { installHostTableInvalidation } from "@/lib/sync/host-table-invalidation"
import { installAgentTeamProjection } from "@/lib/db/agent-team-projection"
import { startMcpSyncCoordinator } from "@/lib/mcp/sync-coordinator"
import { migrateMcpCredentials } from "@/lib/mcp/credential-migrator"

/**
 * Tauri-only provider that installs the desktop-side bridge for
 * `_rpc/sync_pull`. Listens for the Rust HTTP handler's
 * `companion://sync-pull-request` event, runs the corresponding Dexie
 * query, and ships the delta back through the
 * `companion_sync_pull_response` Tauri command.
 *
 * Also installs the host-side table invalidation watcher, which is the PUSH
 * half of the same protocol: `sync_pull` answers when asked, and
 * `installHostTableInvalidation` is what makes a paired client ask. It belongs
 * here for the same reason the board projection does — this is the process that
 * owns the authoritative rows, and on a client these tables are a mirror the
 * sync apply step writes.
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
    const uninstallInvalidation = installHostTableInvalidation()
    startMcpSyncCoordinator()
    void migrateMcpCredentials().then((report) => {
      const failures = report.items.filter((item) => item.status === "failed")
      if (failures.length > 0) {
        console.warn(`[mcp] ${failures.length} credential migration(s) require attention`)
      }
    })
    void installDesktopSyncSource().then((unsub) => {
      if (cancelled) {
        unsub()
        return
      }
      teardown = unsub
    })
    return () => {
      cancelled = true
      uninstallInvalidation()
      uninstallProjection()
      teardown?.()
    }
  }, [platform])

  return <>{children}</>
}
