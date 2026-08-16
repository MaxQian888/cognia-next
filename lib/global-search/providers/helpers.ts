/**
 * Shared plumbing for title-shaped providers (ADR-0129).
 *
 * Nearly every entity provider does the same thing: take a list, score each
 * row's name against the needle, keep the hits, sort, slice, and report the
 * total. `matchTitles` is that loop; providers only describe how to read a row
 * and how to turn a hit into an item.
 */

import { compareByScore, scoreTitleMatch, type TitleMatch } from "../scoring"
import type { GlobalSearchItem, GlobalSearchProviderResult } from "../types"

export interface MatchTitlesOptions<T> {
  getTitle: (row: T) => string
  getSecondary?: (row: T) => string | undefined
  getKeywords?: (row: T) => readonly string[] | undefined
  getTimestamp?: (row: T) => number | undefined
  now: number
  limit: number
  fuzzy?: boolean
  recencyWeight?: number
}

export interface TitleHit<T> {
  row: T
  match: TitleMatch
}

export interface MatchTitlesResult<T> {
  hits: TitleHit<T>[]
  total: number
  truncated: boolean
}

/** Score `rows` against `needle`; hits sorted best-first and sliced to `limit`. */
export function matchTitles<T>(
  rows: readonly T[],
  needle: string,
  {
    getTitle,
    getSecondary,
    getKeywords,
    getTimestamp,
    now,
    limit,
    fuzzy,
    recencyWeight,
  }: MatchTitlesOptions<T>
): MatchTitlesResult<T> {
  const scored: Array<TitleHit<T> & { title: string; timestamp?: number; score: number }> = []
  for (const row of rows) {
    const title = getTitle(row)
    const match = scoreTitleMatch(needle, title, {
      secondary: getSecondary?.(row),
      keywords: getKeywords?.(row),
      timestamp: getTimestamp?.(row),
      now,
      fuzzy,
      recencyWeight,
    })
    if (!match) continue
    scored.push({ row, match, title, timestamp: getTimestamp?.(row), score: match.score })
  }
  scored.sort(compareByScore)
  const hits = scored.slice(0, limit).map(({ row, match }) => ({ row, match }))
  return { hits, total: scored.length, truncated: scored.length > hits.length }
}

/** Wrap a slice into the provider result shape. */
export function toProviderResult(
  items: GlobalSearchItem[],
  total: number,
  truncated: boolean
): GlobalSearchProviderResult {
  return { items, total, truncated }
}

/** Case-insensitive substring positions inside `text` for a needle, or `[]`. */
export function highlightPositions(text: string | undefined, needle: string): number[] {
  if (!text || !needle) return []
  const at = text.toLowerCase().indexOf(needle)
  if (at < 0) return []
  return Array.from({ length: needle.length }, (_, i) => at + i)
}

/** Clamp a long body to a one-line excerpt around the first needle hit. */
export function excerptAround(text: string, needle: string, maxChars = 120): string {
  const clean = text.replace(/\s+/g, " ").trim()
  if (clean.length <= maxChars) return clean
  const at = needle ? clean.toLowerCase().indexOf(needle) : -1
  if (at < 0) return `${clean.slice(0, maxChars - 1)}…`
  const start = Math.max(0, at - Math.floor((maxChars - needle.length) / 2))
  const end = Math.min(clean.length, start + maxChars)
  const head = start > 0 ? "…" : ""
  const tail = end < clean.length ? "…" : ""
  return `${head}${clean.slice(start, end)}${tail}`
}
