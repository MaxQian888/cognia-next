"use client"

import { useEffect, useRef, useSyncExternalStore } from "react"

import { detectPlatform } from "@/lib/platform/detect"
import { installPackWarningRefreshWiring } from "@/lib/plugin/character-pack/warning-refresh-wiring"
import { installPluginRuntimeLogBridge } from "@/lib/plugin/devtools/plugin-log-bridge"
import { loggers } from "@cognia/logging"
import { SystemEvents, emitSystemBusEvent } from "@/lib/plugin/messaging/message-bus"
import { disposeMicrovmAdapters } from "@/lib/sandbox/microvm-bridge"
import {
  markBootCapabilityFailed,
  markBootCapabilityReady,
  getBootCapabilitySnapshot,
  isBootCapabilityRequested,
  subscribeBootCapabilities,
} from "@/lib/boot/capabilities"
import { useAccountStore } from "@/stores/account/account-store"

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
export interface PluginRuntimeInitializerProps {
  /** Keep the pre-account E2E initializer off unrelated real-browser lanes. */
  onlyForPluginSurfaceE2E?: boolean
}

export function PluginRuntimeInitializer({
  onlyForPluginSurfaceE2E = false,
}: PluginRuntimeInitializerProps = {}) {
  const initializedForAccount = useRef<string | null>(null)
  const unlockedAccountId = useAccountStore((state) => state.unlockedAccountId)
  const accountRevision = useAccountStore((state) => state.accountRevision)
  useSyncExternalStore(
    subscribeBootCapabilities,
    getBootCapabilitySnapshot,
    getBootCapabilitySnapshot
  )
  const requested = isBootCapabilityRequested("plugin-runtime")
  const isPluginSurfaceE2E =
    onlyForPluginSurfaceE2E &&
    process.env.NEXT_PUBLIC_E2E === "1" &&
    typeof window !== "undefined" &&
    window.location.pathname.startsWith("/e2e/plugin-ui-surfaces")
  const shouldRun = onlyForPluginSurfaceE2E ? isPluginSurfaceE2E : requested
  const runtimeOwnerKey = isPluginSurfaceE2E
    ? "e2e:plugin-ui-surfaces"
    : unlockedAccountId
      ? `${unlockedAccountId}:${accountRevision}`
      : null

  // Dependency warnings involving theme packs must stay current in every
  // runtime profile. Theme packs are contributed by regular plugins, while
  // local character-pack scanning only runs in the desktop shell.
  useEffect(() => {
    if (!shouldRun) return
    return installPackWarningRefreshWiring()
  }, [shouldRun])

  // A plugin's own output only reaches `/logs` because this forwards it. The
  // detail pane's Logs entry is a link into that panel filtered to the plugin
  // source, and nothing in the app emitted an entry carrying it, so without
  // this bridge that link opens an empty list for every plugin.
  useEffect(() => {
    if (!shouldRun) return
    return installPluginRuntimeLogBridge()
  }, [shouldRun])

  useEffect(() => {
    if (!shouldRun || !runtimeOwnerKey) return
    if (initializedForAccount.current === runtimeOwnerKey) return
    initializedForAccount.current = runtimeOwnerKey
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
          markBootCapabilityReady("plugin-runtime")
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

        // Put the plugins that ship inside the installer on disk before the
        // manager scans for them. Only the desktop shell has a plugin
        // directory to seed into, and only a window that owns the runtime gets
        // this far, so the pet and tray overlays do not each race for the same
        // copy.
        //
        // The whole step is best effort. `seedBundledPluginsOnHost` already
        // records per-plugin failures rather than raising, but the dynamic
        // import and the Tauri path API sit outside anything it can catch on
        // its own behalf. Losing a bundled plugin is worth far less than
        // losing the plugin runtime, so nothing here may reach the outer
        // handler.
        if (tauri) {
          try {
            const { seedBundledPluginsOnHost } =
              await import("@/lib/plugin/distribution/seed-bundled-plugins")
            const seeded = await seedBundledPluginsOnHost()
            if (seeded.seeded.length > 0 || Object.keys(seeded.failed).length > 0) {
              log.info("plugin-runtime: bundled plugin seed", seeded)
            }
          } catch (seedError) {
            log.warn("plugin-runtime: bundled plugin seed unavailable", { seedError })
          }
        }

        const { initializePluginManager } = await import("@/lib/plugin/core/manager")
        await initializePluginManager(resolution.config)
        window.__cogniaPluginRuntimeReady = true
        markBootCapabilityReady("plugin-runtime")
        log.info("plugin-runtime: initialized", { profile: resolution.config.runtimeProfile })
        // Announce boot completion on the plugin message bus so plugins can run
        // post-ready work (the catalog declared `APP_READY` but nothing emitted
        // it). Best-effort; no payload (ids-only convention, nothing to carry).
        emitSystemBusEvent(SystemEvents.APP_READY, {})
      } catch (err) {
        initializedForAccount.current = null
        markBootCapabilityFailed("plugin-runtime", err)
        log.warn("plugin-runtime: boot threw", { err })
      }
    }

    void initialize()
  }, [runtimeOwnerKey, shouldRun])

  // Emit `APP_CLOSING` on page unload so plugins can flush state / cancel
  // in-flight work. The handler must be synchronous (a dynamic import wouldn't
  // resolve before the page is gone), hence the static `emitSystemBusEvent`
  // import above. Best-effort: a no-op when no plugin subscribed.
  useEffect(() => {
    if (!shouldRun) return
    const handleBeforeUnload = () => {
      emitSystemBusEvent(SystemEvents.APP_CLOSING, {})
      void disposeMicrovmAdapters()
    }
    window.addEventListener("beforeunload", handleBeforeUnload)
    return () => window.removeEventListener("beforeunload", handleBeforeUnload)
  }, [shouldRun])

  return null
}

export default PluginRuntimeInitializer
