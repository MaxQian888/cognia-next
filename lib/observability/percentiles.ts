/**
 * Percentile helpers over raw latency arrays.
 *
 * The Rust perf registry uses a streaming log-bucket histogram because it
 * can't hold every sample; here we have the full `durationMs` array per
 * bucket in memory (low-thousands cardinality), so a sort + nearest-rank with
 * linear interpolation is both exact and cheap.
 */

/**
 * Percentile of an ascending-sorted array. `p` ∈ [0, 1]. Empty → 0. Uses the
 * linear-interpolation ("type 7") method, matching NumPy / Excel PERCENTILE.
 */
export function percentile(sortedAsc: number[], p: number): number {
  const n = sortedAsc.length
  if (n === 0) return 0
  if (n === 1) return sortedAsc[0]
  const clamped = Math.min(1, Math.max(0, p))
  const rank = clamped * (n - 1)
  const lo = Math.floor(rank)
  const hi = Math.ceil(rank)
  if (lo === hi) return sortedAsc[lo]
  const frac = rank - lo
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * frac
}

/**
 * Compute several percentiles from an unsorted array with a single sort.
 * Returns one value per entry in `ps` (same order). Empty input → all zeros.
 */
export function percentilesOf(values: number[], ps: number[]): number[] {
  if (values.length === 0) return ps.map(() => 0)
  const sorted = [...values].sort((a, b) => a - b)
  return ps.map((p) => percentile(sorted, p))
}
