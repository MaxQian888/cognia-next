/**
 * Cost estimator — stub.
 *
 * Cognia computes per-token cost from model pricing tables. cognia-next has no
 * pricing data yet; render the cost as a literal USD figure or "—" when the
 * input is missing. Replace with a real estimator when needed.
 */

export function formatCost(usd: number | null | undefined): string {
  if (typeof usd !== "number" || !Number.isFinite(usd)) return "—"
  if (usd === 0) return "$0"
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  return `$${usd.toFixed(2)}`
}
