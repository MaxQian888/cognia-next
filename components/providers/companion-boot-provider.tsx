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
} from "@/lib/capacitor/local-notifications"
import {
  registerPushNotifications,
  reportPushTokenToDesktop,
  subscribeToPushNotifications,
} from "@/lib/push/push-notifications"
import {
  installEventDrivenSync,
  installForegroundSync,
  installNetworkSync,
  installResumeSync,
  runSyncDown,
} from "@/lib/sync/companion-sync"
import { hydrateCompanionConfig } from "@/lib/tauri/transport-companion"
import { transport } from "@/lib/tauri/transport-instance"
import {
  installCapabilityReporter,
  type CapabilityReporterTransport,
} from "@/lib/companion/capability-reporter"
import { installRemoteStepServer } from "@/lib/companion/remote-step-server"
import { loadCompanionConfig } from "@/lib/tauri/transport-companion"
import { getSettings } from "@/lib/db/settings"
import { loggers } from "@cognia/logging"

// Onboarding routes where the boot provider must NOT redirect (the chooser /
// pair / oauth flows own navigation there).
const ONBOARDING_PREFIXES = ["/welcome", "/pair", "/oauth"]

const log = loggers.shell

/**
 * Capacitor-only boot orchestrator (M3.4 hydrate + M4.6 push + M4.7 sync).
 *
 * On the phone's first paint (and again whenever pairing flips on/off):
 *   1. Hydrate the companion config from SecureStorage.
 *   2. If unpaired and the user isn't already on `/pair`, redirect.
 *   3. If paired:
 *        a. Run an immediate sync-down so the chat list is warm.
 *        b. Install the foreground listener (re-sync on visibilitychange).
 *        c. Subscribe to the desktop's `sync://invalidate` channel so
 *           Dexie deltas fall through automatically.
 *        d. Register for APNs/FCM, ship the device token to the desktop.
 *        e. Subscribe to inbound push deliveries — a foreground push
 *           surfaces as a toast; a tap (background) routes the user to
 *           the relevant session via the `sessionId` payload field.
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
  const ranRef = useRef(false)
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

  const appearanceColorTheme = useSettingsStore((s) => s.colorTheme)
  const appearanceActiveCustomThemeId = useSettingsStore((s) => s.activeCustomThemeId)
  const appearanceCustomThemes = useSettingsStore((s) => s.customThemes)

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
  ])

  useEffect(() => {
    if (platform !== "mobile") return
    if (ranRef.current) return
    ranRef.current = true

    let cancelled = false
    const cleanup: Array<() => void | Promise<void>> = []
    // Boot is async: if the effect tears down while a `await subscribe…` is
    // still in flight, the cleanup loop below has already run. Registering
    // through this helper disposes such late arrivals immediately instead of
    // leaking the listener.
    const addCleanup = (fn: () => void | Promise<void>) => {
      if (cancelled) {
        try {
          void fn()
        } catch {
          /* best-effort */
        }
      } else {
        cleanup.push(fn)
      }
    }

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
      if (localNotifUnsub) addCleanup(localNotifUnsub)

      // Subscribe to deeplink routes. OAuth callbacks resolve through their
      // own awaitCallback subscription; the router below handles session,
      // share-target, and pair-qr routes that arrive while the app is
      // foregrounded.
      const navigators = makeRouterNavigators(routerRef.current)
      const dispatchedRaw = new Set<string>()
      const deeplinkUnsub = await subscribeDeeplink((route) => {
        dispatchedRaw.add(route.raw)
        dispatchRoute(route, navigators)
      })
      addCleanup(deeplinkUnsub)

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
      addCleanup(backUnsub)

      const config = await hydrateCompanionConfig()
      if (cancelled) return

      // Runtime mode is read from the authoritative Dexie settings (race-free at
      // boot, unlike the in-memory store which may not be hydrated yet).
      const mode = (await getSettings().catch(() => null))?.mobileRuntimeMode
      if (cancelled) return

      // Standalone (BYOK) mode: no paired desktop — skip companion sync/push
      // entirely. The chat/search/doc paths run in-webview against the user's
      // own keys; a leftover config (paired-then-switched) is intentionally idle.
      if (mode === "standalone") return

      if (!config) {
        const onOnboarding = ONBOARDING_PREFIXES.some((p) => pathnameRef.current.startsWith(p))
        if (!onOnboarding) {
          // Chosen pairing but not paired yet → pair flow; mode not chosen yet
          // (and no legacy config) → the welcome chooser. Already-paired users
          // never reach here because `config` is present (backward compatible).
          const target = mode === "paired" ? "/pair" : "/welcome"
          log.info(`companion: unpaired, redirecting to ${target}`)
          routerRef.current.replace(target)
        }
        return
      }

      // ── Sync ──────────────────────────────────────────────────────────
      try {
        await runSyncDown()
      } catch (err) {
        log.warn("companion: initial sync-down failed", {
          error: err instanceof Error ? err.message : String(err),
        })
      }
      addCleanup(installForegroundSync())
      addCleanup(installEventDrivenSync())
      // Wave 4 / ADR-0026 — also kick a sync on network up and app resume.
      // `installNetworkSync` and `installResumeSync` both return promises
      // that resolve to the teardown function; await before pushing so the
      // cleanup array has a real `() => void`, matching the existing
      // `installForegroundSync` / `installEventDrivenSync` shape.
      addCleanup(await installNetworkSync())
      addCleanup(await installResumeSync())

      // ── Capability report (ADR-0060) ──────────────────────────────────
      // Report this device's platform capability manifest on each connect so
      // the desktop's capability-aware workflow surfaces know what this
      // phone can run. Duck-typed: only the CompanionTransport exposes the
      // connection-state surface (the CLI's stdio transport does not).
      const reporterTransport = transport as Partial<CapabilityReporterTransport>
      if (
        typeof reporterTransport.call === "function" &&
        typeof reporterTransport.getConnectionState === "function" &&
        typeof reporterTransport.onConnectionStateChange === "function"
      ) {
        addCleanup(installCapabilityReporter(reporterTransport as CapabilityReporterTransport))
      }

      // ── Remote step server (ADR-0061 P3) ─────────────────────────────
      // Serve desktop-issued `workflow://step-execute` requests (camera,
      // barcode, location, …) addressed to this device. Foreground-only by
      // nature — the WS subscription lives with the app session.
      addCleanup(
        installRemoteStepServer({
          transport,
          getDeviceId: () => loadCompanionConfig()?.deviceId,
        })
      )

      // ── Push notifications ────────────────────────────────────────────
      const push = await registerPushNotifications()
      if (cancelled) return
      if (push.kind === "registered") {
        const sent = await reportPushTokenToDesktop(push.token, push.platform)
        if (!sent.ok) {
          log.warn("companion: failed to report push token", { reason: sent.reason })
          toast.error(tRef.current("pushTokenFailed", { reason: sent.reason }))
        } else {
          log.info("companion: push token reported", { platform: push.platform })
        }
      } else {
        log.info("companion: push registration outcome", { kind: push.kind })
      }

      const unsubPush = await subscribeToPushNotifications((delivery) => {
        if (delivery.foreground) {
          toast(delivery.title ?? "New notification", {
            description: delivery.body,
          })
        }
        const payload = delivery.data
        const sessionId =
          typeof payload?.sessionId === "string" ? (payload.sessionId as string) : null
        if (sessionId && !delivery.foreground) {
          // Tap-from-background → deep-link to the session via the same
          // router the deeplink subscriber uses.
          navigators.pushSession(sessionId)
        }
      })
      addCleanup(unsubPush)
    })()

    return () => {
      cancelled = true
      for (const fn of cleanup) {
        try {
          const result = fn()
          if (result && typeof (result as Promise<void>).then === "function") {
            void (result as Promise<void>).catch(() => {
              /* best-effort */
            })
          }
        } catch {
          /* best-effort */
        }
      }
    }
  }, [platform])

  return <>{children}</>
}
