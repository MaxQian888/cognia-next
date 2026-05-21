"use client"

import { useEffect } from "react"
import { useSettingsStore } from "@/stores/settings"
import { DEFAULT_RADIUS, type RadiusSettings } from "@/types/appearance"

const DEFAULT_REM = DEFAULT_RADIUS.base

/**
 * Resolve the `--radius` value to write onto `<html>`. Returns null when the
 * resolved value matches the default — in that case the applier removes any
 * prior inline write so the `:root` stylesheet rule serves as the source of
 * truth (same pattern as `CustomThemeApplier`'s "default preset" branch).
 *
 * `base` is clamped to 0..1.5 rem because shadcn's radius derivations
 * (`--radius-sm = base - 4px`, `--radius-xl = base + 4px`) start to look
 * broken outside that range. Pure — exported for tests.
 */
export function resolveRadiusVar(radius: RadiusSettings | undefined): string | null {
  const base = radius?.base ?? DEFAULT_REM
  if (!Number.isFinite(base)) return null
  const clamped = base < 0 ? 0 : base > 1.5 ? 1.5 : base
  if (Math.abs(clamped - DEFAULT_REM) < 1e-9) return null
  return `${clamped}rem`
}

/**
 * Mounts at the root layout. Writes `--radius` onto `<html>` when the user
 * has customized it; otherwise leaves the stylesheet default in place.
 *
 * shadcn components read `--radius` (and its derived `--radius-sm/md/lg/xl`
 * tokens via the `@theme inline` block in globals.css), so a single
 * setProperty cascades to every Card / Button / Input / etc.
 */
export function RadiusApplier(): null {
  const radius = useSettingsStore((s) => s.settings?.radius)

  useEffect(() => {
    if (typeof document === "undefined") return
    const root = document.documentElement
    const value = resolveRadiusVar(radius)
    if (value === null) {
      root.style.removeProperty("--radius")
      return
    }
    root.style.setProperty("--radius", value)
    return () => {
      root.style.removeProperty("--radius")
    }
  }, [radius])

  return null
}
