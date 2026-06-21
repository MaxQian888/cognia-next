/**
 * A small subsequence fuzzy scorer for the panel filter boxes (MCP / Skills).
 * Generalises the tiered match in `commands/matcher.ts`: every query char must
 * appear in order, and matches are scored so that prefix / word-boundary /
 * consecutive hits rank above scattered ones. Pure and deterministic — no
 * `Date.now` / `Math.random` — so it unit-tests in isolation.
 */

/** A match is impossible (some query char is absent or out of order). */
export const NO_MATCH = Number.NEGATIVE_INFINITY

/**
 * Score how well `query` fuzzy-matches `text` (both compared case-insensitively).
 * Returns {@link NO_MATCH} when `text` is not a supersequence of `query`. An
 * empty query matches everything with score `0`. Higher is better.
 */
export function fuzzyScore(query: string, text: string): number {
  const q = query.trim().toLowerCase()
  if (q.length === 0) return 0
  const s = text.toLowerCase()
  let score = 0
  let qi = 0
  let prevMatch = -2
  for (let si = 0; si < s.length && qi < q.length; si++) {
    if (s[si] !== q[qi]) continue
    // Base point for the char.
    score += 1
    // Consecutive run with the previous matched char.
    if (si === prevMatch + 1) score += 5
    // Word boundary (start of string, or after a separator).
    if (si === 0 || /[\s\-_./:]/.test(s[si - 1])) score += 8
    // Match near the front of the string.
    if (si < 4) score += 2
    prevMatch = si
    qi++
  }
  if (qi < q.length) return NO_MATCH
  // Exact prefix is the strongest signal.
  if (s.startsWith(q)) score += 15
  // Shorter strings that still match the whole query rank slightly higher.
  score -= Math.min(s.length, 40) * 0.1
  return score
}

/**
 * Filter + rank `items` by how well `key(item)` fuzzy-matches `query`,
 * preserving the original order for ties (stable). An empty query keeps every
 * item in its original order. When `keys` returns several strings, the best
 * (highest) score across them is used.
 */
export function fuzzyFilter<T>(
  items: T[],
  query: string,
  keys: (item: T) => string | string[]
): T[] {
  const q = query.trim()
  if (q.length === 0) return items.slice()
  const scored: { item: T; score: number; idx: number }[] = []
  items.forEach((item, idx) => {
    const fields = keys(item)
    const list = Array.isArray(fields) ? fields : [fields]
    let best = NO_MATCH
    for (const f of list) {
      const sc = fuzzyScore(q, f)
      if (sc > best) best = sc
    }
    if (best > NO_MATCH) scored.push({ item, score: best, idx })
  })
  scored.sort((a, b) => (b.score === a.score ? a.idx - b.idx : b.score - a.score))
  return scored.map((s) => s.item)
}
