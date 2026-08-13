"use client"

import { usePathname, useRouter } from "next/navigation"
import { useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { useTheme } from "next-themes"
import { toast } from "sonner"

import { usePlatform } from "@/hooks/use-platform"
import { useSettingsStore } from "@/stores/settings"
import { getShellColors } from "@/lib/appearance/shell-sync"
import { minimizeApp, subscribeBackButton } from "@/lib/capacitor/app"
import { getLaunchRoute, subscribe as subscribeDeeplink } from "@/lib/capacitor/deeplink"
import { dispatchRoute, makeRouterNavigators } from "@/lib/capacitor/deeplink-router"
import { registerNativePlugins } from "@/lib/capacitor/register-plugins"
import { hide as hideSplash } from "@/lib/capacitor/splash-screen"
import { syncWithTheme as syncStatusBar } from "@/lib/capacitor/status-bar"
import { syncWithTheme as syncNavBar } from "@/lib/capacitor/navigation-bar"
import {
  DEFAULT_CHANNEL_ID as NOTIF_CHANNEL_ID,
  ensureChannel as ensureNotifChannel,
  onAction as onLocalNotifAction,
  subscribeNotificationPermissionGranted,
} from "@/lib/capacitor/local-notifications"
import { registerPushNotifications, reportPushTokenToDesktop } from "@/lib/push/push-notifications"
import { installPushNotificationBridge } from "@/lib/notifications/inbound-push"
import {
  installEventDrivenSync,
  installForegroundSync,
  installNetworkSync,
  installResumeSync,
  runSyncDown,
} from "@/lib/sync/companion-sync"
import { hydrateCompanionConfig } from "@/lib/tauri/transport-companion"
import { DEFAULT_LOCAL_ACCOUNT_ID } from "@/lib/accounts/active-account-id"
import { adoptMobileCompanionHosts } from "@/lib/companion/mobile-host-adoption"
import { companionCredentialBook } from "@/lib/companion/credential-book"
import { classifyWsHost } from "@/lib/connectivity/lan-classify"
import { activateAccountDatabase } from "@/lib/db/schema"
import { registerCompanionRuntimeTarget } from "@/lib/runtime/account-runtime-target"
import {
  runtimeHostSnapshotFromManifest,
  setRuntimeSnapshot,
  updateRuntimeSnapshot,
} from "@/lib/runtime/runtime-snapshot-store"
import { setActiveRuntimeTargetContext } from "@/lib/runtime/runtime-target-context"
import { registerRuntimeTargetSubscriptionStopper } from "@/lib/runtime/runtime-target-lifecycle"
import { remoteEventResyncCoordinator } from "@/lib/tauri/resync-coordinator"
import { transport } from "@/lib/tauri/transport-instance"
import {
  installCapabilityReporter,
  type CapabilityReporterTransport,
} from "@/lib/companion/capability-reporter"
import { installRemoteStepServer } from "@/lib/companion/remote-step-server"
import { loadCompanionConfig } from "@/lib/tauri/transport-companion"
import { getSettings } from "@/lib/db/settings"
import { loggers } from "@cognia/logging"
import {
  registerMobileHostBindingController,
  restartMobileHostBindings,
} from "@/lib/companion/mobile-host-binding-lifecycle"

// Onboarding routes where the boot provider must NOT redirect (the chooser /
// pair / oauth flows own navigation there).
const ONBOARDING_PREFIXES = ["/welcome", "/pair", "/oauth"]

const log = loggers.shell

/**
 * Capacitor-only boot orchestrator (M3.4 hydrate + M4.6 push + M4.7 sync).
 *
 * On the phone's first paint, and again when notification permission becomes
 * available after pairing:
 *   1. Hydrate the companion config from SecureStorage.
 *   2. If unpaired and the user isn't already on `/pair`, redirect.
 *   3. If paired:
 *        a. Run an immediate sync-down so the chat list is warm.
 *        b. Install the foreground listener (re-sync on visibilitychange).
 *        c. Subscribe to the desktop's `sync://invalidate` channel so
 *           Dexie deltas fall through automatically.
 *        d. Silently register for APNs/FCM when already authorized, then ship
 *           the device token to the desktop. The contextual CTA owns prompts.
 *        e. Install the unified inbound-push bridge; background taps route
 *           to the relevant session via the `sessionId` payload field.
 *
 * No-op on Tauri (the desktop is the server, not a client) and on plain
 * web (no SecureStorage / native plugins). All side effects torn down on
 * unmount or platform change.
 */
export function CompanionBootProvider({ children }: { children: React.ReactNode }) {
  const platform = usePlatform()
  const router = useRouter()
  const pathname = usePathname()
  const { resolvedTheme } = useTheme()
  const t = useTranslations("mobile.companion")
  // The boot effect below must run exactly once per mobile session. Keeping
  // `pathname` / `router` / `t` in its dep array made the FIRST in-app
  // navigation run the effect's cleanup (tearing down backButton, deeplink,
  // push, and all sync installers) while the `ranRef` guard blocked re-setup —
  // leaving the native lifecycle dead for the rest of the session. The boot
  // closure reads all three through refs instead so the effect never re-fires.
  const pathnameRef = useRef(pathname)
  const routerRef = useRef(router)
  const tRef = useRef(t)
  useEffect(() => {
    pathnameRef.current = pathname
    routerRef.current = router
    tRef.current = t
  }, [pathname, router, t])
  // Flips true once registerNativePlugins() has populated
  // window.Capacitor.Plugins.* — the theme-sync effect below must not fire
  // before that (effects run in declaration order, so its first invocation
  // used to race registration and no-op as `unsupported`, leaving the
  // status/nav bars unpainted until the next theme change).
  const [pluginsReady, setPluginsReady] = useState(platform !== "mobile")
  const reportPushForActiveHostRef = useRef<() => Promise<void>>(async () => undefined)

  const appearanceColorTheme = useSettingsStore((s) => s.colorTheme)
  const appearanceActiveCustomThemeId = useSettingsStore((s) => s.activeCustomThemeId)
  const appearanceCustomThemes = useSettingsStore((s) => s.customThemes)
  // High contrast replaces the whole palette; without it the status / nav bars
  // stayed on the normal palette while the app itself repainted.
  const appearanceA11y = useSettingsStore((s) => s.settings?.a11y)

  // Status bar + Android nav bar track the resolved theme on every change.
  // Decoupled from the boot effect because theme can flip after boot
  // (system preference change, manual toggle). The nav-bar wrapper is a
  // no-op on iOS and on devices without the @capgo plugin installed.
  //
  // `getShellColors` derives a token-driven hex pair from the active
  // appearance palette so the chrome paints in lockstep with custom themes,
  // not just light/dark. Falls back to safe defaults when the palette
  // can't be resolved.
  useEffect(() => {
    if (platform !== "mobile" || !pluginsReady) return
    const shellColors = getShellColors(
      {
        colorTheme: appearanceColorTheme,
        activeCustomThemeId: appearanceActiveCustomThemeId,
        customThemes: appearanceCustomThemes,
        a11y: appearanceA11y,
      },
      resolvedTheme
    )
    void syncStatusBar(resolvedTheme, shellColors.backgroundHex)
    void syncNavBar(resolvedTheme, shellColors.backgroundHex)
  }, [
    platform,
    pluginsReady,
    resolvedTheme,
    appearanceColorTheme,
    appearanceActiveCustomThemeId,
    appearanceCustomThemes,
    appearanceA11y,
  ])

  useEffect(() => {
    if (platform !== "mobile") return

    let cancelled = false
    const nativeCleanup: Array<() => void | Promise<void>> = []
    const hostCleanup: Array<() => void | Promise<void>> = []
    let hostGeneration = 0

    const dispose = (fn: () => void | Promise<void>) => {
      try {
        const result = fn()
        if (result && typeof (result as Promise<void>).then === "function") {
          void (result as Promise<void>).catch(() => undefined)
        }
      } catch {
        // Native and subscription teardown is best-effort.
      }
    }

    const addNativeCleanup = (fn: () => void | Promise<void>) => {
      if (cancelled) {
        dispose(fn)
      } else {
        nativeCleanup.push(fn)
      }
    }

    const stopHostBindings = async () => {
      hostGeneration += 1
      reportPushForActiveHostRef.current = async () => undefined
      const pending = hostCleanup.splice(0)
      await Promise.allSettled(
        pending.map(async (fn) => {
          await fn()
        })
      )
    }

    const startHostBindings = async () => {
      const generation = ++hostGeneration
      const isStale = () => cancelled || generation !== hostGeneration
      const addHostCleanup = (fn: () => void | Promise<void>) => {
        if (isStale()) dispose(fn)
        else hostCleanup.push(fn)
      }

      let pushRegistered = false
      let pushRegistration: Promise<void> | null = null
      const registerAndReportPush = async () => {
        if (pushRegistered) return
        if (pushRegistration) return pushRegistration
        const attempt = (async () => {
          const push = await registerPushNotifications({ requestPermission: false })
          if (isStale()) return
          if (push.kind !== "registered") {
            log.info("companion: push registration outcome", { kind: push.kind })
            return
          }
          const sent = await reportPushTokenToDesktop(push.token, push.platform)
          if (isStale()) return
          if (!sent.ok) {
            log.warn("companion: failed to report push token", { reason: sent.reason })
            toast.error(tRef.current("pushTokenFailed", { reason: sent.reason }))
            return
          }
          pushRegistered = true
          log.info("companion: push token reported", { platform: push.platform })
        })()
        pushRegistration = attempt
        try {
          await attempt
        } finally {
          if (pushRegistration === attempt) pushRegistration = null
        }
      }
      reportPushForActiveHostRef.current = registerAndReportPush

      await adoptMobileCompanionHosts()
      if (isStale()) return
      const activeHost = await companionCredentialBook().getActive(DEFAULT_LOCAL_ACCOUNT_ID)
      if (isStale()) return
      if (activeHost) {
        activateAccountDatabase(DEFAULT_LOCAL_ACCOUNT_ID, activeHost.hostId)
        setActiveRuntimeTargetContext(DEFAULT_LOCAL_ACCOUNT_ID, activeHost.hostId)
        setRuntimeSnapshot({
          target: {
            id: activeHost.hostId,
            kind: "companion",
            platform: "mobile",
            hostKind:
              classifyWsHost(activeHost.endpoints.baseUrl) === "ws-lan" ? "desktop" : "cloud",
          },
          vaultState: "unlocked",
          connectionState: "connecting",
        })
      }

      const config = await hydrateCompanionConfig()
      if (isStale()) return
      const mode = (await getSettings().catch(() => null))?.mobileRuntimeMode
      if (isStale()) return
      if (mode === "standalone") return

      if (!config) {
        setRuntimeSnapshot({ target: null, vaultState: "unavailable", connectionState: "offline" })
        const onOnboarding = ONBOARDING_PREFIXES.some((prefix) =>
          pathnameRef.current.startsWith(prefix)
        )
        if (!onOnboarding) routerRef.current.replace(mode === "paired" ? "/pair" : "/welcome")
        return
      }

      await registerCompanionRuntimeTarget({
        ...config,
        accountId: DEFAULT_LOCAL_ACCOUNT_ID,
        targetId: config.targetId,
      })
      if (isStale()) return
      addHostCleanup(registerRuntimeTargetSubscriptionStopper(stopHostBindings))

      try {
        const manifest = await transport.call("host_feature_manifest", {})
        if (isStale()) return
        const host = runtimeHostSnapshotFromManifest(manifest)
        updateRuntimeSnapshot({ host })
        if (!host.compatible) {
          updateRuntimeSnapshot({ connectionState: "offline" })
          return
        }
      } catch (error) {
        if (!isStale()) {
          updateRuntimeSnapshot({ connectionState: "offline", host: undefined })
          log.warn("companion: host manifest unavailable", {
            error: error instanceof Error ? error.message : String(error),
          })
        }
        return
      }

      addHostCleanup(
        remoteEventResyncCoordinator.register("*", async () => {
          await runSyncDown()
        })
      )
      try {
        await runSyncDown()
        if (!isStale()) updateRuntimeSnapshot({ connectionState: "online" })
      } catch (error) {
        log.warn("companion: initial sync-down failed", {
          error: error instanceof Error ? error.message : String(error),
        })
      }
      if (isStale()) return
      addHostCleanup(installForegroundSync())
      addHostCleanup(installEventDrivenSync())
      addHostCleanup(await installNetworkSync())
      addHostCleanup(await installResumeSync())

      const reporterTransport = transport as Partial<CapabilityReporterTransport>
      if (
        typeof reporterTransport.call === "function" &&
        typeof reporterTransport.getConnectionState === "function" &&
        typeof reporterTransport.onConnectionStateChange === "function"
      ) {
        addHostCleanup(installCapabilityReporter(reporterTransport as CapabilityReporterTransport))
      }
      addHostCleanup(
        installRemoteStepServer({
          transport,
          getDeviceId: () => loadCompanionConfig()?.deviceId,
        })
      )
      await registerAndReportPush()
    }

    const unregisterController = registerMobileHostBindingController({
      start: startHostBindings,
      stop: stopHostBindings,
    })
    addNativeCleanup(unregisterController)

    const onConfigChanged = () => {
      void restartMobileHostBindings().catch((error) => {
        log.warn("companion: failed to restart Host bindings", {
          error: error instanceof Error ? error.message : String(error),
        })
      })
    }
    window.addEventListener("cognia:companion-config-changed", onConfigChanged)
    addNativeCleanup(() =>
      window.removeEventListener("cognia:companion-config-changed", onConfigChanged)
    )

    addNativeCleanup(
      subscribeNotificationPermissionGranted(() => {
        void reportPushForActiveHostRef.current().catch((error) => {
          log.warn("companion: permission-triggered push registration failed", {
            error: error instanceof Error ? error.message : String(error),
          })
        })
      })
    )

    void (async () => {
      // FIRST: create the window.Capacitor.Plugins.* proxies. Capacitor Android
      // injects only the transport bridge — without this every lib/capacitor/*
      // wrapper (splash, haptics, camera, openSettings, …) silently no-ops.
      // Must run before any other native call below. Best-effort + self-logs.
      await registerNativePlugins()
      // Unblock the theme-sync effect now that the plugin proxies exist
      // (best-effort even when registration reported unavailable — the
      // wrappers degrade to `unsupported` on their own).
      setPluginsReady(true)

      // Hide native splash now that React has painted. Best-effort — if the
      // plugin is missing this is a no-op.
      void hideSplash(300)
      // Ensure the LocalNotifications channel exists so offline-queue
      // backstops (Wave 3) can fire later without permission prompt churn.
      void ensureNotifChannel({
        id: NOTIF_CHANNEL_ID,
        name: "cognia",
        description: "Pairing, sync, and offline-queue notifications",
        importance: 4,
      })

      // Local-notification taps (backup-due / offline-queue reminders).
      // Schedulers stamp `extra.route` with an in-app path; a tap
      // foregrounds the app and this routes it. Without the listener the
      // tap lands on whatever screen was last open.
      const localNotifUnsub = await onLocalNotifAction((action) => {
        const route = action.notification.extra?.route
        if (typeof route === "string" && route.startsWith("/")) {
          routerRef.current.push(route)
        }
      })
      if (localNotifUnsub) addNativeCleanup(localNotifUnsub)

      // Subscribe to deeplink routes. OAuth callbacks resolve through their
      // own awaitCallback subscription; the router below handles session,
      // share-target, and pair-qr routes that arrive while the app is
      // foregrounded.
      const navigators = makeRouterNavigators(routerRef.current)

      // Subscribe once for the whole mobile session, including welcome/pair
      // screens. Pairing can complete without remounting this provider, so a
      // late permission grant must not depend on another boot or navigation.
      const unsubPush = await installPushNotificationBridge((delivery) => {
        const sessionId =
          typeof delivery.data?.sessionId === "string" ? delivery.data.sessionId : null
        if (sessionId && !delivery.foreground) {
          navigators.pushSession(sessionId)
        }
      })
      addNativeCleanup(unsubPush)
      if (cancelled) return

      const dispatchedRaw = new Set<string>()
      const deeplinkUnsub = await subscribeDeeplink((route) => {
        dispatchedRaw.add(route.raw)
        dispatchRoute(route, navigators)
      })
      addNativeCleanup(deeplinkUnsub)

      // Cold start: when the app is launched BY a deeplink (share sheet,
      // notification tap, pair QR), `appUrlOpen` can fire before the listener
      // above registers — the URL only survives in `App.getLaunchUrl()`.
      // Replay it once, deduped against anything the live listener already
      // handled. No-op on plain launches (getLaunchRoute resolves null).
      const launchRoute = await getLaunchRoute()
      if (launchRoute && !cancelled && !dispatchedRaw.has(launchRoute.raw)) {
        dispatchedRaw.add(launchRoute.raw)
        dispatchRoute(launchRoute, navigators)
      }

      // Android hardware back. Registering the listener disables the App
      // plugin's default (history back / exit at root), so re-implement it:
      // history back keeps `useBackDismiss` sheets and SPA routes working
      // exactly as before; at the root, minimize instead of exiting.
      // Must sit BEFORE the standalone/unpaired early-returns — the back
      // button has to work on /welcome and /pair too.
      const backUnsub = await subscribeBackButton(({ canGoBack }) => {
        if (canGoBack) {
          window.history.back()
        } else {
          void minimizeApp()
        }
      })
      addNativeCleanup(backUnsub)
      await restartMobileHostBindings()
    })()

    return () => {
      cancelled = true
      void stopHostBindings()
      for (const fn of nativeCleanup.splice(0)) dispose(fn)
    }
  }, [platform])

  return <>{children}</>
}
