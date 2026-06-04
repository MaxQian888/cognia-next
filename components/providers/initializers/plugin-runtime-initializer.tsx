"use client"

import { useEffect, useRef } from "react"

import { isTauri } from "@/lib/native/utils"
import { loggers } from "@/lib/logging"

const log = loggers.plugin

/**
 * Boot-time initializer for the plugin platform.
 *
 * Resolves the shell profile via `resolvePluginRuntimeBootstrap` (browser vs
 * Tauri main window; secondary windows are refused there) and calls
 * `initializePluginManager`, which runs the full manager boot:
 * `scanPlugins()` (built-in registry walk + on-disk directory on desktop),
 * `syncRuntimeState()`, `restorePluginStates()`, and the `"startup"`
 * activation event that auto-enables plugins declaring
 * `activationEvents: ["onStartup"]`.
 *
 * Before this existed nothing called `initializePluginManager`, so the
 * entire plugin platform — built-in plugin discovery, declarative
 * contributions (workflow templates, skills, MCP presets), `/plugins`
 * panel data — stayed dormant in the running app.
 *
 * Everything heavy is dynamically imported inside the effect so the
 * manager's module graph stays out of the first paint. Idempotent:
 * `initializePluginManager` returns the existing instance on re-entry.
 * Following the `LocalCharacterPackInitializer` shape so the entry under
 * `app/layout.tsx` stays homogeneous.
 */
export function PluginRuntimeInitializer() {
  const hasInitialized = useRef(false)

  useEffect(() => {
    if (hasInitialized.current) return
    hasInitialized.current = true

    const initialize = async () => {
      try {
        const tauri = isTauri()
        let windowLabel: string | null = null
        let pluginDirectory: string | undefined
        if (tauri) {
          const [{ getCurrentWindow }, { appDataDir, join }] = await Promise.all([
            import("@tauri-apps/api/window"),
            import("@tauri-apps/api/path"),
          ])
          windowLabel = getCurrentWindow().label
          // Matches the `<appDataDir()>/cognia/<area>` convention used by
          // `lib/plugin/character-pack/local-pack-store.ts`. Only consumed
          // for descriptor display and the (optional) directory scan —
          // built-in plugins are discovered from the static registry.
          pluginDirectory = await join(await appDataDir(), "cognia", "plugins")
        }

        const { resolvePluginRuntimeBootstrap } = await import("@/lib/plugin/core/bootstrap")
        const resolution = resolvePluginRuntimeBootstrap({
          isTauri: tauri,
          windowLabel,
          pluginDirectory,
        })
        if (!resolution.shouldInitialize) {
          log.debug("plugin-runtime: boot skipped", { reason: resolution.reason })
          return
        }

        const { initializePluginManager } = await import("@/lib/plugin/core/manager")
        await initializePluginManager(resolution.config)
        log.info("plugin-runtime: initialized", { profile: resolution.config.runtimeProfile })
      } catch (err) {
        log.warn("plugin-runtime: boot threw", { err })
      }
    }

    void initialize()
  }, [])

  return null
}

export default PluginRuntimeInitializer
