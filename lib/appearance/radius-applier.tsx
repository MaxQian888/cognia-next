"use client"

import { useEffect } from "react"
import { useSettingsStore } from "@/stores/settings"
import { DEFAULT_RADIUS, type RadiusSettings } from "@/types/appearance"
import { resolveStylePack, type StylePackSettings } from "@/types/appearance/style-pack"

const DEFAULT_REM = DEFAULT_RADIUS.base

/**
 * Resolve the `--radius` value to write onto `<html>`. Returns null when the
 * resolved value matches the stylesheet default — in that case the applier
 * removes any prior inline write so the `:root` rule serves as the source of
 * truth (same pattern as `CustomThemeApplier`'s "default preset" branch).
 *
 * Two inputs feed one property, so their precedence has to be explicit
 * (ADR-0148): the active style pack supplies the base, and the user's radius
 * slider overrides it *only once it has been moved off the stylesheet default*.
 * Leaving the slider untouched therefore means "let the pack decide" rather
 * than "pin me to 0.625rem", which is what makes picking Sharp actually square
 * the UI. `packBaseRem` defaults to the stylesheet value, so every existing
 * caller keeps its previous behaviour byte-for-byte.
 *
 * `base` is clamped to 0..1.5 rem because shadcn's radius derivations
 * (`--radius-sm = base - 4px`, `--radius-xl = base + 4px`) start to look
 * broken outside that range. Pure — exported for tests.
 */
export function resolveRadiusVar(
  radius: RadiusSettings | undefined,
  packBaseRem: number = DEFAULT_REM
): string | null {
  const userBase = radius?.base
  const userMovedSlider =
    typeof userBase === "number" &&
    Number.isFinite(userBase) &&
    Math.abs(userBase - DEFAULT_REM) >= 1e-9
  const effective = userMovedSlider ? userBase : packBaseRem
  if (!Number.isFinite(effective)) return null
  const clamped = effective < 0 ? 0 : effective > 1.5 ? 1.5 : effective
  if (Math.abs(clamped - DEFAULT_REM) < 1e-9) return null
  return `${clamped}rem`
}

/** The style-pack base this applier should use when the slider is untouched. */
export function stylePackRadiusBase(stylePack: StylePackSettings | undefined): number {
  return resolveStylePack(stylePack).radiusBaseRem
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
  const stylePack = useSettingsStore((s) => s.settings?.stylePack)

  useEffect(() => {
    if (typeof document === "undefined") return
    const root = document.documentElement
    const value = resolveRadiusVar(radius, stylePackRadiusBase(stylePack))
    if (value === null) {
      root.style.removeProperty("--radius")
      return
    }
    root.style.setProperty("--radius", value)
    return () => {
      root.style.removeProperty("--radius")
    }
  }, [radius, stylePack])

  return null
}
