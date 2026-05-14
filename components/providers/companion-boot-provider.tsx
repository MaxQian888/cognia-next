"use client"

import { usePathname, useRouter } from "next/navigation"
import { useEffect, useRef } from "react"
import { useTranslations } from "next-intl"
import { useTheme } from "next-themes"
import { toast } from "sonner"

import { usePlatform } from "@/hooks/use-platform"
import { subscribe as subscribeDeeplink } from "@/lib/capacitor/deeplink"
import { dispatchRoute, makeRouterNavigators } from "@/lib/capacitor/deeplink-router"
import { hide as hideSplash } from "@/lib/capacitor/splash-screen"
import { syncWithTheme as syncStatusBar } from "@/lib/capacitor/status-bar"
import { syncWithTheme as syncNavBar } from "@/lib/capacitor/navigation-bar"
import { ensureChannel as ensureNotifChannel } from "@/lib/capacitor/local-notifications"
import {
  registerPushNotifications,
  reportPushTokenToDesktop,
  subscribeToPushNotifications,
} from "@/lib/push/push-notifications"
import {
  installEventDrivenSync,
  installForegroundSync,
  runSyncDown,
} from "@/lib/sync/companion-sync"
import { hydrateCompanionConfig } from "@/lib/tauri/transport-companion"
import { loggers } from "@/lib/logger"

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

  // Status bar + Android nav bar track the resolved theme on every change.
  // Decoupled from the boot effect because theme can flip after boot
  // (system preference change, manual toggle). The nav-bar wrapper is a
  // no-op on iOS and on devices without the @capgo plugin installed.
  useEffect(() => {
    if (platform !== "mobile") return
    void syncStatusBar(resolvedTheme)
    void syncNavBar(resolvedTheme)
  }, [platform, resolvedTheme])

  useEffect(() => {
    if (platform !== "mobile") return
    if (ranRef.current) return
    ranRef.current = true

    let cancelled = false
    const cleanup: Array<() => void | Promise<void>> = []

    void (async () => {
      // Hide native splash now that React has painted. Best-effort — if the
      // plugin is missing this is a no-op.
      void hideSplash(300)
      // Ensure the LocalNotifications channel exists so offline-queue
      // backstops (Wave 3) can fire later without permission prompt churn.
      void ensureNotifChannel({
        id: "cognia-default",
        name: "cognia",
        description: "Pairing, sync, and offline-queue notifications",
        importance: 4,
      })

      // Subscribe to deeplink routes. OAuth callbacks resolve through their
      // own awaitCallback subscription; the router below handles session,
      // share-target, and pair-qr routes that arrive while the app is
      // foregrounded.
      const navigators = makeRouterNavigators(router)
      const deeplinkUnsub = await subscribeDeeplink((route) => {
        dispatchRoute(route, navigators)
      })
      cleanup.push(deeplinkUnsub)

      const config = await hydrateCompanionConfig()
      if (cancelled) return

      const onPair = pathname === "/pair"
      if (!config) {
        if (!onPair) {
          log.info("companion: no config, redirecting to /pair")
          router.replace("/pair")
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
      cleanup.push(installForegroundSync())
      cleanup.push(installEventDrivenSync())

      // ── Push notifications ────────────────────────────────────────────
      const push = await registerPushNotifications()
      if (cancelled) return
      if (push.kind === "registered") {
        const sent = await reportPushTokenToDesktop(push.token, push.platform)
        if (!sent.ok) {
          log.warn("companion: failed to report push token", { reason: sent.reason })
          toast.error(t("pushTokenFailed", { reason: sent.reason }))
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
      cleanup.push(unsubPush)
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
  }, [platform, pathname, router, t])

  return <>{children}</>
}
