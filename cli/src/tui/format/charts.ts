/**
 * Pure chart primitives for the TUI: a unicode block sparkline for a numeric
 * series (e.g. token-per-turn trend) and a proportional multi-segment stacked
 * bar (e.g. context composition). Returns plain data — a string for the
 * sparkline, colored runs for the bar — so Ink components render them without
 * any charting dependency.
 *
 * Companion to the single-value gauges in `status-bar.ts` (`progressBar` /
 * `contextGauge`): those cover one ratio; `charts.ts` covers series and
 * multi-segment visuals.
 */

/** Eight block heights, lowest → highest. */
const SPARK_TICKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const

/**
 * Render a numeric series as a unicode block sparkline. Values are scaled
 * against the series' own min/max so the shape is visible regardless of
 * magnitude. A flat series renders a mid-height tick (never the floor, which
 * would read as "no data"). When `width` is a positive number and the series is
 * longer, only the most recent `width` values are shown. Non-finite values are
 * dropped; an empty result is "".
 */
export function sparkline(values: number[], width?: number): string {
  const cleaned = values.filter((v) => Number.isFinite(v))
  if (cleaned.length === 0) return ""
  const series =
    width && width > 0 && cleaned.length > width ? cleaned.slice(cleaned.length - width) : cleaned
  const min = Math.min(...series)
  const max = Math.max(...series)
  const span = max - min
  const mid = SPARK_TICKS[Math.floor((SPARK_TICKS.length - 1) / 2)]
  const last = SPARK_TICKS.length - 1
  return series
    .map((v) => {
      if (span === 0) return mid
      const idx = Math.round(((v - min) / span) * last)
      return SPARK_TICKS[Math.max(0, Math.min(last, idx))]
    })
    .join("")
}

/** One input segment of a {@link stackedBar}. */
export interface BarSegment {
  value: number
  /** Terminal color name for this segment's run. Omitted → default color. */
  color?: string
  /** Fill glyph; defaults to "█". */
  char?: string
}

/** One rendered run of a {@link stackedBar} — a glyph string + optional color. */
export interface BarRun {
  text: string
  color?: string
}

/**
 * A proportional stacked bar. Each segment occupies a share of `width`
 * proportional to its value over the total, using largest-remainder
 * apportionment so the rendered runs always sum to exactly `width`. Zero-valued
 * segments are dropped; an all-zero (or empty) input renders a single gray
 * empty-track run. A non-positive width yields no runs.
 */
export function stackedBar(segments: BarSegment[], width: number): BarRun[] {
  const w = Math.max(0, Math.floor(width))
  if (w === 0) return []
  const positives = segments.filter((s) => s.value > 0)
  const total = positives.reduce((sum, s) => sum + s.value, 0)
  if (total === 0) return [{ text: "▱".repeat(w), color: "gray" }]

  const exact = positives.map((s) => (s.value / total) * w)
  const cells = exact.map((x) => Math.floor(x))
  let used = cells.reduce((a, b) => a + b, 0)
  // Hand the leftover cells to the largest fractional remainders.
  const byRemainder = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac)
  for (let k = 0; used < w && k < byRemainder.length; k++, used++) {
    cells[byRemainder[k].i]++
  }

  const runs: BarRun[] = []
  positives.forEach((s, i) => {
    if (cells[i] <= 0) return
    runs.push({ text: (s.char ?? "█").repeat(cells[i]), ...(s.color ? { color: s.color } : {}) })
  })
  return runs
}

/**
 * A bracketed occupancy gauge with a threshold marker — like `contextGauge`,
 * but with a `┊` at `markPct` (e.g. the auto-compact threshold) so you can see
 * how close current usage is to it. Filled cells use █, empty ▱; the marker
 * cell always shows the line glyph. Both percentages are clamped to 0–100.
 */
export function markedGauge(pct: number, markPct: number, width = 10): string {
  const clamp = (x: number): number => Math.max(0, Math.min(100, Math.round(x)))
  const p = clamp(pct)
  const filled = Math.round((p / 100) * width)
  const markCell = Math.min(width - 1, Math.floor((clamp(markPct) / 100) * width))
  let cells = ""
  for (let i = 0; i < width; i++) {
    cells += i === markCell ? "┊" : i < filled ? "█" : "▱"
  }
  return `[${cells}] ${p}%`
}
