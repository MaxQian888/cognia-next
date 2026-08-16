/**
 * Cross-provider relevance (ADR-0129).
 *
 * Every provider hands the engine a `score ∈ [0, 1]`. Title-like items share
 * one scorer so a conversation, a workflow and a settings page that all match
 * "deploy" compete on equal footing:
 *
 *   substring rank (`titleMatchRank`: prefix > word-start > anywhere)
 *   ⊕ fuzzy subsequence quality (`fuzzyMatch`, so "dply" still finds "deploy")
 *   ⊕ recency half-life (fresh items edge out stale ones on ties)
 *
 * The chat-message engine keeps its own absolute score (ADR-0099); the message
 * provider maps it into the same `[0, 1]` band with `normalizeMessageScore`.
 */

import { fuzzyMatch } from "@/lib/chat/completion/fuzzy-match"
import { titleMatchRank } from "@/lib/chat/conversation-list-model"

/** Recency half-life used for tie-breaking (days). */
export const RECENCY_HALF_LIFE_DAYS = 14

const DAY_MS = 86_400_000

export interface TitleMatch {
  score: number
  /** Indices in the *primary* text that matched (for highlighting). */
  positions: number[]
  /** Which text matched: primary title or a secondary field. */
  field: "title" | "secondary" | "keyword"
}

export interface TitleMatchOptions {
  /** Description / subtitle searched when the title misses. */
  secondary?: string
  /** Hidden tokens searched last (aliases, ids, tags). */
  keywords?: readonly string[]
  /** Record timestamp — adds up to `recencyWeight` for very fresh items. */
  timestamp?: number
  now?: number
  /** Cap on the recency contribution. Default 0.15. */
  recencyWeight?: number
  /**
   * Allow fuzzy subsequence matches when no substring hit exists. Default
   * true. Providers over free prose (memories) turn it off — a subsequence in
   * a paragraph is noise.
   */
  fuzzy?: boolean
}

/** Positions of `needle` inside `haystack` (case-insensitive), first hit only. */
export function substringPositions(haystack: string, needle: string): number[] {
  const at = haystack.toLowerCase().indexOf(needle)
  if (at < 0) return []
  return Array.from({ length: needle.length }, (_, i) => at + i)
}

/** 0..1 recency bonus, 1 for "now", ½ after one half-life. */
export function recencyBonus(timestamp: number | undefined, now: number): number {
  if (timestamp === undefined || !Number.isFinite(timestamp)) return 0
  const ageDays = Math.max(0, now - timestamp) / DAY_MS
  return Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS)
}

function substringScore(rank: number, text: string, needle: string): number {
  // prefix 0.9, word-start 0.75, anywhere 0.55; short titles that the needle
  // covers most of get a little more.
  const base = rank === 0 ? 0.9 : rank === 1 ? 0.75 : 0.55
  const coverage = text.length > 0 ? Math.min(1, needle.length / text.length) : 0
  return base + coverage * 0.08
}

/**
 * Score a title-like item against a lower-cased needle. Returns `null` when
 * nothing matched (the item is dropped).
 */
export function scoreTitleMatch(
  needle: string,
  title: string,
  {
    secondary,
    keywords,
    timestamp,
    now = Date.now(),
    recencyWeight = 0.15,
    fuzzy = true,
  }: TitleMatchOptions = {}
): TitleMatch | null {
  const recency = recencyBonus(timestamp, now) * recencyWeight
  if (!needle) {
    return { score: Math.min(1, 0.5 + recency), positions: [], field: "title" }
  }

  const rank = titleMatchRank(title, needle)
  if (rank !== null) {
    return {
      score: Math.min(1, substringScore(rank, title, needle) + recency),
      positions: substringPositions(title, needle),
      field: "title",
    }
  }

  if (secondary) {
    const secondaryRank = titleMatchRank(secondary, needle)
    if (secondaryRank !== null) {
      return {
        // Below every title hit, but ahead of fuzzy guesses.
        score: Math.min(1, 0.3 + (secondaryRank === 0 ? 0.1 : 0.05) + recency),
        positions: [],
        field: "secondary",
      }
    }
  }

  if (keywords) {
    for (const keyword of keywords) {
      if (keyword.toLowerCase().includes(needle)) {
        return { score: Math.min(1, 0.28 + recency), positions: [], field: "keyword" }
      }
    }
  }

  if (fuzzy && needle.length >= 2) {
    const match = fuzzyMatch(needle, title)
    if (match) {
      // fuzzyMatch scores are unbounded; squash into (0, 0.25].
      const squashed = 0.25 * (1 - Math.exp(-Math.max(0, match.score) / 12))
      return {
        score: Math.min(1, squashed + recency * 0.5),
        positions: match.positions,
        field: "title",
      }
    }
  }

  return null
}

/**
 * Map the chat engine's absolute message score onto `[0, 1]`. The engine's
 * weights sum to ≈3.6 for a perfect hit (count 1, position 0.4, title 0.8,
 * recency 1.2, role 0.2); anything above that saturates.
 */
export function normalizeMessageScore(score: number): number {
  if (!Number.isFinite(score) || score <= 0) return 0
  return Math.min(1, score / 3.6)
}

/** Sort helper: score desc, then timestamp desc, then title asc. */
export function compareByScore<T extends { score: number; timestamp?: number; title: string }>(
  a: T,
  b: T
): number {
  if (b.score !== a.score) return b.score - a.score
  const ta = a.timestamp ?? 0
  const tb = b.timestamp ?? 0
  if (tb !== ta) return tb - ta
  return a.title.localeCompare(b.title)
}
