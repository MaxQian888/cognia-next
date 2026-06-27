/**
 * Pure, render-free view helpers for {@link EffortSlider} — the reasoning-effort
 * overlay. Extracted so the responsive layout math (gauge width, fill position,
 * which layout fits the terminal, number-key jumps) is unit-testable without an
 * Ink render. The component imports these and only does the drawing.
 */
import { EFFORT_SLIDER_LEVELS, type ThinkingLevel } from "../../config/schema"

/** One-line description of what each tier does, keyed by level. */
export const EFFORT_LEVEL_DESCRIPTIONS: Record<Exclude<ThinkingLevel, "off">, string> = {
  low: "minimal extra reasoning — fastest",
  medium: "balanced reasoning depth",
  high: "deeper reasoning — slower",
  xhigh: "near-maximum reasoning depth",
  max: "maximum reasoning budget",
  ultracode: "xhigh effort + dynamic workflow tools",
}

/** Layout mode chosen by the available width: the wide layout shows the full
 * inline tier scale with labels; the compact one drops to a gauge + position
 * readout so a narrow terminal never wraps the scale into noise. */
export type EffortLayout = "wide" | "compact"

/** The width below which the inline tier scale no longer fits. The scale needs
 * roughly `Σ(label+2) + arrows` columns; the six default tiers want ~58, so 64
 * leaves a little slack for the cursor + borders before we fall back. */
export const EFFORT_WIDE_MIN_WIDTH = 64

/** Pick the layout for a given overlay width. */
export function effortLayout(width: number | undefined): EffortLayout {
  if (typeof width !== "number" || !Number.isFinite(width)) return "wide"
  return width >= EFFORT_WIDE_MIN_WIDTH ? "wide" : "compact"
}

/**
 * Gauge track length (cell count) for a given overlay width, clamped to a
 * readable band. Leaves margin for the border, padding, and the leading cursor.
 */
export function effortGaugeWidth(width: number | undefined): number {
  const inner = typeof width === "number" && Number.isFinite(width) ? width - 8 : 32
  return Math.max(12, Math.min(44, Math.floor(inner)))
}

/** Per-cell state of the gauge track — drives the component's glyph + colour. */
export type GaugeCell = "filled" | "marker" | "empty"

/**
 * Render the gauge as a per-cell state array: cells up to the marker are
 * `filled`, the marker cell sits at the proportional position, the rest are
 * `empty`. `last <= 0` (a single tier) marks the whole track.
 */
export function effortGaugeCells(index: number, last: number, cells: number): GaugeCell[] {
  if (cells <= 0) return []
  if (last <= 0) return Array.from({ length: cells }, () => "marker")
  const clamped = Math.min(Math.max(index, 0), last)
  const pos = Math.round((clamped / last) * (cells - 1))
  return Array.from(
    { length: cells },
    (_, i): GaugeCell => (i === pos ? "marker" : i < pos ? "filled" : "empty")
  )
}

/**
 * Map a typed digit to a tier index: `"1".."9"` → index `0..8`, returning
 * `null` when the digit names no tier (so `0` and out-of-range fall through to
 * the caller's own handling — `0` toggles "off"). 1-based so the labels read
 * naturally ("press 4 for xhigh").
 */
export function effortKeyToIndex(input: string): number | null {
  if (!/^[1-9]$/.test(input)) return null
  const n = Number(input) - 1
  return n < EFFORT_SLIDER_LEVELS.length ? n : null
}

/** Position readout for the compact layout: `4/6 · xhigh`. */
export function effortPositionLabel(index: number, off: boolean): string {
  if (off) return "off · model default"
  const total = EFFORT_SLIDER_LEVELS.length
  const i = Math.min(Math.max(index, 0), total - 1)
  return `${i + 1}/${total} · ${EFFORT_SLIDER_LEVELS[i]}`
}
