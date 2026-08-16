"use client"

import { useEffect, useState, useSyncExternalStore } from "react"

import { MobileBootScreen, MOBILE_SPLASH_BACKDROP } from "@/components/mobile/splash/mobile-boot-screen"
import { usePlatform } from "@/hooks/use-platform"
import {
  getMobileBootSnapshot,
  getServerMobileBootSnapshot,
  setMobileBootOverlayVisible,
  subscribeMobileBoot,
} from "@/lib/boot/mobile-boot-stages"
import { syncWithTheme as syncNavBar } from "@/lib/capacitor/navigation-bar"
import { syncWithTheme as syncStatusBar } from "@/lib/capacitor/status-bar"

/**
 * Mobile boot splash overlay.
 *
 * The Android 12 system splash (`windowSplashScreenAnimatedIcon`) and the iOS
 * launch storyboard can only show a *static* raster of the brand mark on a
 * flat colour. This overlay takes over the instant the native splash hands
 * off — both paint the same `#01061e`, so the seam is invisible — and renders
 * `MobileBootScreen`: the branded motion the native surface can't, plus the
 * live timeline of what the phone is doing (native bridge, pairing, host
 * link, first sync — reported into `lib/boot/mobile-boot-stages` by
 * `CompanionBootProvider`).
 *
 * Dismissal is signal-driven with two guard rails:
 *
 *   - it holds for at least `MIN_HOLD_MS`, so a fast boot still gets a
 *     legible brand moment instead of a flash;
 *   - it leaves as soon as the boot has **settled** (the host is linked, or
 *     is not going to be, or there is none to link — see the store), so the
 *     user waits for what matters and not for a stopwatch;
 *   - it never waits past `MAX_HOLD_MS`. A stage that fails to report — the
 *     native bridge missing, a provider that threw — cannot strand anyone on
 *     a splash: the ceiling fires and the app underneath is theirs, with the
 *     connection badge carrying the rest of the story.
 *
 * While it is up, the status / navigation bars are painted to match its
 * canvas (light glyphs on navy) as soon as the native bridge is registered,
 * and `CompanionBootProvider`'s theme sync stands aside (`overlayVisible`);
 * the moment the overlay starts leaving, that flag drops and the bars go back
 * to the app theme, so the chrome never lags behind the canvas under it.
 *
 * Mobile-only: `usePlatform()` returns `"web"` during SSR / static export and
 * in the browser + Tauri shells, where this renders `null`.
 */

/** Visible before the earliest possible fade-out. */
export const MIN_HOLD_MS = 1200
/** Hard ceiling — leaves regardless of what the stages report. */
export const MAX_HOLD_MS = 4500
/** Opacity fade-out duration; keep in sync with `.mboot--boot` transition. */
export const FADE_MS = 450

type Phase = "visible" | "leaving" | "done"

export function AppSplash() {
  const platform = usePlatform()
  const mobile = platform === "mobile"
  const boot = useSyncExternalStore(
    subscribeMobileBoot,
    getMobileBootSnapshot,
    getServerMobileBootSnapshot
  )

  const [minElapsed, setMinElapsed] = useState(false)
  const [maxElapsed, setMaxElapsed] = useState(false)
  const [gone, setGone] = useState(false)

  // Derived, not stored: the overlay may leave once the floor has passed and
  // either the boot has settled or the ceiling has passed.
  const leaving = minElapsed && (boot.settled || maxElapsed)
  const phase: Phase = gone ? "done" : leaving ? "leaving" : "visible"

  useEffect(() => {
    if (!mobile) return
    const minTimer = setTimeout(() => setMinElapsed(true), MIN_HOLD_MS)
    const maxTimer = setTimeout(() => setMaxElapsed(true), MAX_HOLD_MS)
    return () => {
      clearTimeout(minTimer)
      clearTimeout(maxTimer)
    }
  }, [mobile])

  useEffect(() => {
    if (!mobile || !leaving) return
    const doneTimer = setTimeout(() => setGone(true), FADE_MS)
    return () => clearTimeout(doneTimer)
  }, [mobile, leaving])

  // Tell the world the overlay is up — and drop the flag the moment it starts
  // leaving (not when it is gone), so the theme sync repaints the bars behind
  // the fade rather than after it.
  const covering = mobile && phase === "visible"
  useEffect(() => {
    if (!covering) return
    setMobileBootOverlayVisible(true)
    return () => setMobileBootOverlayVisible(false)
  }, [covering])

  // Chrome to match the canvas: light glyphs, navy background (Android; iOS
  // ignores the colour and the bar is transparent over the canvas anyway).
  // Only once the native bridge is registered — before that the plugin
  // proxies do not exist and the wrappers would silently no-op.
  const bridgeReady = boot.stages.bridge.status === "done"
  useEffect(() => {
    if (!covering || !bridgeReady) return
    void syncStatusBar("dark", MOBILE_SPLASH_BACKDROP)
    void syncNavBar("dark", MOBILE_SPLASH_BACKDROP)
  }, [covering, bridgeReady])

  if (!mobile || phase === "done") return null

  return <MobileBootScreen milestone={null} leaving={phase === "leaving"} />
}
