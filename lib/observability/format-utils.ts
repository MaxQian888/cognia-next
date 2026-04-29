/**
 * Minimal observability formatters — stub.
 *
 * Cognia exposes shared formatters used across the agent-trace UI.
 * cognia-next reuses `formatDurationShort` from `@/lib/utils`; the rest
 * are slim helpers re-implemented here so migrated agent components
 * keep compiling without the full observability layer.
 */

export function formatTimestamp(ts: number | Date): string {
  const d = ts instanceof Date ? ts : new Date(ts)
  return d.toLocaleString()
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
