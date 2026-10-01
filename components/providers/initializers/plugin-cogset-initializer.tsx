"use client"

import { useEffect, useSyncExternalStore } from "react"
import { loggers } from "@cognia/logging"

import {
  getBootCapabilitySnapshot,
  isBootCapabilityReady,
  subscribeBootCapabilities,
} from "@/lib/boot/capabilities"
import { isMirroredPluginClient } from "@/lib/plugin/core/mirrored-client"
import { useAccountStore } from "@/stores/account/account-store"

/**
 * Starts cogsets on a host that owns its plugin runtime (ADR-0209).
 *
 * Waits for `plugin-runtime` to be ready, because the Default cogset is built
 * from what discovery left enabled, and a reconciliation needs the manager.
 * Then, per unlocked account: create the Default cogset once, keep the applied
 * cogset in step with manual toggles and settings edits, and follow the
 * effective cogset (workspace binding, global choice, session override).
 *
 * A mirrored client runs none of this: it has no runtime to reconcile, and its
 * cogset tables are the host's, synced down.
 */
export function PluginCogsetInitializer() {
  useSyncExternalStore(
    subscribeBootCapabilities,
    getBootCapabilitySnapshot,
    getBootCapabilitySnapshot
  )
  const runtimeReady = isBootCapabilityReady("plugin-runtime")
  const accountId = useAccountStore((state) => state.unlockedAccountId)

  useEffect(() => {
    if (!runtimeReady || !accountId || isMirroredPluginClient()) return
    let cancelled = false
    const stops: Array<() => void> = []
    void (async () => {
      try {
        const [
          { ensureDefaultCogsetOnHost },
          { startDefaultCogsetWriteThrough },
          { startDefaultCogsetFollower },
        ] = await Promise.all([
          import("@/lib/plugin/cogset/bootstrap-default"),
          import("@/lib/plugin/cogset/write-through"),
          import("@/lib/plugin/cogset/follower"),
        ])
        await ensureDefaultCogsetOnHost()
        if (cancelled) return
        const writeThrough = await startDefaultCogsetWriteThrough()
        stops.push(writeThrough.stop)
        if (cancelled) return
        const follower = await startDefaultCogsetFollower()
        stops.push(follower.stop)
      } catch (error) {
        loggers.plugin.warn("cogsets failed to start", {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    })()
    return () => {
      cancelled = true
      for (const stop of stops.splice(0)) stop()
    }
  }, [runtimeReady, accountId])

  return null
}

export default PluginCogsetInitializer
