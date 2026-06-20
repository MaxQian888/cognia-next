// Shared fuzzy matcher for the composer's completion surfaces (slash
// commands, @-mentions). Pure and framework-free so every picker scores
// candidates the same way instead of each rolling its own substring filter.
//
// The algorithm is a forgiving subsequence match: every character of the
// query must appear in the target in order, but not necessarily adjacent.
// Score rewards matches that start at a word boundary, run consecutively,
// and sit near the front of the target; shorter targets win ties. A target
// the query is NOT a subsequence of scores `null` (filtered out).

/** Characters that begin a new "word" inside an identifier or path. */
function isBoundary(ch: string): boolean {
  return ch === " " || ch === "/" || ch === "-" || ch === "_" || ch === "." || ch === ":"
}

/**
 * Score how well `query` fuzzy-matches `target`. Higher is better.
 * Returns `null` when `query` is not a subsequence of `target`.
 * An empty query returns `0` (neutral — every candidate matches equally).
 */
export function fuzzyScore(query: string, target: string): number | null {
  if (query.length === 0) return 0
  const q = query.toLowerCase()
  const t = target.toLowerCase()

  let score = 0
  let qi = 0
  let prevMatch = -1
  let consecutive = 0
  let firstMatch = -1

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) continue
    if (firstMatch === -1) firstMatch = ti
    let charScore = 1
    // Word-boundary matches read as "intentional" — weight them heavily.
    if (ti === 0 || isBoundary(t[ti - 1])) charScore += 3
    // Adjacent matches form a contiguous run; each extra char compounds.
    if (prevMatch === ti - 1) {
      consecutive += 1
      charScore += consecutive * 2
    } else {
      consecutive = 0
    }
    score += charScore
    prevMatch = ti
    qi += 1
  }

  // Not every query char was consumed → not a subsequence.
  if (qi < q.length) return null

  if (t === q) score += 16
  else if (t.startsWith(q)) score += 8
  // Prefer matches that start early and shorter targets overall.
  score -= firstMatch * 0.2
  score -= t.length * 0.05
  return score
}

export interface FuzzyFilterOptions<T> {
  /** Secondary text (e.g. a description) matched when the primary text misses. */
  secondaryText?: (item: T) => string | undefined
  /** Cap the number of results returned. */
  limit?: number
}

/**
 * Filter + sort `items` by how well each fuzzy-matches `query`.
 *
 * - Empty query keeps the original order (optionally truncated to `limit`).
 * - Primary-text matches always rank above secondary-text-only matches.
 * - Sort is stable: equal scores fall back to the input order.
 */
export function fuzzyFilterSort<T>(
  items: readonly T[],
  query: string,
  getText: (item: T) => string,
  options: FuzzyFilterOptions<T> = {}
): T[] {
  const q = query.trim()
  if (!q) {
    return options.limit != null ? items.slice(0, options.limit) : [...items]
  }

  const scored: { item: T; score: number; idx: number }[] = []
  items.forEach((item, idx) => {
    let score = fuzzyScore(q, getText(item))
    if (score === null && options.secondaryText) {
      const secondary = options.secondaryText(item)
      const secondaryScore = secondary ? fuzzyScore(q, secondary) : null
      // Demote description-only hits so a name match always wins.
      if (secondaryScore !== null) score = secondaryScore - 100
    }
    if (score !== null) scored.push({ item, score, idx })
  })

  scored.sort((a, b) => b.score - a.score || a.idx - b.idx)
  const result = scored.map((s) => s.item)
  return options.limit != null ? result.slice(0, options.limit) : result
}
