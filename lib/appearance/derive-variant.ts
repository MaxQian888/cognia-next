import { converter, formatCss, parse, type Color } from "culori"
import type { ThemeColors } from "@/types/plugin/plugin-extended"

const toOklch = converter("oklch")

const NEUTRAL_CHROMA_THRESHOLD = 0.04
const DARK_CHROMA_ATTENUATION = 0.92
const ACCENT_LIGHTNESS_BASE = 0.4
const ACCENT_LIGHTNESS_RANGE = 0.4

interface OklchTriple {
  l: number
  c: number
  h: number
}

/**
 * Convert a CSS color string into OKLCH coordinates. Returns `null` when the
 * input cannot be parsed (callers should fall back to a sane default).
 */
function parseToOklch(input: string): OklchTriple | null {
  try {
    const parsed = parse(input)
    if (!parsed) return null
    const oklch = toOklch(parsed)
    if (!oklch) return null
    return {
      l: typeof oklch.l === "number" ? oklch.l : 0,
      c: typeof oklch.c === "number" ? oklch.c : 0,
      h: typeof oklch.h === "number" ? oklch.h : 0,
    }
  } catch {
    return null
  }
}

function emitOklch(l: number, c: number, h: number): string {
  // Clamp to displayable ranges. P3-aware UAs accept slightly higher chroma but
  // we cap at 0.4 which covers sRGB safely.
  const clampedL = Math.max(0, Math.min(1, l))
  const clampedC = Math.max(0, Math.min(0.4, c))
  const obj: Color = { mode: "oklch", l: clampedL, c: clampedC, h }
  return formatCss(obj)
}

/**
 * Derive a single token's value when flipping between light and dark.
 *
 * Rules:
 *   - Same source and target variant: input unchanged.
 *   - Unparseable input: input unchanged.
 *   - Neutral (`c < 0.04`): flip lightness via `1 - L`.
 *   - Saturated: keep hue, remap lightness to `0.4 + 0.4 * (1 - L)` so accents
 *     stay visible without going pure black/white; in dark mode also attenuate
 *     chroma by 8% to avoid a neon look.
 */
export function deriveTokenColor(
  input: string,
  sourceVariant: "light" | "dark",
  targetVariant: "light" | "dark"
): string {
  if (sourceVariant === targetVariant) return input
  const oklch = parseToOklch(input)
  if (!oklch) return input

  const { l, c, h } = oklch
  const isNeutral = c < NEUTRAL_CHROMA_THRESHOLD
  if (isNeutral) {
    return emitOklch(1 - l, c, h)
  }

  // Asymmetric by design: L=0.5 maps to L_new=0.6, not 0.5. An already-mid
  // accent in a light theme should get *brighter* in dark mode for visibility,
  // not the same lightness. The 0.4..0.8 output range keeps accents readable
  // against both pure-black and pure-white surfaces.
  const newL = ACCENT_LIGHTNESS_BASE + ACCENT_LIGHTNESS_RANGE * (1 - l)
  const newC = targetVariant === "dark" ? c * DARK_CHROMA_ATTENUATION : c
  return emitOklch(newL, newC, h)
}

/**
 * Derive the opposite-variant `ThemeColors` palette from a single source set.
 * Each token is independently derived. **High-contrast seeds (ratio >= ~7)
 * preserve AA in the derived pair; low-contrast seeds (ratio < ~5) may drop
 * below AA after derivation** — callers that need a guaranteed-readable
 * result should run `enforceReadable` from `./contrast` (added in Task 13).
 */
export function deriveOppositeVariant(
  source: ThemeColors,
  sourceVariant: "light" | "dark"
): ThemeColors {
  const target: "light" | "dark" = sourceVariant === "light" ? "dark" : "light"
  const entries = Object.entries(source) as Array<[keyof ThemeColors, string]>
  const result = {} as ThemeColors
  for (const [key, value] of entries) {
    result[key] = deriveTokenColor(value, sourceVariant, target)
  }
  return result
}
