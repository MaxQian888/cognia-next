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
 *  - Tied to `--motion-duration-scale`, which animations multiply by their
 *    base duration (e.g. `transition-duration: calc(0.2s * var(--motion-duration-scale))`).
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
    cssVarValue: String(m.speed),
  }
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
