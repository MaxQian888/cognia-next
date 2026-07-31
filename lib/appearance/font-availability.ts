/**
 * Runtime probe for "is this CSS font family actually resolvable here?".
 *
 * Settings that accept a font name have a silent failure mode: an unavailable
 * family falls back to the next entry in the stack, so the setting looks
 * ignored. `document.fonts.check()` cannot answer this — per spec it reports
 * whether the listed faces are *loaded*, and an unknown family is vacuously
 * satisfied — so we use the canonical width-comparison probe instead.
 *
 * A probe string is measured twice against each generic control family: once
 * with the control alone, once with `<family>, <control>`. If the candidate
 * ever measures differently, the family resolved and did the rendering. If it
 * matches every control exactly, nothing but the fallback was ever used.
 *
 * Three controls are used because a family that happens to be metric-identical
 * to one generic (common for monospace clones) would produce a false negative
 * against that control alone.
 */

/** Probe glyphs: wide, narrow, and symbol runs maximise metric divergence. */
const PROBE_TEXT = "mmmmmmmmmmlliWWWW@#$%"

/** Large size so sub-pixel metric differences exceed float noise. */
const PROBE_SIZE_PX = 72

const GENERIC_CONTROLS = ["monospace", "serif", "sans-serif"] as const

/**
 * CSS generic families and system keywords. These always "resolve" by
 * definition, and probing them against themselves would report unavailable.
 */
const GENERIC_KEYWORDS = new Set([
  "monospace",
  "serif",
  "sans-serif",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-monospace",
  "ui-sans-serif",
  "ui-serif",
  "ui-rounded",
  "math",
  "emoji",
  "fangsong",
  "inherit",
  "initial",
  "unset",
])

/** Strip wrapping quotes from a single family token: `"Fira Code"` → `Fira Code`. */
export function unquoteFamily(family: string): string {
  return family
    .trim()
    .replace(/^["']|["']$/g, "")
    .trim()
}

/**
 * First family of a CSS font-family stack, unquoted. Returns `""` for a blank
 * stack so callers can skip the probe.
 */
export function primaryFamilyOf(stack: string): string {
  const comma = stack.indexOf(",")
  return unquoteFamily(comma === -1 ? stack : stack.slice(0, comma))
}

/**
 * `true` when `family` renders, `false` when every probe fell back, and `null`
 * when the environment can't answer (SSR, no 2D canvas, stubbed `measureText`).
 * Callers must treat `null` as "don't warn" — an unknown is not a failure.
 */
export function isFontFamilyAvailable(family: string): boolean | null {
  const name = unquoteFamily(family)
  if (!name) return null
  if (GENERIC_KEYWORDS.has(name.toLowerCase())) return true
  try {
    if (typeof document === "undefined") return null
    const ctx = document.createElement("canvas").getContext("2d")
    if (!ctx) return null
    const measure = (font: string): number => {
      ctx.font = font
      return ctx.measureText(PROBE_TEXT).width
    }
    for (const control of GENERIC_CONTROLS) {
      const base = measure(`${PROBE_SIZE_PX}px ${control}`)
      // A zero-width control means text measurement isn't implemented
      // (jsdom's stub) — no signal either way.
      if (!base) return null
      if (measure(`${PROBE_SIZE_PX}px "${name}", ${control}`) !== base) return true
    }
    return false
  } catch {
    return null
  }
}
