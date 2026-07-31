/**
 * Cost formatter.
 *
 * Cognia computes per-token cost from model pricing tables outside this
 * package. This helper only renders a supplied USD figure for trace displays.
 */

export function formatCost(usd: number | null | undefined): string {
  if (typeof usd !== "number" || !Number.isFinite(usd)) return "—"
  if (usd === 0) return "$0"
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  return `$${usd.toFixed(2)}`
}
