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

/** A scored match plus the target indices each query char landed on. */
export interface FuzzyMatchResult {
  score: number
  /** Indices in `target` (original casing) of every matched character. */
  positions: number[]
}

/**
 * Score how well `query` fuzzy-matches `target` AND report which target indices
 * the query characters matched. Higher score is better. Returns `null` when
 * `query` is not a subsequence of `target`. An empty query returns score `0`
 * (neutral) with no positions — every candidate matches equally.
 */
export function fuzzyMatch(query: string, target: string): FuzzyMatchResult | null {
  if (query.length === 0) return { score: 0, positions: [] }
  const q = query.toLowerCase()
  const t = target.toLowerCase()

  let score = 0
  let qi = 0
  let prevMatch = -1
  let consecutive = 0
  let firstMatch = -1
  const positions: number[] = []

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) continue
    if (firstMatch === -1) firstMatch = ti
    positions.push(ti)
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
  return { score, positions }
}

/**
 * Score how well `query` fuzzy-matches `target`. Higher is better.
 * Returns `null` when `query` is not a subsequence of `target`.
 * An empty query returns `0` (neutral — every candidate matches equally).
 *
 * Thin wrapper over {@link fuzzyMatch} that drops the positions — kept so
 * existing call sites that only need the score stay unchanged.
 */
export function fuzzyScore(query: string, target: string): number | null {
  return fuzzyMatch(query, target)?.score ?? null
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
  // Same ranking + secondary-text fallback as the ranked variant; this just
  // drops the match positions callers here don't need.
  return fuzzyFilterSortRanked(items, query, getText, options).map((r) => r.item)
}

/** An item kept by {@link fuzzyFilterSortRanked}, with its primary-text hits. */
export interface RankedItem<T> {
  item: T
  /**
   * Indices in the item's PRIMARY text that matched the query. Empty for an
   * empty query and for items kept only via their secondary text (so the
   * caller highlights the name only when the name actually matched).
   */
  positions: number[]
}

/**
 * Like {@link fuzzyFilterSort}, but also returns the matched primary-text
 * positions for each kept item so the UI can highlight them. Ranking and
 * secondary-text fallback behave identically to `fuzzyFilterSort`.
 */
export function fuzzyFilterSortRanked<T>(
  items: readonly T[],
  query: string,
  getText: (item: T) => string,
  options: FuzzyFilterOptions<T> = {}
): RankedItem<T>[] {
  const q = query.trim()
  if (!q) {
    const kept = options.limit != null ? items.slice(0, options.limit) : [...items]
    return kept.map((item) => ({ item, positions: [] }))
  }

  const scored: { item: T; score: number; positions: number[]; idx: number }[] = []
  items.forEach((item, idx) => {
    const primary = fuzzyMatch(q, getText(item))
    if (primary !== null) {
      scored.push({ item, score: primary.score, positions: primary.positions, idx })
      return
    }
    if (options.secondaryText) {
      const secondary = options.secondaryText(item)
      const secondaryMatch = secondary ? fuzzyMatch(q, secondary) : null
      // Demote description-only hits so a name match always wins; no primary
      // positions to highlight in that case.
      if (secondaryMatch !== null) {
        scored.push({ item, score: secondaryMatch.score - 100, positions: [], idx })
      }
    }
  })

  scored.sort((a, b) => b.score - a.score || a.idx - b.idx)
  const ranked = scored.map((s) => ({ item: s.item, positions: s.positions }))
  return options.limit != null ? ranked.slice(0, options.limit) : ranked
}
