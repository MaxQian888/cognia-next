/**
 * Smart pre-filter for radar items — borrows OpenWiki's `content_filter`
 * pattern: importance-score each item, drop near-duplicates (keeping the more
 * important one), then take the top-N. Keeps the analyzer's token cost bounded
 * and its input high-signal. Pure + deterministic.
 */

import type { RadarDataItem } from "@/types/radar"

/** N-gram size for the Jaccard similarity dedup. */
const NGRAM_SIZE = 3
/** Items above this Jaccard similarity are treated as near-duplicates. */
const SIMILARITY_THRESHOLD = 0.8

/**
 * Salience score for an item. Base = memory importance (1..10) or a neutral 3;
 * richer text scores slightly higher (a longer note carries more signal).
 */
export function computeImportance(item: RadarDataItem): number {
  let score = item.importance ?? 3
  const len = item.text.trim().length
  if (len > 200) score += 1
  if (len > 600) score += 1
  // Captured items are explicit user saves — a small salience bump.
  if (item.source === "capture") score += 1
  return score
}

/** Character n-gram set of the normalized text. */
export function ngrams(text: string, n = NGRAM_SIZE): Set<string> {
  const norm = text.toLowerCase().replace(/\s+/g, " ").trim()
  const out = new Set<string>()
  if (norm.length < n) {
    if (norm) out.add(norm)
    return out
  }
  for (let i = 0; i <= norm.length - n; i++) out.add(norm.slice(i, i + n))
  return out
}

/** Jaccard similarity between two n-gram sets. */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1
  let inter = 0
  for (const g of a) if (b.has(g)) inter++
  const union = a.size + b.size - inter
  return union === 0 ? 0 : inter / union
}

/**
 * Drop near-duplicate items, keeping the higher-importance one from each
 * cluster. O(n²) but n is capped small by the caller.
 */
export function dedupeSimilar(items: readonly RadarDataItem[]): RadarDataItem[] {
  const kept: { item: RadarDataItem; grams: Set<string>; score: number }[] = []
  for (const item of items) {
    const grams = ngrams(item.text)
    const score = computeImportance(item)
    const dupIndex = kept.findIndex((k) => jaccard(k.grams, grams) >= SIMILARITY_THRESHOLD)
    if (dupIndex === -1) {
      kept.push({ item, grams, score })
    } else if (score > kept[dupIndex].score) {
      kept[dupIndex] = { item, grams, score }
    }
  }
  return kept.map((k) => k.item)
}

/**
 * Score → dedup → sort by (importance desc, recency desc) → cap at `maxItems`.
 */
export function smartPreFilter(items: readonly RadarDataItem[], maxItems: number): RadarDataItem[] {
  const deduped = dedupeSimilar(items)
  return deduped
    .map((item) => ({ item, score: computeImportance(item) }))
    .sort((a, b) => b.score - a.score || b.item.at - a.item.at)
    .slice(0, maxItems)
    .map((s) => s.item)
}
