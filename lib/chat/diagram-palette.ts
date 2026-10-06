/**
 * The app palette resolved to concrete sRGB colours, for the diagram and chart
 * renderers that cannot read CSS variables (ADR-0218).
 *
 * Two consumers need this:
 *
 *   - Mermaid computes derived shades in JavaScript and cannot parse `oklch`
 *     or `var()`, so it was left on its stock theme and ignored every palette.
 *   - Inline charts are exported as PNG / SVG; a serialized `var(--chart-1)`
 *     means nothing outside the document, so series colours must be literal.
 *
 * The palette is read from the computed tokens on `<html>`, so built-in
 * themes, custom themes (inline `style` vars) and dark mode (`class`) all
 * apply. One `MutationObserver` serves every subscriber, the same shape as
 * `@cognia/mermaid`'s theme source, so fifty diagrams cost one observer.
 */

import { formatHex, interpolate, parse } from "culori"
import { useSyncExternalStore } from "react"

export interface ChatDiagramColors {
  background: string
  foreground: string
  card: string
  muted: string
  mutedForeground: string
  border: string
  primary: string
  accent: string
  warning: string
  chart: readonly string[]
}

export interface ChatDiagramPalette {
  /** Stable identity of the palette; changes when any colour or the mode does. */
  key: string
  dark: boolean
  fontFamily: string
  colors: ChatDiagramColors
}

/** Light defaults, used outside a browser and for any token that fails to parse. */
const FALLBACK: ChatDiagramColors = {
  background: "#ffffff",
  foreground: "#0a0a0a",
  card: "#ffffff",
  muted: "#f5f5f5",
  mutedForeground: "#737373",
  border: "#e5e5e5",
  primary: "#171717",
  accent: "#f5f5f5",
  warning: "#f0b100",
  chart: ["#f54900", "#009689", "#104e64", "#ffb900", "#fe9a00"],
}

const FALLBACK_FONT = "system-ui, -apple-system, sans-serif"

/**
 * Resolve any CSS colour culori understands (hex, rgb, hsl, oklch, named) to
 * `#rrggbb`. A translucent colour is composited over `over` first, the way the
 * browser paints it: `formatHex` alone drops the alpha, so the dark theme's
 * `oklch(1 0 0 / 10%)` border would come out as solid white.
 */
export function toHex(value: string | undefined, fallback: string, over = "#ffffff"): string {
  if (!value) return fallback
  const parsed = parse(value.trim())
  if (!parsed) return fallback
  const alpha = parsed.alpha ?? 1
  if (alpha >= 1) return formatHex(parsed) ?? fallback
  const base = parse(over)
  if (!base) return formatHex(parsed) ?? fallback
  return formatHex(interpolate([base, { ...parsed, alpha: 1 }], "rgb")(alpha)) ?? fallback
}

/** `percent`% of `from` mixed into `into`, in oklab like CSS `color-mix`. */
export function mixHex(from: string, into: string, percent: number): string {
  const a = parse(from)
  const b = parse(into)
  if (!a || !b) return into
  return formatHex(interpolate([b, a], "oklab")(percent / 100)) ?? into
}

/**
 * Read the palette from computed styles. Exported for tests and for one-off
 * reads (PNG export); components use {@link useChatDiagramPalette}.
 */
export function readChatDiagramPalette(): ChatDiagramPalette {
  if (typeof document === "undefined") {
    return { key: "ssr", dark: false, fontFamily: FALLBACK_FONT, colors: FALLBACK }
  }
  const root = document.documentElement
  const style = getComputedStyle(root)
  // A token may be a `color-mix()` or reference another variable, which
  // culori cannot read. Letting the browser compute it on a probe yields a
  // plain colour; the raw declaration is the fallback where the computed
  // value is not a colour (jsdom does not resolve `var()`).
  const probe = document.createElement("span")
  probe.style.display = "none"
  root.appendChild(probe)
  const token = (name: string) => {
    probe.style.color = ""
    probe.style.color = `var(${name})`
    const computed = getComputedStyle(probe).color
    return computed && parse(computed) ? computed : style.getPropertyValue(name)
  }
  const dark = root.classList.contains("dark")
  const background = toHex(token("--background"), FALLBACK.background)
  const read = (name: string, fallback: string) => toHex(token(name), fallback, background)
  const colors: ChatDiagramColors = {
    background,
    foreground: read("--foreground", FALLBACK.foreground),
    card: read("--card", FALLBACK.card),
    muted: read("--muted", FALLBACK.muted),
    mutedForeground: read("--muted-foreground", FALLBACK.mutedForeground),
    border: read("--border", FALLBACK.border),
    primary: read("--primary", FALLBACK.primary),
    accent: read("--accent", FALLBACK.accent),
    warning: read("--warning", FALLBACK.warning),
    chart: [1, 2, 3, 4, 5].map((n) => read(`--chart-${n}`, FALLBACK.chart[n - 1])),
  }
  probe.remove()
  const body = document.body ? getComputedStyle(document.body).fontFamily : ""
  const fontFamily = body.trim() || FALLBACK_FONT
  const key = [dark ? "d" : "l", fontFamily, ...Object.values(colors).flat()].join("|")
  return { key, dark, fontFamily, colors }
}

