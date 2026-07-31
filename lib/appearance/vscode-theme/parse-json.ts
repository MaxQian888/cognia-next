// Convert a VSCode color theme JSON into a cognia `CustomTheme`.
//
// The VSCode theme schema is permissive — most fields are optional and
// authors leave many unset. We do best-effort mapping:
//   - Walk our `VSCODE_COLOR_MAP` lookup and pick the first present key.
//   - For colors with embedded alpha (#rrggbbaa), strip the alpha — our
//     palette doesn't use it.
//   - For tokens we couldn't fill, derive a plausible value from the
//     bg/fg pair so the UI doesn't end up with `#undefined` strings.
//
// VSCode color theme files often use JSONC (with comments + trailing
// commas) — we strip those before `JSON.parse` so authoring with the
// standard VSCode tooling roundtrips.

import type { CustomTheme, ThemeColors } from "@/types/plugin/plugin"
import { darken, lighten, parseHex, readableForeground, stripAlpha } from "./color-utils"
import { DEFAULT_FALLBACKS, THEME_COLOR_KEYS, VSCODE_COLOR_MAP } from "./token-mapping"

export interface VscodeThemeJson {
  /**
   * Some VSCode themes specify `name` here, others rely on the
   * extension manifest's `label`. The caller may override with `nameHint`.
   */
  name?: string
  /** "light" or "dark" — drives `CustomTheme.isDark`. */
  type?: "light" | "dark" | "hc-light" | "hc-black"
  colors?: Record<string, string | undefined>
  /** Token (syntax highlighting) colors — preserved on the imported theme. */
  tokenColors?: unknown[]
  /** Most schema variants we've seen; rest treated as opaque. */
  [extra: string]: unknown
}

export interface ParseJsonOptions {
  /** Override the `CustomTheme.name`. Wins over `theme.name`. */
  nameHint?: string
  /** Force a variant. When unset we read `theme.type` (defaulting to "dark"). */
  forceVariant?: "light" | "dark"
}

export interface ParsedTheme {
  /** Ready-to-store CustomTheme; `id` will be assigned by the store on insert. */
  theme: Omit<CustomTheme, "id" | "colors"> & { colors: ThemeColors }
  /** True when the input had no `colors` table at all (still a valid theme). */
  emptyColors: boolean
  /** Number of cognia color slots that were filled directly from VSCode keys. */
  matchedCount: number
}

/**
 * Strip JSONC artifacts (line + block comments + trailing commas). Returns
 * the cleaned text — `JSON.parse` is left to the caller so they can hold
 * onto the original error object.
 */
export function stripJsonComments(input: string): string {
  let out = ""
  let i = 0
  const n = input.length
  while (i < n) {
    const ch = input[i]
    const next = input[i + 1]
    if (ch === '"' || ch === "'") {
      // Walk past the entire string, respecting backslash escapes.
      const quote = ch
      out += ch
      i += 1
      while (i < n) {
        const c = input[i]
        out += c
        if (c === "\\" && i + 1 < n) {
          out += input[i + 1]
          i += 2
          continue
        }
        i += 1
        if (c === quote) break
      }
      continue
    }
    if (ch === "/" && next === "/") {
      // Line comment — skip to end of line, preserve the newline.
      i += 2
      while (i < n && input[i] !== "\n") i += 1
      continue
    }
    if (ch === "/" && next === "*") {
      i += 2
      while (i < n && !(input[i] === "*" && input[i + 1] === "/")) i += 1
      i += 2 // skip the closing `*/`
      continue
    }
    out += ch
    i += 1
  }
  // Trailing commas: `,}` or `,]`. Iterating once is enough because the
  // pattern can only appear after the strip-comments pass.
  return out.replace(/,\s*([}\]])/g, "$1")
}

/** Parse a VSCode color theme JSON file. Returns null if the input isn't valid JSON. */
export function parseVscodeJson(text: string): VscodeThemeJson | null {
  try {
    const cleaned = stripJsonComments(text)
    const obj = JSON.parse(cleaned) as VscodeThemeJson
    if (typeof obj !== "object" || obj === null) return null
    return obj
  } catch {
    return null
  }
}

/**
 * Build a `CustomTheme` from a parsed VSCode JSON object. The inverse of
 * `parseVscodeJson` — accepts an in-memory object so the VSIX path can
 * skip the text-parsing step.
 */
