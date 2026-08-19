"use client"

import { useEffect, useRef } from "react"
import { useLocale } from "next-intl"
import { usePathname } from "next/navigation"

import { resolveObservabilityRuntime } from "@/lib/logging/observability-runtime"
import { isTauri } from "@/lib/platform/detect"
import { trackAppLaunched, trackScreenViewed } from "@/lib/telemetry/app-session"

/**
 * App-session behavior telemetry (ADR-0074).
 *
 * Every other event in the catalog describes what a session *did*; nothing
 * described that a session happened at all, so an operator could not compute
 * active users, retention or version adoption from the data the app shipped.
 * This emits the two events that floor: one launch per app session, and a
 * screen view per top-level route.
 *
 * Consent is not checked here — `trackEvent` fails closed on the master switch,
 * the `app` category, and the PII gate, so mounting this unconditionally is
 * exactly as opt-in as every other call site. It sits under `LoggerProvider`
 * because `bootstrapLogger()` is what configures the exporters.
 */
export function TelemetrySessionInitializer() {
  const locale = useLocale()
  const pathname = usePathname()
  const launched = useRef(false)

  useEffect(() => {
    // React 19 StrictMode double-invokes effects in development; the launch
    // event is per app session, not per mount.
    if (launched.current) return
    launched.current = true
    void trackAppLaunched({
      runtime: resolveObservabilityRuntime({
        isTauri: isTauri(),
        platformHint: process.env.NEXT_PUBLIC_PLATFORM,
        userAgent: typeof navigator === "undefined" ? "" : navigator.userAgent,
      }),
      appVersion: process.env.NEXT_PUBLIC_APP_VERSION || "0.1.0",
      locale,
      storage: typeof localStorage === "undefined" ? undefined : localStorage,
    })
  }, [locale])

  useEffect(() => {
    void trackScreenViewed(pathname)
  }, [pathname])

  return null
}

export default TelemetrySessionInitializer
