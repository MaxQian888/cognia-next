"use client"

import { usePathname, useRouter } from "next/navigation"
import { useEffect, useRef } from "react"

import { usePlatform } from "@/hooks/use-platform"
import { hasWebCompanionTarget } from "@/lib/platform/web-companion"
import {
  installEventDrivenSync,
  installForegroundSync,
  runSyncDown,
} from "@/lib/sync/companion-sync"
import { hydrateCompanionConfig } from "@/lib/tauri/transport-companion"
import { loggers } from "@/lib/logging"

const log = loggers.shell

// The pair flow owns navigation on these routes — never redirect from them.
const ONBOARDING_PREFIXES = ["/welcome", "/pair", "/oauth"]

/**
 * Cloud-companion boot for the PLAIN BROWSER (ADR-0059 C1).
 *
 * The web build becomes a thin client of a cognia-server when
 * `hasWebCompanionTarget()` is true (build-time server URL or an existing
 * pairing). This is the browser sibling of `CompanionBootProvider` minus
 * everything Capacitor: no native plugins, no push, no deeplinks, no status
 * bar — just config hydration, the unpaired→/pair redirect, and the sync
 * installers (which are webview-agnostic).
 *
 * No-op on Tauri (the desktop IS the server) and on Capacitor (the mobile
 * provider owns boot there). Also a no-op on web-standalone — a browser with
 * no server target keeps the BYOK stub behavior.
 */
export function WebCompanionBootProvider({ children }: { children: React.ReactNode }) {
  const platform = usePlatform()
  const router = useRouter()
  const pathname = usePathname()
  const ranRef = useRef(false)

  useEffect(() => {
    if (platform !== "web") return
    if (!hasWebCompanionTarget()) return
    if (ranRef.current) return
    ranRef.current = true

    let cancelled = false
    const cleanup: Array<() => void> = []

    void (async () => {
      const config = await hydrateCompanionConfig()
      if (cancelled) return

      if (!config) {
        const onOnboarding = ONBOARDING_PREFIXES.some((p) => pathname.startsWith(p))
        if (!onOnboarding) {
          log.info("web companion: server configured but unpaired — redirecting to /pair")
          router.replace("/pair")
        }
        return
      }

      try {
        await runSyncDown()
      } catch (err) {
        log.warn("web companion: initial sync-down failed", {
          error: err instanceof Error ? err.message : String(err),
        })
      }
      if (cancelled) return
      cleanup.push(installForegroundSync())
      cleanup.push(installEventDrivenSync())
    })()

    return () => {
      cancelled = true
      for (const dispose of cleanup) {
        try {
          dispose()
        } catch {
          // teardown is best-effort
        }
      }
    }
  }, [platform, router, pathname])

  return <>{children}</>
}
