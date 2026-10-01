"use client"

// Runtime driver for automatic light/dark switching. Mounted once via
// `AutoModeInitializer`. When `autoMode.enabled`, it re-evaluates the desired
// phase (see `resolveAutoPhase`) on a 1-minute tick and whenever the OS
// `prefers-color-scheme` flips, writing the result through next-themes
// (`setTheme`, the live `dark`-class driver) and persisting it.
//
// Manual overrides win: if the live theme ever diverges from what the runner
// last applied, the user changed it by hand, so we record `lastManualAt` and
// suppress auto switches for `snoozeMs` (default 30 min).
//
// The `wallpaper` trigger also re-evaluates when the active wallpaper changes
// (a pick, a rotation advance) and when its analysis lands in the cache — the
// legibility guard measures a new image a frame or two after it is painted.

import { useEffect, useRef } from "react"
import { useTheme } from "next-themes"
import { useSettingsStore } from "@/stores/settings"
import type { BackgroundSettings, Wallpaper } from "@/types/appearance"
import { isWithinSnooze, resolveAutoPhase, type AutoPhase } from "./auto-mode"
import { findActiveWallpaper } from "./presets"
import { readCachedAnalysisFor, subscribeAnalysisCache } from "./wallpaper-analysis-cache"
import { extremesOf, recommendThemeVariant } from "./wallpaper-legibility"

const TICK_MS = 60_000

function systemPrefersDark(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  )
}

/**
 * The variant the active wallpaper suits, or null when none is painted or it
 * has not been measured yet (the resolver then follows the system).
 */
export function wallpaperPhase(
  background: BackgroundSettings,
  wallpapers: Wallpaper[] | undefined
): AutoPhase | null {
  const analysis = readCachedAnalysisFor(findActiveWallpaper(background, wallpapers))
  if (!analysis) return null
  return recommendThemeVariant({ extremes: extremesOf(analysis), blurPx: background.blurPx })
    .recommended
}

export function useAutoMode(): void {
  const enabled = useSettingsStore((s) => s.autoMode.enabled)
  const trigger = useSettingsStore((s) => s.autoMode.trigger)
  // Which wallpaper is up. Only the `wallpaper` trigger reads it, but a new
  // pick must re-evaluate right away rather than on the next minute tick.
  const followsWallpaper = trigger === "wallpaper"
  const wallpaperKey = useSettingsStore((s) =>
    followsWallpaper && s.background.enabled ? (s.background.activeId ?? "") : ""
  )
  const { setTheme } = useTheme()
  // The phase the runner last wrote; `null` means "not currently driving".
  const appliedRef = useRef<AutoPhase | null>(null)

  useEffect(() => {
    if (!enabled) {
      appliedRef.current = null
      return
    }

    const evaluate = () => {
      const state = useSettingsStore.getState()
      const am = state.autoMode
      if (!am.enabled) return

      // Manual override: the live theme no longer matches our last write.
      if (appliedRef.current && state.theme !== appliedRef.current) {
        appliedRef.current = null
        void state.save({ autoMode: { ...am, lastManualAt: Date.now() } })
        return
      }

      if (isWithinSnooze(am, Date.now())) return

      const desired = resolveAutoPhase(am, {
        now: new Date(),
        systemPrefersDark: systemPrefersDark(),
        wallpaperPhase:
          am.trigger === "wallpaper" ? wallpaperPhase(state.background, state.wallpapers) : null,
      })
      appliedRef.current = desired
      if (state.theme === desired) return
      setTheme(desired)
      void state.save({ theme: desired })
    }

    evaluate()
    const interval = window.setInterval(evaluate, TICK_MS)

    let mql: MediaQueryList | null = null
    if (typeof window.matchMedia === "function") {
      mql = window.matchMedia("(prefers-color-scheme: dark)")
      mql.addEventListener?.("change", evaluate)
    }
    const unsubscribeAnalysis = followsWallpaper ? subscribeAnalysisCache(evaluate) : null

    return () => {
      window.clearInterval(interval)
      mql?.removeEventListener?.("change", evaluate)
      unsubscribeAnalysis?.()
    }
    // Schedule / location edits are picked up by the next tick via getState();
    // only enable/trigger — and, when following it, the wallpaper — re-arm it.
  }, [enabled, trigger, followsWallpaper, wallpaperKey, setTheme])
}
