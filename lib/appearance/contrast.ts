// lib/appearance/contrast.ts (minimal stub for Task 6; Task 13 will expand it)
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
