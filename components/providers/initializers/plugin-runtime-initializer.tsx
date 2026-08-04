"use client"

import { useEffect, useRef } from "react"

import { detectPlatform } from "@/lib/platform/detect"
import { installPackWarningRefreshWiring } from "@/lib/plugin/character-pack/warning-refresh-wiring"
import { loggers } from "@cognia/logging"
import { SystemEvents, emitSystemBusEvent } from "@/lib/plugin/messaging/message-bus"

const log = loggers.plugin

declare global {
  interface Window {
    __cogniaPluginRuntimeReady?: boolean
  }
}

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

  // Dependency warnings involving theme packs must stay current in every
  // runtime profile. Theme packs are contributed by regular plugins, while
  // local character-pack scanning only runs in the desktop shell.
  useEffect(() => installPackWarningRefreshWiring(), [])

  useEffect(() => {
    if (hasInitialized.current) return
    hasInitialized.current = true
    window.__cogniaPluginRuntimeReady = false

    const initialize = async () => {
      try {
        // Resolve the host platform once (tauri wins over mobile over web) and
        // derive both signals so the bootstrap can pick the right runtime
        // profile: tauri / mobile (Capacitor WebView) / browser.
        const platform = detectPlatform()
        const tauri = platform === "tauri"
        const mobile = platform === "mobile"
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
          isMobile: mobile,
          windowLabel,
          pluginDirectory,
        })
        if (!resolution.shouldInitialize) {
          log.debug("plugin-runtime: boot skipped", { reason: resolution.reason })
          return
        }

        // Wire the live plugin security posture (settings → egress/permission
        // gates) so a strict posture denies undeclared network egress.
        const [{ setPluginSecurityPostureSource }, { useSettingsStore }] = await Promise.all([
          import("@/lib/plugin/security/security-posture"),
          import("@/stores/settings/settings-store"),
        ])
        setPluginSecurityPostureSource(
          () => useSettingsStore.getState().settings?.pluginSecurityPosture
        )

        const { initializePluginManager } = await import("@/lib/plugin/core/manager")
        await initializePluginManager(resolution.config)
        window.__cogniaPluginRuntimeReady = true
        log.info("plugin-runtime: initialized", { profile: resolution.config.runtimeProfile })
        // Announce boot completion on the plugin message bus so plugins can run
        // post-ready work (the catalog declared `APP_READY` but nothing emitted
        // it). Best-effort; no payload (ids-only convention, nothing to carry).
        emitSystemBusEvent(SystemEvents.APP_READY, {})
      } catch (err) {
        log.warn("plugin-runtime: boot threw", { err })
      }
    }

    void initialize()
  }, [])

  // Emit `APP_CLOSING` on page unload so plugins can flush state / cancel
  // in-flight work. The handler must be synchronous (a dynamic import wouldn't
  // resolve before the page is gone), hence the static `emitSystemBusEvent`
  // import above. Best-effort: a no-op when no plugin subscribed.
  useEffect(() => {
    const handleBeforeUnload = () => emitSystemBusEvent(SystemEvents.APP_CLOSING, {})
    window.addEventListener("beforeunload", handleBeforeUnload)
    return () => window.removeEventListener("beforeunload", handleBeforeUnload)
  }, [])

  return null
}

export default PluginRuntimeInitializer
