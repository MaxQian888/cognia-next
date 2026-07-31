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

import { useEffect, useRef } from "react"
import { useTheme } from "next-themes"
import { useSettingsStore } from "@/stores/settings"
import { isWithinSnooze, resolveAutoPhase, type AutoPhase } from "./auto-mode"

const TICK_MS = 60_000

function systemPrefersDark(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  )
}

export function useAutoMode(): void {
  const enabled = useSettingsStore((s) => s.autoMode.enabled)
  const trigger = useSettingsStore((s) => s.autoMode.trigger)
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

    return () => {
      window.clearInterval(interval)
      mql?.removeEventListener?.("change", evaluate)
    }
    // Schedule / location edits are picked up by the next tick via getState();
    // only enable/trigger need to re-arm the effect.
  }, [enabled, trigger, setTheme])
}
