"use client"

import dynamic from "next/dynamic"
import { useEffect, useSyncExternalStore } from "react"

import { isMobile } from "@/lib/capacitor/_shared"
import { registerNativePlugins } from "@/lib/capacitor/register-plugins"
import { hide } from "@/lib/capacitor/splash-screen"
import { startCameraRecovery } from "@/lib/capacitor/camera-recovery"

/**
 * Mounted above AccountGate: a loading, locked, recovery or onboarding screen
 * is already content the native launch screen can hand over to. Registration
 * is idempotent; CompanionBootProvider retains its own registration and hide
 * as a fallback if this early attempt cannot reach the native bridge.
 */
export function MobileNativeSplashInitializer() {
  const isClient = useIsClient()
  useEffect(() => {
    if (!isMobile()) return
    let cancelled = false
    void registerNativePlugins().then((result) => {
      if (!cancelled && result.kind === "registered") {
        void startCameraRecovery().catch(() => undefined)
        void hide(180)
      }
    })
    return () => {
      cancelled = true
    }
  }, [])
  return isClient && isMobile() ? <BarcodeScannerOverlay /> : null
}

/**
 * Client-mount probe via `useSyncExternalStore` (not `useState` + effect, which
 * the repo's `react-hooks/set-state-in-effect` lint forbids). Server snapshot
 * `false`, client snapshot `true`, so the first client render matches the
 * prerendered server output (`null`) before flipping post-hydration.
 */
const emptySubscribe = () => () => {}

function useIsClient(): boolean {
  return useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false
  )
}

/**
 * Capacitor-only boot surfaces, consolidated behind a single runtime mobile
 * gate.
 *
 * `AppSplash` is mobile-only (it renders `null` off the Capacitor shell), so
 * statically importing it into the root layout pulled its splash animation
 * graph into the eager graph the dev server compiles for every page. Here it
 * is a `next/dynamic(ssr: false)` import rendered only when `isMobile()` is
 * true, so the browser / Tauri dev server never fetches — and so never
 * compiles — its chunk. `next build` still emits the chunk into `out/`, so the
 * `NEXT_PUBLIC_PLATFORM=mobile` Capacitor build loads it at runtime as before.
 *
 * The mounted guard keeps the first client render equal to the server (both
 * `null`) so the shared static-export bundle hydrates cleanly on every shell.
 */
const AppSplash = dynamic(
  () => import("@/components/mobile/splash/app-splash").then((m) => m.AppSplash),
  { ssr: false }
)

const BarcodeScannerOverlay = dynamic(
  () => import("@/components/mobile/barcode-scanner-overlay").then((m) => m.BarcodeScannerOverlay),
  { ssr: false }
)

// Opt-in automatic crash-report submission (ADR-0102): the phone has a
// submission path through the crash plugin, so the switch works here too.
const DiagnosticAutoSubmitInitializer = dynamic(
  () =>
    import("./diagnostic-auto-submit-initializer").then((m) => m.DiagnosticAutoSubmitInitializer),
  { ssr: false }
)

export function MobileOnlyInitializers() {
  const isClient = useIsClient()
  if (!isClient || !isMobile()) return null

  return (
    <>
      <AppSplash />
      <DiagnosticAutoSubmitInitializer />
    </>
  )
}

export default MobileOnlyInitializers
