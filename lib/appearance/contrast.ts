// lib/appearance/contrast.ts
import { converter, parse } from "culori"

const toRgb = converter("rgb")

function relLuminance(color: string): number {
  const rgb = toRgb(parse(color))
  if (!rgb) return 0
  const f = (v: number) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))
  return 0.2126 * f(rgb.r ?? 0) + 0.7152 * f(rgb.g ?? 0) + 0.0722 * f(rgb.b ?? 0)
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
