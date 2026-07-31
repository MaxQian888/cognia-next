/**
 * Pure incremental reverse-history-search matcher.
 *
 * Input history entries are stored oldest-first, so the "most recent" entry is
 * the one at the highest index. Reverse search scans DOWNWARD: starting just
 * below `fromIndex` (i.e. from `fromIndex - 1` toward 0) and returning the first
 * case-insensitive substring match.
 *
 * Documented behaviour the overlay/controller relies on:
 * - The query is trimmed; an empty or whitespace-only query returns `null`.
 * - Matching is a case-insensitive substring (`includes`) test on both sides.
 * - No wrap: the scan stops at index 0. Once the oldest match is consumed,
 *   the next call (with that hit's index as `fromIndex`) returns `null`.
 * - To get the most-recent match, callers pass `fromIndex = entries.length`.
 *   To cycle to the next-older match, callers pass the last hit's `index` as the
 *   next `fromIndex`.
 * - `fromIndex` is clamped to `entries.length`; a `fromIndex` of 0 (or an empty
 *   history) yields `null` because there is nothing below to scan.
 */

export interface HistorySearchHit {
  index: number
  match: string
}

/**
 * Find the first case-insensitive substring match of `query` scanning downward
 * from just below `fromIndex` toward index 0.
 *
 * @param entries Input history, oldest-first.
 * @param query Search text; trimmed before matching. Empty/whitespace → `null`.
 * @param fromIndex Exclusive upper bound; scanning begins at `fromIndex - 1`.
 * @returns The matched entry and its index, or `null` if no match at/below the bound.
 */
export function searchHistory(
  entries: string[],
  query: string,
  fromIndex: number
): HistorySearchHit | null {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return null

  const start = Math.min(fromIndex, entries.length) - 1
  for (let i = start; i >= 0; i--) {
    const entry = entries[i]
    if (entry.toLowerCase().includes(needle)) {
      return { index: i, match: entry }
    }
  }
  return null
}
