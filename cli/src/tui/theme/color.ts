/**
 * Normalise the colour-value formats a Claude Code custom theme can use into a
 * form Ink's `<Text color>` accepts: either a 6-digit `#rrggbb` hex string or a
 * bare ANSI colour keyword (`"red"`, `"cyanBright"`). Claude accepts five
 * formats — `#rrggbb`, `#rgb`, `rgb(r,g,b)`, `ansi256(n)`, and `ansi:<name>` —
 * and silently ignores anything else; we mirror that by returning `null` for
 * unrecognised values so the caller keeps the derived default.
 */

/** The 16 standard ANSI colours, indexed by their 256-colour code (0–15). */
const ANSI_16: readonly string[] = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "gray",
  "redBright",
  "greenBright",
  "yellowBright",
  "blueBright",
  "magentaBright",
  "cyanBright",
  "whiteBright",
]

function toHex2(n: number): string {
  return Math.max(0, Math.min(255, Math.round(n)))
    .toString(16)
    .padStart(2, "0")
}

/** Convert an xterm 256-colour index (16–255) to `#rrggbb`. */
function ansi256ToHex(n: number): string | null {
  if (n < 16 || n > 255) return null
  if (n <= 231) {
    // 6×6×6 colour cube starting at 16.
    const c = n - 16
    const r = Math.floor(c / 36)
    const g = Math.floor((c % 36) / 6)
    const b = c % 6
    const level = (v: number) => (v === 0 ? 0 : 55 + v * 40)
    return `#${toHex2(level(r))}${toHex2(level(g))}${toHex2(level(b))}`
  }
  // 24-step grayscale ramp (232–255): 8, 18, 28, … 238.
  const v = 8 + (n - 232) * 10
  return `#${toHex2(v)}${toHex2(v)}${toHex2(v)}`
}

/** Normalise one Claude colour value, or null if it can't be parsed. */
export function normalizeColor(value: string): string | null {
  const v = value.trim()
  if (!v) return null

  // ansi:<name>
  const ansiName = /^ansi:([a-zA-Z]+)$/.exec(v)
  if (ansiName) return ansiName[1]

  // ansi256(n)
  const ansi256 = /^ansi256\((\d{1,3})\)$/.exec(v)
  if (ansi256) {
    const n = Number(ansi256[1])
    if (n < 16) return ANSI_16[n] ?? null
    return ansi256ToHex(n)
  }

  // rgb(r,g,b)
  const rgb = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/.exec(v)
  if (rgb) {
    const [r, g, b] = [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
    if ([r, g, b].some((c) => c > 255)) return null
    return `#${toHex2(r)}${toHex2(g)}${toHex2(b)}`
  }

  // #rgb / #rrggbb
  const hex = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(v)
  if (hex) {
    const h = hex[1].toLowerCase()
    return h.length === 3 ? `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}` : `#${h}`
  }

  return null
}
