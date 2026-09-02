"use client"

/**
 * The rotation timer.
 *
 * Called from `BackgroundApplier`, which is already mounted once at the root
 * layout. Giving this its own initializer component would have added a second
 * mount point for the same subsystem and a second thing to forget to wire, and
 * this repo's most recurrent defect is a fully-built feature that was never
 * reachable at runtime.
 *
 * All of the deciding lives in `lib/appearance/wallpaper-rotation.ts`. What is
 * left here is the part that genuinely needs a component: a timer, a
 * visibility listener, and exactly one settings write per advance.
 */

import { useCallback, useEffect, useRef } from "react"

import { useSettingsStore } from "@/stores/settings"
import { withBuiltinPresets } from "@/lib/appearance/presets"
import {
  isAdvanceDue,
  msUntilNextAdvance,
  pickNextWallpaperId,
  resolveRotationPool,
} from "@/lib/appearance/wallpaper-rotation"
import { DEFAULT_WALLPAPER_ROTATION } from "@/types/appearance/wallpaper-rotation"

/**
 * Ceiling on a single `setTimeout`.
 *
 * `setTimeout` stores its delay in a signed 32-bit int, so anything past
 * ~24.8 days overflows and fires IMMEDIATELY. A 7-day rotation interval is
 * inside that, but the daily trigger schedules to local midnight and a machine
 * whose clock is wrong could compute far more. Capping and re-arming is the
 * standard fix and costs one extra wake-up per hour at worst.
 */
const MAX_TIMEOUT_MS = 60 * 60 * 1000

export function useWallpaperRotation(): void {
  const background = useSettingsStore((s) => s.background)
  const wallpapers = useSettingsStore((s) => s.wallpapers)
  const setBackground = useSettingsStore((s) => s.setBackground)

  // `launch` fires once per process, so the hook needs to know whether this is
  // the first evaluation. A ref rather than state: flipping it must not
  // re-render, and it must survive the effect re-running on every settings
  // change.
  const firstEvaluationRef = useRef(true)
  const timerRef = useRef<number | null>(null)

  const rotation = { ...DEFAULT_WALLPAPER_ROTATION, ...(background.rotation ?? {}) }
  const { enabled, trigger, intervalMs, pauseWhenHidden, order, playlist, lastAdvancedAt } =
    rotation
  const activeId = background.activeId
  const backgroundEnabled = background.enabled

  const advance = useCallback(async () => {
    const state = useSettingsStore.getState()
    const current = state.background
    const live = { ...DEFAULT_WALLPAPER_ROTATION, ...(current.rotation ?? {}) }
    if (!live.enabled || !current.enabled) return

    const gallery = withBuiltinPresets(state.wallpapers)
    const pool = resolveRotationPool(live.playlist, gallery)
    const next = pickNextWallpaperId({ pool, currentId: current.activeId, order: live.order })

    // Nothing to advance to. Still stamp the clock, otherwise a single-item
    // playlist re-evaluates on every tick forever.
    const stampedRotation = { ...live, lastAdvancedAt: Date.now() }
    await setBackground(
      next === null ? { rotation: stampedRotation } : { activeId: next, rotation: stampedRotation }
    )
  }, [setBackground])

  useEffect(() => {
    if (typeof window === "undefined") return
    if (!enabled || !backgroundEnabled) {
      firstEvaluationRef.current = true
      return
    }

    let disposed = false

    const clear = () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }

    const evaluate = () => {
      if (disposed) return
      clear()

      if (pauseWhenHidden && typeof document !== "undefined" && document.hidden) {
        // Do not re-arm. The visibility listener below wakes us instead, so a
        // backgrounded tab costs nothing at all rather than a timer per
        // interval that only discovers it should do nothing.
        return
      }

      const wasFirst = firstEvaluationRef.current
      firstEvaluationRef.current = false

      const live = {
        ...DEFAULT_WALLPAPER_ROTATION,
        ...(useSettingsStore.getState().background.rotation ?? {}),
      }

      if (isAdvanceDue({ rotation: live, now: Date.now(), isFirstEvaluation: wasFirst })) {
        void advance()
        // The settings write re-runs this effect with a fresh
        // `lastAdvancedAt`, which is what arms the next interval.
        return
      }

      if (live.trigger !== "launch" && live.lastAdvancedAt === undefined) {
        // Start the clock. Without this a freshly-enabled rotation has no
        // reference point and `msUntilNextAdvance` returns null forever.
        void setBackground({ rotation: { ...live, lastAdvancedAt: Date.now() } })
        return
      }

      const delay = msUntilNextAdvance(live, Date.now())
      if (delay === null) return
      timerRef.current = window.setTimeout(evaluate, Math.min(delay, MAX_TIMEOUT_MS))
    }

    evaluate()

    const onVisibility = () => {
      if (document.hidden) {
        if (pauseWhenHidden) clear()
        return
      }
      // Coming back into view re-evaluates immediately, so a tab hidden across
      // several intervals shows a fresh wallpaper the moment it is looked at
      // rather than sitting on a stale one until the next tick.
      evaluate()
    }

    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      disposed = true
      clear()
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [
    advance,
    setBackground,
    enabled,
    backgroundEnabled,
    trigger,
    intervalMs,
    pauseWhenHidden,
    order,
    playlist,
    lastAdvancedAt,
    activeId,
  ])
}
