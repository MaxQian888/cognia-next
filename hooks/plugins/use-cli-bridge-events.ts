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
 * Install/uninstall events refresh discovery and land in the hot-reload
 * history that the DevTools diagnostics panel reads. Development build events
 * feed the canonical in-memory Dev Session store. Runtime success is recorded
 * exclusively by the renderer request that verifies a new lifecycle
 * generation, so this hook never claims a reload worked.
 *
 * On web / Capacitor the hook is a noop — the bridge isn't running there.
 */

import { useEffect } from "react"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"

import { isTauri } from "@/lib/tauri"
import { safeUnlisten } from "@/lib/tauri/safe-unlisten"
import { loggers } from "@cognia/logging"
import { getPluginManager } from "@/lib/plugin/core/manager"
import {
  usePluginDevSessionStore,
  type PluginDevSessionEvent,
} from "@/stores/plugins/plugin-dev-session-store"
import { recordHotReloadEvent } from "@/stores/plugin-runtime/hot-reload-history-store"

interface InstallPayload {
  plugin_id: string
  /**
   * Which driver installed it. The in-app "Load unpacked" flow
   * (`plugin_install_from_directory`) and the loopback CLI bridge both emit
   * `cli-bridge:plugin-installed`, so without this the panel would credit the
   * CLI for a drag-and-drop install.
   */
  source?: string
}
interface UninstallPayload {
  plugin_id: string
  purge_data?: boolean
}
const INSTALL_EVENT = "cli-bridge:plugin-installed"
const UNINSTALL_EVENT = "cli-bridge:plugin-uninstalled"
const DEV_SESSION_EVENT = "cli-bridge:plugin-dev-session"
/**
 * The bridge only fires these after the Rust side finished the operation, so
 * every entry recorded here is already terminal.
 *
 * These are install / uninstall rows, never `hot-reload` ones: an install
 * event proves a bundle landed on disk, not that the plugin activated. Only
 * the verified `plugin_dev_reload` round-trip may claim a runtime success.
 */
const CLI_SOURCE = "cli"
const APP_SOURCE = "app"

/** `plugin_install_from_directory` is the in-app "Load unpacked" flow. */
function installSource(payload: InstallPayload): string {
  return payload.source === "load-unpacked" ? APP_SOURCE : CLI_SOURCE
}

/**
 * Mount once at the app root (next to the other plugin runtime mounts).
 * Subscribes to the three CLI-bridge events and tears down on unmount.
 */
export function useCliBridgeEvents(): void {
  useEffect(() => {
    if (!isTauri()) return
    let active = true
    const unlisteners: UnlistenFn[] = []
    const staleTimer = window.setInterval(
      () => usePluginDevSessionStore.getState().markStale(),
      5_000
    )

    void (async () => {
      try {
        const unInstall = await listen<InstallPayload>(INSTALL_EVENT, (event) => {
          const id = event.payload?.plugin_id
          if (!id) return
          loggers.plugin.info(`[cli-bridge] install event for ${id}`)
          recordHotReloadEvent({
            pluginId: id,
            source: installSource(event.payload),
            kind: "install",
            status: "success",
            timestamp: Date.now(),
          })
          void refreshManagerScan()
        })
        const unUninstall = await listen<UninstallPayload>(UNINSTALL_EVENT, (event) => {
          const id = event.payload?.plugin_id
          if (!id) return
          loggers.plugin.info(`[cli-bridge] uninstall event for ${id}`)
          recordHotReloadEvent({
            pluginId: id,
            source: CLI_SOURCE,
            kind: "uninstall",
            status: "success",
            timestamp: Date.now(),
          })
          void refreshManagerScan()
        })
        const unSession = await listen<PluginDevSessionEvent>(DEV_SESSION_EVENT, (event) => {
          if (!event.payload?.sessionId) return
          usePluginDevSessionStore.getState().ingest(event.payload)
        })

        if (active) {
          unlisteners.push(unInstall, unUninstall, unSession)
        } else {
          // Listener resolved after unmount — clean up immediately so
          // we don't leak a Tauri channel.
          safeUnlisten(unInstall)
          safeUnlisten(unUninstall)
          safeUnlisten(unSession)
        }
      } catch (err) {
        loggers.plugin.warn(`[cli-bridge] failed to subscribe`, { error: String(err) })
      }
    })()

    return () => {
      active = false
      window.clearInterval(staleTimer)
      for (const off of unlisteners) safeUnlisten(off)
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
