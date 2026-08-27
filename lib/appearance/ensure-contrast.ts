// lib/appearance/ensure-contrast.ts
//
// Guarantees foreground/surface legibility for whatever palette is about to be
// written to the DOM. Custom and imported (e.g. VSCode) themes can pair a
// surface token with a near-identical foreground — most visibly on secondary
// buttons, where the label vanishes into the background. Rather than patch each
// call site, `CustomThemeApplier` runs the resolved palette through this pass
// so every surface in any active theme stays readable.

import type { ThemeColors } from "@/types/plugin/plugin"
import { adjustForegroundLightnessToTarget, wcagContrast } from "./contrast"

/** WCAG 2.1 AA contrast threshold for normal-size text. */
export const AA_NORMAL_TEXT = 4.5

/**
 * Surface → foreground token pairs. The first key is the background the text
 * sits on; the second is the text/icon color. Only the foreground is ever
 * adjusted, never the surface, so the theme's overall hue character is kept.
 * Non-text tokens (border, input, ring) are intentionally absent.
 */
const FOREGROUND_PAIRS: ReadonlyArray<readonly [keyof ThemeColors, keyof ThemeColors]> = [
  ["background", "foreground"],
  ["card", "cardForeground"],
  ["popover", "popoverForeground"],
  ["primary", "primaryForeground"],
  ["secondary", "secondaryForeground"],
  ["accent", "accentForeground"],
  ["muted", "mutedForeground"],
  ["destructive", "destructiveForeground"],
  ["success", "successForeground"],
  ["warning", "warningForeground"],
  ["info", "infoForeground"],
  ["sidebar", "sidebarForeground"],
  ["sidebarPrimary", "sidebarPrimaryForeground"],
  ["sidebarAccent", "sidebarAccentForeground"],
]

/**
 * Return a copy of `tokens` where every foreground that fails `targetRatio`
 * against its paired surface is nudged along its oklch lightness axis until it
 * passes (hue + chroma preserved). Pairs that already pass — or that can't be
 * parsed / corrected — are left exactly as they were. When nothing needs
 * fixing the original object is returned unchanged (referential identity), so
 * the common case allocates nothing.
 *
 * Generic in the palette shape so a caller passing a fully-resolved palette
 * gets one back — the correction only ever replaces existing values, never
 * removes them.
 */
export function ensureForegroundContrast<T extends ThemeColors>(
  tokens: T,
  targetRatio: number = AA_NORMAL_TEXT
): T {
  let result: T | null = null
  for (const [bgKey, fgKey] of FOREGROUND_PAIRS) {
    const bg = tokens[bgKey]
    const fg = tokens[fgKey]
    if (!bg || !fg) continue
    if (wcagContrast(fg, bg) >= targetRatio) continue
    const corrected = adjustForegroundLightnessToTarget(fg, bg, targetRatio)
    if (!corrected || corrected === fg) continue
    if (!result) result = { ...tokens }
    result[fgKey] = corrected
  }
  return result ?? tokens
}
