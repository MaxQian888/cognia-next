"use client"

/**
 * Subscribe to Tauri events fired by `src-tauri/src/cli_bridge/handlers.rs`
 * whenever the loopback HTTP bridge (i.e. the `cognia` CLI) installs,
 * uninstalls, or hot-reloads a plugin in this running desktop instance.
 *
 * The renderer never knew about these events before — the Rust handler
 * comment in the bridge said "renderer wires this in M3". This hook is
 * that M3 wiring.
 *
 * Each handled event refreshes the in-memory plugin runtime (`PluginManager`
 * scan) so the user sees the new row appear in the Library tab without
 * restarting the app. The actual `recordHotReload` side effect lives in
 * `stores/plugin-runtime/hot-reload-history-store.ts` so a separate panel
 * can render the history; we just feed it.
 *
 * On web / Capacitor the hook is a noop — the bridge isn't running there.
 */

import { useEffect } from "react"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"

import { isTauri } from "@/lib/tauri"
import { loggers } from "@/lib/logging"
import { getPluginManager } from "@/lib/plugin/core/manager"
import {
  recordHotReloadEvent,
  type HotReloadEntry,
} from "@/stores/plugin-runtime/hot-reload-history-store"

interface InstallPayload {
  plugin_id: string
}
interface UninstallPayload {
  plugin_id: string
  purge_data?: boolean
}
interface HotReloadPayload {
  plugin_id: string
  source?: string
  via?: "install" | "reload"
}

const INSTALL_EVENT = "cli-bridge:plugin-installed"
const UNINSTALL_EVENT = "cli-bridge:plugin-uninstalled"
const HOT_RELOAD_EVENT = "plugin-hot-reload"

/**
 * Mount once at the app root (next to the other plugin runtime mounts).
 * Subscribes to the three CLI-bridge events and tears down on unmount.
 */
export function useCliBridgeEvents(): void {
  useEffect(() => {
    if (!isTauri()) return
    let active = true
    const unlisteners: UnlistenFn[] = []

    void (async () => {
      try {
        const unInstall = await listen<InstallPayload>(INSTALL_EVENT, (event) => {
          const id = event.payload?.plugin_id
          if (!id) return
          loggers.plugin.info(`[cli-bridge] install event for ${id}`)
          recordHotReloadEvent({
            pluginId: id,
            source: "cli-bridge",
            kind: "install",
            timestamp: Date.now(),
            status: "success",
          })
          void refreshManagerScan()
        })
        const unUninstall = await listen<UninstallPayload>(UNINSTALL_EVENT, (event) => {
          const id = event.payload?.plugin_id
          if (!id) return
          loggers.plugin.info(`[cli-bridge] uninstall event for ${id}`)
          recordHotReloadEvent({
            pluginId: id,
            source: "cli-bridge",
            kind: "uninstall",
            timestamp: Date.now(),
            status: "success",
          })
          void refreshManagerScan()
        })
        const unReload = await listen<HotReloadPayload>(HOT_RELOAD_EVENT, (event) => {
          const id = event.payload?.plugin_id
          if (!id) return
          loggers.plugin.info(`[cli-bridge] hot-reload event for ${id}`)
          recordHotReloadEvent({
            pluginId: id,
            source: event.payload?.source ?? "cli-bridge",
            kind: event.payload?.via === "install" ? "install" : "hot-reload",
            timestamp: Date.now(),
            status: "success",
          })
          void refreshManagerScan()
        })

        if (active) {
          unlisteners.push(unInstall, unUninstall, unReload)
        } else {
          // Listener resolved after unmount — clean up immediately so
          // we don't leak a Tauri channel.
          unInstall()
          unUninstall()
          unReload()
        }
      } catch (err) {
        loggers.plugin.warn(`[cli-bridge] failed to subscribe`, { error: String(err) })
      }
    })()

    return () => {
      active = false
      for (const off of unlisteners) {
        try {
          off()
        } catch (err) {
          loggers.plugin.warn(`[cli-bridge] unlisten failed`, { error: String(err) })
        }
      }
    }
  }, [])
}

async function refreshManagerScan(): Promise<void> {
  try {
    await getPluginManager().scanPlugins()
  } catch (err) {
    loggers.plugin.warn(`[cli-bridge] post-event scan failed`, { error: String(err) })
  }
}

// Re-export for symmetry with the hot-reload store consumers.
export type { HotReloadEntry }
