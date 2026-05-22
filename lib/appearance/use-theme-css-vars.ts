/**
 * useThemeCssVars — generalised live reader for CSS custom properties on
 * `<html>`. Returns resolved values for each requested key and re-reads
 * whenever next-themes flips the class **or** `CustomThemeApplier` writes
 * inline styles. The previous home for this hook (`lib/logger/use-theme-colors.ts`)
 * only observed `class`, which made it miss every inline-style update — that
 * bug is fixed here and the logger module now delegates to this hook.
 *
 * SSR-safe: returns the caller-supplied defaults on the server / first paint,
 * then upgrades to live values on mount. Defaults should mirror the `:root`
 * stylesheet values so charts render reasonably before hydration completes.
 *
 * Canvas safety: callers that hand the resolved string to a 2D canvas
 * context (`ctx.fillStyle = vars["--primary"]`) get an oklch value on
 * modern browsers (Chromium 111+, Safari 16.4+, Firefox 113+). On older
 * engines that don't recognise oklch, the resolved value is converted to
 * a hex string via culori before being returned.
 */

"use client"

import { useEffect, useState } from "react"
import { formatHex, parse as parseCulori } from "culori"

// Cached probe — runs once per module load. Modern browsers say yes; this
// gates the culori conversion fallback for very old WebViews only.
let cachedOklchSupport: boolean | null = null
function supportsOklch(): boolean {
  if (cachedOklchSupport !== null) return cachedOklchSupport
  if (typeof CSS === "undefined" || typeof CSS.supports !== "function") {
    cachedOklchSupport = false
    return false
  }
  try {
    cachedOklchSupport = CSS.supports("color", "oklch(0 0 0)")
  } catch {
    cachedOklchSupport = false
  }
  return cachedOklchSupport
}

function normaliseValue(raw: string, canvasSafe: boolean): string {
  if (!raw) return raw
  if (!canvasSafe || supportsOklch()) return raw
  // Old WebViews: convert any color the browser computed (oklch, hsl, etc.)
  // into a hex string the canvas API accepts.
  try {
    const parsed = parseCulori(raw)
    if (parsed) {
      const hex = formatHex(parsed)
      if (hex) return hex
    }
  } catch {
    // Fall through and return the raw value — the canvas may still draw
    // something readable, and we prefer that over a hard failure.
  }
  return raw
}

export interface UseThemeCssVarsOptions {
  /**
   * Set to `true` when the resolved string will be assigned to a 2D canvas
   * context (`ctx.fillStyle = ...`). Triggers oklch → hex fallback on
   * legacy WebViews so the canvas always draws the intended color.
   */
  canvasSafe?: boolean
}

export function useThemeCssVars<K extends string>(
  keys: readonly K[],
  defaults: Record<K, string>,
  options: UseThemeCssVarsOptions = {}
): Record<K, string> {
  const canvasSafe = options.canvasSafe === true
  const [vars, setVars] = useState<Record<K, string>>(defaults)

  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") return

    const root = document.documentElement

    const readVars = () => {
      const computed = getComputedStyle(root)
      const next = {} as Record<K, string>
      for (const key of keys) {
        const value = computed.getPropertyValue(key).trim()
        next[key] = value ? normaliseValue(value, canvasSafe) : defaults[key]
      }
      setVars(next)
    }

    readVars()

    // Watch BOTH `class` (next-themes toggling `.dark`) AND `style`
    // (CustomThemeApplier writing inline CSS variables). The logger hook's
    // previous failure to observe `style` is why custom themes never
    // propagated into chart colors.
    const observer = new MutationObserver(readVars)
    observer.observe(root, {
      attributes: true,
      attributeFilter: ["class", "style"],
    })

    return () => observer.disconnect()
  }, [keys, defaults, canvasSafe])

  return vars
}

/** Test-only — reset the cached `CSS.supports("oklch")` probe. */
export function __resetOklchSupportProbeForTesting(): void {
  cachedOklchSupport = null
}
