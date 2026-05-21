"use client"

import { useEffect } from "react"
import { useSettingsStore } from "@/stores/settings"
import { DEFAULT_TYPOGRAPHY_EXT, type TypographyExtSettings } from "@/types/appearance"
import { applyCssVars, removeCssVars } from "./css-var"

/** CSS variables this applier owns. Listed for cleanup. */
const VAR_KEYS = [
  "--font-sans",
  "--font-mono",
  "--font-serif",
  "--line-height-scale",
  "--letter-spacing-em",
] as const

const FALLBACK_SANS =
  "var(--font-geist-sans), system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
const FALLBACK_MONO =
  "var(--font-geist-mono), ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace"
const FALLBACK_SERIF = "ui-serif, Georgia, 'Times New Roman', serif"

/**
 * Resolve the typography vars to write onto `<html>`. Pure — exported for tests.
 *
 * Wraps each font family name with a generic fallback chain so we never
 * inherit a pinned plugin family that has since been unloaded. `lineHeightScale`
 * and `letterSpacingEm` are clamped to the documented ranges so the UI
 * always reads as something a person could actually use.
 */
export function resolveTypographyVars(
  typography: TypographyExtSettings | undefined
): Record<string, string> {
  const t = { ...DEFAULT_TYPOGRAPHY_EXT, ...(typography ?? {}) }
  const lineHeightScale = clamp(t.lineHeightScale, 0.875, 1.25)
  const letterSpacingEm = clamp(t.letterSpacingEm, -0.02, 0.02)
  const vars: Record<string, string> = {
    "--font-sans": withFallback(t.fontFamily, FALLBACK_SANS),
    "--font-mono": withFallback(t.monoFamily, FALLBACK_MONO),
    "--line-height-scale": String(lineHeightScale),
    "--letter-spacing-em": `${letterSpacingEm}em`,
  }
  if (t.serifFamily) {
    vars["--font-serif"] = withFallback(t.serifFamily, FALLBACK_SERIF)
  }
  return vars
}

function withFallback(family: string | undefined, fallback: string): string {
  if (!family) return fallback
  const trimmed = family.trim()
  if (!trimmed) return fallback
  // Quote families containing spaces / hyphens that aren't already quoted —
  // raw `Source Sans 3` would parse as three families otherwise.
  const needsQuotes = /[\s,]/.test(trimmed) && !/^["'].*["']$/.test(trimmed)
  const quoted = needsQuotes ? `"${trimmed.replace(/"/g, '\\"')}"` : trimmed
  return `${quoted}, ${fallback}`
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  if (value < min) return min
  if (value > max) return max
  return value
}

/**
 * Mounts at the root layout. Writes the typography vars onto `<html>` as
 * inline styles whenever the typography slice changes.
 *
 * Defaults are documented at `DEFAULT_TYPOGRAPHY_EXT`; older settings rows
 * without the slice resolve to the defaults via `resolveTypographyVars`.
 */
export function TypographyApplier(): null {
  const typography = useSettingsStore((s) => s.settings?.typographyExt)

  useEffect(() => {
    if (typeof document === "undefined") return
    const root = document.documentElement
    const vars = resolveTypographyVars(typography)
    applyCssVars(root, vars)
    return () => {
      removeCssVars(root, VAR_KEYS)
    }
  }, [typography])

  return null
}
