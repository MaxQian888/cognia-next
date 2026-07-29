"use client"

import { useEffect } from "react"
import { useSettingsStore } from "@/stores/settings"
import { DEFAULT_MOTION, type MotionSettings } from "@/types/appearance"

/**
 * Resolve the motion DOM state. Returns the `--motion-duration-scale`
 * variable plus whether the `reduce-motion` class should be present on
 * `<html>`. Pure — exported for tests.
 *
 * `reduce` semantics:
 *  - Explicit user opt-in always wins (`reduce: true` → class on).
 *  - Otherwise the `prefers-reduced-motion` CSS @media in globals.css handles
 *    the OS hint; the applier does not need to mirror it into the class.
 *
 * Speed:
 *  - `MotionSettings.speed` is a *speed* multiplier, the way the settings UI
 *    labels it ("Fast (1.5×)"). `--motion-duration-scale` is a *duration*
 *    multiplier: consumers write `calc(0.2s * var(--motion-duration-scale))`.
 *    The two are reciprocals — 1.5× speed must yield a 0.667× duration.
 *    Writing `speed` straight into the var inverted the whole setting (picking
 *    "Fast" made every animation 50% slower), so the reciprocal is taken here,
 *    at the single writer, and every CSS `calc()` consumer stays untouched.
 *  - Rounded to 3 decimals: 1/1.5 is non-terminating and the raw float would
 *    land in the inline `style` attribute of every page.
 *  - `speed` is clamped before dividing. It arrives from persisted settings, so
 *    a corrupt 0 would otherwise produce `Infinity` and silently invalidate
 *    every `calc()` that reads the var.
 *  - When the user has enabled `reduce`, speed becomes meaningless — we still
 *    write the var so a future toggle-off reverts cleanly.
 */
export function resolveMotionState(motion: MotionSettings | undefined): {
  reduceClass: boolean
  cssVarValue: string
} {
  const m = { ...DEFAULT_MOTION, ...(motion ?? {}) }
  return {
    reduceClass: m.reduce === true,
    cssVarValue: String(speedToDurationScale(m.speed)),
  }
}

/** Smallest / largest speed multiplier accepted from persisted settings. */
const MIN_SPEED = 0.25
const MAX_SPEED = 4

/**
 * Convert a user-facing *speed* multiplier into the *duration* multiplier that
 * `--motion-duration-scale` and every JS `transition` consumer expect. Exported
 * so the JS-side motion primitives derive their scale from the same function
 * rather than re-deriving (and re-inverting) it.
 */
export function speedToDurationScale(speed: number | undefined): number {
  const safe = Number.isFinite(speed)
    ? Math.min(Math.max(speed as number, MIN_SPEED), MAX_SPEED)
    : 1
  return Number((1 / safe).toFixed(3))
}

/**
 * Mounts at the root layout. Reflects motion preferences onto `<html>`:
 *   - `--motion-duration-scale` var (used by app-owned animations)
 *   - `reduce-motion` class (read by the global CSS reset in globals.css)
 *
 * Backward-compat: respects the legacy `settings.reduceMotion` boolean when
 * the new `settings.motion.reduce` is not yet set. New a11y tab writes the
 * canonical `motion.reduce`; legacy typography-tab toggle still writes
 * `reduceMotion` for now.
 */
export function MotionApplier(): null {
  const motion = useSettingsStore((s) => s.settings?.motion)
  const legacyReduceMotion = useSettingsStore((s) => s.settings?.reduceMotion)

  useEffect(() => {
    if (typeof document === "undefined") return
    const root = document.documentElement
    const merged: MotionSettings = {
      ...DEFAULT_MOTION,
      ...(motion ?? {}),
      // Legacy field acts as a baseline; explicit `motion.reduce` wins.
      reduce: motion?.reduce ?? legacyReduceMotion ?? false,
    }
    const { reduceClass, cssVarValue } = resolveMotionState(merged)
    root.style.setProperty("--motion-duration-scale", cssVarValue)
    if (reduceClass) {
      root.classList.add("reduce-motion")
    } else {
      root.classList.remove("reduce-motion")
    }
    return () => {
      root.style.removeProperty("--motion-duration-scale")
      root.classList.remove("reduce-motion")
    }
  }, [motion, legacyReduceMotion])

  return null
}
