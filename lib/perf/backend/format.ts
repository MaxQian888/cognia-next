/**
 * Pure formatting helpers for the performance panel. Locale-agnostic and
 * dependency-free so they are trivial to unit-test and reuse across the
 * graph / table / tile components.
 */

/** Format a byte count as a human-readable size (e.g. `1.5 MB`). */
export function formatBytes(bytes: number, fractionDigits = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** exponent
  return `${value.toFixed(exponent === 0 ? 0 : fractionDigits)} ${units[exponent]}`
}

/** Format a bytes-per-second rate (e.g. `2.0 MB/s`). */
export function formatBytesPerSec(bps: number): string {
  if (!Number.isFinite(bps) || bps <= 0) return "0 B/s"
  return `${formatBytes(bps)}/s`
}

/** Format a 0–100 percentage with one decimal (e.g. `42.3%`). */
export function formatPercent(pct: number): string {
  if (!Number.isFinite(pct) || pct <= 0) return "0%"
  return `${pct.toFixed(1)}%`
}

/** Format a millisecond duration, scaling to µs / ms / s for readability. */
export function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0 ms"
  if (ms < 1) return `${(ms * 1000).toFixed(0)} µs`
  if (ms < 1000) return `${ms.toFixed(ms < 10 ? 2 : 0)} ms`
  return `${(ms / 1000).toFixed(2)} s`
}

/** Compact integer formatting for large counts (e.g. `12.3k`). */
export function formatCount(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return "0"
  if (count < 1000) return `${Math.round(count)}`
  if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k`
  return `${(count / 1_000_000).toFixed(1)}M`
}
