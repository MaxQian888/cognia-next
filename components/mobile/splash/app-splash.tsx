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
 * Android 12+ plays the dedicated native vector mark while the WebView starts;
 * iOS uses its launch storyboard. Both hand off to the same `#01061e` backdrop.
 * Account and preference gates show MobileBootScreen first; this final overlay
 * then reports local pairing progress from CompanionBootProvider. It does not
 * require a second brand animation or a successful host connection to finish.
 *
 * Dismissal follows local readiness, without a minimum brand hold:
 *
 *   - once the local account, preferences and pairing have resolved, the
 *     interface can show its cached content while the host connects;
 *   - settled failures also release the interface, where the existing
 *     connection state explains recovery;
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

/** Hard ceiling — leaves regardless of what the stages report. */
export const MAX_HOLD_MS = 4500
/** Opacity fade-out duration; keep in sync with `.mboot--boot` transition. */
export const FADE_MS = 180

type Phase = "visible" | "leaving" | "done"

export function AppSplash() {
  const platform = usePlatform()
  const mobile = platform === "mobile"
  const boot = useSyncExternalStore(
    subscribeMobileBoot,
    getMobileBootSnapshot,
    getServerMobileBootSnapshot
  )

  const [maxElapsed, setMaxElapsed] = useState(false)
  const [gone, setGone] = useState(false)
  const [released, setReleased] = useState(false)

  // A reconnect must never cover an interface the user has already reached.
  const ready = boot.settled || boot.stages.companion.status === "done" || maxElapsed
  if (mobile && ready && !released) setReleased(true)
  const leaving = released
  const phase: Phase = gone ? "done" : leaving ? "leaving" : "visible"

  useEffect(() => {
    if (!mobile) return
    const maxTimer = setTimeout(() => setMaxElapsed(true), MAX_HOLD_MS)
    return () => {
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
