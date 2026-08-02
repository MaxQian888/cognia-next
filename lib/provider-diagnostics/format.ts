/**
 * Display formatters for provider-diagnostics metrics.
 *
 * Lives here rather than in the tab component because the diagnostics UI is
 * split across several section components (summary / matrix / history) that all
 * render the same latency and throughput numbers, and a metric must not read
 * "250 ms" in one section and "0.25s" in another.
 *
 * Deliberately NOT `lib/observability/format-utils.ts:formatMs`: that one
 * switches unit by magnitude (`500µs` / `1.50s` / `2.0m`) for log timelines.
 * Diagnostics compares samples against each other, so every duration stays in
 * whole milliseconds — a fixed unit is what makes the matrix column scannable.
 */

/** Millisecond duration, rounded. `undefined` renders as an em dash, not "NaN ms". */
export function formatMs(value?: number): string {
  return value === undefined ? "—" : `${Math.round(value)} ms`
}

/** Fixed-precision number (throughput, ratios). `undefined` renders as an em dash. */
export function formatNumber(value?: number, digits = 2): string {
  return value === undefined ? "—" : value.toFixed(digits)
}

/** USD cost, or an em dash when the sample carries no cost estimate. */
export function formatCostUsd(value?: number, digits = 6): string {
  return value === undefined ? "—" : `$${value.toFixed(digits)}`
}