export function vscodeThemeToCustomTheme(
  source: VscodeThemeJson,
  options: ParseJsonOptions = {}
): ParsedTheme {
  const variant: "light" | "dark" =
    options.forceVariant ??
    (source.type === "light" || source.type === "hc-light" ? "light" : "dark")
  const fallback = DEFAULT_FALLBACKS[variant]
  const isDark = variant === "dark"

  const vsColors: Record<string, string> = {}
  if (source.colors && typeof source.colors === "object") {
    for (const [key, value] of Object.entries(source.colors)) {
      if (typeof value === "string" && value.length > 0) vsColors[key] = value
    }
  }
  const emptyColors = Object.keys(vsColors).length === 0

  let matched = 0
  const out: Partial<ThemeColors> = {}
  for (const key of THEME_COLOR_KEYS) {
    const candidates = VSCODE_COLOR_MAP[key]
    let chosen: string | undefined
    for (const candidate of candidates) {
      const v = vsColors[candidate]
      if (typeof v === "string" && v.length > 0 && parseHex(v)) {
        chosen = stripAlpha(v)
        break
      }
    }
    if (chosen) {
      out[key] = chosen
      matched += 1
    }
  }

  // Derive missing fields from background/foreground when possible. The
  // derivation comes BEFORE the hardcoded `DEFAULT_FALLBACKS` palette so
  // a minimalist VSCode theme that only sets bg/fg ends up with derived
  // colors that match its mood, not blue accents from our defaults.
  const bg = out.background ?? fallback.background
  const fg = out.foreground ?? readableForeground(bg)
  out.background ??= bg
  out.foreground ??= fg

  // Surface colors: derive from bg with small tints/shades.
  if (!out.muted) out.muted = isDark ? lighten(bg, 0.06) : darken(bg, 0.04)
  if (!out.card) out.card = isDark ? lighten(bg, 0.04) : bg
  if (!out.popover) out.popover = isDark ? lighten(bg, 0.05) : bg
  if (!out.input) out.input = isDark ? lighten(bg, 0.07) : darken(bg, 0.05)
  if (!out.sidebar) out.sidebar = isDark ? lighten(bg, 0.02) : darken(bg, 0.02)

  // Foreground colors: derive from fg with subtle adjustments.
  if (!out.cardForeground) out.cardForeground = fg
  if (!out.popoverForeground) out.popoverForeground = fg
  if (!out.sidebarForeground) out.sidebarForeground = fg
  if (!out.mutedForeground) out.mutedForeground = isDark ? darken(fg, 0.25) : lighten(fg, 0.25)
  if (!out.secondaryForeground) out.secondaryForeground = fg

  // Borders: subtle bg-derived values.
  if (!out.border) out.border = isDark ? lighten(bg, 0.1) : darken(bg, 0.08)
  if (!out.sidebarBorder) out.sidebarBorder = out.border

  // Accents/primary: derive from primary if matched. Only fall back to the
  // hardcoded palette when neither bg/fg nor primary are usable.
  const accentSource = out.primary ?? out.foreground
  if (!out.accent) out.accent = accentSource
  if (!out.accentForeground) out.accentForeground = readableForeground(out.accent)
  if (!out.ring) out.ring = out.primary ?? accentSource ?? fallback.ring
  if (!out.sidebarPrimary) out.sidebarPrimary = out.primary ?? fallback.primary
  if (!out.sidebarPrimaryForeground)
    out.sidebarPrimaryForeground = readableForeground(out.sidebarPrimary)
  if (!out.sidebarAccent)
    out.sidebarAccent = out.muted ?? (isDark ? lighten(bg, 0.06) : darken(bg, 0.04))
  if (!out.sidebarAccentForeground)
    out.sidebarAccentForeground = readableForeground(out.sidebarAccent)
  if (!out.sidebarRing) out.sidebarRing = out.ring ?? out.primary ?? fallback.ring

  // Last-resort hardcoded fallbacks for tokens that have no source at all.
  if (!out.primary) out.primary = fallback.primary
  if (!out.primaryForeground) out.primaryForeground = readableForeground(out.primary)
  if (!out.secondary) out.secondary = isDark ? lighten(bg, 0.05) : darken(bg, 0.03)
  if (!out.destructive) out.destructive = fallback.destructive
  if (!out.destructiveForeground) out.destructiveForeground = readableForeground(out.destructive)

  const name = options.nameHint ?? source.name ?? "Imported Theme"
  return {
    // The derivation block above guarantees all 27 ThemeColors keys are filled.
    theme: { name, isDark, colors: out as ThemeColors },
    emptyColors,
    matchedCount: matched,
  }
}

/**
 * Convenience for the file-drop flow. Reads JSON text + an optional
 * filename and returns a fully-formed `ParsedTheme`. Throws when the
 * input isn't valid JSON.
 */
export function importVscodeThemeJson(text: string, options: ParseJsonOptions = {}): ParsedTheme {
  const parsed = parseVscodeJson(text)
  if (!parsed) throw new Error("Invalid VSCode theme JSON")
  return vscodeThemeToCustomTheme(parsed, options)
}
