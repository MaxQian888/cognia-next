/**
 * Compact formatters shared by the agent-trace UI.
 *
 * These are locale-NEUTRAL where they can be (`12ms`, `$0.02`, `1.2K`) and
 * take the app locale explicitly where they cannot. A component that renders a
 * localized unit or date should prefer `useObservabilityFormatters()`
 * (`hooks/observability/use-observability-formatters.ts`), which routes through
 * next-intl's `useFormatter`; these plain functions remain for pure modules
 * (CSV export, axis math) and for the many non-trace callers that predate it.
 */

/**
 * Epoch ms / Date → a date-time string in `locale`.
 *
 * `locale` is the APP locale (`useLocale()` from next-intl). Omitting it falls
 * back to the browser's locale — which is how this used to behave everywhere,
 * and why a zh-CN user on an en-US system saw US-ordered dates in an otherwise
 * Chinese UI. Kept optional only for the legacy non-trace callers.
 */
export function formatTimestamp(
  ts: number | Date,
  locale?: string,
  options?: Intl.DateTimeFormatOptions
): string {
  const d = ts instanceof Date ? ts : new Date(ts)
  try {
    return d.toLocaleString(locale, options)
  } catch {
    // An unknown locale tag throws a RangeError; the browser default beats a crash.
    return d.toLocaleString(undefined, options)
  }
}

export function formatBytesCompact(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—"
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)}GB`
}

export function formatRate(value: number, suffix = ""): string {
  if (!Number.isFinite(value)) return "—"
  return `${value.toFixed(2)}${suffix}`
}

export function formatTokens(tokens: number | null | undefined): string {
  if (tokens === null || tokens === undefined || !Number.isFinite(tokens)) {
    return "—"
  }
  if (tokens < 1000) return String(Math.round(tokens))
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}K`
  return `${(tokens / 1_000_000).toFixed(2)}M`
}

/** USD with adaptive precision: sub-cent amounts keep 4 dp, the rest 2 dp. */
export function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—"
  if (value === 0) return "$0.00"
  if (Math.abs(value) < 0.01) return `$${value.toFixed(4)}`
  return `$${value.toFixed(2)}`
}

/** Fraction (0..1) → percent string. `digits` controls decimal places. */
export function formatPercent(fraction: number | null | undefined, digits = 0): string {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) return "—"
  return `${(fraction * 100).toFixed(digits)}%`
}

/** Duration in ms → compact human string (µs / ms / s). */
export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—"
  if (ms < 1) return `${Math.round(ms * 1000)}µs`
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`
  return `${(ms / 60_000).toFixed(1)}m`
}
