// lib/appearance/contrast.ts
import { converter, formatCss, parse } from "culori"

const toRgb = converter("rgb")
const toOklch = converter("oklch")

function relLuminance(color: string): number {
  const rgb = toRgb(parse(color))
  if (!rgb) return 0
  const f = (v: number) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))
  return 0.2126 * f(rgb.r) + 0.7152 * f(rgb.g) + 0.0722 * f(rgb.b)
}

/**
 * Whether culori can resolve this string to a real color.
 *
 * Worth calling before {@link wcagContrast}: an unparsable input does **not**
 * throw, it silently contributes zero luminance, so a pair of garbage colors
 * reports a plausible-looking 1:1 rather than an error. Callers that read
 * colors out of the live cascade (where a var can resolve to something culori
 * has no parser for) need to tell "unreadable" apart from "unknown".
 */
export function isColorParsable(color: string): boolean {
  return toRgb(parse(color)) !== undefined
}

export function wcagContrast(fg: string, bg: string): number {
  const a = relLuminance(fg)
  const b = relLuminance(bg)
  const [hi, lo] = a > b ? [a, b] : [b, a]
  return (hi + 0.05) / (lo + 0.05)
}

export type ReadabilityLevel = "ok" | "warn" | "fail"

export interface ReadabilityVerdict {
  level: ReadabilityLevel
  ratio: number
  recommendation?: string
}

/**
 * Classify a foreground/background pair against WCAG 2.1 AA thresholds for
 * normal text (4.5:1). Used by the wallpaper opacity guard and the custom
 * theme editor to surface readability issues in real time.
 *
 * - ok    (>= 4.5): meets AA for normal text
 * - warn  (>= 3.0): meets AA for large text but not normal — borderline
 * - fail  (< 3.0):  unreadable; recommend a corrective action
 */
export function evaluateReadability(args: {
  fgColor: string
  bgColor: string
}): ReadabilityVerdict {
  const ratio = wcagContrast(args.fgColor, args.bgColor)
  if (ratio >= 4.5) return { level: "ok", ratio }
  if (ratio >= 3) {
    return {
      level: "warn",
      ratio,
      recommendation: "对比度低于 4.5:1，可能影响可读性",
    }
  }
  return {
    level: "fail",
    ratio,
    recommendation: "对比度过低，文本几乎不可读",
  }
}

/**
 * Binary-search the foreground's oklch L axis so the resulting color meets
 * `targetRatio` against `bg`. Preserves the original hue and chroma — only
 * lightness moves, which keeps the corrected color visually related to the
 * user's choice.
 *
 * Direction: if the current `fg` is already lighter than `bg`, we push it
 * further toward 1; if darker, toward 0. This avoids "flipping" a dark-on-
 * light pair to light-on-light, which would change the visual character of
 * the theme.
 *
 * Returns `null` when:
 *   - either color cannot be parsed
 *   - even the extreme of the chosen direction (L=0 or L=1) fails to reach
 *     the target (i.e. the background itself is unreachable)
 */
export function adjustForegroundLightnessToTarget(
  fg: string,
  bg: string,
  targetRatio: number
): string | null {
  const fgOklch = toOklch(parse(fg))
  const bgRgb = toRgb(parse(bg))
  if (!fgOklch || !bgRgb) return null

  // Solve for a slightly tighter ratio internally — `formatCss` rounds the
  // L axis to ~3 decimals, so a binary search hit at the exact boundary can
  // round back below threshold. The 0.1 margin keeps the rounded result
  // safely above the actual WCAG threshold.
  const searchTarget = targetRatio + 0.1

  // `formatCss` is total for an oklch color, and `fgOklch` parsed above.
  const tryColor = (L: number): string => formatCss({ ...fgOklch, l: L })

  // Decide direction based on starting luminance, but flip if the natural
  // direction is unreachable. Mid-gray backgrounds are notoriously hard for
  // light-mode foregrounds: e.g. #999999 on #888888 wants to move lighter,
  // but white on #888888 only reaches 3.5:1. In that case we flip to dark.
  const startLuma = relLuminance(fg)
  const bgLuma = relLuminance(bg)
  let moveLighter = startLuma >= bgLuma
  let extremeL = moveLighter ? 1 : 0
  if (wcagContrast(tryColor(extremeL), bg) < searchTarget) {
    // Try the other direction before giving up.
    moveLighter = !moveLighter
    extremeL = moveLighter ? 1 : 0
    if (wcagContrast(tryColor(extremeL), bg) < searchTarget) return null
  }

  // Binary search the L axis. 18 iterations gets us to ~3.8e-6 precision —
  // well below the JND threshold of oklch L.
  //
  // Bracket choice:
  //   - Natural direction: bracket is [originalL, 1] for lighter or
  //     [0, originalL] for darker, so the search returns the *minimum*
  //     change required.
  //   - Flipped direction (the natural extreme was unreachable): use [0, 1]
  //     so the search can cross the original L and find a satisfying value
  //     on the opposite side.
  const originalSatisfies = moveLighter === startLuma >= bgLuma // true iff direction wasn't flipped
  let lo = originalSatisfies && moveLighter ? fgOklch.l : 0
  let hi = originalSatisfies && !moveLighter ? fgOklch.l : 1
  // Ensure lo/hi bracket the target so the binary search has a solution.
  if (moveLighter && wcagContrast(tryColor(lo), bg) >= searchTarget) {
    return formatCss(fgOklch)
  }
  if (!moveLighter && wcagContrast(tryColor(hi), bg) >= searchTarget) {
    return formatCss(fgOklch)
  }
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2
    const ratio = wcagContrast(tryColor(mid), bg)
    if (ratio >= searchTarget) {
      // mid satisfies — pull the search bound in toward the original to
      // return the *minimum* change required.
      if (moveLighter) hi = mid
      else lo = mid
    } else {
      if (moveLighter) lo = mid
      else hi = mid
    }
  }
  return tryColor(moveLighter ? hi : lo)
}