/**
 * Mermaid `base`-theme variables for a palette. Nodes take a faint tint of the
 * theme primary over the background (so a coloured theme shows through and
 * the neutral default reads as quiet grey), edges and borders the muted
 * foreground, notes a warning wash, and pie / xy charts the chart series.
 */
export function buildMermaidThemeVariables(
  palette: ChatDiagramPalette
): Record<string, string | boolean> {
  const c = palette.colors
  const node = mixHex(c.primary, c.background, palette.dark ? 16 : 8)
  const nodeBorder = mixHex(c.mutedForeground, c.background, 55)
  const cluster = mixHex(c.muted, c.background, 50)
  const note = mixHex(c.warning, c.background, palette.dark ? 20 : 14)
  const pies = Object.fromEntries(c.chart.map((color, i) => [`pie${i + 1}`, color]))
  const cScale = Object.fromEntries(c.chart.map((color, i) => [`cScale${i}`, color]))
  return {
    darkMode: palette.dark,
    background: c.background,
    fontFamily: palette.fontFamily,
    fontSize: "13px",
    primaryColor: node,
    primaryTextColor: c.foreground,
    primaryBorderColor: nodeBorder,
    secondaryColor: mixHex(c.accent, c.background, 60),
    secondaryTextColor: c.foreground,
    secondaryBorderColor: nodeBorder,
    tertiaryColor: cluster,
    tertiaryTextColor: c.foreground,
    tertiaryBorderColor: c.border,
    mainBkg: node,
    nodeBorder,
    nodeTextColor: c.foreground,
    textColor: c.foreground,
    titleColor: c.foreground,
    lineColor: c.mutedForeground,
    edgeLabelBackground: c.background,
    clusterBkg: cluster,
    clusterBorder: c.border,
    noteBkgColor: note,
    noteTextColor: c.foreground,
    noteBorderColor: mixHex(c.warning, c.background, 50),
    actorBkg: node,
    actorBorder: nodeBorder,
    actorTextColor: c.foreground,
    actorLineColor: c.mutedForeground,
    signalColor: c.foreground,
    signalTextColor: c.foreground,
    labelBoxBkgColor: node,
    labelBoxBorderColor: nodeBorder,
    labelTextColor: c.foreground,
    loopTextColor: c.foreground,
    activationBkgColor: cluster,
    activationBorderColor: nodeBorder,
    sequenceNumberColor: c.background,
    ...pies,
    pieStrokeColor: c.background,
    pieOuterStrokeColor: c.border,
    pieTitleTextColor: c.foreground,
    pieSectionTextColor: palette.dark ? c.foreground : c.background,
    pieLegendTextColor: c.foreground,
    ...cScale,
  }
}

// ----------------------------------------------------------------------------
// One shared observer.
// ----------------------------------------------------------------------------

type Listener = () => void
const listeners = new Set<Listener>()
let observer: MutationObserver | null = null
let snapshot: ChatDiagramPalette | null = null

function refresh(): void {
  const next = readChatDiagramPalette()
  if (snapshot && next.key === snapshot.key) return
  snapshot = next
  for (const listener of listeners) listener()
}

export function subscribeChatDiagramPalette(listener: Listener): () => void {
  listeners.add(listener)
  if (
    observer === null &&
    typeof MutationObserver !== "undefined" &&
    typeof document !== "undefined"
  ) {
    observer = new MutationObserver(refresh)
    // `class` carries dark mode, `style` the custom-theme token overrides.
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    })
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      observer?.disconnect()
      observer = null
    }
  }
}

function getSnapshot(): ChatDiagramPalette {
  if (!snapshot) snapshot = readChatDiagramPalette()
  return snapshot
}

const SERVER_SNAPSHOT: ChatDiagramPalette = {
  key: "ssr",
  dark: false,
  fontFamily: FALLBACK_FONT,
  colors: FALLBACK,
}

/** The live palette; re-renders only when a colour, the mode or the font changes. */
export function useChatDiagramPalette(): ChatDiagramPalette {
  return useSyncExternalStore(subscribeChatDiagramPalette, getSnapshot, () => SERVER_SNAPSHOT)
}

/** Test seam: forget the cached snapshot. */
export function __resetChatDiagramPaletteForTesting(): void {
  snapshot = null
}
